//! Command-line access to the portable translation state. See SPEC.md,
//! Command-Line Tool.
//!
//! The tool reads and writes the same `data/` folder as the app, through the
//! same scanner, token checks, state files, and export. It owns the portable
//! profile while it runs, so it refuses to start while the app (or another
//! command) uses that folder. Every command prints one JSON document to
//! stdout; human-readable errors also go to stderr.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::scanner::{ScanResult, ScannedMod, StringRow};
use crate::translations::{self, StoredString};
use crate::{detection, export, glossary, language, portable_profile, scanner, settings, tokens};

pub const STRINGS_FORMAT: &str = "stardew-translator-strings";
pub const STRINGS_VERSION: u64 = 1;

/// Exit codes: success, failure, invalid usage, and a completed command in
/// which some strings were rejected (any valid ones were saved).
const EXIT_OK: i32 = 0;
const EXIT_FAILED: i32 = 1;
const EXIT_USAGE: i32 = 2;
const EXIT_REJECTED: i32 = 3;

/// Command-line undo records kept per language.
const MAX_HISTORY: usize = 20;

const HELP: &str = "Stardew i18n Translator command-line tool

Usage: stardew-i18n-cli <command> [options]

Commands:
  list                         List mods and their translation progress.
  pull --mod <id>              Write a strings file with the strings to translate.
       [--file <dir>] [--status <list>] [--limit <n>] [--out <path>]
       --status: untranslated, outdated, review-needed, translated, or all
       (comma-separated; default untranslated,outdated).
  check <file>                 Validate a strings file without saving anything.
  push <file> [--status <s>]   Save the translations in a strings file.
       --status translated (default) or review-needed. A changed (outdated)
       string sent back unedited stays changed; confirm it with done.
  done --mod <id> (--keys <k1,k2> | --all) [--file <dir>]
                               Mark saved translations as translated. --all
                               takes every review-needed string.
  undo [<id>] [--list]         Undo the latest (or the given) push or done;
                               --list shows them.
  export (--mod <id> | --all) [--dry-run]
                               Write i18n/<lang>.json into the mod folders.

Global options:
  --data <dir>    Portable data folder (default: data next to this program).
  --mods <dir>    Mods folder (default: from the app settings).
  --lang <code>   Target language (default: from the app settings).

Output is JSON on stdout. Exit codes: 0 success, 1 failure, 2 invalid usage,
3 some strings were rejected (the valid ones were saved).
Close the app before running a command: both use the same data folder.";

const VALUE_OPTIONS: &[&str] = &[
    "--data", "--mods", "--lang", "--mod", "--file", "--status", "--limit", "--out", "--keys",
];
const FLAG_OPTIONS: &[&str] = &["--all", "--dry-run", "--list", "--help"];
const GLOBAL_OPTIONS: &[&str] = &["--data", "--mods", "--lang"];

/// Run one command and return the process exit code.
pub fn run(args: Vec<String>) -> i32 {
    let parsed = match Args::parse(args) {
        Ok(parsed) => parsed,
        Err(error) => return usage_error(&error),
    };
    if parsed.flag("--help") || parsed.command.as_deref() == Some("help") {
        println!("{HELP}");
        return EXIT_OK;
    }
    if parsed.command.is_none() {
        println!("{HELP}");
        return EXIT_USAGE;
    }
    match dispatch(&parsed) {
        Ok(Outcome { body, rejected }) => {
            print_json(&body);
            if rejected {
                EXIT_REJECTED
            } else {
                EXIT_OK
            }
        }
        Err(CliError::Usage(message)) => usage_error(&message),
        Err(CliError::Failed(message)) => {
            eprintln!("{message}");
            print_json(&json!({ "ok": false, "error": message }));
            EXIT_FAILED
        }
    }
}

fn usage_error(message: &str) -> i32 {
    eprintln!("{message}\nRun `stardew-i18n-cli --help` for usage.");
    print_json(&json!({ "ok": false, "error": message }));
    EXIT_USAGE
}

fn print_json(value: &Value) {
    println!(
        "{}",
        serde_json::to_string_pretty(value).expect("JSON values always serialize")
    );
}

enum CliError {
    Usage(String),
    Failed(String),
}

impl From<String> for CliError {
    fn from(message: String) -> Self {
        CliError::Failed(message)
    }
}

type CliResult<T> = Result<T, CliError>;

struct Outcome {
    body: Value,
    rejected: bool,
}

impl Outcome {
    fn ok(body: Value) -> Self {
        Outcome {
            body,
            rejected: false,
        }
    }
}

#[derive(Debug, Default)]
struct Args {
    command: Option<String>,
    positionals: Vec<String>,
    values: HashMap<String, String>,
    flags: HashSet<String>,
}

impl Args {
    fn parse(args: Vec<String>) -> Result<Self, String> {
        let mut parsed = Args::default();
        let mut iter = args.into_iter();
        while let Some(arg) = iter.next() {
            if arg.starts_with("--") {
                let (name, inline) = match arg.split_once('=') {
                    Some((name, value)) => (name, Some(value.to_string())),
                    None => (arg.as_str(), None),
                };
                if VALUE_OPTIONS.contains(&name) {
                    let value = match inline {
                        Some(value) => value,
                        None => iter
                            .next()
                            .filter(|value| !value.starts_with("--"))
                            .ok_or_else(|| format!("{name} needs a value."))?,
                    };
                    if parsed.values.insert(name.to_string(), value).is_some() {
                        return Err(format!("{name} was given more than once."));
                    }
                } else if FLAG_OPTIONS.contains(&name) && inline.is_none() {
                    parsed.flags.insert(name.to_string());
                } else {
                    return Err(format!("Unknown option {arg}."));
                }
            } else if parsed.command.is_none() {
                parsed.command = Some(arg);
            } else {
                parsed.positionals.push(arg);
            }
        }
        Ok(parsed)
    }

    fn value(&self, name: &str) -> Option<&str> {
        self.values.get(name).map(String::as_str)
    }

    fn flag(&self, name: &str) -> bool {
        self.flags.contains(name)
    }

    /// Reject options and positional arguments the command does not use, so a
    /// mistyped command never silently does something broader.
    fn allow(&self, options: &[&str], positionals: usize) -> CliResult<()> {
        let command = self.command.as_deref().unwrap_or_default();
        for name in self.values.keys().chain(self.flags.iter()) {
            if !options.contains(&name.as_str()) && !GLOBAL_OPTIONS.contains(&name.as_str()) {
                return Err(CliError::Usage(format!("{command} does not take {name}.")));
            }
        }
        if self.positionals.len() > positionals {
            return Err(CliError::Usage(format!(
                "{command} got an unexpected argument: {}.",
                self.positionals[positionals]
            )));
        }
        Ok(())
    }

