//! Recursive mod scanner — M1 / Issue 4 (SPEC §6).
//!
//! Walks the Mods folder, finds every `manifest.json`, reads its metadata, and
//! discovers the translatable `i18n/` units beneath each mod. String contents
//! are parsed in Issue 5 — this stage only discovers files and groups mods by
//! package (top-level Mods subfolder, SPEC §7.3).
//!
//! Edge cases handled (SPEC §6): nested/multi-component mods (each manifest is
//! its own mod; `i18n/` is associated with the nearest ancestor manifest),
//! multiple `i18n/` folders per mod, malformed manifests (skipped with a
//! warning), `Nexus:-1` sentinel IDs, BOM / `//` + `/* */` comments / trailing
//! commas, missing `UniqueID` (folder-name fallback), and symlink cycles.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

use crate::translations::{self, ModState};

const MAX_DEPTH: usize = 12;
const MAX_DIRS: usize = 200_000;

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScannedI18nFile {
    /// `i18n/` directory relative to the mod folder, e.g. `i18n` or `sub/i18n`.
    pub relative_dir: String,
    pub default_path: String,
    pub target_path: String,
    pub target_exists: bool,
    /// Number of keys in `default.json`.
    pub total_keys: usize,
    /// Source keys with a non-empty value in the target `<lang>.json`.
    pub translated_keys: usize,
    /// Source keys whose saved status is an unreviewed AI suggestion
    /// (`review-needed`) — feeds the dashboard review queue.
    pub review_needed: usize,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScannedMod {
    pub unique_id: String,
    pub name: String,
    pub version: String,
    pub nexus_id: Option<u64>,
    /// Top-level Mods subfolder this mod belongs to (the downloaded package).
    pub package_id: String,
    pub folder_path: String,
    pub i18n_files: Vec<ScannedI18nFile>,
    /// Aggregates across all i18n files.
    pub total_keys: usize,
    pub translated_keys: usize,
    /// Unreviewed AI suggestions across all i18n files (dashboard queue).
    pub review_needed: usize,
    pub progress: f64,
    /// "none" (no keys) | "untranslated" (some missing) | "translated" (all present).
    pub status: String,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub mods: Vec<ScannedMod>,
    pub warnings: Vec<String>,
    pub mod_count: usize,
    pub file_count: usize,
}

/// Make the lenient transformations real SMAPI mods require (Newtonsoft.Json)
/// and parse as JSON. In order: strip a UTF-8 BOM; drop `//` + `/* */` comments
/// and trailing commas; quote bare (unquoted) object keys; escape raw control
/// characters inside string literals.
///
/// Comments are removed **first** so the later string-aware passes are never
/// fooled by quotes that live inside a comment (e.g. `/// foo"` or a
/// commented-out `//"value",` line).
pub fn parse_json_lenient(text: &str) -> Result<Value, String> {
    let text = text.strip_prefix('\u{FEFF}').unwrap_or(text);
    let cleaned = strip_json_comments_and_trailing_commas(text);
    let quoted = quote_bare_keys(&cleaned);
    let escaped = escape_control_chars_in_strings(&quoted);
    serde_json::from_str(&escaped).map_err(|error| error.to_string())
}

/// Quote bare (unquoted, JavaScript-style) object keys: `Key: "v"` -> `"Key": "v"`.
/// Newtonsoft accepts unquoted property names; serde does not. Operates only
/// outside string literals, and only in key position (right after `{` or `,`),
/// so string values and array elements are untouched. Must run **after** comment
/// removal. i18n keys may contain `.`/`-`/`_`/`$`.
pub fn quote_bare_keys(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len() + 16);
    let mut i = 0;
    let mut in_string = false;
    let mut escaped = false;
    // True right after `{` or `,` (a key is expected next), through whitespace.
    let mut expect_key = false;

    while i < chars.len() {
        let c = chars[i];
        if in_string {
            out.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_string = false;
            }
            i += 1;
            continue;
        }
        if c == '"' {
            in_string = true;
            expect_key = false;
            out.push(c);
            i += 1;
        } else if c == '{' || c == ',' {
            expect_key = true;
            out.push(c);
            i += 1;
        } else if c.is_whitespace() {
            out.push(c);
            i += 1;
        } else if expect_key && (c.is_ascii_alphabetic() || c == '_' || c == '$') {
            let start = i;
            while i < chars.len() {
                let d = chars[i];
                if d.is_ascii_alphanumeric() || matches!(d, '_' | '.' | '$' | '-') {
                    i += 1;
                } else {
                    break;
                }
            }
            out.push('"');
            out.extend(&chars[start..i]);
            out.push('"');
            expect_key = false;
        } else {
            expect_key = false;
            out.push(c);
            i += 1;
        }
    }
    out
}

