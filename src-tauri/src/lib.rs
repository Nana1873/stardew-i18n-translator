//! Stardew i18n Translator — Tauri backend.
//!
//! Portable settings and translation state, Stardew detection, mod scanning,
//! i18n import/export, glossary extraction, and local-LLM integration. Kept
//! minimal per SCOPE_GUARDRAILS — no plugin/provider abstractions.

mod ai;
mod batch;
mod codex_cli;
mod detection;
mod export;
mod glossary;
mod input_limits;
mod lang_pack;
mod language;
mod llm;
mod operation_history;
mod release_zip;
mod scanner;
mod settings;
mod tokens;
mod translations;
mod xnb;

#[cfg(test)]
mod language_compatibility;

use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::{fs::OpenOptions, io::Write};

use tauri::{AppHandle, State};
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

#[tauri::command(async)]
fn scan_mods(app: AppHandle, mods_path: String, target_lang: String) -> Result<ScanResult, String> {
    let target_lang = language::normalize_target_code(&target_lang)?;
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
    let rows = scanner::load_strings_checked(
        Path::new(&default_path),
        Path::new(&target_path),
        &state,
        &relative_dir,
    )?;
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

/// One component group in a reversible batch that may span several scanned
/// i18n components. The group boundary keeps each component's portable state
/// file explicit while the backend commits the whole action as one operation.
#[derive(serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct SaveStringGroupInput {
    mod_unique_id: String,
    entries: Vec<SaveStringInput>,
}

fn stored_save_entries(entries: Vec<SaveStringInput>) -> Vec<(String, translations::StoredString)> {
    entries
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
        .collect()
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
    let entries = stored_save_entries(entries);
    translations::save_many(&translation_config_dir(&app)?, &mod_unique_id, entries)
}

/// Persist one real batch edit and retain its exact previous values in memory.
/// The existing `save_strings` command stays available for compatibility;
/// result-tray batch actions use this command when they want the single safe
/// undo snapshot described by the product contract.
#[tauri::command]
fn save_strings_with_undo(
    app: AppHandle,
    history: State<'_, operation_history::OperationHistoryState>,
    mod_unique_id: String,
    title: String,
    entries: Vec<SaveStringInput>,
) -> Result<operation_history::OperationHistoryEntry, String> {
    let title = title.trim();
    if title.is_empty() || title.chars().count() > 80 || title.chars().any(char::is_control) {
        return Err("The batch result title must contain 1 to 80 visible characters.".to_string());
    }
    history.apply_reversible_batch(
        &translation_config_dir(&app)?,
        &mod_unique_id,
        title.to_string(),
        stored_save_entries(entries),
    )
}

/// Persist one real batch edit across one or more i18n components and retain
/// one conditional undo snapshot for the complete action.
#[tauri::command]
fn save_string_groups_with_undo(
    app: AppHandle,
    history: State<'_, operation_history::OperationHistoryState>,
    title: String,
    groups: Vec<SaveStringGroupInput>,
) -> Result<operation_history::OperationHistoryEntry, String> {
    let title = title.trim();
    if title.is_empty() || title.chars().count() > 80 || title.chars().any(char::is_control) {
        return Err("The batch result title must contain 1 to 80 visible characters.".to_string());
    }
    history.apply_reversible_batch_groups(
        &translation_config_dir(&app)?,
        title.to_string(),
        groups
            .into_iter()
            .map(|group| (group.mod_unique_id, stored_save_entries(group.entries)))
            .collect(),
    )
}

#[tauri::command]
fn list_operation_history(
    history: State<'_, operation_history::OperationHistoryState>,
) -> Result<Vec<operation_history::OperationHistoryEntry>, String> {
    history.list()
}

#[tauri::command]
fn undo_batch_edit(
    app: AppHandle,
    history: State<'_, operation_history::OperationHistoryState>,
    operation_id: String,
) -> Result<operation_history::OperationHistoryEntry, String> {
    history.undo_reversible_batch(&translation_config_dir(&app)?, &operation_id)
}

fn operation_detail(label: &str, value: impl ToString) -> operation_history::OperationDetail {
    operation_history::OperationDetail {
        label: label.to_string(),
        value: value.to_string(),
    }
}

fn operation_file_location(path: &str) -> (Option<String>, Option<String>) {
    let file_name = Path::new(path)
        .file_name()
        .and_then(|value| value.to_str())
        .map(ToOwned::to_owned);
    (Some(path.to_string()), file_name)
}

/// Result history is useful feedback, but it must never turn a successfully
/// completed file operation into a reported failure. A poisoned in-memory
/// history lock is therefore logged and the real backend result still wins.
fn remember_operation(
    history: &State<'_, operation_history::OperationHistoryState>,
    operation: operation_history::CompletedOperation,
) {
    if let Err(error) = history.record(operation) {
        log::warn!("Could not retain completed operation result: {error}");
    }
}

fn compact_export_warnings(skipped: &[export::SkippedKey]) -> Vec<String> {
    const LIMIT: usize = 4;
    let mut warnings = skipped
        .iter()
        .take(LIMIT)
        .map(|item| format!("{} / {}: {}", item.relative_dir, item.key, item.reason))
        .collect::<Vec<_>>();
    if skipped.len() > LIMIT {
        warnings.push(format!(
            "{} additional skipped strings.",
            skipped.len() - LIMIT
        ));
    }
    warnings
}