    fn required(&self, name: &str) -> CliResult<&str> {
        self.value(name).ok_or_else(|| {
            CliError::Usage(format!(
                "{} needs {name}.",
                self.command.as_deref().unwrap_or_default()
            ))
        })
    }
}

fn dispatch(args: &Args) -> CliResult<Outcome> {
    let command = args.command.as_deref().unwrap_or_default();
    match command {
        "list" => {
            args.allow(&[], 0)?;
            list(&Context::open(args)?).map(Outcome::ok)
        }
        "pull" => {
            args.allow(&["--mod", "--file", "--status", "--limit", "--out"], 0)?;
            pull(&Context::open(args)?, args).map(Outcome::ok)
        }
        "check" | "push" => {
            let options: &[&str] = if command == "push" {
                &["--status"]
            } else {
                &[]
            };
            args.allow(options, 1)?;
            let path = args.positionals.first().ok_or_else(|| {
                CliError::Usage(format!("{command} needs the path of a strings file."))
            })?;
            let status = match args.value("--status").unwrap_or("translated") {
                status @ ("translated" | "review-needed") => status,
                other => {
                    return Err(CliError::Usage(format!(
                        "--status must be translated or review-needed, not {other}."
                    )))
                }
            };
            push(
                &Context::open(args)?,
                Path::new(path),
                status,
                command == "check",
            )
        }
        "done" => {
            args.allow(&["--mod", "--file", "--keys", "--all"], 0)?;
            if args.flag("--all") == args.value("--keys").is_some() {
                return Err(CliError::Usage(
                    "done needs either --keys or --all.".to_string(),
                ));
            }
            done(&Context::open(args)?, args)
        }
        "undo" => {
            args.allow(&["--list"], 1)?;
            let context = Context::open(args)?;
            if args.flag("--list") {
                if !args.positionals.is_empty() {
                    return Err(CliError::Usage(
                        "undo --list takes no operation id.".to_string(),
                    ));
                }
                return list_history(&context).map(Outcome::ok);
            }
            undo(&context, args.positionals.first().map(String::as_str))
        }
        "export" => {
            args.allow(&["--mod", "--all", "--dry-run"], 0)?;
            if args.flag("--all") == args.value("--mod").is_some() {
                return Err(CliError::Usage(
                    "export needs either --mod or --all.".to_string(),
                ));
            }
            export_mods(&Context::open(args)?, args).map(Outcome::ok)
        }
        other => Err(CliError::Usage(format!("Unknown command {other}."))),
    }
}

/// The resolved portable profile for one command. Holding `_owner` keeps the
/// app and other commands from writing the same folder meanwhile.
struct Context {
    data_dir: PathBuf,
    state_root: PathBuf,
    mods_root: PathBuf,
    target_lang: String,
    _owner: portable_profile::ProfileOwner,
}

impl Context {
    fn open(args: &Args) -> CliResult<Self> {
        let data_dir = match args.value("--data") {
            Some(path) => PathBuf::from(path),
            None => crate::portable_data_dir()?,
        };
        if !data_dir.is_dir() {
            return Err(CliError::Failed(format!(
                "There is no data folder at {}. Start the app once from the same folder, or pass --data.",
                data_dir.display()
            )));
        }
        let owner = portable_profile::acquire(&data_dir)?;
        let settings = settings::load_checked(&data_dir)?;
        let target_lang = args
            .value("--lang")
            .map(str::to_string)
            .or_else(|| settings.target_lang.clone())
            .ok_or_else(|| {
                "No target language is set. Choose one in the app, or pass --lang.".to_string()
            })?;
        let target_lang = language::normalize_target_code(&target_lang)?;
        let mods_root = args
            .value("--mods")
            .map(PathBuf::from)
            .or_else(|| settings.mods_path.map(PathBuf::from))
            .or_else(|| {
                settings
                    .stardew_path
                    .as_deref()
                    .map(|path| detection::mods_path_for(Path::new(path)))
            })
            .ok_or_else(|| {
                "No Mods folder is set. Choose one in the app, or pass --mods.".to_string()
            })?;
        if !mods_root.is_dir() {
            return Err(CliError::Failed(format!(
                "The Mods folder {} is unavailable.",
                mods_root.display()
            )));
        }
        // A pre-v1.1 profile's state belongs to the settings language, as in
        // the app. Migrate it there first, since the scanner would otherwise
        // move it into whichever language --lang names.
        let settings_lang = settings
            .target_lang
            .as_deref()
            .and_then(|lang| language::normalize_target_code(lang).ok());
        match settings_lang {
            Some(lang) => {
                translations::language_root(&data_dir, &lang)?;
            }
            None if data_dir.join("translations").is_dir() => {
                return Err(CliError::Failed(
                    "This data folder has translations from an older app version. Open it in the app once and choose a target language first.".to_string(),
                ));
            }
            None => {}
        }
        let state_root = translations::language_root(&data_dir, &target_lang)?;
        Ok(Context {
            data_dir,
            state_root,
            mods_root,
            target_lang,
            _owner: owner,
        })
    }

    fn scan(&self) -> ScanResult {
        scanner::scan_mods(&self.mods_root, &self.target_lang, &self.data_dir)
    }

    fn history_dir(&self) -> PathBuf {
        self.state_root.join("cli-history")
    }
}

fn find_mod<'a>(scan: &'a ScanResult, unique_id: &str) -> CliResult<&'a ScannedMod> {
    let matches = scan
        .mods
        .iter()
        .filter(|scanned| scanned.unique_id.eq_ignore_ascii_case(unique_id))
        .collect::<Vec<_>>();
    match matches.as_slice() {
        [scanned] => Ok(scanned),
        [] => Err(CliError::Failed(format!(
            "No translatable mod has the ID {unique_id}. Run list to see the IDs."
        ))),
        _ => Err(CliError::Failed(format!(
            "Two mods have the ID {unique_id}. Remove the duplicate first."
        ))),
    }
}

/// Current rows of a mod, optionally limited to one i18n folder, in
/// `default.json` order.
fn load_rows(
    context: &Context,
    scanned: &ScannedMod,
    file: Option<&str>,
) -> CliResult<Vec<(String, StringRow)>> {
    if let Some(file) = file {
        if !scanned.i18n_files.iter().any(|f| f.relative_dir == file) {
            return Err(CliError::Failed(format!(
                "{} has no translation file {file}. Its files are: {}.",
                scanned.unique_id,
                file_names(scanned)
            )));
        }
    }
    let state = translations::load(&context.state_root, &scanned.unique_id)?;
    let mut rows = Vec::new();
    for i18n in &scanned.i18n_files {
        if file.is_some_and(|file| file != i18n.relative_dir) {
            continue;
        }
        let loaded = scanner::load_strings_checked(
            Path::new(&i18n.default_path),
            Path::new(&i18n.target_path),
            &state,
            &i18n.relative_dir,
        )?;
        rows.extend(
            loaded
                .into_iter()
                .map(|row| (i18n.relative_dir.clone(), row)),
        );
    }
    Ok(rows)
}

