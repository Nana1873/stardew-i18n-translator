//! Official game glossary — M1 / SPEC §5.
//!
//! The glossary is a multilingual dictionary of official Stardew terms (item /
//! NPC / location names, seasons, days, common UI strings). It powers manual
//! translation hints (and, later, AI prompt hints). It is **optional and
//! non-blocking**: if the data is unavailable, the tool works fully without it.
//!
//! Data source: a **StardewXnbHack-unpacked** `Content (unpacked)/` folder
//! (<https://github.com/Pathoschild/StardewXnbHack>). That tool deserializes
//! XNB with the game's own code (byte-perfect, all 1.6 data models), so we never
//! decode XNB ourselves. We read the unpacked `Strings/*.json` dictionaries —
//! both the English base and the target-locale variant — and pair short,
//! term-like values by key to build `{ english -> target }`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// High-signal `Strings/*` assets (resolved display names + UI terms). Files
/// that are absent in a given unpacked dump are simply skipped.
const STRING_ASSETS: &[&str] = &[
    "StringsFromCSFiles", // seasons, days, common UI, location names
    "Objects",            // item names
    "BigCraftables",      // craftable names
    "1_6_Strings",        // 1.6 additions
    "Locations",          // location names
];

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Glossary {
    pub source_lang: String,
    pub target_lang: String,
    pub term_count: usize,
    /// english term -> target term.
    pub terms: HashMap<String, String>,
}

/// Official glossary terms (english -> target) that occur as whole words in
/// `source`. A faithful port of the editor's `matchGlossary` (TS): case-
/// insensitive, terms shorter than 3 chars skipped, word boundaries required,
/// capped at 15. Used to inject term guidance into the local-LLM prompt (M6).
pub fn match_terms(source: &str, glossary: &Glossary) -> Vec<(String, String)> {
    let lower: Vec<char> = source.to_lowercase().chars().collect();
    let is_word = |c: Option<&char>| c.is_some_and(|c| c.is_alphanumeric());
    let mut out: Vec<(String, String)> = Vec::new();

    for (term, translation) in &glossary.terms {
        if term.chars().count() < 3 {
            continue;
        }
        let needle: Vec<char> = term.to_lowercase().chars().collect();
        if let Some(idx) = window_position(&lower, &needle) {
            let before = if idx == 0 { None } else { lower.get(idx - 1) };
            let after = lower.get(idx + needle.len());
            if is_word(before) || is_word(after) {
                continue;
            }
            out.push((term.clone(), translation.clone()));
            if out.len() >= 15 {
                break;
            }
        }
    }
    // Deterministic order (HashMap iteration is not) for stable prompts/tests.
    out.sort();
    out
}

/// First index in `haystack` where `needle` occurs as a contiguous slice.
fn window_position(haystack: &[char], needle: &[char]) -> Option<usize> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return None;
    }
    (0..=haystack.len() - needle.len()).find(|&i| &haystack[i..i + needle.len()] == needle)
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GlossaryInfo {
    pub target_lang: String,
    pub term_count: usize,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GlossaryStatus {
    /// Whether a StardewXnbHack-unpacked `Strings/` folder is present.
    pub unpacked_present: bool,
    /// The currently cached glossary, if any.
    pub cached: Option<GlossaryInfo>,
}

/// Map a SMAPI i18n code to the game's content locale suffix (SPEC §5).
pub fn game_locale_suffix(smapi_lang: &str) -> Option<&'static str> {
    Some(match smapi_lang {
        "de" => "de-DE",
        "es" => "es-ES",
        "fr" => "fr-FR",
        "hu" => "hu-HU",
        "it" => "it-IT",
        "ja" => "ja-JP",
        "ko" => "ko-KR",
        "pt" => "pt-BR",
        "ru" => "ru-RU",
        "tr" => "tr-TR",
        "zh" => "zh-CN",
        _ => return None,
    })
}

/// The conventional unpacked-content folder next to the game install.
pub fn default_unpacked_path(stardew_path: &Path) -> PathBuf {
    stardew_path.join("Content (unpacked)")
}

/// Whether an unpacked `Strings/` folder is present (i.e. StardewXnbHack ran).
pub fn unpacked_present(stardew_path: &Path) -> bool {
    default_unpacked_path(stardew_path).join("Strings").is_dir()
}

/// Build the glossary for `target_lang` from the unpacked content folder.
pub fn build(unpacked_content: &Path, target_lang: &str) -> Result<Glossary, String> {
    let suffix = game_locale_suffix(target_lang)
        .ok_or_else(|| format!("Unsupported target language: {target_lang}"))?;
    let strings_dir = unpacked_content.join("Strings");
    if !strings_dir.is_dir() {
        return Err(format!(
            "No unpacked Strings folder at {}. Run StardewXnbHack first.",
            unpacked_content.display()
        ));
    }

    let mut terms: HashMap<String, String> = HashMap::new();
    for asset in STRING_ASSETS {
        let base = read_string_map(&strings_dir.join(format!("{asset}.json")));
        let localized = read_string_map(&strings_dir.join(format!("{asset}.{suffix}.json")));
        if let (Some(base), Some(localized)) = (base, localized) {
            for (key, english) in &base {
                let Some(target) = localized.get(key) else {
                    continue;
                };
                if let Some((en, tgt)) = glossary_term(english, target) {
                    terms.insert(en, tgt);
                }
            }
        }
    }

    Ok(Glossary {
        source_lang: "default".to_string(),
        target_lang: target_lang.to_string(),
        term_count: terms.len(),
        terms,
    })
}