#[tauri::command]
fn export_mod(
    app: AppHandle,
    history: State<'_, operation_history::OperationHistoryState>,
    mod_unique_id: String,
    files: Vec<export::ExportFileInput>,
) -> Result<export::ExportResult, String> {
    let config = config_dir(&app)?;
    let settings = settings::load_checked(&config)?;
    let mods_root = settings
        .mods_path
        .map(PathBuf::from)
        .or_else(|| {
            settings
                .stardew_path
                .as_deref()
                .map(|path| detection::mods_path_for(Path::new(path)))
        })
        .ok_or_else(|| "Configure the Stardew Valley Mods folder before exporting.".to_string())?;
    let target_lang = settings
        .target_lang
        .ok_or_else(|| "Choose a target language before exporting translations.".to_string())?;
    export::validate_paths(&mods_root, &target_lang, &files)?;
    let translation_config = translations::language_root(&config, &target_lang)?;
    let result = export::export_mod(&translation_config, &mod_unique_id, &files)
        .inspect_err(|error| log::error!("export_mod({mod_unique_id}) failed: {error}"))?;
    let changed_files = result
        .files
        .iter()
        .filter(|file| file.written || file.removed)
        .collect::<Vec<_>>();
    let (path, file_name) = if changed_files.len() == 1 {
        operation_file_location(&changed_files[0].target_path)
    } else {
        (Some(mods_root.display().to_string()), None)
    };
    remember_operation(
        &history,
        operation_history::CompletedOperation {
            kind: operation_history::OperationKind::Export,
            outcome: if result.blocked {
                operation_history::OperationOutcome::Blocked
            } else if !result.skipped.is_empty()
                || result.total_outdated > 0
                || result.total_review_needed > 0
                || result.total_orphan_keys > 0
            {
                operation_history::OperationOutcome::Warning
            } else {
                operation_history::OperationOutcome::Success
            },
            title: "Translation export completed".to_string(),
            summary: if result.blocked {
                "Export was blocked before any target file changed.".to_string()
            } else {
                format!(
                    "{} target files written and {} removed.",
                    result.files_written, result.files_removed
                )
            },
            item_count: result.total_written_keys,
            path,
            file_name,
            warnings: compact_export_warnings(&result.skipped),
            details: vec![
                operation_detail("Component", &mod_unique_id),
                operation_detail("Strings written", result.total_written_keys),
                operation_detail("Untranslated", result.total_untranslated),
                operation_detail("Changed source", result.total_outdated),
                operation_detail("Needs review", result.total_review_needed),
                operation_detail("Orphan keys removed", result.total_orphan_keys),
            ],
        },
    );
    Ok(result)
}

#[tauri::command]
fn export_all_mods(
    app: AppHandle,
    history: State<'_, operation_history::OperationHistoryState>,
    mods: Vec<export::ExportModInput>,
) -> Result<export::ExportAllResult, String> {
    let config = config_dir(&app)?;
    let settings = settings::load_checked(&config)?;
    let mods_root = settings
        .mods_path
        .map(PathBuf::from)
        .or_else(|| {
            settings
                .stardew_path
                .as_deref()
                .map(|path| detection::mods_path_for(Path::new(path)))
        })
        .ok_or_else(|| "Configure the Stardew Valley Mods folder before exporting.".to_string())?;
    let target_lang = settings
        .target_lang
        .ok_or_else(|| "Choose a target language before exporting translations.".to_string())?;
    let target_lang = language::normalize_target_code(&target_lang)?;
    let files = mods
        .iter()
        .flat_map(|request| request.files.iter().cloned())
        .collect::<Vec<_>>();
    // Validate in one pass so duplicate targets are rejected across mod groups,
    // not only within each individual group.
    export::validate_paths(&mods_root, &target_lang, &files)?;
    let translation_config = translations::language_root(&config, &target_lang)?;
    let result = export::export_all_mods(&translation_config, &mods)
        .inspect_err(|error| log::error!("export_all_mods failed: {error}"))?;
    let skipped = result
        .mods
        .iter()
        .flat_map(|item| item.result.skipped.iter().cloned())
        .collect::<Vec<_>>();
    remember_operation(
        &history,
        operation_history::CompletedOperation {
            kind: operation_history::OperationKind::Export,
            outcome: if result.blocked {
                operation_history::OperationOutcome::Blocked
            } else if !skipped.is_empty()
                || result.total_outdated > 0
                || result.total_review_needed > 0
                || result.total_orphan_keys > 0
            {
                operation_history::OperationOutcome::Warning
            } else {
                operation_history::OperationOutcome::Success
            },
            title: "All-mod export completed".to_string(),
            summary: if result.blocked {
                "Export was blocked before any target file changed.".to_string()
            } else {
                format!(
                    "{} components changed; {} target files written and {} removed.",
                    result.mods_changed, result.files_written, result.files_removed
                )
            },
            item_count: result.total_written_keys,
            path: Some(mods_root.display().to_string()),
            file_name: None,
            warnings: compact_export_warnings(&skipped),
            details: vec![
                operation_detail("Components changed", result.mods_changed),
                operation_detail("Strings written", result.total_written_keys),
                operation_detail("Untranslated", result.total_untranslated),
                operation_detail("Changed source", result.total_outdated),
                operation_detail("Needs review", result.total_review_needed),
                operation_detail("Orphan keys removed", result.total_orphan_keys),
            ],
        },
    );
    Ok(result)
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
    let target_lang = language::normalize_target_code(&target_lang)?;
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
    history: State<'_, operation_history::OperationHistoryState>,
    mut request: release_zip::ZipBuildRequest,
) -> Result<release_zip::ZipBuildOutcome, String> {
    request.target_lang = language::normalize_target_code(&request.target_lang)?;
    let result = release_zip::build(&translation_config_dir(&app)?, &request)?;
    remember_operation(
        &history,
        operation_history::CompletedOperation {
            kind: operation_history::OperationKind::Zip,
            outcome: operation_history::OperationOutcome::Success,
            title: "Translation ZIP created".to_string(),
            summary: format!(
                "{} strings packaged in {} archive entries.",
                result.strings, result.entries
            ),
            item_count: result.strings,
            path: Some(result.path.clone()),
            file_name: Some(result.file_name.clone()),
            warnings: Vec::new(),
            details: vec![
                operation_detail("Destination folder", &result.folder),
                operation_detail("Archive entries", result.entries),
                operation_detail("Strings", result.strings),
            ],
        },
    );
    Ok(result)
}

/// Outcome of an external LLM batch export: where the file landed and what
/// it contains. `None` from the command means the user cancelled the picker.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct LlmExportOutcome {
    path: String,
    string_count: usize,
}

fn write_llm_batch(
    destination: &Path,
    mod_unique_id: &str,
    target_lang: &str,
    items: &[batch::BatchExportItem],
) -> Result<LlmExportOutcome, String> {
    let batch_json = batch::build_batch(mod_unique_id, target_lang, items);
    let mut body = serde_json::to_string_pretty(&batch_json)
        .map_err(|error| format!("Could not serialize the batch: {error}"))?;
    body.push('\n');
    ensure_llm_batch_json_size(body.len() as u64)?;
    std::fs::write(destination, body.as_bytes())
        .map_err(|error| format!("Could not write {}: {error}", destination.display()))?;

    Ok(LlmExportOutcome {
        path: destination.display().to_string(),
        string_count: items.len(),
    })
}

