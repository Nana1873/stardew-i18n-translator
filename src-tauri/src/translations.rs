//! Persisted translation state — M2 / Issue 10 (SPEC §14).
//!
//! Work-in-progress translations are stored **separately** from the mod's own
//! files: one JSON per mod (keyed by UniqueID) and target language in the
//! portable `Data/` folder. The mod's `default.json` is never touched; export
//! (M3) writes the final `i18n/<lang>.json`. Each entry records the target text,
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
/// `Data/translations/` folder is moved once into the first active language,
/// which is the language stored in settings when upgrading.
pub fn language_root(config_dir: &Path, target_lang: &str) -> Result<PathBuf, String> {
    let safe_lang: String = target_lang
        .trim()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect();
    if safe_lang.is_empty() {
        return Err("A target language is required for translation state.".to_string());
    }
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
    match std::fs::read_to_string(&path) {
        Ok(body) => serde_json::from_str(&body).map_err(|error| {
            format!(
                "Saved translation state for {unique_id} is corrupted ({}): {error}. \
                 The file is left untouched — restore it from the .bak sibling or \
                 remove it to start over.",
                path.display()
            )
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(ModState::new()),
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
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create translations dir: {error}"))?;
    }
    let body = serde_json::to_string_pretty(state)
        .map_err(|error| format!("Could not serialize translation state: {error}"))?;
    // Defensive: re-parse what we are about to write (mirrors export.rs).
    serde_json::from_str::<ModState>(&body)
        .map_err(|error| format!("Generated invalid translation state JSON: {error}"))?;

    if path.is_file() && backed_up.insert(path.to_path_buf()) {
        std::fs::copy(path, sibling(path, ".bak"))
            .map_err(|error| format!("Could not back up {}: {error}", path.display()))?;
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
