//! Stardew i18n Translator — Tauri backend.
//!
//! Settings persistence + Stardew auto-detection (M1), the mod scanner and
//! i18n parser (M1/M2), persisted translation state (M2), the i18n exporter
//! (M3), and the local-LLM connection probe (M6). Kept minimal per
//! SCOPE_GUARDRAILS — no plugin/provider abstractions.

mod detection;
mod export;
mod glossary;
mod llm;
mod scanner;
mod settings;
mod tokens;
mod translations;

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

use detection::DetectedInstall;
use scanner::ScanResult;
use settings::AppSettings;

#[tauri::command]
fn detect_stardew() -> Option<DetectedInstall> {
    detection::detect()
}

#[tauri::command]
fn validate_stardew_path(path: String) -> bool {
    detection::is_stardew_install(Path::new(&path))
}

#[tauri::command]
fn default_mods_path(stardew_path: String) -> String {
    detection::mods_path_for(Path::new(&stardew_path))
        .display()
        .to_string()
}

#[tauri::command]
fn pick_folder(app: AppHandle, title: Option<String>) -> Result<Option<String>, String> {
    let picked = app
        .dialog()
        .file()
        .set_title(title.unwrap_or_else(|| "Select folder".to_string()))
        .blocking_pick_folder();

    match picked {
        Some(folder) => folder
            .into_path()
            .map(|path| Some(path.display().to_string()))
            .map_err(|error| format!("Could not read selected path: {error}")),
        None => Ok(None),
    }
}

#[tauri::command]
fn scan_mods(app: AppHandle, mods_path: String, target_lang: String) -> Result<ScanResult, String> {
    let config = config_dir(&app)?;
    Ok(scanner::scan_mods(Path::new(&mods_path), &target_lang, &config))
}

#[tauri::command]
fn load_strings(
    app: AppHandle,
    mod_unique_id: String,
    relative_dir: String,
    default_path: String,
    target_path: String,
) -> Result<Vec<scanner::StringRow>, String> {
    // A corrupted state file is surfaced to the user (instead of silently
    // showing everything untranslated and inviting an overwrite).
    let state = translations::load(&config_dir(&app)?, &mod_unique_id)?;
    Ok(scanner::load_strings(
        Path::new(&default_path),
        Path::new(&target_path),
        &state,
        &relative_dir,
    ))
}

#[tauri::command]
fn save_string(
    app: AppHandle,
    mod_unique_id: String,
    relative_dir: String,
    key: String,
    target: String,
    status: String,
    source: String,
) -> Result<(), String> {
    let entry = translations::StoredString {
        target,
        status,
        source_hash: translations::source_hash(&source),
    };
    translations::save_one(
        &config_dir(&app)?,
        &mod_unique_id,
        translations::entry_key(&relative_dir, &key),
        entry,
    )
}

/// One string of a bulk save (mirrors the frontend's `SaveStringEntry`).
#[derive(serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct SaveStringInput {
    relative_dir: String,
    key: String,
    target: String,
    status: String,
    source: String,
}

/// Save many strings of one mod in a single load-modify-write cycle. The bulk
/// actions (context menu) must use this instead of N parallel `save_string`
/// calls, which would race the per-mod state file and lose updates.
#[tauri::command]
fn save_strings(
    app: AppHandle,
    mod_unique_id: String,
    entries: Vec<SaveStringInput>,
) -> Result<(), String> {
    let entries = entries
        .into_iter()
        .map(|input| {
            (
                translations::entry_key(&input.relative_dir, &input.key),
                translations::StoredString {
                    source_hash: translations::source_hash(&input.source),
                    target: input.target,
                    status: input.status,
                },
            )
        })
        .collect();
    translations::save_many(&config_dir(&app)?, &mod_unique_id, entries)
}

#[tauri::command]
fn export_mod(
    app: AppHandle,
    mod_unique_id: String,
    files: Vec<export::ExportFileInput>,
) -> Result<export::ExportResult, String> {
    export::export_mod(&config_dir(&app)?, &mod_unique_id, &files)
}