fn remember_llm_batch_export(
    history: &State<'_, operation_history::OperationHistoryState>,
    outcome: &LlmExportOutcome,
    mod_unique_id: &str,
) {
    let (path, file_name) = operation_file_location(&outcome.path);
    remember_operation(
        history,
        operation_history::CompletedOperation {
            kind: operation_history::OperationKind::BatchExport,
            outcome: operation_history::OperationOutcome::Success,
            title: "LLM batch exported".to_string(),
            summary: format!(
                "{} strings written for external translation.",
                outcome.string_count
            ),
            item_count: outcome.string_count,
            path,
            file_name,
            warnings: Vec::new(),
            details: vec![operation_detail("Component", mod_unique_id)],
        },
    );
}

/// Write the selected strings as an external LLM translation batch
/// (SPEC §11). Opens a save dialog and writes the minimal format-2
/// binding plus the selected source strings.
#[tauri::command]
fn export_llm_batch(
    app: AppHandle,
    history: State<'_, operation_history::OperationHistoryState>,
    mod_unique_id: String,
    items: Vec<batch::BatchExportItem>,
) -> Result<Option<LlmExportOutcome>, String> {
    let target_lang = active_target_lang(&app)?;
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

    let outcome = write_llm_batch(&dest, &mod_unique_id, &target_lang, &items)?;
    remember_llm_batch_export(&history, &outcome, &mod_unique_id);
    Ok(Some(outcome))
}

/// Choose an LLM batch destination without writing anything. The caller can
/// show or change this path before explicitly invoking
/// `export_llm_batch_to_path`.
#[tauri::command]
fn pick_llm_batch_destination(
    app: AppHandle,
    suggested_file_name: String,
) -> Result<Option<String>, String> {
    let picked = app
        .dialog()
        .file()
        .set_title("Export LLM translation batch")
        .set_file_name(suggested_file_name)
        .add_filter("JSON", &["json"])
        .blocking_save_file();
    match picked {
        Some(file) => file
            .into_path()
            .map(|path| Some(path.display().to_string()))
            .map_err(|error| format!("Could not read the selected path: {error}")),
        None => Ok(None),
    }
}

/// Write the minimal format-2 LLM batch to a destination the user already
/// selected with `pick_llm_batch_destination`.
#[tauri::command]
fn export_llm_batch_to_path(
    app: AppHandle,
    history: State<'_, operation_history::OperationHistoryState>,
    mod_unique_id: String,
    items: Vec<batch::BatchExportItem>,
    path: String,
) -> Result<LlmExportOutcome, String> {
    let target_lang = active_target_lang(&app)?;
    let outcome = write_llm_batch(Path::new(&path), &mod_unique_id, &target_lang, &items)?;
    remember_llm_batch_export(&history, &outcome, &mod_unique_id);
    Ok(outcome)
}

fn ensure_llm_batch_json_size(byte_len: u64) -> Result<(), String> {
    input_limits::ensure_json_output_size(byte_len, "LLM batch JSON")
}

fn remember_llm_batch_import(
    history: &State<'_, operation_history::OperationHistoryState>,
    summary: &batch::ImportSummary,
    source: &Path,
    mod_unique_id: &str,
) {
    let source_display = source.display().to_string();
    let (path, file_name) = operation_file_location(&source_display);
    let mut warnings = Vec::new();
    if summary.unmatched > 0 {
        warnings.push(format!(
            "{} values were skipped because no translation was supplied.",
            summary.unmatched
        ));
    }
    if summary.identical_to_source > 0 {
        warnings.push(format!(
            "{} imported values are identical to their source text.",
            summary.identical_to_source
        ));
    }
    remember_operation(
        history,
        operation_history::CompletedOperation {
            kind: operation_history::OperationKind::Import,
            outcome: if warnings.is_empty() {
                operation_history::OperationOutcome::Success
            } else {
                operation_history::OperationOutcome::Warning
            },
            title: "LLM batch imported".to_string(),
            summary: format!("{} suggestions staged for review.", summary.imported),
            item_count: summary.imported,
            path,
            file_name,
            warnings,
            details: vec![
                operation_detail("Component", mod_unique_id),
                operation_detail("Values in file", summary.total_in_file),
                operation_detail("Local translations preserved", summary.skipped_translated),
                operation_detail("Skipped empty values", summary.unmatched),
                operation_detail("Identical to source", summary.identical_to_source),
            ],
        },
    );
}

/// Import a translated LLM batch/result file for one mod. Opens
/// a file picker; matches keys against the mod's current strings; stages all
/// accepted values as `review-needed` in ONE state write. `None` = cancelled.
#[tauri::command]
fn import_llm_batch(
    app: AppHandle,
    history: State<'_, operation_history::OperationHistoryState>,
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
    let summary = import_llm_batch_from_path(&app, &mod_unique_id, &files, &source)
        .inspect_err(|error| log::error!("import_llm_batch({mod_unique_id}) failed: {error}"))?;
    remember_llm_batch_import(&history, &summary, &source, &mod_unique_id);
    Ok(Some(summary))
}

/// Pick an external LLM result without importing it. The caller can use the
/// returned path with `import_llm_batch_path` after selecting the target mod.
#[tauri::command]
fn pick_llm_batch_file(app: AppHandle) -> Result<Option<String>, String> {
    let picked = app
        .dialog()
        .file()
        .set_title("Choose LLM translation result")
        .add_filter("JSON", &["json"])
        .blocking_pick_file();
    match picked {
        Some(file) => file
            .into_path()
            .map(|path| Some(path.display().to_string()))
            .map_err(|error| format!("Could not read the selected path: {error}")),
        None => Ok(None),
    }
}

struct LlmBatchContext {
    parsed: serde_json::Value,
    target_lang: String,
    config: PathBuf,
    rows_by_dir: std::collections::HashMap<String, Vec<scanner::StringRow>>,
}