/// Escape raw control characters (literal newline, carriage return, tab, and
/// other `U+0000-U+001F`) that appear **inside** JSON string literals.
///
/// Stardew/SMAPI mods are parsed by Newtonsoft.Json, which tolerates multi-line
/// string values (dialogue split across lines with `$q`/`#$b#` commands). The
/// strict `serde_json` rejects raw control chars in strings, so we convert them
/// to their JSON escapes first. The decoded value is identical; only the on-disk
/// representation differs (and round-trips to strictly-valid JSON on export).
/// Control characters **outside** strings (structural newlines, the indentation
/// tabs, and line-comment terminators) are left untouched.
pub fn escape_control_chars_in_strings(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 16);
    let mut in_string = false;
    let mut escaped = false;

    for ch in text.chars() {
        if !in_string {
            if ch == '"' {
                in_string = true;
            }
            out.push(ch);
            continue;
        }
        if escaped {
            out.push(ch);
            escaped = false;
            continue;
        }
        match ch {
            '\\' => {
                out.push(ch);
                escaped = true;
            }
            '"' => {
                out.push(ch);
                in_string = false;
            }
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

/// Extract a positive Nexus mod id from SMAPI `UpdateKeys`.
///
/// Accepts `Nexus:1234` (whitespace tolerated, optional `@subkey` ignored).
/// Rejects the `Nexus:-1` sentinel and any non-positive value (SPEC §6).
pub fn extract_nexus_id(update_keys: &[String]) -> Option<u64> {
    for key in update_keys {
        let mut parts = key.splitn(2, ':');
        let site = parts.next().unwrap_or_default().trim();
        if !site.eq_ignore_ascii_case("nexus") {
            continue;
        }
        let Some(rest) = parts.next() else { continue };
        let digits: String = rest
            .trim()
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect();
        if let Ok(id) = digits.parse::<u64>() {
            if id > 0 {
                return Some(id);
            }
        }
    }
    None
}

/// Scan `mods_path` for translatable mods, importing for `target_lang`. Saved
/// translation state from `config_dir` is merged into progress counts.
pub fn scan_mods(mods_path: &Path, target_lang: &str, config_dir: &Path) -> ScanResult {
    let mut warnings = Vec::new();
    let mut manifest_files = Vec::new();
    let mut i18n_dirs = Vec::new();
    collect(mods_path, &mut manifest_files, &mut i18n_dirs);

    // Build a mod per manifest, keyed by its folder.
    let mut mods: HashMap<PathBuf, ScannedMod> = HashMap::new();
    let mut order: Vec<PathBuf> = Vec::new();
    let manifest_dirs: HashSet<PathBuf> = manifest_files
        .iter()
        .filter_map(|file| file.parent().map(Path::to_path_buf))
        .collect();

    for manifest in &manifest_files {
        let Some(dir) = manifest.parent() else {
            continue;
        };
        match read_manifest(manifest, dir, mods_path) {
            Ok(scanned) => {
                order.push(dir.to_path_buf());
                mods.insert(dir.to_path_buf(), scanned);
            }
            Err(reason) => warnings.push(format!("Skipped {}: {reason}", manifest.display())),
        }
    }

    // Associate each i18n/ folder with the nearest ancestor manifest, merging
    // saved translation state (cached per mod). A corrupted state file becomes
    // a scan warning (counts degrade to the imported values); it is NOT
    // silently treated as empty, and saves elsewhere refuse to overwrite it.
    let mut state_cache: HashMap<String, ModState> = HashMap::new();
    for i18n_dir in &i18n_dirs {
        let Some(owner) = nearest_manifest_owner(i18n_dir, &manifest_dirs) else {
            continue;
        };
        if let Some(scanned) = mods.get_mut(&owner) {
            let unique_id = scanned.unique_id.clone();
            let state = match state_cache.entry(unique_id.clone()) {
                std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
                std::collections::hash_map::Entry::Vacant(slot) => {
                    let loaded =
                        translations::load(config_dir, &unique_id).unwrap_or_else(|error| {
                            warnings.push(error);
                            ModState::new()
                        });
                    slot.insert(loaded)
                }
            };
            if let Some(file) = build_i18n_file(&owner, i18n_dir, target_lang, state) {
                scanned.i18n_files.push(file);
            }
        }
    }

    // Keep only mods with translatable content; stable order by discovery.
    let mut result_mods: Vec<ScannedMod> = order
        .into_iter()
        .filter_map(|dir| mods.remove(&dir))
        .filter(|m| !m.i18n_files.is_empty())
        .collect();
    for scanned in &mut result_mods {
        scanned
            .i18n_files
            .sort_by(|a, b| a.relative_dir.cmp(&b.relative_dir));
        scanned.total_keys = scanned.i18n_files.iter().map(|f| f.total_keys).sum();
        scanned.translated_keys = scanned.i18n_files.iter().map(|f| f.translated_keys).sum();
        scanned.review_needed = scanned.i18n_files.iter().map(|f| f.review_needed).sum();
        scanned.progress = progress_of(scanned.total_keys, scanned.translated_keys);
        scanned.status = derive_status(scanned.total_keys, scanned.translated_keys).to_string();
    }

    let file_count = result_mods.iter().map(|m| m.i18n_files.len()).sum();
    ScanResult {
        mod_count: result_mods.len(),
        file_count,
        mods: result_mods,
        warnings,
    }
}

fn read_manifest(manifest: &Path, dir: &Path, mods_path: &Path) -> Result<ScannedMod, String> {
    let body =
        std::fs::read_to_string(manifest).map_err(|e| format!("unreadable manifest: {e}"))?;
    let value = parse_json_lenient(&body).map_err(|e| format!("invalid manifest JSON: {e}"))?;
    let object = value.as_object().ok_or("manifest is not an object")?;

    let folder_name = dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown")
        .to_string();

    let unique_id = string_field(object, "UniqueID").unwrap_or_else(|| folder_name.clone());
    let name = string_field(object, "Name").unwrap_or_else(|| folder_name.clone());
    let version = string_field(object, "Version").unwrap_or_default();
    let nexus_id = extract_nexus_id(&update_keys(object));
    let package_id = package_id_for(dir, mods_path).unwrap_or_else(|| folder_name.clone());

    Ok(ScannedMod {
        unique_id,
        name,
        version,
        nexus_id,
        package_id,
        folder_path: dir.display().to_string(),
        i18n_files: Vec::new(),
        total_keys: 0,
        translated_keys: 0,
        review_needed: 0,
        progress: 0.0,
        status: String::new(),
    })
}

fn progress_of(total: usize, translated: usize) -> f64 {
    if total == 0 {
        0.0
    } else {
        translated as f64 / total as f64
    }
}

fn derive_status(total: usize, translated: usize) -> &'static str {
    if total == 0 {
        "none"
    } else if translated >= total {
        "translated"
    } else {
        "untranslated"
    }
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StringRow {
    pub key: String,
    pub source: String,
    pub target: String,
    /// Whether the key exists in the target file (distinguishes "" from absent).
    pub target_present: bool,
    /// untranslated | translated | review-needed | outdated (v1.5 model, SPEC §9)
    pub status: String,
    /// Section this key belongs to — the nearest standalone `//` comment line
    /// above it in `default.json` (v1.5, SPEC §7.4). None = no section.
    pub section: Option<String>,
}

/// Load the paired source/target strings of one i18n file, preserving the key
/// order of `default.json` (serde_json `preserve_order`). Saved translation
/// state overrides the imported target and supplies the per-string status.
pub fn load_strings(
    default_path: &Path,
    target_path: &Path,
    state: &ModState,
    relative_dir: &str,
) -> Vec<StringRow> {
    let Some(body) = std::fs::read_to_string(default_path).ok() else {
        return Vec::new();
    };
    let Some(source) = parse_json_lenient(&body)
        .ok()
        .and_then(|value| value.as_object().cloned())
    else {
        return Vec::new();
    };
    let sections = extract_sections(&body);
    let target_map = read_object(target_path).unwrap_or_default();
    let target = TargetLookup::new(&target_map);
    source
        .iter()
        .filter(|(key, _)| !is_ignored_i18n_key(key))
        .map(|(key, value)| {
            let source_text = value_to_text(value);
            let (effective_target, status) =
                resolve_string(&source_text, target.get(key), state, relative_dir, key);
            StringRow {
                key: key.clone(),
                source: source_text,
                target: effective_target,
                target_present: target.contains(key),
                status,
                section: sections.get(&folded_key(key)).cloned(),
            }
        })
        .collect()
}

/// Section titles from standalone `//` comment lines in `default.json` (v1.5,
/// SPEC §7.4): a comment line on its own starts a section, and every key after
/// it (until the next standalone comment) belongs to that section. Returns
/// folded key → section title. String-aware, so `//` inside a value (URLs) or
/// a trailing same-line comment never starts a section; `/* */` blocks are
/// skipped without effect.
pub(crate) fn extract_sections(text: &str) -> HashMap<String, String> {
    let text = text.strip_prefix('\u{FEFF}').unwrap_or(text);
    let chars: Vec<char> = text.chars().collect();
    let mut sections = HashMap::new();
    let mut current: Option<String> = None;
    // Only whitespace seen so far on the current line → a `//` here is a
    // standalone comment line, not a trailing comment after a value.
    let mut line_blank = true;
    let mut i = 0;
    while i < chars.len() {
        match chars[i] {
            '\n' => {
                line_blank = true;
                i += 1;
            }
            '"' => {
                line_blank = false;
                i += 1;
                let mut key = String::new();
                let mut escaped = false;
                while i < chars.len() {
                    let d = chars[i];
                    i += 1;
                    if escaped {
                        key.push(d);
                        escaped = false;
                    } else if d == '\\' {
                        escaped = true;
                    } else if d == '"' {
                        break;
                    } else {
                        key.push(d);
                    }
                }
                // A string followed by `:` is a key; a value is followed by
                // `,` / `}` instead.
                let mut j = i;
                while j < chars.len() && chars[j].is_whitespace() {
                    j += 1;
                }
                if chars.get(j) == Some(&':') {
                    if let Some(section) = &current {
                        sections.insert(folded_key(&key), section.clone());
                    }
                }
            }
            '/' if chars.get(i + 1) == Some(&'/') => {
                let standalone = line_blank;
                i += 2;
                let mut comment = String::new();
                while i < chars.len() && chars[i] != '\n' {
                    comment.push(chars[i]);
                    i += 1;
                }
                if standalone {
                    // Trim decoration (`// ==== Title ====`) down to the text.
                    let title = comment
                        .trim()
                        .trim_matches(['=', '-', '/', '*', '#'])
                        .trim();
                    if !title.is_empty() {
                        current = Some(title.to_string());
                    }
                }
            }
            '/' if chars.get(i + 1) == Some(&'*') => {
                line_blank = false;
                i += 2;
                while i + 1 < chars.len() && !(chars[i] == '*' && chars[i + 1] == '/') {
                    i += 1;
                }
                i = (i + 2).min(chars.len());
            }
            c => {
                if !c.is_whitespace() {
                    line_blank = false;
                }
                i += 1;
            }
        }
    }
    sections
}

/// Resolve the effective target + status for one key from saved state, falling
/// back to the imported value. Detects `outdated` via the stored source hash.
fn resolve_string(
    source_text: &str,
    imported: Option<&Value>,
    state: &ModState,
    relative_dir: &str,
    key: &str,
) -> (String, String) {
    if let Some(stored) = state.get(&translations::entry_key(relative_dir, key)) {
        // Legacy `not-translatable` (pre-v1.5 status model): kept-English is
        // now an explicit identical translation ("Keep original"). An empty
        // stored target takes the *current* source text — that pair can't be
        // stale, so it skips the outdated check below.
        if stored.status == "not-translatable" && stored.target.trim().is_empty() {
            return (source_text.to_string(), "translated".to_string());
        }
        let status = normalize_status(&stored.status);
        // A `translated` or (AI-suggested) `review-needed` string goes stale when
        // its source changes — both are translations tied to a source hash.
        let status = if (status == "translated" || status == "review-needed")
            && stored.source_hash != translations::source_hash(source_text)
        {
            "outdated".to_string()
        } else {
            status
        };
        return (stored.target.clone(), status);
    }
    let imported_text = imported.map(value_to_text).unwrap_or_default();
    let status = if imported_text.trim().is_empty() {
        "untranslated"
    } else {
        "translated"
    };
    (imported_text, status.to_string())
}

/// Map any stored status (including legacy values) to the recognized set:
/// `untranslated` | `translated` | `review-needed`. (`outdated` is derived
/// from the source hash, never stored.) `review-needed` is an AI suggestion
/// awaiting review (M6); legacy `done`/`imported`/`not-translatable` collapse
/// to `translated` — kept-English is an explicit identical translation since
/// v1.5 (resolve_string fills an empty legacy target with the source).
fn normalize_status(stored: &str) -> String {
    match stored {
        "untranslated" => "untranslated",
        "review-needed" => "review-needed",
        _ => "translated", // done | imported | translated | outdated | not-translatable
    }
    .to_string()
}

fn value_to_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// Keys that are i18n metadata, not translatable strings. `$schema` is the
/// JSON-schema reference SMAPI's i18n loader ignores (it only powers editor
/// autocompletion), so it must not appear in the table or the key counts.
fn is_ignored_i18n_key(key: &str) -> bool {
    key == "$schema"
}

/// SMAPI reads translation keys **case-insensitively and trimmed** — an
/// existing `<lang>.json` whose keys differ from `default.json` only in case
/// or surrounding whitespace works in game, so it must import here too.
pub(crate) fn folded_key(key: &str) -> String {
    key.trim().to_lowercase()
}

/// Lookup over a target i18n object with SMAPI key semantics: exact key first,
/// then a case-insensitive/trimmed match (first such key wins).
pub(crate) struct TargetLookup<'a> {
    map: &'a serde_json::Map<String, Value>,
    folded: HashMap<String, &'a String>,
}

impl<'a> TargetLookup<'a> {
    pub(crate) fn new(map: &'a serde_json::Map<String, Value>) -> Self {
        let mut folded: HashMap<String, &'a String> = HashMap::new();
        for key in map.keys() {
            folded.entry(folded_key(key)).or_insert(key);
        }
        Self { map, folded }
    }

    pub(crate) fn get(&self, key: &str) -> Option<&'a Value> {
        if let Some(value) = self.map.get(key) {
            return Some(value);
        }
        self.folded
            .get(&folded_key(key))
            .and_then(|actual| self.map.get(*actual))
    }

    pub(crate) fn contains(&self, key: &str) -> bool {
        self.get(key).is_some()
    }
}