fn file_names(scanned: &ScannedMod) -> String {
    scanned
        .i18n_files
        .iter()
        .map(|file| file.relative_dir.as_str())
        .collect::<Vec<_>>()
        .join(", ")
}

fn shown_folder(context: &Context, folder: &str) -> String {
    Path::new(folder)
        .strip_prefix(&context.mods_root)
        .map(|relative| relative.display().to_string())
        .unwrap_or_else(|_| folder.to_string())
}

fn list(context: &Context) -> CliResult<Value> {
    let scan = context.scan();
    let mods = scan
        .mods
        .iter()
        .map(|scanned| {
            json!({
                "uniqueId": scanned.unique_id,
                "name": scanned.name,
                "version": scanned.version,
                "folder": shown_folder(context, &scanned.folder_path),
                "totalKeys": scanned.total_keys,
                "statusCounts": scanned.status_counts,
                "progress": scanned.progress,
                "files": scanned.i18n_files.iter().map(|file| json!({
                    "file": file.relative_dir,
                    "totalKeys": file.total_keys,
                    "translatedKeys": file.translated_keys,
                    "reviewNeeded": file.review_needed,
                })).collect::<Vec<_>>(),
            })
        })
        .collect::<Vec<_>>();
    let skipped = scan
        .skipped_components
        .iter()
        .filter(|component| component.requires_attention)
        .map(|component| {
            json!({ "location": component.relative_location, "reason": component.reason })
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "ok": true,
        "targetLang": context.target_lang,
        "mods": mods,
        "warnings": scan.warnings,
        "skipped": skipped,
    }))
}

const PULL_STATUSES: &[&str] = &["untranslated", "outdated", "review-needed", "translated"];

fn pull(context: &Context, args: &Args) -> CliResult<Value> {
    let unique_id = args.required("--mod")?;
    let statuses: Vec<&str> = match args.value("--status").unwrap_or("untranslated,outdated") {
        "all" => PULL_STATUSES.to_vec(),
        list => list
            .split(',')
            .map(str::trim)
            .map(|status| {
                PULL_STATUSES
                    .iter()
                    .copied()
                    .find(|known| *known == status)
                    .ok_or_else(|| {
                        CliError::Usage(format!(
                            "Unknown status {status}. Use {} or all.",
                            PULL_STATUSES.join(", ")
                        ))
                    })
            })
            .collect::<CliResult<_>>()?,
    };
    let limit = match args.value("--limit") {
        Some(value) => Some(
            value
                .parse::<usize>()
                .ok()
                .filter(|limit| *limit > 0)
                .ok_or_else(|| CliError::Usage("--limit must be a positive number.".into()))?,
        ),
        None => None,
    };

    let scan = context.scan();
    let scanned = find_mod(&scan, unique_id)?;
    let rows = load_rows(context, scanned, args.value("--file"))?;
    let glossary = glossary::load(&context.data_dir, &context.target_lang);
    let matching = rows
        .iter()
        .filter(|(_, row)| statuses.contains(&row.status.as_str()))
        .collect::<Vec<_>>();
    let selected = &matching[..limit.map_or(matching.len(), |limit| limit.min(matching.len()))];
    let strings = selected
        .iter()
        .map(|(file, row)| pulled_string(file, row, glossary.as_ref()))
        .collect::<Vec<_>>();

    let document = json!({
        "format": STRINGS_FORMAT,
        "version": STRINGS_VERSION,
        "modUniqueId": scanned.unique_id,
        "modName": scanned.name,
        "targetLang": context.target_lang,
        "strings": strings,
    });
    let summary = |document: Option<Value>| {
        let mut body = json!({
            "ok": true,
            "modUniqueId": scanned.unique_id,
            "returned": selected.len(),
            "remaining": matching.len() - selected.len(),
        });
        note_outdated_glossary(&mut body, glossary.as_ref());
        if let Some(document) = document {
            body["document"] = document;
        }
        body
    };
    match args.value("--out") {
        Some(out) => {
            let body = serde_json::to_string_pretty(&document)
                .map_err(|error| format!("Could not write the strings file: {error}"))?;
            std::fs::write(out, body).map_err(|error| format!("Could not write {out}: {error}"))?;
            let mut body = summary(None);
            body["out"] = Value::String(out.to_string());
            Ok(body)
        }
        None => Ok(summary(Some(document))),
    }
}

/// Add a non-blocking note when the loaded glossary comes from an older app
/// version. The CLI cannot rebuild it; current and missing glossaries add nothing.
fn note_outdated_glossary(body: &mut Value, glossary: Option<&glossary::Glossary>) {
    if glossary.is_some_and(|glossary| glossary.format < glossary::GLOSSARY_FORMAT) {
        body["glossaryOutdated"] = Value::Bool(true);
        body["glossaryNotice"] = Value::String(
            "The glossary was built by an older app version. Rebuild it in the app's Settings."
                .into(),
        );
    }
}

fn pulled_string(file: &str, row: &StringRow, glossary: Option<&glossary::Glossary>) -> Value {
    let mut entry = json!({
        "file": file,
        "key": row.key,
        "source": row.source,
        "target": row.target,
        "status": row.status,
    });
    if let Some(section) = &row.section {
        entry["section"] = Value::String(section.clone());
    }
    let mut protected = Vec::new();
    for token in tokens::extract(&row.source) {
        if !protected.contains(&token) {
            protected.push(token);
        }
    }
    if !protected.is_empty() {
        entry["tokens"] = json!(protected);
    }
    let terms = glossary
        .map(|glossary| glossary::match_terms(&row.source, glossary))
        .unwrap_or_default();
    if !terms.is_empty() {
        entry["glossary"] = terms
            .into_iter()
            .map(|(source, target)| json!({ "source": source, "target": target }))
            .collect();
    }
    entry
}

/// A strings file as `pull` writes it. Only the identity, the English source
/// it was translated from, and the translation are read back.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StringsFile {
    format: String,
    version: u64,
    mod_unique_id: String,
    target_lang: String,
    strings: Vec<PushedString>,
}

#[derive(Deserialize)]
struct PushedString {
    file: String,
    key: String,
    source: String,
    target: String,
}