fn load_llm_batch_context(
    app: &AppHandle,
    mod_unique_id: &str,
    files: &[export::ExportFileInput],
    source: &Path,
) -> Result<LlmBatchContext, String> {
    let body = input_limits::read_json_text(source)?;
    // Lenient parse: LLM output sometimes carries trailing commas or comments.
    let parsed = scanner::parse_json_lenient(&body)
        .map_err(|error| format!("Invalid JSON in {}: {error}", source.display()))?;

    let target_lang = active_target_lang(app)?;
    let config = translations::language_root(&config_dir(app)?, &target_lang)?;
    let state = translations::load(&config, mod_unique_id)?;
    let mut rows_by_dir = std::collections::HashMap::new();
    for file in files {
        rows_by_dir.insert(
            file.relative_dir.clone(),
            scanner::load_strings_checked(
                Path::new(&file.default_path),
                Path::new(&file.target_path),
                &state,
                &file.relative_dir,
            )?,
        );
    }

    Ok(LlmBatchContext {
        parsed,
        target_lang,
        config,
        rows_by_dir,
    })
}

/// Analyze one selected LLM result without writing translation state. A file
/// for another mod returns its binding metadata so the frontend can offer a
/// deliberate switch and rerun this command with that component's real files.
#[tauri::command]
fn preflight_llm_batch_path(
    app: AppHandle,
    mod_unique_id: String,
    files: Vec<export::ExportFileInput>,
    path: String,
) -> Result<batch::ImportPreflight, String> {
    let context = load_llm_batch_context(&app, &mod_unique_id, &files, Path::new(&path))?;
    batch::preflight_batch(
        &context.parsed,
        &mod_unique_id,
        &context.target_lang,
        &context.rows_by_dir,
    )
    .inspect_err(|error| log::error!("preflight_llm_batch_path({mod_unique_id}) failed: {error}"))
}

fn import_llm_batch_from_path(
    app: &AppHandle,
    mod_unique_id: &str,
    files: &[export::ExportFileInput],
    source: &Path,
) -> Result<batch::ImportSummary, String> {
    // Import reruns the complete read-only analysis immediately before the
    // first write, so a changed file or changed local/source state is refused.
    let context = load_llm_batch_context(app, mod_unique_id, files, source)?;
    let prepared = batch::apply_batch(
        &context.parsed,
        mod_unique_id,
        &context.target_lang,
        &context.rows_by_dir,
    )?;
    if !prepared.entries.is_empty() {
        translations::save_many(&context.config, mod_unique_id, prepared.entries)?;
    }
    Ok(prepared.summary)
}

/// Import a dropped LLM batch/result path through the same safe pipeline as
/// the picker command.
#[tauri::command]
fn import_llm_batch_path(
    app: AppHandle,
    history: State<'_, operation_history::OperationHistoryState>,
    mod_unique_id: String,
    files: Vec<export::ExportFileInput>,
    path: String,
) -> Result<batch::ImportSummary, String> {
    let source = Path::new(&path);
    let summary =
        import_llm_batch_from_path(&app, &mod_unique_id, &files, source).inspect_err(|error| {
            log::error!("import_llm_batch_path({mod_unique_id}) failed: {error}")
        })?;
    remember_llm_batch_import(&history, &summary, source, &mod_unique_id);
    Ok(summary)
}

/// The Mods folder to scan for community language packs: the user's configured
/// `mods_path` when set, else the default `<Stardew>/Mods`.
fn mods_dir(config: &Path, stardew_path: &str) -> PathBuf {
    settings::load(config)
        .mods_path
        .map(PathBuf::from)
        .unwrap_or_else(|| detection::mods_path_for(Path::new(stardew_path)))
}

/// Load the glossary that is safe to use for runtime hints/prompts. Official
/// language caches are self-contained; community-pack caches are used only while
/// the matching pack is still installed, so removing a pack returns the app to
/// the no-glossary fallback promised for unsupported languages.
fn load_active_glossary(config: &Path, target_lang: &str) -> Option<glossary::Glossary> {
    let cached = glossary::load(config, target_lang)?;
    if glossary::game_locale_suffix(target_lang).is_some() {
        return Some(cached);
    }
    if cached.source != glossary::GlossarySource::CommunityPack {
        return None;
    }
    let settings = settings::load(config);
    let stardew_path = settings.stardew_path.as_deref()?;
    let pack = lang_pack::detect_language_pack(&mods_dir(config, stardew_path), target_lang).pack?;
    match cached.pack_name.as_deref() {
        Some(name) if name == pack.name => Some(cached),
        _ => None,
    }
}

#[tauri::command]
fn build_glossary(
    app: AppHandle,
    stardew_path: String,
    target_lang: String,
) -> Result<glossary::GlossaryInfo, String> {
    let target_lang = language::normalize_target_code(&target_lang)?;
    let config = config_dir(&app)?;
    let unpacked = glossary::default_unpacked_path(Path::new(&stardew_path));
    // A game-supported language builds from official content; a game-unsupported
    // one (e.g. Thai) builds from an installed community language pack.
    let built = if glossary::game_locale_suffix(&target_lang).is_some() {
        glossary::build_from_game(Path::new(&stardew_path), &target_lang)
    } else {
        let mods = mods_dir(&config, &stardew_path);
        match lang_pack::detect_language_pack(&mods, &target_lang).pack {
            Some(pack) => glossary::build_from_pack(
                &unpacked,
                &pack.strings_dir,
                pack.format,
                &target_lang,
                &pack.name,
            ),
            None => Err(format!(
                "No community language pack for \"{target_lang}\" was found in your Mods folder."
            )),
        }
    }
    .inspect_err(|error| log::error!("build_glossary({target_lang}) failed: {error}"))?;
    glossary::save(&config, &built)?;
    Ok(glossary::GlossaryInfo::of(&built))
}

#[tauri::command]
fn load_glossary(
    app: AppHandle,
    target_lang: String,
) -> Result<Option<glossary::Glossary>, String> {
    let target_lang = language::normalize_target_code(&target_lang)?;
    let config = config_dir(&app)?;
    glossary::migrate_legacy_cache(&config);
    Ok(load_active_glossary(&config, &target_lang))
}

