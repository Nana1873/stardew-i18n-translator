//! Stardew i18n Translator — Tauri backend.
//!
//! Settings persistence + Stardew auto-detection (M1), the mod scanner and
//! i18n parser (M1/M2), persisted translation state (M2), the i18n exporter
//! (M3), and the local-LLM connection probe (M6). Kept minimal per
//! SCOPE_GUARDRAILS — no plugin/provider abstractions.

mod batch;
mod detection;
mod export;
mod glossary;
mod llm;
mod scanner;
mod settings;
mod tokens;
mod translations;

use std::path::{Path, PathBuf};
use std::{fs::OpenOptions, io::Write};

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

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
    Ok(scanner::scan_mods(
        Path::new(&mods_path),
        &target_lang,
        &config,
    ))
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

/// Outcome of an external LLM batch export (M4): where the file landed and what
/// it contains. `None` from the command means the user cancelled the picker.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct LlmExportOutcome {
    path: String,
    string_count: usize,
    glossary_terms: usize,
}

/// Write the selected strings as an external LLM translation batch
/// (M4, SPEC §11). Opens a save dialog; embeds instructions + a glossary
/// excerpt so the file can be handed to any LLM verbatim.
#[tauri::command]
fn export_llm_batch(
    app: AppHandle,
    mod_unique_id: String,
    mod_name: String,
    target_lang: String,
    target_language: String,
    items: Vec<batch::BatchExportItem>,
) -> Result<Option<LlmExportOutcome>, String> {
    let picked = app
        .dialog()
        .file()
        .set_title("Export LLM translation batch")
        .set_file_name(format!("{mod_unique_id}.llm-batch.json"))
        .add_filter("JSON", &["json"])
        .blocking_save_file();
    let Some(picked) = picked else {
        return Ok(None);
    };
    let dest = picked
        .into_path()
        .map_err(|error| format!("Could not read the selected path: {error}"))?;

    let glossary = glossary::load(&config_dir(&app)?);
    let batch_json = batch::build_batch(
        &mod_name,
        &mod_unique_id,
        &target_lang,
        &target_language,
        &items,
        glossary.as_ref(),
    );
    let glossary_terms = batch_json["glossary"]
        .as_object()
        .map(|terms| terms.len())
        .unwrap_or(0);
    let mut body = serde_json::to_string_pretty(&batch_json)
        .map_err(|error| format!("Could not serialize the batch: {error}"))?;
    body.push('\n');
    std::fs::write(&dest, body.as_bytes())
        .map_err(|error| format!("Could not write {}: {error}", dest.display()))?;

    Ok(Some(LlmExportOutcome {
        path: dest.display().to_string(),
        string_count: items.len(),
        glossary_terms,
    }))
}

/// Import a translated LLM batch/result file for one mod (M4). Opens
/// a file picker; matches keys against the mod's current strings; stages all
/// accepted values as `review-needed` in ONE state write. `None` = cancelled.
#[tauri::command]
fn import_llm_batch(
    app: AppHandle,
    mod_unique_id: String,
    files: Vec<export::ExportFileInput>,
) -> Result<Option<batch::ImportSummary>, String> {
    let picked = app
        .dialog()
        .file()
        .set_title("Import LLM translation result")
        .add_filter("JSON", &["json"])
        .blocking_pick_file();
    let Some(picked) = picked else {
        return Ok(None);
    };
    let source = picked
        .into_path()
        .map_err(|error| format!("Could not read the selected path: {error}"))?;

    let body = std::fs::read_to_string(&source)
        .map_err(|error| format!("Could not read {}: {error}", source.display()))?;
    // Lenient parse: LLM output sometimes carries trailing commas or comments.
    let parsed = scanner::parse_json_lenient(&body)
        .map_err(|error| format!("Invalid JSON in {}: {error}", source.display()))?;

    let config = config_dir(&app)?;
    let state = translations::load(&config, &mod_unique_id)?;
    let mut rows_by_dir = std::collections::HashMap::new();
    for file in &files {
        rows_by_dir.insert(
            file.relative_dir.clone(),
            scanner::load_strings(
                Path::new(&file.default_path),
                Path::new(&file.target_path),
                &state,
                &file.relative_dir,
            ),
        );
    }

    let prepared = batch::apply_batch(&parsed, &rows_by_dir)?;
    if !prepared.entries.is_empty() {
        translations::save_many(&config, &mod_unique_id, prepared.entries)?;
    }
    Ok(Some(prepared.summary))
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
    section: Option<String>,
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
        section.as_deref(),
        &glossary_pairs,
        temperature,
    )
    .await
}

/// Open an external http(s) URL in the user's default browser (Nexus links).
/// Uses the opener plugin (ShellExecute) — never a shell, so URL contents can
/// not be interpreted as commands (`cmd /C start` would parse `&`, `^`, …).
#[tauri::command]
fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Only http(s) URLs are allowed.".to_string());
    }
    app.opener()
        .open_url(&url, None::<String>)
        .map_err(|error| format!("Could not open URL: {error}"))
}

#[tauri::command]
fn load_settings(app: AppHandle) -> Result<AppSettings, String> {
    Ok(settings::load(&config_dir(&app)?))
}

#[tauri::command]
fn save_settings(app: AppHandle, settings: AppSettings) -> Result<(), String> {
    settings::save(&config_dir(&app)?, &settings)
}