fn read_strings_file(path: &Path) -> CliResult<StringsFile> {
    let body = crate::input_limits::read_json_text(path)?;
    let parsed: Value = serde_json::from_str(&body)
        .map_err(|error| format!("{} is not valid JSON: {error}", path.display()))?;
    if parsed.get("format").and_then(Value::as_str) != Some(STRINGS_FORMAT) {
        return Err(CliError::Failed(format!(
            "{} is not a strings file from pull (expected format {STRINGS_FORMAT}).",
            path.display()
        )));
    }
    let file: StringsFile = serde_json::from_value(parsed)
        .map_err(|error| format!("{} is damaged: {error}", path.display()))?;
    if file.format != STRINGS_FORMAT || file.version != STRINGS_VERSION {
        return Err(CliError::Failed(format!(
            "{} has version {}, but this tool reads version {STRINGS_VERSION}. Pull a new file.",
            path.display(),
            file.version
        )));
    }
    Ok(file)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Rejected {
    file: String,
    key: String,
    reason: &'static str,
    message: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    differences: Vec<Value>,
}

impl Rejected {
    fn new(file: &str, key: &str, reason: &'static str, message: impl Into<String>) -> Self {
        Rejected {
            file: file.to_string(),
            key: key.to_string(),
            reason,
            message: message.into(),
            differences: Vec::new(),
        }
    }
}

fn token_json(difference: &tokens::TokenDifference) -> Value {
    json!({
        "token": difference.token,
        "sourceCount": difference.source_count,
        "targetCount": difference.target_count,
        "severity": difference.severity,
    })
}

/// Game-breaking token errors reject a string; anything else is saved.
fn token_rejection(file: &str, key: &str, source: &str, target: &str) -> Option<Rejected> {
    let blocking = tokens::blocking_differences(source, target);
    if blocking.is_empty() {
        return None;
    }
    let mut rejected = Rejected::new(
        file,
        key,
        "token-error",
        tokens::explain_differences(&blocking, target),
    );
    rejected.differences = blocking.iter().map(token_json).collect();
    Some(rejected)
}

/// Non-blocking findings: token warnings and glossary terms whose official
/// translation does not appear in the target.
fn string_warnings(
    file: &str,
    key: &str,
    source: &str,
    target: &str,
    glossary: Option<&glossary::Glossary>,
) -> Vec<Value> {
    let mut warnings = tokens::token_differences(source, target)
        .iter()
        .filter(|difference| !difference.is_error())
        .map(|difference| {
            let mut warning = token_json(difference);
            warning["file"] = json!(file);
            warning["key"] = json!(key);
            warning["kind"] = json!("token");
            warning
        })
        .collect::<Vec<_>>();
    if let Some(glossary) = glossary {
        let lowered = target.to_lowercase();
        for (term, expected) in glossary::match_terms(source, glossary) {
            if !lowered.contains(&expected.to_lowercase()) {
                warnings.push(json!({
                    "file": file,
                    "key": key,
                    "kind": "glossary",
                    "term": term,
                    "expected": expected,
                }));
            }
        }
    }
    warnings
}

fn push(context: &Context, path: &Path, status: &str, dry_run: bool) -> CliResult<Outcome> {
    let file = read_strings_file(path)?;
    if file.target_lang != context.target_lang {
        return Err(CliError::Failed(format!(
            "The strings file is for language {}, but the target language is {}. Pass --lang {} to use it.",
            file.target_lang, context.target_lang, file.target_lang
        )));
    }
    let scan = context.scan();
    let scanned = find_mod(&scan, &file.mod_unique_id)?;
    let rows = load_rows(context, scanned, None)?;
    let rows: HashMap<(&str, &str), &StringRow> = rows
        .iter()
        .map(|(file, row)| ((file.as_str(), row.key.as_str()), row))
        .collect();
    let glossary = glossary::load(&context.data_dir, &context.target_lang);

    let mut seen = HashSet::new();
    let mut entries = Vec::new();
    let mut rejected = Vec::new();
    let mut warnings = Vec::new();
    let (mut unchanged, mut empty, mut still_changed) = (0usize, 0usize, 0usize);
    for string in &file.strings {
        if !seen.insert((string.file.as_str(), string.key.as_str())) {
            return Err(CliError::Failed(format!(
                "The strings file lists {} · {} more than once. Nothing was saved.",
                string.file, string.key
            )));
        }
        let Some(row) = rows.get(&(string.file.as_str(), string.key.as_str())) else {
            rejected.push(Rejected::new(
                &string.file,
                &string.key,
                "unknown-key",
                "The mod no longer has this string. Pull again.",
            ));
            continue;
        };
        if row.source != string.source {
            rejected.push(Rejected::new(
                &string.file,
                &string.key,
                "source-changed",
                "The English text changed since the pull. Pull again and translate the new text.",
            ));
            continue;
        }
        // Whitespace reads back as untranslated; only a single space is the
        // app's deliberate blank.
        if string.target.trim().is_empty() && string.target != " " {
            empty += 1;
            continue;
        }
        let same_target = row.target == string.target;
        // Sending a Changed string back unedited does not confirm it: the old
        // text was written for the previous English source. `done` does that.
        if same_target && row.status == "outdated" {
            still_changed += 1;
            continue;
        }
        // Keep a token mismatch the translator accepted in the app.
        let accepted_mismatch = same_target && row.token_mismatch_accepted;
        if !accepted_mismatch {
            if let Some(rejection) =
                token_rejection(&string.file, &string.key, &string.source, &string.target)
            {
                rejected.push(rejection);
                continue;
            }
        }
        warnings.extend(string_warnings(
            &string.file,
            &string.key,
            &string.source,
            &string.target,
            glossary.as_ref(),
        ));
        if same_target && row.status == status {
            unchanged += 1;
            continue;
        }
        let stored_status = match (accepted_mismatch, status) {
            (true, "review-needed") => translations::REVIEW_NEEDED_TOKEN_MISMATCH_ACCEPTED_STATUS,
            (true, _) => translations::TOKEN_MISMATCH_ACCEPTED_STATUS,
            (false, status) => status,
        };
        entries.push((
            translations::entry_key(&string.file, &string.key),
            StoredString {
                target: string.target.clone(),
                status: translations::status_for_save(
                    &string.source,
                    &string.target,
                    stored_status,
                ),
                source_hash: translations::source_hash(&string.source),
            },
        ));
    }

    let mut body = json!({
        "ok": true,
        "modUniqueId": scanned.unique_id,
        "dryRun": dry_run,
        "status": status,
        "saved": if dry_run { 0 } else { entries.len() },
        "wouldSave": entries.len(),
        "unchanged": unchanged,
        "skippedEmpty": empty,
        "skippedStillChanged": still_changed,
        "rejected": rejected,
        "warnings": warnings,
    });
    note_outdated_glossary(&mut body, glossary.as_ref());
    if !dry_run && !entries.is_empty() {
        let id = record_change(context, "push", &scanned.unique_id, entries)?;
        body["operationId"] = Value::String(id);
    }
    Ok(Outcome {
        body,
        rejected: !rejected.is_empty(),
    })
}

fn done(context: &Context, args: &Args) -> CliResult<Outcome> {
    let unique_id = args.required("--mod")?;
    let scan = context.scan();
    let scanned = find_mod(&scan, unique_id)?;
    let rows = load_rows(context, scanned, args.value("--file"))?;

    let selected: Vec<&(String, StringRow)> = match args.value("--keys") {
        Some(keys) => {
            let mut selected = Vec::new();
            let mut seen = HashSet::new();
            for key in keys.split(',').map(str::trim).filter(|key| !key.is_empty()) {
                if !seen.insert(key) {
                    return Err(CliError::Usage(format!(
                        "--keys lists {key} more than once."
                    )));
                }
                let found = rows
                    .iter()
                    .filter(|(_, row)| row.key == key)
                    .collect::<Vec<_>>();
                match found.as_slice() {
                    [row] => selected.push(*row),
                    [] => {
                        return Err(CliError::Failed(format!(
                            "{} has no string {key}. Nothing was changed.",
                            scanned.unique_id
                        )))
                    }
                    _ => {
                        return Err(CliError::Failed(format!(
                            "{key} exists in several files ({}). Pass --file. Nothing was changed.",
                            file_names(scanned)
                        )))
                    }
                }
            }
            if selected.is_empty() {
                return Err(CliError::Usage("--keys names no key.".to_string()));
            }
            selected
        }
        None => rows
            .iter()
            .filter(|(_, row)| row.status == "review-needed")
            .collect(),
    };

    let mut entries = Vec::new();
    let mut rejected = Vec::new();
    let mut unchanged = 0usize;
    for (file, row) in selected {
        match row.status.as_str() {
            "translated" => {
                unchanged += 1;
                continue;
            }
            "untranslated" => {
                rejected.push(Rejected::new(
                    file,
                    &row.key,
                    "no-translation",
                    "This string has no translation yet.",
                ));
                continue;
            }
            _ => {}
        }
        let status = if row.token_mismatch_accepted {
            translations::TOKEN_MISMATCH_ACCEPTED_STATUS
        } else if let Some(rejection) = token_rejection(file, &row.key, &row.source, &row.target) {
            rejected.push(rejection);
            continue;
        } else {
            "translated"
        };
        entries.push((
            translations::entry_key(file, &row.key),
            StoredString {
                target: row.target.clone(),
                status: translations::status_for_save(&row.source, &row.target, status),
                source_hash: translations::source_hash(&row.source),
            },
        ));
    }

    let mut body = json!({
        "ok": true,
        "modUniqueId": scanned.unique_id,
        "marked": entries.len(),
        "unchanged": unchanged,
        "rejected": rejected,
    });
    if !entries.is_empty() {
        let id = record_change(context, "done", &scanned.unique_id, entries)?;
        body["operationId"] = Value::String(id);
    }
    Ok(Outcome {
        body,
        rejected: !rejected.is_empty(),
    })
}

/// One saved change that `undo` can restore while its strings are unchanged.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryRecord {
    id: String,
    command: String,
    mod_unique_id: String,
    completed_at_epoch_ms: u64,
    changes: Vec<HistoryChange>,
}