/// Accept a pair only if it is a short, term-like named entity (not prose,
/// not a token). Returns the trimmed (english, target) to store.
fn glossary_term(english: &str, target: &str) -> Option<(String, String)> {
    let en = english.trim();
    let tgt = target.trim();
    if en.is_empty() || tgt.is_empty() || en.eq_ignore_ascii_case(tgt) {
        return None;
    }
    if en.chars().count() > 30 || en.split_whitespace().count() > 4 {
        return None; // exclude descriptions / dialogue prose
    }
    // Exclude tokens, multi-line, and sentence-like values.
    if en.contains(['{', '}', '[', ']', '\n', '\r'])
        || en.ends_with(['.', '!', '?', ':'])
        || tgt.contains(['\n', '\r'])
    {
        return None;
    }
    Some((en.to_string(), tgt.to_string()))
}

fn read_string_map(path: &Path) -> Option<HashMap<String, String>> {
    let body = std::fs::read_to_string(path).ok()?;
    let value: Value = serde_json::from_str(&body).ok()?;
    let object = value.as_object()?;
    let mut map = HashMap::with_capacity(object.len());
    for (key, value) in object {
        if let Some(text) = value.as_str() {
            map.insert(key.clone(), text.to_string());
        }
    }
    Some(map)
}

fn glossary_path(config_dir: &Path) -> PathBuf {
    config_dir.join("glossary.json")
}

pub fn save(config_dir: &Path, glossary: &Glossary) -> Result<(), String> {
    std::fs::create_dir_all(config_dir).map_err(|e| format!("Could not create config dir: {e}"))?;
    let body = serde_json::to_string(glossary).map_err(|e| format!("serialize glossary: {e}"))?;
    std::fs::write(glossary_path(config_dir), body).map_err(|e| format!("write glossary: {e}"))
}

pub fn load(config_dir: &Path) -> Option<Glossary> {
    let body = std::fs::read_to_string(glossary_path(config_dir)).ok()?;
    serde_json::from_str(&body).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, body: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    #[test]
    fn locale_mapping() {
        assert_eq!(game_locale_suffix("de"), Some("de-DE"));
        assert_eq!(game_locale_suffix("pt"), Some("pt-BR"));
        assert_eq!(game_locale_suffix("xx"), None);
    }

    #[test]
    fn match_terms_finds_whole_words_only() {
        let mut terms = HashMap::new();
        terms.insert("Parsnip".to_string(), "Pastinake".to_string());
        terms.insert("Pufferfish".to_string(), "Kugelfisch".to_string());
        terms.insert("ox".to_string(), "Ochse".to_string()); // < 3 chars: skipped
        let glossary = Glossary {
            terms,
            ..Default::default()
        };

        // "Parsnip" matches (case-insensitive, whole word); "Pufferfish" absent.
        let hits = match_terms("I planted a parsnip today.", &glossary);
        assert_eq!(hits, vec![("Parsnip".to_string(), "Pastinake".to_string())]);

        // Substring inside another word must not match.
        assert!(match_terms("parsnips everywhere", &glossary).is_empty());
        // Too-short term is never matched even as a whole word.
        assert!(match_terms("an ox cart", &glossary).is_empty());
    }

    #[test]
    fn pairs_term_like_values_and_excludes_prose_and_tokens() {
        let root = crate::test_support::temp_dir("glossary-build");
        let strings = root.join("Content (unpacked)").join("Strings");
        write(
            &strings.join("StringsFromCSFiles.json"),
            r#"{ "Season_Spring": "Spring", "Greeting": "Hello there", "Desc": "A long sentence describing things.", "Same": "Junimo" }"#,
        );
        write(
            &strings.join("StringsFromCSFiles.de-DE.json"),
            r#"{ "Season_Spring": "Frühling", "Greeting": "Hallo zusammen", "Desc": "Ein langer beschreibender Satz.", "Same": "Junimo" }"#,
        );

        let glossary = build(&root.join("Content (unpacked)"), "de").unwrap();
        // Term-like pair kept.
        assert_eq!(glossary.terms.get("Spring"), Some(&"Frühling".to_string()));
        // "Hello there" -> "Hallo zusammen" is short enough (2 words) -> kept.
        assert_eq!(
            glossary.terms.get("Hello there"),
            Some(&"Hallo zusammen".to_string())
        );
        // Prose (ends with '.') excluded.
        assert!(!glossary
            .terms
            .contains_key("A long sentence describing things."));
        // Identical value (no translation) excluded.
        assert!(!glossary.terms.values().any(|v| v == "Junimo"));
        assert_eq!(glossary.target_lang, "de");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn missing_unpacked_folder_errors_cleanly() {
        let root = crate::test_support::temp_dir("glossary-missing");
        let err = build(&root.join("Content (unpacked)"), "de").unwrap_err();
        assert!(err.contains("StardewXnbHack"));
    }

    #[test]
    fn save_then_load_roundtrips() {
        let dir = crate::test_support::temp_dir("glossary-cache");
        let mut terms = HashMap::new();
        terms.insert("Spring".to_string(), "Frühling".to_string());
        let glossary = Glossary {
            source_lang: "default".into(),
            target_lang: "de".into(),
            term_count: 1,
            terms,
        };
        save(&dir, &glossary).unwrap();
        assert_eq!(load(&dir), Some(glossary));
        std::fs::remove_dir_all(&dir).ok();
    }
}
