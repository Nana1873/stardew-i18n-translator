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
/// `source`. A faithful port of the editor's `matchGlossary` (TS): **case-
/// sensitive**, terms shorter than 3 chars skipped, word boundaries required,
/// capped at 15. Used to inject term guidance into the local-LLM prompt (M6).
///
/// Matching is case-sensitive on purpose: named entities are capitalized
/// (`Parsnip`, `Abigail`), so a capitalized UI term like `Play` (-> `Spielen`)
/// must not fire on the common lowercase verb in prose ("my best play ever").
/// The glossary is a soft hint, so a missed lowercase mention is cheap while a
/// wrong hint poisons the prompt — precision is worth more than recall here.
pub fn match_terms(source: &str, glossary: &Glossary) -> Vec<(String, String)> {
    let haystack: Vec<char> = source.chars().collect();
    let is_word = |c: Option<&char>| c.is_some_and(|c| c.is_alphanumeric());
    let mut out: Vec<(String, String)> = Vec::new();

    for (term, translation) in &glossary.terms {
        if term.chars().count() < 3 {
            continue;
        }
        let needle: Vec<char> = term.chars().collect();
        if let Some(idx) = window_position(&haystack, &needle) {
            let before = if idx == 0 {
                None
            } else {
                haystack.get(idx - 1)
            };
            let after = haystack.get(idx + needle.len());
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
    // The glossary is strictly named entities and identifiers (SPEC §5), not
    // dialogue or UI vocabulary. Two cheap signals keep generic words out:
    //  - a named entity is capitalized (`Parsnip`, `Abigail`, `Pelican Town`),
    //    so a lowercase value ("and", "with", "good", "the farm") is prose and
    //    must never become a forced "official term".
    //  - common UI/menu commands ("Play", "Quit", "Yes", "Back") are capitalized
    //    and slip past the case test, so a small stoplist drops them. Forcing
    //    these rigidifies ordinary translation (e.g. "Right" -> "Rechts" when it
    //    means "correct").
    if !en.chars().next().is_some_and(char::is_uppercase) {
        return None;
    }
    if is_common_ui_word(en) {
        return None;
    }
    if en.chars().count() > 30 || en.split_whitespace().count() > 4 {
        return None; // exclude descriptions / dialogue prose
    }
    // A clean term maps roughly 1:1; German compounds rather than expands, so a
    // target with several more words than the source is a mis-paired dialogue
    // fragment (e.g. "head" -> "meinen schmerzenden Kopf", "back" -> "meinen
    // wunden Rücken"), not a named entity. Allow a single extra word for the
    // occasional legitimate expansion.
    if tgt.split_whitespace().count() > en.split_whitespace().count() + 1 {
        return None;
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

/// Common UI / menu / command words that leak in from the game's UI string
/// assets but are not game-content terms. Compared case-insensitively, so both
/// `Play` and a stray `play` are excluded. Kept deliberately small and stable
/// (these menu words do not proliferate); item/NPC/location names never collide
/// with it.
fn is_common_ui_word(term: &str) -> bool {
    const STOPWORDS: &[&str] = &[
        "yes", "no", "ok", "okay", "cancel", "back", "next", "previous", "play", "pause", "quit",
        "exit", "menu", "options", "settings", "save", "load", "continue", "help", "done", "close",
        "open", "skip", "start", "stop", "new", "delete", "remove", "add", "edit", "on", "off",
        "book", "right", "left", "up", "down", "and", "or", "with", "good", "bad", "ran", "run",
    ];
    STOPWORDS.iter().any(|word| term.eq_ignore_ascii_case(word))
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

        // "Parsnip" matches (case-sensitive, whole word); "Pufferfish" absent.
        let hits = match_terms("I planted a Parsnip today.", &glossary);
        assert_eq!(hits, vec![("Parsnip".to_string(), "Pastinake".to_string())]);

        // Substring inside another word must not match.
        assert!(match_terms("Parsnips everywhere", &glossary).is_empty());
        // Too-short term is never matched even as a whole word.
        assert!(match_terms("an ox cart", &glossary).is_empty());
    }

    #[test]
    fn match_terms_is_case_sensitive_to_avoid_ui_false_friends() {
        // A capitalized UI button term (`Play` -> `Spielen`) must not fire on
        // the common lowercase verb in dialogue prose ("my best play ever").
        let mut terms = HashMap::new();
        terms.insert("Play".to_string(), "Spielen".to_string());
        let glossary = Glossary {
            terms,
            ..Default::default()
        };
        assert!(match_terms("Marrying you was my best play ever.", &glossary).is_empty());
        // The genuine UI element (capitalized) still matches.
        assert_eq!(
            match_terms("Press Play to start.", &glossary),
            vec![("Play".to_string(), "Spielen".to_string())]
        );
    }

    #[test]
    fn glossary_build_rejects_non_named_entities() {
        // Lowercase function words / common verbs leaking from UI string assets
        // are prose, not named entities — rejected by the capitalization rule.
        assert_eq!(glossary_term("and", "und"), None);
        assert_eq!(glossary_term("with", "mit"), None);
        assert_eq!(glossary_term("good", "gut"), None);
        assert_eq!(glossary_term("the farm", "der Hof"), None);
        assert_eq!(glossary_term("away from", "weg von"), None);
        // Capitalized UI/menu commands slip past the case test -> stoplist drops.
        assert_eq!(glossary_term("Play", "Spielen"), None);
        assert_eq!(glossary_term("Quit", "Verlassen"), None);
        assert_eq!(glossary_term("Yes", "Ja"), None);
        assert_eq!(glossary_term("Right", "Rechts"), None);
        // Genuine named entities are kept.
        assert_eq!(
            glossary_term("Parsnip", "Pastinake"),
            Some(("Parsnip".to_string(), "Pastinake".to_string()))
        );
        assert_eq!(
            glossary_term("Pelican Town", "Pelikanstadt"),
            Some(("Pelican Town".to_string(), "Pelikanstadt".to_string()))
        );
        assert_eq!(
            glossary_term("Spring", "Frühling"),
            Some(("Spring".to_string(), "Frühling".to_string()))
        );
    }

    #[test]
    fn glossary_build_rejects_mispaired_dialogue_fragments() {
        // A one-word (capitalized) value paired with a longer localized dialogue
        // fragment is a mis-pairing, not a named entity — caught by the word-ratio
        // rule (the capitalized source clears the named-entity check first).
        assert_eq!(glossary_term("Head", "mein ganzer schmerzender Kopf"), None);
        assert_eq!(glossary_term("Garden", "mein schöner kleiner Garten"), None);
        // A clean term (1:1) and a modest expansion (+1 word) are still kept.
        assert_eq!(
            glossary_term("Parsnip", "Pastinake"),
            Some(("Parsnip".to_string(), "Pastinake".to_string()))
        );
        assert_eq!(
            glossary_term("Mayor", "Der Bürgermeister"),
            Some(("Mayor".to_string(), "Der Bürgermeister".to_string()))
        );
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