#[derive(Serialize, Deserialize)]
struct HistoryChange {
    key: String,
    previous: Option<StoredString>,
    applied: StoredString,
}

/// Save `entries` and keep a record to undo them. The record is written
/// first: a save without a record could not be undone, while a record whose
/// save failed is removed again.
fn record_change(
    context: &Context,
    command: &str,
    unique_id: &str,
    entries: Vec<(String, StoredString)>,
) -> CliResult<String> {
    let before = translations::load(&context.state_root, unique_id)?;
    let completed_at_epoch_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default();
    let directory = context.history_dir();
    std::fs::create_dir_all(&directory).map_err(|error| {
        format!(
            "Could not create the undo folder {}: {error}",
            directory.display()
        )
    })?;
    let mut sequence = 0u32;
    let (id, path) = loop {
        let id = format!("{completed_at_epoch_ms}-{sequence}-{command}");
        let path = directory.join(format!("{id}.json"));
        if !path.exists() {
            break (id, path);
        }
        sequence += 1;
    };
    let record = HistoryRecord {
        id: id.clone(),
        command: command.to_string(),
        mod_unique_id: unique_id.to_string(),
        completed_at_epoch_ms,
        changes: entries
            .iter()
            .map(|(key, applied)| HistoryChange {
                key: key.clone(),
                previous: before.get(key).cloned(),
                applied: applied.clone(),
            })
            .collect(),
    };
    let body = serde_json::to_vec_pretty(&record)
        .map_err(|error| format!("Could not record the change for undo: {error}"))?;
    crate::input_limits::write_synced(&path, &body)
        .map_err(|error| format!("Could not record the change for undo: {error}"))?;
    if let Err(error) = translations::save_many(&context.state_root, unique_id, entries) {
        let _ = std::fs::remove_file(&path);
        return Err(error.into());
    }
    prune_history(&directory);
    Ok(id)
}

/// Record files, newest first.
fn history_files(directory: &Path) -> Vec<PathBuf> {
    let mut files = std::fs::read_dir(directory)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    files.sort_by_key(|path| std::cmp::Reverse(history_order(path)));
    files
}

/// Sort key from the file name `<epoch ms>-<sequence>-<command>.json`.
fn history_order(path: &Path) -> (u64, u32) {
    let stem = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or_default();
    let mut parts = stem.splitn(3, '-');
    let millis = parts.next().and_then(|part| part.parse().ok()).unwrap_or(0);
    let sequence = parts.next().and_then(|part| part.parse().ok()).unwrap_or(0);
    (millis, sequence)
}

fn prune_history(directory: &Path) {
    for old in history_files(directory).into_iter().skip(MAX_HISTORY) {
        let _ = std::fs::remove_file(old);
    }
}

fn read_record(path: &Path) -> CliResult<HistoryRecord> {
    let body = crate::input_limits::read_json_text(path)?;
    serde_json::from_str(&body).map_err(|error| {
        CliError::Failed(format!(
            "The undo record {} is damaged: {error}",
            path.display()
        ))
    })
}

/// `<epoch ms>-<sequence>-<push|done>`, as `record_change` names records.
fn is_operation_id(id: &str) -> bool {
    let digits = |part: &str| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit());
    let mut parts = id.splitn(3, '-');
    matches!(
        (parts.next(), parts.next(), parts.next()),
        (Some(millis), Some(sequence), Some("push" | "done")) if digits(millis) && digits(sequence)
    )
}

