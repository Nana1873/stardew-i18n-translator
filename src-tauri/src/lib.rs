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
mod release_zip;
mod scanner;
mod settings;
mod tokens;
mod translations;

#[cfg(test)]
mod language_compatibility;

use std::path::{Path, PathBuf};
use std::{fs::OpenOptions, io::Write};

use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_log::{RotationStrategy, Target, TargetKind};
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
    let result = scanner::scan_mods(Path::new(&mods_path), &target_lang, &config);
    if !result.warnings.is_empty() {
        log::warn!(
            "scan_mods({mods_path}): {} warning(s)",
            result.warnings.len()
        );
    }
    log::info!(
        "scan_mods({target_lang}): {} mods, {} i18n files",
        result.mod_count,
        result.file_count
    );
    Ok(result)
}

#[tauri::command]
fn load_strings(
    app: AppHandle,
    mod_unique_id: String,
    relative_dir: String,
    default_path: String,
    target_path: String,
) -> Result<Vec<scanner::StringRow>, String> {
    let config = translation_config_dir(&app)?;
    // A corrupted state file is surfaced to the user (instead of silently
    // showing everything untranslated and inviting an overwrite).
    let state = translations::load(&config, &mod_unique_id)?;
    let rows = scanner::load_strings(
        Path::new(&default_path),
        Path::new(&target_path),
        &state,
        &relative_dir,
    );
    // Adopt pre-existing <lang>.json translations the user never saved so they
    // gain a source-hash baseline — without one they could never be flagged
    // `outdated` when the mod's English source later changes. Idempotent: once
    // adopted, the keys are in `state` and subsequent opens persist nothing.
    let baselines = scanner::imported_baselines(&rows, &state, &relative_dir);
    if !baselines.is_empty() {
        translations::save_many(&config, &mod_unique_id, baselines)?;
    }
    Ok(rows)
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
        &translation_config_dir(&app)?,
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
    translations::save_many(&translation_config_dir(&app)?, &mod_unique_id, entries)
}

#[tauri::command]
fn export_mod(
    app: AppHandle,
    mod_unique_id: String,
    files: Vec<export::ExportFileInput>,
) -> Result<export::ExportResult, String> {
    export::export_mod(&translation_config_dir(&app)?, &mod_unique_id, &files)
        .inspect_err(|error| log::error!("export_mod({mod_unique_id}) failed: {error}"))
}

#[tauri::command]
fn preview_translation_zip(
    app: AppHandle,
    mods_path: String,
    package_name: String,
    target_lang: String,
    target_language: String,
    components: Vec<release_zip::ZipComponentInput>,
) -> Result<release_zip::ZipPreview, String> {
    release_zip::preview(
        &translation_config_dir(&app)?,
        Path::new(&mods_path),
        &package_name,
        &target_lang,
        &target_language,
        &components,
    )
}

#[tauri::command]
fn pick_translation_zip_destination(
    app: AppHandle,
    default_file_name: String,
) -> Result<Option<String>, String> {
    let picked = app
        .dialog()
        .file()
        .set_title("Save translation ZIP")
        .set_file_name(release_zip::sanitize_file_name(&default_file_name))
        .add_filter("ZIP archive", &["zip"])
        .blocking_save_file();
    match picked {
        Some(file) => file
            .into_path()
            .map(|path| Some(path.display().to_string()))
            .map_err(|error| format!("Could not read the selected path: {error}")),
        None => Ok(None),
    }
}

#[tauri::command]
fn build_translation_zip(
    app: AppHandle,
    request: release_zip::ZipBuildRequest,
) -> Result<release_zip::ZipBuildOutcome, String> {
    release_zip::build(&translation_config_dir(&app)?, &request)
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

    // Per-language glossary: unsupported languages have no cache, so their batch
    // glossary excerpt is empty rather than carrying another language's terms.
    let glossary = glossary::load(&config_dir(&app)?, &target_lang);
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
    import_llm_batch_from_path(&app, &mod_unique_id, &files, &source)
        .inspect_err(|error| log::error!("import_llm_batch({mod_unique_id}) failed: {error}"))
        .map(Some)
}

fn import_llm_batch_from_path(
    app: &AppHandle,
    mod_unique_id: &str,
    files: &[export::ExportFileInput],
    source: &Path,
) -> Result<batch::ImportSummary, String> {
    let body = std::fs::read_to_string(source)
        .map_err(|error| format!("Could not read {}: {error}", source.display()))?;
    // Lenient parse: LLM output sometimes carries trailing commas or comments.
    let parsed = scanner::parse_json_lenient(&body)
        .map_err(|error| format!("Invalid JSON in {}: {error}", source.display()))?;

    let config = translation_config_dir(app)?;
    let state = translations::load(&config, mod_unique_id)?;
    let mut rows_by_dir = std::collections::HashMap::new();
    for file in files {
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
        translations::save_many(&config, mod_unique_id, prepared.entries)?;
    }
    Ok(prepared.summary)
}

