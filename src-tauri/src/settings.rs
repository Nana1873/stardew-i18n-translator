//! Persisted application settings (SPEC §14).
//!
//! Stored as `data/settings.json` beside the portable executable. This file
//! holds the user's whole configuration (folders, target language, the local-AI
//! connection), so writes follow the same crash-safe rules as the translation
//! state (translations.rs / export.rs):
//!  - Writes are **atomic**: serialize → verify → `.tmp` sibling → rename.
//!  - Each overwrite first copies the **last valid** file to `settings.json.bak`
//!    (a corrupt main file is never copied over a good backup).
//!  - A corrupt main file is recovered from the `.bak` (controlled recovery);
//!    only when both are unusable does loading surface a **visible error**
//!    ([`load_checked`]) instead of silently resetting to defaults.
//!
//! A genuinely missing file (first run) is not an error — it yields defaults.

use std::{
    collections::BTreeMap,
    io::ErrorKind,
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
    /// Local diagnostic log files are enabled by default. This never controls
    /// telemetry or network reporting; those do not exist.
    #[serde(default = "default_diagnostic_logging")]
    pub diagnostic_logging: bool,
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

fn default_diagnostic_logging() -> bool {
    true
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
            diagnostic_logging: true,
        }
    }
}

pub fn settings_path(config_dir: &Path) -> PathBuf {
    config_dir.join(SETTINGS_FILE)
}

/// A sibling path with `suffix` appended to the full file name
/// (`settings.json` + `.bak` -> `settings.json.bak`).
fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(suffix);
    path.with_file_name(name)
}

/// Load settings best-effort, falling back to defaults when no usable file
/// exists. This is the infallible entry point for internal bootstrap callers
/// (diagnostic-logging setup, the target-language lookup). It still recovers a
/// corrupt main file from the `.bak`; only when **both** are unusable does it
/// degrade to defaults. The user-facing `load_settings` command uses
/// [`load_checked`] instead, so that both-corrupt case surfaces as an error
/// rather than a silent reset.
pub fn load(config_dir: &Path) -> AppSettings {
    load_checked(config_dir).unwrap_or_default()
}

/// Load settings, distinguishing a genuine first run (no file → defaults) from
/// a corrupted file. A corrupt main `settings.json` is recovered from
/// `settings.json.bak` when that backup is valid; if both are unusable the
/// error is returned so the caller can surface it (no silent data loss).
pub fn load_checked(config_dir: &Path) -> Result<AppSettings, String> {
    let path = settings_path(config_dir);
    match std::fs::read_to_string(&path) {
        Ok(body) => match serde_json::from_str(&body) {
            Ok(settings) => Ok(settings),
            // Main file is corrupt — try the backup before giving up.
            Err(parse_error) => recover_from_backup(&path, &parse_error.to_string()),
        },
        // No file at all: a fresh portable folder starts with defaults.
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(AppSettings::default()),
        // The main file exists but cannot be read — try the backup, then fail.
        Err(io_error) => recover_from_backup(&path, &io_error.to_string()),
    }
}

/// Recover settings from the `.bak` sibling of `path` when the main file is
/// unusable. Returns the recovered settings, or a visible error naming both
/// failures when the backup is missing or also corrupt.
fn recover_from_backup(path: &Path, main_error: &str) -> Result<AppSettings, String> {
    let backup = sibling(path, ".bak");
    match std::fs::read_to_string(&backup) {
        Ok(body) => match serde_json::from_str(&body) {
            Ok(settings) => {
                log::warn!(
                    "settings.json unusable ({main_error}); recovered from {}",
                    backup.display()
                );
                Ok(settings)
            }
            Err(backup_error) => Err(format!(
                "Settings file {} is corrupted ({main_error}) and its backup {} is \
                 also corrupted ({backup_error}). Fix or remove the file to start over.",
                path.display(),
                backup.display()
            )),
        },
        Err(backup_error) => Err(format!(
            "Settings file {} is corrupted ({main_error}) and no usable backup exists \
             ({backup_error}). Fix or remove the file to start over.",
            path.display()
        )),
    }
}