fn list_history(context: &Context) -> CliResult<Value> {
    let operations = history_files(&context.history_dir())
        .iter()
        .map(|path| match read_record(path) {
            Ok(record) => json!({
                "id": record.id,
                "command": record.command,
                "modUniqueId": record.mod_unique_id,
                "strings": record.changes.len(),
                "completedAtEpochMs": record.completed_at_epoch_ms,
            }),
            Err(CliError::Usage(error) | CliError::Failed(error)) => json!({
                "id": path.file_stem().map(|stem| stem.to_string_lossy()),
                "damaged": error,
            }),
        })
        .collect::<Vec<_>>();
    Ok(json!({ "ok": true, "operations": operations }))
}

fn undo(context: &Context, id: Option<&str>) -> CliResult<Outcome> {
    let directory = context.history_dir();
    let path = match id {
        Some(id) => {
            if !is_operation_id(id) {
                return Err(CliError::Usage(format!("{id} is not an operation id.")));
            }
            let path = directory.join(format!("{id}.json"));
            if !path.is_file() {
                return Err(CliError::Failed(format!(
                    "There is no operation {id} to undo. Run undo --list."
                )));
            }
            path
        }
        None => history_files(&directory)
            .into_iter()
            .next()
            .ok_or_else(|| "There is nothing to undo.".to_string())?,
    };
    let record = read_record(&path)?;
    let total = record.changes.len();
    let changed_since = translations::replace_if_unchanged(
        &context.state_root,
        &record.mod_unique_id,
        record
            .changes
            .into_iter()
            .map(|change| (change.key, change.applied, change.previous))
            .collect(),
    )?;
    // The state is already restored; a record left behind only lists strings
    // as changed since if undone again.
    let warnings = match std::fs::remove_file(&path) {
        Ok(()) => Vec::new(),
        Err(error) => vec![format!(
            "Could not remove the undo record {}: {error}",
            path.display()
        )],
    };
    let kept = changed_since
        .iter()
        .map(|key| {
            let (file, key) = key.split_once('\u{0}').unwrap_or(("", key));
            json!({ "file": file, "key": key })
        })
        .collect::<Vec<_>>();
    Ok(Outcome {
        body: json!({
            "ok": true,
            "operationId": record.id,
            "modUniqueId": record.mod_unique_id,
            "restored": total - kept.len(),
            "keptChangedSince": kept,
            "warnings": warnings,
        }),
        rejected: false,
    })
}

