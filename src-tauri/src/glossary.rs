//! Official game and community-pack glossary. See SPEC.md, Optional Glossary and AI.
//!
//! The glossary is a **typed, high-confidence** dictionary of official Stardew
//! names (items, characters, places and more; see [`TermKind`]) and seasons.
//! Each entry carries its `kind` (category) plus the source asset and key it
//! came from. It powers manual translation hints (and the local-AI prompt). It
//! is **optional and non-blocking**: if the data is unavailable, the tool works
//! fully without it.
//!
//! Precision beats recall: a wrong match poisons editor hints and the local-AI
//! prompt, so we only keep short official names — never prose, dialogue, or UI
//! vocabulary. Entries are extracted from a curated set of content `Strings/*`
//! assets, each restricted to the keys that hold display names and screened by a
//! strict term-like quality gate.
//!
//! Data sources are deliberately narrow and read-only. The installed game's
//! `Content/Strings/*.xnb` (and a few `Content/Data/*.xnb`) string dictionaries
//! are decoded directly; no unpacking tool is needed. Community language packs
//! may supply the corresponding target `Strings` dictionaries (as XNB or JSON).
//! English and target values are paired by key before the quality gate runs.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::xnb;

/// On-disk cache schema version written by this app: v1 was untyped, v2 typed
/// `entries`, v3 the same layout with more name groups. An older typed cache
/// still loads; the status asks for a rebuild.
pub const GLOSSARY_FORMAT: u32 = 3;

/// The oldest cache format `load` accepts: the first typed layout. Newer
/// formats load too as long as they parse, so a cache from a newer app keeps
/// working here instead of silently disabling the glossary.
const MIN_GLOSSARY_FORMAT: u32 = 2;

/// Category of an official term. Encodes confidence (each kind is restricted to
/// a content asset and key rule) and drives the editor's category chip.
///
/// Adding a kind needs no format bump: a kind this app does not know (from a
/// cache built by a newer version) loads as [`TermKind::Unknown`] instead of
/// failing the whole cache.
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
    Festival,
    Building,
    Animal,
    Monster,
    Movie,
    /// A kind from a newer app version; the term itself is still usable.
    #[serde(other)]
    Unknown,
}

/// Where a glossary's term pairs came from. `Official` uses the installed
/// game's XNB strings for a game-supported language. `CommunityPack` pairs the English game base with an installed
/// custom-language pack's `Strings/*`. Defaults to `Official` so caches written
/// before this field round-trip unchanged.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum GlossarySource {
    #[default]
    Official,
    CommunityPack,
}

/// Storage format of a community language pack's `Strings` assets. JSON is
/// a plain key/value file; XNB is direct `Dictionary<string,string>` content.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StringAssetFormat {
    Json,
    Xnb,
}

/// One official term: `source` (English) → `target`, tagged with its category
/// and the `asset`/`key` it was extracted from for debugging provenance.
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
    /// How the terms were sourced (official game content vs. a community pack).
    #[serde(default)]
    pub source: GlossarySource,
    /// For a `CommunityPack` build, the pack's display name (provenance shown in
    /// the UI). Never an on-disk path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pack_name: Option<String>,
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
    /// Only keys starting with one of these prefixes (assets that mix names
    /// with menu choices and dialogue under other keys, `MapPage.cs.`).
    Prefixes(&'static [&'static str]),
    /// Only keys ending with this suffix (`_Title`).
    Suffix(&'static str),
    /// Keys starting with the prefix, or exactly the one extra key.
    PrefixOrKey(&'static str, &'static str),
    /// Only these exact keys (single names inside assets of UI text).
    Keys(&'static [&'static str]),
}

/// One asset the glossary reads: which keys and which part of each value hold a
/// name, and how strictly the names are screened. `asset` is a `Strings` asset
/// name (`Objects`), or `Data/…` for a `Content/Data` dictionary.
#[derive(Clone, Copy)]
struct AssetSpec {
    asset: &'static str,
    kind: TermKind,
    rule: KeyRule,
    value: ValuePart,
    /// Keep single-word names. False where single words are ordinary
    /// vocabulary with the ordinary translation (`Bat`, `Pig`, `Popcorn`).
    single_words: bool,
    /// Skip values with digits or brackets (opening hours, addresses, tokens).
    strict: bool,
}

/// Defaults for [`TYPED_ASSETS`]: the whole value, shared quality gate only.
const TYPED: AssetSpec = AssetSpec {
    asset: "",
    kind: TermKind::Item,
    rule: KeyRule::Bare,
    value: ValuePart::Whole,
    single_words: true,
    strict: false,
};

/// Defaults for [`NAME_ASSETS`]: strict screening, single words allowed.
const NAME: AssetSpec = AssetSpec {
    strict: true,
    ..TYPED
};

/// Typed content assets, in priority order — when the same English name appears
/// in several assets, the first one wins (item names beat stray collisions).
/// Assets absent from the selected string source are simply skipped. The generic
/// `1_6_Strings` asset mixes UI and content terms, so [`NAME_ASSETS`] reads only
/// a few exact keys from it.
const TYPED_ASSETS: &[AssetSpec] = &[
    AssetSpec {
        asset: "Objects",
        kind: TermKind::Item,
        ..TYPED
    },
    AssetSpec {
        asset: "BigCraftables",
        kind: TermKind::BigCraftable,
        ..TYPED
    },
    AssetSpec {
        asset: "Weapons",
        kind: TermKind::Weapon,
        rule: KeyRule::NameOnly,
        ..TYPED
    },
    AssetSpec {
        asset: "Tools",
        kind: TermKind::Tool,
        rule: KeyRule::NameOnly,
        ..TYPED
    },
    AssetSpec {
        asset: "Pants",
        kind: TermKind::Clothing,
        rule: KeyRule::NameOnly,
        ..TYPED
    },
    AssetSpec {
        asset: "Shirts",
        kind: TermKind::Clothing,
        rule: KeyRule::NameOnly,
        ..TYPED
    },
    AssetSpec {
        asset: "NPCNames",
        kind: TermKind::Npc,
        ..TYPED
    },
    AssetSpec {
        asset: "Locations",
        kind: TermKind::Location,
        // The asset also holds menu choices (`AnimalShop_Marnie_Leave`) and
        // dialogue, so only key groups that are real names are read.
        rule: KeyRule::Prefixes(&[
            "AdventureGuild_KillList_",
            "AdventureGuild_ItemRecovery",
            "CommunityCenter_AreaName_",
            "MineCart_Destination_",
        ]),
        ..TYPED
    },
    AssetSpec {
        asset: "StringsFromCSFiles",
        kind: TermKind::Season,
        rule: KeyRule::Seasons,
        ..TYPED
    },
];

/// Which part of a dictionary value holds the display name.
#[derive(Clone, Copy)]
enum ValuePart {
    /// The whole value.
    Whole,
    /// The first line (`\n` or the game's `^`): map labels list opening hours
    /// or an address below the name.
    FirstLine,
    /// One `/`-separated field of a `Data/*` record (0-based).
    Field(usize),
    /// The last `/`-separated field (`Data/Monsters` keeps its display name there).
    LastField,
}

/// Further official name groups, read after [`TYPED_ASSETS`] (so an item name
/// still wins a collision). Their names often share a value with opening hours,
/// addresses, stats or tokens, so values with digits or brackets are skipped.
/// Single-word monsters, animals, hats and concessions are ordinary words and
/// are dropped; single-word buildings and places stay, since the official term
/// often differs from the everyday one (`Barn` -> `Stall`, not `Scheune`).
/// `Data/*` assets are official-only; community packs supply `Strings` only.
///
/// Only string dictionaries are read. `Data/Locations`, `Data/WorldMap` and
/// `Data/PassiveFestivals` are typed objects that the narrow XNB reader does not
/// decode; their display names point at `StringsFromCSFiles` (`MapPage.cs.*`),
/// `Strings/WorldMap`, `Strings/UI` and `Strings/1_6_Strings`, which are read
/// here instead.
const NAME_ASSETS: &[AssetSpec] = &[
    AssetSpec {
        asset: "Data/Festivals/FestivalDates",
        kind: TermKind::Festival,
        ..NAME
    },
    // Passive festivals: the keys their `DisplayName` and calendar entries
    // point at. Both assets are otherwise UI text and dialogue.
    AssetSpec {
        asset: "UI",
        kind: TermKind::Festival,
        rule: KeyRule::Keys(&["Billboard_NightMarket"]),
        ..NAME
    },
    AssetSpec {
        asset: "1_6_Strings",
        kind: TermKind::Festival,
        rule: KeyRule::Keys(&["DesertFestival", "TroutDerby", "SquidFest"]),
        ..NAME
    },
    AssetSpec {
        asset: "Buildings",
        kind: TermKind::Building,
        rule: KeyRule::NameOnly,
        ..NAME
    },
    AssetSpec {
        asset: "StringsFromCSFiles",
        kind: TermKind::Location,
        // `IslandName` is the only plain `Ginger Island` string in the game.
        rule: KeyRule::PrefixOrKey("MapPage.cs.", "IslandName"),
        value: ValuePart::FirstLine,
        ..NAME
    },
    AssetSpec {
        asset: "WorldMap",
        kind: TermKind::Location,
        value: ValuePart::FirstLine,
        ..NAME
    },
    AssetSpec {
        asset: "FarmAnimals",
        kind: TermKind::Animal,
        rule: KeyRule::Prefixes(&["DisplayType_"]),
        single_words: false,
        ..NAME
    },
    AssetSpec {
        asset: "Data/Boots",
        kind: TermKind::Clothing,
        value: ValuePart::Field(6),
        ..NAME
    },
    AssetSpec {
        asset: "Data/hats",
        kind: TermKind::Clothing,
        value: ValuePart::Field(5),
        single_words: false,
        ..NAME
    },
    AssetSpec {
        asset: "Data/Monsters",
        kind: TermKind::Monster,
        value: ValuePart::LastField,
        single_words: false,
        ..NAME
    },
    AssetSpec {
        asset: "Movies",
        kind: TermKind::Movie,
        rule: KeyRule::Suffix("_Title"),
        ..NAME
    },
    AssetSpec {
        asset: "MovieConcessions",
        kind: TermKind::Item,
        rule: KeyRule::NameOnly,
        single_words: false,
        ..NAME
    },
];

