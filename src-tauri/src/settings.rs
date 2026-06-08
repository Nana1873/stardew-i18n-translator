//! Persisted application settings (SPEC §14).
//!
//! Stored as a single `settings.json` in the app config directory. Loading is
//! lenient: a missing or unreadable file yields defaults so the app always starts.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const SETTINGS_FILE: &str = "settings.json";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default)]
    pub stardew_path: Option<String>,
    #[serde(default)]
    pub mods_path: Option<String>,
    /// Source language is fixed to English (`default`) for v1.
    #[serde(default = "default_source_lang")]
    pub source_lang: String,
    #[serde(default)]
    pub target_lang: Option<String>,
}

fn default_source_lang() -> String {
    "default".to_string()
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            stardew_path: None,
            mods_path: None,
            source_lang: default_source_lang(),
            target_lang: None,
        }
    }
}

pub fn settings_path(config_dir: &Path) -> PathBuf {
    config_dir.join(SETTINGS_FILE)
}

/// Load settings from `config_dir`, falling back to defaults if the file is
/// absent or cannot be parsed.
pub fn load(config_dir: &Path) -> AppSettings {
    match std::fs::read_to_string(settings_path(config_dir)) {
        Ok(body) => serde_json::from_str(&body).unwrap_or_default(),
        Err(_) => AppSettings::default(),
    }
}

/// Persist settings to `config_dir`, creating the directory if needed.
pub fn save(config_dir: &Path, settings: &AppSettings) -> Result<(), String> {
    std::fs::create_dir_all(config_dir)
        .map_err(|error| format!("Could not create config directory: {error}"))?;
    let body = serde_json::to_string_pretty(settings)
        .map_err(|error| format!("Could not serialize settings: {error}"))?;
    std::fs::write(settings_path(config_dir), body)
        .map_err(|error| format!("Could not write settings: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_source_language_is_english() {
        assert_eq!(AppSettings::default().source_lang, "default");
        assert!(AppSettings::default().target_lang.is_none());
    }

    #[test]
    fn missing_file_yields_defaults() {
        let dir = crate::test_support::temp_dir("settings-missing");
        assert_eq!(load(&dir), AppSettings::default());
    }

    #[test]
    fn save_then_load_roundtrips() {
        let dir = crate::test_support::temp_dir("settings-roundtrip");
        let settings = AppSettings {
            stardew_path: Some(r"E:\SteamLibrary\steamapps\common\Stardew Valley".to_string()),
            mods_path: Some(r"E:\SteamLibrary\steamapps\common\Stardew Valley\Mods".to_string()),
            source_lang: "default".to_string(),
            target_lang: Some("de".to_string()),
        };
        save(&dir, &settings).unwrap();
        assert_eq!(load(&dir), settings);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn malformed_file_yields_defaults() {
        let dir = crate::test_support::temp_dir("settings-malformed");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(settings_path(&dir), "{ not json").unwrap();
        assert_eq!(load(&dir), AppSettings::default());
        std::fs::remove_dir_all(&dir).ok();
    }
}