#[tauri::command]
fn glossary_status(
    app: AppHandle,
    stardew_path: String,
    target_lang: String,
) -> Result<glossary::GlossaryStatus, String> {
    let target_lang = language::normalize_target_code(&target_lang)?;
    let config = config_dir(&app)?;
    glossary::migrate_legacy_cache(&config);
    let cached =
        load_active_glossary(&config, &target_lang).map(|g| glossary::GlossaryInfo::of(&g));
    // A legacy single `glossary.json` still present after migration is an
    // unmigratable old/invalid cache — the UI surfaces a "rebuild recommended" note.
    let outdated_cache = glossary::legacy_cache_present(&config);
    // For a game-unsupported language, see whether an installed community pack
    // could supply a glossary. Skipped for supported languages (they build
    // from official content) — so the Mods folder is only scanned when relevant.
    let stardew = Path::new(&stardew_path);
    let game_xnb_present = glossary::game_xnb_present(stardew);
    let unpacked_present = glossary::unpacked_present(stardew);
    let detected =
        if !target_lang.is_empty() && glossary::game_locale_suffix(&target_lang).is_none() {
            lang_pack::detect_language_pack(&mods_dir(&config, &stardew_path), &target_lang).pack
        } else {
            None
        };
    let pack_xnb_available = detected
        .as_ref()
        .is_some_and(|pack| pack.format == glossary::StringAssetFormat::Xnb);
    Ok(glossary::GlossaryStatus {
        game_xnb_present,
        unpacked_present,
        source_available: glossary::source_available(stardew),
        cached,
        outdated_cache,
        pack_available: detected.is_some(),
        pack_xnb_available,
        pack_name: detected.map(|pack| pack.name),
    })
}

/// List models from an OpenAI-compatible local server. Doubles as
/// the "Test connection" probe: success means the server is reachable.
#[tauri::command]
async fn llm_models(base_url: String) -> Result<Vec<String>, String> {
    llm::validate_base_url(&base_url)?;
    llm::list_models(&base_url)
        .await
        .inspect_err(|error| log::error!("llm_models({base_url}) failed: {error}"))
}

/// Translate one source string via the configured local LLM.
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
    llm::validate_base_url(&base_url)?;
    let target_lang = language::normalize_target_code(&target_lang)?;
    // Load only the glossary currently valid for the active language. For
    // unsupported languages, a community-pack cache is ignored after the pack is
    // removed so stale official-term hints never reach the prompt.
    let glossary_pairs = load_active_glossary(&config_dir(&app)?, &target_lang)
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

fn prepare_ai_request(
    app: &AppHandle,
    request: &ai::AiTranslationRequest,
) -> Result<
    (
        settings::AppSettings,
        String,
        PathBuf,
        Vec<ai::PreparedAiItem>,
    ),
    String,
> {
    ai::validate_request_shape(request)?;
    let config = config_dir(app)?;
    let settings = settings::load_checked(&config)?;
    let target_lang = settings
        .target_lang
        .as_deref()
        .ok_or_else(|| "Choose a target language before using AI translation.".to_string())?;
    let target_lang = language::normalize_target_code(target_lang)?;
    let target_language = language::target_language_name(&target_lang)?.to_string();
    let mods_path = settings
        .mods_path
        .as_deref()
        .map(PathBuf::from)
        .or_else(|| {
            settings
                .stardew_path
                .as_deref()
                .map(|path| detection::mods_path_for(Path::new(path)))
        })
        .ok_or_else(|| "Choose a Mods folder before using AI translation.".to_string())?;
    if !mods_path.is_dir() {
        return Err("The configured Mods folder is unavailable.".to_string());
    }

    // Never trust source text, file paths, section labels, or scope membership
    // from the webview. Resolve every requested identity from a fresh scan and
    // load rows only through the paths returned by that scan.
    let scan = scanner::scan_mods(&mods_path, &target_lang, &config);
    let translation_root = translations::language_root(&config, &target_lang)?;
    let mut rows = Vec::new();
    for scanned in scan.mods {
        let state_snapshot = translations::load_snapshot(&translation_root, &scanned.unique_id)?;
        let state = &state_snapshot.state;
        for file in scanned.i18n_files {
            let default_path = PathBuf::from(&file.default_path);
            let target_path = PathBuf::from(&file.target_path);
            let relative_dir = file.relative_dir;
            let current =
                scanner::load_strings_checked(&default_path, &target_path, state, &relative_dir)?;
            rows.extend(current.into_iter().map(|row| {
                let state_key = translations::entry_key(&relative_dir, &row.key);
                ai::AiScopeRow {
                    identity: ai::AiStringIdentity {
                        mod_unique_id: scanned.unique_id.clone(),
                        relative_dir: relative_dir.clone(),
                        key: row.key,
                    },
                    source: row.source,
                    section: row.section,
                    status: row.status,
                    default_path: default_path.clone(),
                    target_path: target_path.clone(),
                    expected_stored: state.get(&state_key).cloned(),
                    expected_revision: state_snapshot.entry_revision(&state_key),
                }
            }));
        }
    }
    let resolved = ai::resolve_scope(request, &rows)?;
    let glossary = load_active_glossary(&config, &target_lang);
    let prepared = ai::prepare_items(&resolved, |source| {
        glossary
            .as_ref()
            .map(|glossary| glossary::match_terms(source, glossary))
            .unwrap_or_default()
    })?;
    Ok((settings, target_language, translation_root, prepared))
}

fn ai_run_result(
    request: &ai::AiTranslationRequest,
    requested: usize,
    provider: (&str, String, String),
    suggestions: Vec<ai::AiSuggestion>,
    outcome: ai::AiRunOutcome,
    error: Option<String>,
) -> ai::AiRunResult {
    let (engine, model, reasoning) = provider;
    ai::AiRunResult {
        run_id: request.run_id.clone(),
        engine: engine.to_string(),
        model,
        reasoning,
        scope: request.scope,
        requested,
        completed: suggestions.len(),
        outcome,
        error,
        suggestions,
    }
}

