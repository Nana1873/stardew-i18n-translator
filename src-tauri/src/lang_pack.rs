//! Community language-pack detection — Issue #163.
//!
//! A Stardew "language pack" is a Content Patcher content pack that registers an
//! additional in-game language (`Data/AdditionalLanguages` → `LanguageCode`) and
//! ships translated `Strings/*` for it. For a game-unsupported target language we
//! can build a typed glossary from such a pack (English base from unpacked
//! content + the pack's translated `Strings`). This module only *locates* a
//! usable pack; [`crate::glossary::build_from_pack`] does the extraction.
//!
//! Read-only and narrowly bounded per `SCOPE_GUARDRAILS.md`: a pack's
//! `manifest.json` + `content.json` are parsed only to detect the language
//! registration and locate its `Strings/` folder; the game's own `Data/*` is
//! never read here. We do **not** implement Content Patcher — `When` matching is
//! deliberately tolerant (a `Language` string or string array), and anything more
//! complex falls back to a bounded folder probe.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::scanner;

const CONTENT_PATCHER_ID: &str = "Pathoschild.ContentPatcher";

/// A detected community language pack usable as a glossary source.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LanguagePack {
    /// Display name (manifest `Name`, falling back to the folder name).
    pub name: String,
    /// The pack's `Strings/` folder holding `<asset>.json` files.
    pub strings_dir: PathBuf,
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
        Some(content) => language_codes(&content),
        None => Vec::new(),
    }
}

/// Find the best installed community language pack that supplies `target_lang`,
/// scanning `mods_dir`. When several packs register the language the choice is
/// deterministic — most resolvable typed-asset files wins, ties broken by name
/// then path — and a warning records which was used. Returns no pack (and no
/// warning) when none match or the only matches are unreadable (XNB-only).
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
        if !language_codes(&content)
            .iter()
            .any(|code| code.eq_ignore_ascii_case(target))
        {
            continue;
        }
        let Some(strings_dir) = resolve_strings_dir(mod_dir, &content, target) else {
            continue;
        };
        if !seen_dirs.insert(strings_dir.clone()) {
            continue;
        }
        let score = typed_asset_score(&strings_dir);
        if score == 0 {
            continue; // nothing extractable (e.g. XNB-only Strings)
        }
        candidates.push((
            LanguagePack {
                name: pack_name(mod_dir),
                strings_dir,
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
fn language_codes(content: &Value) -> Vec<String> {
    let mut codes = Vec::new();
    for change in changes(content) {
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
fn resolve_strings_dir(mod_dir: &Path, content: &Value, target: &str) -> Option<PathBuf> {
    for change in changes(content) {
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
            let file = mod_dir.join(resolved.replace('\\', "/"));
            if file.is_file() {
                if let Some(parent) = file.parent() {
                    return Some(parent.to_path_buf());
                }
            }
        }
    }
    probe_strings_dir(mod_dir)
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
fn probe_strings_dir(mod_dir: &Path) -> Option<PathBuf> {
    for relative in [
        "assets/Content/Strings",
        "assets/Strings",
        "Content/Strings",
        "Strings",
    ] {
        let dir = mod_dir.join(relative);
        if typed_asset_score(&dir) > 0 {
            return Some(dir);
        }
    }
    find_strings_dir(mod_dir, 0)
}

/// Depth-limited search for a directory named `Strings` containing a typed asset.
fn find_strings_dir(dir: &Path, depth: usize) -> Option<PathBuf> {
    if depth > 6 {
        return None;
    }
    let mut subdirs = Vec::new();
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let is_strings = path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case("Strings"));
        if is_strings && typed_asset_score(&path) > 0 {
            return Some(path);
        }
        subdirs.push(path);
    }
    for sub in subdirs {
        if let Some(found) = find_strings_dir(&sub, depth + 1) {
            return Some(found);
        }
    }
    None
}

/// How many typed-glossary assets (`Objects.json`, `NPCNames.json`, …) the folder
/// holds. The detector's selection score; 0 means nothing extractable.
fn typed_asset_score(strings_dir: &Path) -> usize {
    if !strings_dir.is_dir() {
        return 0;
    }
    crate::glossary::typed_asset_names()
        .iter()
        .filter(|asset| strings_dir.join(format!("{asset}.json")).is_file())
        .count()
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
    let body = std::fs::read_to_string(path).ok()?;
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
            pack.join("assets").join("Content").join("Strings")
        );
        assert!(detection.warnings.is_empty());

        // A different language and a missing language both find nothing.
        assert!(detect_language_pack(&root, "fr").pack.is_none());
        assert!(detect_language_pack(&root, "").pack.is_none());

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn xnb_only_pack_yields_no_glossary_source() {
        // Registers the language but ships no readable Strings/*.json (XNB-only).
        let root = crate::test_support::temp_dir("lp-xnb");
        let pack = root.join("XNB Pack");
        write_pack(&pack, "XNB Pack", "th", &[]);
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
        let lang = std::env::var("SIT_REAL_PACK_LANG").unwrap_or_else(|_| "th".to_string());

        let detection = detect_language_pack(&stardew.join("Mods"), &lang);
        let Some(pack) = detection.pack else {
            eprintln!("lang_pack: no community pack for '{lang}' — skipped");
            return;
        };
        eprintln!(
            "lang_pack: detected \"{}\", {} typed asset(s), {} warning(s)",
            pack.name,
            typed_asset_score(&pack.strings_dir),
            detection.warnings.len()
        );

        let unpacked = crate::glossary::default_unpacked_path(stardew);
        match crate::glossary::build_from_pack(&unpacked, &pack.strings_dir, &lang, &pack.name) {
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
            Err(error) => eprintln!("lang_pack: build skipped ({error})"),
        }
    }
}
