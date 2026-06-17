//! Official game glossary — M1 / SPEC §5.
//!
//! The glossary is a **typed, high-confidence** dictionary of official Stardew
//! terms — item / craftable / weapon / tool / clothing / NPC / location names
//! and seasons. Each entry carries its `kind` (category) plus the source asset
//! and key it came from. It powers manual translation hints (and the local-AI
//! prompt). It is **optional and non-blocking**: if the data is unavailable, the
//! tool works fully without it.
//!
//! Precision beats recall: a wrong match poisons editor hints and the local-AI
//! prompt, so we only keep short official names — never prose, dialogue, or UI
//! vocabulary. Entries are extracted from a curated set of content `Strings/*`
//! assets, each restricted to the keys that hold display names and screened by a
//! strict term-like quality gate.
//!
//! Data source: a **StardewXnbHack-unpacked** `Content (unpacked)/` folder
//! (<https://github.com/Pathoschild/StardewXnbHack>). That tool deserializes
//! XNB with the game's own code (byte-perfect, all 1.6 data models), so we never
//! decode XNB ourselves. We read the unpacked `Strings/*.json` dictionaries —
//! both the English base and the target-locale variant — and pair short,
//! term-like values by key.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// On-disk cache schema version. Bumped from the untyped v1 (`{ terms: {…} }`)
/// to the typed v2 (`{ entries: [...] }`); `load` ignores any other version.
pub const GLOSSARY_FORMAT: u32 = 2;

/// Category of an official term. Encodes confidence (each kind is restricted to
/// a content asset and key rule) and drives the editor's category chip.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TermKind {
    Item,
    BigCraftable,
    Weapon,
    Tool,
    Clothing,
    Npc,
    Location,
    Season,
}

/// One official term: `source` (English) → `target`, tagged with its category
/// and the `asset`/`key` it was extracted from (provenance for debugging/#158).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GlossaryEntry {
    pub source: String,
    pub target: String,
    pub kind: TermKind,
    pub asset: String,
    pub key: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Glossary {
    /// Cache schema version (`GLOSSARY_FORMAT`).
    pub format: u32,
    pub source_lang: String,
    pub target_lang: String,
    pub term_count: usize,
    /// Typed official terms.
    pub entries: Vec<GlossaryEntry>,
}

/// How an asset's keys map to glossary entries. Most `Strings/*` files mix
/// display names with descriptions/format strings under separate keys, so each
/// asset restricts which keys are eligible before the quality gate runs.
#[derive(Clone, Copy)]
enum KeyRule {
    /// Every key is eligible (values still pass the quality gate).
    Bare,
    /// Only keys ending `_Name` (skips the parallel `_Description` keys).
    NameOnly,
    /// Only the four season keys in `StringsFromCSFiles`.
    Seasons,
}

struct AssetSpec {
    asset: &'static str,
    kind: TermKind,
    rule: KeyRule,
}

/// Typed content assets, in priority order — when the same English name appears
/// in several assets, the first one wins (item names beat stray collisions).
/// Assets absent from a given unpacked dump are simply skipped. The old generic
/// `1_6_Strings` scan is intentionally dropped (mixed UI/content, low precision).
const TYPED_ASSETS: &[AssetSpec] = &[
    AssetSpec {
        asset: "Objects",
        kind: TermKind::Item,
        rule: KeyRule::Bare,
    },
    AssetSpec {
        asset: "BigCraftables",
        kind: TermKind::BigCraftable,
        rule: KeyRule::Bare,
    },
    AssetSpec {
        asset: "Weapons",
        kind: TermKind::Weapon,
        rule: KeyRule::NameOnly,
    },
    AssetSpec {
        asset: "Tools",
        kind: TermKind::Tool,
        rule: KeyRule::NameOnly,
    },
    AssetSpec {
        asset: "Pants",
        kind: TermKind::Clothing,
        rule: KeyRule::NameOnly,
    },
    AssetSpec {
        asset: "Shirts",
        kind: TermKind::Clothing,
        rule: KeyRule::NameOnly,
    },
    AssetSpec {
        asset: "NPCNames",
        kind: TermKind::Npc,
        rule: KeyRule::Bare,
    },
    AssetSpec {
        asset: "Locations",
        kind: TermKind::Location,
        rule: KeyRule::Bare,
    },
    AssetSpec {
        asset: "StringsFromCSFiles",
        kind: TermKind::Season,
        rule: KeyRule::Seasons,
    },
];