/// Provenance label (`asset`) of the hand-checked [`CURATED_DE`] entries.
const CURATED_ASSET: &str = "curated";

/// German names that appear only in dialogue and descriptions, so no name asset
/// holds them. Hand-checked against the game's most common wording; applied to
/// official German builds only, after every asset-derived entry.
const CURATED_DE: &[(&str, &str)] = &[
    ("Stardew Valley", "Sternentautal"),
    ("JojaMart", "Joja-Markt"),
    ("Skull Cavern", "Schädelhöhle"),
    ("Cindersap Forest", "Zundersaftwald"),
    ("Gem Sea", "Edelsteinsee"),
];

/// Append the curated names for `target_lang`. An English term an asset already
/// defines keeps its asset-derived entry. The quality gate is skipped: these
/// are reviewed by hand.
fn add_curated_entries(entries: &mut Vec<GlossaryEntry>, target_lang: &str) {
    let curated = match target_lang {
        "de" => CURATED_DE,
        _ => return,
    };
    let mut seen: HashSet<String> = entries.iter().map(|entry| entry.source.clone()).collect();
    for (source, target) in curated {
        if seen.insert((*source).to_string()) {
            entries.push(GlossaryEntry {
                source: (*source).to_string(),
                target: (*target).to_string(),
                kind: TermKind::Location,
                asset: CURATED_ASSET.to_string(),
                key: (*source).to_string(),
            });
        }
    }
}

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
        let Some((start, end)) = whole_word_range(&haystack, &needle, &occupied) else {
            continue;
        };
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
fn whole_word_range(
    haystack: &[char],
    needle: &[char],
    occupied: &[(usize, usize)],
) -> Option<(usize, usize)> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return None;
    }
    let is_word = |c: Option<&char>| c.is_some_and(|c| c.is_alphanumeric());
    for idx in 0..=haystack.len() - needle.len() {
        if &haystack[idx..idx + needle.len()] != needle {
            continue;
        }
        let before = if idx == 0 {
            None
        } else {
            haystack.get(idx - 1)
        };
        let end = idx + needle.len();
        let after = haystack.get(end);
        if is_word(before) || is_word(after) {
            continue;
        }
        if occupied
            .iter()
            .any(|&(start, stop)| idx < stop && start < end)
        {
            continue;
        }
        return Some((idx, end));
    }
    None
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GlossaryInfo {
    pub target_lang: String,
    pub term_count: usize,
    /// Provenance of the cached glossary (official content vs. a community pack).
    #[serde(default)]
    pub source: GlossarySource,
    /// The community pack's display name, when `source` is `CommunityPack`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pack_name: Option<String>,
}

impl GlossaryInfo {
    /// Summarize a built/loaded glossary for the UI, carrying its provenance.
    pub fn of(glossary: &Glossary) -> Self {
        Self {
            target_lang: glossary.target_lang.clone(),
            term_count: glossary.term_count,
            source: glossary.source,
            pack_name: glossary.pack_name.clone(),
        }
    }
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GlossaryStatus {
    /// Whether the installed game exposes direct `Content/Strings/*.xnb` assets.
    pub game_xnb_present: bool,
    /// Whether the game's string source for glossary extraction is available
    /// (currently the same as `game_xnb_present`).
    pub source_available: bool,
    /// The currently cached glossary, if a valid typed one exists.
    pub cached: Option<GlossaryInfo>,
    /// The UI should recommend a rebuild: the cache predates `GLOSSARY_FORMAT`,
    /// or a legacy `glossary.json` is old/invalid. False when no rebuild is possible.
    pub outdated_cache: bool,
    /// For a game-unsupported language, whether an installed community language
    /// pack was detected that could supply a glossary. Always false for
    /// game-supported languages (they build from official content).
    pub pack_available: bool,
    /// Whether the detected community pack supplies direct `Strings/*_<lang>.xnb`.
    pub pack_xnb_available: bool,
    /// The detected community pack's display name, when `pack_available`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pack_name: Option<String>,
}

/// Map a SMAPI i18n code to the game's content locale suffix.
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

/// The installed game's direct `Content/Strings` folder.
pub fn default_game_strings_path(stardew_path: &Path) -> PathBuf {
    stardew_path.join("Content").join("Strings")
}

/// Whether direct game `Strings/*.xnb` assets are present.
pub fn game_xnb_present(stardew_path: &Path) -> bool {
    let strings_dir = default_game_strings_path(stardew_path);
    strings_dir.is_dir()
        && TYPED_ASSETS
            .iter()
            .any(|spec| strings_dir.join(format!("{}.xnb", spec.asset)).is_file())
}

/// Whether the local game glossary source is available.
pub fn source_available(stardew_path: &Path) -> bool {
    game_xnb_present(stardew_path)
}

/// The content `Strings/*` asset base-names the typed glossary extracts from
/// (e.g. `Objects`, `NPCNames`). Lets the language-pack detector score how much
/// of a pack is usable without duplicating the asset list.
pub fn typed_asset_names() -> Vec<&'static str> {
    TYPED_ASSETS.iter().map(|spec| spec.asset).collect()
}