#[tauri::command]
fn build_glossary(
    app: AppHandle,
    stardew_path: String,
    target_lang: String,
) -> Result<glossary::GlossaryInfo, String> {
    let unpacked = glossary::default_unpacked_path(Path::new(&stardew_path));
    let built = glossary::build(&unpacked, &target_lang)?;
    glossary::save(&config_dir(&app)?, &built)?;
    Ok(glossary::GlossaryInfo {
        target_lang: built.target_lang,
        term_count: built.term_count,
    })
}

#[tauri::command]
fn load_glossary(app: AppHandle) -> Result<Option<glossary::Glossary>, String> {
    Ok(glossary::load(&config_dir(&app)?))
}

#[tauri::command]
fn glossary_status(
    app: AppHandle,
    stardew_path: String,
) -> Result<glossary::GlossaryStatus, String> {
    let cached = glossary::load(&config_dir(&app)?).map(|g| glossary::GlossaryInfo {
        target_lang: g.target_lang,
        term_count: g.term_count,
    });
    Ok(glossary::GlossaryStatus {
        unpacked_present: glossary::unpacked_present(Path::new(&stardew_path)),
        cached,
    })
}

/// List models from an OpenAI-compatible local server (M6, Issue 15). Doubles as
/// the "Test connection" probe: success means the server is reachable.
#[tauri::command]
async fn llm_models(base_url: String) -> Result<Vec<String>, String> {
    if !(base_url.starts_with("http://") || base_url.starts_with("https://")) {
        return Err("Base URL must start with http:// or https://.".to_string());
    }
    llm::list_models(&base_url).await
}

/// Translate one source string via the configured local LLM (M6, Issue 16).
/// Injects matching official-glossary terms into the prompt and validates the
/// result's protected tokens (with one stricter retry). `temperature` is the
/// optional user setting (None = low default).
#[tauri::command]
async fn translate_string(
    app: AppHandle,
    base_url: String,
    model: String,
    source: String,
    target_language: String,
    temperature: Option<f32>,
) -> Result<llm::TranslationResult, String> {
    if !(base_url.starts_with("http://") || base_url.starts_with("https://")) {
        return Err("Base URL must start with http:// or https://.".to_string());
    }
    let glossary_pairs = glossary::load(&config_dir(&app)?)
        .map(|g| glossary::match_terms(&source, &g))
        .unwrap_or_default();
    llm::translate(
        &base_url,
        &model,
        &source,
        &target_language,
        &glossary_pairs,
        temperature,
    )
    .await
}

/// Open an external http(s) URL in the user's default browser (Nexus links).
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Only http(s) URLs are allowed.".to_string());
    }
    #[cfg(windows)]
    std::process::Command::new("cmd")
        .args(["/C", "start", "", &url])
        .spawn()
        .map_err(|error| format!("Could not open URL: {error}"))?;
    Ok(())
}

#[tauri::command]
fn load_settings(app: AppHandle) -> Result<AppSettings, String> {
    Ok(settings::load(&config_dir(&app)?))
}

#[tauri::command]
fn save_settings(app: AppHandle, settings: AppSettings) -> Result<(), String> {
    settings::save(&config_dir(&app)?, &settings)
}

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|error| format!("Could not resolve config directory: {error}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            detect_stardew,
            validate_stardew_path,
            default_mods_path,
            pick_folder,
            scan_mods,
            load_strings,
            save_string,
            save_strings,
            export_mod,
            build_glossary,
            glossary_status,
            load_glossary,
            llm_models,
            translate_string,
            open_url,
            load_settings,
            save_settings
        ])
        .run(tauri::generate_context!())
        .expect("error while running Stardew i18n Translator");
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    /// A unique, not-yet-created temp directory path for tests.
    pub fn temp_dir(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
        let mut dir = std::env::temp_dir();
        dir.push(format!("sit-test-{tag}-{nanos}-{seq}"));
        dir
    }
}