fn export_mods(context: &Context, args: &Args) -> CliResult<Value> {
    let scan = context.scan();
    let selected: Vec<&ScannedMod> = match args.value("--mod") {
        Some(unique_id) => vec![find_mod(&scan, unique_id)?],
        None => scan
            .mods
            .iter()
            .filter(|scanned| !scanned.i18n_files.is_empty())
            .collect(),
    };
    let requests = selected
        .iter()
        .map(|scanned| export::ExportModInput {
            mod_unique_id: scanned.unique_id.clone(),
            mod_name: scanned.name.clone(),
            files: scanned
                .i18n_files
                .iter()
                .map(|file| export::ExportFileInput {
                    relative_dir: file.relative_dir.clone(),
                    default_path: file.default_path.clone(),
                    target_path: file.target_path.clone(),
                })
                .collect(),
        })
        .collect::<Vec<_>>();
    let mods = export::resolve_scanned_inputs(&scan, &requests)?;
    let files = mods
        .iter()
        .flat_map(|request| request.files.iter().cloned())
        .collect::<Vec<_>>();
    export::validate_paths(&context.mods_root, &context.target_lang, &files)?;

    if args.flag("--dry-run") {
        let mut preview = export::preview_export(&context.state_root, &mods)?;
        for file in &mut preview.files {
            file.target_path = shown_folder(context, &file.target_path);
        }
        return Ok(json!({ "ok": true, "dryRun": true, "preview": preview }));
    }
    let mut result = export::export_all_mods(&context.state_root, &mods)?;
    for exported in &mut result.mods {
        export::show_relative_paths(&mut exported.result.files, &context.mods_root);
    }
    Ok(json!({ "ok": true, "dryRun": false, "result": result }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn parses_options_flags_and_positionals() {
        let parsed = Args::parse(args(&[
            "push",
            "file.json",
            "--status=review-needed",
            "--lang",
            "de",
        ]))
        .unwrap();
        assert_eq!(parsed.command.as_deref(), Some("push"));
        assert_eq!(parsed.positionals, ["file.json"]);
        assert_eq!(parsed.value("--status"), Some("review-needed"));
        assert_eq!(parsed.value("--lang"), Some("de"));
        assert!(Args::parse(args(&["list", "--bogus"])).is_err());
        assert!(Args::parse(args(&["pull", "--mod"])).is_err());
        assert!(Args::parse(args(&["pull", "--mod", "a", "--mod", "b"])).is_err());
        assert!(Args::parse(args(&["export", "--all=yes"])).is_err());
    }

    #[test]
    fn commands_reject_options_they_do_not_use() {
        let parsed = Args::parse(args(&["list", "--mod", "Example"])).unwrap();
        assert!(matches!(parsed.allow(&[], 0), Err(CliError::Usage(_))));
        let parsed = Args::parse(args(&["list", "--lang", "de"])).unwrap();
        assert!(parsed.allow(&[], 0).is_ok());
    }

    /// A synthetic portable profile and Mods folder with one German-target mod.
    struct Fixture {
        root: PathBuf,
    }

    impl Fixture {
        fn new(tag: &str) -> Self {
            let root = crate::test_support::temp_dir(tag);
            let i18n = root.join("Mods").join("Example").join("i18n");
            std::fs::create_dir_all(&i18n).unwrap();
            std::fs::create_dir_all(root.join("data")).unwrap();
            std::fs::write(
                root.join("Mods").join("Example").join("manifest.json"),
                r#"{ "Name": "Example", "Author": "Fixture", "Version": "1.0.0", "UniqueID": "Fixture.Example", "EntryDll": "Example.dll" }"#,
            )
            .unwrap();
            std::fs::write(
                i18n.join("default.json"),
                r#"{ "greeting": "Hello, {{name}}!", "farewell": "Goodbye.", "other": "Later." }"#,
            )
            .unwrap();
            std::fs::write(
                root.join("data").join("settings.json"),
                serde_json::to_string(&json!({
                    "targetLang": "de",
                    "modsPath": root.join("Mods").display().to_string(),
                }))
                .unwrap(),
            )
            .unwrap();
            Fixture { root }
        }

        fn run(&self, values: &[&str]) -> Outcome {
            let mut values = args(values);
            values.push("--data".into());
            values.push(self.root.join("data").display().to_string());
            match dispatch(&Args::parse(values).unwrap()) {
                Ok(outcome) => outcome,
                Err(CliError::Usage(error) | CliError::Failed(error)) => panic!("{error}"),
            }
        }

        fn fail(&self, values: &[&str]) -> String {
            let mut values = args(values);
            values.push("--data".into());
            values.push(self.root.join("data").display().to_string());
            match dispatch(&Args::parse(values).unwrap()) {
                Ok(outcome) => panic!("expected a failure, got {}", outcome.body),
                Err(CliError::Usage(error) | CliError::Failed(error)) => error,
            }
        }

        /// Pull every untranslated string and fill in `targets` by key.
        fn translated_file(&self, targets: &[(&str, &str)]) -> PathBuf {
            let mut document =
                self.run(&["pull", "--mod", "fixture.example"]).body["document"].clone();
            for string in document["strings"].as_array_mut().unwrap() {
                if let Some((_, target)) = targets.iter().find(|(key, _)| string["key"] == *key) {
                    string["target"] = json!(target);
                }
            }
            let path = self.root.join("strings.json");
            std::fs::write(&path, document.to_string()).unwrap();
            path
        }

        fn statuses(&self) -> Value {
            self.run(&["list"]).body["mods"][0]["statusCounts"].clone()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn pull_lists_open_strings_with_their_tokens() {
        let fixture = Fixture::new("cli-pull");
        let body = fixture
            .run(&["pull", "--mod", "Fixture.Example", "--limit", "2"])
            .body;
        assert_eq!(body["returned"], 2);
        assert_eq!(body["remaining"], 1);
        let strings = body["document"]["strings"].as_array().unwrap();
        assert_eq!(strings[0]["key"], "greeting");
        assert_eq!(strings[0]["tokens"], json!(["{{name}}"]));
        assert_eq!(body["document"]["format"], STRINGS_FORMAT);
    }

    fn save_glossary(fixture: &Fixture, format: u32) {
        let glossary = glossary::Glossary {
            format,
            target_lang: "de".into(),
            ..Default::default()
        };
        glossary::save(&fixture.root.join("data"), &glossary).unwrap();
    }

    #[test]
    fn pull_and_check_report_an_outdated_glossary_only_when_it_is_outdated() {
        let fixture = Fixture::new("cli-glossary-outdated");
        let none = fixture.run(&["pull", "--mod", "Fixture.Example"]).body;
        assert!(none.get("glossaryOutdated").is_none());

        save_glossary(&fixture, glossary::GLOSSARY_FORMAT);
        let path = fixture.translated_file(&[("farewell", "Tschüss.")]);
        let path = path.to_str().unwrap();
        let pulled = fixture.run(&["pull", "--mod", "Fixture.Example"]).body;
        let checked = fixture.run(&["check", path]).body;
        for body in [&pulled, &checked] {
            assert!(body.get("glossaryOutdated").is_none());
            assert!(body.get("glossaryNotice").is_none());
        }

        save_glossary(&fixture, 2);
        let pulled = fixture.run(&["pull", "--mod", "Fixture.Example"]).body;
        let checked = fixture.run(&["check", path]).body;
        for body in [&pulled, &checked] {
            assert_eq!(body["glossaryOutdated"], true);
            assert!(body["glossaryNotice"].as_str().unwrap().contains("Rebuild"));
        }
    }

    #[test]
    fn push_saves_finished_strings_and_rejects_game_breaking_ones() {
        let fixture = Fixture::new("cli-push");
        let file =
            fixture.translated_file(&[("greeting", "Hallo, {{name}!"), ("farewell", "Tschüss.")]);
        let path = file.display().to_string();

        let check = fixture.run(&["check", &path]);
        assert!(check.rejected);
        assert_eq!(check.body["wouldSave"], 1);
        assert_eq!(fixture.statuses()["translated"], 0, "check never saves");

        let push = fixture.run(&["push", &path]);
        assert!(push.rejected);
        assert_eq!(push.body["saved"], 1);
        assert_eq!(push.body["rejected"][0]["key"], "greeting");
        assert_eq!(push.body["rejected"][0]["reason"], "token-error");
        assert_eq!(push.body["skippedEmpty"], 1);
        assert_eq!(fixture.statuses()["translated"], 1);
    }

    #[test]
    fn push_rejects_a_string_whose_english_text_changed() {
        let fixture = Fixture::new("cli-stale");
        let file = fixture.translated_file(&[("farewell", "Tschüss.")]);
        std::fs::write(
            fixture.root.join("Mods/Example/i18n/default.json"),
            r#"{ "greeting": "Hello, {{name}}!", "farewell": "Bye now.", "other": "Later." }"#,
        )
        .unwrap();
        let push = fixture.run(&["push", &file.display().to_string()]);
        assert_eq!(push.body["saved"], 0);
        assert_eq!(push.body["rejected"][0]["reason"], "source-changed");
    }

    #[test]
    fn review_needed_strings_can_be_marked_done() {
        let fixture = Fixture::new("cli-done");
        let file = fixture.translated_file(&[("farewell", "Tschüss."), ("other", "Später.")]);
        fixture.run(&[
            "push",
            &file.display().to_string(),
            "--status",
            "review-needed",
        ]);
        assert_eq!(fixture.statuses()["review-needed"], 2);

        let done = fixture.run(&["done", "--mod", "Fixture.Example", "--keys", "farewell"]);
        assert_eq!(done.body["marked"], 1);
        let rejected = fixture.run(&["done", "--mod", "Fixture.Example", "--keys", "greeting"]);
        assert_eq!(rejected.body["rejected"][0]["reason"], "no-translation");
        fixture.run(&["done", "--mod", "Fixture.Example", "--all"]);
        assert_eq!(fixture.statuses()["translated"], 2);
        assert_eq!(fixture.statuses()["review-needed"], 0);
    }

    #[test]
    fn undo_restores_a_push_but_keeps_later_edits() {
        let fixture = Fixture::new("cli-undo");
        let file = fixture.translated_file(&[("farewell", "Tschüss."), ("other", "Später.")]);
        fixture.run(&["push", &file.display().to_string()]);
        // A later edit of one string (as the app would make it).
        let state_root = translations::language_root(&fixture.root.join("data"), "de").unwrap();
        translations::save_one(
            &state_root,
            "Fixture.Example",
            translations::entry_key("i18n", "other"),
            StoredString {
                target: "Bis später.".into(),
                status: "translated".into(),
                source_hash: translations::source_hash("Later."),
            },
        )
        .unwrap();

        let undo = fixture.run(&["undo"]);
        assert_eq!(undo.body["restored"], 1);
        assert_eq!(
            undo.body["keptChangedSince"],
            json!([{ "file": "i18n", "key": "other" }])
        );
        let state = translations::load(&state_root, "Fixture.Example").unwrap();
        assert!(!state.contains_key(&translations::entry_key("i18n", "farewell")));
        assert_eq!(
            state[&translations::entry_key("i18n", "other")].target,
            "Bis später."
        );
        assert!(fixture.fail(&["undo"]).contains("nothing to undo"));
    }

    #[test]
    fn export_writes_the_finished_translation_file() {
        let fixture = Fixture::new("cli-export");
        let file = fixture.translated_file(&[("greeting", "Hallo, {{name}}!")]);
        fixture.run(&["push", &file.display().to_string()]);
        let target = fixture.root.join("Mods/Example/i18n/de.json");

        let preview = fixture.run(&["export", "--all", "--dry-run"]);
        assert_eq!(preview.body["preview"]["files"][0]["action"], "create");
        assert!(!target.exists(), "a dry run writes nothing");

        fixture.run(&["export", "--mod", "Fixture.Example"]);
        let written: Value =
            serde_json::from_str(&std::fs::read_to_string(target).unwrap()).unwrap();
        assert_eq!(written, json!({ "greeting": "Hallo, {{name}}!" }));
    }

    #[test]
    fn refuses_to_run_while_another_process_owns_the_data_folder() {
        let fixture = Fixture::new("cli-owned");
        let owner = portable_profile::acquire(&fixture.root.join("data")).unwrap();
        assert!(fixture.fail(&["list"]).contains("Close another Translator"));
        drop(owner);
        fixture.run(&["list"]);
    }

    #[test]
    fn a_strings_file_for_another_language_is_refused() {
        let fixture = Fixture::new("cli-language");
        let file = fixture.translated_file(&[("farewell", "Tschüss.")]);
        let error = fixture.fail(&["push", &file.display().to_string(), "--lang", "fr"]);
        assert!(error.contains("--lang de"), "{error}");
    }

    #[test]
    fn whitespace_targets_are_skipped_but_a_single_space_is_a_deliberate_blank() {
        let fixture = Fixture::new("cli-blank");
        let file = fixture.translated_file(&[("farewell", "\t "), ("other", " ")]);
        let push = fixture.run(&["push", &file.display().to_string()]);
        assert_eq!(push.body["skippedEmpty"], 2, "greeting and farewell");
        assert_eq!(push.body["saved"], 1);
        assert_eq!(fixture.statuses()["translated"], 1);
        assert_eq!(fixture.statuses()["untranslated"], 2);
    }

    #[test]
    fn an_unedited_changed_string_stays_changed_until_done() {
        let fixture = Fixture::new("cli-outdated");
        let file = fixture.translated_file(&[("farewell", "Tschüss.")]);
        fixture.run(&["push", &file.display().to_string()]);
        std::fs::write(
            fixture.root.join("Mods/Example/i18n/default.json"),
            r#"{ "greeting": "Hello, {{name}}!", "farewell": "Bye now.", "other": "Later." }"#,
        )
        .unwrap();
        let file = fixture.translated_file(&[]);
        let push = fixture.run(&["push", &file.display().to_string()]);
        assert_eq!(push.body["skippedStillChanged"], 1);
        assert_eq!(fixture.statuses()["outdated"], 1);
        fixture.run(&["done", "--mod", "Fixture.Example", "--keys", "farewell"]);
        assert_eq!(fixture.statuses()["outdated"], 0);
        assert_eq!(fixture.statuses()["translated"], 1);
    }

    #[test]
    fn push_keeps_a_token_mismatch_accepted_in_the_app() {
        let fixture = Fixture::new("cli-accepted");
        let state_root = translations::language_root(&fixture.root.join("data"), "de").unwrap();
        translations::save_one(
            &state_root,
            "Fixture.Example",
            translations::entry_key("i18n", "greeting"),
            StoredString {
                target: "Hallo!".into(),
                status: translations::TOKEN_MISMATCH_ACCEPTED_STATUS.into(),
                source_hash: translations::source_hash("Hello, {{name}}!"),
            },
        )
        .unwrap();
        let mut document = fixture
            .run(&["pull", "--mod", "Fixture.Example", "--status", "all"])
            .body["document"]
            .clone();
        document["strings"] = json!([document["strings"][0].clone()]);
        let path = fixture.root.join("accepted.json");
        std::fs::write(&path, document.to_string()).unwrap();

        let push = fixture.run(&[
            "push",
            &path.display().to_string(),
            "--status",
            "review-needed",
        ]);
        assert!(!push.rejected, "{}", push.body);
        let state = translations::load(&state_root, "Fixture.Example").unwrap();
        assert_eq!(
            state[&translations::entry_key("i18n", "greeting")].status,
            translations::REVIEW_NEEDED_TOKEN_MISMATCH_ACCEPTED_STATUS
        );
    }

    #[test]
    fn another_language_never_claims_legacy_state() {
        let fixture = Fixture::new("cli-legacy");
        let legacy = fixture.root.join("data/translations");
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(legacy.join("Fixture.Example.json"), "{}").unwrap();
        fixture.run(&["list", "--lang", "fr"]);
        assert!(!legacy.exists());
        let state = fixture.root.join("data/language-state");
        assert!(
            state.join("de/translations/Fixture.Example.json").is_file(),
            "the legacy state belongs to the settings language"
        );
        assert!(!state.join("fr/translations/Fixture.Example.json").exists());
    }

    #[test]
    fn rejects_repeated_keys_and_foreign_operation_ids() {
        let fixture = Fixture::new("cli-ids");
        assert!(fixture
            .fail(&[
                "done",
                "--mod",
                "Fixture.Example",
                "--keys",
                "farewell,farewell"
            ])
            .contains("more than once"));
        assert!(fixture
            .fail(&["undo", "C:foo"])
            .contains("not an operation id"));
        assert!(is_operation_id("1792599193737-0-push"));
        assert!(!is_operation_id("1-0-push:stream"));
        assert!(Args::parse(args(&["pull", "--mod", "--all"])).is_err());
    }

    #[test]
    fn history_order_sorts_by_time_then_sequence() {
        let directory = crate::test_support::temp_dir("cli-history-order");
        std::fs::create_dir_all(&directory).unwrap();
        for name in ["900-0-push", "1000-0-push", "1000-1-done", "99-0-push"] {
            std::fs::write(directory.join(format!("{name}.json")), "{}").unwrap();
        }
        let names = history_files(&directory)
            .iter()
            .map(|path| path.file_stem().unwrap().to_string_lossy().to_string())
            .collect::<Vec<_>>();
        assert_eq!(
            names,
            ["1000-1-done", "1000-0-push", "900-0-push", "99-0-push"]
        );
        std::fs::remove_dir_all(directory).unwrap();
    }
}
