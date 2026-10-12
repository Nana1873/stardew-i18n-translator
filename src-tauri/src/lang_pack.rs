//! Community language-pack detection.
//!
//! A Stardew "language pack" is a Content Patcher content pack that registers an
//! additional in-game language (`Data/AdditionalLanguages` → `LanguageCode`) and
//! ships translated `Strings/*` for it. For a game-unsupported target language we
//! can build a typed glossary from such a pack (English base from the game's
//! `Content/Strings` XNB files + the pack's translated `Strings`). This module only *locates* a
//! usable pack; [`crate::glossary::build_from_pack`] does the extraction.
//!
//! Read-only and narrowly bounded: a pack's
//! `manifest.json` + `content.json` (and the JSON files its `Include` changes
//! load, see [`pack_changes`]) are parsed only to detect the language
//! registration and locate its `Strings/` folder; the game's own `Data/*` is
//! never read here. We do **not** implement Content Patcher — `When` matching is
//! deliberately tolerant (a `Language` string or string array), and anything more
//! complex falls back to a bounded folder probe.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::glossary::StringAssetFormat;
use crate::scanner;

const CONTENT_PATCHER_ID: &str = "Pathoschild.ContentPatcher";

/// A detected community language pack usable as a glossary source.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LanguagePack {
    /// Canonical boundary for every bundled asset read during extraction.
    pub root: PathBuf,
    /// Display name (manifest `Name`, falling back to the folder name).
    pub name: String,
    /// The pack's `Strings/` folder holding glossary-relevant string assets.
    pub strings_dir: PathBuf,
    /// The preferred readable format in `strings_dir` (JSON wins over XNB).
    pub format: StringAssetFormat,
}

/// Result of scanning the Mods folder for a language pack: the best candidate (if
/// any) plus warnings (e.g. when several packs registered the same language).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Detection {
    pub pack: Option<LanguagePack>,
    pub warnings: Vec<String>,
}

/// The in-game language codes a mod registers via `Data/AdditionalLanguages`.
/// Empty unless the mod is a Content Patcher pack whose `content.json` adds at
/// least one language. Used both to detect a glossary source and to exclude
/// language packs from the translatable scan ([`crate::scanner`]).
pub fn registered_language_codes(mod_dir: &Path) -> Vec<String> {
    if !is_content_patcher_pack(mod_dir) {
        return Vec::new();
    }
    match read_json(&mod_dir.join("content.json")) {
        Some(content) => language_codes(&pack_changes(mod_dir, &content)),
        None => Vec::new(),
    }
}

/// Find the best installed community language pack that supplies `target_lang`,
/// scanning `mods_dir`. When several packs register the language the choice is
/// deterministic — most resolvable typed-asset files wins, ties broken by name
/// then path — and a warning records which was used. Returns no pack (and no
/// warning) when none match or no readable typed assets are present.
pub fn detect_language_pack(mods_dir: &Path, target_lang: &str) -> Detection {
    let target = target_lang.trim();
    if target.is_empty() || !mods_dir.is_dir() {
        return Detection::default();
    }

    let mut manifests = Vec::new();
    let mut i18n_dirs = Vec::new();
    scanner::collect(mods_dir, &mut manifests, &mut i18n_dirs);

    // (pack, score), score = count of typed-asset Strings files in the folder.
    let mut candidates: Vec<(LanguagePack, usize)> = Vec::new();
    let mut seen_dirs: HashSet<PathBuf> = HashSet::new();
    for manifest in &manifests {
        let Some(mod_dir) = manifest.parent() else {
            continue;
        };
        if !is_content_patcher_pack(mod_dir) {
            continue;
        }
        let Some(content) = read_json(&mod_dir.join("content.json")) else {
            continue;
        };
        let changes = pack_changes(mod_dir, &content);
        if !language_codes(&changes)
            .iter()
            .any(|code| code.eq_ignore_ascii_case(target))
        {
            continue;
        }
        let Some(strings_dir) = resolve_strings_dir(mod_dir, &changes, target) else {
            continue;
        };
        if !seen_dirs.insert(strings_dir.clone()) {
            continue;
        }
        let Some((format, score)) = typed_asset_score(&strings_dir, target) else {
            continue;
        };
        candidates.push((
            LanguagePack {
                root: match mod_dir.canonicalize() {
                    Ok(root) => root,
                    Err(_) => continue,
                },
                name: pack_name(mod_dir),
                strings_dir,
                format,
            },
            score,
        ));
    }

    // Deterministic: highest score, then name, then path.
    candidates.sort_by(|(a, score_a), (b, score_b)| {
        score_b
            .cmp(score_a)
            .then_with(|| a.name.cmp(&b.name))
            .then_with(|| a.strings_dir.cmp(&b.strings_dir))
    });

    let mut warnings = Vec::new();
    if candidates.len() > 1 {
        if let Some((chosen, _)) = candidates.first() {
            warnings.push(format!(
                "Multiple community language packs provide \"{target}\"; using \"{}\". \
                 Remove the extra pack(s) to silence this.",
                chosen.name
            ));
        }
    }

    Detection {
        pack: candidates.into_iter().next().map(|(pack, _)| pack),
        warnings,
    }
}