fn stage_ai_suggestions(
    translation_root: &Path,
    items: &[ai::PreparedAiItem],
    generated: Vec<ai::AiSuggestion>,
    staged: &mut Vec<ai::AiSuggestion>,
) -> Result<(), String> {
    if generated.len() != items.len() {
        return Err("The validated AI result no longer matches its source chunk.".to_string());
    }
    for (item, mut suggestion) in items.iter().zip(generated) {
        if suggestion.identity != item.identity {
            return Err(
                "The validated AI result no longer matches its string identity.".to_string(),
            );
        }

        // Re-read the real source/target files and current portable state just
        // before each write. The provider may have taken minutes; a newer user
        // edit or source update must win instead of being overwritten.
        let current_state = translations::load(translation_root, &item.identity.mod_unique_id)?;
        let current_rows = scanner::load_strings_checked(
            &item.default_path,
            &item.target_path,
            &current_state,
            &item.identity.relative_dir,
        )?;
        let current = current_rows
            .iter()
            .find(|row| row.key == item.identity.key)
            .filter(|row| {
                row.source == item.source
                    && (row.status == "untranslated" || row.status == "outdated")
            })
            .ok_or_else(|| {
                "A string changed while AI translation was running. Already completed suggestions remain saved in Review."
                    .to_string()
            })?;
        let key = translations::entry_key(&item.identity.relative_dir, &item.identity.key);
        let entry = translations::StoredString {
            target: suggestion.text.clone(),
            status: "review-needed".to_string(),
            source_hash: translations::source_hash(&current.source),
        };
        if translations::save_one_if_unchanged(
            translation_root,
            &item.identity.mod_unique_id,
            &key,
            item.expected_stored.as_ref(),
            item.expected_revision,
            entry,
        )? == translations::ConditionalSaveOutcome::Stale
        {
            return Err(
                "A string changed while AI translation was running. Already completed suggestions remain saved in Review."
                    .to_string(),
            );
        }
        suggestion.status = "review-needed".to_string();
        staged.push(suggestion);
    }
    Ok(())
}

fn remember_ai_run(
    history: &State<'_, operation_history::OperationHistoryState>,
    result: &ai::AiRunResult,
) {
    let engine_label = match result.engine.as_str() {
        "local" => "Local AI",
        "codex" => "Codex CLI",
        _ => "AI",
    };
    let scope = match result.scope {
        ai::AiScope::OneString => "One string",
        ai::AiScope::Selected => "Selected strings",
    };
    let summary = match result.outcome {
        ai::AiRunOutcome::Complete => {
            format!("{} suggestions staged for review.", result.completed)
        }
        ai::AiRunOutcome::Cancelled => format!(
            "Cancelled after {} of {} suggestions.",
            result.completed, result.requested
        ),
        ai::AiRunOutcome::Error => format!(
            "Stopped after {} of {} suggestions.",
            result.completed, result.requested
        ),
    };
    remember_operation(
        history,
        operation_history::CompletedOperation {
            kind: operation_history::OperationKind::Ai,
            outcome: match result.outcome {
                ai::AiRunOutcome::Complete if result.error.is_none() => {
                    operation_history::OperationOutcome::Success
                }
                ai::AiRunOutcome::Complete => operation_history::OperationOutcome::Warning,
                ai::AiRunOutcome::Cancelled => operation_history::OperationOutcome::Cancelled,
                ai::AiRunOutcome::Error => operation_history::OperationOutcome::Failed,
            },
            title: format!("{engine_label} translation run"),
            summary,
            item_count: result.completed,
            path: None,
            file_name: None,
            warnings: result.error.iter().cloned().collect(),
            details: vec![
                operation_detail("Scope", scope),
                operation_detail("Requested", result.requested),
                operation_detail("Completed", result.completed),
                operation_detail("Model", &result.model),
                operation_detail("Reasoning", &result.reasoning),
            ],
        },
    );
}

/// Real local-AI batch contract. The existing single-string command remains for
/// backwards compatibility; the redesigned UI uses this bounded request/result
/// shape for both live engines.
#[tauri::command]
async fn translate_with_local_ai(
    app: AppHandle,
    state: State<'_, ai::AiRuntimeState>,
    history: State<'_, operation_history::OperationHistoryState>,
    request: ai::AiTranslationRequest,
) -> Result<ai::AiRunResult, String> {
    ai::validate_request_shape(&request)?;
    let lease = state.begin_run(&request.run_id)?;
    let (settings, target_language, translation_root, prepared) =
        prepare_ai_request(&app, &request)?;
    let local = settings
        .llm
        .ok_or_else(|| "Configure and test Local AI in Settings first.".to_string())?;
    llm::validate_base_url(&local.base_url)?;
    if local.model.trim().is_empty() {
        return Err("Choose a Local AI model in Settings first.".to_string());
    }
    let mut suggestions = Vec::with_capacity(prepared.len());
    let mut outcome = ai::AiRunOutcome::Complete;
    let mut error = None;
    for item in &prepared {
        if lease.cancelled.load(Ordering::Acquire) {
            outcome = ai::AiRunOutcome::Cancelled;
            break;
        }
        let translation = tokio::select! {
            result = llm::translate(
                &local.base_url,
                &local.model,
                &item.source,
                &target_language,
                item.section.as_deref(),
                &item.glossary_pairs,
                local.temperature,
            ) => result.map_err(ai::ProviderFailure::Message),
            () = ai::wait_for_cancel(lease.cancelled.clone()) => Err(ai::ProviderFailure::Cancelled),
        };
        match translation {
            Ok(result) => match ai::suggestions(
                std::slice::from_ref(item),
                vec![ai::ProviderTranslation {
                    id: item.id.clone(),
                    text: result.text,
                }],
            ) {
                Ok(completed) => {
                    if let Err(cause) = stage_ai_suggestions(
                        &translation_root,
                        std::slice::from_ref(item),
                        completed,
                        &mut suggestions,
                    ) {
                        outcome = ai::AiRunOutcome::Error;
                        error = Some(cause);
                        break;
                    }
                }
                Err(cause) => {
                    outcome = ai::AiRunOutcome::Error;
                    error = Some(cause);
                    break;
                }
            },
            Err(ai::ProviderFailure::Cancelled) => {
                outcome = ai::AiRunOutcome::Cancelled;
                break;
            }
            Err(ai::ProviderFailure::Message(cause)) => {
                outcome = ai::AiRunOutcome::Error;
                error = Some(cause);
                break;
            }
        }
    }
    outcome = lease.finish(outcome)?;
    let result = ai_run_result(
        &request,
        prepared.len(),
        ("local", local.model, "default".to_string()),
        suggestions,
        outcome,
        error,
    );
    log::info!(
        "Local AI run finished: {}/{} suggestions ({:?})",
        result.completed,
        result.requested,
        result.outcome
    );
    remember_ai_run(&history, &result);
    Ok(result)
}