/// Persist settings to `config_dir`, creating the directory if needed. Crash
/// safe: the previous **valid** file is backed up to `settings.json.bak`, the
/// new content is verified and written to a `.tmp` sibling, then renamed over
/// the target (atomic on the same volume).
pub fn save(config_dir: &Path, settings: &AppSettings) -> Result<(), String> {
    std::fs::create_dir_all(config_dir)
        .map_err(|error| format!("Could not create config directory: {error}"))?;
    let body = serde_json::to_string_pretty(settings)
        .map_err(|error| format!("Could not serialize settings: {error}"))?;
    // Defensive: re-parse what we are about to write (mirrors translations.rs).
    serde_json::from_str::<AppSettings>(&body)
        .map_err(|error| format!("Generated invalid settings JSON: {error}"))?;

    let path = settings_path(config_dir);
    // Back up only a *valid* existing file, so a corrupt main never clobbers a
    // good backup that loading would otherwise recover from.
    if existing_file_is_valid(&path) {
        std::fs::copy(&path, sibling(&path, ".bak"))
            .map_err(|error| format!("Could not back up {}: {error}", path.display()))?;
    }

    let temp = sibling(&path, ".tmp");
    std::fs::write(&temp, body.as_bytes())
        .map_err(|error| format!("Could not write temp settings file: {error}"))?;
    std::fs::rename(&temp, &path)
        .map_err(|error| format!("Could not finalize {}: {error}", path.display()))
}

/// Whether `path` is an existing file that parses as valid settings.
fn existing_file_is_valid(path: &Path) -> bool {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|body| serde_json::from_str::<AppSettings>(&body).ok())
        .is_some()
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
            diagnostic_logging: false,
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
        assert!(load(&dir).diagnostic_logging);
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
        assert!(load(&dir).diagnostic_logging);
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

    fn sample(target: &str) -> AppSettings {
        AppSettings {
            target_lang: Some(target.to_string()),
            ..AppSettings::default()
        }
    }

    #[test]
    fn first_save_creates_no_backup() {
        // Nothing to back up yet: the first save writes only settings.json.
        let dir = crate::test_support::temp_dir("settings-first-save");
        save(&dir, &sample("de")).unwrap();

        let path = settings_path(&dir);
        assert!(path.is_file(), "settings.json must be written");
        assert!(!sibling(&path, ".bak").exists(), "no backup on first save");
        assert!(!sibling(&path, ".tmp").exists(), "no temp file left behind");
        assert_eq!(load(&dir), sample("de"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn overwrite_backs_up_previous_valid_content() {
        // The second save copies the previous valid file to .bak first.
        let dir = crate::test_support::temp_dir("settings-overwrite-backup");
        save(&dir, &sample("de")).unwrap();
        save(&dir, &sample("fr")).unwrap();

        let path = settings_path(&dir);
        let bak = sibling(&path, ".bak");
        let backup: AppSettings =
            serde_json::from_str(&std::fs::read_to_string(&bak).unwrap()).unwrap();
        assert_eq!(backup, sample("de"), "backup holds the pre-overwrite value");
        assert_eq!(load(&dir), sample("fr"), "main holds the new value");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_checked_reads_a_valid_file() {
        let dir = crate::test_support::temp_dir("settings-load-valid");
        save(&dir, &sample("es")).unwrap();
        assert_eq!(load_checked(&dir).unwrap(), sample("es"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn corrupt_main_recovers_from_valid_backup() {
        // A truncated/corrupt settings.json with a good .bak is recovered
        // transparently — never silently reset to defaults.
        let dir = crate::test_support::temp_dir("settings-recover");
        std::fs::create_dir_all(&dir).unwrap();
        let path = settings_path(&dir);
        std::fs::write(&path, "{ truncated").unwrap();
        std::fs::write(
            sibling(&path, ".bak"),
            serde_json::to_string_pretty(&sample("ja")).unwrap(),
        )
        .unwrap();

        // Both the checked and the infallible entry points recover.
        assert_eq!(load_checked(&dir).unwrap(), sample("ja"));
        assert_eq!(load(&dir), sample("ja"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn corrupt_main_and_backup_is_a_visible_error() {
        // Both files unusable: load_checked must error (no silent default that
        // would look like data loss), while the infallible load degrades.
        let dir = crate::test_support::temp_dir("settings-both-corrupt");
        std::fs::create_dir_all(&dir).unwrap();
        let path = settings_path(&dir);
        std::fs::write(&path, "{ truncated").unwrap();
        std::fs::write(sibling(&path, ".bak"), "{ also broken").unwrap();

        let error = load_checked(&dir).unwrap_err();
        assert!(error.contains("corrupted"), "unexpected error: {error}");
        assert!(
            error.contains("backup"),
            "error should name the backup: {error}"
        );
        // The best-effort entry point still starts the app with defaults.
        assert_eq!(load(&dir), AppSettings::default());
        std::fs::remove_dir_all(&dir).ok();
    }
}