/// Whether a mod is a Content Patcher content pack (its manifest's
/// `ContentPackFor.UniqueID` is Content Patcher's id).
fn is_content_patcher_pack(mod_dir: &Path) -> bool {
    read_json(&mod_dir.join("manifest.json"))
        .as_ref()
        .and_then(|manifest| manifest.get("ContentPackFor"))
        .and_then(Value::as_object)
        .and_then(|content_pack_for| content_pack_for.get("UniqueID"))
        .and_then(Value::as_str)
        .is_some_and(|id| id.trim().eq_ignore_ascii_case(CONTENT_PATCHER_ID))
}

/// The language codes added by `EditData` changes targeting
/// `Data/AdditionalLanguages`.
fn language_codes(changes: &[Value]) -> Vec<String> {
    let mut codes = Vec::new();
    for change in changes {
        if !is_action(change, "EditData") || !targets(change, "Data/AdditionalLanguages") {
            continue;
        }
        let Some(entries) = change.get("Entries").and_then(Value::as_object) else {
            continue;
        };
        for entry in entries.values() {
            if let Some(code) = entry.get("LanguageCode").and_then(Value::as_str) {
                let code = code.trim();
                if !code.is_empty() {
                    codes.push(code.to_string());
                }
            }
        }
    }
    codes
}

/// Locate the pack's `Strings/` folder. Resolve a `Load` action's `FromFile` by
/// substituting only the `{{Target}}` token (Content Patcher's per-asset token);
/// fall back to a bounded probe when the path carries other tokens or the action
/// shape is unusual.
fn resolve_strings_dir(mod_dir: &Path, changes: &[Value], target: &str) -> Option<PathBuf> {
    for change in changes {
        if !is_action(change, "Load") || !when_selects_language(change, target) {
            continue;
        }
        let Some(from_file) = change.get("FromFile").and_then(Value::as_str) else {
            continue;
        };
        let Some(target_field) = change.get("Target").and_then(Value::as_str) else {
            continue;
        };
        for token in target_field.split(',') {
            let token = token.trim();
            if !token_is_strings_asset(token) {
                continue;
            }
            let resolved = from_file.replace("{{Target}}", token);
            if resolved.contains("{{") {
                continue; // other unresolved Content Patcher tokens — give up here
            }
            let file = match resolved_pack_file(mod_dir, &resolved) {
                Some(file) => file,
                None => continue,
            };
            if file.is_file() {
                if let Some(parent) = file.parent() {
                    return Some(parent.to_path_buf());
                }
            }
        }
    }
    probe_strings_dir(mod_dir, target)
}

/// Resolve a pack-local `FromFile` path and reject absolute/path-traversal
/// targets. The pack source is intentionally limited to bundled assets.
fn resolved_pack_file(mod_dir: &Path, relative: &str) -> Option<PathBuf> {
    let file = mod_dir.join(relative.replace('\\', "/"));
    if !file.is_file() {
        return None;
    }
    let root = std::fs::canonicalize(mod_dir).ok()?;
    let canonical_file = std::fs::canonicalize(&file).ok()?;
    if !canonical_file.starts_with(root) {
        return None;
    }
    Some(canonical_file)
}

