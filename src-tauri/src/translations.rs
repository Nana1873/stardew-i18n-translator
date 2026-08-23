//! Persisted translation state (SPEC §14).
//!
//! Work-in-progress translations are stored **separately** from the mod's own
//! files: one JSON per mod (keyed by UniqueID) and target language in the
//! portable `data/` folder. The mod's `default.json` is never touched; export
//! writes the final `i18n/<lang>.json`. Each entry records the target text,
//! its status, and a hash of the source text at save time (for `outdated`
//! detection on re-scan).
//!
//! Safety rules (this file holds the user's only copy of their work):
//!  - Writes are **serialized** by a process-wide lock — concurrent bulk saves
//!    must never interleave their load-modify-write cycles (lost updates).
//!  - Writes are **atomic**: serialize → verify → `.tmp` sibling → rename.
//!  - The first overwrite of an existing state file per session copies it to
//!    `<file>.bak` first.
//!  - A corrupted state file is a **loud error**, never silently treated as
//!    empty — and it is never overwritten by a subsequent save.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoredString {
    pub target: String,
    pub status: String,
    /// SHA-256 of the source text when this entry was last saved.
    pub source_hash: String,
}

/// Stored status used when the translator explicitly accepts a protected-token
/// mismatch. The scanner exposes it as the normal `translated` status while
/// retaining the export waiver for the exact saved source text.
pub const TOKEN_MISMATCH_ACCEPTED_STATUS: &str = "translated-token-mismatch-accepted";

/// Per-mod state: entry key -> stored translation.
pub type ModState = HashMap<String, StoredString>;

/// SHA-256 hex of a source string (for outdated detection).
pub fn source_hash(text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// Composite key for a string within a mod: `<relativeDir>\0<key>`.
pub fn entry_key(relative_dir: &str, key: &str) -> String {
    format!("{relative_dir}\u{0}{key}")
}

/// Return the isolated state root for one target language. A pre-v1.1
/// `data/translations/` folder is moved once into the first active language,
/// which is the language stored in settings when upgrading.
pub fn language_root(config_dir: &Path, target_lang: &str) -> Result<PathBuf, String> {
    let safe_lang = crate::language::normalize_target_code(target_lang)?;
    let root = config_dir.join("language-state").join(safe_lang);
    let legacy = config_dir.join("translations");
    let destination = root.join("translations");
    if legacy.is_dir() && !destination.exists() {
        std::fs::create_dir_all(&root).map_err(|error| {
            format!(
                "Could not prepare language-specific translation state {}: {error}",
                root.display()
            )
        })?;
        std::fs::rename(&legacy, &destination).map_err(|error| {
            format!(
                "Could not migrate translation state from {} to {}: {error}",
                legacy.display(),
                destination.display()
            )
        })?;
    }
    Ok(root)
}

/// Process-wide write guard: serializes every load-modify-write cycle and
/// remembers which state files were already backed up this session.
fn write_guard() -> &'static Mutex<HashSet<PathBuf>> {
    static GUARD: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    GUARD.get_or_init(|| Mutex::new(HashSet::new()))
}

fn state_path(config_dir: &Path, unique_id: &str) -> PathBuf {
    if is_safe_windows_stem(unique_id) {
        return config_dir
            .join("translations")
            .join(format!("{unique_id}.json"));
    }
    let mut hasher = Sha256::new();
    hasher.update(unique_id.as_bytes());
    config_dir
        .join("translations")
        .join(format!("state-{:x}.json", hasher.finalize()))
}

fn legacy_state_path(config_dir: &Path, unique_id: &str) -> PathBuf {
    let safe: String = unique_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect();
    config_dir.join("translations").join(format!("{safe}.json"))
}

fn is_safe_windows_stem(value: &str) -> bool {
    if value.is_empty()
        || value.len() > 240
        || value.ends_with([' ', '.'])
        || !value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
    {
        return false;
    }
    let base = value
        .split('.')
        .next()
        .unwrap_or(value)
        .to_ascii_uppercase();
    !matches!(
        base.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    )
}