/// Official glossary entries whose `source` occurs as a whole word in `source`.
/// **Case-sensitive** (named entities are capitalized, so a UI term like `Play`
/// must not fire on the lowercase verb in prose); terms shorter than 3 chars are
/// skipped; capped at 15.
///
/// Longer, more specific terms are matched first and claim their character span,
/// so `Iridium Ore` wins over a bare `Ore` overlapping the same text. The
/// returned entries carry their `kind` for the editor's category chip.
pub fn match_entries<'a>(source: &str, glossary: &'a Glossary) -> Vec<&'a GlossaryEntry> {
    let haystack: Vec<char> = source.chars().collect();

    // Longest source first so specific terms claim their span before a shorter
    // overlapping term can; tie-break on source for deterministic output.
    let mut sorted: Vec<&GlossaryEntry> = glossary.entries.iter().collect();
    sorted.sort_by(|a, b| {
        b.source
            .chars()
            .count()
            .cmp(&a.source.chars().count())
            .then_with(|| a.source.cmp(&b.source))
    });

    let mut occupied: Vec<(usize, usize)> = Vec::new();
    let mut out: Vec<&GlossaryEntry> = Vec::new();
    for entry in sorted {
        if entry.source.chars().count() < 3 {
            continue;
        }
        let needle: Vec<char> = entry.source.chars().collect();
        let Some((start, end)) = whole_word_range(&haystack, &needle) else {
            continue;
        };
        // Skip a term that overlaps a span already claimed by a longer one.
        if occupied.iter().any(|&(s, e)| start < e && s < end) {
            continue;
        }
        occupied.push((start, end));
        out.push(entry);
        if out.len() >= 15 {
            break;
        }
    }
    out
}

/// Official glossary terms (english -> target) that occur as whole words in
/// `source`. Thin wrapper over [`match_entries`] for the LLM-prompt / batch
/// consumers that only need the name pairs. Output is sorted for stable prompts.
pub fn match_terms(source: &str, glossary: &Glossary) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = match_entries(source, glossary)
        .into_iter()
        .map(|entry| (entry.source.clone(), entry.target.clone()))
        .collect();
    out.sort();
    out
}

