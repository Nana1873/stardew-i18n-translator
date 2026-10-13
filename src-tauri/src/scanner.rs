//! Recursive mod scanner and lenient SMAPI i18n reader.
//! See SPEC.md, Scanning and Source Changes.
//!
//! Walks the Mods folder, finds every `manifest.json`, reads its metadata, and
//! discovers and reads the translatable `i18n/` units beneath each mod. Mods are
//! grouped by package (top-level Mods subfolder).
//!
//! Edge cases handled: multi-component mods (each manifest SMAPI loads is its
//! own mod; `i18n/` is associated with the nearest ancestor manifest), manifests
//! SMAPI never reaches (reported as information, see `SmapiModFolders`),
//! multiple `i18n/` folders per mod, Content Patcher data under `assets/i18n`
//! (ignored because it is not a SMAPI translation target), malformed manifests
//! (reported as structured skips), `Nexus:-1` sentinel IDs, BOM / `//` + `/* */`
//! comments / trailing commas, missing `UniqueID` (folder-name fallback), and
//! symlink cycles.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

use crate::input_limits;
use crate::lang_pack;
use crate::translations::{self, ModState};

pub(crate) const MAX_DEPTH: usize = 12;
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
    /// Blank source/working-target pairs need no translation, without a saved exemption.
    pub no_translation_needed_keys: usize,
    /// Source keys whose saved status is an unreviewed AI suggestion
    /// (`review-needed`) — feeds the dashboard review queue.
    pub review_needed: usize,
    /// Semantic source hashes used only for the portable previous-scan
    /// comparison. Source text itself is never persisted in the snapshot.
    #[serde(skip)]
    pub(crate) source_hashes: Vec<SourceKeyHash>,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct StatusCounts {
    pub untranslated: usize,
    pub translated: usize,
    pub outdated: usize,
    #[serde(rename = "review-needed")]
    pub review_needed: usize,
}

impl StatusCounts {
    fn record(&mut self, status: &str) {
        match status {
            "translated" => self.translated += 1,
            "outdated" => self.outdated += 1,
            "review-needed" => self.review_needed += 1,
            _ => self.untranslated += 1,
        }
    }