pub fn prepare_state_paths(
    config_dir: &Path,
    unique_ids: &[String],
) -> (HashSet<String>, Vec<String>) {
    let mut blocked = HashSet::new();
    let mut warnings = Vec::new();
    let mut by_id: std::collections::BTreeMap<String, Vec<&String>> =
        std::collections::BTreeMap::new();
    let mut by_legacy: std::collections::BTreeMap<String, Vec<&String>> =
        std::collections::BTreeMap::new();
    for id in unique_ids {
        by_id.entry(id.to_lowercase()).or_default().push(id);
        let legacy = legacy_state_path(config_dir, id)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .to_lowercase();
        by_legacy.entry(legacy).or_default().push(id);
    }
    for ids in by_id.values().filter(|ids| ids.len() > 1) {
        for id in ids {
            blocked.insert(id.to_lowercase());
        }
        warnings.push(format!(
            "Case-insensitive duplicate mod UniqueID: {}. Their translation files were excluded until the duplicate is removed.",
            ids.iter().map(|id| id.as_str()).collect::<Vec<_>>().join(", ")
        ));
    }
    for ids in by_legacy.values().filter(|ids| ids.len() > 1) {
        if ids.iter().any(|id| !is_safe_windows_stem(id)) {
            for id in ids {
                blocked.insert(id.to_lowercase());
            }
            warnings.push(format!(
                "Multiple mods map to the same legacy translation-state file: {}. No state was migrated or opened for writing.",
                ids.iter().map(|id| id.as_str()).collect::<Vec<_>>().join(", ")
            ));
        }
    }
    for id in unique_ids {
        if blocked.contains(&id.to_lowercase()) || is_safe_windows_stem(id) {
            continue;
        }
        let legacy = legacy_state_path(config_dir, id);
        let destination = state_path(config_dir, id);
        if !legacy.is_file() || destination.exists() {
            continue;
        }
        let migration = crate::input_limits::read_json_text(&legacy)
            .and_then(|body| {
                serde_json::from_str::<ModState>(&body)
                    .map(|_| body)
                    .map_err(|error| error.to_string())
            })
            .and_then(|body| {
                if let Some(parent) = destination.parent() {
                    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
                }
                let temp = sibling(&destination, ".tmp");
                std::fs::write(&temp, body).map_err(|error| error.to_string())?;
                std::fs::rename(&temp, &destination).map_err(|error| error.to_string())
            });
        if let Err(error) = migration {
            blocked.insert(id.to_lowercase());
            warnings.push(format!(
                "Could not safely migrate translation state for {id}: {error}. The legacy file was left untouched."
            ));
        }
    }
    (blocked, warnings)
}

/// A sibling path with `suffix` appended to the full file name
/// (`Some.Mod.json` + `.bak` -> `Some.Mod.json.bak`).
fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(suffix);
    path.with_file_name(name)
}

/// Load a mod's saved state. A missing file is an empty state; an unreadable
/// or unparseable file is a **loud error** (the UI must show it instead of
/// silently presenting everything as untranslated — and saves must refuse to
/// overwrite the file while it is in this condition).
pub fn load(config_dir: &Path, unique_id: &str) -> Result<ModState, String> {
    let path = state_path(config_dir, unique_id);
    if !path.exists() {
        return Ok(ModState::new());
    }
    match crate::input_limits::read_json_text(&path) {
        Ok(body) => serde_json::from_str(&body).map_err(|error| {
            format!(
                "Saved translation state for {unique_id} is corrupted ({}): {error}. \
                 The file is left untouched — restore it from the .bak sibling or \
                 remove it to start over.",
                path.display()
            )
        }),
        Err(error) => Err(format!(
            "Could not read translation state {}: {error}",
            path.display()
        )),
    }
}

/// Serialize `state` and write it to `path` safely: verify the JSON, back up an
/// existing file once per session, write a `.tmp` sibling, rename over the
/// target. Callers must hold the write guard.
fn write_state(
    path: &Path,
    state: &ModState,
    backed_up: &mut HashSet<PathBuf>,
) -> Result<(), String> {
    let body = serde_json::to_string_pretty(state)
        .map_err(|error| format!("Could not serialize translation state: {error}"))?;
    crate::input_limits::ensure_json_output_size(body.len() as u64, "Translation state")?;
    // Defensive: re-parse what we are about to write (mirrors export.rs).
    serde_json::from_str::<ModState>(&body)
        .map_err(|error| format!("Generated invalid translation state JSON: {error}"))?;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create translations dir: {error}"))?;
    }

    if path.is_file() && !backed_up.contains(path) {
        std::fs::copy(path, sibling(path, ".bak"))
            .map_err(|error| format!("Could not back up {}: {error}", path.display()))?;
        backed_up.insert(path.to_path_buf());
    }

    let temp = sibling(path, ".tmp");
    std::fs::write(&temp, body.as_bytes())
        .map_err(|error| format!("Could not write temp state file: {error}"))?;
    std::fs::rename(&temp, path)
        .map_err(|error| format!("Could not finalize {}: {error}", path.display()))
}

/// Upsert a single string's saved state (one serialized load-modify-write).
pub fn save_one(
    config_dir: &Path,
    unique_id: &str,
    key: String,
    entry: StoredString,
) -> Result<(), String> {
    save_many(config_dir, unique_id, vec![(key, entry)])
}

