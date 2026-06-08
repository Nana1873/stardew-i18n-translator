//! Persisted translation state — M2 / Issue 10 (SPEC §14).
//!
//! Work-in-progress translations are stored **separately** from the mod's own
//! files: one JSON per mod (keyed by UniqueID) in the app config directory.
//! The mod's `default.json` is never touched; export (M3) writes the final
//! `i18n/<lang>.json`. Each entry records the target text, its status, and a
//! hash of the source text at save time (for `outdated` detection on re-scan).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

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

/// Load a mod's saved state (empty if none / unreadable).
pub fn load(config_dir: &Path, unique_id: &str) -> ModState {
    match std::fs::read_to_string(state_path(config_dir, unique_id)) {
        Ok(body) => serde_json::from_str(&body).unwrap_or_default(),
        Err(_) => ModState::new(),
    }
}

fn save(config_dir: &Path, unique_id: &str, state: &ModState) -> Result<(), String> {
    let path = state_path(config_dir, unique_id);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create translations dir: {error}"))?;
    }
    let body = serde_json::to_string_pretty(state)
        .map_err(|error| format!("Could not serialize translation state: {error}"))?;
    std::fs::write(path, body).map_err(|error| format!("Could not write translation state: {error}"))
}

/// Upsert a single string's saved state.
pub fn save_one(
    config_dir: &Path,
    unique_id: &str,
    key: String,
    entry: StoredString,
) -> Result<(), String> {
    let mut state = load(config_dir, unique_id);
    state.insert(key, entry);
    save(config_dir, unique_id, &state)
}

#[cfg(test)]
mod tests {
    use super::*;

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
        save_one(&dir, "Some.Mod", entry_key("i18n", "greeting"), entry.clone()).unwrap();

        let state = load(&dir, "Some.Mod");
        assert_eq!(state.get(&entry_key("i18n", "greeting")), Some(&entry));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unknown_mod_yields_empty_state() {
        let dir = crate::test_support::temp_dir("translations-empty");
        assert!(load(&dir, "Nope").is_empty());
    }
}