/// Parse a flat i18n JSON object (lenient), returning its string entries.
pub(crate) fn read_object(path: &Path) -> Option<serde_json::Map<String, Value>> {
    let body = std::fs::read_to_string(path).ok()?;
    parse_json_lenient(&body).ok()?.as_object().cloned()
}

/// (total source keys, source keys with a non-empty **working** target — saved
/// state takes precedence over the imported `<lang>.json` value — and source
/// keys whose stored status is an unreviewed AI suggestion). The review count
/// feeds the dashboard's cross-mod review queue (SPEC §7.0 rollout ④).
fn count_keys(
    default_path: &Path,
    target_path: &Path,
    state: &ModState,
    relative_dir: &str,
) -> (usize, usize, usize) {
    let Some(source) = read_object(default_path) else {
        return (0, 0, 0);
    };
    let target_map = read_object(target_path).unwrap_or_default();
    let target = TargetLookup::new(&target_map);
    let total = source
        .keys()
        .filter(|key| !is_ignored_i18n_key(key))
        .count();
    let translated = source
        .keys()
        .filter(|key| !is_ignored_i18n_key(key))
        .filter(|key| {
            match state.get(&translations::entry_key(relative_dir, key)) {
                // Legacy not-translatable counts as handled even without target
                // text — it resolves to keep-original (source text) on load.
                Some(stored) => {
                    stored.status == "not-translatable" || !stored.target.trim().is_empty()
                }
                None => target
                    .get(key)
                    .and_then(Value::as_str)
                    .is_some_and(|value| !value.trim().is_empty()),
            }
        })
        .count();
    let review_needed = source
        .keys()
        .filter(|key| !is_ignored_i18n_key(key))
        .filter(|key| {
            state
                .get(&translations::entry_key(relative_dir, key))
                .is_some_and(|stored| stored.status == "review-needed")
        })
        .count();
    (total, translated, review_needed)
}