/// Import a dropped LLM batch/result path through the same safe M4 pipeline as
/// the picker command.
#[tauri::command]
fn import_llm_batch_path(
    app: AppHandle,
    mod_unique_id: String,
    files: Vec<export::ExportFileInput>,
    path: String,
) -> Result<batch::ImportSummary, String> {
    import_llm_batch_from_path(&app, &mod_unique_id, &files, Path::new(&path))
        .inspect_err(|error| log::error!("import_llm_batch_path({mod_unique_id}) failed: {error}"))
}

#[tauri::command]
fn build_glossary(
    app: AppHandle,
    stardew_path: String,
    target_lang: String,
) -> Result<glossary::GlossaryInfo, String> {
    let unpacked = glossary::default_unpacked_path(Path::new(&stardew_path));
    let built = glossary::build(&unpacked, &target_lang)
        .inspect_err(|error| log::error!("build_glossary({target_lang}) failed: {error}"))?;
    glossary::save(&config_dir(&app)?, &built)?;
    Ok(glossary::GlossaryInfo {
        target_lang: built.target_lang,
        term_count: built.term_count,
    })
}

#[tauri::command]
fn load_glossary(
    app: AppHandle,
    target_lang: String,
) -> Result<Option<glossary::Glossary>, String> {
    let config = config_dir(&app)?;
    glossary::migrate_legacy_cache(&config);
    Ok(glossary::load(&config, &target_lang))
}

#[tauri::command]
fn glossary_status(
    app: AppHandle,
    stardew_path: String,
    target_lang: String,
) -> Result<glossary::GlossaryStatus, String> {
    let config = config_dir(&app)?;
    glossary::migrate_legacy_cache(&config);
    let cached = glossary::load(&config, &target_lang).map(|g| glossary::GlossaryInfo {
        target_lang: g.target_lang,
        term_count: g.term_count,
    });
    // A legacy single `glossary.json` still present after migration is an
    // unmigratable old/invalid cache — the UI surfaces a "rebuild recommended" note.
    let outdated_cache = glossary::legacy_cache_present(&config);
    Ok(glossary::GlossaryStatus {
        unpacked_present: glossary::unpacked_present(Path::new(&stardew_path)),
        cached,
        outdated_cache,
    })
}

/// List models from an OpenAI-compatible local server (M6, Issue 15). Doubles as
/// the "Test connection" probe: success means the server is reachable.
#[tauri::command]
async fn llm_models(base_url: String) -> Result<Vec<String>, String> {
    if !(base_url.starts_with("http://") || base_url.starts_with("https://")) {
        return Err("Base URL must start with http:// or https://.".to_string());
    }
    llm::list_models(&base_url)
        .await
        .inspect_err(|error| log::error!("llm_models({base_url}) failed: {error}"))
}