#[tauri::command]
async fn codex_cli_status() -> codex_cli::CodexCliStatus {
    codex_cli::status().await
}

#[tauri::command]
async fn translate_with_codex_cli(
    app: AppHandle,
    state: State<'_, ai::AiRuntimeState>,
    history: State<'_, operation_history::OperationHistoryState>,
    request: ai::AiTranslationRequest,
) -> Result<ai::AiRunResult, String> {
    ai::validate_request_shape(&request)?;
    let lease = state.begin_run(&request.run_id)?;
    let (settings, target_language, translation_root, prepared) =
        prepare_ai_request(&app, &request)?;
    let reasoning = ai::normalize_reasoning(&settings.ai.codex_reasoning)?;
    let mut suggestions = Vec::with_capacity(prepared.len());
    let mut outcome = ai::AiRunOutcome::Complete;
    let mut error = None;
    for chunk in ai::chunks(&prepared) {
        if lease.cancelled.load(Ordering::Acquire) {
            outcome = ai::AiRunOutcome::Cancelled;
            break;
        }
        match codex_cli::translate_chunk(
            &reasoning,
            &target_language,
            chunk,
            lease.cancelled.clone(),
        )
        .await
        {
            Ok(translations) => match ai::suggestions(chunk, translations) {
                Ok(completed) => {
                    if let Err(cause) =
                        stage_ai_suggestions(&translation_root, chunk, completed, &mut suggestions)
                    {
                        outcome = ai::AiRunOutcome::Error;
                        error = Some(cause);
                        break;
                    }
                }
                Err(cause) => {
                    outcome = ai::AiRunOutcome::Error;
                    error = Some(cause);
                    break;
                }
            },
            Err(ai::ProviderFailure::Cancelled) => {
                outcome = ai::AiRunOutcome::Cancelled;
                break;
            }
            Err(ai::ProviderFailure::Message(cause)) => {
                outcome = ai::AiRunOutcome::Error;
                error = Some(cause);
                break;
            }
        }
    }
    outcome = lease.finish(outcome)?;
    let result = ai_run_result(
        &request,
        prepared.len(),
        ("codex", "Codex default".to_string(), reasoning),
        suggestions,
        outcome,
        error,
    );
    log::info!(
        "Codex CLI run finished: {}/{} suggestions ({:?})",
        result.completed,
        result.requested,
        result.outcome
    );
    remember_ai_run(&history, &result);
    Ok(result)
}

#[tauri::command]
fn cancel_ai_run(state: State<'_, ai::AiRuntimeState>, run_id: String) -> Result<bool, String> {
    state.cancel_run(&run_id)
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

/// Append a frontend-side error to the same diagnostic log file as the backend.
/// The webview cannot write the portable log itself, so this command
/// is the bridge: a caught UI error still lands in `data/logs/` for bug reports.
/// Fire-and-forget — logging must never itself surface an error to the user.
#[tauri::command]
fn log_frontend_error(context: String, message: String) {
    log::error!("[frontend] {context}: {message}");
}

/// Open the portable `data/logs/` folder in the OS file manager so a
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
    let target_lang = active_target_lang(app)?;
    translations::language_root(&config_dir(app)?, &target_lang)
}

fn active_target_lang(app: &AppHandle) -> Result<String, String> {
    let config = config_dir(app)?;
    settings::load_checked(&config)?
        .target_lang
        .ok_or_else(|| "Choose a target language before editing translations.".to_string())
}

/// Build the diagnostic-logging plugin. Writes a rotating log file to
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
        .manage(ai::AiRuntimeState::default())
        .manage(operation_history::OperationHistoryState::default())
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
            save_strings_with_undo,
            save_string_groups_with_undo,
            list_operation_history,
            undo_batch_edit,
            export_mod,
            export_all_mods,
            preview_translation_zip,
            pick_translation_zip_destination,
            build_translation_zip,
            export_llm_batch,
            pick_llm_batch_destination,
            export_llm_batch_to_path,
            import_llm_batch,
            pick_llm_batch_file,
            preflight_llm_batch_path,
            import_llm_batch_path,
            build_glossary,
            glossary_status,
            load_glossary,
            llm_models,
            translate_string,
            translate_with_local_ai,
            codex_cli_status,
            translate_with_codex_cli,
            cancel_ai_run,
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
mod glossary_runtime_tests {
    use super::*;