fn string_field(object: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
    match object.get(key) {
        Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
        Some(Value::Number(n)) => Some(n.to_string()),
        _ => None,
    }
}

fn update_keys(object: &serde_json::Map<String, Value>) -> Vec<String> {
    match object.get("UpdateKeys") {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|v| v.as_str().map(String::from))
            .collect(),
        Some(Value::String(s)) => vec![s.clone()],
        _ => Vec::new(),
    }
}

/// The top-level Mods subfolder containing `dir` (the downloaded package).
fn package_id_for(dir: &Path, mods_path: &Path) -> Option<String> {
    let relative = dir.strip_prefix(mods_path).ok()?;
    relative
        .components()
        .next()
        .and_then(|c| c.as_os_str().to_str())
        .map(String::from)
}

fn nearest_manifest_owner(i18n_dir: &Path, manifest_dirs: &HashSet<PathBuf>) -> Option<PathBuf> {
    let mut current = i18n_dir.parent();
    while let Some(dir) = current {
        if manifest_dirs.contains(dir) {
            return Some(dir.to_path_buf());
        }
        current = dir.parent();
    }
    None
}

fn build_i18n_file(
    mod_dir: &Path,
    i18n_dir: &Path,
    target_lang: &str,
    state: &ModState,
) -> Option<ScannedI18nFile> {
    let relative_dir = i18n_dir
        .strip_prefix(mod_dir)
        .ok()?
        .to_str()?
        .replace('\\', "/");
    let default_path = i18n_dir.join("default.json");
    let target_path = i18n_dir.join(format!("{target_lang}.json"));
    let (total_keys, translated_keys, review_needed) =
        count_keys(&default_path, &target_path, state, &relative_dir);
    Some(ScannedI18nFile {
        target_exists: target_path.is_file(),
        default_path: default_path.display().to_string(),
        target_path: target_path.display().to_string(),
        relative_dir,
        total_keys,
        translated_keys,
        review_needed,
    })
}