/// Translate one source string via the configured local LLM (M6, Issue 16).
/// Injects matching official-glossary terms into the prompt and validates the
/// result's protected tokens (with one stricter retry). `temperature` is the
/// optional user setting (None = low default).
// Tauri delivers each field as a named argument from the JS bridge, so the flat
// parameter list mirrors the `translateString` call rather than a wrapper struct.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
async fn translate_string(
    app: AppHandle,
    base_url: String,
    model: String,
    source: String,
    target_lang: String,
    target_language: String,
    section: Option<String>,
    temperature: Option<f32>,
) -> Result<llm::TranslationResult, String> {
    if !(base_url.starts_with("http://") || base_url.starts_with("https://")) {
        return Err("Base URL must start with http:// or https://.".to_string());
    }
    // Load the glossary for the active language only: an unsupported language has
    // no cache file, so no official terms are ever injected into its prompt.
    let glossary_pairs = glossary::load(&config_dir(&app)?, &target_lang)
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
    .inspect_err(|error| log::error!("translate_string failed: {error}"))
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

/// Append a frontend-side error to the same diagnostic log file as the backend
/// (v1.1.1). The webview cannot write the portable log itself, so this command
/// is the bridge: a caught UI error still lands in `data/logs/` for bug reports.
/// Fire-and-forget — logging must never itself surface an error to the user.
#[tauri::command]
fn log_frontend_error(context: String, message: String) {
    log::error!("[frontend] {context}: {message}");
}

/// Open the portable `data/logs/` folder in the OS file manager (v1.1.1) so a
/// user can attach the current log file to a GitHub bug report.
#[tauri::command]
fn open_logs_dir(app: AppHandle) -> Result<(), String> {
    let dir = portable_logs_dir()?;
    std::fs::create_dir_all(&dir).map_err(|error| {
        format!(
            "Could not create the logs folder {}: {error}",
            dir.display()
        )
    })?;
    app.opener()
        .open_path(dir.display().to_string(), None::<String>)
        .map_err(|error| format!("Could not open the logs folder: {error}"))
}

/// Open a mod's folder in the OS file manager. The path comes from a scan
/// result so it is trusted, but it is validated as an existing directory before
/// being handed to the opener (ShellExecute — never a shell).
#[tauri::command]
fn open_mod_folder(app: AppHandle, path: String) -> Result<(), String> {
    if !Path::new(&path).is_dir() {
        return Err(format!("Mod folder not found: {path}"));
    }
    app.opener()
        .open_path(path, None::<String>)
        .map_err(|error| format!("Could not open the mod folder: {error}"))
}

#[tauri::command]
fn open_folder(app: AppHandle, path: String) -> Result<(), String> {
    if !Path::new(&path).is_dir() {
        return Err(format!("Folder not found: {path}"));
    }
    app.opener()
        .open_path(path, None::<String>)
        .map_err(|error| format!("Could not open the folder: {error}"))
}

#[tauri::command]
fn load_settings(app: AppHandle) -> Result<AppSettings, String> {
    // Use the checked load so a corrupted settings file surfaces as a visible
    // error instead of silently resetting the user's configuration to defaults.
    settings::load_checked(&config_dir(&app)?)
}

#[tauri::command]
fn save_settings(app: AppHandle, settings: AppSettings) -> Result<(), String> {
    settings::save(&config_dir(&app)?, &settings)?;
    apply_diagnostic_logging(settings.diagnostic_logging);
    Ok(())
}

fn apply_diagnostic_logging(enabled: bool) {
    log::set_max_level(if enabled {
        log::LevelFilter::Info
    } else {
        log::LevelFilter::Off
    });
}

fn portable_data_dir_for(executable: &Path) -> Result<PathBuf, String> {
    executable
        .parent()
        .filter(|directory| !directory.as_os_str().is_empty())
        .map(|directory| directory.join("data"))
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

fn portable_logs_dir_for(executable: &Path) -> Result<PathBuf, String> {
    portable_data_dir_for(executable).map(|dir| dir.join("logs"))
}

fn portable_logs_dir() -> Result<PathBuf, String> {
    let executable = std::env::current_exe()
        .map_err(|error| format!("Could not resolve the application executable: {error}"))?;
    portable_logs_dir_for(&executable)
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

fn config_dir(_app: &AppHandle) -> Result<PathBuf, String> {
    portable_data_dir()
}

fn translation_config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let config = config_dir(app)?;
    let target_lang = settings::load(&config)
        .target_lang
        .ok_or("Choose a target language before editing translations.")?;
    translations::language_root(&config, &target_lang)
}

/// Build the diagnostic-logging plugin (v1.1.1). Writes a rotating log file to
/// the portable `data/logs/` folder so it travels with the app and can be
/// attached to a bug report — never to the OS log dir. Local only: there is no
/// network target, consistent with the no-telemetry guarantee. Best-effort: if
/// the portable path can't be resolved we log to stderr only, and the writable
/// folder check in `.setup()` still surfaces real problems to the user.
fn log_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    let mut targets = vec![Target::new(TargetKind::Stderr)];
    if let Ok(dir) = portable_logs_dir() {
        let _ = std::fs::create_dir_all(&dir);
        targets.push(Target::new(TargetKind::Folder {
            path: dir,
            file_name: Some("stardew-i18n-translator".to_string()),
        }));
    }
    tauri_plugin_log::Builder::new()
        .targets(targets)
        .level(log::LevelFilter::Info)
        // Keep the footprint small inside the portable folder: a few recent
        // files, each capped at ~2 MB.
        .max_file_size(2_000_000)
        .rotation_strategy(RotationStrategy::KeepSome(5))
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(log_plugin())
        .setup(|app| {
            let data_dir = ensure_portable_data_dir().map_err(|error| {
                log::error!("Portable data folder unusable: {error}");
                std::io::Error::other(error)
            })?;
            apply_diagnostic_logging(settings::load(&data_dir).diagnostic_logging);
            log::info!(
                "Stardew i18n Translator {} started",
                app.package_info().version
            );
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
            preview_translation_zip,
            pick_translation_zip_destination,
            build_translation_zip,
            export_llm_batch,
            import_llm_batch,
            import_llm_batch_path,
            build_glossary,
            glossary_status,
            load_glossary,
            llm_models,
            translate_string,
            open_url,
            log_frontend_error,
            open_logs_dir,
            open_mod_folder,
            open_folder,
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
            PathBuf::from(r"E:\Tools\Stardew Translator\data")
        );
    }

    #[test]
    fn relative_executable_without_parent_is_rejected() {
        assert!(portable_data_dir_for(Path::new("translator.exe")).is_err());
    }

    #[test]
    fn logs_live_under_the_portable_data_folder() {
        let executable = Path::new(r"E:\Tools\Stardew Translator\stardew-i18n-translator.exe");
        assert_eq!(
            portable_logs_dir_for(executable).unwrap(),
            PathBuf::from(r"E:\Tools\Stardew Translator\data\logs")
        );
    }

    #[test]
    fn logs_dir_rejects_an_executable_without_parent() {
        assert!(portable_logs_dir_for(Path::new("translator.exe")).is_err());
    }
}
