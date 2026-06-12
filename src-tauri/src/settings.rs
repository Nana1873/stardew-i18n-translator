//! Persisted application settings (SPEC §14).
//!
//! Stored as `Data/settings.json` beside the portable executable. Loading is
//! lenient: a missing or unreadable file yields defaults so the app always starts.

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

const SETTINGS_FILE: &str = "settings.json";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
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
    /// Optional local-LLM connection (M6). Absent when AI translation is not set up.
    #[serde(default)]
    pub llm: Option<LlmSettings>,
    /// User overrides for the frontend shortcut catalog (v1.1).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub shortcuts: BTreeMap<String, String>,
}

/// Local-LLM connection settings (M6, Issue 15). OpenAI-compatible endpoint only.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LlmSettings {
    /// UI preset hint: `"lmstudio"`, `"ollama"`, or `"custom"`. Not used by the
    /// backend (the base URL is authoritative) — kept so the wizard can restore it.
    #[serde(default)]
    pub provider: String,
    /// OpenAI-compatible base URL, e.g. `http://localhost:1234/v1`.
    #[serde(default)]
    pub base_url: String,
    /// Selected model id (from `GET /v1/models`).
    #[serde(default)]
    pub model: String,
    /// Optional sampling temperature (M6 scope). `None` = the default (0.2,
    /// low — translation wants consistency, not creativity).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
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
            llm: None,
            shortcuts: BTreeMap::new(),
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
            llm: None,
            shortcuts: BTreeMap::from([("editor.save".to_string(), "Ctrl+S".to_string())]),
        };
        save(&dir, &settings).unwrap();
        assert_eq!(load(&dir), settings);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn llm_settings_roundtrip() {
        let dir = crate::test_support::temp_dir("settings-llm");
        let settings = AppSettings {
            llm: Some(LlmSettings {
                provider: "lmstudio".to_string(),
                base_url: "http://localhost:1234/v1".to_string(),
                model: "llama3.1:8b".to_string(),
                temperature: Some(0.4),
            }),
            ..AppSettings::default()
        };
        save(&dir, &settings).unwrap();
        assert_eq!(load(&dir), settings);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn llm_settings_without_temperature_load_with_none() {
        // An llm block written before the temperature field existed must load.
        let dir = crate::test_support::temp_dir("settings-no-temp");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            settings_path(&dir),
            r#"{"llm":{"provider":"ollama","baseUrl":"http://localhost:11434/v1","model":"qwen2.5"}}"#,
        )
        .unwrap();
        let llm = load(&dir).llm.unwrap();
        assert_eq!(llm.temperature, None);
        assert_eq!(llm.model, "qwen2.5");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn settings_without_llm_field_load_with_none() {
        // A settings.json written before M6 has no `llm` key — it must still load.
        let dir = crate::test_support::temp_dir("settings-no-llm");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            settings_path(&dir),
            r#"{"stardewPath":"X","modsPath":"Y","sourceLang":"default","targetLang":"de"}"#,
        )
        .unwrap();
        assert_eq!(load(&dir).llm, None);
        assert!(load(&dir).shortcuts.is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn settings_without_shortcuts_load_with_empty_overrides() {
        let dir = crate::test_support::temp_dir("settings-no-shortcuts");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            settings_path(&dir),
            r#"{"sourceLang":"default","targetLang":"de"}"#,
        )
        .unwrap();
        assert!(load(&dir).shortcuts.is_empty());
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