/// Walk `root`, collecting `manifest.json` files and `i18n/` dirs that contain a
/// `default.json`. Bounded by depth and a visited-canonical-path set (cycles).
fn collect(root: &Path, manifests: &mut Vec<PathBuf>, i18n_dirs: &mut Vec<PathBuf>) {
    let mut visited: HashSet<PathBuf> = HashSet::new();
    let mut stack: Vec<(PathBuf, usize)> = vec![(root.to_path_buf(), 0)];
    let mut dirs_seen = 0usize;

    while let Some((dir, depth)) = stack.pop() {
        if depth > MAX_DEPTH || dirs_seen >= MAX_DIRS {
            continue;
        }
        let canonical = std::fs::canonicalize(&dir).unwrap_or_else(|_| dir.clone());
        if !visited.insert(canonical) {
            continue; // cycle / already visited
        }
        dirs_seen += 1;

        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };

            if file_type.is_file() {
                if path.file_name().is_some_and(|n| n == "manifest.json") {
                    manifests.push(path);
                }
                continue;
            }

            if file_type.is_dir() || file_type.is_symlink() {
                let is_i18n = path
                    .file_name()
                    .is_some_and(|n| n.eq_ignore_ascii_case("i18n"));
                if is_i18n {
                    if path.join("default.json").is_file() {
                        i18n_dirs.push(path);
                    }
                    continue; // no mods nested inside an i18n folder
                }
                stack.push((path, depth + 1));
            }
        }
    }
}