    fn write(path: &Path, body: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    fn community_glossary(pack_name: &str) -> glossary::Glossary {
        glossary::Glossary {
            format: glossary::GLOSSARY_FORMAT,
            source_lang: "default".to_string(),
            target_lang: "th".to_string(),
            term_count: 1,
            source: glossary::GlossarySource::CommunityPack,
            pack_name: Some(pack_name.to_string()),
            entries: vec![glossary::GlossaryEntry {
                source: "Parsnip".to_string(),
                target: "Pastinake".to_string(),
                kind: glossary::TermKind::Item,
                asset: "Objects".to_string(),
                key: "24".to_string(),
            }],
        }
    }

    fn install_pack(mods: &Path, name: &str) {
        let pack = mods.join(name);
        write(
            &pack.join("manifest.json"),
            &format!(
                r#"{{ "Name": "{name}", "UniqueID": "test.th.{name}",
                     "ContentPackFor": {{ "UniqueID": "Pathoschild.ContentPatcher" }} }}"#
            ),
        );
        write(
            &pack.join("content.json"),
            r#"{
              "Changes": [
                {
                  "Action": "EditData",
                  "Target": "Data/AdditionalLanguages",
                  "Entries": { "{{ModId}}": { "LanguageCode": "th" } }
                },
                {
                  "Action": "Load",
                  "Target": "Strings/Objects",
                  "FromFile": "assets/Content/{{Target}}.json",
                  "When": { "Language": "th" }
                }
              ]
            }"#,
        );
        write(
            &pack
                .join("assets")
                .join("Content")
                .join("Strings")
                .join("Objects.json"),
            r#"{ "24": "Pastinake" }"#,
        );
    }

    #[test]
    fn community_pack_cache_is_used_only_while_matching_pack_is_installed() {
        let config = test_support::temp_dir("active-glossary");
        let stardew = config.join("Game");
        let mods = stardew.join("Mods");
        settings::save(
            &config,
            &settings::AppSettings {
                stardew_path: Some(stardew.to_string_lossy().to_string()),
                mods_path: Some(mods.to_string_lossy().to_string()),
                target_lang: Some("th".to_string()),
                ..settings::AppSettings::default()
            },
        )
        .unwrap();
        glossary::save(&config, &community_glossary("Thai Pack")).unwrap();

        assert!(load_active_glossary(&config, "th").is_none());

        install_pack(&mods, "Other Pack");
        assert!(load_active_glossary(&config, "th").is_none());

        std::fs::remove_dir_all(mods.join("Other Pack")).unwrap();
        install_pack(&mods, "Thai Pack");
        assert!(load_active_glossary(&config, "th").is_some());

        std::fs::remove_dir_all(&config).ok();
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

#[cfg(test)]
mod json_output_limit_tests {
    use super::*;

    #[test]
    fn llm_batch_guard_matches_the_shared_import_limit() {
        ensure_llm_batch_json_size(input_limits::MAX_JSON_BYTES).unwrap();
        let error = ensure_llm_batch_json_size(input_limits::MAX_JSON_BYTES + 1).unwrap_err();
        assert!(error.contains("LLM batch JSON"));
        assert!(error.contains("64 MiB"));
    }

    #[test]
    fn llm_batch_writer_uses_the_existing_format_at_the_selected_path() {
        let root = test_support::temp_dir("llm-batch-write");
        std::fs::create_dir_all(&root).unwrap();
        let destination = root.join("selected.json");
        let items = vec![batch::BatchExportItem {
            relative_dir: "i18n".to_string(),
            key: "hello".to_string(),
            source: "Hello {{name}}".to_string(),
        }];

        let outcome = write_llm_batch(&destination, "Author.Mod", "de", &items).unwrap();

        assert_eq!(outcome.path, destination.display().to_string());
        assert_eq!(outcome.string_count, 1);
        let body = std::fs::read_to_string(&destination).unwrap();
        assert!(body.ends_with('\n'));
        let written: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(written, batch::build_batch("Author.Mod", "de", &items));

        std::fs::remove_dir_all(root).ok();
    }
}

#[cfg(test)]
mod ai_run_contract_tests {
    use super::*;

    #[test]
    fn failed_run_reports_resolved_count_and_keeps_completed_suggestions() {
        let request = ai::AiTranslationRequest {
            run_id: "run-partial".to_string(),
            scope: ai::AiScope::Selected,
            identities: vec![ai::AiStringIdentity {
                mod_unique_id: "example.component".to_string(),
                relative_dir: "i18n".to_string(),
                key: "greeting".to_string(),
            }],
            include_open: true,
            include_changed: true,
        };
        let identity = ai::AiStringIdentity {
            mod_unique_id: "example.component".to_string(),
            relative_dir: "i18n".to_string(),
            key: "greeting".to_string(),
        };
        let suggestion = ai::AiSuggestion {
            identity: identity.clone(),
            text: "Hallo".to_string(),
            status: "review-needed".to_string(),
            token_differences: Vec::new(),
            glossary_misses: Vec::new(),
        };

        let result = ai_run_result(
            &request,
            3,
            ("codex", "Codex default".to_string(), "medium".to_string()),
            vec![suggestion],
            ai::AiRunOutcome::Error,
            Some("provider stopped after one chunk".to_string()),
        );

        assert_eq!(result.requested, 3);
        assert_eq!(result.completed, 1);
        assert_eq!(result.outcome, ai::AiRunOutcome::Error);
        assert_eq!(result.suggestions[0].identity, identity);
        assert_eq!(result.suggestions[0].status, "review-needed");
        assert!(result.error.is_some());
    }

    #[test]
    fn completed_ai_suggestion_is_saved_as_review_and_never_overwrites_a_newer_edit() {
        let root = test_support::temp_dir("ai-stage-review");
        let i18n = root.join("fixture").join("i18n");
        std::fs::create_dir_all(&i18n).unwrap();
        let default_path = i18n.join("default.json");
        let target_path = i18n.join("de.json");
        std::fs::write(&default_path, r#"{"greeting":"Hello"}"#).unwrap();
        let translation_root = root.join("state");
        let identity = ai::AiStringIdentity {
            mod_unique_id: "example.mod".to_string(),
            relative_dir: "i18n".to_string(),
            key: "greeting".to_string(),
        };
        let item = ai::PreparedAiItem {
            id: "item-0000".to_string(),
            identity: identity.clone(),
            source: "Hello".to_string(),
            section: None,
            glossary_pairs: Vec::new(),
            default_path,
            target_path,
            expected_stored: None,
            expected_revision: 0,
        };
        let generated = ai::AiSuggestion {
            identity: identity.clone(),
            text: "Hallo".to_string(),
            // The staging boundary fixes this even if an internal caller ever
            // hands it an incorrect status.
            status: "translated".to_string(),
            token_differences: Vec::new(),
            glossary_misses: Vec::new(),
        };
        let mut staged = Vec::new();
        stage_ai_suggestions(
            &translation_root,
            std::slice::from_ref(&item),
            vec![generated.clone()],
            &mut staged,
        )
        .unwrap();
        let key = translations::entry_key("i18n", "greeting");
        let saved = translations::load(&translation_root, "example.mod").unwrap();
        assert_eq!(saved[&key].target, "Hallo");
        assert_eq!(saved[&key].status, "review-needed");
        assert_eq!(staged[0].status, "review-needed");

        translations::save_one(
            &translation_root,
            "example.mod",
            key.clone(),
            translations::StoredString {
                target: "Manual".to_string(),
                status: "translated".to_string(),
                source_hash: translations::source_hash("Hello"),
            },
        )
        .unwrap();
        assert!(stage_ai_suggestions(
            &translation_root,
            std::slice::from_ref(&item),
            vec![generated],
            &mut Vec::new(),
        )
        .is_err());
        assert_eq!(
            translations::load(&translation_root, "example.mod").unwrap()[&key].target,
            "Manual"
        );
        std::fs::remove_dir_all(root).ok();
    }
}