    fn merge(&mut self, other: &Self) {
        self.untranslated += other.untranslated;
        self.translated += other.translated;
        self.outdated += other.outdated;
        self.review_needed += other.review_needed;
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SourceKeyHash {
    pub key: String,
    pub source_hash: String,
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
    pub no_translation_needed_keys: usize,
    /// Unreviewed AI suggestions across all i18n files (dashboard queue).
    pub review_needed: usize,
    /// Current per-status string counts across all i18n files.
    pub status_counts: StatusCounts,
    pub progress: f64,
    /// "none" (no keys) | "untranslated" (some missing) | "translated" (all present).
    pub status: String,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub mods: Vec<ScannedMod>,
    /// Scanner diagnostics that do not themselves represent an omitted
    /// component. Component-specific failures belong in `skipped_components`
    /// so the UI does not have to deduplicate free-form messages.
    pub warnings: Vec<String>,
    /// Components that were deliberately omitted from this scan. Unlike
    /// `warnings`, every entry corresponds to an actual skipped unit and is
    /// safe to count and display in the scan result UI.
    pub skipped_components: Vec<SkippedComponent>,
    pub extra_keys: Vec<ExtraKeyDiagnostic>,
    /// Distinct top-level packages with at least one loaded translatable
    /// component.
    pub mod_count: usize,
    /// Loaded translatable i18n files across every component.
    pub file_count: usize,
    /// English-source changes observed since the preceding complete scan of
    /// this Mods folder. `None` means comparison was unavailable because this
    /// scan omitted a component needing attention or snapshot persistence
    /// failed. A bounded or otherwise incomplete directory traversal also
    /// leaves this unavailable.
    pub source_deltas: Option<ScanDeltas>,
    /// Internal completeness signal for derived scan data and export preflight.
    #[serde(skip)]
    pub(crate) traversal_complete: bool,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScanDeltas {
    pub sources_changed: usize,
    pub strings_added: usize,
    pub strings_removed: usize,
    /// Exact current rows opened by the scan result actions.
    pub added_strings: Vec<ScanStringIdentity>,
    pub changed_sources: Vec<ScanStringIdentity>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub struct ScanStringIdentity {
    pub mod_unique_id: String,
    pub relative_dir: String,
    pub key: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkippedComponent {
    pub package_id: Option<String>,
    pub component_unique_id: Option<String>,
    pub component_name: Option<String>,
    /// Location relative to the configured Mods folder; never an absolute
    /// personal path.
    pub relative_location: String,
    pub reason: String,
    /// False for an intentional, expected exclusion such as an installed
    /// community language pack. The UI keeps those informational and reserves
    /// warning treatment for components that need attention.
    pub requires_attention: bool,
    /// True when another real translation component from this package remains
    /// available in the final scan result.
    pub rest_of_package_loaded: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExtraKeyDiagnostic {
    pub mod_name: String,
    pub relative_dir: String,
    pub target_path: String,
    pub key: String,
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
/// Rejects the `Nexus:-1` sentinel and any non-positive value.
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
    let mut skipped_components = Vec::new();
    let language_root = match translations::language_root(config_dir, target_lang) {
        Ok(root) => Some(root),
        Err(error) => {
            warnings.push(error);
            None
        }
    };
    let mut manifest_files = Vec::new();
    let mut i18n_dirs = Vec::new();
    let traversal_complete = collect(mods_path, &mut manifest_files, &mut i18n_dirs);
    if !traversal_complete {
        warnings.push(
            "Some mod folders could not be read, so new and changed texts can't be counted this time. Fix the listed problems and scan again."
                .to_string(),
        );
    }

    // Build a mod per manifest, keyed by its folder.
    let mut mods: HashMap<PathBuf, ScannedMod> = HashMap::new();
    let mut order: Vec<PathBuf> = Vec::new();
    // SMAPI only loads a manifest.json in a folder it reaches as a mod folder;
    // one it never reaches is information, not a component.
    let mut reach = SmapiModFolders::new(mods_path);
    let mut unloaded_manifest_dirs: HashSet<PathBuf> = HashSet::new();
    let mut manifest_dirs: HashSet<PathBuf> = HashSet::new();
    for manifest in &manifest_files {
        let Some(dir) = manifest.parent() else {
            continue;
        };
        match reach.blocker(dir) {
            None => {
                manifest_dirs.insert(dir.to_path_buf());
            }
            Some(blocker) => {
                unloaded_manifest_dirs.insert(dir.to_path_buf());
                skipped_components.push(SkippedComponent {
                    package_id: None,
                    component_unique_id: None,
                    component_name: None,
                    relative_location: safe_relative_location(manifest, mods_path),
                    reason: blocker.reason(dir, mods_path),
                    requires_attention: false,
                    rest_of_package_loaded: false,
                });
            }
        }
    }

    for manifest in &manifest_files {
        let Some(dir) = manifest.parent() else {
            continue;
        };
        if unloaded_manifest_dirs.contains(dir) {
            continue;
        }
        match read_manifest(manifest, dir, mods_path) {
            Ok(scanned) => {
                order.push(dir.to_path_buf());
                mods.insert(dir.to_path_buf(), scanned);
            }
            Err(reason) => {
                skipped_components.push(SkippedComponent {
                    package_id: package_id_for(dir, mods_path),
                    component_unique_id: None,
                    component_name: None,
                    relative_location: safe_relative_location(manifest, mods_path),
                    reason: safe_skip_reason(&reason, mods_path),
                    requires_attention: true,
                    rest_of_package_loaded: false,
                });
            }
        }
    }

    let unique_ids = mods
        .values()
        .map(|scanned| scanned.unique_id.clone())
        .collect::<Vec<_>>();
    let blocked_state_ids = language_root
        .as_deref()
        .map(|root| {
            let (blocked, state_warnings) = translations::prepare_state_paths(root, &unique_ids);
            warnings.extend(state_warnings);
            blocked
        })
        .unwrap_or_default();

    // Associate each i18n/ folder with the nearest ancestor manifest, merging
    // saved translation state (cached per mod). A corrupted state file becomes
    // a scan warning (counts degrade to the imported values); it is NOT
    // silently treated as empty, and saves elsewhere refuse to overwrite it.
    let mut state_cache: HashMap<String, ModState> = HashMap::new();
    let mut extra_keys = Vec::new();
    // The read boundary for every i18n file, resolved once per scan. If the
    // Mods folder vanished mid-scan, the unresolved path refuses every read.
    let canonical_mods = canonical_root(mods_path).unwrap_or_else(|_| mods_path.to_path_buf());
    for i18n_dir in &i18n_dirs {
        // Covered by the note for the unloaded manifest.json above it. SMAPI
        // still searches below a manifest.json placed directly in Mods.
        if i18n_dir
            .parent()
            .is_some_and(|dir| unloaded_manifest_dirs.contains(dir))
            || i18n_dir
                .ancestors()
                .skip(1)
                .take_while(|dir| *dir != mods_path)
                .any(|dir| unloaded_manifest_dirs.contains(dir))
        {
            continue;
        }
        let Some(owner) = nearest_manifest_owner(i18n_dir, &manifest_dirs) else {
            // SMAPI only loads i18n folders of a mod with a manifest. Report the
            // folder as information so it does not vanish without a trace.
            skipped_components.push(SkippedComponent {
                package_id: None,
                component_unique_id: None,
                component_name: None,
                relative_location: safe_relative_location(i18n_dir, mods_path),
                reason: "No manifest.json in this folder or a parent folder, so SMAPI does not load these translations.".to_string(),
                requires_attention: false,
                rest_of_package_loaded: false,
            });
            continue;
        };
        if is_content_patcher_assets_i18n(&owner, i18n_dir) {
            continue;
        }
        // SMAPI reads only `<mod folder>/i18n` (SCore.ReadTranslationFiles), so
        // an `i18n` folder deeper inside a mod without its own manifest is never
        // loaded. Components with their own manifest (SVE, Ridgeside) are owners
        // themselves and are unaffected.
        if i18n_dir.parent() != Some(owner.as_path()) {
            skipped_components.push(SkippedComponent {
                package_id: None,
                component_unique_id: None,
                component_name: None,
                relative_location: safe_relative_location(i18n_dir, mods_path),
                reason: "SMAPI only loads the i18n folder next to a manifest.json, so these translations are not used.".to_string(),
                requires_attention: false,
                rest_of_package_loaded: false,
            });
            continue;
        }
        if let Some(scanned) = mods.get_mut(&owner) {
            let unique_id = scanned.unique_id.clone();
            if blocked_state_ids.contains(&unique_id.to_lowercase()) {
                skipped_components.push(skipped_i18n_component(
                    scanned,
                    i18n_dir,
                    mods_path,
                    "Your saved translations for this mod could not be loaded, so it was left out."
                        .to_string(),
                ));
                continue;
            }
            let state = match state_cache.entry(unique_id.clone()) {
                std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
                std::collections::hash_map::Entry::Vacant(slot) => {
                    let loaded = language_root
                        .as_deref()
                        .map(|root| translations::load(root, &unique_id))
                        .transpose()
                        .unwrap_or_else(|error| {
                            warnings.push(error);
                            Some(ModState::new())
                        })
                        .unwrap_or_default();
                    slot.insert(loaded)
                }
            };
            let mixed = mixed_i18n_layout(i18n_dir).unwrap_or(false);
            if mixed {
                // Information, not a problem: the top-level files still load.
                skipped_components.push(SkippedComponent {
                    package_id: None,
                    component_unique_id: None,
                    component_name: None,
                    relative_location: safe_relative_location(&i18n_dir.join("default"), mods_path),
                    reason: "The game reads only the translation files directly in the i18n folder, so its language folders, like this one, are not used.".to_string(),
                    requires_attention: false,
                    rest_of_package_loaded: false,
                });
            }
            let split_targets = if mixed {
                Vec::new()
            } else {
                unreadable_split_targets(i18n_dir, target_lang, &canonical_mods)
            };
            for (path, error) in split_targets {
                warnings.push(format!(
                    "{} in {} was ignored because it cannot be read: {}",
                    safe_relative_location(&path, mods_path),
                    scanned.name,
                    safe_skip_reason(&error, mods_path)
                ));
            }
            for unit in
                i18n_units(i18n_dir, &canonical_mods).unwrap_or_else(|error| vec![Err(error)])
            {
                match unit.and_then(|unit| {
                    build_i18n_file(&owner, &unit, &canonical_mods, target_lang, state)
                }) {
                    Ok((file, status_counts, extra_target_keys)) => {
                        if let Some((path, error)) =
                            unreadable_locale_variant(Path::new(&file.target_path), |path| {
                                read_object_within_root(path, &canonical_mods, "target")
                            })
                        {
                            warnings.push(format!(
                                "{} in {} was ignored because it cannot be read: {}",
                                safe_relative_location(&path, mods_path),
                                scanned.name,
                                safe_skip_reason(&error, mods_path)
                            ));
                        }
                        extra_keys.extend(extra_target_keys.into_iter().map(|key| {
                            ExtraKeyDiagnostic {
                                mod_name: scanned.name.clone(),
                                relative_dir: file.relative_dir.clone(),
                                target_path: file.target_path.clone(),
                                key,
                            }
                        }));
                        scanned.status_counts.merge(&status_counts);
                        scanned.i18n_files.push(file);
                    }
                    Err(error) => {
                        skipped_components.push(skipped_i18n_component(
                            scanned,
                            i18n_dir,
                            mods_path,
                            safe_skip_reason(&error, mods_path),
                        ));
                    }
                }
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
        scanned.no_translation_needed_keys = scanned
            .i18n_files
            .iter()
            .map(|file| file.no_translation_needed_keys)
            .sum();
        scanned.review_needed = scanned.i18n_files.iter().map(|f| f.review_needed).sum();
        let completed_work = scanned.translated_keys + scanned.no_translation_needed_keys;
        scanned.progress = progress_of(scanned.total_keys, completed_work);
        scanned.status = derive_status(scanned.total_keys, completed_work).to_string();
    }

    // Exclude community language packs: such a pack ships its own `i18n/`
    // (its config-menu strings, already in the pack's language), so it would
    // otherwise appear here as a bogus translation target. A pack is detected by
    // the same signal the glossary source uses — it registers an in-game language
    // via `Data/AdditionalLanguages`. The content.json parse runs only for the
    // already-filtered mods that have i18n, so the cost stays bounded.
    let mut retained_mods = Vec::with_capacity(result_mods.len());
    for scanned in result_mods {
        if lang_pack::registered_language_codes(Path::new(&scanned.folder_path)).is_empty() {
            retained_mods.push(scanned);
            continue;
        }
        skipped_components.push(SkippedComponent {
            package_id: Some(scanned.package_id.clone()),
            component_unique_id: Some(scanned.unique_id.clone()),
            component_name: Some(scanned.name.clone()),
            relative_location: safe_relative_location(Path::new(&scanned.folder_path), mods_path),
            reason: "This is a language pack, not a mod to translate.".to_string(),
            requires_attention: false,
            rest_of_package_loaded: false,
        });
    }
    result_mods = retained_mods;

    let loaded_packages: HashSet<&str> = result_mods
        .iter()
        .map(|scanned| scanned.package_id.as_str())
        .collect();
    for skipped in &mut skipped_components {
        skipped.rest_of_package_loaded = skipped
            .package_id
            .as_deref()
            .is_some_and(|package_id| loaded_packages.contains(package_id));
    }

    let mod_count = loaded_packages.len();
    let file_count = result_mods.iter().map(|m| m.i18n_files.len()).sum();
    ScanResult {
        mod_count,

        file_count,
        mods: result_mods,
        warnings,
        skipped_components,
        extra_keys,
        source_deltas: None,
        traversal_complete,
    }
}

fn skipped_i18n_component(
    scanned: &ScannedMod,
    i18n_dir: &Path,
    mods_path: &Path,
    reason: String,
) -> SkippedComponent {
    SkippedComponent {
        package_id: Some(scanned.package_id.clone()),
        component_unique_id: Some(scanned.unique_id.clone()),
        component_name: Some(scanned.name.clone()),
        relative_location: safe_relative_location(&i18n_dir.join("default.json"), mods_path),
        reason,
        requires_attention: true,
        rest_of_package_loaded: false,
    }
}

fn safe_relative_location(path: &Path, mods_path: &Path) -> String {
    path.strip_prefix(mods_path)
        .ok()
        .map(|relative| relative.to_string_lossy().replace('\\', "/"))
        .filter(|relative| !relative.is_empty())
        .unwrap_or_else(|| "Unavailable".to_string())
}

pub(crate) fn safe_skip_reason(reason: &str, mods_path: &Path) -> String {
    let mut safe = reason.to_string();
    let mut roots = vec![mods_path.display().to_string()];
    if let Ok(canonical) = std::fs::canonicalize(mods_path) {
        // Canonical Windows paths carry the `\\?\` verbatim prefix. Replace the
        // longest spelling first, otherwise the plain root matches inside the
        // verbatim one and leaves `\\?\Mods\...` behind in the message.
        let canonical = canonical.display().to_string();
        roots.push(canonical.trim_start_matches(r"\\?\").to_string());
        roots.push(canonical);
    }
    roots.sort_by_key(|root| std::cmp::Reverse(root.len()));
    roots.dedup();
    for root in roots {
        if root.is_empty() {
            continue;
        }
        safe = safe.replace(&root, "Mods");
        safe = safe.replace(&root.replace('\\', "/"), "Mods");
    }
    safe
}

fn read_manifest(manifest: &Path, dir: &Path, mods_path: &Path) -> Result<ScannedMod, String> {
    let body = input_limits::read_json_text(manifest).map_err(|error| {
        format!("The manifest.json could not be read ({error}), so this mod was left out.")
    })?;
    let value = parse_json_lenient(&body).map_err(|e| {
        format!("The manifest.json is not valid JSON ({e}), so this mod was left out.")
    })?;
    let object = value
        .as_object()
        .ok_or("The manifest.json does not contain a JSON object, so this mod was left out.")?;

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
        no_translation_needed_keys: 0,
        review_needed: 0,
        status_counts: StatusCounts::default(),
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
    /// untranslated | translated | review-needed | outdated
    pub status: String,
    /// The translator explicitly accepted the current protected-token mismatch.
    pub token_mismatch_accepted: bool,
    /// Section this key belongs to — the nearest standalone `//` comment line
    /// above it in `default.json`. None = no section.
    pub section: Option<String>,
}

impl StringRow {
    pub fn has_translation(&self) -> bool {
        has_translation(&self.source, &self.target, &self.status)
    }
}

fn has_translation(source: &str, target: &str, status: &str) -> bool {
    !target.trim().is_empty()
        || (!source.trim().is_empty() && target == " " && status != "untranslated")
}

/// Load the paired source/target strings of one i18n file, preserving the key
/// order of `default.json` (serde_json `preserve_order`). Saved translation
/// state overrides the imported target and supplies the per-string status.
#[cfg(test)]
pub fn load_strings(
    default_path: &Path,
    target_path: &Path,
    state: &ModState,
    relative_dir: &str,
) -> Vec<StringRow> {
    load_strings_checked(default_path, target_path, state, relative_dir).unwrap_or_default()
}

pub fn load_strings_checked(
    default_path: &Path,
    target_path: &Path,
    state: &ModState,
    relative_dir: &str,
) -> Result<Vec<StringRow>, String> {
    let body = input_limits::read_json_text(default_path)?;
    let source = parse_flat_object(&body, default_path)?;
    let sections = extract_sections(&body);
    let target_map = read_target_object_checked(target_path)?;
    let target = TargetLookup::new(&target_map);
    Ok(source
        .iter()
        .filter(|(key, _)| !is_ignored_i18n_key(key))
        .map(|(key, value)| {
            let source_text = value_to_text(value);
            let (effective_target, status) =
                resolve_string(&source_text, target.get(key), state, relative_dir, key);
            let token_mismatch_accepted = state
                .get(&translations::entry_key(relative_dir, key))
                .is_some_and(|stored| {
                    matches!(
                        translations::base_status(&stored.status),
                        translations::TOKEN_MISMATCH_ACCEPTED_STATUS
                            | translations::REVIEW_NEEDED_TOKEN_MISMATCH_ACCEPTED_STATUS
                    ) && stored.source_hash == translations::source_hash(&source_text)
                });
            StringRow {
                key: key.clone(),
                source: source_text,
                target: effective_target,
                status,
                token_mismatch_accepted,
                section: sections.get(&folded_key(key)).cloned(),
            }
        })
        .collect())
}

/// Baseline state entries for imported translations not yet tracked in `state`.
///
/// A pre-existing `<lang>.json` value the user never saved (a community
/// translation discovered on disk) carries no stored source hash, so it can
/// never be detected as `outdated` when the mod's English source later changes.
/// Adopting it the first time the mod is opened — recording it as `translated`
/// with a hash of the *current* source — gives it that baseline. Returns the
/// `(entry_key, entry)` pairs to persist; empty when there is nothing new to
/// adopt, so the caller can skip the write entirely.
pub fn imported_baselines(
    rows: &[StringRow],
    state: &ModState,
    relative_dir: &str,
) -> Vec<(String, translations::StoredString)> {
    rows.iter()
        // Only imported translations with no saved state, including a single
        // space that deliberately suppresses visible text.
        .filter(|row| row.has_translation())
        .filter(|row| !state.contains_key(&translations::entry_key(relative_dir, &row.key)))
        .map(|row| {
            (
                translations::entry_key(relative_dir, &row.key),
                translations::StoredString {
                    target: row.target.clone(),
                    status: translations::status_for_save(&row.source, &row.target, "translated"),
                    source_hash: translations::source_hash(&row.source),
                },
            )
        })
        .collect()
}

/// Section titles from standalone `//` comment lines in `default.json`.
/// A comment line on its own starts a section, and every key after
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
                if standalone && !is_note_or_disabled_line(&comment) {
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

/// A standalone comment that is not a section title: a commented-out entry
/// (`//"OldGreeting": "Hi",`, a quoted key followed by `:`) or a working note
/// whose marker stands alone or before a colon (`// TODO`, `// NOTE: …`).
/// Headings such as `// "Festival" lines` or `// Note on festivals` stay
/// sections. The current section continues past a skipped line.
fn is_note_or_disabled_line(comment: &str) -> bool {
    let text = comment.trim();
    if let Some(rest) = text.strip_prefix('"') {
        if let Some(end) = rest.find('"') {
            if rest[end + 1..].trim_start().starts_with(':') {
                return true;
            }
        }
    }
    ["TODO", "FIXME", "XXX", "NOTE"].iter().any(|marker| {
        text.get(..marker.len())
            .is_some_and(|start| start.eq_ignore_ascii_case(marker))
            && matches!(text[marker.len()..].chars().next(), None | Some(':'))
    })
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
        // Legacy `not-translatable` status: kept-English is
        // now an explicit identical translation ("Keep original"). An empty
        // stored target takes the *current* source text — that pair can't be
        // stale, so it skips the outdated check below.
        // Preserve legacy Keep original except where its baseline proves the
        // original was exactly empty: a new source is then new translation work.
        if stored.status == "not-translatable"
            && stored.target.trim().is_empty()
            && stored.source_hash != translations::source_hash("")
        {
            return (source_text.to_string(), "translated".to_string());
        }
        // Empty work is derived from the current source, never a permanent Done
        // exemption. A later nonempty source reopens even an old saved Done row.
        let intentional_blank = !source_text.trim().is_empty()
            && stored.target == " "
            && translations::base_status(&stored.status) != stored.status;
        if stored.target.trim().is_empty() && !intentional_blank {
            let status = if source_text.trim().is_empty() {
                "translated"
            } else {
                "untranslated"
            };
            return (stored.target.clone(), status.to_string());
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
    let status = if !has_translation(source_text, &imported_text, "translated")
        && !source_text.trim().is_empty()
    {
        "untranslated"
    } else {
        "translated"
    };
    (imported_text, status.to_string())
}

/// Map any stored status (including legacy values) to the recognized set:
/// `untranslated` | `translated` | `review-needed`. (`outdated` is derived
/// from the source hash, never stored.) `review-needed` is an AI suggestion
/// awaiting review; legacy `done`/`imported`/`not-translatable` values collapse
/// to `translated` — kept-English is an explicit identical translation
/// (resolve_string fills an empty legacy target with the source).
fn normalize_status(stored: &str) -> String {
    match translations::base_status(stored) {
        "untranslated" => "untranslated",
        "review-needed" | translations::REVIEW_NEEDED_TOKEN_MISMATCH_ACCEPTED_STATUS => {
            "review-needed"
        }
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
}

pub(crate) fn read_object_checked(path: &Path) -> Result<serde_json::Map<String, Value>, String> {
    let body = input_limits::read_json_text(path)?;
    parse_flat_object(&body, path)
}

pub(crate) fn parse_flat_object(
    text: &str,
    path: &Path,
) -> Result<serde_json::Map<String, Value>, String> {
    let value = parse_json_lenient(text)
        .map_err(|error| format!("Invalid JSON in {}: {error}", path.display()))?;
    let object = value
        .as_object()
        .ok_or_else(|| format!("{} must contain one flat JSON object.", path.display()))?;
    if let Some((key, _)) = object
        .iter()
        .find(|(key, value)| key.as_str() != "$schema" && !value.is_string())
    {
        return Err(format!(
            "{} contains a non-string value for key {key:?}; i18n files must be flat string objects.",
            path.display()
        ));
    }
    Ok(object.clone())
}

/// Read an existing translation file. Unlike a source, a target may hold
/// numbers or booleans (SMAPI reads them as text) and values the game cannot
/// use, such as `null`, lists, or objects; those keys count as untranslated
/// instead of hiding the whole component and its English source.
pub(crate) fn read_target_file(path: &Path) -> Result<serde_json::Map<String, Value>, String> {
    let body = input_limits::read_json_text(path)?;
    let value = parse_json_lenient(&body)
        .map_err(|error| format!("Invalid JSON in {}: {error}", path.display()))?;
    let Value::Object(object) = value else {
        return Err(format!(
            "{} must contain one flat JSON object.",
            path.display()
        ));
    };
    Ok(object
        .into_iter()
        .filter_map(|(key, value)| match value {
            Value::String(_) => Some((key, value)),
            Value::Number(number) => Some((key, Value::String(number.to_string()))),
            Value::Bool(flag) => Some((key, Value::String(flag.to_string()))),
            _ => None,
        })
        .collect())
}

/// Read the canonical target file merged with SMAPI's regional file
/// (`de-DE.json`, `pt-BR.json`, ...). SMAPI reads both and the regional value wins
/// per key, so keys that only the canonical file has stay translated. The
/// scanned path remains `de.json`/`pt.json`/...: exports write that file and remove
/// the regional one, whose values they already contain.
pub(crate) fn read_target_object_checked(
    target_path: &Path,
) -> Result<serde_json::Map<String, Value>, String> {
    read_merged_target(target_path, read_target_file)
}

/// The canonical target with the regional variant laid over it per key.
/// SMAPI skips a locale file it cannot read and logs it, so one broken file of
/// the pair is skipped whichever it is (the scan names it, see
/// [`unreadable_locale_variant`]); reading only fails when no readable file
/// is left.
fn read_merged_target(
    target_path: &Path,
    read: impl Fn(&Path) -> Result<serde_json::Map<String, Value>, String>,
) -> Result<serde_json::Map<String, Value>, String> {
    let regional = regional_target_variant(target_path).filter(|path| path.is_file());
    let canonical = target_path.is_file().then(|| read(target_path));
    let (canonical, regional) = match (canonical, regional.map(|path| read(&path))) {
        (None, None) => return Ok(serde_json::Map::new()),
        (Some(only), None) | (None, Some(only)) => return only,
        (Some(Err(error)), Some(Err(_))) => return Err(error),
        (Some(canonical), Some(regional)) => (canonical, regional),
    };
    let skip_broken = |read: Result<serde_json::Map<String, Value>, String>| {
        read.unwrap_or_else(|error| {
            log::warn!("{error}; using the other translation file only");
            serde_json::Map::new()
        })
    };
    let mut merged = skip_broken(canonical);
    let regional = skip_broken(regional);
    // Keys match case-insensitively in SMAPI, so a regional key replaces the
    // canonical one even when only its casing differs.
    let regional_keys: std::collections::HashSet<String> =
        regional.keys().map(|key| key.to_lowercase()).collect();
    merged.retain(|key, _| !regional_keys.contains(&key.to_lowercase()));
    merged.extend(regional);
    Ok(merged)
}

pub(crate) fn target_read_path(target_path: &Path) -> PathBuf {
    if let Some(fallback) = regional_target_variant(target_path) {
        if fallback.is_file() {
            return fallback;
        }
    }
    target_path.to_path_buf()
}

/// The regional locale file SMAPI also reads for a target language: the game
/// locale is regional for every language (`de-DE`, `es-ES`, `pt-BR`, ...), so
/// `de-DE.json` is looked up before `de.json`. Only the target's own game locale
/// counts; `en-GB.json` or `de-AT.json` are not aliases.
///
/// In a split layout the folder name is the locale, so `i18n/de/Dialogue.json`
/// pairs with the same document in `i18n/de-DE/`, which SMAPI also prefers per
/// key. Document names inside a locale folder are never aliases themselves
/// (`i18n/de/de.json` has no `i18n/de/de-DE.json` variant).
pub(crate) fn regional_target_variant(path: &Path) -> Option<PathBuf> {
    let is_i18n = |dir: &Path| {
        dir.file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case("i18n"))
    };
    let parent = path.parent()?;
    let name = path.file_name()?.to_str()?;
    if is_i18n(parent) {
        let code = name.get(..name.len().checked_sub(".json".len())?)?;
        if !name[code.len()..].eq_ignore_ascii_case(".json") {
            return None;
        }
        let locale = crate::glossary::game_locale_suffix(&code.to_ascii_lowercase())?;
        return Some(path.with_file_name(format!("{locale}.json")));
    }
    let i18n = parent.parent().filter(|dir| is_i18n(dir))?;
    let code = parent.file_name()?.to_str()?;
    let locale = crate::glossary::game_locale_suffix(&code.to_ascii_lowercase())?;
    Some(i18n.join(locale).join(name))
}

/// The one broken file of a canonical/regional pair that reading skips, with
/// its error, so the scan can name it. `None` when both read, when only one
/// file exists (its error stops the read instead), or when both are broken.
fn unreadable_locale_variant(
    target_path: &Path,
    read: impl Fn(&Path) -> Result<serde_json::Map<String, Value>, String>,
) -> Option<(PathBuf, String)> {
    let regional = regional_target_variant(target_path).filter(|path| path.is_file())?;
    if !target_path.is_file() {
        return None;
    }
    match (read(target_path), read(&regional)) {
        (Err(error), Ok(_)) => Some((target_path.to_path_buf(), error)),
        (Ok(_), Err(error)) => Some((regional, error)),
        _ => None,
    }
}

/// (total source keys, source keys with a non-empty **working** target — saved
/// state takes precedence over the imported `<lang>.json` value — and source
/// keys whose stored status is an unreviewed AI suggestion). The review count
/// feeds the dashboard's cross-mod review queue.
#[cfg(test)]
fn count_keys(
    default_path: &Path,
    target_path: &Path,
    state: &ModState,
    relative_dir: &str,
) -> (usize, usize, usize) {
    inspect_keys_checked(default_path, target_path, None, state, relative_dir)
        .map(|inspection| {
            (
                inspection.total,
                inspection.translated,
                inspection.status_counts.review_needed,
            )
        })
        .unwrap_or((0, 0, 0))
}

struct KeyInspection {
    total: usize,
    translated: usize,

    no_translation_needed: usize,

    status_counts: StatusCounts,
    source_hashes: Vec<SourceKeyHash>,
    /// Target keys that `default.json` no longer has (informational).
    extra_target_keys: Vec<String>,
}

fn inspect_keys_checked(
    default_path: &Path,
    target_path: &Path,
    allowed_root: Option<&Path>,
    state: &ModState,
    relative_dir: &str,
) -> Result<KeyInspection, String> {
    let source = match allowed_root {
        Some(root) => read_object_within_root(default_path, root, "source")?,
        None => read_object_checked(default_path)?,
    };
    let target_map = match allowed_root {
        Some(root) => read_target_object_within_root(target_path, root)?,
        None => read_target_object_checked(target_path)?,
    };
    let target = TargetLookup::new(&target_map);
    let total = source
        .keys()
        .filter(|key| !is_ignored_i18n_key(key))
        .count();
    let mut translated = 0;
    let mut no_translation_needed = 0;
    let mut status_counts = StatusCounts::default();
    for (key, value) in source.iter().filter(|(key, _)| !is_ignored_i18n_key(key)) {
        let source_text = value.as_str().unwrap_or_default();
        let (working_target, status) =
            resolve_string(source_text, target.get(key), state, relative_dir, key);
        if has_translation(source_text, &working_target, &status) {
            translated += 1;
        } else if source_text.trim().is_empty() {
            no_translation_needed += 1;
        }
        status_counts.record(&status);
    }
    let source_hashes = source
        .iter()
        .filter(|(key, _)| !is_ignored_i18n_key(key))
        .map(|(key, value)| SourceKeyHash {
            key: key.clone(),
            source_hash: translations::source_hash(value.as_str().unwrap_or_default()),
        })
        .collect();
    let source_folded: HashSet<String> = source.keys().map(|key| folded_key(key)).collect();
    let extra_target_keys = target_map
        .keys()
        .filter(|key| !is_ignored_i18n_key(key))
        .filter(|key| !source_folded.contains(&folded_key(key)))
        .cloned()
        .collect();
    Ok(KeyInspection {
        total,
        translated,

        no_translation_needed,

        status_counts,
        source_hashes,
        extra_target_keys,
    })
}

fn read_target_object_within_root(
    target_path: &Path,
    allowed_root: &Path,
) -> Result<serde_json::Map<String, Value>, String> {
    read_merged_target(target_path, |path| {
        read_object_within_root(path, allowed_root, "target")
    })
}

/// Canonicalize a read boundary once, so per-file reads below it only resolve
/// the file itself.
fn canonical_root(allowed_root: &Path) -> Result<PathBuf, String> {
    std::fs::canonicalize(allowed_root).map_err(|error| {
        let name = allowed_root
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        format!(
            "Could not open the folder \"{name}\" ({}). Check that it exists and is not locked by another program, then scan again.",
            plain_io_error(&error)
        )
    })
}

/// Read `path` if it resolves inside `canonical_root`, which must already be
/// canonical (see [`canonical_root`]); a non-canonical root refuses every read.
fn read_object_within_root(
    path: &Path,
    canonical_root: &Path,
    kind: &str,
) -> Result<serde_json::Map<String, Value>, String> {
    let canonical_read = std::fs::canonicalize(path)
        .map_err(|error| format!("Could not validate {kind} file {}: {error}", path.display()))?;
    if !canonical_read.starts_with(canonical_root) {
        return Err(format!(
            "{kind} file resolves outside the configured Mods folder: {}",
            path.display()
        ));
    }

    // Read the resolved file rather than following the original path again;
    // this narrows the swap window for a link between validation and opening.
    if kind == "target" {
        read_target_file(&canonical_read)
    } else {
        read_object_checked(&canonical_read)
    }
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

/// File extensions SMAPI's mod scanner ignores (`ModScanner.IgnoreFileExtensions`,
/// SMAPI 4.5.2 Toolkit), compared like .NET `FileInfo.Extension`.
const SMAPI_IGNORED_EXTENSIONS: &[&str] = &[
    ".doc", ".docx", ".md", ".rtf", ".txt", ".bmp", ".gif", ".ico", ".jpeg", ".jpg", ".png",
    ".psd", ".tif", ".xcf", ".rar", ".zip", ".7z", ".tar", ".tar.gz", ".backup", ".bak", ".old",
    ".url", ".lnk",
];

/// Names SMAPI's mod scanner ignores (`ModScanner.IgnoreFilesystemNames`).
fn smapi_ignored_name(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name.starts_with("._")
        || matches!(
            name.as_str(),
            "__folder_managed_by_vortex"
                | ".ds_store"
                | "__macosx"
                | "mcs"
                | "desktop.ini"
                | "thumbs.db"
        )
}

/// SMAPI's `ModScanner.IsRelevant` for a file.
fn smapi_relevant_file(name: &str) -> bool {
    let extension = name
        .rfind('.')
        .map(|index| name[index..].to_ascii_lowercase())
        .unwrap_or_default();
    !name.starts_with('.')
        && !SMAPI_IGNORED_EXTENSIONS.contains(&extension.as_str())
        && !smapi_ignored_name(name)
}

/// Files Mod Organizer 2 keeps in its own `mods` folder but never shows the
/// game: each mod's `meta.ini` and files it hid with `.mohidden`. When the
/// Mods folder is MO2's `mods` folder, SMAPI sees each mod's contents without
/// them, so they must not stop the search like a mod's own file would.
fn mo2_only_file(name: &str, top_level: bool) -> bool {
    let name = name.to_ascii_lowercase();
    name.ends_with(".mohidden") || (top_level && name == "meta.ini")
}

/// SMAPI's `ModScanner.IsRelevant` for a folder, plus its dot-folder skip.
fn smapi_relevant_folder(name: &str) -> bool {
    !name.starts_with('.') && !smapi_ignored_name(name)
}

/// Why SMAPI never reads a folder as a mod folder.
enum Unloaded {
    /// The Mods folder itself, which SMAPI only searches.
    ModsRoot,
    /// SMAPI reads this folder above it as a mod folder and stops there.
    InsideFolder { folder: PathBuf, has_manifest: bool },
    /// SMAPI skips this folder (or one above it) by name.
    IgnoredFolder(PathBuf),
}

impl Unloaded {
    fn reason(&self, dir: &Path, mods_path: &Path) -> String {
        let shown = |path: &Path| format!("Mods/{}", safe_relative_location(path, mods_path));
        match self {
            Self::ModsRoot => "The game only loads mods from folders inside the Mods folder, not a manifest.json placed directly in it.".to_string(),
            Self::InsideFolder { has_manifest: true, .. } => "This manifest.json is inside another mod's folder, so SMAPI doesn't load it as a separate mod. The outer mod may still use it.".to_string(),
            Self::InsideFolder { folder, has_manifest: false } => format!(
                "{} has a manifest.json, but the game doesn't load it because {} already contains other files.",
                shown(dir),
                shown(folder)
            ),
            Self::IgnoredFolder(folder) => format!(
                "{} has a manifest.json, but the game doesn't load it because it skips folders named {}.",
                shown(dir),
                folder.file_name().unwrap_or_default().to_string_lossy()
            ),
        }
    }
}

/// Which folders SMAPI reads as mod folders, mirroring `ModScanner.GetModFolders`
/// (decompiled SMAPI 4.5.2 Toolkit): starting at the Mods folder, SMAPI only
/// descends into a folder that has relevant subfolders and no relevant files;
/// any other folder it reaches is read as one mod folder and nothing inside is
/// searched further.
pub(crate) struct SmapiModFolders<'a> {
    root: &'a Path,
    /// Per folder: `None` when it has no relevant files, else whether one of
    /// them is a manifest.json.
    relevant_files: HashMap<PathBuf, Option<bool>>,
}

impl<'a> SmapiModFolders<'a> {
    pub(crate) fn new(root: &'a Path) -> Self {
        Self {
            root,
            relevant_files: HashMap::new(),
        }
    }

    /// Whether SMAPI reads `dir` (a folder below the Mods folder) as a mod folder.
    pub(crate) fn loads(&mut self, dir: &Path) -> bool {
        self.blocker(dir).is_none()
    }

    fn blocker(&mut self, dir: &Path) -> Option<Unloaded> {
        // Paths outside the walked root cannot be judged; keep them.
        let relative = dir.strip_prefix(self.root).ok()?;
        let names: Vec<_> = relative
            .components()
            .filter_map(|component| match component {
                std::path::Component::Normal(name) => Some(name),
                _ => None,
            })
            .collect();
        if names.is_empty() {
            return Some(Unloaded::ModsRoot);
        }
        let mut current = self.root.to_path_buf();
        for (index, name) in names.iter().enumerate() {
            current.push(name);
            if !smapi_relevant_folder(&name.to_string_lossy()) {
                return Some(Unloaded::IgnoredFolder(current));
            }
            if index + 1 == names.len() {
                return None;
            }
            if let Some(has_manifest) = self.relevant_files_in(&current) {
                return Some(Unloaded::InsideFolder {
                    folder: current,
                    has_manifest,
                });
            }
        }
        None
    }

    fn relevant_files_in(&mut self, folder: &Path) -> Option<bool> {
        if let Some(cached) = self.relevant_files.get(folder) {
            return *cached;
        }
        // An unreadable folder counts as searchable, so its components stay
        // offered; the walk already reports the read problem.
        let top_level = folder.parent() == Some(self.root);
        let mut found: Option<bool> = None;
        for entry in std::fs::read_dir(folder).into_iter().flatten().flatten() {
            let is_file = entry.file_type().is_ok_and(|file_type| {
                file_type.is_file()
                    || (file_type.is_symlink()
                        && std::fs::metadata(entry.path()).is_ok_and(|meta| meta.is_file()))
            });
            let name = entry.file_name().to_string_lossy().into_owned();
            if is_file && smapi_relevant_file(&name) && !mo2_only_file(&name, top_level) {
                let is_manifest = name.eq_ignore_ascii_case("manifest.json");
                found = Some(found.unwrap_or(false) || is_manifest);
            }
        }
        self.relevant_files.insert(folder.to_path_buf(), found);
        found
    }
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

fn is_content_patcher_assets_i18n(mod_dir: &Path, i18n_dir: &Path) -> bool {
    i18n_dir
        .strip_prefix(mod_dir)
        .ok()
        .and_then(Path::to_str)
        .is_some_and(|relative| {
            relative
                .replace('\\', "/")
                .eq_ignore_ascii_case("assets/i18n")
        })
}

/// An I/O error in plain words, without the `(os error N)` suffix.
pub(crate) fn plain_io_error(error: &std::io::Error) -> String {
    match error.kind() {
        std::io::ErrorKind::NotFound => "it no longer exists".to_string(),
        std::io::ErrorKind::PermissionDenied => "Windows denied access".to_string(),
        _ => {
            let text = error.to_string();
            match text.rfind(" (os error ") {
                Some(index) if text.ends_with(')') => {
                    text[..index].trim_end_matches('.').to_string()
                }
                _ => text,
            }
        }
    }
}

/// A translation folder that cannot be listed, named by its last two parts
/// (`i18n/de`) so the message never carries the user's folder layout.
fn unreadable_folder(dir: &Path, error: &std::io::Error) -> String {
    let parts: Vec<_> = dir.components().rev().take(2).collect();
    let shown: PathBuf = parts.into_iter().rev().collect();
    format!(
        "Could not read the folder {} ({}). Check that it exists and is not locked by another program, then scan again.",
        shown.display().to_string().replace('\\', "/"),
        plain_io_error(error)
    )
}

/// Folded keys of every source document beside `source` (all split segments).
fn split_source_keys(source: &Path, canonical_root: &Path) -> Result<HashSet<String>, String> {
    let mut known = HashSet::new();
    let sources = source.parent().ok_or("Invalid split source")?;
    for entry in std::fs::read_dir(sources).map_err(|e| unreadable_folder(sources, &e))? {
        let path = entry.map_err(|e| unreadable_folder(sources, &e))?.path();
        if !path
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("json"))
        {
            continue;
        }
        known.extend(
            read_object_within_root(&path, canonical_root, "source")?
                .keys()
                .filter(|key| !is_ignored_i18n_key(key))
                .map(|key| folded_key(key)),
        );
    }
    Ok(known)
}

pub(crate) fn split_target_path(source: &Path, language: &str) -> Result<PathBuf, String> {
    let root = source
        .parent()
        .and_then(Path::parent)
        .ok_or("Invalid split source")?;
    let target = root.join(language);
    let canonical = canonical_root(root)?;
    let keys: HashSet<_> = read_object_checked(source)?
        .keys()
        .filter(|key| !is_ignored_i18n_key(key))
        .map(|k| folded_key(k))
        .collect();
    let mut matches = Vec::new();
    let mut all_source_keys = None;
    let mut broken_same_name = false;
    if target.is_dir() {
        for entry in std::fs::read_dir(&target).map_err(|e| unreadable_folder(&target, &e))? {
            let path = entry.map_err(|e| unreadable_folder(&target, &e))?.path();
            if !path
                .extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("json"))
            {
                continue;
            }
            let same_name = path.file_name().is_some_and(|name| {
                source
                    .file_name()
                    .is_some_and(|own| own.eq_ignore_ascii_case(name))
            });
            let values = match read_object_within_root(&path, &canonical, "target") {
                Ok(values) => values,
                // SMAPI skips a locale document it cannot parse (per-file
                // try/continue in SCore.ReadTranslationFiles), so one broken
                // file only blocks the source document it would be written to;
                // the scan reports it once (see `unreadable_split_targets`).
                Err(_) if !same_name => continue,
                // The same document in the regional folder (`de-DE/`) still
                // applies, so the broken one is skipped like a broken flat
                // `de.json` beside `de-DE.json`; the scan names it.
                Err(_)
                    if regional_target_variant(&path).is_some_and(|regional| {
                        regional.is_file()
                            && read_object_within_root(&regional, &canonical, "target").is_ok()
                    }) =>
                {
                    broken_same_name = true;
                    continue;
                }
                Err(error) => return Err(error),
            };
            let existing: Vec<_> = values
                .keys()
                .filter(|k| !is_ignored_i18n_key(k))
                .map(|k| folded_key(k))
                .collect();
            if existing.iter().any(|k| keys.contains(k)) {
                if existing.iter().any(|k| !keys.contains(k)) {
                    // Removed keys have no current source owner and remain
                    // informational orphans. Only keys owned by another source
                    // document make this target ambiguous.
                    let known_keys = match all_source_keys {
                        Some(ref known) => known,
                        None => all_source_keys.insert(split_source_keys(source, &canonical)?),
                    };
                    if existing
                        .iter()
                        .any(|key| !keys.contains(key) && known_keys.contains(key))
                    {
                        return Err("Existing locale document combines multiple source segments; automatic export is ambiguous.".into());
                    }
                }
                matches.push(path);
            }
        }
    }
    match matches.len() {
        0 => {
            let path = target.join(source.file_name().ok_or("Invalid split source")?);
            if path.exists() && !broken_same_name {
                // A same-named document without shared keys is a stub (`{}`) or
                // holds only keys the source no longer has. It belongs to this
                // segment unless it carries keys another source document owns.
                let other_source_keys = split_source_keys(source, &canonical)?;
                let owned_elsewhere = read_object_within_root(&path, &canonical, "target")?
                    .keys()
                    .filter(|key| !is_ignored_i18n_key(key))
                    .map(|key| folded_key(key))
                    .any(|key| !keys.contains(&key) && other_source_keys.contains(&key));
                if owned_elsewhere {
                    return Err("Target filename is occupied by a different source segment.".into());
                }
            }
            Ok(path)
        }
        1 => Ok(matches.remove(0)),
        _ => Err("Existing locale keys are spread across multiple documents; automatic export is ambiguous.".into()),
    }
}

/// Locale documents in a split `i18n/<lang>/` folder that cannot be read and
/// share no name with a source document. They are ignored for export, so
/// they are reported once per scan instead of once per source document.
fn unreadable_split_targets(
    i18n_dir: &Path,
    target_lang: &str,
    root: &Path,
) -> Vec<(PathBuf, String)> {
    let sources = i18n_dir.join("default");
    let target = i18n_dir.join(target_lang);
    if !sources.is_dir() || !target.is_dir() {
        return Vec::new();
    }
    let Ok(entries) = std::fs::read_dir(&target) else {
        return Vec::new();
    };
    let mut broken: Vec<_> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("json"))
        })
        .filter(|path| {
            !path.file_name().is_some_and(|name| {
                std::fs::read_dir(&sources).is_ok_and(|mut sources| {
                    sources.any(|source| {
                        source.is_ok_and(|source| source.file_name().eq_ignore_ascii_case(name))
                    })
                })
            })
        })
        .filter_map(|path| {
            read_object_within_root(&path, root, "target")
                .err()
                .map(|error| (path, error))
        })
        .collect();
    broken.sort();
    broken
}

/// Whether an `i18n` folder has both top-level locale files and a `default/`
/// language folder. SMAPI then logs an error and reads only the top-level
/// files, ignoring every language folder.
fn mixed_i18n_layout(dir: &Path) -> Result<bool, String> {
    if !dir.join("default").is_dir() {
        return Ok(false);
    }
    Ok(std::fs::read_dir(dir)
        .map_err(|e| unreadable_folder(dir, &e))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| unreadable_folder(dir, &e))?
        .into_iter()
        .any(|e| {
            let path = e.path();
            path.is_file()
                && path
                    .extension()
                    .is_some_and(|v| v.eq_ignore_ascii_case("json"))
        }))
}

/// SMAPI merges immediate locale-directory JSON files into one namespace.
/// Reject duplicate source keys instead of inventing a filesystem-order winner.
fn i18n_units(dir: &Path, root: &Path) -> Result<Vec<Result<PathBuf, String>>, String> {
    let split = dir.join("default");
    if mixed_i18n_layout(dir)? {
        // Like SMAPI, use the top-level files only. Without a top-level
        // default.json there is no English source the game reads.
        return Ok(if dir.join("default.json").is_file() {
            vec![Ok(dir.to_path_buf())]
        } else {
            Vec::new()
        });
    }
    if !split.is_dir() {
        return Ok(vec![Ok(dir.to_path_buf())]);
    }
    let mut files: Vec<_> = std::fs::read_dir(&split)
        .map_err(|e| unreadable_folder(&split, &e))?
        .map(|entry| {
            entry
                .map(|e| e.path())
                .map_err(|e| unreadable_folder(&split, &e))
        })
        .collect::<Result<_, _>>()?;
    files.retain(|p| {
        p.extension()
            .is_some_and(|v| v.eq_ignore_ascii_case("json"))
    });
    files.sort();
    let mut keys = HashSet::new();
    for file in &files {
        for key in read_object_within_root(file, root, "source")?
            .keys()
            .filter(|key| !is_ignored_i18n_key(key))
        {
            if !keys.insert(folded_key(key)) {
                return Err("Duplicate source key across language-folder documents.".into());
            }
        }
    }
    Ok(files.into_iter().map(Ok).collect())
}

/// One scanned translation unit, its status counts, and the target keys that
/// `default.json` no longer has, all from a single read of source and target.
fn build_i18n_file(
    mod_dir: &Path,
    i18n_dir: &Path,
    canonical_mods: &Path,
    target_lang: &str,
    state: &ModState,
) -> Result<(ScannedI18nFile, StatusCounts, Vec<String>), String> {
    let split = i18n_dir.is_file();
    let source_dir = if split {
        i18n_dir
            .parent()
            .and_then(Path::parent)
            .ok_or("Invalid split source")?
    } else {
        i18n_dir
    };
    let mut relative_dir = source_dir
        .strip_prefix(mod_dir)
        .map_err(|_| "i18n folder is outside its mod folder".to_string())?
        .to_str()
        .ok_or_else(|| {
            "The i18n folder path contains characters that cannot be read as text, so its translations were left out."
                .to_string()
        })?
        .replace('\\', "/");
    let (default_path, target_path) = if split {
        let name = i18n_dir
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or("Invalid split filename")?;
        relative_dir = format!("{relative_dir}/@split/{name}");
        (
            i18n_dir.to_path_buf(),
            split_target_path(i18n_dir, target_lang)?,
        )
    } else {
        (
            i18n_dir.join("default.json"),
            i18n_dir.join(format!("{target_lang}.json")),
        )
    };
    let inspection = inspect_keys_checked(
        &default_path,
        &target_path,
        Some(canonical_mods),
        state,
        &relative_dir,
    )?;
    let review_needed = inspection.status_counts.review_needed;
    let file = ScannedI18nFile {
        target_exists: target_read_path(&target_path).is_file(),
        default_path: default_path.display().to_string(),
        target_path: target_path.display().to_string(),
        relative_dir,
        total_keys: inspection.total,
        translated_keys: inspection.translated,
        no_translation_needed_keys: inspection.no_translation_needed,
        review_needed,
        source_hashes: inspection.source_hashes,
    };
    Ok((file, inspection.status_counts, inspection.extra_target_keys))
}

/// Walk `root`, collecting `manifest.json` files and `i18n/` dirs that contain a
/// `default.json`. Bounded by depth, the canonical root, and a
/// visited-canonical-path set (cycles). Links that resolve outside `root` are
/// never traversed, and folder links are walked last so a folder reachable
/// directly is always recorded under its real path.
/// Returns `false` when filesystem errors or traversal limits may have omitted
/// content. Intentional exclusions, including links outside `root`, remain a
/// complete traversal.
/// `pub(crate)` so `lang_pack` can reuse the same bounded walk for pack discovery.
pub(crate) fn collect(
    root: &Path,
    manifests: &mut Vec<PathBuf>,
    i18n_dirs: &mut Vec<PathBuf>,
) -> bool {
    collect_bounded(root, manifests, i18n_dirs, MAX_DEPTH, MAX_DIRS)
}

fn collect_bounded(
    root: &Path,
    manifests: &mut Vec<PathBuf>,
    i18n_dirs: &mut Vec<PathBuf>,
    max_depth: usize,
    max_dirs: usize,
) -> bool {
    let Ok(canonical_root) = std::fs::canonicalize(root) else {
        return false;
    };
    let mut visited: HashSet<PathBuf> = HashSet::new();
    let mut stack: Vec<(PathBuf, usize)> = vec![(root.to_path_buf(), 0)];
    // Folder links are walked only after every real folder, so a folder reached
    // both directly and through a link keeps its real path.
    let mut linked: Vec<(PathBuf, usize)> = Vec::new();
    let mut dirs_seen = 0usize;
    let mut complete = true;

    while let Some((dir, depth)) = stack.pop().or_else(|| linked.pop()) {
        let Ok(canonical) = std::fs::canonicalize(&dir) else {
            complete = false;
            continue;
        };
        if !canonical.starts_with(&canonical_root) {
            continue;
        }
        if !visited.insert(canonical) {
            continue; // cycle / already visited
        }
        if depth > max_depth || dirs_seen >= max_dirs {
            complete = false;
            continue;
        }
        dirs_seen += 1;

        let Ok(entries) = std::fs::read_dir(&dir) else {
            complete = false;
            continue;
        };
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => {
                    complete = false;
                    continue;
                }
            };
            let path = entry.path();
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(_) => {
                    complete = false;
                    continue;
                }
            };
            let symlink_target = if file_type.is_symlink() {
                match std::fs::canonicalize(&path) {
                    Ok(target) => Some(target),
                    Err(_) => {
                        complete = false;
                        continue;
                    }
                }
            } else {
                None
            };
            let target_is_file = file_type.is_file()
                || symlink_target
                    .as_ref()
                    .is_some_and(|target| target.is_file());
            let target_is_dir = file_type.is_dir()
                || symlink_target
                    .as_ref()
                    .is_some_and(|target| target.is_dir());

            if target_is_file {
                // SMAPI finds the manifest case-insensitively on Windows; so do we.
                if path
                    .file_name()
                    .is_some_and(|n| n.eq_ignore_ascii_case("manifest.json"))
                {
                    match symlink_target
                        .clone()
                        .map(Ok)
                        .unwrap_or_else(|| std::fs::canonicalize(&path))
                    {
                        Ok(canonical)
                            if canonical.is_file() && canonical.starts_with(&canonical_root) =>
                        {
                            manifests.push(path.clone());
                        }
                        Ok(_) => {}
                        Err(_) => complete = false,
                    }
                }
                continue;
            }

            if target_is_dir {
                // SMAPI ignores folders whose name starts with a dot (the usual
                // way to park a disabled mod copy). Scanning them would turn the
                // parked copy into a duplicate UniqueID that blocks the live mod.
                if path
                    .file_name()
                    .is_some_and(|n| n.to_string_lossy().starts_with('.'))
                {
                    continue;
                }
                let is_i18n = path
                    .file_name()
                    .is_some_and(|n| n.eq_ignore_ascii_case("i18n"));
                if is_i18n {
                    let canonical_i18n = match symlink_target.clone() {
                        Some(canonical) => canonical,
                        None => match std::fs::canonicalize(&path) {
                            Ok(canonical) => canonical,
                            Err(_) => {
                                complete = false;
                                continue;
                            }
                        },
                    };
                    if !canonical_i18n.starts_with(&canonical_root) {
                        continue;
                    }
                    let default_path = path.join("default.json");
                    let safe_default = match std::fs::symlink_metadata(&default_path) {
                        Ok(_) => match std::fs::canonicalize(&default_path) {
                            Ok(canonical) => {
                                canonical.is_file() && canonical.starts_with(&canonical_root)
                            }
                            Err(_) => {
                                complete = false;
                                false
                            }
                        },
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
                        Err(_) => {
                            complete = false;
                            false
                        }
                    };
                    if safe_default || path.join("default").is_dir() {
                        i18n_dirs.push(path);
                    }
                    continue; // no mods nested inside an i18n folder
                }
                if symlink_target.is_some() {
                    linked.push((path, depth + 1));
                } else {
                    stack.push((path, depth + 1));
                }
            }
        }
    }

    complete
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
    fn warns_on_duplicate_unique_id_across_mods() {
        // Two separate packages declaring the same UniqueID is a broken/duplicated
        // install: their state would collide on one file. The scan must warn.
        let root = crate::test_support::temp_dir("scan-dup-id");
        for pkg in ["CopyA", "CopyB"] {
            write(
                &root.join(pkg).join("manifest.json"),
                "{ \"Name\": \"Dup\", \"UniqueID\": \"same.id\" }",
            );
            write(
                &root.join(pkg).join("i18n").join("default.json"),
                "{ \"k\": \"v\" }",
            );
        }

        let result = scan_mods(&root, "de", &root);
        assert_eq!(
            result.mod_count, 0,
            "duplicate IDs must not open writable mods"
        );
        assert!(
            result
                .warnings
                .iter()
                .any(|w| w.contains("have the same ID") && w.contains("same.id")),
            "expected a duplicate-UniqueID warning, got: {:?}",
            result.warnings
        );
        assert_eq!(result.skipped_components.len(), 2);
        assert!(result.skipped_components.iter().all(|skipped| {
            skipped.component_unique_id.as_deref() == Some("same.id")
                && !skipped.rest_of_package_loaded
        }));

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn excludes_community_language_packs_from_scan() {
        // A community language pack ships its own i18n (config strings in its
        // language). It must be excluded from the translatable list and
        // surfaced as expected information, while ordinary mods still list
        // normally.
        let root = crate::test_support::temp_dir("scan-langpack");
        let normal = root.join("Normal");
        write(
            &normal.join("manifest.json"),
            "{ \"UniqueID\": \"a.b\", \"Name\": \"Normal\" }",
        );
        write(
            &normal.join("i18n").join("default.json"),
            "{ \"k\": \"v\" }",
        );
        let pack = root.join("Stardew Valley - THAI");
        write(
            &pack.join("manifest.json"),
            "{ \"Name\": \"Stardew Valley - THAI\", \"UniqueID\": \"ell.thai\", \
             \"ContentPackFor\": { \"UniqueID\": \"Pathoschild.ContentPatcher\" } }",
        );
        write(
            &pack.join("content.json"),
            "{ \"Changes\": [ { \"Action\": \"EditData\", \"Target\": \"Data/AdditionalLanguages\", \
             \"Entries\": { \"id\": { \"LanguageCode\": \"th\" } } } ] }",
        );
        write(
            &pack.join("i18n").join("default.json"),
            "{ \"config.x\": \"value\" }",
        );

        let result = scan_mods(&root, "th", &root);
        let names: Vec<&str> = result.mods.iter().map(|m| m.name.as_str()).collect();
        assert_eq!(names, vec!["Normal"], "only the ordinary mod is listed");
        assert!(result.warnings.is_empty(), "{:?}", result.warnings);
        assert_eq!(result.skipped_components.len(), 1);
        assert_eq!(
            result.skipped_components[0].component_unique_id.as_deref(),
            Some("ell.thai")
        );
        assert_eq!(
            result.skipped_components[0].relative_location,
            "Stardew Valley - THAI"
        );
        assert!(!result.skipped_components[0].requires_attention);
        assert!(!result.skipped_components[0].rest_of_package_loaded);

        std::fs::remove_dir_all(&root).ok();
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
        // A malformed manifest -> reported as one structured skip.
        write(&root.join("Broken").join("manifest.json"), "{ not json");

        let result = scan_mods(&root, "de", &root);

        assert_eq!(result.mod_count, 1, "one top-level package is loaded");
        assert_eq!(result.file_count, 3, "each component i18n file is counted");
        assert_eq!(
            result.mods.len(),
            3,
            "all translatable components are listed"
        );
        assert!(result.warnings.is_empty(), "{:?}", result.warnings);
        assert!(result
            .skipped_components
            .iter()
            .any(|skipped| skipped.relative_location == "Broken/manifest.json"));
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
    fn ignores_manifest_nested_inside_another_mod_like_smapi() {
        let root = crate::test_support::temp_dir("scan-nested-manifest");
        write(
            &root.join("Mod").join("manifest.json"),
            "{ \"Name\": \"Outer\", \"UniqueID\": \"outer.mod\" }",
        );
        write(
            &root.join("Mod").join("i18n").join("default.json"),
            "{ \"k\": \"v\" }",
        );
        write(
            &root.join("Mod").join("optional").join("manifest.json"),
            "{ \"Name\": \"Inner\", \"UniqueID\": \"inner.mod\" }",
        );
        write(
            &root
                .join("Mod")
                .join("optional")
                .join("i18n")
                .join("default.json"),
            "{ \"k\": \"v\" }",
        );
        // Sibling components in a package folder without a manifest still work.
        for name in ["[CP] X", "[JA] X"] {
            write(
                &root.join("Pkg").join(name).join("manifest.json"),
                &format!("{{ \"Name\": \"{name}\", \"UniqueID\": \"id.{name}\" }}"),
            );
            write(
                &root
                    .join("Pkg")
                    .join(name)
                    .join("i18n")
                    .join("default.json"),
                "{ \"k\": \"v\" }",
            );
        }

        let result = scan_mods(&root, "de", &root);

        let mut names: Vec<&str> = result.mods.iter().map(|m| m.name.as_str()).collect();
        names.sort_unstable();
        assert_eq!(names, vec!["Outer", "[CP] X", "[JA] X"]);
        assert!(result.warnings.is_empty(), "{:?}", result.warnings);
        assert_eq!(result.skipped_components.len(), 1);
        let note = &result.skipped_components[0];
        assert_eq!(note.relative_location, "Mod/optional/manifest.json");
        assert!(!note.requires_attention);
        assert!(note.package_id.is_none() && note.component_unique_id.is_none());

        std::fs::remove_dir_all(&root).ok();
    }

    fn write_component(dir: &Path, name: &str) {
        write(
            &dir.join("manifest.json"),
            &format!("{{ \"Name\": \"{name}\", \"UniqueID\": \"id.{name}\" }}"),
        );
        write(&dir.join("i18n").join("default.json"), "{ \"k\": \"v\" }");
    }

    #[test]
    fn package_folder_with_only_ignorable_files_is_searched_like_smapi() {
        let root = crate::test_support::temp_dir("scan-package-ignorable-files");
        let package = root.join("Pkg");
        for file in [
            "README.md",
            "notes.txt",
            "preview.png",
            "__folder_managed_by_vortex",
            "desktop.ini",
            ".hidden",
        ] {
            write(&package.join(file), "x");
        }
        write_component(&package.join("[CP] X"), "[CP] X");
        write_component(&package.join("[JA] X"), "[JA] X");
        // A folder SMAPI skips by name does not make Pkg a mod folder either.
        write_component(&package.join("__MACOSX").join("X"), "Mac copy");

        let result = scan_mods(&root, "de", &root);

        let mut names: Vec<&str> = result.mods.iter().map(|m| m.name.as_str()).collect();
        names.sort_unstable();
        assert_eq!(names, vec!["[CP] X", "[JA] X"]);
        assert_eq!(result.skipped_components.len(), 1);
        let note = &result.skipped_components[0];
        assert_eq!(note.relative_location, "Pkg/__MACOSX/X/manifest.json");
        assert_eq!(
            note.reason,
            "Mods/Pkg/__MACOSX/X has a manifest.json, but the game doesn't load it because it skips folders named __MACOSX."
        );

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn mod_organizer_mods_folder_is_searched_like_the_game_sees_it() {
        // MO2's `mods` folder: each entry holds `meta.ini` next to the mod
        // folder it shows the game, and hidden files end in `.mohidden`.
        let root = crate::test_support::temp_dir("scan-mo2-mods-folder");
        let entry = root.join("Better Mod (Nexus 123)");
        write(&entry.join("meta.ini"), "[General]");
        write(&entry.join("old.dll.mohidden"), "x");
        write_component(&entry.join("BetterMod"), "Better Mod");
        // A separator entry holds only meta.ini.
        write(&root.join("Base_separator").join("meta.ini"), "[General]");
        // Deeper down, meta.ini is an ordinary file of the mod.
        write(&root.join("Pkg").join("Inner").join("meta.ini"), "x");
        write_component(&root.join("Pkg").join("Inner").join("[CP] X"), "[CP] X");

        let result = scan_mods(&root, "de", &root);

        let names: Vec<&str> = result.mods.iter().map(|m| m.name.as_str()).collect();
        assert_eq!(names, vec!["Better Mod"]);
        assert_eq!(result.skipped_components.len(), 1);
        assert_eq!(
            result.skipped_components[0].relative_location,
            "Pkg/Inner/[CP] X/manifest.json"
        );

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn other_files_in_a_package_folder_hide_its_components_like_smapi() {
        let root = crate::test_support::temp_dir("scan-package-with-files");
        write(&root.join("Pkg").join("config.json"), "{}");
        write_component(&root.join("Pkg").join("[CP] X"), "[CP] X");
        write_component(&root.join("Other"), "Other");

        let result = scan_mods(&root, "de", &root);

        let names: Vec<&str> = result.mods.iter().map(|m| m.name.as_str()).collect();
        assert_eq!(names, vec!["Other"]);
        // One note for the component; its i18n folder is not reported again.
        assert_eq!(result.skipped_components.len(), 1);
        let note = &result.skipped_components[0];
        assert_eq!(note.relative_location, "Pkg/[CP] X/manifest.json");
        assert_eq!(
            note.reason,
            "Mods/Pkg/[CP] X has a manifest.json, but the game doesn't load it because Mods/Pkg already contains other files."
        );
        assert!(!note.requires_attention);
        assert!(note.package_id.is_none() && note.component_unique_id.is_none());

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn manifest_directly_in_mods_is_not_a_mod_and_hides_nothing() {
        let root = crate::test_support::temp_dir("scan-root-manifest");
        write_component(&root, "Root");
        write_component(&root.join("Mod"), "Mod");

        let result = scan_mods(&root, "de", &root);

        let names: Vec<&str> = result.mods.iter().map(|m| m.name.as_str()).collect();
        assert_eq!(names, vec!["Mod"]);
        assert_eq!(result.skipped_components.len(), 1);
        assert_eq!(
            result.skipped_components[0].relative_location,
            "manifest.json"
        );
        assert_eq!(
            result.skipped_components[0].reason,
            "The game only loads mods from folders inside the Mods folder, not a manifest.json placed directly in it."
        );

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn i18n_anywhere_below_an_unloaded_manifest_is_not_reported_twice() {
        let root = crate::test_support::temp_dir("scan-unloaded-deep-i18n");
        write_component(&root.join("Mod"), "Outer");
        write(
            &root.join("Mod").join("opt").join("Manifest.json"),
            "{ \"Name\": \"Inner\", \"UniqueID\": \"inner.mod\" }",
        );
        write(
            &root
                .join("Mod")
                .join("opt")
                .join("assets")
                .join("i18n")
                .join("default.json"),
            "{ \"k\": \"v\" }",
        );

        let result = scan_mods(&root, "de", &root);

        let names: Vec<&str> = result.mods.iter().map(|m| m.name.as_str()).collect();
        assert_eq!(names, vec!["Outer"]);
        assert_eq!(result.skipped_components.len(), 1);
        assert_eq!(
            result.skipped_components[0].relative_location,
            "Mod/opt/Manifest.json"
        );

        std::fs::remove_dir_all(&root).ok();
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn folder_link_does_not_hide_the_real_mod_it_points_to() {
        let root = crate::test_support::temp_dir("scan-link-to-real-mod");
        let real = root.join("AAA");
        write_component(&real, "Real");
        write_component(&root.join("ZZZ"), "Holder");
        let link = root.join("ZZZ").join("link");
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(&real, &link).is_ok();
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_dir(&real, &link).is_ok()
            || std::process::Command::new("powershell.exe")
                .args([
                    "-NoProfile",
                    "-Command",
                    &format!(
                        "New-Item -ItemType Junction -Path '{}' -Target '{}' | Out-Null",
                        link.display(),
                        real.display()
                    ),
                ])
                .status()
                .is_ok_and(|status| status.success());
        if !linked || !link.is_dir() {
            // Links unavailable on this machine; nothing to check.
            std::fs::remove_dir_all(&root).ok();
            return;
        }

        let result = scan_mods(&root, "de", &root);

        let mut names: Vec<&str> = result.mods.iter().map(|m| m.name.as_str()).collect();
        names.sort_unstable();
        assert_eq!(names, vec!["Holder", "Real"]);
        let real_mod = result.mods.iter().find(|m| m.name == "Real").unwrap();
        assert_eq!(Path::new(&real_mod.folder_path), real.as_path());
        assert!(
            result.skipped_components.is_empty(),
            "{:?}",
            result.skipped_components
        );

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
    fn portuguese_fallback_counts_as_an_existing_target() {
        let root = crate::test_support::temp_dir("scan-portuguese-fallback");
        let mod_dir = root.join("Mod");
        write(
            &mod_dir.join("manifest.json"),
            "{ \"UniqueID\": \"a.b\", \"Name\": \"Mod\" }",
        );
        write(
            &mod_dir.join("i18n").join("default.json"),
            "{ \"k\": \"Hello\" }",
        );
        write(
            &mod_dir.join("i18n").join("pt-BR.json"),
            "{ \"k\": \"Olá\" }",
        );

        let result = scan_mods(&root, "pt", &root);
        let file = &result.mods[0].i18n_files[0];
        assert!(file.target_exists);
        assert!(file.target_path.ends_with("pt.json"));
        assert_eq!(result.mods[0].translated_keys, 1);

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn spanish_regional_file_alone_counts_as_an_existing_target() {
        let root = crate::test_support::temp_dir("scan-spanish-regional-only");
        let mod_dir = root.join("Mod");
        write(
            &mod_dir.join("manifest.json"),
            "{ \"UniqueID\": \"a.b\", \"Name\": \"Mod\" }",
        );
        write(
            &mod_dir.join("i18n").join("default.json"),
            "{ \"k\": \"Hello\", \"other\": \"World\" }",
        );
        let regional = mod_dir.join("i18n").join("es-ES.json");
        write(&regional, "{ \"k\": \"Hola\" }");

        let result = scan_mods(&root, "es", &root);
        let file = &result.mods[0].i18n_files[0];
        assert!(file.target_exists);
        assert!(file.target_path.ends_with("es.json"));
        assert_eq!(target_read_path(Path::new(&file.target_path)), regional);
        assert_eq!(result.mods[0].translated_keys, 1);

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn canonical_and_regional_targets_merge_per_key() {
        // SMAPI reads pt-BR.json, then pt.json, per key. A key only pt.json
        // has must stay translated instead of reading as Open.
        let root = crate::test_support::temp_dir("scan-portuguese-merge");
        let mod_dir = root.join("Mod");
        write(
            &mod_dir.join("manifest.json"),
            "{ \"UniqueID\": \"a.b\", \"Name\": \"Mod\" }",
        );
        write(
            &mod_dir.join("i18n").join("default.json"),
            "{ \"shared\": \"Hello\", \"only.pt\": \"Bye\" }",
        );
        write(
            &mod_dir.join("i18n").join("pt.json"),
            "{ \"shared\": \"Oi\", \"only.pt\": \"Tchau\" }",
        );
        write(
            &mod_dir.join("i18n").join("pt-BR.json"),
            "{ \"shared\": \"Olá\" }",
        );

        let result = scan_mods(&root, "pt", &root);
        assert_eq!(result.mods[0].translated_keys, 2);
        let file = &result.mods[0].i18n_files[0];
        let rows = load_strings(
            Path::new(&file.default_path),
            Path::new(&file.target_path),
            &ModState::new(),
            "i18n",
        );
        let target = |key: &str| {
            rows.iter()
                .find(|row| row.key == key)
                .map(|row| row.target.clone())
                .unwrap()
        };
        assert_eq!(target("shared"), "Olá");
        assert_eq!(target("only.pt"), "Tchau");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn regional_target_wins_across_key_casing_and_survives_a_broken_canonical() {
        let root = crate::test_support::temp_dir("scan-portuguese-casing");
        let i18n = root.join("i18n");
        write(
            &i18n.join("pt.json"),
            "{ \"Greeting\": \"Oi\", \"bye\": \"Tchau\" }",
        );
        write(&i18n.join("pt-BR.json"), "{ \"greeting\": \"Olá\" }");
        let merged = read_target_object_checked(&i18n.join("pt.json")).unwrap();
        assert_eq!(merged.len(), 2);
        assert_eq!(merged["greeting"], "Olá");
        assert_eq!(merged["bye"], "Tchau");

        write(&i18n.join("pt.json"), "{ broken");
        let merged = read_target_object_checked(&i18n.join("pt.json")).unwrap();
        assert_eq!(merged.len(), 1);
        assert_eq!(merged["greeting"], "Olá");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn regional_game_locale_files_merge_for_every_language() {
        let root = crate::test_support::temp_dir("scan-regional-locales");
        let i18n = root.join("i18n");
        write(&i18n.join("de.json"), "{ \"a\": \"alt\", \"b\": \"B\" }");
        write(&i18n.join("de-DE.json"), "{ \"a\": \"neu\" }");
        let merged = read_target_object_checked(&i18n.join("de.json")).unwrap();
        assert_eq!(merged["a"], "neu");
        assert_eq!(merged["b"], "B");

        write(&i18n.join("es-ES.json"), "{ \"a\": \"Hola\" }");
        write(&i18n.join("es.json"), "{ broken");
        let merged = read_target_object_checked(&i18n.join("es.json")).unwrap();
        assert_eq!(merged.len(), 1);
        assert_eq!(merged["a"], "Hola");

        // Only the target's own game locale counts.
        write(&i18n.join("en-GB.json"), "{ \"a\": \"Cheers\" }");
        write(&i18n.join("fr-CA.json"), "{ \"a\": \"Salut\" }");
        write(&i18n.join("fr.json"), "{ \"a\": \"Bonjour\" }");
        let merged = read_target_object_checked(&i18n.join("fr.json")).unwrap();
        assert_eq!(merged["a"], "Bonjour");
        assert!(regional_target_variant(&i18n.join("en.json")).is_none());
        assert!(regional_target_variant(&i18n.join("default.json")).is_none());
        assert!(regional_target_variant(&root.join("de.json")).is_none());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn collect_marks_missing_root_and_depth_limit_as_incomplete() {
        let base = crate::test_support::temp_dir("scan-incomplete-depth");
        let missing = base.join("Missing");
        let mut manifests = Vec::new();
        let mut i18n_dirs = Vec::new();
        assert!(!collect(&missing, &mut manifests, &mut i18n_dirs));

        let root = base.join("Mods");
        write(
            &root.join("Nested/manifest.json"),
            r#"{"UniqueID":"nested.mod"}"#,
        );
        write(&root.join("Nested/i18n/default.json"), r#"{"k":"source"}"#);
        assert!(!collect_bounded(
            &root,
            &mut manifests,
            &mut i18n_dirs,
            0,
            MAX_DIRS,
        ));
        assert!(manifests.is_empty());
        assert!(i18n_dirs.is_empty());

        std::fs::remove_dir_all(base).ok();
    }

    #[test]
    fn collect_marks_directory_limit_as_incomplete() {
        let root = crate::test_support::temp_dir("scan-incomplete-dir-limit");
        write(&root.join("One/manifest.json"), r#"{"UniqueID":"one.mod"}"#);
        write(&root.join("Two/manifest.json"), r#"{"UniqueID":"two.mod"}"#);
        let mut manifests = Vec::new();
        let mut i18n_dirs = Vec::new();

        assert!(!collect_bounded(
            &root,
            &mut manifests,
            &mut i18n_dirs,
            MAX_DEPTH,
            1,
        ));
        assert!(manifests.is_empty());

        std::fs::remove_dir_all(root).ok();
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn collect_does_not_follow_directory_links_outside_the_root() {
        let base = crate::test_support::temp_dir("scan-link-escape");
        let root = base.join("Mods");
        let safe = root.join("Safe");
        let outside = base.join("Outside");
        write(&safe.join("manifest.json"), r#"{"UniqueID":"safe.mod"}"#);
        write(&safe.join("i18n/default.json"), r#"{"k":"safe"}"#);
        write(
            &outside.join("manifest.json"),
            r#"{"UniqueID":"outside.mod"}"#,
        );
        write(&outside.join("i18n/default.json"), r#"{"k":"outside"}"#);

        let link = root.join("Escaped");
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(&outside, &link);
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_dir(&outside, &link);
        if linked.is_err() {
            // Creating Windows symlinks may require Developer Mode. Linux CI
            // still exercises this regression test unconditionally.
            std::fs::remove_dir_all(base).ok();
            return;
        }

        let mut manifests = Vec::new();
        let mut i18n_dirs = Vec::new();
        let complete = collect(&root, &mut manifests, &mut i18n_dirs);

        assert!(complete);
        assert_eq!(manifests, vec![safe.join("manifest.json")]);
        assert_eq!(i18n_dirs, vec![safe.join("i18n")]);

        std::fs::remove_dir_all(base).ok();
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn collect_rejects_default_file_links_outside_the_root() {
        let base = crate::test_support::temp_dir("scan-file-link-escape");
        let root = base.join("Mods");
        let mod_dir = root.join("Safe");
        let outside_default = base.join("outside-default.json");
        write(&mod_dir.join("manifest.json"), r#"{"UniqueID":"safe.mod"}"#);
        std::fs::create_dir_all(mod_dir.join("i18n")).unwrap();
        std::fs::write(&outside_default, r#"{"k":"outside"}"#).unwrap();

        let link = mod_dir.join("i18n/default.json");
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(&outside_default, &link);
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_file(&outside_default, &link);
        if linked.is_err() {
            std::fs::remove_dir_all(base).ok();
            return;
        }

        let mut manifests = Vec::new();
        let mut i18n_dirs = Vec::new();
        let complete = collect(&root, &mut manifests, &mut i18n_dirs);

        assert!(complete);
        assert_eq!(manifests, vec![mod_dir.join("manifest.json")]);
        assert!(i18n_dirs.is_empty());

        std::fs::remove_dir_all(base).ok();
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn scan_rejects_target_file_links_outside_the_root() {
        let base = crate::test_support::temp_dir("scan-target-link-escape");
        let root = base.join("Mods");
        let mod_dir = root.join("Safe");
        let i18n = mod_dir.join("i18n");
        let outside_target = base.join("outside-target.json");
        write(&mod_dir.join("manifest.json"), r#"{"UniqueID":"safe.mod"}"#);
        write(&i18n.join("default.json"), r#"{"k":"source"}"#);
        std::fs::write(&outside_target, r#"{"k":"outside"}"#).unwrap();

        let german_link = i18n.join("de.json");
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(&outside_target, &german_link);
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_file(&outside_target, &german_link);
        if linked.is_err() {
            std::fs::remove_dir_all(base).ok();
            return;
        }

        let german = scan_mods(&root, "de", &base.join("data"));
        assert!(german.mods.is_empty());
        assert!(german.warnings.is_empty(), "{:?}", german.warnings);
        assert!(german
            .skipped_components
            .iter()
            .any(|skipped| { skipped.reason.contains("target file resolves outside") }));

        std::fs::remove_file(&german_link).unwrap();
        let portuguese_link = i18n.join("pt-BR.json");
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(&outside_target, &portuguese_link);
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_file(&outside_target, &portuguese_link);
        if linked.is_err() {
            std::fs::remove_dir_all(base).ok();
            return;
        }

        let portuguese = scan_mods(&root, "pt", &base.join("data"));
        assert!(portuguese.mods.is_empty());
        assert!(portuguese.warnings.is_empty(), "{:?}", portuguese.warnings);
        assert!(portuguese
            .skipped_components
            .iter()
            .any(|skipped| { skipped.reason.contains("target file resolves outside") }));

        std::fs::remove_dir_all(base).ok();
    }

    #[test]
    fn reports_extra_target_keys_without_counting_them() {
        let root = crate::test_support::temp_dir("scan-extra-keys");
        let mod_dir = root.join("Mod");
        write(
            &mod_dir.join("manifest.json"),
            "{ \"UniqueID\": \"a.b\", \"Name\": \"Example Mod\" }",
        );
        write(
            &mod_dir.join("i18n").join("default.json"),
            "{ \"current\": \"Current\" }",
        );
        write(
            &mod_dir.join("i18n").join("de.json"),
            "{ \"current\": \"Aktuell\", \"removed\": \"Alt\", \"$schema\": \"ignored\" }",
        );

        let result = scan_mods(&root, "de", &root);
        assert_eq!(result.mods[0].total_keys, 1);
        assert_eq!(result.mods[0].translated_keys, 1);
        assert_eq!(
            result.extra_keys,
            vec![ExtraKeyDiagnostic {
                mod_name: "Example Mod".to_string(),
                relative_dir: "i18n".to_string(),
                target_path: mod_dir.join("i18n").join("de.json").display().to_string(),
                key: "removed".to_string(),
            }]
        );

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
    fn checked_loader_rejects_missing_malformed_and_non_flat_sources() {
        let root = crate::test_support::temp_dir("scanner-checked-errors");
        let missing = root.join("missing.json");
        let target = root.join("de.json");
        assert!(load_strings_checked(&missing, &target, &ModState::new(), "i18n").is_err());

        let source = root.join("default.json");
        write(&source, "{ broken");
        assert!(load_strings_checked(&source, &target, &ModState::new(), "i18n").is_err());
        write(&source, r#"{"k":{"nested":"value"}}"#);
        assert!(load_strings_checked(&source, &target, &ModState::new(), "i18n").is_err());
        write(&source, r#"{"k":"Hello"}"#);
        write(&target, "[");
        assert!(load_strings_checked(&source, &target, &ModState::new(), "i18n").is_err());
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn scanner_skips_only_the_malformed_i18n_component() {
        let root = crate::test_support::temp_dir("scanner-component-error");
        // A package folder with one component folder per manifest, as SMAPI
        // loads them (it never looks inside a folder that has a manifest).
        let mod_dir = root.join("Mod");
        write(
            &mod_dir.join("Main/manifest.json"),
            r#"{"Name":"Mod","UniqueID":"Author.Mod"}"#,
        );
        write(&mod_dir.join("Main/i18n/default.json"), r#"{"ok":"Hello"}"#);
        write(
            &mod_dir.join("optional/manifest.json"),
            r#"{"Name":"Optional","UniqueID":"Author.Optional"}"#,
        );
        write(&mod_dir.join("optional/i18n/default.json"), "{ broken");

        let result = scan_mods(&root, "de", &root);
        assert_eq!(result.mod_count, 1);
        assert_eq!(result.file_count, 1);
        assert!(result.warnings.is_empty(), "{:?}", result.warnings);
        assert_eq!(result.skipped_components.len(), 1);
        let skipped = &result.skipped_components[0];
        assert_eq!(skipped.package_id.as_deref(), Some("Mod"));
        assert_eq!(
            skipped.component_unique_id.as_deref(),
            Some("Author.Optional")
        );
        assert_eq!(skipped.component_name.as_deref(), Some("Optional"));
        assert_eq!(skipped.relative_location, "Mod/optional/i18n/default.json");
        assert!(skipped.rest_of_package_loaded);
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn ignores_content_patcher_assets_i18n_and_notes_unloaded_nested_i18n() {
        let root = crate::test_support::temp_dir("scanner-ignore-cp-assets-i18n");
        let mod_dir = root.join("Mod");
        write(
            &mod_dir.join("manifest.json"),
            r#"{"Name":"Mod","UniqueID":"Author.Mod"}"#,
        );
        write(&mod_dir.join("i18n/default.json"), r#"{"ok":"Hello"}"#);
        write(
            &mod_dir.join("optional/i18n/default.json"),
            r#"{"extra":"Nested component"}"#,
        );
        write(
            &mod_dir.join("Assets/I18N/default.json"),
            r#"{ 0: "Content Patcher data" }"#,
        );
        write(
            &mod_dir.join("Assets/I18N/fr.json"),
            r#"{ 0: "Données Content Patcher" }"#,
        );
        write(
            &mod_dir.join("Assets/I18N/pt.json"),
            r#"{ 0: "Dados do Content Patcher" }"#,
        );

        let result = scan_mods(&root, "de", &root);
        assert!(result.traversal_complete);
        assert_eq!(result.mod_count, 1);
        assert_eq!(result.file_count, 1);
        assert!(result.warnings.is_empty(), "{:?}", result.warnings);
        // SMAPI never loads `optional/i18n` (no manifest beside it): a note.
        assert_eq!(result.skipped_components.len(), 1);
        assert!(!result.skipped_components[0].requires_attention);
        assert_eq!(
            result.skipped_components[0].relative_location,
            "Mod/optional/i18n"
        );
        assert_eq!(
            result.mods[0]
                .i18n_files
                .iter()
                .map(|file| file.relative_dir.as_str())
                .collect::<Vec<_>>(),
            vec!["i18n"]
        );
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn ignores_i18n_owned_by_a_manifest_nested_in_an_assets_folder() {
        let root = crate::test_support::temp_dir("scanner-assets-child-owner");
        let package = root.join("Package");
        write(
            &package.join("manifest.json"),
            r#"{"Name":"Parent","UniqueID":"Author.Parent"}"#,
        );
        write(&package.join("i18n/default.json"), r#"{"parent":"Parent"}"#);
        write(
            &package.join("assets/manifest.json"),
            r#"{"Name":"Child","UniqueID":"Author.Child"}"#,
        );
        write(
            &package.join("assets/i18n/default.json"),
            r#"{"child":"Child"}"#,
        );

        let result = scan_mods(&root, "de", &root);
        assert_eq!(result.mod_count, 1);
        assert_eq!(result.file_count, 1);
        assert_eq!(result.mods.len(), 1, "SMAPI never loads the nested child");
        assert_eq!(result.mods[0].unique_id, "Author.Parent");
        assert_eq!(result.skipped_components.len(), 1);
        assert_eq!(
            result.skipped_components[0].relative_location,
            "Package/assets/manifest.json"
        );
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn structured_skip_for_the_only_broken_i18n_component_is_not_loaded() {
        let root = crate::test_support::temp_dir("scanner-only-component-error");
        let mod_dir = root.join("Solo");
        write(
            &mod_dir.join("manifest.json"),
            r#"{"Name":"Solo","UniqueID":"Author.Solo"}"#,
        );
        write(&mod_dir.join("i18n/default.json"), "{ broken");

        let result = scan_mods(&root, "de", &root);

        assert_eq!(result.mod_count, 0);
        assert_eq!(result.file_count, 0);
        assert_eq!(result.skipped_components.len(), 1);
        let skipped = &result.skipped_components[0];
        assert_eq!(skipped.package_id.as_deref(), Some("Solo"));
        assert_eq!(skipped.component_unique_id.as_deref(), Some("Author.Solo"));
        assert_eq!(skipped.relative_location, "Solo/i18n/default.json");
        assert!(!skipped.rest_of_package_loaded);
        assert!(!skipped.reason.contains(&root.display().to_string()));
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn malformed_manifest_reports_its_package_and_loaded_sibling() {
        let root = crate::test_support::temp_dir("scanner-manifest-component-error");
        let package = root.join("Bundle");
        write(
            &package.join("Good/manifest.json"),
            r#"{"Name":"Good","UniqueID":"Author.Good"}"#,
        );
        write(&package.join("Good/i18n/default.json"), r#"{"ok":"Hello"}"#);
        write(&package.join("Broken/manifest.json"), "{ broken");

        let result = scan_mods(&root, "de", &root);

        assert_eq!(result.mod_count, 1);
        assert_eq!(result.skipped_components.len(), 1);
        let skipped = &result.skipped_components[0];
        assert_eq!(skipped.package_id.as_deref(), Some("Bundle"));
        assert_eq!(skipped.component_unique_id, None);
        assert_eq!(skipped.component_name, None);
        assert_eq!(skipped.relative_location, "Bundle/Broken/manifest.json");
        assert!(skipped.rest_of_package_loaded);
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn state_load_warning_does_not_invent_a_skipped_component() {
        let root = crate::test_support::temp_dir("scanner-state-warning");
        let mod_dir = root.join("Mod");
        write(
            &mod_dir.join("manifest.json"),
            r#"{"Name":"Mod","UniqueID":"Author.Mod"}"#,
        );
        write(&mod_dir.join("i18n/default.json"), r#"{"ok":"Hello"}"#);
        write(
            &root.join("language-state/de/translations/Author.Mod.json"),
            "{ broken",
        );

        let result = scan_mods(&root, "de", &root);

        assert_eq!(result.mod_count, 1);
        assert!(!result.warnings.is_empty());
        assert!(result.skipped_components.is_empty());
        std::fs::remove_dir_all(root).ok();
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
    fn token_mismatch_acceptance_only_applies_to_the_saved_source_revision() {
        let root = crate::test_support::temp_dir("accepted-token-revision");
        let i18n = root.join("i18n");
        let default_path = i18n.join("default.json");
        let target_path = i18n.join("de.json");
        write(&default_path, r#"{"k":"Hello$8"}"#);
        translations::save_one(
            &root,
            "mod.id",
            translations::entry_key("i18n", "k"),
            translations::StoredString {
                target: "Hallo$7".into(),
                status: translations::TOKEN_MISMATCH_ACCEPTED_STATUS.into(),
                source_hash: translations::source_hash("Hello$8"),
            },
        )
        .unwrap();
        let state = translations::load(&root, "mod.id").unwrap();

        let rows = load_strings(&default_path, &target_path, &state, "i18n");
        assert_eq!(rows[0].status, "translated");
        assert!(rows[0].token_mismatch_accepted);

        write(&default_path, r#"{"k":"Hello again$8"}"#);
        let rows = load_strings(&default_path, &target_path, &state, "i18n");
        assert_eq!(rows[0].status, "outdated");
        assert!(!rows[0].token_mismatch_accepted);

        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn review_needed_token_mismatch_acceptance_survives_only_the_saved_source_revision() {
        let root = crate::test_support::temp_dir("accepted-review-token-revision");
        let i18n = root.join("i18n");
        let default_path = i18n.join("default.json");
        let target_path = i18n.join("de.json");
        write(&default_path, r#"{"k":"Hello$8"}"#);
        translations::save_one(
            &root,
            "mod.id",
            translations::entry_key("i18n", "k"),
            translations::StoredString {
                target: "Hallo$7".into(),
                status: translations::REVIEW_NEEDED_TOKEN_MISMATCH_ACCEPTED_STATUS.into(),
                source_hash: translations::source_hash("Hello$8"),
            },
        )
        .unwrap();
        let state = translations::load(&root, "mod.id").unwrap();

        let rows = load_strings(&default_path, &target_path, &state, "i18n");
        assert_eq!(rows[0].status, "review-needed");
        assert!(rows[0].token_mismatch_accepted);

        write(&default_path, r#"{"k":"Hello again$8"}"#);
        let rows = load_strings(&default_path, &target_path, &state, "i18n");
        assert_eq!(rows[0].status, "outdated");
        assert!(!rows[0].token_mismatch_accepted);

        std::fs::remove_dir_all(root).ok();
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

        write(
            &i18n.join("default.json"),
            "{ \"a\": \"A changed\", \"b\": \"B\" }",
        );
        let counts = count_keys(
            &i18n.join("default.json"),
            &i18n.join("de.json"),
            &state,
            "i18n",
        );
        assert_eq!(counts, (2, 1, 0), "outdated AI text is not review-needed");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn scan_reports_current_status_counts_for_the_dashboard() {
        let root = crate::test_support::temp_dir("scan-status-counts");
        let mods = root.join("Mods");
        let config = root.join("data");
        let mod_dir = mods.join("Status Mod");
        let i18n = mod_dir.join("i18n");
        write(
            &mod_dir.join("manifest.json"),
            r#"{"UniqueID":"status.mod","Name":"Status Mod"}"#,
        );
        write(
            &i18n.join("default.json"),
            r#"{"open":"Open","done":"Done","review":"Review","changed":"Changed"}"#,
        );
        write(&i18n.join("de.json"), r#"{"done":"Fertig"}"#);

        let language_root = translations::language_root(&config, "de").unwrap();
        translations::save_one(
            &language_root,
            "status.mod",
            translations::entry_key("i18n", "review"),
            translations::StoredString {
                target: "Prüfen".into(),
                status: "review-needed".into(),
                source_hash: translations::source_hash("Review"),
            },
        )
        .unwrap();
        translations::save_one(
            &language_root,
            "status.mod",
            translations::entry_key("i18n", "changed"),
            translations::StoredString {
                target: "Geändert".into(),
                status: "translated".into(),
                source_hash: translations::source_hash("Old source"),
            },
        )
        .unwrap();

        let result = scan_mods(&mods, "de", &config);
        let scanned = &result.mods[0];
        assert_eq!(scanned.total_keys, 4);
        assert_eq!(scanned.translated_keys, 3);
        assert_eq!(scanned.review_needed, 1);
        assert_eq!(
            scanned.status_counts,
            StatusCounts {
                untranslated: 1,
                translated: 1,
                outdated: 1,
                review_needed: 1,
            }
        );
        assert_eq!(
            serde_json::to_value(&scanned.status_counts).unwrap()["review-needed"],
            1
        );

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
        assert!(!sections.contains_key(&folded_key("first")));
        assert_eq!(
            sections.get(&folded_key("second")).map(String::as_str),
            Some("Later")
        );
    }

    #[test]
    fn commented_out_entries_and_notes_do_not_start_sections() {
        let body = r#"{
  // Greetings
  //"OldGreeting": "Hi",
  "hello": "Hello",
  // "Removed" : "Gone",
  // TODO: reword this
  "bye": "Bye",
  // fixme: later
  // Note: keep short
  // XXX
  "later": "Later",
  // Notebook entries
  "page": "Page",
  // ÄÖÜ title
  "umlaut": "Umlaut"
}"#;
        let sections = extract_sections(body);
        for key in ["hello", "bye", "later"] {
            assert_eq!(
                sections.get(&folded_key(key)).map(String::as_str),
                Some("Greetings"),
                "{key}"
            );
        }
        assert_eq!(
            sections.get(&folded_key("page")).map(String::as_str),
            Some("Notebook entries")
        );
        assert_eq!(
            sections.get(&folded_key("umlaut")).map(String::as_str),
            Some("ÄÖÜ title")
        );
        assert!(!sections.contains_key(&folded_key("OldGreeting")));
    }

    #[test]
    fn only_quoted_keys_and_bare_markers_are_skipped_as_headings() {
        for skipped in [
            r#""OldGreeting": "Hi","#,
            r#" "Removed" : "Gone""#,
            "TODO",
            "TODO: reword",
            "NOTE:",
        ] {
            assert!(is_note_or_disabled_line(skipped), "{skipped}");
        }
        for heading in [
            r#" "Festival" lines"#,
            "Todo list",
            "Note on festivals",
            "Notebook entries",
            "Greetings",
        ] {
            assert!(!is_note_or_disabled_line(heading), "{heading}");
        }
    }

    #[test]
    fn imported_baselines_snapshots_only_untracked_translations() {
        let root = crate::test_support::temp_dir("imported-baselines");
        let i18n = root.join("i18n");
        write(
            &i18n.join("default.json"),
            "{ \"kept\": \"Hello\", \"empty\": \"Bye\", \"tracked\": \"Hi\" }",
        );
        // `kept` is imported, `empty` has no target, `tracked` is already saved.
        write(
            &i18n.join("de.json"),
            "{ \"kept\": \"Hallo\", \"tracked\": \"Servus\" }",
        );
        translations::save_one(
            &root,
            "mod.id",
            translations::entry_key("i18n", "tracked"),
            translations::StoredString {
                target: "Servus".into(),
                status: "translated".into(),
                source_hash: translations::source_hash("Hi"),
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
        let baselines = imported_baselines(&rows, &state, "i18n");

        // Only the imported `kept` string is adopted — not the empty one, not
        // the already-tracked one.
        assert_eq!(baselines.len(), 1);
        let (key, entry) = &baselines[0];
        assert_eq!(key, &translations::entry_key("i18n", "kept"));
        assert_eq!(entry.target, "Hallo");
        assert_eq!(entry.status, "translated");
        assert_eq!(entry.source_hash, translations::source_hash("Hello"));

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn adopted_import_goes_outdated_when_source_changes() {
        // The end-to-end point of imported_baselines: an imported translation
        // gains a baseline on first open, then becomes `outdated` once the
        // mod's source text changes.
        let root = crate::test_support::temp_dir("imported-outdated");
        let i18n = root.join("i18n");
        let default_path = i18n.join("default.json");
        let target_path = i18n.join("de.json");
        write(&default_path, "{ \"k\": \"Hello\" }");
        write(&target_path, "{ \"k\": \"Hallo\" }");

        // First open: no state yet, so the import resolves as plain translated.
        let state = ModState::new();
        let rows = load_strings(&default_path, &target_path, &state, "i18n");
        assert_eq!(rows[0].status, "translated");

        // Adopt the baseline (what the load_strings command persists).
        let baselines = imported_baselines(&rows, &state, "i18n");
        translations::save_many(&root, "mod.id", baselines).unwrap();

        // Source unchanged -> still translated.
        let state = translations::load(&root, "mod.id").unwrap();
        let rows = load_strings(&default_path, &target_path, &state, "i18n");
        assert_eq!(rows[0].status, "translated");

        // Source changes after the translation was adopted -> outdated.
        write(&default_path, "{ \"k\": \"Hello there\" }");
        let rows = load_strings(&default_path, &target_path, &state, "i18n");
        assert_eq!(rows[0].status, "outdated");

        std::fs::remove_dir_all(&root).ok();
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
        // Legacy `not-translatable` entries become "keep
        // original" — translated, with an empty stored target resolving to
        // the current source text.
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

#[cfg(test)]
mod blank_source_tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    struct Fixture {
        base: PathBuf,
        mods: PathBuf,
        config: PathBuf,
        source: PathBuf,
        target: PathBuf,
    }
    impl Fixture {
        fn new(source: &str, target: Option<&str>) -> Self {
            let base = crate::test_support::temp_dir("blank-source");
            let mods = base.join("Mods");
            let folder = mods.join("Example");
            let source_path = folder.join("i18n/default.json");
            let target_path = folder.join("i18n/de.json");
            fs::create_dir_all(source_path.parent().unwrap()).unwrap();
            fs::write(
                folder.join("manifest.json"),
                br#"{"UniqueID":"test.blank","Name":"Example"}"#,
            )
            .unwrap();
            fs::write(
                &source_path,
                serde_json::to_vec(&json!({"key":source})).unwrap(),
            )
            .unwrap();
            if let Some(target) = target {
                fs::write(
                    &target_path,
                    serde_json::to_vec(&json!({"key":target})).unwrap(),
                )
                .unwrap();
            }
            Self {
                config: base.join("config"),
                base,
                mods,
                source: source_path,
                target: target_path,
            }
        }
        fn state_root(&self) -> PathBuf {
            translations::language_root(&self.config, "de").unwrap()
        }
        fn scan(&self) -> ScanResult {
            scan_mods(&self.mods, "de", &self.config)
        }
        fn rows(&self) -> Vec<StringRow> {
            let state = translations::load(&self.state_root(), "test.blank").unwrap();
            load_strings_checked(&self.source, &self.target, &state, "i18n").unwrap()
        }
        fn save(&self, source: &str, target: &str, status: &str) {
            translations::save_one(
                &self.state_root(),
                "test.blank",
                translations::entry_key("i18n", "key"),
                translations::StoredString {
                    target: target.into(),
                    status: status.into(),
                    source_hash: translations::source_hash(source),
                },
            )
            .unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.base).unwrap();
        }
    }

    #[test]
    fn intentional_space_survives_reload_counts_and_source_changes() {
        let f = Fixture::new("Tree", None);
        let status = translations::status_for_save("Tree", " ", "translated");
        f.save("Tree", " ", &status);
        for _ in 0..2 {
            let row = &f.rows()[0];
            assert_eq!(
                (row.target.as_str(), row.status.as_str()),
                (" ", "translated")
            );
            assert!(row.has_translation());
            let scan = f.scan();
            let component = &scan.mods[0];
            assert_eq!(
                (
                    component.translated_keys,
                    component.no_translation_needed_keys
                ),
                (1, 0)
            );
            assert_eq!(component.status_counts.translated, 1);
            assert_eq!(component.progress, 1.0);
            assert!(
                !f.target.exists(),
                "Scanning must not export to the installed mod"
            );
        }

        fs::write(
            &f.source,
            serde_json::to_vec(&json!({"key":"New Tree"})).unwrap(),
        )
        .unwrap();
        let row = &f.rows()[0];
        assert_eq!(row.status, "outdated");
        assert!(row.has_translation());

        f.save("New Tree", "", "untranslated");
        assert_eq!(f.rows()[0].status, "untranslated");
        assert!(!f.rows()[0].has_translation());
    }

    #[test]
    fn imported_single_space_is_adopted_but_old_blank_pair_state_is_not_an_exemption() {
        let f = Fixture::new("Tree", Some(" "));
        assert_eq!(f.rows()[0].status, "translated");
        let baseline = imported_baselines(&f.rows(), &Default::default(), "i18n");
        assert_eq!(baseline.len(), 1);
        assert_eq!(
            translations::base_status(&baseline[0].1.status),
            "translated"
        );
        assert_ne!(baseline[0].1.status, "translated");
        f.save("Tree", " ", &baseline[0].1.status);
        fs::write(&f.source, br#"{"key":"New Tree"}"#).unwrap();
        assert_eq!(f.rows()[0].status, "outdated");

        let old = Fixture::new("", None);
        old.save("", " ", "translated");
        assert_eq!(old.rows()[0].status, "translated");
        fs::write(&old.source, br#"{"key":"Tree"}"#).unwrap();
        assert_eq!(old.rows()[0].status, "untranslated");
        assert!(!old.rows()[0].has_translation());
    }

    #[test]
    fn intentional_space_keeps_review_and_source_bound_token_waivers() {
        let source = "Tree {{Count}}";
        let f = Fixture::new(source, None);
        let status = translations::status_for_save(
            source,
            " ",
            translations::REVIEW_NEEDED_TOKEN_MISMATCH_ACCEPTED_STATUS,
        );
        f.save(source, " ", &status);
        let row = &f.rows()[0];
        assert_eq!(row.status, "review-needed");
        assert!(row.token_mismatch_accepted);
        fs::write(&f.source, br#"{"key":"Tree {{Count}} changed"}"#).unwrap();
        assert_eq!(f.rows()[0].status, "outdated");
        assert!(!f.rows()[0].token_mismatch_accepted);
    }

    #[test]
    fn blank_pairs_reopen_after_source_update_and_reload_without_saving_exemptions() {
        // Unicode White_Space matches the frontend predicate: NEL is blank;
        // FEFF is text (unlike JavaScript's built-in String.trim).
        for source in ["", "   ", "\t\r\n", "\u{a0}", "\u{85}"] {
            for target in [
                None,
                Some(""),
                Some(" \t\r\n"),
                Some("\u{a0}"),
                Some("\u{85}"),
            ] {
                for status in [
                    None,
                    Some("untranslated"),
                    Some("translated"),
                    Some("review-needed"),
                ] {
                    let f = Fixture::new(source, target);
                    if let Some(status) = status {
                        f.save(source, target.unwrap_or_default(), status);
                    }
                    let before_state = translations::load(&f.state_root(), "test.blank").unwrap();
                    let before_source = fs::read(&f.source).unwrap();
                    let before_target = fs::read(&f.target).ok();
                    let mut scan = f.scan();
                    let row = &f.rows()[0];
                    assert_eq!(row.status, "translated");
                    assert_eq!(row.source, source);
                    assert_eq!(row.target, target.unwrap_or_default());
                    let component = &scan.mods[0];
                    assert_eq!(
                        (
                            component.total_keys,
                            component.translated_keys,
                            component.no_translation_needed_keys
                        ),
                        (1, 0, 1)
                    );

                    assert_eq!(component.i18n_files[0].target_exists, target.is_some());
                    assert_eq!(component.status_counts.untranslated, 0);
                    assert_eq!(component.status_counts.translated, 1);
                    assert_eq!(component.progress, 1.0);
                    assert!(imported_baselines(&f.rows(), &before_state, "i18n").is_empty());
                    assert_eq!(fs::read(&f.source).unwrap(), before_source);
                    assert_eq!(fs::read(&f.target).ok(), before_target);
                    crate::scan_snapshot::apply(&mut scan, &f.mods, &f.config).unwrap();
                    fs::write(&f.source, br#"{"key":"Now needs translation"}"#).unwrap();
                    // Reload all persisted state, as a fresh application process does.
                    let mut updated = f.scan();
                    crate::scan_snapshot::apply(&mut updated, &f.mods, &f.config).unwrap();
                    assert_eq!(updated.source_deltas.as_ref().unwrap().sources_changed, 1);
                    assert_eq!(updated.source_deltas.as_ref().unwrap().strings_added, 0);
                    let component = &updated.mods[0];
                    assert_eq!(f.rows()[0].status, "untranslated");
                    assert_eq!(component.status_counts.untranslated, 1);
                    assert_eq!(component.status_counts.outdated, 0);
                    assert_eq!(component.no_translation_needed_keys, 0);

                    assert_eq!(component.progress, 0.0);
                    assert_eq!(
                        translations::load(&f.state_root(), "test.blank").unwrap(),
                        before_state
                    );
                    assert_eq!(fs::read(&f.target).ok(), before_target);
                }
            }
        }
    }

    #[test]
    fn feff_is_text_in_status_and_work_counts() {
        let f = Fixture::new("\u{feff}", Some(""));
        assert_eq!(f.rows()[0].status, "untranslated");
        assert_eq!(f.scan().mods[0].no_translation_needed_keys, 0);

        f.save("\u{feff}", "", "translated");
        fs::write(&f.source, br#"{"key":"New text"}"#).unwrap();
        assert_eq!(f.rows()[0].status, "untranslated");
        let f = Fixture::new("", Some("\u{feff}"));
        let scan = f.scan();
        assert_eq!(f.rows()[0].target, "\u{feff}");
        assert_eq!(f.rows()[0].status, "translated");
        assert_eq!(
            (
                scan.mods[0].translated_keys,
                scan.mods[0].no_translation_needed_keys
            ),
            (1, 0)
        );
    }

    #[test]
    fn personal_text_retains_review_and_source_hash_changes_with_empty_source() {
        for status in ["translated", "review-needed", "untranslated"] {
            let f = Fixture::new("", Some(""));
            f.save("", " Personal text ", status);
            let scan = f.scan();
            assert_eq!(f.rows()[0].status, status);
            assert_eq!(
                (
                    scan.mods[0].translated_keys,
                    scan.mods[0].no_translation_needed_keys
                ),
                (1, 0)
            );

            fs::write(&f.source, br#"{"key":"Changed source"}"#).unwrap();
            let row = &f.rows()[0];
            assert_eq!(row.target, " Personal text ");
            assert_eq!(
                row.status,
                if status == "untranslated" {
                    "untranslated"
                } else {
                    "outdated"
                }
            );
        }
    }

    #[test]
    fn exactly_empty_legacy_baseline_reopens_counts_and_export_without_copying_source() {
        let f = Fixture::new("", Some(""));
        f.save("", "", "not-translatable");
        assert_eq!(f.rows()[0].status, "translated");
        fs::write(&f.source, br#"{"key":"New source"}"#).unwrap();
        let scan = f.scan();
        assert_eq!(f.rows()[0].status, "untranslated");
        assert_eq!(f.rows()[0].target, "");
        assert_eq!(scan.mods[0].translated_keys, 0);
        assert_eq!(scan.mods[0].no_translation_needed_keys, 0);
        assert_eq!(scan.mods[0].status_counts.untranslated, 1);
        let result = crate::export::export_mod(
            &f.state_root(),
            "test.blank",
            &[crate::export::ExportFileInput {
                relative_dir: "i18n".into(),
                default_path: f.source.display().to_string(),
                target_path: f.target.display().to_string(),
            }],
        )
        .unwrap();
        assert_eq!(result.total_written_keys, 0);
        assert_eq!(result.total_untranslated, 1);
        assert!(!f.target.exists());
        assert!(f.target.with_file_name("de.json.bak").exists());
        // Other historical baselines still mean the explicit legacy Keep original.
        f.save("Previous text", "", "not-translatable");
        assert_eq!(f.rows()[0].target, "New source");
        assert_eq!(f.rows()[0].status, "translated");
        assert_eq!(f.scan().mods[0].translated_keys, 1);
    }

    #[test]
    fn clear_keeps_work_untranslated() {
        let f = Fixture::new("Normal source", Some("Installed translation"));
        f.save("Normal source", "", "untranslated");
        let scan = f.scan();
        assert_eq!(f.rows()[0].status, "untranslated");
        assert_eq!(
            (
                scan.mods[0].translated_keys,
                scan.mods[0].no_translation_needed_keys
            ),
            (0, 0)
        );

        assert_eq!(scan.mods[0].progress, 0.0);
    }
}

#[cfg(test)]
mod split_locale_tests {
    use super::*;

    #[test]
    fn unreadable_split_folders_are_named_briefly_in_plain_words() {
        let missing = std::io::Error::from(std::io::ErrorKind::NotFound);
        let message = unreadable_folder(Path::new("C:/Users/Someone/Mods/Mod/i18n/de"), &missing);
        assert_eq!(
            message,
            "Could not read the folder i18n/de (it no longer exists). Check that it exists and is not locked by another program, then scan again."
        );
        let other = std::io::Error::other("The disk is busy. (os error 170)");
        assert_eq!(plain_io_error(&other), "The disk is busy");
    }

    #[test]
    fn unresolvable_read_boundary_names_only_the_folder() {
        let root = crate::test_support::temp_dir("canonical-root-missing");
        let error = canonical_root(&root.join("Gone").join("i18n")).unwrap_err();
        assert_eq!(
            error,
            "Could not open the folder \"i18n\" (it no longer exists). Check that it exists and is not locked by another program, then scan again."
        );
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn split_units_roundtrip_through_batch_working_state_and_folder_export() {
        let root = crate::test_support::temp_dir("split-working-roundtrip");
        let mods = root.join("Mods");
        let folder = mods.join("Example");
        let config = root.join("data");
        std::fs::create_dir_all(folder.join("i18n/default")).unwrap();
        std::fs::write(
            folder.join("manifest.json"),
            r#"{"Name":"Example","UniqueID":"Example.Split"}"#,
        )
        .unwrap();
        std::fs::write(
            folder.join("i18n/default/Dialogue.json"),
            r#"{"hello":"Hello @"}"#,
        )
        .unwrap();
        std::fs::write(
            folder.join("i18n/default/Events.json"),
            r#"{"start":"Start"}"#,
        )
        .unwrap();
        let scan = scan_mods(&mods, "de", &config);
        let files = &scan.mods[0].i18n_files;
        let mut rows_by_dir = HashMap::new();
        let mut ai_rows = Vec::new();
        let mut items = Vec::new();
        for file in files {
            let rows = load_strings_checked(
                Path::new(&file.default_path),
                Path::new(&file.target_path),
                &ModState::new(),
                &file.relative_dir,
            )
            .unwrap();
            for row in &rows {
                ai_rows.push(crate::ai::AiScopeRow {
                    identity: crate::ai::AiStringIdentity {
                        mod_unique_id: "Example.Split".into(),
                        relative_dir: file.relative_dir.clone(),
                        key: row.key.clone(),
                    },
                    source: row.source.clone(),
                    section: row.section.clone(),
                    status: row.status.clone(),
                    default_path: PathBuf::from(&file.default_path),
                    target_path: PathBuf::from(&file.target_path),
                    expected_stored: None,
                    expected_revision: 0,
                });
                items.push(crate::batch::BatchExportItem {
                    relative_dir: file.relative_dir.clone(),
                    key: row.key.clone(),
                    source: row.source.clone(),
                });
            }
            rows_by_dir.insert(file.relative_dir.clone(), rows);
        }
        let request = crate::ai::AiTranslationRequest {
            run_id: "split-test".into(),
            scope: crate::ai::AiScope::Selected,
            identities: ai_rows.iter().map(|row| row.identity.clone()).collect(),
            include_open: true,
            include_changed: true,
        };
        crate::ai::validate_request_shape(&request).unwrap();
        assert_eq!(
            crate::ai::resolve_scope(&request, &ai_rows).unwrap().len(),
            2
        );
        let mut batch = crate::batch::build_batch("Example.Split", "de", &items);
        for item in &items {
            batch["files"][&item.relative_dir][&item.key] =
                serde_json::json!(if item.key == "hello" {
                    "Hallo @"
                } else {
                    "Los"
                });
        }
        let prepared =
            crate::batch::apply_batch(&batch, "Example.Split", "de", &rows_by_dir).unwrap();
        assert_eq!(prepared.summary.imported, 2);
        let working = translations::language_root(&config, "de").unwrap();
        translations::save_many(&working, "Example.Split", prepared.entries).unwrap();
        let rescanned = scan_mods(&mods, "de", &config);
        assert_eq!(rescanned.mods[0].review_needed, 2);
        assert_eq!(
            files.iter().map(|f| &f.relative_dir).collect::<Vec<_>>(),
            rescanned.mods[0]
                .i18n_files
                .iter()
                .map(|f| &f.relative_dir)
                .collect::<Vec<_>>()
        );
        let inputs: Vec<_> = rescanned.mods[0]
            .i18n_files
            .iter()
            .map(|f| crate::export::ExportFileInput {
                relative_dir: f.relative_dir.clone(),
                default_path: f.default_path.clone(),
                target_path: f.target_path.clone(),
            })
            .collect();
        crate::export::validate_paths(&mods, "de", &inputs).unwrap();
        let exported = crate::export::export_mod(&working, "Example.Split", &inputs).unwrap();
        assert_eq!(exported.total_written_keys, 2);
        assert!(!folder.join("i18n/de.json").exists());
        assert_eq!(
            read_object_checked(&folder.join("i18n/de/Dialogue.json")).unwrap()["hello"],
            "Hallo @"
        );
        std::fs::write(
            folder.join("i18n/default/Dialogue.json"),
            r#"{"hello":"Changed @"}"#,
        )
        .unwrap();
        let changed = scan_mods(&mods, "de", &config);
        assert_eq!(changed.mods[0].status_counts.outdated, 1);
        let state = translations::load(&working, "Example.Split").unwrap();
        let file = changed.mods[0]
            .i18n_files
            .iter()
            .find(|f| f.relative_dir.ends_with("Dialogue.json"))
            .unwrap();
        rows_by_dir.insert(
            file.relative_dir.clone(),
            load_strings_checked(
                Path::new(&file.default_path),
                Path::new(&file.target_path),
                &state,
                &file.relative_dir,
            )
            .unwrap(),
        );
        assert!(crate::batch::apply_batch(&batch, "Example.Split", "de", &rows_by_dir).is_err());
    }

    #[test]
    fn an_i18n_folder_without_a_manifest_is_reported_as_information() {
        let root = crate::test_support::temp_dir("i18n-without-manifest");
        let stray = root.join("Mods/Loose/i18n");
        std::fs::create_dir_all(&stray).unwrap();
        std::fs::write(stray.join("default.json"), r#"{"a":"A"}"#).unwrap();
        let scan = scan_mods(&root.join("Mods"), "de", &root.join("data"));
        assert!(scan.mods.is_empty());
        assert_eq!(scan.skipped_components.len(), 1);
        let skipped = &scan.skipped_components[0];
        assert!(!skipped.requires_attention);
        assert!(skipped.reason.contains("manifest.json"));
        assert!(!skipped
            .relative_location
            .contains(&root.display().to_string()));
        std::fs::remove_dir_all(root).ok();
    }

    fn split_fixture(name: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        let root = crate::test_support::temp_dir(name);
        let moddir = root.join("Mods/Example");
        std::fs::create_dir_all(moddir.join("i18n/default")).unwrap();
        std::fs::create_dir_all(moddir.join("i18n/de")).unwrap();
        std::fs::write(
            moddir.join("manifest.json"),
            r#"{"Name":"Example","UniqueID":"Example.Split","Version":"1.0"}"#,
        )
        .unwrap();
        std::fs::write(
            moddir.join("i18n/default/Dialogue.json"),
            r#"{"dialogue.hello":"Hello"}"#,
        )
        .unwrap();
        std::fs::write(
            moddir.join("i18n/default/Events.json"),
            r#"{"event.start":"Start"}"#,
        )
        .unwrap();
        (root, moddir)
    }

    fn split_targets(scan: &ScanResult) -> HashMap<String, String> {
        scan.mods[0]
            .i18n_files
            .iter()
            .flat_map(|file| {
                load_strings(
                    Path::new(&file.default_path),
                    Path::new(&file.target_path),
                    &ModState::new(),
                    &file.relative_dir,
                )
            })
            .map(|row| (row.key, row.target))
            .collect()
    }

    #[test]
    fn regional_language_folder_wins_per_key_like_smapi() {
        let (root, moddir) = split_fixture("split-regional-folder");
        std::fs::write(
            moddir.join("i18n/default/Dialogue.json"),
            r#"{"dialogue.hello":"Hello","dialogue.bye":"Bye"}"#,
        )
        .unwrap();
        std::fs::write(
            moddir.join("i18n/de/Dialogue.json"),
            r#"{"dialogue.hello":"Hallo alt","dialogue.bye":"Tschüss"}"#,
        )
        .unwrap();
        std::fs::create_dir_all(moddir.join("i18n/de-DE")).unwrap();
        std::fs::write(
            moddir.join("i18n/de-DE/Dialogue.json"),
            r#"{"Dialogue.Hello":"Hallo neu"}"#,
        )
        .unwrap();
        // A document only the regional folder has still counts.
        std::fs::write(
            moddir.join("i18n/de-DE/Events.json"),
            r#"{"event.start":"Los"}"#,
        )
        .unwrap();

        let scan = scan_mods(&root.join("Mods"), "de", &root.join("data"));
        assert!(scan.warnings.is_empty(), "{:?}", scan.warnings);
        assert_eq!(scan.mods[0].translated_keys, 3);
        assert!(scan.mods[0]
            .i18n_files
            .iter()
            .all(|file| file.target_exists));
        let targets = split_targets(&scan);
        assert_eq!(targets["dialogue.hello"], "Hallo neu");
        assert_eq!(targets["dialogue.bye"], "Tschüss");
        assert_eq!(targets["event.start"], "Los");
        assert_eq!(
            regional_target_variant(&moddir.join("i18n/de/Events.json")),
            Some(moddir.join("i18n/de-DE/Events.json"))
        );
        // Document names inside a language folder are never aliases.
        assert!(regional_target_variant(&moddir.join("i18n/de/de.json"))
            .is_some_and(|path| path.ends_with("de-DE/de.json")));
        assert!(regional_target_variant(&moddir.join("i18n/default/Events.json")).is_none());
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn broken_canonical_or_regional_document_is_skipped_and_named() {
        let (root, moddir) = split_fixture("split-regional-broken");
        std::fs::create_dir_all(moddir.join("i18n/de-DE")).unwrap();
        std::fs::write(moddir.join("i18n/de/Dialogue.json"), "{ broken").unwrap();
        std::fs::write(
            moddir.join("i18n/de-DE/Dialogue.json"),
            r#"{"dialogue.hello":"Hallo"}"#,
        )
        .unwrap();
        std::fs::write(
            moddir.join("i18n/de/Events.json"),
            r#"{"event.start":"Los"}"#,
        )
        .unwrap();
        std::fs::write(moddir.join("i18n/de-DE/Events.json"), "{ broken").unwrap();

        let scan = scan_mods(&root.join("Mods"), "de", &root.join("data"));
        assert!(scan.skipped_components.is_empty());
        assert_eq!(scan.mods[0].i18n_files.len(), 2);
        let targets = split_targets(&scan);
        assert_eq!(targets["dialogue.hello"], "Hallo");
        assert_eq!(targets["event.start"], "Los");
        assert_eq!(scan.warnings.len(), 2, "{:?}", scan.warnings);
        assert!(scan.warnings[0].starts_with(
            "Example/i18n/de/Dialogue.json in Example was ignored because it cannot be read:"
        ));
        assert!(scan.warnings[1].starts_with(
            "Example/i18n/de-DE/Events.json in Example was ignored because it cannot be read:"
        ));
        assert!(scan
            .warnings
            .iter()
            .all(|warning| !warning.contains(&root.display().to_string())));
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn broken_flat_regional_file_is_skipped_like_a_broken_canonical_one() {
        let root = crate::test_support::temp_dir("scan-broken-regional-flat");
        let moddir = root.join("Mods/Example");
        let put = |path: &Path, body: &str| {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, body).unwrap();
        };
        put(
            &moddir.join("manifest.json"),
            r#"{"Name":"Example","UniqueID":"Example.Flat"}"#,
        );
        put(&moddir.join("i18n/default.json"), r#"{"k":"Hello"}"#);
        put(&moddir.join("i18n/de.json"), r#"{"k":"Hallo"}"#);
        put(&moddir.join("i18n/de-DE.json"), "{ broken");

        let scan = scan_mods(&root.join("Mods"), "de", &root.join("data"));
        assert!(scan.skipped_components.is_empty());
        assert_eq!(scan.mods[0].translated_keys, 1);
        assert_eq!(scan.warnings.len(), 1);
        assert!(scan.warnings[0].starts_with(
            "Example/i18n/de-DE.json in Example was ignored because it cannot be read:"
        ));

        // With both files broken nothing readable is left: the component is
        // skipped as before.
        put(&moddir.join("i18n/de.json"), "{ broken");
        let scan = scan_mods(&root.join("Mods"), "de", &root.join("data"));
        assert!(scan.mods.is_empty());
        assert_eq!(scan.skipped_components.len(), 1);
        assert!(scan.skipped_components[0].requires_attention);
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn mixed_layout_uses_the_top_level_files_like_smapi() {
        let (root, moddir) = split_fixture("split-mixed-layout");
        std::fs::write(moddir.join("i18n/default.json"), r#"{"top":"Top"}"#).unwrap();
        std::fs::write(moddir.join("i18n/de.json"), r#"{"top":"Oben"}"#).unwrap();
        std::fs::write(
            moddir.join("i18n/de/Dialogue.json"),
            r#"{"dialogue.hello":"Hallo"}"#,
        )
        .unwrap();
        std::fs::write(moddir.join("i18n/de/Broken.json"), "{ broken").unwrap();

        let scan = scan_mods(&root.join("Mods"), "de", &root.join("data"));
        assert!(scan.warnings.is_empty(), "{:?}", scan.warnings);
        let files = &scan.mods[0].i18n_files;
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].relative_dir, "i18n");
        assert_eq!(scan.mods[0].translated_keys, 1);
        assert_eq!(scan.skipped_components.len(), 1);
        let note = &scan.skipped_components[0];
        assert!(!note.requires_attention);
        assert_eq!(note.relative_location, "Example/i18n/default");
        assert_eq!(
            note.reason,
            "The game reads only the translation files directly in the i18n folder, so its language folders, like this one, are not used."
        );

        // Without a top-level default.json the game has no English source to
        // translate here, so nothing loads, and the note stays information.
        std::fs::remove_file(moddir.join("i18n/default.json")).unwrap();
        let scan = scan_mods(&root.join("Mods"), "de", &root.join("data"));
        assert!(scan.mods.is_empty());
        assert_eq!(scan.skipped_components.len(), 1);
        assert!(!scan.skipped_components[0].requires_attention);
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn one_unreadable_split_target_is_reported_once_and_keeps_the_component() {
        let (root, moddir) = split_fixture("split-broken-other");
        std::fs::write(moddir.join("i18n/de/Notes.json"), "{ not json").unwrap();
        let scan = scan_mods(&root.join("Mods"), "de", &root.join("data"));
        assert_eq!(scan.mods[0].i18n_files.len(), 2);
        assert!(scan.skipped_components.is_empty());
        let notes: Vec<_> = scan
            .warnings
            .iter()
            .filter(|warning| warning.contains("Notes.json"))
            .collect();
        assert_eq!(notes.len(), 1);
        assert!(!notes[0].contains(&root.display().to_string()));
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn an_unreadable_same_named_split_target_skips_only_its_document() {
        let (root, moddir) = split_fixture("split-broken-same");
        std::fs::write(moddir.join("i18n/de/Events.json"), "{ not json").unwrap();
        let scan = scan_mods(&root.join("Mods"), "de", &root.join("data"));
        let files = &scan.mods[0].i18n_files;
        assert_eq!(files.len(), 1);
        assert!(files[0].relative_dir.ends_with("Dialogue.json"));
        assert_eq!(scan.skipped_components.len(), 1);
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn utf16_targets_and_non_string_target_values_load() {
        let root = crate::test_support::temp_dir("target-tolerance");
        let i18n = root.join("i18n");
        std::fs::create_dir_all(&i18n).unwrap();
        std::fs::write(
            i18n.join("default.json"),
            r#"{"a":"One","b":"Two","c":"Three","d":"Four"}"#,
        )
        .unwrap();
        let text = r#"{"a":"Eins","b":2,"c":null,"d":{"x":"y"}}"#;
        let utf16: Vec<u8> = [0xFF, 0xFE]
            .into_iter()
            .chain(text.encode_utf16().flat_map(u16::to_le_bytes))
            .collect();
        std::fs::write(i18n.join("de.json"), utf16).unwrap();

        let rows = load_strings_checked(
            &i18n.join("default.json"),
            &i18n.join("de.json"),
            &ModState::new(),
            "i18n",
        )
        .unwrap();
        let target = |key: &str| {
            rows.iter()
                .find(|row| row.key == key)
                .map(|row| row.target.clone())
                .unwrap()
        };
        assert_eq!(target("a"), "Eins");
        assert_eq!(target("b"), "2");
        assert_eq!(target("c"), "");
        assert_eq!(target("d"), "");
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn split_sources_have_stable_units_and_existing_target_membership() {
        let root = crate::test_support::temp_dir("split-locales");
        let moddir = root.join("Mods/Example");
        std::fs::create_dir_all(moddir.join("i18n/default")).unwrap();
        std::fs::create_dir_all(moddir.join("i18n/de")).unwrap();
        std::fs::write(
            moddir.join("manifest.json"),
            r#"{"Name":"Example","UniqueID":"Example.Split","Version":"1.0"}"#,
        )
        .unwrap();
        std::fs::write(
            moddir.join("i18n/default/Dialogue.json"),
            r#"{"dialogue.hello":"Hello"}"#,
        )
        .unwrap();
        std::fs::write(
            moddir.join("i18n/default/Events.json"),
            r#"{"event.start":"Start"}"#,
        )
        .unwrap();
        std::fs::write(
            moddir.join("i18n/de/Other.json"),
            r#"{"dialogue.hello":"Hallo"}"#,
        )
        .unwrap();
        let scan = scan_mods(&root.join("Mods"), "de", &root.join("data"));
        assert_eq!(scan.mods.len(), 1);
        let files = &scan.mods[0].i18n_files;
        assert_eq!(files.len(), 2);
        let dialogue = files
            .iter()
            .find(|f| f.relative_dir.ends_with("Dialogue.json"))
            .unwrap();
        assert!(dialogue.target_path.ends_with("Other.json"));
        assert_eq!(dialogue.total_keys, 1);
        let inputs: Vec<_> = files
            .iter()
            .map(|f| crate::export::ExportFileInput {
                relative_dir: f.relative_dir.clone(),
                default_path: f.default_path.clone(),
                target_path: f.target_path.clone(),
            })
            .collect();
        crate::export::validate_paths(&root.join("Mods"), "de", &inputs).unwrap();
        // A same-named stub or a document holding only removed keys belongs
        // to this segment; only keys owned by another source segment block it.
        for stub in [r#"{}"#, r#"{"unrelated.key":"Elsewhere"}"#] {
            std::fs::write(moddir.join("i18n/de/Events.json"), stub).unwrap();
            assert!(
                split_target_path(&moddir.join("i18n/default/Events.json"), "de")
                    .unwrap()
                    .ends_with("Events.json"),
                "{stub}"
            );
        }
        std::fs::write(
            moddir.join("i18n/de/Events.json"),
            r#"{"dialogue.hello":"Elsewhere"}"#,
        )
        .unwrap();
        assert!(
            split_target_path(&moddir.join("i18n/default/Events.json"), "de")
                .unwrap_err()
                .contains("occupied")
        );
        std::fs::remove_file(moddir.join("i18n/de/Events.json")).unwrap();
        std::fs::write(
            moddir.join("i18n/default/Events.json"),
            r#"{"dialogue.hello":"Duplicate"}"#,
        )
        .unwrap();
        assert!(scan_mods(&root.join("Mods"), "de", &root.join("data"))
            .mods
            .is_empty());
        // With a top-level default.json, SMAPI uses only the top-level files,
        // so the duplicate keys in the language folders no longer matter.
        std::fs::write(moddir.join("i18n/default.json"), "{}").unwrap();
        let mixed = scan_mods(&root.join("Mods"), "de", &root.join("data"));
        assert_eq!(mixed.mods[0].i18n_files.len(), 1);
        assert_eq!(mixed.mods[0].i18n_files[0].relative_dir, "i18n");
    }
}

#[cfg(test)]
mod audit_quick_win_tests {
    use super::*;

    fn write(path: &Path, body: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    #[test]
    fn skip_reason_hides_the_verbatim_prefix_of_canonical_paths() {
        let root = crate::test_support::temp_dir("scan-verbatim-reason");
        std::fs::create_dir_all(&root).unwrap();
        let canonical = std::fs::canonicalize(&root).unwrap();
        let reason = format!(
            "Invalid JSON in {}: expected `,` or `}}`",
            canonical
                .join("Broken")
                .join("i18n")
                .join("default.json")
                .display()
        );
        let safe = safe_skip_reason(&reason, &root);
        assert!(!safe.contains(r"\\?\"), "{safe}");
        assert!(safe.starts_with("Invalid JSON in Mods"), "{safe}");
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn manifest_is_found_regardless_of_filename_case() {
        let root = crate::test_support::temp_dir("scan-manifest-case");
        write(
            &root.join("Cased/Manifest.json"),
            r#"{"UniqueID":"cased.mod"}"#,
        );
        write(&root.join("Cased/i18n/default.json"), r#"{"k":"source"}"#);
        let mut manifests = Vec::new();
        let mut i18n_dirs = Vec::new();
        assert!(collect(&root, &mut manifests, &mut i18n_dirs));
        assert_eq!(manifests.len(), 1, "{manifests:?}");
        assert_eq!(i18n_dirs.len(), 1, "{i18n_dirs:?}");
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn dot_folders_are_skipped_like_smapi_does() {
        let root = crate::test_support::temp_dir("scan-dot-folders");
        write(
            &root.join("Live/manifest.json"),
            r#"{"UniqueID":"same.mod"}"#,
        );
        write(&root.join("Live/i18n/default.json"), r#"{"k":"source"}"#);
        write(
            &root.join(".disabled/Old/manifest.json"),
            r#"{"UniqueID":"same.mod"}"#,
        );
        write(
            &root.join(".disabled/Old/i18n/default.json"),
            r#"{"k":"old"}"#,
        );
        let mut manifests = Vec::new();
        let mut i18n_dirs = Vec::new();
        assert!(collect(&root, &mut manifests, &mut i18n_dirs));
        assert_eq!(manifests.len(), 1, "{manifests:?}");
        assert!(manifests[0].starts_with(root.join("Live")));
        assert_eq!(i18n_dirs.len(), 1, "{i18n_dirs:?}");
        std::fs::remove_dir_all(root).ok();
    }
}

#[cfg(test)]
mod manifest_reason_tests {
    use super::*;

    #[test]
    fn manifest_skip_reasons_are_full_sentences() {
        let root = crate::test_support::temp_dir("manifest-reasons");
        let dir = root.join("Broken");
        std::fs::create_dir_all(&dir).unwrap();
        let manifest = dir.join("manifest.json");

        std::fs::write(&manifest, "[1, 2]").unwrap();
        let error = read_manifest(&manifest, &dir, &root).unwrap_err();
        assert_eq!(
            error,
            "The manifest.json does not contain a JSON object, so this mod was left out."
        );

        std::fs::write(&manifest, "{ not json").unwrap();
        let error = read_manifest(&manifest, &dir, &root).unwrap_err();
        assert!(error.starts_with("The manifest.json is not valid JSON ("));
        assert!(error.ends_with("), so this mod was left out."));

        std::fs::remove_file(&manifest).unwrap();
        let error = read_manifest(&manifest, &dir, &root).unwrap_err();
        assert!(error.starts_with("The manifest.json could not be read ("));

        let _ = std::fs::remove_dir_all(&root);
    }
}