/// Whether a change's `When` selects `target`. Tolerant of the two common shapes
/// — `"Language": "th"` and `"Language": ["th"]` (comma-separated strings too),
/// case-insensitive. Anything else (no `When`, tokenized conditions) is treated
/// as "not selected" so the caller falls back to the folder probe.
fn when_selects_language(change: &Value, target: &str) -> bool {
    let Some(language) = change
        .get("When")
        .and_then(Value::as_object)
        .and_then(|when| {
            when.iter()
                .find(|(key, _)| key.eq_ignore_ascii_case("Language"))
                .map(|(_, value)| value)
        })
    else {
        return false;
    };
    match language {
        Value::String(text) => text
            .split(',')
            .any(|part| part.trim().eq_ignore_ascii_case(target)),
        Value::Array(items) => items
            .iter()
            .filter_map(Value::as_str)
            .any(|text| text.trim().eq_ignore_ascii_case(target)),
        _ => false,
    }
}

/// A `Target` token of the form `Strings/<asset>` (exactly one segment after
/// `Strings/`), so its resolved file's parent is the `Strings/` folder itself —
/// not a nested folder like `Strings/schedules`.
fn token_is_strings_asset(token: &str) -> bool {
    let mut parts = token.splitn(2, '/');
    let head = parts.next().unwrap_or_default();
    let rest = parts.next().unwrap_or_default();
    head.eq_ignore_ascii_case("Strings") && !rest.is_empty() && !rest.contains('/')
}

/// Bounded fallback: the conventional pack layouts first, then a depth-limited
/// search for a `Strings/` folder holding at least one typed asset.
fn probe_strings_dir(mod_dir: &Path, target: &str) -> Option<PathBuf> {
    let root = mod_dir.canonicalize().ok()?;
    for relative in [
        "assets/Content/Strings",
        "assets/Strings",
        "Content/Strings",
        "Strings",
    ] {
        let dir = mod_dir.join(relative).canonicalize().ok();
        let Some(dir) = dir.filter(|dir| dir.starts_with(&root)) else {
            continue;
        };
        if typed_asset_score(&dir, target).is_some() {
            return Some(dir);
        }
    }
    find_strings_dir(&root, mod_dir, target, 0)
}

/// Depth-limited search for a directory named `Strings` containing a typed asset.
fn find_strings_dir(root: &Path, dir: &Path, target: &str, depth: usize) -> Option<PathBuf> {
    if depth > 6 {
        return None;
    }
    let mut subdirs = Vec::new();
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let Ok(path) = entry.path().canonicalize() else {
            continue;
        };
        if !path.starts_with(root) {
            continue;
        }
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let is_strings = path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case("Strings"));
        if is_strings && typed_asset_score(&path, target).is_some() {
            return Some(path);
        }
        subdirs.push(path);
    }
    for sub in subdirs {
        if let Some(found) = find_strings_dir(root, &sub, target, depth + 1) {
            return Some(found);
        }
    }
    None
}

/// How many typed-glossary assets (`Objects.json`, `NPCNames.json`, …) the folder
/// holds. The detector's selection score; 0 means nothing extractable.
fn typed_asset_score(strings_dir: &Path, target: &str) -> Option<(StringAssetFormat, usize)> {
    if !strings_dir.is_dir() {
        return None;
    }
    let assets = crate::glossary::typed_asset_names();
    let json_count = assets
        .iter()
        .filter(|asset| strings_dir.join(format!("{asset}.json")).is_file())
        .count();
    if json_count > 0 {
        return Some((StringAssetFormat::Json, json_count));
    }
    let xnb_count = assets
        .iter()
        .filter(|asset| strings_dir.join(format!("{asset}_{target}.xnb")).is_file())
        .count();
    (xnb_count > 0).then_some((StringAssetFormat::Xnb, xnb_count))
}