fn portable_data_dir_for(executable: &Path) -> Result<PathBuf, String> {
    executable
        .parent()
        .filter(|directory| !directory.as_os_str().is_empty())
        .map(|directory| directory.join("Data"))
        .ok_or_else(|| {
            format!(
                "Could not resolve the folder containing {}.",
                executable.display()
            )
        })
}

fn portable_data_dir() -> Result<PathBuf, String> {
    let executable = std::env::current_exe()
        .map_err(|error| format!("Could not resolve the application executable: {error}"))?;
    portable_data_dir_for(&executable)
}

fn ensure_portable_data_dir() -> Result<PathBuf, String> {
    let data_dir = portable_data_dir()?;
    std::fs::create_dir_all(&data_dir).map_err(|error| {
        format!(
            "Could not create the portable data folder {}: {error}. Move the application to a writable folder.",
            data_dir.display()
        )
    })?;

    let probe = data_dir.join(format!(".write-test-{}", std::process::id()));
    let write_result = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
        .and_then(|mut file| file.write_all(b"portable"));
    if let Err(error) = write_result {
        return Err(format!(
            "The portable data folder {} is not writable: {error}. Move the application to a writable folder.",
            data_dir.display()
        ));
    }
    std::fs::remove_file(&probe).map_err(|error| {
        format!(
            "Could not finalize the portable data-folder check at {}: {error}",
            data_dir.display()
        )
    })?;
    Ok(data_dir)
}

fn has_portable_user_data(data_dir: &Path) -> bool {
    data_dir.join("settings.json").exists()
        || data_dir.join("glossary.json").exists()
        || data_dir.join("translations").exists()
}

fn copy_directory(source: &Path, destination: &Path) -> Result<(), String> {
    std::fs::create_dir_all(destination).map_err(|error| {
        format!(
            "Could not create portable directory {}: {error}",
            destination.display()
        )
    })?;
    for entry in std::fs::read_dir(source)
        .map_err(|error| format!("Could not read legacy data {}: {error}", source.display()))?
    {
        let entry = entry.map_err(|error| format!("Could not read legacy data entry: {error}"))?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        if source_path.is_dir() {
            copy_directory(&source_path, &destination_path)?;
        } else {
            std::fs::copy(&source_path, &destination_path).map_err(|error| {
                format!(
                    "Could not migrate {} to {}: {error}",
                    source_path.display(),
                    destination_path.display()
                )
            })?;
        }
    }
    Ok(())
}

fn migrate_legacy_data(legacy_dir: &Path, data_dir: &Path) -> Result<(), String> {
    if legacy_dir == data_dir || !legacy_dir.is_dir() || has_portable_user_data(data_dir) {
        return Ok(());
    }

    for file in ["settings.json", "glossary.json"] {
        let source = legacy_dir.join(file);
        if source.is_file() {
            std::fs::copy(&source, data_dir.join(file)).map_err(|error| {
                format!(
                    "Could not migrate legacy data {}: {error}",
                    source.display()
                )
            })?;
        }
    }

    let translations = legacy_dir.join("translations");
    if translations.is_dir() {
        copy_directory(&translations, &data_dir.join("translations"))?;
    }
    Ok(())
}

fn config_dir(_app: &AppHandle) -> Result<PathBuf, String> {
    portable_data_dir()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = ensure_portable_data_dir().map_err(std::io::Error::other)?;
            let legacy_dir = app.path().app_config_dir().map_err(std::io::Error::other)?;
            migrate_legacy_data(&legacy_dir, &data_dir).map_err(std::io::Error::other)?;
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
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
            export_llm_batch,
            import_llm_batch,
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

#[cfg(test)]
mod portable_tests {
    use super::*;

    #[test]
    fn portable_data_lives_next_to_the_executable() {
        let executable = Path::new(r"E:\Tools\Stardew Translator\stardew-i18n-translator.exe");
        assert_eq!(
            portable_data_dir_for(executable).unwrap(),
            PathBuf::from(r"E:\Tools\Stardew Translator\Data")
        );
    }

    #[test]
    fn relative_executable_without_parent_is_rejected() {
        assert!(portable_data_dir_for(Path::new("translator.exe")).is_err());
    }

    #[test]
    fn legacy_data_migrates_only_into_an_empty_portable_folder() {
        let root = crate::test_support::temp_dir("portable-migration");
        let legacy = root.join("legacy");
        let portable = root.join("portable");
        std::fs::create_dir_all(legacy.join("translations")).unwrap();
        std::fs::create_dir_all(&portable).unwrap();
        std::fs::write(legacy.join("settings.json"), "{\"targetLang\":\"de\"}").unwrap();
        std::fs::write(legacy.join("glossary.json"), "{}").unwrap();
        std::fs::write(legacy.join("translations").join("Example.Mod.json"), "{}").unwrap();

        migrate_legacy_data(&legacy, &portable).unwrap();
        assert!(portable.join("settings.json").is_file());
        assert!(portable.join("glossary.json").is_file());
        assert!(portable
            .join("translations")
            .join("Example.Mod.json")
            .is_file());

        std::fs::write(portable.join("settings.json"), "portable").unwrap();
        std::fs::write(legacy.join("settings.json"), "legacy changed").unwrap();
        migrate_legacy_data(&legacy, &portable).unwrap();
        assert_eq!(
            std::fs::read_to_string(portable.join("settings.json")).unwrap(),
            "portable"
        );
        std::fs::remove_dir_all(root).ok();
    }
}