/// Strip `//` and `/* */` comments and trailing commas from JSON-ish text,
/// respecting string literals. Ported from the previous project's parser.
pub fn strip_json_comments_and_trailing_commas(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let len = chars.len();

    // Pass 1: remove comments (keep newlines so error offsets stay sane).
    let mut chunks = Vec::new();
    let mut segment_start = 0;
    let mut in_string = false;
    let mut escaped = false;
    let mut in_line_comment = false;
    let mut in_block_comment = false;
    let mut index = 0;

    while index < len {
        let ch = chars[index];
        let next = if index + 1 < len {
            chars[index + 1]
        } else {
            '\0'
        };

        if in_line_comment {
            if ch == '\n' || ch == '\r' {
                in_line_comment = false;
                chunks.push(ch.to_string());
                segment_start = index + 1;
            }
            index += 1;
            continue;
        }
        if in_block_comment {
            if ch == '*' && next == '/' {
                in_block_comment = false;
                index += 2;
                segment_start = index;
                continue;
            }
            if ch == '\n' || ch == '\r' {
                chunks.push(ch.to_string());
            }
            index += 1;
            continue;
        }
        if in_string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            index += 1;
            continue;
        }
        if ch == '"' {
            in_string = true;
            index += 1;
            continue;
        }
        if ch == '/' && next == '/' {
            chunks.push(chars[segment_start..index].iter().collect::<String>());
            in_line_comment = true;
            index += 2;
            continue;
        }
        if ch == '/' && next == '*' {
            chunks.push(chars[segment_start..index].iter().collect::<String>());
            in_block_comment = true;
            index += 2;
            continue;
        }
        index += 1;
    }
    // Only flush the trailing segment if it is real content — a `//` or `/* */`
    // comment that runs to EOF with no terminating newline must not be re-added.
    if !in_line_comment && !in_block_comment {
        chunks.push(chars[segment_start..].iter().collect::<String>());
    }
    let without_comments: Vec<char> = chunks.join("").chars().collect();

    // Pass 2: drop commas immediately before `}` or `]`.
    let len = without_comments.len();
    let mut out = Vec::new();
    let mut segment_start = 0;
    let mut in_string = false;
    let mut escaped = false;
    let mut index = 0;

    while index < len {
        let ch = without_comments[index];
        if in_string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            index += 1;
            continue;
        }
        if ch == '"' {
            in_string = true;
            index += 1;
            continue;
        }
        if ch == ',' {
            let next_non_ws = without_comments[index + 1..]
                .iter()
                .find(|c| !c.is_whitespace())
                .copied()
                .unwrap_or('\0');
            if next_non_ws == '}' || next_non_ws == ']' {
                out.push(
                    without_comments[segment_start..index]
                        .iter()
                        .collect::<String>(),
                );
                segment_start = index + 1;
            }
        }
        index += 1;
    }
    out.push(without_comments[segment_start..].iter().collect::<String>());
    out.join("")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_comments_and_trailing_commas() {
        let input = "{\n  // line\n  \"a\": \"1\", /* block */\n  \"b\": \"2\",\n}";
        let value = parse_json_lenient(input).unwrap();
        assert_eq!(value["a"], "1");
        assert_eq!(value["b"], "2");
    }

    #[test]
    fn keeps_comment_markers_inside_strings() {
        let value = parse_json_lenient("{ \"url\": \"http://x/* y */\" }").unwrap();
        assert_eq!(value["url"], "http://x/* y */");
    }

    #[test]
    fn accepts_literal_newlines_and_tabs_inside_string_values() {
        // Newtonsoft (SMAPI) tolerates multi-line dialogue values; serde does
        // not. The lenient parser must accept them and preserve the value.
        let input = "{\r\n\t\"k\": \"line one\r\n\tline two\",\r\n\t\"after\": \"ok\" //c\r\n}";
        let value = parse_json_lenient(input).unwrap();
        assert_eq!(value["k"], "line one\r\n\tline two");
        assert_eq!(value["after"], "ok");
    }

    #[test]
    fn strips_trailing_line_comment_without_newline_at_eof() {
        // A `//` comment that ends the file (no trailing newline) must be
        // dropped, not re-added after the closing brace.
        let value =
            parse_json_lenient("{\n  \"k\": \"v\"\n}\n//trailing \"comment\" at eof").unwrap();
        assert_eq!(value["k"], "v");
        assert_eq!(value.as_object().unwrap().len(), 1);
    }

    #[test]
    fn accepts_unquoted_bare_keys() {
        // Newtonsoft accepts JS-style unquoted property names; serde does not.
        let input = "{\n  // by: someone\n  Foo: \"1\", Bar.Baz-2: \"2\",\n}";
        let value = parse_json_lenient(input).unwrap();
        assert_eq!(value["Foo"], "1");
        assert_eq!(value["Bar.Baz-2"], "2");
    }

    #[test]
    fn comment_quotes_do_not_desync_string_tracking() {
        // A quote inside a comment must not be treated as a string boundary.
        let input = "{\n  /// GENERIC DIALOGUE\"\n  //\"commented out value\",\n  \"k\": \"v\"\n}";
        let value = parse_json_lenient(input).unwrap();
        assert_eq!(value["k"], "v");
        assert_eq!(value.as_object().unwrap().len(), 1);
    }

    #[test]
    fn quote_bare_keys_leaves_string_values_and_urls_untouched() {
        let value = parse_json_lenient("{ \"url\": \"https://x.io/a:b\" }").unwrap();
        assert_eq!(value["url"], "https://x.io/a:b");
    }

    #[test]
    fn escape_does_not_touch_structural_whitespace() {
        // A tab between tokens (outside strings) stays structural; the parse
        // still yields the two keys.
        let value = parse_json_lenient("{\n\t\"a\":\t\"1\",\n\t\"b\":\t\"2\"\n}").unwrap();
        assert_eq!(value["a"], "1");
        assert_eq!(value["b"], "2");
    }

    #[test]
    fn nexus_id_parsing() {
        assert_eq!(extract_nexus_id(&["Nexus:7286".into()]), Some(7286));
        assert_eq!(extract_nexus_id(&["Nexus: 7286".into()]), Some(7286));
        assert_eq!(extract_nexus_id(&["Nexus:7286@1.0".into()]), Some(7286));
        assert_eq!(extract_nexus_id(&["Nexus:-1".into()]), None);
        assert_eq!(extract_nexus_id(&["Nexus:0".into()]), None);
        assert_eq!(extract_nexus_id(&["GitHub:Owner/Repo".into()]), None);
        assert_eq!(
            extract_nexus_id(&["GitHub:o/r".into(), "Nexus:42".into()]),
            Some(42)
        );
    }

    fn write(path: &Path, body: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    #[test]
    fn scans_multi_component_package_and_skips_components_without_i18n() {
        let root = crate::test_support::temp_dir("scan-multi");
        // A "Ridgeside-like" package: 3 components with i18n, 1 without.
        let pkg = root.join("Ridgeside Village");
        for (name, nexus) in [
            ("[CP] RSV", "Nexus:7286"),
            ("[CC] RSV", "Nexus:-1"),
            ("RSV", "Nexus:-1"),
        ] {
            write(
                &pkg.join(name).join("manifest.json"),
                &format!("{{ \"Name\": \"{name}\", \"Version\": \"1.0\", \"UniqueID\": \"id.{name}\", \"UpdateKeys\": [ \"{nexus}\" ] }}"),
            );
            write(
                &pkg.join(name).join("i18n").join("default.json"),
                "{ \"k\": \"v\" }",
            );
        }
        // [FTM] component: manifest but no i18n -> excluded.
        write(
            &pkg.join("[FTM] RSV").join("manifest.json"),
            "{ \"Name\": \"[FTM] RSV\", \"UniqueID\": \"id.ftm\" }",
        );
        // A malformed manifest -> skipped with a warning.
        write(&root.join("Broken").join("manifest.json"), "{ not json");

        let result = scan_mods(&root, "de", &root);

        assert_eq!(result.mod_count, 3, "only components with i18n are listed");
        assert!(result.warnings.iter().any(|w| w.contains("Broken")));
        assert!(result
            .mods
            .iter()
            .all(|m| m.package_id == "Ridgeside Village"));
        let cp = result.mods.iter().find(|m| m.name == "[CP] RSV").unwrap();
        assert_eq!(cp.nexus_id, Some(7286));
        assert_eq!(cp.i18n_files.len(), 1);
        assert_eq!(cp.i18n_files[0].relative_dir, "i18n");
        // Sentinel Nexus:-1 -> no id.
        let cc = result.mods.iter().find(|m| m.name == "[CC] RSV").unwrap();
        assert_eq!(cc.nexus_id, None);

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn detects_existing_target_translation() {
        let root = crate::test_support::temp_dir("scan-target");
        let mod_dir = root.join("Mod");
        write(
            &mod_dir.join("manifest.json"),
            "{ \"UniqueID\": \"a.b\", \"Name\": \"Mod\" }",
        );
        write(
            &mod_dir.join("i18n").join("default.json"),
            "{ \"k\": \"v\" }",
        );
        write(&mod_dir.join("i18n").join("de.json"), "{ \"k\": \"w\" }");

        let result = scan_mods(&root, "de", &root);
        let file = &result.mods[0].i18n_files[0];
        assert!(file.target_exists);
        assert!(file.target_path.ends_with("de.json"));

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn counts_keys_and_derives_progress_status() {
        let root = crate::test_support::temp_dir("scan-progress");
        let mod_dir = root.join("Mod");
        write(
            &mod_dir.join("manifest.json"),
            "{ \"UniqueID\": \"a.b\", \"Name\": \"Mod\" }",
        );
        write(
            &mod_dir.join("i18n").join("default.json"),
            "{ \"a\": \"1\", \"b\": \"2\", \"c\": \"3\" }",
        );
        // Only `a` is translated; `b` is empty, `c` missing.
        write(
            &mod_dir.join("i18n").join("de.json"),
            "{ \"a\": \"eins\", \"b\": \"  \" }",
        );

        let scanned = &scan_mods(&root, "de", &root).mods[0];
        assert_eq!(scanned.total_keys, 3);
        assert_eq!(scanned.translated_keys, 1);
        assert!((scanned.progress - 1.0 / 3.0).abs() < 1e-9);
        assert_eq!(scanned.status, "untranslated");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn load_strings_preserves_order_and_pairs_target() {
        let root = crate::test_support::temp_dir("load-strings");
        let i18n = root.join("i18n");
        // Intentionally non-alphabetical to prove order is preserved.
        write(
            &i18n.join("default.json"),
            "{ \"zeta\": \"Z\", \"alpha\": \"A\" }",
        );
        write(&i18n.join("de.json"), "{ \"alpha\": \"Ä\" }");

        let rows = load_strings(
            &i18n.join("default.json"),
            &i18n.join("de.json"),
            &ModState::new(),
            "i18n",
        );
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].key, "zeta");
        assert_eq!(rows[0].source, "Z");
        assert_eq!(rows[0].target, "");
        assert_eq!(rows[1].key, "alpha");
        assert_eq!(rows[1].target, "Ä");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn imports_target_keys_case_insensitively_and_trimmed() {
        // SMAPI reads translation keys case-insensitively (and trims), so an
        // existing de.json with different casing/whitespace must still import.
        let root = crate::test_support::temp_dir("case-fold");
        let i18n = root.join("i18n");
        write(
            &i18n.join("default.json"),
            "{ \"greeting\": \"Hello\", \"bye\": \"Bye\" }",
        );
        write(
            &i18n.join("de.json"),
            "{ \"GREETING\": \"Hallo\", \" bye \": \"Tschüss\" }",
        );

        let rows = load_strings(
            &i18n.join("default.json"),
            &i18n.join("de.json"),
            &ModState::new(),
            "i18n",
        );
        assert_eq!(rows[0].target, "Hallo");
        assert_eq!(rows[0].status, "translated");
        assert!(rows[0].target_present);
        assert_eq!(rows[1].target, "Tschüss");

        // Counts agree: both keys are translated, none awaiting review.
        let state = ModState::new();
        let (total, translated, review) = count_keys(
            &i18n.join("default.json"),
            &i18n.join("de.json"),
            &state,
            "i18n",
        );
        assert_eq!((total, translated, review), (2, 2, 0));

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn ignores_schema_meta_key() {
        let root = crate::test_support::temp_dir("schema-key");
        let i18n = root.join("i18n");
        write(
            &i18n.join("default.json"),
            "{ \"$schema\": \"https://smapi.io/schemas/i18n.json\", \"k\": \"Hello\" }",
        );

        let rows = load_strings(
            &i18n.join("default.json"),
            &i18n.join("de.json"),
            &ModState::new(),
            "i18n",
        );
        assert_eq!(rows.len(), 1, "$schema must not be a translatable row");
        assert_eq!(rows[0].key, "k");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn load_strings_applies_saved_status_and_detects_outdated() {
        let root = crate::test_support::temp_dir("load-status");
        let i18n = root.join("i18n");
        write(&i18n.join("default.json"), "{ \"k\": \"Hello\" }");

        translations::save_one(
            &root,
            "mod.id",
            translations::entry_key("i18n", "k"),
            translations::StoredString {
                target: "Hallo".into(),
                status: "done".into(),
                source_hash: translations::source_hash("Hello"),
            },
        )
        .unwrap();
        let state = translations::load(&root, "mod.id").unwrap();

        let default_path = i18n.join("default.json");
        let target_path = i18n.join("de.json");
        let rows = load_strings(&default_path, &target_path, &state, "i18n");
        assert_eq!(rows[0].target, "Hallo");
        // Legacy "done" normalizes to "translated".
        assert_eq!(rows[0].status, "translated");

        // Source text changed since the translation was saved -> outdated.
        write(&default_path, "{ \"k\": \"Hello there\" }");
        let rows = load_strings(&default_path, &target_path, &state, "i18n");
        assert_eq!(rows[0].status, "outdated");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn count_keys_counts_unreviewed_ai_suggestions() {
        let root = crate::test_support::temp_dir("count-review");
        let i18n = root.join("i18n");
        write(&i18n.join("default.json"), "{ \"a\": \"A\", \"b\": \"B\" }");
        translations::save_one(
            &root,
            "mod.id",
            translations::entry_key("i18n", "a"),
            translations::StoredString {
                target: "KI-Vorschlag".into(),
                status: "review-needed".into(),
                source_hash: translations::source_hash("A"),
            },
        )
        .unwrap();
        let state = translations::load(&root, "mod.id").unwrap();

        let (total, translated, review) = count_keys(
            &i18n.join("default.json"),
            &i18n.join("de.json"),
            &state,
            "i18n",
        );
        assert_eq!((total, translated, review), (2, 1, 1));

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn extract_sections_maps_standalone_comments_to_following_keys() {
        let body = r#"{
  // ==== Harvest tooltips ====
  "HarvestPrice": "Harvest price",
  "ReadyToHarvest": "Ready! See https://example.com//docs", // trailing note
  /* block comments never start a section */
  "StillHarvest": "Still in the first section",

  // NPC dialogue
  "Abigail.Rain": "I love the rain."
}"#;
        let sections = extract_sections(body);
        assert_eq!(
            sections
                .get(&folded_key("HarvestPrice"))
                .map(String::as_str),
            Some("Harvest tooltips")
        );
        // `//` inside a string value and a trailing comment change nothing.
        assert_eq!(
            sections
                .get(&folded_key("ReadyToHarvest"))
                .map(String::as_str),
            Some("Harvest tooltips")
        );
        assert_eq!(
            sections
                .get(&folded_key("StillHarvest"))
                .map(String::as_str),
            Some("Harvest tooltips")
        );
        assert_eq!(
            sections
                .get(&folded_key("Abigail.Rain"))
                .map(String::as_str),
            Some("NPC dialogue")
        );
    }

    #[test]
    fn keys_before_any_comment_have_no_section() {
        let body = "{\n  \"first\": \"No section\",\n  // Later\n  \"second\": \"Sectioned\"\n}";
        let sections = extract_sections(body);
        assert!(sections.get(&folded_key("first")).is_none());
        assert_eq!(
            sections.get(&folded_key("second")).map(String::as_str),
            Some("Later")
        );
    }

    #[test]
    fn load_strings_carries_the_section() {
        let root = crate::test_support::temp_dir("load-sections");
        let i18n = root.join("i18n");
        write(
            &i18n.join("default.json"),
            "{\n  \"plain\": \"A\",\n  // Tooltips\n  \"tip\": \"B\"\n}",
        );
        let state = ModState::default();
        let rows = load_strings(
            &i18n.join("default.json"),
            &i18n.join("de.json"),
            &state,
            "i18n",
        );
        assert_eq!(rows[0].section, None);
        assert_eq!(rows[1].section.as_deref(), Some("Tooltips"));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn legacy_not_translatable_migrates_to_keep_original() {
        // Pre-v1.5 status model: `not-translatable` entries become "keep
        // original" — translated, with an empty stored target resolving to
        // the current source text (SPEC §9).
        let root = crate::test_support::temp_dir("load-keep-original");
        let i18n = root.join("i18n");
        write(
            &i18n.join("default.json"),
            "{ \"empty\": \"Parsnip\", \"kept\": \"Junimo Hut\" }",
        );

        translations::save_one(
            &root,
            "mod.id",
            translations::entry_key("i18n", "empty"),
            translations::StoredString {
                target: String::new(),
                status: "not-translatable".into(),
                source_hash: translations::source_hash("Parsnip"),
            },
        )
        .unwrap();
        translations::save_one(
            &root,
            "mod.id",
            translations::entry_key("i18n", "kept"),
            translations::StoredString {
                target: "Junimo Hut".into(),
                status: "not-translatable".into(),
                source_hash: translations::source_hash("old source"),
            },
        )
        .unwrap();
        let state = translations::load(&root, "mod.id").unwrap();

        let rows = load_strings(
            &i18n.join("default.json"),
            &i18n.join("de.json"),
            &state,
            "i18n",
        );
        // Empty legacy target -> the current source, never stale.
        assert_eq!(rows[0].target, "Parsnip");
        assert_eq!(rows[0].status, "translated");
        // Non-empty legacy target keeps its text; the stale hash makes the
        // regular outdated detection kick in (the point of the migration).
        assert_eq!(rows[1].target, "Junimo Hut");
        assert_eq!(rows[1].status, "outdated");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn fully_translated_mod_is_translated() {
        let root = crate::test_support::temp_dir("scan-imported");
        let mod_dir = root.join("Mod");
        write(&mod_dir.join("manifest.json"), "{ \"UniqueID\": \"a.b\" }");
        write(
            &mod_dir.join("i18n").join("default.json"),
            "{ \"a\": \"1\" }",
        );
        write(&mod_dir.join("i18n").join("de.json"), "{ \"a\": \"eins\" }");

        let scanned = &scan_mods(&root, "de", &root).mods[0];
        assert_eq!(scanned.status, "translated");
        assert!((scanned.progress - 1.0).abs() < 1e-9);

        std::fs::remove_dir_all(&root).ok();
    }

    /// Real-machine smoke check against a local Mods folder. Opt-in: set
    /// `SIT_REAL_MODS_SCAN` to the Mods path (skipped otherwise, e.g. in CI).
    #[test]
    fn reports_scan_on_real_mods() {
        let Ok(mods_path) = std::env::var("SIT_REAL_MODS_SCAN") else {
            eprintln!("scan: SIT_REAL_MODS_SCAN not set — skipped");
            return;
        };
        let mods = Path::new(&mods_path);
        if !mods.is_dir() {
            eprintln!("scan: real Mods folder absent — skipped");
            return;
        }
        let started = std::time::Instant::now();
        let result = scan_mods(mods, "de", &std::env::temp_dir());
        let elapsed = started.elapsed();
        let total_keys: usize = result.mods.iter().map(|m| m.total_keys).sum();
        eprintln!(
            "scan: {} mods, {} i18n files, {} total keys, {} warnings in {:?}",
            result.mod_count,
            result.file_count,
            total_keys,
            result.warnings.len(),
            elapsed
        );
        if let Some(cp) = result
            .mods
            .iter()
            .find(|m| m.name.contains("Ridgeside") && m.name.contains("Content"))
        {
            eprintln!(
                "  Ridgeside [CP]: {} keys, {} translated, status {}",
                cp.total_keys, cp.translated_keys, cp.status
            );
        }
    }
}