/// Extract typed entries by pairing the English dictionary of each asset
/// with its target dictionary. Official content stores the locale inline
/// (`Objects.de-DE.xnb`), while a community pack uses its own file names
/// (`Objects.json`, `Objects_th.xnb`). The first asset to define a name
/// wins (priority order).
fn build_entries(
    english_map: &dyn Fn(&str) -> Option<HashMap<String, String>>,
    target_map: &dyn Fn(&str) -> Option<HashMap<String, String>>,
    target_lang: &str,
) -> Vec<GlossaryEntry> {
    let mut entries: Vec<GlossaryEntry> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for spec in TYPED_ASSETS.iter().chain(NAME_ASSETS) {
        let base = english_map(spec.asset);
        let localized = target_map(spec.asset);
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
            let (Some(english), Some(target)) = (
                value_part(&base[key], spec.value),
                value_part(target, spec.value),
            ) else {
                continue;
            };
            if spec.strict && (has_digit_or_bracket(english) || has_digit_or_bracket(target)) {
                continue;
            }
            // Season tokens are stored lowercase (`spring`), but appear
            // capitalized in mod text (`Spring`); normalize so the term-like gate
            // accepts them and case-sensitive matching can fire.
            let english = if matches!(spec.rule, KeyRule::Seasons) {
                capitalize_first(english)
            } else {
                english.to_string()
            };
            let Some((source, target)) = glossary_term(&english, target, target_lang) else {
                continue;
            };
            if !spec.single_words && source.split_whitespace().count() < 2 {
                continue;
            }
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
    entries
}

/// The game's `Content/Strings` folder is missing.
const NO_GAME_STRINGS: &str = "The game's Content/Strings folder was not found. Check that the Stardew Valley folder in Settings is correct, then build the glossary again.";

/// Build the official glossary from the installed game's `Content/Strings`
/// (and the few `Content/Data`) XNB dictionaries: English base + the inline
/// `.<locale>.xnb` variant.
pub fn build_from_game(stardew_path: &Path, target_lang: &str) -> Result<Glossary, String> {
    let suffix = game_locale_suffix(target_lang)
        .ok_or_else(|| format!("Unsupported target language: {target_lang}"))?;
    let strings_dir = default_game_strings_path(stardew_path);
    if !strings_dir.is_dir() {
        return Err(NO_GAME_STRINGS.to_string());
    }
    // `Data/…` assets live in `Content/Data`, all others in `Content/Strings`.
    let data_dir = stardew_path.join("Content").join("Data");
    let path_of = |file: &str| match file.strip_prefix("Data/") {
        Some(file) => data_dir.join(file),
        None => strings_dir.join(file),
    };
    // The first problem per asset, kept so a failed build can name the cause.
    let problems = std::cell::RefCell::new(Vec::<(String, String)>::new());
    let note = |asset: &str, problem: String| {
        let mut problems = problems.borrow_mut();
        if !problems.iter().any(|(seen, _)| seen == asset) {
            problems.push((asset.to_string(), problem));
        }
    };
    let read = |asset: &str, file: String| {
        let path = path_of(&file);
        if !path.is_file() {
            return None;
        }
        xnb::read_string_dictionary(&path)
            .inspect_err(|error| note(asset, format!("{file}: {error}")))
            .ok()
    };
    let mut entries = build_entries(
        &|asset| {
            let english = read(asset, format!("{asset}.xnb"));
            let target = format!("{asset}.{suffix}.xnb");
            if english.is_some() && !path_of(&target).is_file() {
                note(asset, format!("{target} is missing"));
            }
            english
        },
        &|asset| read(asset, format!("{asset}.{suffix}.xnb")),
        target_lang,
    );
    let problems = problems.into_inner();
    for (_, problem) in &problems {
        log::warn!(target: "app", "Game XNB skipped for the glossary: {problem}");
    }
    if !entries.is_empty() {
        // Only on top of real asset names: curated terms alone never make a
        // glossary out of unreadable game files.
        add_curated_entries(&mut entries, target_lang);
        return Ok(Glossary {
            format: GLOSSARY_FORMAT,
            source_lang: "default".to_string(),
            target_lang: target_lang.to_string(),
            term_count: entries.len(),
            source: GlossarySource::Official,
            pack_name: None,
            entries,
        });
    }
    Err(game_files_problem(
        &problems,
        " This language may not be available in this game version, or the game files are damaged.",
    ))
}

/// The game's `Content/Strings` files gave no usable names. Names the first
/// recorded problem (file name only) and how many more there were; `cause`
/// is a sentence on the likely reason, with a leading space.
fn game_files_problem(problems: &[(String, String)], cause: &str) -> String {
    let Some((_, first)) = problems.first() else {
        return "No official names were found in the game's Content/Strings files. Check that the Stardew Valley folder in Settings is correct, then build the glossary again.".to_string();
    };
    let more = match problems.len() - 1 {
        0 => String::new(),
        1 => " One more file has a problem too.".to_string(),
        n => format!(" {n} more files have problems too."),
    };
    format!(
        "The game's text files could not be read ({}).{more}{cause} Verify the game files in Steam or GOG, then build the glossary again.",
        first.trim_end_matches('.')
    )
}

/// Build a glossary for a game-unsupported `target_lang` from an installed
/// community language pack. The English base comes from the installed game's
/// `Content/Strings` XNB dictionaries; the target side comes from the pack's
/// `Strings/` folder, whose files share the English keys. Untranslated
/// (English-identical) values are dropped by the term-quality gate, so only
/// genuine translations remain.
pub fn build_from_pack(
    game_strings: &Path,
    pack_root: &Path,
    pack_strings_dir: &Path,
    pack_format: StringAssetFormat,
    target_lang: &str,
    pack_name: &str,
) -> Result<Glossary, String> {
    if !pack_strings_dir.is_dir() {
        return Err("The language pack has no readable Strings folder.".to_string());
    }
    if !game_strings.is_dir() {
        return Err(NO_GAME_STRINGS.to_string());
    }

    let pack_root = pack_root
        .canonicalize()
        .map_err(|error| format!("Could not identify the language pack folder: {error}"))?;
    let target_map = |asset: &str| {
        // Packs supply `Strings` only; `Data/…` names stay official-only.
        if asset.starts_with("Data/") {
            return None;
        }
        let filename = match pack_format {
            StringAssetFormat::Json => format!("{asset}.json"),
            StringAssetFormat::Xnb => format!("{asset}_{target_lang}.xnb"),
        };
        let path = pack_strings_dir.join(filename).canonicalize().ok()?;
        if !path.starts_with(&pack_root) {
            return None;
        }
        match pack_format {
            StringAssetFormat::Json => read_string_map(&path),
            StringAssetFormat::Xnb => xnb::read_string_dictionary(&path).ok(),
        }
    };
    // Problems with the game's English files, and whether any could be read:
    // without a readable English base the pack is not the cause.
    let problems = std::cell::RefCell::new(Vec::<(String, String)>::new());
    let english_read = std::cell::Cell::new(false);
    let entries = build_entries(
        &|asset| {
            if asset.starts_with("Data/") {
                return None;
            }
            let file = format!("{asset}.xnb");
            let path = game_strings.join(&file);
            if !path.is_file() {
                return None;
            }
            let english = xnb::read_string_dictionary(&path)
                .inspect_err(|error| {
                    let mut problems = problems.borrow_mut();
                    // `StringsFromCSFiles` feeds two groups; report it once.
                    if !problems.iter().any(|(seen, _)| seen == asset) {
                        log::warn!(target: "app", "Game Strings XNB skipped for the glossary: {file}: {error}");
                        problems.push((asset.to_string(), format!("{file}: {error}")));
                    }
                })
                .ok();
            english_read.set(english_read.get() || english.is_some());
            english
        },
        &target_map,
        target_lang,
    );
    if entries.is_empty() && !english_read.get() {
        return Err(game_files_problem(
            &problems.into_inner(),
            " The English names come from these files, so the language pack cannot be used without them.",
        ));
    }
    if entries.is_empty() {
        return Err(format!(
            "No official terms could be extracted from the language pack \"{pack_name}\"."
        ));
    }
    Ok(Glossary {
        format: GLOSSARY_FORMAT,
        source_lang: "default".to_string(),
        target_lang: target_lang.to_string(),
        term_count: entries.len(),
        source: GlossarySource::CommunityPack,
        pack_name: Some(pack_name.to_string()),
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
        KeyRule::Prefixes(prefixes) => prefixes.iter().any(|prefix| key.starts_with(prefix)),
        KeyRule::Suffix(suffix) => key.ends_with(suffix),
        KeyRule::PrefixOrKey(prefix, exact) => key.starts_with(prefix) || key == exact,
        KeyRule::Keys(keys) => keys.contains(&key),
    }
}

/// The part of `value` that holds the display name, or `None` when a `Data/*`
/// record has fewer fields.
fn value_part(value: &str, part: ValuePart) -> Option<&str> {
    match part {
        ValuePart::Whole => Some(value),
        // `^` is the game's line break in UI text.
        ValuePart::FirstLine => value.split(['\n', '\r', '^']).next(),
        ValuePart::Field(index) => value.split('/').nth(index),
        ValuePart::LastField => value.rsplit('/').next(),
    }
}

/// Whether a value carries digits or brackets: opening hours, addresses, stats,
/// or tokens such as `[LocalizedText …]` rather than a plain name.
fn has_digit_or_bracket(value: &str) -> bool {
    value
        .chars()
        .any(|c| c.is_numeric() || matches!(c, '[' | ']' | '(' | ')' | '{' | '}' | '<' | '>'))
}

/// Accept a pair only if it is a short, term-like official name (not prose, not
/// a token, not a UI command). Returns the trimmed (english, target) to store.
fn glossary_term(english: &str, target: &str, target_lang: &str) -> Option<(String, String)> {
    let en = english.trim();
    let tgt = target.trim();
    if en.is_empty() || tgt.is_empty() || en.eq_ignore_ascii_case(tgt) {
        return None;
    }
    // The glossary is strictly official names, not dialogue or UI
    // vocabulary. Official names are Title Case proper nouns (`Parsnip`,
    // `Pelican Town`, `Iridium Ore`), so a value with a lowercase word — whether
    // a leading one (`the farm`, `away from`) or an interior one
    // (`Hello there`) — is prose and must never become a forced "official term".
    // Only short function words inside a name stay lowercase (`Ring of Yoba`).
    if en.split_whitespace().enumerate().any(|(index, word)| {
        word.chars().next().is_some_and(char::is_lowercase)
            && (index == 0 || !is_name_function_word(word))
    }) {
        return None;
    }
    // Common UI/menu commands (`Play`, `Quit`, `Yes`, `Back`) are capitalized and
    // slip past the case test, so a small stoplist drops them. Forcing these
    // rigidifies ordinary translation (e.g. `Right` -> `Rechts` when it means
    // "correct").
    if is_common_ui_word(en) {
        return None;
    }
    // Function words inside a name do not count, so `Feast of the Winter Star`
    // stays a name while longer descriptions / dialogue prose are excluded.
    // Titles capitalize them (`It Howls In The Rain`), so case is ignored here.
    let content_words = en
        .split_whitespace()
        .filter(|word| !is_name_function_word(&word.to_lowercase()))
        .count();
    if en.chars().count() > 30 || content_words > 4 {
        return None;
    }
    // A clean name maps roughly 1:1; German compounds rather than expands, so a
    // target with several more words than the source is a mis-paired dialogue
    // fragment (e.g. `head` -> `meinen schmerzenden Kopf`), not a named entity.
    // Allow a single extra word for the occasional legitimate expansion.
    // Vietnamese writes every syllable as its own word (`Củ cải vàng`), so the
    // count says nothing there.
    if !writes_syllables_as_words(target_lang)
        && tgt.split_whitespace().count() > en.split_whitespace().count() + 1
    {
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
        "leave", "shop", "rules", "hint", "well",
    ];
    STOPWORDS.iter().any(|word| term.eq_ignore_ascii_case(word))
}

/// Short function words that stay lowercase inside an official name
/// (`Ring of Yoba`, `Message in a Bottle`). Kept small and explicit.
fn is_name_function_word(word: &str) -> bool {
    const FUNCTION_WORDS: &[&str] = &[
        "of", "the", "and", "a", "an", "in", "on", "de", "la", "le", "von", "der", "die", "das",
    ];
    FUNCTION_WORDS.contains(&word)
}

/// Languages that separate every syllable with a space, so a word count does
/// not show whether a target is longer than its source.
fn writes_syllables_as_words(target_lang: &str) -> bool {
    target_lang
        .split(['-', '_'])
        .next()
        .is_some_and(|base| base.eq_ignore_ascii_case("vi"))
}

fn read_string_map(path: &Path) -> Option<HashMap<String, String>> {
    let body = crate::input_limits::read_json_text(path).ok()?;
    // Pack Strings files are hand-edited like other mod JSON:
    // accept comments and trailing commas (SPEC: relaxed mod JSON).
    let value: Value = crate::scanner::parse_json_lenient(&body).ok()?;
    let object = value.as_object()?;
    let mut map = HashMap::with_capacity(object.len());
    for (key, value) in object {
        if let Some(text) = value.as_str() {
            map.insert(key.clone(), text.to_string());
        }
    }
    Some(map)
}

/// The folder holding the per-language cache files (`<config>/glossary/`).
fn glossary_dir(config_dir: &Path) -> PathBuf {
    config_dir.join("glossary")
}

/// Per-language cache file path: `glossary/glossary-<lang>.json`. Only a
/// canonical supported target code may reach the filename.
fn glossary_path(config_dir: &Path, lang: &str) -> Option<PathBuf> {
    let safe = crate::language::normalize_target_code(lang).ok()?;
    Some(glossary_dir(config_dir).join(format!("glossary-{safe}.json")))
}

/// The pre-v1.4.0 single-file cache path (one shared `glossary.json` directly in
/// the config dir). Retained only for one-time migration into the per-language
/// `glossary/` subfolder.
fn legacy_glossary_path(config_dir: &Path) -> PathBuf {
    config_dir.join("glossary.json")
}

/// Whether a legacy single-file `glossary.json` still exists. After
/// [`migrate_legacy_cache`] runs, this is true only for an unmigratable
/// (unparseable / wrong-format) leftover — which drives the "rebuild recommended"
/// status.
pub fn legacy_cache_present(config_dir: &Path) -> bool {
    legacy_glossary_path(config_dir).is_file()
}

/// Remove a legacy single-file `glossary.json`. Call after
/// [`migrate_legacy_cache`], when only an unmigratable leftover can remain, and
/// only once a current glossary was built, so nothing usable is lost.
pub fn remove_legacy_cache(config_dir: &Path) {
    let _ = std::fs::remove_file(legacy_glossary_path(config_dir));
}

pub fn save(config_dir: &Path, glossary: &Glossary) -> Result<(), String> {
    let path = glossary_path(config_dir, &glossary.target_lang)
        .ok_or_else(|| format!("Invalid target language: {}", glossary.target_lang))?;
    let body = serde_json::to_string(glossary).map_err(|e| format!("serialize glossary: {e}"))?;
    crate::input_limits::ensure_json_output_size(body.len() as u64, "Glossary JSON")?;
    std::fs::create_dir_all(glossary_dir(config_dir))
        .map_err(|e| format!("Could not create glossary dir: {e}"))?;
    // Write beside the target and rename, so an interrupted save keeps the
    // previous glossary instead of leaving a truncated file.
    let mut temp_name = path.as_os_str().to_owned();
    temp_name.push(".tmp");
    let temp = std::path::PathBuf::from(temp_name);
    crate::input_limits::write_synced(&temp, body.as_bytes())
        .and_then(|()| std::fs::rename(&temp, &path))
        .map_err(|e| {
            std::fs::remove_file(&temp).ok();
            format!("write glossary: {e}")
        })
}

/// Load the cached glossary for `lang`, or `None` when its file is missing,
/// unparseable, or older than the typed format. Because the cache is keyed by
/// language, an unsupported language (which never builds a file) always loads
/// `None`, and a stale build for another language can never leak in. Unknown
/// term kinds from a newer app load as [`TermKind::Unknown`]. Never panics.
pub fn load(config_dir: &Path, lang: &str) -> Option<Glossary> {
    let body = crate::input_limits::read_json_text(&glossary_path(config_dir, lang)?).ok()?;
    let glossary: Glossary = serde_json::from_str(&body).ok()?;
    // Any parseable format from 2 up is accepted, so a future breaking change
    // must rename fields or change the layout, not only bump `format`.
    if glossary.format < MIN_GLOSSARY_FORMAT || glossary.target_lang != lang {
        return None;
    }
    Some(glossary)
}

/// One-time migration of older cache layouts into the current
/// `glossary/glossary-<lang>.json` one. Idempotent and best-effort — failures are
/// swallowed so a migration hiccup never blocks the app.
///
/// 1. Flat per-language files from the first v1.4.0 layout
///    (`<config>/glossary-<lang>.json`) are moved into the `glossary/` subfolder.
/// 2. A pre-v1.4.0 single `glossary.json` is moved to
///    `glossary/glossary-<its target_lang>.json` (unless that already exists).
///    An unparseable/old-format single file is left in place so
///    `legacy_cache_present` can still flag it for rebuild.
pub fn migrate_legacy_cache(config_dir: &Path) {
    relocate_flat_per_language_files(config_dir);

    let legacy = legacy_glossary_path(config_dir);
    let Ok(body) = crate::input_limits::read_json_text(&legacy) else {
        return;
    };
    let Ok(glossary) = serde_json::from_str::<Glossary>(&body) else {
        return; // unparseable → leave it for the outdated-cache flag
    };
    if glossary.format < MIN_GLOSSARY_FORMAT {
        return; // untyped format → leave it for the outdated-cache flag
    }
    let Some(target) = glossary_path(config_dir, &glossary.target_lang) else {
        return;
    };
    if target.exists() {
        // A per-language file already exists; just drop the stale legacy copy.
        let _ = std::fs::remove_file(&legacy);
    } else {
        let _ = std::fs::create_dir_all(glossary_dir(config_dir));
        // Rename into the per-language name; if the move fails, the legacy file
        // simply stays put and the next run retries.
        let _ = std::fs::rename(&legacy, &target);
    }
}

/// Move any flat `<config>/glossary-<lang>.json` files (the first v1.4.0 layout,
/// before the `glossary/` subfolder) into the subfolder. Skips a destination that
/// already exists.
fn relocate_flat_per_language_files(config_dir: &Path) {
    let Ok(entries) = std::fs::read_dir(config_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        // `glossary-<lang>.json` at the top level (the single `glossary.json` has
        // no `-` after `glossary`, so it is not matched here).
        let Some(lang) = name
            .strip_prefix("glossary-")
            .and_then(|rest| rest.strip_suffix(".json"))
        else {
            continue;
        };
        let Some(dest) = glossary_path(config_dir, lang) else {
            continue;
        };
        if entry.path() == dest || dest.exists() {
            continue;
        }
        let _ = std::fs::create_dir_all(glossary_dir(config_dir));
        let _ = std::fs::rename(entry.path(), &dest);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, body: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    fn write_bytes(path: &Path, body: &[u8]) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    fn write_7bit(out: &mut Vec<u8>, mut value: usize) {
        loop {
            let mut byte = (value & 0x7f) as u8;
            value >>= 7;
            if value != 0 {
                byte |= 0x80;
            }
            out.push(byte);
            if value == 0 {
                break;
            }
        }
    }

    fn write_xnb_string(out: &mut Vec<u8>, text: &str) {
        write_7bit(out, text.len());
        out.extend_from_slice(text.as_bytes());
    }

    fn test_xnb_dictionary(entries: &[(&str, &str)]) -> Vec<u8> {
        let mut content = Vec::new();
        write_7bit(&mut content, 2);
        write_xnb_string(
            &mut content,
            "Microsoft.Xna.Framework.Content.DictionaryReader`2[[System.String, mscorlib],[System.String, mscorlib]]",
        );
        content.extend_from_slice(&0i32.to_le_bytes());
        write_xnb_string(&mut content, "Microsoft.Xna.Framework.Content.StringReader");
        content.extend_from_slice(&0i32.to_le_bytes());
        write_7bit(&mut content, 0);
        write_7bit(&mut content, 1);
        content.extend_from_slice(&(entries.len() as u32).to_le_bytes());
        for (key, value) in entries {
            write_7bit(&mut content, 2);
            write_xnb_string(&mut content, key);
            write_7bit(&mut content, 2);
            write_xnb_string(&mut content, value);
        }

        let mut xnb = Vec::new();
        xnb.extend_from_slice(b"XNBw");
        xnb.push(5);
        xnb.push(0x01);
        xnb.extend_from_slice(&0u32.to_le_bytes());
        xnb.extend_from_slice(&content);
        let len = xnb.len() as u32;
        xnb[6..10].copy_from_slice(&len.to_le_bytes());
        xnb
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

    /// Drift guard against `src/languages.ts`: both suites read the same
    /// fixture, so the TypeScript `gameLocale` entries match this table.
    #[test]
    fn shared_target_language_fixture_matches() {
        let body = include_str!("../../tests/fixtures/target-languages.json");
        let parsed: serde_json::Value = serde_json::from_str(body).unwrap();
        let languages = parsed["languages"].as_array().unwrap();
        let codes: Vec<&str> = languages
            .iter()
            .map(|language| language["code"].as_str().unwrap())
            .collect();
        assert_eq!(codes, crate::language::TARGET_LANGUAGE_CODES);
        for language in languages {
            let code = language["code"].as_str().unwrap();
            assert_eq!(
                game_locale_suffix(code),
                language["gameLocale"].as_str(),
                "{code}"
            );
        }
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

        // The shorter term may still claim a later, non-overlapping occurrence.
        let hits = match_terms("Iridium Ore and Ore", &glossary);
        assert_eq!(
            hits,
            vec![
                ("Iridium Ore".to_string(), "Iridiumerz".to_string()),
                ("Ore".to_string(), "Erz".to_string()),
            ]
        );
    }

    #[test]
    fn match_continues_after_an_invalid_first_occurrence() {
        let glossary = glossary_of(vec![entry("Parsnip", "Pastinake", TermKind::Item)]);
        assert_eq!(
            match_terms("Parsnips beside a Parsnip", &glossary),
            vec![("Parsnip".to_string(), "Pastinake".to_string())]
        );
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
            glossary_term("Parsnip", "Pastinake", "de"),
            Some(("Parsnip".to_string(), "Pastinake".to_string()))
        );
        assert_eq!(
            glossary_term("Iridium Ore", "Iridiumerz", "de"),
            Some(("Iridium Ore".to_string(), "Iridiumerz".to_string()))
        );
        assert_eq!(
            glossary_term("Pelican Town", "Pelikanstadt", "de"),
            Some(("Pelican Town".to_string(), "Pelikanstadt".to_string()))
        );
        assert_eq!(
            glossary_term("Spring", "Frühling", "de"),
            Some(("Spring".to_string(), "Frühling".to_string()))
        );
        assert_eq!(
            glossary_term("Abigail", "Abigail-DE", "de"),
            Some(("Abigail".to_string(), "Abigail-DE".to_string()))
        );
        assert_eq!(
            glossary_term("Mayor", "Der Bürgermeister", "de"),
            Some(("Mayor".to_string(), "Der Bürgermeister".to_string()))
        );
    }

    #[test]
    fn quality_gate_rejects_prose_and_ui_and_tokens() {
        // Prose / dialogue fragments (a lowercase interior word betrays them).
        assert_eq!(glossary_term("Hello there", "Hallo zusammen", "de"), None);
        assert_eq!(glossary_term("the farm", "der Hof", "de"), None);
        assert_eq!(glossary_term("away from", "weg von", "de"), None);
        assert_eq!(glossary_term("good", "gut", "de"), None);
        // A full sentence / description (ends with punctuation).
        assert_eq!(
            glossary_term(
                "A long sentence describing things.",
                "Ein langer Satz.",
                "de"
            ),
            None
        );
        // Capitalized UI/menu commands -> stoplist.
        assert_eq!(glossary_term("Play", "Spielen", "de"), None);
        assert_eq!(glossary_term("Right", "Rechts", "de"), None);
        assert_eq!(glossary_term("Back", "Zurück", "de"), None);
        assert_eq!(glossary_term("Good", "Gut", "de"), None);
        // Mis-paired dialogue fragment (target far longer than the source).
        assert_eq!(
            glossary_term("Head", "mein ganzer schmerzender Kopf", "de"),
            None
        );
        // Format strings / tokens / multi-line.
        assert_eq!(glossary_term("Day {0}", "Tag {0}", "de"), None);
        assert_eq!(glossary_term("Line\tbreak", "Zeile\tumbruch", "de"), None);
        // Identical value (no translation).
        assert_eq!(glossary_term("Junimo", "Junimo", "de"), None);
    }

    #[test]
    fn quality_gate_keeps_names_with_function_words() {
        assert_eq!(
            glossary_term("Ring of Yoba", "Ring von Yoba", "de"),
            Some(("Ring of Yoba".to_string(), "Ring von Yoba".to_string()))
        );
        assert!(glossary_term("Message in a Bottle", "Flaschenpost", "de").is_some());
        // Function words do not count toward the word limit.
        assert!(glossary_term("Feast of the Winter Star", "Fest des Wintersterns", "de").is_some());
        // Title Case capitalizes them, which does not make them count.
        assert!(glossary_term("It Howls In The Rain", "Das Geheul im Regen", "de").is_some());
        assert_eq!(
            glossary_term("Big Red Shiny Lucky Hat", "Großer roter Hut", "de"),
            None
        );
        // A leading function word or any other lowercase word is still prose.
        assert_eq!(glossary_term("the Farm", "der Hof", "de"), None);
        assert_eq!(glossary_term("Ring for Yoba", "Ring für Yoba", "de"), None);
    }

    #[test]
    fn word_count_rule_does_not_apply_to_vietnamese() {
        assert_eq!(
            glossary_term("Parsnip", "Củ cải vàng", "vi"),
            Some(("Parsnip".to_string(), "Củ cải vàng".to_string()))
        );
        assert!(glossary_term("Iridium Ore", "Quặng I ri đi", "vi").is_some());
        assert_eq!(glossary_term("Parsnip", "Củ cải vàng", "de"), None);
    }

    #[test]
    fn builds_typed_entries_from_assets_and_excludes_prose() {
        let root = crate::test_support::temp_dir("glossary-build");
        let strings = root.join("Content").join("Strings");
        let xnb = |file: &str, entries: &[(&str, &str)]| {
            write_bytes(&strings.join(file), &test_xnb_dictionary(entries));
        };

        // Objects: an item name (kept) + a description value (rejected: ends `.`).
        xnb(
            "Objects.xnb",
            &[
                ("24", "Parsnip"),
                ("24_desc", "A spring tuber closely related to the carrot."),
            ],
        );
        xnb(
            "Objects.de-DE.xnb",
            &[
                ("24", "Pastinake"),
                (
                    "24_desc",
                    "Eine Frühlingsknolle, eng verwandt mit der Karotte.",
                ),
            ],
        );
        // Weapons: only `_Name` keys are eligible; `_Description` is skipped.
        xnb(
            "Weapons.xnb",
            &[
                ("4_Name", "Galaxy Sword"),
                ("4_Description", "A legendary blade of unknown origin."),
            ],
        );
        xnb(
            "Weapons.de-DE.xnb",
            &[
                ("4_Name", "Galaxieschwert"),
                (
                    "4_Description",
                    "Eine legendäre Klinge unbekannter Herkunft.",
                ),
            ],
        );
        // NPCNames: clean single-word names.
        xnb("NPCNames.xnb", &[("Abigail", "Abigail")]);
        xnb("NPCNames.de-DE.xnb", &[("Abigail", "Abby")]);
        // Locations: only name key groups are kept (room, kill-list monster);
        // menu choices and prose/format values are rejected.
        xnb(
            "Locations.xnb",
            &[
                ("CommunityCenter_AreaName_Pantry", "Pantry"),
                ("AdventureGuild_KillList_Bats", "Bats"),
                ("AnimalShop_Marnie_Animals", "Purchase Animals"),
                ("AnimalShop_Marnie_Leave", "Leave"),
                ("Blacksmith_Clint_Shop", "Shop"),
                ("Beach_Sign", "Welcome to the beach! Watch for {0}."),
            ],
        );
        xnb(
            "Locations.de-DE.xnb",
            &[
                ("CommunityCenter_AreaName_Pantry", "Speisekammer"),
                ("AdventureGuild_KillList_Bats", "Fledermäuse"),
                ("AnimalShop_Marnie_Animals", "Tiere kaufen"),
                ("AnimalShop_Marnie_Leave", "Verlassen"),
                ("Blacksmith_Clint_Shop", "Laden"),
                ("Beach_Sign", "Willkommen am Strand! Achte auf {0}."),
            ],
        );
        // StringsFromCSFiles: only the season keys (stored lowercase in real
        // data, normalized to `Spring`); greeting prose is rejected.
        xnb(
            "StringsFromCSFiles.xnb",
            &[("spring", "spring"), ("Greeting", "Hello there")],
        );
        xnb(
            "StringsFromCSFiles.de-DE.xnb",
            &[("spring", "Frühling"), ("Greeting", "Hallo zusammen")],
        );

        let glossary = build_from_game(&root, "de").unwrap();
        let find = |source: &str| glossary.entries.iter().find(|e| e.source == source);

        assert_eq!(glossary.format, GLOSSARY_FORMAT);
        assert_eq!(glossary.target_lang, "de");
        assert_eq!(glossary.term_count, glossary.entries.len());

        // Kept, with the right kind.
        assert_eq!(find("Parsnip").map(|e| e.kind), Some(TermKind::Item));
        assert_eq!(find("Galaxy Sword").map(|e| e.kind), Some(TermKind::Weapon));
        assert_eq!(find("Abigail").map(|e| e.kind), Some(TermKind::Npc));
        assert_eq!(find("Pantry").map(|e| e.kind), Some(TermKind::Location));
        assert_eq!(find("Bats").map(|e| e.kind), Some(TermKind::Location));
        // Menu choices from Strings/Locations are not names.
        for menu in ["Leave", "Shop", "Purchase Animals"] {
            assert!(find(menu).is_none(), "{menu}");
        }
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
    fn builds_festival_place_building_animal_clothing_monster_and_movie_names() {
        let root = crate::test_support::temp_dir("glossary-name-groups");
        let content = root.join("Content");
        let pair = |file: &str, english: &[(&str, &str)], german: &[(&str, &str)]| {
            write_bytes(
                &content.join(format!("{file}.xnb")),
                &test_xnb_dictionary(english),
            );
            write_bytes(
                &content.join(format!("{file}.de-DE.xnb")),
                &test_xnb_dictionary(german),
            );
        };

        // An item name also listed as a concession stays an item.
        pair(
            "Strings/Objects",
            &[("167", "Joja Cola")],
            &[("167", "Joja-Cola")],
        );
        pair(
            "Data/Festivals/FestivalDates",
            &[("winter25", "Feast of the Winter Star")],
            &[("winter25", "Fest des Wintersterns")],
        );
        // Map labels: the name is the first line; addresses are not names.
        pair(
            "Strings/StringsFromCSFiles",
            &[
                (
                    "MapPage.cs.11065",
                    "Stardrop Saloon^Open 12:00PM to 12:00AM",
                ),
                ("MapPage.cs.11066", "1 Willow Lane"),
                ("Menu.cs.1", "Inventory"),
            ],
            &[
                (
                    "MapPage.cs.11065",
                    "Kneipe zum Sternenfall^Geöffnet 12 bis 24 Uhr",
                ),
                ("MapPage.cs.11066", "Weidenweg 1"),
                ("Menu.cs.1", "Inventar"),
            ],
        );
        pair(
            "Strings/WorldMap",
            &[("CommunityCenter", "Community Center")],
            &[("CommunityCenter", "Gemeinschaftszentrum")],
        );
        // Single-word buildings stay (the official term differs from the
        // everyday word), but not one that is also a common word.
        pair(
            "Strings/Buildings",
            &[("Barn_Name", "Barn"), ("Well_Name", "Well")],
            &[("Barn_Name", "Stall"), ("Well_Name", "Brunnen")],
        );
        pair(
            "Strings/FarmAnimals",
            &[
                ("DisplayType_VoidChicken", "Void Chicken"),
                ("Void_Egg", "Void Egg"),
            ],
            &[
                ("DisplayType_VoidChicken", "Schattenhuhn"),
                ("Void_Egg", "Schattenei"),
            ],
        );
        pair(
            "Data/Boots",
            &[(
                "506",
                "Rubber Boots/Protection from the elements./100/0/1/3/Rubber Boots",
            )],
            &[(
                "506",
                "Rubber Boots/Schutz vor den Elementen./100/0/1/3/Regenstiefel",
            )],
        );
        pair(
            "Data/hats",
            &[("2", "Top Hat/A gentleman's classic./false/true//Top Hat")],
            &[("2", "Top Hat/Ein Klassiker./false/true//Zylinder")],
        );
        // Single-word monsters (like animals, hats, concessions) are ordinary words.
        pair(
            "Data/Monsters",
            &[
                (
                    "Shadow Brute",
                    "125/15/0/0/false/2000/769 .75/2/.01/4/2/.00/true/2/Shadow Brute",
                ),
                ("Bat", "24/5/0/0/true/1000/767 .9/1/.01/4/2/.00/true/1/Bat"),
            ],
            &[
                (
                    "Shadow Brute",
                    "125/15/0/0/false/2000/769 .75/2/.01/4/2/.00/true/2/Schattenbestie",
                ),
                (
                    "Bat",
                    "24/5/0/0/true/1000/767 .9/1/.01/4/2/.00/true/1/Fledermaus",
                ),
            ],
        );
        pair(
            "Strings/Movies",
            &[
                ("BraveSapling_Title", "The Brave Little Sapling"),
                ("BraveSapling_Description", "A Brave Little Tale"),
            ],
            &[
                ("BraveSapling_Title", "Der tapfere kleine Setzling"),
                ("BraveSapling_Description", "Ein tapferes Maerchen"),
            ],
        );
        pair(
            "Strings/MovieConcessions",
            &[
                ("CottonCandy_Name", "Cotton Candy"),
                ("JojaCola_Name", "Joja Cola"),
            ],
            &[
                ("CottonCandy_Name", "Zuckerwatte"),
                ("JojaCola_Name", "Joja-Cola"),
            ],
        );
        pair(
            "Strings/UI",
            &[
                ("Billboard_NightMarket", "Night Market"),
                ("Billboard_NothingPosted", "Nothing Posted"),
            ],
            &[
                ("Billboard_NightMarket", "Nachtmarkt"),
                ("Billboard_NothingPosted", "Nichts ausgehängt"),
            ],
        );
        pair(
            "Strings/1_6_Strings",
            &[
                ("TroutDerby", "Trout Derby"),
                ("TroutDerby_NowOpen", "Trout Derby Now Open"),
                ("SquidFestBooth_Intro", "Welcome to SquidFest"),
            ],
            &[
                ("TroutDerby", "Forellenderby"),
                ("TroutDerby_NowOpen", "Forellenderby eröffnet"),
                ("SquidFestBooth_Intro", "Willkommen beim Tintenfischfest"),
            ],
        );

        let glossary = build_from_game(&root, "de").unwrap();
        let find = |source: &str| {
            glossary
                .entries
                .iter()
                .find(|e| e.source == source)
                .map(|e| (e.target.as_str(), e.kind, e.asset.as_str()))
        };

        for (source, expected) in [
            ("Joja Cola", ("Joja-Cola", TermKind::Item, "Objects")),
            (
                "Feast of the Winter Star",
                (
                    "Fest des Wintersterns",
                    TermKind::Festival,
                    "Data/Festivals/FestivalDates",
                ),
            ),
            (
                "Stardrop Saloon",
                (
                    "Kneipe zum Sternenfall",
                    TermKind::Location,
                    "StringsFromCSFiles",
                ),
            ),
            (
                "Community Center",
                ("Gemeinschaftszentrum", TermKind::Location, "WorldMap"),
            ),
            ("Barn", ("Stall", TermKind::Building, "Buildings")),
            (
                "Void Chicken",
                ("Schattenhuhn", TermKind::Animal, "FarmAnimals"),
            ),
            (
                "Rubber Boots",
                ("Regenstiefel", TermKind::Clothing, "Data/Boots"),
            ),
            ("Top Hat", ("Zylinder", TermKind::Clothing, "Data/hats")),
            (
                "Shadow Brute",
                ("Schattenbestie", TermKind::Monster, "Data/Monsters"),
            ),
            (
                "The Brave Little Sapling",
                ("Der tapfere kleine Setzling", TermKind::Movie, "Movies"),
            ),
            (
                "Cotton Candy",
                ("Zuckerwatte", TermKind::Item, "MovieConcessions"),
            ),
            ("Night Market", ("Nachtmarkt", TermKind::Festival, "UI")),
            (
                "Trout Derby",
                ("Forellenderby", TermKind::Festival, "1_6_Strings"),
            ),
        ] {
            assert_eq!(find(source), Some(expected), "{source}");
        }
        for absent in [
            "Well",
            "Bat",
            "Inventory",
            "1 Willow Lane",
            "Void Egg",
            "A Brave Little Tale",
            "Nothing Posted",
            "Trout Derby Now Open",
            "Welcome to SquidFest",
        ] {
            assert!(find(absent).is_none(), "{absent} must not be a term");
        }

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn missing_game_strings_folder_errors_cleanly() {
        let root = crate::test_support::temp_dir("glossary-missing");
        let err = build_from_game(&root, "de").unwrap_err();
        assert_eq!(err, NO_GAME_STRINGS);
        assert!(!err.contains("StardewXnbHack"));
        // Readable XNB files without any usable name say so plainly.
        write_bytes(
            &root.join("Content/Strings/Objects.xnb"),
            &test_xnb_dictionary(&[("24_desc", "A tuber.")]),
        );
        write_bytes(
            &root.join("Content/Strings/Objects.de-DE.xnb"),
            &test_xnb_dictionary(&[("24_desc", "Eine Knolle.")]),
        );
        let err = build_from_game(&root, "de").unwrap_err();
        assert!(err.starts_with("No official names were found"), "{err}");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn build_from_game_names_the_xnb_problem_in_plain_words() {
        let root = crate::test_support::temp_dir("glossary-game-xnb-broken");
        let strings = root.join("Content").join("Strings");
        let mut lz4 = test_xnb_dictionary(&[("24", "Parsnip")]);
        lz4[5] |= 0x40;
        write_bytes(&strings.join("Objects.xnb"), &lz4);
        write_bytes(
            &strings.join("Objects.de-DE.xnb"),
            &test_xnb_dictionary(&[("24", "Pastinake")]),
        );

        let error = build_from_game(&root, "de").unwrap_err();
        assert_eq!(
            error,
            "The game's text files could not be read (Objects.xnb: LZ4-compressed XNB files are not supported). This language may not be available in this game version, or the game files are damaged. Verify the game files in Steam or GOG, then build the glossary again."
        );

        // A missing translated file is named too, together with the count of
        // further problems (one per asset).
        write_bytes(
            &strings.join("Objects.xnb"),
            &test_xnb_dictionary(&[("24", "Parsnip")]),
        );
        std::fs::remove_file(strings.join("Objects.de-DE.xnb")).unwrap();
        write_bytes(&strings.join("BigCraftables.xnb"), b"broken XNB");
        write_bytes(&strings.join("BigCraftables.de-DE.xnb"), b"broken XNB");
        let error = build_from_game(&root, "de").unwrap_err();
        assert!(
            error.starts_with(
                "The game's text files could not be read (Objects.de-DE.xnb is missing). One more file has a problem too. This language may not be available"
            ),
            "{error}"
        );
        assert!(!error.contains(&root.display().to_string()), "{error}");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn build_from_game_prefers_direct_xnb_strings() {
        let root = crate::test_support::temp_dir("glossary-game-xnb");
        let strings = root.join("Content").join("Strings");
        write_bytes(
            &strings.join("Objects.xnb"),
            &test_xnb_dictionary(&[("24", "Parsnip")]),
        );
        write_bytes(
            &strings.join("Objects.de-DE.xnb"),
            &test_xnb_dictionary(&[("24", "Pastinake")]),
        );

        let glossary = build_from_game(&root, "de").unwrap();

        assert_eq!(glossary.source, GlossarySource::Official);
        assert_eq!(glossary.term_count, 1 + CURATED_DE.len());
        assert_eq!(glossary.entries[0].source, "Parsnip");
        assert_eq!(glossary.entries[0].target, "Pastinake");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn curated_german_names_are_added_to_official_german_builds_only() {
        let root = crate::test_support::temp_dir("glossary-curated");
        let strings = root.join("Content").join("Strings");
        for (file, value) in [
            ("Objects.xnb", "Parsnip"),
            ("Objects.de-DE.xnb", "Pastinake"),
            ("Objects.fr-FR.xnb", "Panais"),
        ] {
            write_bytes(&strings.join(file), &test_xnb_dictionary(&[("24", value)]));
        }
        let curated_of = |glossary: &Glossary| {
            glossary
                .entries
                .iter()
                .filter(|e| e.asset == CURATED_ASSET)
                .map(|e| (e.source.clone(), e.target.clone(), e.kind))
                .collect::<Vec<_>>()
        };

        let german = build_from_game(&root, "de").unwrap();
        let curated = curated_of(&german);
        assert_eq!(curated.len(), CURATED_DE.len());
        assert!(curated.contains(&(
            "Stardew Valley".into(),
            "Sternentautal".into(),
            TermKind::Location
        )));
        assert!(curated.contains(&("Gem Sea".into(), "Edelsteinsee".into(), TermKind::Location)));
        assert_eq!(german.entries[0].source, "Parsnip", "curated come last");
        assert_eq!(german.term_count, german.entries.len());

        let french = build_from_game(&root, "fr").unwrap();
        assert!(curated_of(&french).is_empty());

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn curated_names_skip_packs_and_never_override_asset_entries() {
        let mut entries = vec![GlossaryEntry {
            source: "Gem Sea".to_string(),
            target: "Juwelenmeer".to_string(),
            kind: TermKind::Location,
            asset: "WorldMap".to_string(),
            key: "GemSea".to_string(),
        }];
        add_curated_entries(&mut entries, "de");
        assert_eq!(entries.len(), CURATED_DE.len());
        assert_eq!(entries[0].target, "Juwelenmeer");
        assert_eq!(entries[0].asset, "WorldMap");
        assert_eq!(
            entries.iter().filter(|e| e.source == "Gem Sea").count(),
            1,
            "no duplicate for an asset-defined term"
        );

        let mut other = Vec::new();
        add_curated_entries(&mut other, "fr");
        assert!(other.is_empty());

        // Pack builds never call the hook; check with a German pack file set.
        let root = crate::test_support::temp_dir("glossary-curated-pack");
        let game = root.join("game");
        let pack = root.join("pack");
        write_bytes(
            &game.join("Objects.xnb"),
            &test_xnb_dictionary(&[("24", "Parsnip")]),
        );
        write(&pack.join("Objects.json"), r#"{"24":"Pastinake"}"#);
        let glossary = build_from_pack(
            &game,
            &pack,
            &pack,
            StringAssetFormat::Json,
            "de",
            "Test Pack",
        )
        .unwrap();
        assert!(glossary.entries.iter().all(|e| e.asset != CURATED_ASSET));
        assert_eq!(glossary.entries.len(), 1);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn builds_from_pack_pairing_english_base_with_pack_strings() {
        // A game-unsupported language (Thai) builds from an installed pack
        // whose Strings keys are English-identical. English values come from the
        // game's XNB files; the pack supplies the target side.
        let root = crate::test_support::temp_dir("glossary-pack");
        let english = root.join("Content").join("Strings");
        let pack = root.join("pack").join("Strings");
        write_bytes(
            &english.join("Objects.xnb"),
            &test_xnb_dictionary(&[("24", "Parsnip"), ("78", "Cave Carrot")]),
        );
        write_bytes(
            &english.join("NPCNames.xnb"),
            &test_xnb_dictionary(&[("Abigail", "Abigail")]),
        );
        // Pack: same keys, Thai values — `Cave Carrot` left untranslated.
        write(
            &pack.join("Objects.json"),
            r#"{ "24": "พาร์สนิป", "78": "Cave Carrot" }"#,
        );
        write(&pack.join("NPCNames.json"), r#"{ "Abigail": "อบิเกล" }"#);
        // The newer `Strings` name groups come from the pack as well.
        write_bytes(
            &english.join("Buildings.xnb"),
            &test_xnb_dictionary(&[("Coop_Name", "Coop")]),
        );
        write(&pack.join("Buildings.json"), r#"{ "Coop_Name": "เล้าไก่" }"#);

        let glossary = build_from_pack(
            &english,
            &root.join("pack"),
            &pack,
            StringAssetFormat::Json,
            "th",
            "THAI Pack",
        )
        .unwrap();

        assert_eq!(glossary.target_lang, "th");
        assert_eq!(glossary.source, GlossarySource::CommunityPack);
        assert_eq!(glossary.pack_name.as_deref(), Some("THAI Pack"));
        let find = |source: &str| glossary.entries.iter().find(|e| e.source == source);
        assert_eq!(find("Parsnip").map(|e| e.kind), Some(TermKind::Item));
        assert_eq!(find("Abigail").map(|e| e.kind), Some(TermKind::Npc));
        assert_eq!(find("Coop").map(|e| e.kind), Some(TermKind::Building));
        // The untranslated (English-identical) value is dropped by the gate.
        assert!(find("Cave Carrot").is_none());

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn pack_extraction_rejects_an_external_asset_link() {
        let root = crate::test_support::temp_dir("glossary-external-pack-asset");
        let english = root.join("Content/Strings");
        let pack = root.join("pack");
        write_bytes(
            &english.join("Objects.xnb"),
            &test_xnb_dictionary(&[("24", "Parsnip")]),
        );
        let outside = root.join("outside.json");
        write(&outside, r#"{"24":"Outside Term"}"#);
        std::fs::create_dir_all(pack.join("Strings")).unwrap();
        let link = pack.join("Strings/Objects.json");
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_file(&outside, &link);
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(&outside, &link);
        if let Err(error) = linked {
            #[cfg(windows)]
            if error.kind() == std::io::ErrorKind::PermissionDenied
                || error.raw_os_error() == Some(1314)
            {
                eprintln!("External asset link test requires Windows Developer Mode or symlink privilege: {error}");
                std::fs::remove_dir_all(root).unwrap();
                return;
            }
            panic!("Could not create synthetic asset link: {error}");
        }
        assert!(build_from_pack(
            &english,
            &pack,
            &pack.join("Strings"),
            StringAssetFormat::Json,
            "th",
            "Linked Pack"
        )
        .is_err());
        std::fs::remove_file(link).unwrap();
        write(&pack.join("Strings/Objects.json"), r#"{"24":"Local Term"}"#);
        assert_eq!(
            build_from_pack(
                &english,
                &pack,
                &pack.join("Strings"),
                StringAssetFormat::Json,
                "th",
                "Valid Pack"
            )
            .unwrap()
            .term_count,
            1
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn builds_from_xnb_only_pack_pairing_direct_game_xnb_with_pack_strings() {
        let root = crate::test_support::temp_dir("glossary-pack-xnb");
        let game = root.join("Content").join("Strings");
        let pack = root.join("pack").join("Strings");
        write_bytes(
            &game.join("Objects.xnb"),
            &test_xnb_dictionary(&[("24", "Parsnip"), ("78", "Cave Carrot")]),
        );
        write_bytes(
            &pack.join("Objects_vi.xnb"),
            &test_xnb_dictionary(&[("24", "Cu Cai"), ("78", "Cave Carrot")]),
        );

        let glossary = build_from_pack(
            &game,
            &root.join("pack"),
            &pack,
            StringAssetFormat::Xnb,
            "vi",
            "Vietnamese Pack",
        )
        .unwrap();

        assert_eq!(glossary.source, GlossarySource::CommunityPack);
        assert_eq!(glossary.pack_name.as_deref(), Some("Vietnamese Pack"));
        let find = |source: &str| glossary.entries.iter().find(|e| e.source == source);
        assert_eq!(find("Parsnip").map(|e| e.target.as_str()), Some("Cu Cai"));
        assert!(find("Cave Carrot").is_none());

        std::fs::remove_dir_all(&root).ok();
    }

    fn checked_xnb_entries(strings: &Path) -> Vec<GlossaryEntry> {
        let read = |path: PathBuf| {
            if path.is_file() {
                Some(xnb::read_string_dictionary(&path).unwrap_or_else(|error| {
                    panic!(
                        "Configured XNB dictionary {} must decode: {error}",
                        path.display()
                    )
                }))
            } else {
                None
            }
        };
        let path_of = |file: String| match file.strip_prefix("Data/") {
            Some(file) => strings.parent().unwrap().join("Data").join(file),
            None => strings.join(file),
        };
        build_entries(
            &|asset| read(path_of(format!("{asset}.xnb"))),
            &|asset| read(path_of(format!("{asset}.de-DE.xnb"))),
            "de",
        )
    }

    #[test]
    fn broken_game_xnb_fails_instead_of_using_unpacked_json() {
        let root = crate::test_support::temp_dir("strict-xnb-comparison");
        let strings = root.join("Content/Strings");
        write_bytes(
            &strings.join("Objects.xnb"),
            &test_xnb_dictionary(&[("24", "Parsnip")]),
        );
        write_bytes(
            &strings.join("Objects.de-DE.xnb"),
            &test_xnb_dictionary(&[("24", "Pastinake")]),
        );
        // An old StardewXnbHack export is no longer read.
        write(
            &root.join("Content (unpacked)/Strings/Objects.json"),
            r#"{"24":"Parsnip"}"#,
        );
        write(
            &root.join("Content (unpacked)/Strings/Objects.de-DE.json"),
            r#"{"24":"Pastinake"}"#,
        );
        assert_eq!(checked_xnb_entries(&strings).len(), 1);
        write_bytes(&strings.join("Objects.xnb"), b"broken XNB");
        let error = build_from_game(&root, "de").unwrap_err();
        assert!(error.contains("(Objects.xnb: "), "{error}");
        assert!(std::panic::catch_unwind(|| checked_xnb_entries(&strings)).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn real_direct_xnb_builds_a_glossary_when_available() {
        let Ok(stardew) = std::env::var("SIT_REAL_STARDEW") else {
            eprintln!("glossary: SIT_REAL_STARDEW not set - skipped");
            return;
        };
        let stardew = Path::new(&stardew);
        assert!(
            stardew.is_dir(),
            "Configured Stardew test directory is missing."
        );
        let direct = checked_xnb_entries(&default_game_strings_path(stardew));
        assert!(
            !direct.is_empty(),
            "Configured XNB source produced no terms."
        );
        let built =
            build_from_game(stardew, "de").expect("Configured game Strings must build a glossary.");
        let curated = |entry: &&GlossaryEntry| entry.asset == CURATED_ASSET;
        assert_eq!(
            built.entries.iter().filter(|e| !curated(e)).count(),
            direct.len()
        );
        eprintln!("glossary: direct XNB terms {}", direct.len());

        // Spot checks for the Strings and Data name groups (German 1.6).
        let find = |source: &str| {
            built
                .entries
                .iter()
                .find(|entry| entry.source == source)
                .map(|entry| (entry.target.as_str(), entry.kind))
        };
        for (source, target, kind) in [
            (
                "Feast of the Winter Star",
                "Fest des Wintersterns",
                TermKind::Festival,
            ),
            (
                "Stardew Valley Fair",
                "Sternentautaler Volksfest",
                TermKind::Festival,
            ),
            ("Night Market", "Nachtmarkt", TermKind::Festival),
            ("Desert Festival", "Wüstenfestival", TermKind::Festival),
            ("Trout Derby", "Forellenderby", TermKind::Festival),
            ("SquidFest", "Tintenfischfest", TermKind::Festival),
            ("Pelican Town", "Pelikan", TermKind::Location),
            (
                "Stardrop Saloon",
                "Kneipe zum Sternenfall",
                TermKind::Location,
            ),
            ("Ginger Island", "Ingwerinsel", TermKind::Location),
            ("Pantry", "Speisekammer", TermKind::Location),
            ("Barn", "Stall", TermKind::Building),
            ("Slime Hutch", "Schleim-Stall", TermKind::Building),
            ("Void Chicken", "Schattenhuhn", TermKind::Animal),
            ("Rubber Boots", "Regenstiefel", TermKind::Clothing),
            ("Top Hat", "Zylinder", TermKind::Clothing),
            ("Shadow Brute", "Schattenbestie", TermKind::Monster),
            (
                "It Howls In The Rain",
                "Das Geheul im Regen",
                TermKind::Movie,
            ),
        ] {
            assert_eq!(find(source), Some((target, kind)), "{source}");
        }
        for target in ["Verlassen", "Laden", "Regeln", "Tipp", "Tiere kaufen"] {
            assert!(
                !built.entries.iter().any(|entry| entry.target == target),
                "{target}"
            );
        }
    }

    #[test]
    fn build_from_pack_without_any_translation_errors() {
        let root = crate::test_support::temp_dir("glossary-pack-empty");
        let english = root.join("Content").join("Strings");
        let pack = root.join("pack").join("Strings");
        write_bytes(
            &english.join("Objects.xnb"),
            &test_xnb_dictionary(&[("24", "Parsnip")]),
        );
        // Pack value identical to English → nothing extractable.
        write(&pack.join("Objects.json"), r#"{ "24": "Parsnip" }"#);

        let err = build_from_pack(
            &english,
            &root.join("pack"),
            &pack,
            StringAssetFormat::Json,
            "th",
            "Empty Pack",
        )
        .unwrap_err();
        assert!(err.contains("Empty Pack"));

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn build_from_pack_names_unreadable_game_files_instead_of_the_pack() {
        let root = crate::test_support::temp_dir("glossary-pack-broken-game");
        let english = root.join("Content").join("Strings");
        let pack = root.join("pack").join("Strings");
        let mut lz4 = test_xnb_dictionary(&[("24", "Parsnip")]);
        lz4[5] |= 0x40;
        write_bytes(&english.join("Objects.xnb"), &lz4);
        write(&pack.join("Objects.json"), r#"{ "24": "พาร์สนิป" }"#);

        let err = build_from_pack(
            &english,
            &root.join("pack"),
            &pack,
            StringAssetFormat::Json,
            "th",
            "Thai Pack",
        )
        .unwrap_err();
        assert_eq!(
            err,
            "The game's text files could not be read (Objects.xnb: LZ4-compressed XNB files are not supported). The English names come from these files, so the language pack cannot be used without them. Verify the game files in Steam or GOG, then build the glossary again."
        );

        // No English file at all: the game folder is named, not the pack.
        std::fs::remove_file(english.join("Objects.xnb")).unwrap();
        let err = build_from_pack(
            &english,
            &root.join("pack"),
            &pack,
            StringAssetFormat::Json,
            "th",
            "Thai Pack",
        )
        .unwrap_err();
        assert!(
            err.starts_with("No official names were found in the game's Content/Strings files."),
            "{err}"
        );

        std::fs::remove_dir_all(&root).ok();
    }

    /// A cacheable glossary tagged with a target language.
    fn glossary_for(lang: &str, entries: Vec<GlossaryEntry>) -> Glossary {
        Glossary {
            format: GLOSSARY_FORMAT,
            target_lang: lang.to_string(),
            term_count: entries.len(),
            entries,
            ..Default::default()
        }
    }

    #[test]
    fn save_then_load_roundtrips_per_language_at_the_current_format() {
        let dir = crate::test_support::temp_dir("glossary-cache");
        let glossary = glossary_for("de", vec![entry("Spring", "Frühling", TermKind::Season)]);
        save(&dir, &glossary).unwrap();

        let loaded = load(&dir, "de").unwrap();
        assert_eq!(loaded, glossary);
        assert_eq!(loaded.format, 3);
        // Stored in the per-language subfolder.
        assert!(dir.join("glossary").join("glossary-de.json").is_file());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn caches_are_isolated_by_language() {
        // Building one language must never leak into another:
        // a different supported language and an unsupported one both load `None`.
        let dir = crate::test_support::temp_dir("glossary-isolation");
        save(
            &dir,
            &glossary_for("de", vec![entry("Parsnip", "Pastinake", TermKind::Item)]),
        )
        .unwrap();

        assert!(load(&dir, "de").is_some());
        assert_eq!(load(&dir, "fr"), None);
        assert_eq!(load(&dir, "th"), None);
        assert!(!dir.join("glossary").join("glossary-th.json").exists());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_ignores_old_versioned_per_language_cache() {
        let dir = crate::test_support::temp_dir("glossary-old-cache");
        // A typed cache stamped with a different format is ignored.
        write(
            &dir.join("glossary").join("glossary-de.json"),
            r#"{ "format": 1, "sourceLang": "default", "targetLang": "de", "termCount": 0, "entries": [] }"#,
        );
        assert_eq!(load(&dir, "de"), None);
        assert!(dir.join("glossary").join("glossary-de.json").is_file());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_keeps_a_format_2_cache_and_flags_it_for_a_rebuild() {
        // A cache from before the festival/place/building groups still gives
        // hints; the status only recommends a rebuild to add the new names.
        let dir = crate::test_support::temp_dir("glossary-format-2");
        write(
            &dir.join("glossary").join("glossary-de.json"),
            r#"{ "format": 2, "sourceLang": "default", "targetLang": "de", "termCount": 1,
                 "entries": [ { "source": "Parsnip", "target": "Pastinake", "kind": "item",
                                "asset": "Objects", "key": "24" } ] }"#,
        );
        let loaded = load(&dir, "de").expect("a format-2 cache still loads");
        assert_eq!(loaded.entries[0].kind, TermKind::Item);
        assert!(loaded.format < GLOSSARY_FORMAT);
        assert_eq!(
            match_terms("A Parsnip.", &loaded),
            vec![("Parsnip".to_string(), "Pastinake".to_string())]
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_tolerates_term_kinds_and_formats_from_a_newer_app() {
        // A newer app may add kinds (and bump the format); its cache must not
        // switch the whole glossary off here.
        let dir = crate::test_support::temp_dir("glossary-newer-kinds");
        write(
            &dir.join("glossary").join("glossary-de.json"),
            r#"{ "format": 4, "sourceLang": "default", "targetLang": "de", "termCount": 2,
                 "entries": [
                   { "source": "Parsnip", "target": "Pastinake", "kind": "item",
                     "asset": "Objects", "key": "24" },
                   { "source": "Junimo Kart", "target": "Junimo-Kart", "kind": "arcadeGame",
                     "asset": "Minigames", "key": "JunimoKart" } ] }"#,
        );
        let loaded = load(&dir, "de").expect("unknown kinds do not fail the cache");
        assert!(loaded.format >= GLOSSARY_FORMAT);
        assert_eq!(loaded.entries.len(), 2);
        assert_eq!(loaded.entries[1].kind, TermKind::Unknown);
        let hits = match_terms("Play Junimo Kart with a Parsnip.", &loaded);
        assert_eq!(hits.len(), 2, "{hits:?}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_ignores_a_cache_tagged_for_another_language() {
        let dir = crate::test_support::temp_dir("glossary-wrong-language");
        let french = glossary_for("fr", vec![entry("Spring", "Printemps", TermKind::Season)]);
        write(
            &dir.join("glossary").join("glossary-de.json"),
            &serde_json::to_string(&french).unwrap(),
        );

        assert_eq!(load(&dir, "de"), None);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn migrates_legacy_single_file_into_per_language_subfolder() {
        let dir = crate::test_support::temp_dir("glossary-migrate");
        // A pre-v1.4.0 valid format-2 single cache, directly in the config dir.
        let legacy = glossary_for("de", vec![entry("Spring", "Frühling", TermKind::Season)]);
        write(
            &dir.join("glossary.json"),
            &serde_json::to_string(&legacy).unwrap(),
        );

        migrate_legacy_cache(&dir);

        // Moved into the subfolder; the legacy file is gone; load works.
        assert!(dir.join("glossary").join("glossary-de.json").is_file());
        assert!(!dir.join("glossary.json").is_file());
        assert!(!legacy_cache_present(&dir));
        assert_eq!(load(&dir, "de"), Some(legacy));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn migrates_flat_per_language_files_into_subfolder() {
        let dir = crate::test_support::temp_dir("glossary-migrate-flat");
        // The first v1.4.0 layout: per-language files flat in the config dir.
        let de = glossary_for("de", vec![entry("Parsnip", "Pastinake", TermKind::Item)]);
        write(
            &dir.join("glossary-de.json"),
            &serde_json::to_string(&de).unwrap(),
        );

        migrate_legacy_cache(&dir);

        assert!(dir.join("glossary").join("glossary-de.json").is_file());
        assert!(!dir.join("glossary-de.json").is_file());
        assert_eq!(load(&dir, "de"), Some(de));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn migration_leaves_unparseable_legacy_cache_for_rebuild_flag() {
        let dir = crate::test_support::temp_dir("glossary-migrate-old");
        // An untyped v1 cache (`{ terms: {…} }`) can't migrate — left in place so
        // the UI can recommend a rebuild.
        write(
            &dir.join("glossary.json"),
            r#"{ "sourceLang": "default", "targetLang": "de", "termCount": 1, "terms": { "Spring": "Frühling" } }"#,
        );

        migrate_legacy_cache(&dir);

        assert!(legacy_cache_present(&dir));
        assert_eq!(load(&dir, "de"), None);

        // A rebuild replaces the leftover, so the rebuild note goes away.
        remove_legacy_cache(&dir);
        assert!(!legacy_cache_present(&dir));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn pack_strings_accept_comments_and_trailing_commas() {
        let dir = crate::test_support::temp_dir("glossary-lenient-strings");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("Objects.json");
        std::fs::write(
            &path,
            "{
  // hand-edited pack file
  \"24\": \"Pastinake\",
}
",
        )
        .unwrap();
        let map = read_string_map(&path).expect("relaxed JSON is accepted");
        assert_eq!(map.get("24").map(String::as_str), Some("Pastinake"));
        std::fs::remove_dir_all(&dir).ok();
    }
}