/// The `[start, end)` char span where `needle` occurs as a whole word in
/// `haystack`, or `None` if it does not occur on a word boundary.
fn whole_word_range(haystack: &[char], needle: &[char]) -> Option<(usize, usize)> {
    let idx = window_position(haystack, needle)?;
    let is_word = |c: Option<&char>| c.is_some_and(|c| c.is_alphanumeric());
    let before = if idx == 0 {
        None
    } else {
        haystack.get(idx - 1)
    };
    let after = haystack.get(idx + needle.len());
    if is_word(before) || is_word(after) {
        return None;
    }
    Some((idx, idx + needle.len()))
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
    /// The currently cached glossary, if a valid typed one exists.
    pub cached: Option<GlossaryInfo>,
    /// A `glossary.json` exists but is old/invalid (untyped v1 or unparseable),
    /// so the UI should recommend a rebuild.
    pub outdated_cache: bool,
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

    let mut entries: Vec<GlossaryEntry> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for spec in TYPED_ASSETS {
        let base = read_string_map(&strings_dir.join(format!("{}.json", spec.asset)));
        let localized = read_string_map(&strings_dir.join(format!("{}.{suffix}.json", spec.asset)));
        let (Some(base), Some(localized)) = (base, localized) else {
            continue;
        };
        // Sort keys so extraction order (and thus dedupe within an asset) is
        // deterministic — `read_string_map`'s HashMap iteration order is not.
        let mut keys: Vec<&String> = base.keys().collect();
        keys.sort();
        for key in keys {
            if !key_allowed(spec.rule, key) {
                continue;
            }
            let Some(target) = localized.get(key) else {
                continue;
            };
            // Season tokens are stored lowercase (`spring`), but appear
            // capitalized in mod text (`Spring`); normalize so the term-like gate
            // accepts them and case-sensitive matching can fire.
            let english = if matches!(spec.rule, KeyRule::Seasons) {
                capitalize_first(&base[key])
            } else {
                base[key].clone()
            };
            let Some((source, target)) = glossary_term(&english, target) else {
                continue;
            };
            // First typed asset to define a name wins (assets are in priority
            // order), so an item name beats a stray collision elsewhere.
            if !seen.insert(source.clone()) {
                continue;
            }
            entries.push(GlossaryEntry {
                source,
                target,
                kind: spec.kind,
                asset: spec.asset.to_string(),
                key: key.clone(),
            });
        }
    }

    Ok(Glossary {
        format: GLOSSARY_FORMAT,
        source_lang: "default".to_string(),
        target_lang: target_lang.to_string(),
        term_count: entries.len(),
        entries,
    })
}