/// The pack's display name (manifest `Name`, falling back to the folder name).
fn pack_name(mod_dir: &Path) -> String {
    read_json(&mod_dir.join("manifest.json"))
        .as_ref()
        .and_then(|manifest| manifest.get("Name"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            mod_dir
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("Language pack")
                .to_string()
        })
}

fn changes(content: &Value) -> &[Value] {
    content
        .get("Changes")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

/// How many `Include` levels are followed below `content.json`.
const MAX_INCLUDE_DEPTH: usize = 5;

/// Every change of a pack: `content.json`'s own plus those of the JSON files
/// its `Include` changes load (`FromFile`, comma-separated, relative to the
/// pack folder), followed up to [`MAX_INCLUDE_DEPTH`] levels. Paths with
/// Content Patcher tokens cannot be resolved and are skipped, as are files
/// outside the pack folder and files already read (cycles). `When`
/// conditions are not evaluated, like elsewhere in this detector. At most
/// [`MAX_INCLUDE_FILES`] included files are read per pack.
fn pack_changes(mod_dir: &Path, content: &Value) -> Vec<Value> {
    let mut walk = IncludeWalk::default();
    if let Ok(path) = mod_dir.join("content.json").canonicalize() {
        walk.visited.insert(path);
    }
    let mut collected = Vec::new();
    collect_changes(mod_dir, content, 0, &mut walk, &mut collected);
    collected
}

/// How many included files are read per pack, across all levels.
const MAX_INCLUDE_FILES: usize = 50;

#[derive(Default)]
struct IncludeWalk {
    visited: HashSet<PathBuf>,
    followed: usize,
    capped: bool,
}

fn collect_changes(
    mod_dir: &Path,
    content: &Value,
    depth: usize,
    walk: &mut IncludeWalk,
    collected: &mut Vec<Value>,
) {
    for change in changes(content) {
        if !is_action(change, "Include") {
            collected.push(change.clone());
            continue;
        }
        if depth >= MAX_INCLUDE_DEPTH {
            continue;
        }
        let Some(from_file) = change.get("FromFile").and_then(Value::as_str) else {
            continue;
        };
        for relative in from_file.split(',').map(str::trim) {
            if relative.is_empty() || relative.contains("{{") {
                continue;
            }
            let Some(file) = resolved_pack_file(mod_dir, relative) else {
                continue;
            };
            if walk.visited.contains(&file) {
                continue;
            }
            if walk.followed >= MAX_INCLUDE_FILES {
                if !walk.capped {
                    walk.capped = true;
                    log::warn!(
                        target: "app",
                        "Language pack {}: stopped after {MAX_INCLUDE_FILES} included files.",
                        mod_dir.file_name().map(|name| name.to_string_lossy()).unwrap_or_default()
                    );
                }
                continue;
            }
            walk.visited.insert(file.clone());
            walk.followed += 1;
            if let Some(included) = read_json(&file) {
                collect_changes(mod_dir, &included, depth + 1, walk, collected);
            }
        }
    }
}

fn is_action(change: &Value, action: &str) -> bool {
    change
        .get("Action")
        .and_then(Value::as_str)
        .is_some_and(|value| value.eq_ignore_ascii_case(action))
}

/// Whether a change's `Target` (a string, possibly a comma-separated list)
/// includes `target`.
fn targets(change: &Value, target: &str) -> bool {
    change
        .get("Target")
        .and_then(Value::as_str)
        .is_some_and(|field| {
            field
                .split(',')
                .any(|part| part.trim().eq_ignore_ascii_case(target))
        })
}

fn read_json(path: &Path) -> Option<Value> {
    let body = crate::input_limits::read_json_text(path).ok()?;
    scanner::parse_json_lenient(&body).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, body: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    /// Write a Content Patcher language pack registering `code`, with the given
    /// typed-asset files under `assets/Content/Strings/`.
    fn write_pack(mod_dir: &Path, name: &str, code: &str, assets: &[(&str, &str)]) {
        write(
            &mod_dir.join("manifest.json"),
            &format!(
                r#"{{ "Name": "{name}", "UniqueID": "test.{code}.{name}",
                     "ContentPackFor": {{ "UniqueID": "Pathoschild.ContentPatcher" }} }}"#
            ),
        );
        write(
            &mod_dir.join("content.json"),
            &format!(
                r#"{{
                  "Format": "2.0.0",
                  // register the language
                  "Changes": [
                    {{
                      "Action": "EditData",
                      "Target": "Data/AdditionalLanguages",
                      "Entries": {{ "{{{{ModId}}}}": {{ "LanguageCode": "{code}" }} }}
                    }},
                    {{
                      "Action": "Load",
                      "Target": "Strings/Objects, Strings/NPCNames",
                      "FromFile": "assets/Content/{{{{Target}}}}.json",
                      "When": {{ "Language": "{code}" }}
                    }}
                  ]
                }}"#
            ),
        );
        for (asset, body) in assets {
            write(
                &mod_dir
                    .join("assets")
                    .join("Content")
                    .join("Strings")
                    .join(format!("{asset}.json")),
                body,
            );
        }
    }

    #[test]
    fn external_strings_junction_is_rejected_even_after_from_file_fallback() {
        for direct in [false, true] {
            let root = crate::test_support::temp_dir("lp-external-fallback");
            let mods = root.join("Mods");
            let pack = mods.join("Pack");
            let outside = root.join("outside");
            write_pack(&pack, "Pack", "th", &[]);
            write(&outside.join("Objects.json"), r#"{"24":"Outside Term"}"#);
            let content_path = pack.join("content.json");
            let mut content: Value =
                scanner::parse_json_lenient(&std::fs::read_to_string(&content_path).unwrap())
                    .unwrap();
            if direct {
                content["Changes"][1]["FromFile"] = Value::String("Strings/Objects.json".into());
            } else {
                content["Changes"].as_array_mut().unwrap().truncate(1);
            }
            write(&content_path, &content.to_string());
            let link = pack.join("Strings");
            #[cfg(windows)]
            assert!(std::process::Command::new("powershell.exe")
                .args([
                    "-NoProfile",
                    "-Command",
                    &format!(
                        "New-Item -ItemType Junction -Path '{}' -Target '{}' | Out-Null",
                        link.display(),
                        outside.display()
                    )
                ])
                .status()
                .unwrap()
                .success());
            #[cfg(unix)]
            std::os::unix::fs::symlink(&outside, &link).unwrap();
            assert!(detect_language_pack(&mods, "th").pack.is_none());
            std::fs::remove_dir_all(root).unwrap();
        }
    }

    fn write_manifest(mod_dir: &Path, name: &str) {
        write(
            &mod_dir.join("manifest.json"),
            &format!(
                r#"{{ "Name": "{name}", "UniqueID": "test.{name}",
                     "ContentPackFor": {{ "UniqueID": "Pathoschild.ContentPatcher" }} }}"#
            ),
        );
    }

    #[test]
    fn included_files_register_the_language_and_load_strings() {
        let root = crate::test_support::temp_dir("lp-include");
        let pack = root.join("Included Pack");
        write_manifest(&pack, "Included Pack");
        write(
            &pack.join("content.json"),
            r#"{ "Changes": [
                { "Action": "Include", "FromFile": "data/language.json, {{Season}}/x.json" },
                { "Action": "Include", "FromFile": "data/strings.json" }
            ] }"#,
        );
        write(
            &pack.join("data/language.json"),
            r#"{ "Changes": [ { "Action": "EditData", "Target": "Data/AdditionalLanguages",
                 "Entries": { "x": { "LanguageCode": "vi" } } } ] }"#,
        );
        // A nested include that loads the Strings, plus a cycle back to itself.
        write(
            &pack.join("data/strings.json"),
            r#"{ "Changes": [
                { "Action": "Include", "FromFile": "data/strings-load.json" }
            ] }"#,
        );
        write(
            &pack.join("data/strings-load.json"),
            r#"{ "Changes": [
                { "Action": "Include", "FromFile": "data/strings.json, content.json" },
                { "Action": "Load", "Target": "Strings/Objects",
                  "FromFile": "i18n-assets/{{Target}}.json", "When": { "Language": "vi" } }
            ] }"#,
        );
        write(
            &pack.join("i18n-assets/Strings/Objects.json"),
            r#"{ "24": "Củ cải" }"#,
        );

        assert_eq!(registered_language_codes(&pack), vec!["vi".to_string()]);
        let found = detect_language_pack(&root, "vi")
            .pack
            .expect("pack detected");
        assert_eq!(
            found.strings_dir,
            pack.join("i18n-assets/Strings").canonicalize().unwrap()
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn includes_stay_inside_the_pack_and_stop_at_the_depth_limit() {
        let root = crate::test_support::temp_dir("lp-include-bounds");
        let register = r#"{ "Changes": [ { "Action": "EditData",
            "Target": "Data/AdditionalLanguages",
            "Entries": { "x": { "LanguageCode": "vi" } } } ] }"#;

        // An include that escapes the pack folder is ignored.
        let escaping = root.join("Escaping");
        write_manifest(&escaping, "Escaping");
        write(
            &escaping.join("content.json"),
            r#"{ "Changes": [ { "Action": "Include", "FromFile": "../outside.json" } ] }"#,
        );
        write(&root.join("outside.json"), register);
        assert!(registered_language_codes(&escaping).is_empty());

        // A chain of includes deeper than the limit is not followed.
        let deep = root.join("Deep");
        write_manifest(&deep, "Deep");
        write(
            &deep.join("content.json"),
            r#"{ "Changes": [ { "Action": "Include", "FromFile": "level1.json" } ] }"#,
        );
        for level in 1..=MAX_INCLUDE_DEPTH {
            write(
                &deep.join(format!("level{level}.json")),
                &format!(
                    r#"{{ "Changes": [ {{ "Action": "Include", "FromFile": "level{}.json" }} ] }}"#,
                    level + 1
                ),
            );
        }
        write(
            &deep.join(format!("level{}.json", MAX_INCLUDE_DEPTH + 1)),
            register,
        );
        assert!(registered_language_codes(&deep).is_empty());
        // One level less is still found.
        write(
            &deep.join(format!("level{MAX_INCLUDE_DEPTH}.json")),
            register,
        );
        assert_eq!(registered_language_codes(&deep), vec!["vi".to_string()]);

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn include_files_are_capped_per_pack() {
        let root = crate::test_support::temp_dir("lp-include-cap");
        let pack = root.join("Wide");
        write_manifest(&pack, "Wide");
        let register = r#"{ "Changes": [ { "Action": "EditData",
            "Target": "Data/AdditionalLanguages",
            "Entries": { "x": { "LanguageCode": "vi" } } } ] }"#;
        let filler: Vec<String> = (0..MAX_INCLUDE_FILES)
            .map(|index| format!("part{index}.json"))
            .collect();
        for file in &filler {
            write(&pack.join(file), r#"{ "Changes": [] }"#);
        }
        write(&pack.join("language.json"), register);
        // The registration sits after the cap; changes beside the includes
        // are still collected.
        write(
            &pack.join("content.json"),
            &format!(
                r#"{{ "Changes": [
                    {{ "Action": "Include", "FromFile": "{}, language.json" }},
                    {{ "Action": "EditData", "Target": "Data/AdditionalLanguages",
                       "Entries": {{ "y": {{ "LanguageCode": "th" }} }} }}
                ] }}"#,
                filler.join(", ")
            ),
        );
        assert_eq!(registered_language_codes(&pack), vec!["th".to_string()]);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn registered_codes_detects_language_pack() {
        let root = crate::test_support::temp_dir("lp-codes");
        let pack = root.join("Stardew Valley - THAI");
        write_pack(
            &pack,
            "Stardew Valley - THAI",
            "th",
            &[("Objects", r#"{ "24": "ห" }"#)],
        );
        assert_eq!(registered_language_codes(&pack), vec!["th".to_string()]);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn registered_codes_empty_for_non_pack_and_non_registering() {
        let root = crate::test_support::temp_dir("lp-codes-empty");
        // A plain mod (no ContentPackFor) that merely *uses* a language.
        let plain = root.join("Plain");
        write(
            &plain.join("manifest.json"),
            r#"{ "Name": "Plain", "UniqueID": "a.b" }"#,
        );
        write(
            &plain.join("content.json"),
            r#"{ "Changes": [ { "Action": "Load", "Target": "Strings/Objects",
                 "FromFile": "x.json", "When": { "Language": "th" } } ] }"#,
        );
        assert!(registered_language_codes(&plain).is_empty());

        // A CP pack that edits something else — no language registration.
        let other = root.join("Other");
        write(
            &other.join("manifest.json"),
            r#"{ "Name": "Other", "ContentPackFor": { "UniqueID": "Pathoschild.ContentPatcher" } }"#,
        );
        write(
            &other.join("content.json"),
            r#"{ "Changes": [ { "Action": "EditData", "Target": "Data/Objects", "Entries": {} } ] }"#,
        );
        assert!(registered_language_codes(&other).is_empty());

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn detects_pack_and_resolves_strings_dir() {
        let root = crate::test_support::temp_dir("lp-detect");
        let pack = root.join("Stardew Valley - THAI");
        write_pack(
            &pack,
            "Stardew Valley - THAI",
            "th",
            &[
                ("Objects", r#"{ "24": "ทับทิม" }"#),
                ("NPCNames", r#"{ "Abigail": "อบิเกล" }"#),
            ],
        );

        let detection = detect_language_pack(&root, "th");
        let found = detection.pack.expect("pack detected");
        assert_eq!(found.name, "Stardew Valley - THAI");
        assert_eq!(
            found.strings_dir,
            pack.join("assets")
                .join("Content")
                .join("Strings")
                .canonicalize()
                .unwrap()
        );
        assert_eq!(found.format, StringAssetFormat::Json);
        assert!(detection.warnings.is_empty());

        // A different language and a missing language both find nothing.
        assert!(detect_language_pack(&root, "fr").pack.is_none());
        assert!(detect_language_pack(&root, "").pack.is_none());

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn xnb_only_pack_yields_xnb_glossary_source() {
        // Registers the language and ships direct Strings/*_<lang>.xnb files.
        let root = crate::test_support::temp_dir("lp-xnb");
        let pack = root.join("XNB Pack");
        write_pack(&pack, "XNB Pack", "th", &[]);
        write(
            &pack
                .join("assets")
                .join("Content")
                .join("Strings")
                .join("Objects_th.xnb"),
            "placeholder",
        );
        let found = detect_language_pack(&root, "th").pack.unwrap();
        assert_eq!(found.name, "XNB Pack");
        assert_eq!(found.format, StringAssetFormat::Xnb);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn from_file_must_stay_inside_pack_folder() {
        let root = crate::test_support::temp_dir("lp-traversal");
        let pack = root.join("Pack");
        let outside = root.join("outside").join("Content").join("Strings");
        write(
            &pack.join("manifest.json"),
            r#"{ "Name": "Pack", "UniqueID": "test.pack",
                 "ContentPackFor": { "UniqueID": "Pathoschild.ContentPatcher" } }"#,
        );
        write(
            &pack.join("content.json"),
            r#"{
              "Changes": [
                {
                  "Action": "EditData",
                  "Target": "Data/AdditionalLanguages",
                  "Entries": { "{{ModId}}": { "LanguageCode": "th" } }
                },
                {
                  "Action": "Load",
                  "Target": "Strings/Objects",
                  "FromFile": "../outside/Content/{{Target}}.json",
                  "When": { "Language": "th" }
                }
              ]
            }"#,
        );
        write(&outside.join("Objects.json"), r#"{ "24": "Ruby" }"#);

        assert!(detect_language_pack(&root, "th").pack.is_none());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn multiple_packs_choose_deterministically_with_warning() {
        let root = crate::test_support::temp_dir("lp-multi");
        // "Aaa" has 1 typed asset; "Bbb" has 2 → Bbb wins on score despite name.
        write_pack(
            &root.join("Aaa"),
            "Aaa",
            "th",
            &[("Objects", r#"{ "24": "ก" }"#)],
        );
        write_pack(
            &root.join("Bbb"),
            "Bbb",
            "th",
            &[
                ("Objects", r#"{ "24": "ก" }"#),
                ("NPCNames", r#"{ "Abigail": "ข" }"#),
            ],
        );

        let detection = detect_language_pack(&root, "th");
        assert_eq!(detection.pack.unwrap().name, "Bbb");
        assert_eq!(detection.warnings.len(), 1);
        assert!(detection.warnings[0].contains("Bbb"));

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn when_language_accepts_string_and_array_forms() {
        let as_string: Value = serde_json::from_str(r#"{ "When": { "Language": "th" } }"#).unwrap();
        let as_array: Value =
            serde_json::from_str(r#"{ "When": { "Language": ["en", "th"] } }"#).unwrap();
        let other: Value = serde_json::from_str(r#"{ "When": { "Language": "fr" } }"#).unwrap();
        let none: Value = serde_json::from_str(r#"{ "Action": "Load" }"#).unwrap();
        assert!(when_selects_language(&as_string, "th"));
        assert!(when_selects_language(&as_array, "th"));
        assert!(!when_selects_language(&other, "th"));
        assert!(!when_selects_language(&none, "th"));
    }

    #[test]
    fn token_shape_only_accepts_direct_strings_asset() {
        assert!(token_is_strings_asset("Strings/Objects"));
        assert!(token_is_strings_asset("strings/NPCNames"));
        assert!(!token_is_strings_asset("Strings/schedules/Abigail"));
        assert!(!token_is_strings_asset("Data/Objects"));
        assert!(!token_is_strings_asset("Strings"));
    }

    /// Real-machine smoke check: detect an installed community language pack and
    /// build a glossary from it end-to-end. Opt-in via `SIT_REAL_STARDEW` (the
    /// Stardew install path); skipped otherwise, e.g. in CI. Target language code
    /// defaults to `th`, overridable with `SIT_REAL_PACK_LANG`. Reads real files
    /// read-only and asserts only counts/provenance — never any content.
    #[test]
    fn builds_glossary_from_real_pack() {
        let Ok(stardew) = std::env::var("SIT_REAL_STARDEW") else {
            eprintln!("lang_pack: SIT_REAL_STARDEW not set — skipped");
            return;
        };
        let stardew = Path::new(&stardew);
        assert!(
            stardew.is_dir(),
            "Configured Stardew test directory is missing."
        );
        let lang = std::env::var("SIT_REAL_PACK_LANG").unwrap_or_else(|_| "th".to_string());

        let detection = detect_language_pack(&stardew.join("Mods"), &lang);
        let Some(pack) = detection.pack else {
            assert!(
                std::env::var("SIT_REAL_PACK_LANG").is_err(),
                "No pack found for the explicitly configured test language."
            );
            eprintln!("lang_pack: no community pack for '{lang}' — skipped");
            return;
        };
        eprintln!(
            "lang_pack: detected \"{}\", {} typed asset(s), {} warning(s)",
            pack.name,
            typed_asset_score(&pack.strings_dir, &lang)
                .map(|(_, score)| score)
                .unwrap_or(0),
            detection.warnings.len()
        );

        let game_strings = crate::glossary::default_game_strings_path(stardew);
        match crate::glossary::build_from_pack(
            &game_strings,
            &pack.root,
            &pack.strings_dir,
            pack.format,
            &lang,
            &pack.name,
        ) {
            Ok(glossary) => {
                eprintln!(
                    "lang_pack: built {} terms from \"{}\"",
                    glossary.term_count, pack.name
                );
                assert!(glossary.term_count > 0);
                assert_eq!(
                    glossary.source,
                    crate::glossary::GlossarySource::CommunityPack
                );
                assert_eq!(glossary.target_lang, lang);
            }
            Err(error) => panic!("Detected test pack must build successfully: {error}"),
        }
    }
}