/// Upsert many strings in **one** load-modify-write cycle, serialized against
/// every other save in this process. This is the bulk-action path: N parallel
/// `save_one` calls would race their read-modify-write cycles and lose updates.
pub fn save_many(
    config_dir: &Path,
    unique_id: &str,
    entries: Vec<(String, StoredString)>,
) -> Result<(), String> {
    let mut backed_up = write_guard()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut state = load(config_dir, unique_id)?;
    for (key, entry) in entries {
        state.insert(key, entry);
    }
    write_state(&state_path(config_dir, unique_id), &state, &mut backed_up)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(target: &str) -> StoredString {
        StoredString {
            target: target.into(),
            status: "translated".into(),
            source_hash: source_hash("Hello"),
        }
    }

    #[test]
    fn hash_is_stable_and_distinct() {
        assert_eq!(source_hash("hello"), source_hash("hello"));
        assert_ne!(source_hash("hello"), source_hash("hello!"));
    }

    #[test]
    fn save_one_then_load_roundtrips() {
        let dir = crate::test_support::temp_dir("translations");
        let entry = StoredString {
            target: "Hallo".into(),
            status: "done".into(),
            source_hash: source_hash("Hello"),
        };
        save_one(
            &dir,
            "Some.Mod",
            entry_key("i18n", "greeting"),
            entry.clone(),
        )
        .unwrap();

        let state = load(&dir, "Some.Mod").unwrap();
        assert_eq!(state.get(&entry_key("i18n", "greeting")), Some(&entry));
        // No temp file is left behind.
        assert!(!sibling(&state_path(&dir, "Some.Mod"), ".tmp").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unknown_mod_yields_empty_state() {
        let dir = crate::test_support::temp_dir("translations-empty");
        assert!(load(&dir, "Nope").unwrap().is_empty());
    }

    #[test]
    fn unsafe_id_uses_hash_and_migrates_one_valid_legacy_file_without_deleting_it() {
        let dir = crate::test_support::temp_dir("translations-hashed-migration");
        let id = "Author/Unsafe";
        let legacy = legacy_state_path(&dir, id);
        std::fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        let state = ModState::from([(entry_key("i18n", "k"), entry("Alt"))]);
        std::fs::write(&legacy, serde_json::to_string(&state).unwrap()).unwrap();

        let (blocked, warnings) = prepare_state_paths(&dir, &[id.to_string()]);
        assert!(blocked.is_empty(), "{warnings:?}");
        assert!(legacy.is_file(), "legacy state remains recoverable");
        let destination = state_path(&dir, id);
        assert!(destination
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("state-"));
        assert_eq!(load(&dir, id).unwrap(), state);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn colliding_legacy_paths_are_blocked_without_migration() {
        let dir = crate::test_support::temp_dir("translations-colliding-migration");
        let ids = vec!["Author/A".to_string(), "Author?A".to_string()];
        let legacy = legacy_state_path(&dir, &ids[0]);
        std::fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        std::fs::write(&legacy, "{}").unwrap();

        let (blocked, warnings) = prepare_state_paths(&dir, &ids);
        assert_eq!(blocked.len(), 2, "{warnings:?}");
        assert!(ids.iter().all(|id| !state_path(&dir, id).exists()));
        assert!(legacy.is_file());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn failed_backup_can_be_retried_successfully() {
        let dir = crate::test_support::temp_dir("translations-backup-retry");
        save_one(&dir, "Retry.Mod", entry_key("i18n", "a"), entry("A")).unwrap();
        let path = state_path(&dir, "Retry.Mod");
        let backup = sibling(&path, ".bak");
        std::fs::create_dir_all(&backup).unwrap();
        assert!(save_one(&dir, "Retry.Mod", entry_key("i18n", "b"), entry("B")).is_err());
        std::fs::remove_dir(&backup).unwrap();
        save_one(&dir, "Retry.Mod", entry_key("i18n", "b"), entry("B")).unwrap();
        assert!(backup.is_file());
        assert_eq!(load(&dir, "Retry.Mod").unwrap().len(), 2);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn save_many_persists_all_entries_in_one_write() {
        let dir = crate::test_support::temp_dir("translations-many");
        let entries: Vec<_> = (0..50)
            .map(|i| (entry_key("i18n", &format!("k{i}")), entry(&format!("v{i}"))))
            .collect();
        save_many(&dir, "Bulk.Mod", entries).unwrap();
        let state = load(&dir, "Bulk.Mod").unwrap();
        assert_eq!(state.len(), 50);
        assert_eq!(state.get(&entry_key("i18n", "k7")).unwrap().target, "v7");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn language_roots_isolate_state_and_migrate_legacy_once() {
        let dir = crate::test_support::temp_dir("translations-languages");
        save_one(&dir, "mod.id", entry_key("i18n", "k"), entry("Deutsch")).unwrap();

        let german = language_root(&dir, "de").unwrap();
        assert_eq!(
            load(&german, "mod.id").unwrap()[&entry_key("i18n", "k")].target,
            "Deutsch"
        );
        assert!(!dir.join("translations").exists());

        let japanese = language_root(&dir, "ja").unwrap();
        assert!(load(&japanese, "mod.id").unwrap().is_empty());
        save_one(&japanese, "mod.id", entry_key("i18n", "k"), entry("日本語")).unwrap();

        assert_eq!(
            load(&german, "mod.id").unwrap()[&entry_key("i18n", "k")].target,
            "Deutsch"
        );
        assert_eq!(
            load(&japanese, "mod.id").unwrap()[&entry_key("i18n", "k")].target,
            "日本語"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn concurrent_saves_lose_no_updates() {
        // 32 threads each upsert a distinct key into the SAME state file. Without
        // the process-wide write guard, racing load-modify-write cycles drop
        // entries; with it, every key must survive.
        let dir = crate::test_support::temp_dir("translations-concurrent");
        let handles: Vec<_> = (0..32)
            .map(|i| {
                let dir = dir.clone();
                std::thread::spawn(move || {
                    save_one(
                        &dir,
                        "Race.Mod",
                        entry_key("i18n", &format!("k{i}")),
                        entry(&format!("v{i}")),
                    )
                    .unwrap();
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }
        let state = load(&dir, "Race.Mod").unwrap();
        assert_eq!(state.len(), 32, "every concurrent save must persist");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn corrupt_state_errors_loudly_and_is_never_overwritten() {
        let dir = crate::test_support::temp_dir("translations-corrupt");
        let path = state_path(&dir, "Broken.Mod");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{ not json").unwrap();

        // Load is a loud error, not a silent empty state.
        let err = load(&dir, "Broken.Mod").unwrap_err();
        assert!(err.contains("corrupted"), "unexpected error: {err}");

        // A save must refuse to clobber the corrupted (recoverable) file.
        let result = save_one(&dir, "Broken.Mod", entry_key("i18n", "k"), entry("v"));
        assert!(result.is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ not json");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn oversized_state_errors_before_read_and_is_never_overwritten() {
        let dir = crate::test_support::temp_dir("translations-oversized");
        let path = state_path(&dir, "Large.Mod");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(crate::input_limits::MAX_JSON_BYTES + 1)
            .unwrap();

        let error = load(&dir, "Large.Mod").unwrap_err();
        assert!(error.contains("64 MiB"), "unexpected error: {error}");
        assert!(save_one(&dir, "Large.Mod", entry_key("i18n", "k"), entry("v")).is_err());
        assert_eq!(
            std::fs::metadata(&path).unwrap().len(),
            crate::input_limits::MAX_JSON_BYTES + 1
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn oversized_save_leaves_existing_state_untouched() {
        let dir = crate::test_support::temp_dir("translations-oversized-save");
        let unique_id = "Large.Save.Mod";
        let old_key = entry_key("i18n", "old");
        let old_entry = entry("Bestehend");
        save_one(&dir, unique_id, old_key.clone(), old_entry.clone()).unwrap();

        let path = state_path(&dir, unique_id);
        let before = std::fs::read(&path).unwrap();
        let oversized = StoredString {
            // One value is the lowest-overhead way to cross the real file
            // boundary while exercising serialization and the public save path.
            target: "x".repeat(crate::input_limits::MAX_JSON_BYTES as usize),
            status: "translated".to_string(),
            source_hash: source_hash("Large source"),
        };

        let error =
            save_one(&dir, unique_id, entry_key("i18n", "too-large"), oversized).unwrap_err();
        assert!(error.contains("64 MiB"), "unexpected error: {error}");
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(
            load(&dir, unique_id).unwrap().get(&old_key),
            Some(&old_entry)
        );
        assert!(!sibling(&path, ".bak").exists());
        assert!(!sibling(&path, ".tmp").exists());

        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn first_overwrite_of_a_session_creates_a_backup() {
        let dir = crate::test_support::temp_dir("translations-backup");
        let path = state_path(&dir, "Backup.Mod");
        let bak = sibling(&path, ".bak");

        // First save creates the file — nothing to back up yet.
        save_one(&dir, "Backup.Mod", entry_key("i18n", "k1"), entry("v1")).unwrap();
        assert!(!bak.exists());

        // Second save overwrites — the pre-overwrite content lands in .bak.
        save_one(&dir, "Backup.Mod", entry_key("i18n", "k2"), entry("v2")).unwrap();
        let backup: ModState =
            serde_json::from_str(&std::fs::read_to_string(&bak).unwrap()).unwrap();
        assert!(backup.contains_key(&entry_key("i18n", "k1")));
        assert!(!backup.contains_key(&entry_key("i18n", "k2")));
        std::fs::remove_dir_all(&dir).ok();
    }
}