/// Uppercase the first character of `s` (leaving the rest unchanged). Used to
/// normalize lowercase season tokens (`spring`) into the capitalized form
/// (`Spring`) that appears in mod source text.
fn capitalize_first(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// Whether `key` is eligible under the asset's [`KeyRule`].
fn key_allowed(rule: KeyRule, key: &str) -> bool {
    match rule {
        KeyRule::Bare => true,
        KeyRule::NameOnly => key.ends_with("_Name"),
        KeyRule::Seasons => matches!(
            key.to_ascii_lowercase().as_str(),
            "spring" | "summer" | "fall" | "winter"
        ),
    }
}

/// Accept a pair only if it is a short, term-like official name (not prose, not
/// a token, not a UI command). Returns the trimmed (english, target) to store.
fn glossary_term(english: &str, target: &str) -> Option<(String, String)> {
    let en = english.trim();
    let tgt = target.trim();
    if en.is_empty() || tgt.is_empty() || en.eq_ignore_ascii_case(tgt) {
        return None;
    }
    // The glossary is strictly official names (SPEC §5), not dialogue or UI
    // vocabulary. Official names are Title Case proper nouns (`Parsnip`,
    // `Pelican Town`, `Iridium Ore`), so a value with a lowercase word — whether
    // a leading function word (`the farm`, `away from`) or an interior one
    // (`Hello there`) — is prose and must never become a forced "official term".
    if en
        .split_whitespace()
        .any(|word| word.chars().next().is_some_and(char::is_lowercase))
    {
        return None;
    }
    // Common UI/menu commands (`Play`, `Quit`, `Yes`, `Back`) are capitalized and
    // slip past the case test, so a small stoplist drops them. Forcing these
    // rigidifies ordinary translation (e.g. `Right` -> `Rechts` when it means
    // "correct").
    if is_common_ui_word(en) {
        return None;
    }
    if en.chars().count() > 30 || en.split_whitespace().count() > 4 {
        return None; // exclude descriptions / dialogue prose
    }
    // A clean name maps roughly 1:1; German compounds rather than expands, so a
    // target with several more words than the source is a mis-paired dialogue
    // fragment (e.g. `head` -> `meinen schmerzenden Kopf`), not a named entity.
    // Allow a single extra word for the occasional legitimate expansion.
    if tgt.split_whitespace().count() > en.split_whitespace().count() + 1 {
        return None;
    }
    // Exclude tokens, multi-line / tab-laden format strings, and sentence-like
    // values on either side.
    if en.contains(['{', '}', '[', ']', '\n', '\r', '\t'])
        || tgt.contains(['\n', '\r', '\t'])
        || en.ends_with(['.', '!', '?', ':'])
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

/// Whether a `glossary.json` file exists on disk (regardless of validity).
pub fn cache_present(config_dir: &Path) -> bool {
    glossary_path(config_dir).is_file()
}

pub fn save(config_dir: &Path, glossary: &Glossary) -> Result<(), String> {
    std::fs::create_dir_all(config_dir).map_err(|e| format!("Could not create config dir: {e}"))?;
    let body = serde_json::to_string(glossary).map_err(|e| format!("serialize glossary: {e}"))?;
    std::fs::write(glossary_path(config_dir), body).map_err(|e| format!("write glossary: {e}"))
}

/// Load the cached glossary, or `None` when the file is missing, unparseable, or
/// an old/incompatible format (untyped v1 cache). Never crashes.
pub fn load(config_dir: &Path) -> Option<Glossary> {
    let body = std::fs::read_to_string(glossary_path(config_dir)).ok()?;
    let glossary: Glossary = serde_json::from_str(&body).ok()?;
    if glossary.format != GLOSSARY_FORMAT {
        return None;
    }
    Some(glossary)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, body: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    fn entry(source: &str, target: &str, kind: TermKind) -> GlossaryEntry {
        GlossaryEntry {
            source: source.to_string(),
            target: target.to_string(),
            kind,
            asset: "test".to_string(),
            key: source.to_string(),
        }
    }

    fn glossary_of(entries: Vec<GlossaryEntry>) -> Glossary {
        Glossary {
            format: GLOSSARY_FORMAT,
            term_count: entries.len(),
            entries,
            ..Default::default()
        }
    }

    #[test]
    fn locale_mapping() {
        assert_eq!(game_locale_suffix("de"), Some("de-DE"));
        assert_eq!(game_locale_suffix("pt"), Some("pt-BR"));
        assert_eq!(game_locale_suffix("xx"), None);
    }

    #[test]
    fn match_terms_finds_whole_words_only() {
        let glossary = glossary_of(vec![
            entry("Parsnip", "Pastinake", TermKind::Item),
            entry("Pufferfish", "Kugelfisch", TermKind::Item),
            entry("ox", "Ochse", TermKind::Item), // < 3 chars: skipped
        ]);

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
        let glossary = glossary_of(vec![entry("Play", "Spielen", TermKind::Item)]);
        assert!(match_terms("Marrying you was my best play ever.", &glossary).is_empty());
        // The genuine UI element (capitalized) still matches.
        assert_eq!(
            match_terms("Press Play to start.", &glossary),
            vec![("Play".to_string(), "Spielen".to_string())]
        );
    }

    #[test]
    fn match_prefers_longer_more_specific_terms() {
        // "Iridium Ore" must win over a bare "Ore" overlapping the same text.
        let glossary = glossary_of(vec![
            entry("Ore", "Erz", TermKind::Item),
            entry("Iridium Ore", "Iridiumerz", TermKind::Item),
        ]);
        let hits = match_terms("I refined some Iridium Ore today.", &glossary);
        assert_eq!(
            hits,
            vec![("Iridium Ore".to_string(), "Iridiumerz".to_string())]
        );

        // A standalone "Ore" elsewhere still matches when nothing longer covers it.
        let hits = match_terms("Just plain Ore here.", &glossary);
        assert_eq!(hits, vec![("Ore".to_string(), "Erz".to_string())]);
    }

    #[test]
    fn match_entries_carries_kind() {
        let glossary = glossary_of(vec![
            entry("Pelican Town", "Pelikanstadt", TermKind::Location),
            entry("Spring", "Frühling", TermKind::Season),
        ]);
        let hits = match_entries("Welcome to Pelican Town in Spring.", &glossary);
        let kinds: Vec<TermKind> = hits.iter().map(|e| e.kind).collect();
        assert!(kinds.contains(&TermKind::Location));
        assert!(kinds.contains(&TermKind::Season));
    }

    #[test]
    fn quality_gate_keeps_official_names() {
        // Genuine named entities (items, locations, seasons, an NPC, a +1-word
        // expansion) are kept.
        assert_eq!(
            glossary_term("Parsnip", "Pastinake"),
            Some(("Parsnip".to_string(), "Pastinake".to_string()))
        );
        assert_eq!(
            glossary_term("Iridium Ore", "Iridiumerz"),
            Some(("Iridium Ore".to_string(), "Iridiumerz".to_string()))
        );
        assert_eq!(
            glossary_term("Pelican Town", "Pelikanstadt"),
            Some(("Pelican Town".to_string(), "Pelikanstadt".to_string()))
        );
        assert_eq!(
            glossary_term("Spring", "Frühling"),
            Some(("Spring".to_string(), "Frühling".to_string()))
        );
        assert_eq!(
            glossary_term("Abigail", "Abigail-DE"),
            Some(("Abigail".to_string(), "Abigail-DE".to_string()))
        );
        assert_eq!(
            glossary_term("Mayor", "Der Bürgermeister"),
            Some(("Mayor".to_string(), "Der Bürgermeister".to_string()))
        );
    }

    #[test]
    fn quality_gate_rejects_prose_and_ui_and_tokens() {
        // Prose / dialogue fragments (a lowercase interior word betrays them).
        assert_eq!(glossary_term("Hello there", "Hallo zusammen"), None);
        assert_eq!(glossary_term("the farm", "der Hof"), None);
        assert_eq!(glossary_term("away from", "weg von"), None);
        assert_eq!(glossary_term("good", "gut"), None);
        // A full sentence / description (ends with punctuation).
        assert_eq!(
            glossary_term("A long sentence describing things.", "Ein langer Satz."),
            None
        );
        // Capitalized UI/menu commands -> stoplist.
        assert_eq!(glossary_term("Play", "Spielen"), None);
        assert_eq!(glossary_term("Right", "Rechts"), None);
        assert_eq!(glossary_term("Back", "Zurück"), None);
        assert_eq!(glossary_term("Good", "Gut"), None);
        // Mis-paired dialogue fragment (target far longer than the source).
        assert_eq!(glossary_term("Head", "mein ganzer schmerzender Kopf"), None);
        // Format strings / tokens / multi-line.
        assert_eq!(glossary_term("Day {0}", "Tag {0}"), None);
        assert_eq!(glossary_term("Line\tbreak", "Zeile\tumbruch"), None);
        // Identical value (no translation).
        assert_eq!(glossary_term("Junimo", "Junimo"), None);
    }

    #[test]
    fn builds_typed_entries_from_assets_and_excludes_prose() {
        let root = crate::test_support::temp_dir("glossary-build");
        let strings = root.join("Content (unpacked)").join("Strings");

        // Objects: an item name (kept) + a description value (rejected: ends `.`).
        write(
            &strings.join("Objects.json"),
            r#"{ "24": "Parsnip", "24_desc": "A spring tuber closely related to the carrot." }"#,
        );
        write(
            &strings.join("Objects.de-DE.json"),
            r#"{ "24": "Pastinake", "24_desc": "Eine Frühlingsknolle, eng verwandt mit der Karotte." }"#,
        );
        // Weapons: only `_Name` keys are eligible; `_Description` is skipped.
        write(
            &strings.join("Weapons.json"),
            r#"{ "4_Name": "Galaxy Sword", "4_Description": "A legendary blade of unknown origin." }"#,
        );
        write(
            &strings.join("Weapons.de-DE.json"),
            r#"{ "4_Name": "Galaxieschwert", "4_Description": "Eine legendäre Klinge unbekannter Herkunft." }"#,
        );
        // NPCNames: clean single-word names.
        write(
            &strings.join("NPCNames.json"),
            r#"{ "Abigail": "Abigail" }"#,
        );
        write(
            &strings.join("NPCNames.de-DE.json"),
            r#"{ "Abigail": "Abby" }"#,
        );
        // Locations: a real place name (kept) + a prose/format value (rejected).
        write(
            &strings.join("Locations.json"),
            r#"{ "Town": "Pelican Town", "Beach_Sign": "Welcome to the beach! Watch for {0}." }"#,
        );
        write(
            &strings.join("Locations.de-DE.json"),
            r#"{ "Town": "Pelikanstadt", "Beach_Sign": "Willkommen am Strand! Achte auf {0}." }"#,
        );
        // StringsFromCSFiles: only the season keys (stored lowercase in real
        // data, normalized to `Spring`); greeting prose is rejected.
        write(
            &strings.join("StringsFromCSFiles.json"),
            r#"{ "spring": "spring", "Greeting": "Hello there" }"#,
        );
        write(
            &strings.join("StringsFromCSFiles.de-DE.json"),
            r#"{ "spring": "Frühling", "Greeting": "Hallo zusammen" }"#,
        );

        let glossary = build(&root.join("Content (unpacked)"), "de").unwrap();
        let find = |source: &str| glossary.entries.iter().find(|e| e.source == source);

        assert_eq!(glossary.format, GLOSSARY_FORMAT);
        assert_eq!(glossary.target_lang, "de");
        assert_eq!(glossary.term_count, glossary.entries.len());

        // Kept, with the right kind.
        assert_eq!(find("Parsnip").map(|e| e.kind), Some(TermKind::Item));
        assert_eq!(find("Galaxy Sword").map(|e| e.kind), Some(TermKind::Weapon));
        assert_eq!(find("Abigail").map(|e| e.kind), Some(TermKind::Npc));
        assert_eq!(
            find("Pelican Town").map(|e| e.kind),
            Some(TermKind::Location)
        );
        assert_eq!(find("Spring").map(|e| e.kind), Some(TermKind::Season));

        // Excluded: descriptions, format strings, greeting prose.
        assert!(glossary.entries.iter().all(|e| !e.source.contains("tuber")));
        assert!(find("Galaxy Sword").is_some() && find("legendary").is_none());
        assert!(find("Hello there").is_none());
        assert!(glossary
            .entries
            .iter()
            .all(|e| !e.source.starts_with("Welcome")));

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn missing_unpacked_folder_errors_cleanly() {
        let root = crate::test_support::temp_dir("glossary-missing");
        let err = build(&root.join("Content (unpacked)"), "de").unwrap_err();
        assert!(err.contains("StardewXnbHack"));
    }

    #[test]
    fn save_then_load_roundtrips_at_format_2() {
        let dir = crate::test_support::temp_dir("glossary-cache");
        let glossary = glossary_of(vec![entry("Spring", "Frühling", TermKind::Season)]);
        save(&dir, &glossary).unwrap();
        let loaded = load(&dir).unwrap();
        assert_eq!(loaded, glossary);
        assert_eq!(loaded.format, 2);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_ignores_old_untyped_and_versioned_caches() {
        let dir = crate::test_support::temp_dir("glossary-old-cache");
        // An untyped v1 cache (`{ terms: {…} }`, no `entries`/`format`) is ignored.
        write(
            &glossary_path(&dir),
            r#"{ "sourceLang": "default", "targetLang": "de", "termCount": 1, "terms": { "Spring": "Frühling" } }"#,
        );
        assert_eq!(load(&dir), None);
        assert!(cache_present(&dir));

        // A typed cache stamped with a different format is also ignored.
        write(
            &glossary_path(&dir),
            r#"{ "format": 1, "sourceLang": "default", "targetLang": "de", "termCount": 0, "entries": [] }"#,
        );
        assert_eq!(load(&dir), None);
        assert!(cache_present(&dir));

        std::fs::remove_dir_all(&dir).ok();
    }
}
