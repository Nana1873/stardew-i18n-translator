//! Stardew i18n Translator — Tauri backend.
//!
//! Portable settings and translation state, Stardew detection, mod scanning,
//! i18n import/export, glossary extraction, and direct AI integrations.

mod ai;
mod ai_provider;
mod batch;
mod chatgpt;
mod chatgpt_auth;
mod chatgpt_response;
mod detection;
mod export;
mod glossary;
mod input_limits;
mod lang_pack;
mod language;
mod llm;
mod operation_history;
mod operation_log;
mod portable_profile;
mod release_zip;
mod scan_snapshot;
mod scanner;
mod settings;
mod tokens;
mod translations;
mod xnb;

#[cfg(test)]
mod language_compatibility;

use futures_util::{stream::FuturesUnordered, StreamExt};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use std::{fs::OpenOptions, io::Write};

use tauri::{AppHandle, Emitter, State};
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

fn scan_warning_counts(result: &ScanResult) -> Option<(usize, usize)> {
    let skipped_count = result
        .skipped_components
        .iter()
        .filter(|component| component.requires_attention)
        .count();
    (!result.warnings.is_empty() || skipped_count > 0)
        .then_some((result.warnings.len(), skipped_count))
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
    use operation_log::{Outcome, Summary};
    operation_log::run(
        "scan_mods",
        || {
            let target_lang = language::normalize_target_code(&target_lang)?;
            let config = config_dir(&app)?;
            let mods_root = PathBuf::from(mods_path.trim());
            if !mods_root.is_dir() {
                return Err(format!(
                    "The selected Mods folder {} is unavailable.",
                    mods_root.display()
                ));
            }
            let mut result = scanner::scan_mods(&mods_root, &target_lang, &config);
            if let Err(error) = scan_snapshot::apply(&mut result, &mods_root, &config) {
                log::warn!(target: "app", "Could not update source-change scan baseline: {error}");
                result.warnings.push(format!(
            "Source-change comparison is unavailable because its portable scan baseline could not be updated: {error}"
        ));
            }
            if let Some((warning_count, skipped_count)) = scan_warning_counts(&result) {
                log::warn!(
                    target: "app",
                    "scan_mods({target_lang}): {warning_count} warning(s), {skipped_count} skipped component(s)"
                );
            }
            log::info!(
                target: "app",
                "scan_mods({target_lang}): {} mods, {} i18n files",
                result.mod_count,
                result.file_count
            );
            Ok(result)
        },
        |r| {
            Summary::new(
                if r.traversal_complete {
                    Outcome::Success
                } else {
                    Outcome::Partial
                },
                r.mod_count,
                r.file_count,
                r.warnings.len(),
            )
        },
    )
}

#[cfg(test)]
mod scan_logging_tests {
    use super::*;

    fn skipped_component(requires_attention: bool) -> scanner::SkippedComponent {
        scanner::SkippedComponent {
            package_id: None,
            component_unique_id: None,
            component_name: None,
            relative_location: "fixture/manifest.json".to_string(),
            reason: "Fixture diagnostic".to_string(),
            requires_attention,
            rest_of_package_loaded: false,
        }
    }

    #[test]
    fn expected_exclusion_alone_emits_no_warning_summary() {
        let result = ScanResult {
            skipped_components: vec![skipped_component(false)],
            ..ScanResult::default()
        };

        assert_eq!(scan_warning_counts(&result), None);
    }

    #[test]
    fn attention_required_skip_is_counted() {
        let result = ScanResult {
            skipped_components: vec![skipped_component(true)],
            ..ScanResult::default()
        };

        assert_eq!(scan_warning_counts(&result), Some((0, 1)));
    }

    #[test]
    fn scanner_warning_stays_visible_with_an_expected_exclusion() {
        let result = ScanResult {
            warnings: vec!["Fixture warning".to_string()],
            skipped_components: vec![skipped_component(false)],
            ..ScanResult::default()
        };

        assert_eq!(scan_warning_counts(&result), Some((1, 0)));
    }
}

#[tauri::command(async)]
fn load_strings(
    app: AppHandle,
    mod_unique_id: String,
    relative_dir: String,
    default_path: String,
    target_path: String,
) -> Result<Vec<scanner::StringRow>, String> {
    use operation_log::{Outcome, Summary};
    operation_log::run(
        "load_strings",
        || {
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
            translations::adopt_imported_baselines(&config, &mod_unique_id, baselines)?;
            Ok(rows)
        },
        |r| Summary::new(Outcome::Success, r.len(), 1, 0),
    )
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
    history: &operation_history::OperationHistoryState,
    operation: operation_history::CompletedOperation,
) {
    if let Err(error) = history.record(operation) {
        log::warn!(target: "app", "Could not retain completed operation result: {error}");
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

// Async export commands may overlap; their temporary files and rollback paths must not.
static EXPORT_WRITE: Mutex<()> = Mutex::new(());

fn export_write_guard() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    EXPORT_WRITE.try_lock().map_err(|error| match error {
        std::sync::TryLockError::WouldBlock => {
            "An export or settings update is already running. Wait for it to finish and try again."
                .to_string()
        }
        std::sync::TryLockError::Poisoned(_) => {
            "A previous export or settings update panicked. Restart the app before trying again."
                .to_string()
        }
    })
}

#[cfg(test)]
mod export_dispatch_tests {
    #[test]
    fn concurrent_export_is_rejected_and_completion_releases_the_guard() {
        let guard = super::export_write_guard().unwrap();
        let competing = std::thread::spawn(|| super::export_write_guard().is_err());
        assert!(competing.join().unwrap());
        drop(guard);
        assert!(super::export_write_guard().is_ok());
        let failed_export = || -> Result<(), String> {
            let _guard = super::export_write_guard()?;
            Err("fixture write failure".into())
        };
        assert!(failed_export().is_err());
        assert!(super::export_write_guard().is_ok());
    }
}

#[tauri::command(async)]
fn preview_export(
    app: AppHandle,
    mods: Vec<export::ExportModInput>,
) -> Result<export::ExportPreflight, String> {
    use operation_log::{Outcome, Summary};
    operation_log::run(
        "preview_export",
        || {
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
                .ok_or_else(|| {
                    "Configure the Stardew Valley Mods folder before exporting.".to_string()
                })?;
            let target_lang = settings.target_lang.ok_or_else(|| {
                "Choose a target language before exporting translations.".to_string()
            })?;
            let target_lang = language::normalize_target_code(&target_lang)?;
            let mods = export::resolve_scan_inputs(&mods_root, &target_lang, &config, &mods)?;
            let files = mods
                .iter()
                .flat_map(|request| request.files.iter().cloned())
                .collect::<Vec<_>>();
            export::validate_paths(&mods_root, &target_lang, &files)?;
            export::preview_export(&translations::language_root(&config, &target_lang)?, &mods)
                .inspect_err(|error| log::error!(target: "app", "preview_export failed: {error}"))
        },
        |r| {
            Summary::new(
                if r.blocking_problem.is_some() {
                    Outcome::Blocked
                } else {
                    Outcome::Success
                },
                0,
                0,
                usize::from(r.blocking_problem.is_some()),
            )
        },
    )
}

#[tauri::command(async)]
fn export_mod(
    app: AppHandle,
    history: State<'_, operation_history::OperationHistoryState>,
    mod_unique_id: String,
    files: Vec<export::ExportFileInput>,
) -> Result<export::ExportResult, String> {
    use operation_log::{Outcome, Summary};
    operation_log::run(
        "export_mod",
        || {
            let _export_guard = export_write_guard()?;
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
                .ok_or_else(|| {
                    "Configure the Stardew Valley Mods folder before exporting.".to_string()
                })?;
            let target_lang = settings.target_lang.ok_or_else(|| {
                "Choose a target language before exporting translations.".to_string()
            })?;
            let target_lang = language::normalize_target_code(&target_lang)?;
            let mut resolved = export::resolve_scan_inputs(
                &mods_root,
                &target_lang,
                &config,
                &[export::ExportModInput {
                    mod_unique_id,
                    mod_name: String::new(),
                    files,
                }],
            )?;
            let resolved = resolved
                .pop()
                .ok_or_else(|| "Refusing export: no component was selected.".to_string())?;
            export::validate_paths(&mods_root, &target_lang, &resolved.files)?;
            let translation_config = translations::language_root(&config, &target_lang)?;
            let result = export::export_mod(
        &translation_config,
        &resolved.mod_unique_id,
        &resolved.files,
    )
    .inspect_err(|error| {
        log::error!(target: "app", "export_mod({}) failed: {error}", resolved.mod_unique_id)
    })?;
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
                        operation_detail("Component", &resolved.mod_unique_id),
                        operation_detail("Strings written", result.total_written_keys),
                        operation_detail("Open strings omitted", result.total_untranslated),
                        operation_detail("Changed strings included", result.total_outdated),
                        operation_detail("Review strings included", result.total_review_needed),
                        operation_detail(
                            "Entries without English source omitted",
                            result.total_orphan_keys,
                        ),
                    ],
                },
            );
            Ok(result)
        },
        |r| {
            Summary::new(
                if r.blocked {
                    Outcome::Blocked
                } else {
                    Outcome::Success
                },
                r.total_written_keys,
                r.files_written,
                r.skipped.len(),
            )
        },
    )
}

#[tauri::command(async)]
fn export_all_mods(
    app: AppHandle,
    history: State<'_, operation_history::OperationHistoryState>,
    mods: Vec<export::ExportModInput>,
) -> Result<export::ExportAllResult, String> {
    use operation_log::{Outcome, Summary};
    operation_log::run(
        "export_all_mods",
        || {
            let _export_guard = export_write_guard()?;
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
                .ok_or_else(|| {
                    "Configure the Stardew Valley Mods folder before exporting.".to_string()
                })?;
            let target_lang = settings.target_lang.ok_or_else(|| {
                "Choose a target language before exporting translations.".to_string()
            })?;
            let target_lang = language::normalize_target_code(&target_lang)?;
            let mods = export::resolve_scan_inputs(&mods_root, &target_lang, &config, &mods)?;
            let files = mods
                .iter()
                .flat_map(|request| request.files.iter().cloned())
                .collect::<Vec<_>>();
            // Validate in one pass so duplicate targets are rejected across mod groups,
            // not only within each individual group.
            export::validate_paths(&mods_root, &target_lang, &files)?;
            let translation_config = translations::language_root(&config, &target_lang)?;
            let result = export::export_all_mods(&translation_config, &mods).inspect_err(
                |error| log::error!(target: "app", "export_all_mods failed: {error}"),
            )?;
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
                        operation_detail("Open strings omitted", result.total_untranslated),
                        operation_detail("Changed strings included", result.total_outdated),
                        operation_detail("Review strings included", result.total_review_needed),
                        operation_detail(
                            "Entries without English source omitted",
                            result.total_orphan_keys,
                        ),
                    ],
                },
            );
            Ok(result)
        },
        |r| {
            Summary::new(
                if r.blocked {
                    Outcome::Blocked
                } else {
                    Outcome::Success
                },
                r.total_written_keys,
                r.files_written,
                usize::from(r.blocked),
            )
        },
    )
}

#[tauri::command(async)]
fn preview_translation_zip(
    app: AppHandle,
    mods_path: String,
    package_name: String,
    target_lang: String,
    target_language: String,
    components: Vec<release_zip::ZipComponentInput>,
) -> Result<release_zip::ZipPreview, String> {
    use operation_log::{Outcome, Summary};
    operation_log::run(
        "preview_translation_zip",
        || {
            let target_lang = language::normalize_target_code(&target_lang)?;
            let config = config_dir(&app)?;
            let components = release_zip::resolve_components(
                &config,
                Path::new(&mods_path),
                &package_name,
                &target_lang,
                &components,
            )?;
            release_zip::preview(
                &translations::language_root(&config, &target_lang)?,
                Path::new(&mods_path),
                &package_name,
                &target_lang,
                &target_language,
                &components,
            )
        },
        |r| {
            Summary::new(
                if r.problems.is_empty() {
                    Outcome::Success
                } else {
                    Outcome::Blocked
                },
                r.total_strings,
                r.entries.len(),
                r.problems.len(),
            )
        },
    )
}

#[tauri::command(async)]
fn preview_stardew_translator_output(app: AppHandle) -> Result<release_zip::ZipPreview, String> {
    use operation_log::{Outcome, Summary};
    operation_log::run(
        "preview_stardew_translator_output",
        || release_zip::preview_output(&config_dir(&app)?),
        |r| {
            Summary::new(
                if r.problems.is_empty() {
                    Outcome::Success
                } else {
                    Outcome::Blocked
                },
                r.total_strings,
                r.entries.len(),
                r.problems.len(),
            )
        },
    )
}

#[tauri::command(async)]
fn build_stardew_translator_output(
    app: AppHandle,
    history: State<'_, operation_history::OperationHistoryState>,
    destination: String,
    overwrite: bool,
    install_folders: Option<Vec<release_zip::ZipInstallFolder>>,
) -> Result<release_zip::ZipBuildOutcome, String> {
    use operation_log::{Outcome, Summary};
    operation_log::run(
        "build_stardew_translator_output",
        || {
            let _export_guard = export_write_guard()?;
            build_output_with_history(
                &config_dir(&app)?,
                &history,
                Path::new(&destination),
                overwrite,
                install_folders.as_deref().unwrap_or_default(),
            )
        },
        |r| Summary::new(Outcome::Success, r.strings, r.entries, 0),
    )
}

fn build_output_with_history(
    config: &Path,
    history: &operation_history::OperationHistoryState,
    destination: &Path,
    overwrite: bool,
    install_folders: &[release_zip::ZipInstallFolder],
) -> Result<release_zip::ZipBuildOutcome, String> {
    let result =
        release_zip::build_output_with_folders(config, destination, overwrite, install_folders)?;
    remember_zip_operation(history, &result, "Stardew Translator Output created");
    Ok(result)
}

fn remember_zip_operation(
    history: &operation_history::OperationHistoryState,
    result: &release_zip::ZipBuildOutcome,
    title: &str,
) {
    remember_operation(
        history,
        operation_history::CompletedOperation {
            kind: operation_history::OperationKind::Zip,
            outcome: operation_history::OperationOutcome::Success,
            title: title.to_string(),
            summary: format!(
                "{} strings packaged in {} translation files.",
                result.strings, result.entries
            ),
            item_count: result.strings,
            path: Some(result.path.clone()),
            file_name: Some(result.file_name.clone()),
            warnings: Vec::new(),
            details: vec![
                operation_detail("Destination folder", &result.folder),
                operation_detail("Translation files", result.entries),
                operation_detail("Strings", result.strings),
            ],
        },
    );
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

#[tauri::command(async)]
fn build_translation_zip(
    app: AppHandle,
    history: State<'_, operation_history::OperationHistoryState>,
    mut request: release_zip::ZipBuildRequest,
) -> Result<release_zip::ZipBuildOutcome, String> {
    use operation_log::{Outcome, Summary};
    operation_log::run(
        "build_translation_zip",
        || {
            let _export_guard = export_write_guard()?;
            request.target_lang = language::normalize_target_code(&request.target_lang)?;
            let config = config_dir(&app)?;
            request.components = release_zip::resolve_components(
                &config,
                Path::new(&request.mods_path),
                &request.package_name,
                &request.target_lang,
                &request.components,
            )?;
            let result = release_zip::build(
                &translations::language_root(&config, &request.target_lang)?,
                &request,
            )?;
            remember_zip_operation(&history, &result, "Translation ZIP created");
            Ok(result)
        },
        |r| Summary::new(Outcome::Success, r.strings, r.entries, 0),
    )
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

/// Write the selected strings as an external LLM translation batch.
/// Opens a save dialog and writes the minimal format-2
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
    untrusted_files: &[export::ExportFileInput],
    source: &Path,
) -> Result<LlmBatchContext, String> {
    load_llm_batch_context_from_config(&config_dir(app)?, mod_unique_id, untrusted_files, source)
}

fn load_llm_batch_context_from_config(
    config: &Path,
    mod_unique_id: &str,
    _untrusted_files: &[export::ExportFileInput],
    source: &Path,
) -> Result<LlmBatchContext, String> {
    let body = input_limits::read_json_text(source)?;
    // Lenient parse: LLM output sometimes carries trailing commas or comments.
    let parsed = scanner::parse_json_lenient(&body)
        .map_err(|error| format!("Invalid JSON in {}: {error}", source.display()))?;

    let saved_settings = settings::load_checked(config)?;
    let target_lang = saved_settings
        .target_lang
        .as_deref()
        .ok_or_else(|| "Choose a target language before importing an LLM batch.".to_string())?;
    let target_lang = language::normalize_target_code(target_lang)?;
    let mods_path = saved_settings
        .mods_path
        .as_deref()
        .map(PathBuf::from)
        .or_else(|| {
            saved_settings
                .stardew_path
                .as_deref()
                .map(|path| detection::mods_path_for(Path::new(path)))
        })
        .ok_or_else(|| "Choose a Mods folder before importing an LLM batch.".to_string())?;
    if !mods_path.is_dir() {
        return Err("The configured Mods folder is unavailable.".to_string());
    }

    // The WebView's file list is display state, not an authorization boundary.
    // Resolve the selected component and all source/target paths from a fresh
    // backend scan so stale or substituted IPC paths cannot change the import.
    let scan = scanner::scan_mods(&mods_path, &target_lang, config);
    let scanned = scan
        .mods
        .into_iter()
        .find(|candidate| candidate.unique_id == mod_unique_id)
        .ok_or_else(|| {
            format!(
                "The selected mod component \"{mod_unique_id}\" is not available in a fresh scan of the configured Mods folder. Scan again and retry."
            )
        })?;

    let translation_root = translations::language_root(config, &target_lang)?;
    let state = translations::load(&translation_root, mod_unique_id)?;
    let mut rows_by_dir = std::collections::HashMap::new();
    for file in scanned.i18n_files {
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
        config: translation_root,
        rows_by_dir,
    })
}

/// Analyze one selected LLM result without writing translation state. A file
/// for another mod returns its binding metadata so the frontend can offer a
/// deliberate switch and rerun this command with that component's id; the
/// backend resolves its current files again.
#[tauri::command]
fn preflight_llm_batch_path(
    app: AppHandle,
    mod_unique_id: String,
    files: Vec<export::ExportFileInput>,
    path: String,
) -> Result<batch::ImportPreflight, String> {
    use operation_log::{Outcome, Summary};
    operation_log::run(
        "preflight_llm_batch_path",
        || {
            let context = load_llm_batch_context(&app, &mod_unique_id, &files, Path::new(&path))?;
            batch::preflight_batch(
        &context.parsed,
        &mod_unique_id,
        &context.target_lang,
        &context.rows_by_dir,
    )
    .inspect_err(|error| {
        log::error!(target: "app", "preflight_llm_batch_path({mod_unique_id}) failed: {error}")
    })
        },
        |r| {
            Summary::new(
                if r.ready {
                    Outcome::Success
                } else {
                    Outcome::Blocked
                },
                r.importable,
                0,
                r.protected_token_issues.len(),
            )
        },
    )
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
    use operation_log::{Outcome, Summary};
    operation_log::run(
        "import_llm_batch_path",
        || {
            let source = Path::new(&path);
            let summary =
        import_llm_batch_from_path(&app, &mod_unique_id, &files, source).inspect_err(|error| {
            log::error!(target: "app", "import_llm_batch_path({mod_unique_id}) failed: {error}")
        })?;
            remember_llm_batch_import(&history, &summary, source, &mod_unique_id);
            Ok(summary)
        },
        |r| Summary::new(Outcome::Success, r.imported, 0, r.unmatched),
    )
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
    .inspect_err(
        |error| log::error!(target: "app", "build_glossary({target_lang}) failed: {error}"),
    )?;
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
    if let Err(error) = llm::validate_base_url(&base_url) {
        log::warn!(
            target: "ai_run",
            "{}",
            local_ai_model_probe_diagnostic("configuration")
        );
        return Err(error);
    }
    match llm::list_models(&base_url).await {
        Ok(models) => Ok(models),
        Err(error) => {
            log::warn!(
                target: "ai_run",
                "{}",
                local_ai_model_probe_diagnostic(local_ai_error_category(&error))
            );
            Err(error)
        }
    }
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
    let requested_components = request
        .identities
        .iter()
        .map(|identity| identity.mod_unique_id.clone())
        .collect::<HashSet<_>>();
    let rows = load_ai_scope_rows(scan, &translation_root, &requested_components)?;
    let resolved = ai::resolve_scope(request, &rows)?;
    let glossary = load_active_glossary(&config, &target_lang);
    let prepared = ai::prepare_items_with_context(&resolved, &rows, |source| {
        glossary
            .as_ref()
            .map(|glossary| glossary::match_terms(source, glossary))
            .unwrap_or_default()
    })?;
    Ok((settings, target_language, translation_root, prepared))
}

fn load_ai_scope_rows(
    scan: scanner::ScanResult,
    translation_root: &Path,
    requested_components: &HashSet<String>,
) -> Result<Vec<ai::AiScopeRow>, String> {
    let mut rows = Vec::new();
    for scanned in scan
        .mods
        .into_iter()
        .filter(|scanned| requested_components.contains(&scanned.unique_id))
    {
        let state_snapshot = translations::load_snapshot(translation_root, &scanned.unique_id)?;
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
    Ok(rows)
}

#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AiRunTokenUsage {
    input_tokens: u64,
    cached_input_tokens: u64,
    output_tokens: u64,
    reasoning_output_tokens: u64,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AiRunProgress {
    run_id: String,
    phase: &'static str,
    completed: usize,
    translated: usize,
    #[serde(skip)]
    translated_ids: HashSet<String>,
    total: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    batch_index: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    batch_total: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    batch_size: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    active_batches: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    parallel_limit: Option<usize>,
    retries: usize,
    splits: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    recovery: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    provider_stage: Option<&'static str>,
    provider_activity_sequence: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    usage: Option<AiRunTokenUsage>,
}

impl AiRunProgress {
    fn record_translated(&mut self, ids: impl IntoIterator<Item = String>) {
        // Recovery can revisit drafts or skip items before saving. Count each
        // generated item ID once, independently of the persisted count.
        self.translated_ids.extend(ids);
        self.translated = self.translated_ids.len().min(self.total);
    }
}

fn safe_ai_run_id_for_log(run_id: &str) -> &str {
    if !run_id.is_empty()
        && run_id.len() <= 128
        && run_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        run_id
    } else {
        "redacted"
    }
}

fn provider_activity_stage(activity: ai_provider::ProviderActivity) -> &'static str {
    match activity {
        ai_provider::ProviderActivity::Starting => "starting",
        ai_provider::ProviderActivity::Working => "working",
        ai_provider::ProviderActivity::Reasoning => "reasoning",
        ai_provider::ProviderActivity::WritingResponse => "writingResponse",
        ai_provider::ProviderActivity::Completed => "completed",
        ai_provider::ProviderActivity::Failed => "failed",
    }
}

fn provider_failure_category(failure: &ai::ProviderFailure) -> &'static str {
    match failure {
        ai::ProviderFailure::Cancelled => "cancelled",
        ai::ProviderFailure::Transient(_) => "transient",
        ai::ProviderFailure::InvalidResponse(_) => "invalidResponse",
        ai::ProviderFailure::Message(_) => "provider",
    }
}

fn local_ai_error_category(error: &str) -> &'static str {
    let normalized = error.to_ascii_lowercase();
    if normalized.contains("timed out") || normalized.contains("timeout") {
        "timeout"
    } else if normalized.contains("too large") {
        "responseTooLarge"
    } else if normalized.contains("not valid utf-8")
        || normalized.contains("could not read the server response")
    {
        "invalidResponse"
    } else if normalized.starts_with("server returned ") {
        "httpStatus"
    } else if normalized.contains("could not reach ") {
        "unreachable"
    } else if normalized.contains("could not create http client") {
        "clientSetup"
    } else if normalized.contains("qwen3 thinking model supports only thinking mode") {
        "configuration"
    } else {
        "provider"
    }
}

fn local_ai_error_is_systemic(error_category: &str) -> bool {
    matches!(
        error_category,
        "unreachable" | "httpStatus" | "clientSetup" | "configuration"
    )
}

fn local_ai_model_probe_diagnostic(error_category: &'static str) -> serde_json::Value {
    serde_json::json!({
        "event": "model_probe_failed",
        "engine": "local",
        "errorCategory": error_category,
    })
}

#[derive(Debug)]
struct LocalAiItemFailure {
    identity: ai::AiStringIdentity,
    cause: String,
}

fn bounded_single_line(value: &str, max_chars: usize) -> String {
    let mut bounded = String::new();
    let mut char_count = 0;
    let mut pending_space = false;
    let mut truncated = false;
    for character in value.chars() {
        if character.is_whitespace() {
            pending_space = char_count > 0;
            continue;
        }
        if pending_space {
            if char_count == max_chars {
                truncated = true;
                break;
            }
            bounded.push(' ');
            char_count += 1;
            pending_space = false;
        }
        if char_count == max_chars {
            truncated = true;
            break;
        }
        bounded.push(character);
        char_count += 1;
    }
    if truncated {
        bounded.push_str("...");
    }
    bounded
}

fn local_ai_failure_summary(failures: &[LocalAiItemFailure]) -> Option<String> {
    const MAX_DETAILS: usize = 8;
    if failures.is_empty() {
        return None;
    }
    let detail_count = failures.len().min(MAX_DETAILS);
    let details = failures
        .iter()
        .take(detail_count)
        .map(|failure| {
            let identity = format!(
                "{} / {} / {}",
                bounded_single_line(&failure.identity.mod_unique_id, 80),
                bounded_single_line(&failure.identity.relative_dir, 80),
                bounded_single_line(&failure.identity.key, 120)
            );
            format!("{}: {}", identity, bounded_single_line(&failure.cause, 320))
        })
        .collect::<Vec<_>>()
        .join("; ");
    let omitted = failures.len().saturating_sub(detail_count);
    let omitted_note = if omitted == 0 {
        String::new()
    } else {
        format!("; {omitted} additional failure(s) omitted from this summary")
    };
    let string_label = if failures.len() == 1 {
        "string"
    } else {
        "strings"
    };
    Some(format!(
        "{} selected {string_label} failed in Local AI. Any completed suggestions remain saved in Review. Failed strings: {details}{omitted_note}.",
        failures.len(),
    ))
}

fn combine_local_ai_errors(
    terminal_error: Option<String>,
    item_failures: &[LocalAiItemFailure],
) -> Option<String> {
    match (terminal_error, local_ai_failure_summary(item_failures)) {
        (Some(terminal), Some(summary)) => Some(format!("{terminal} {summary}")),
        (Some(terminal), None) => Some(terminal),
        (None, summary) => summary,
    }
}

fn emit_ai_progress(app: &AppHandle, progress: &AiRunProgress) {
    if let Err(error) = app.emit("ai-run-progress", progress.clone()) {
        // Progress is convenience state only. The final command result remains
        // authoritative if an event cannot be delivered to the webview.
        log::warn!(target: "app", "Could not emit AI run progress: {error}");
    }
}

fn update_ai_progress(
    app: &AppHandle,
    state: &Arc<Mutex<AiRunProgress>>,
    update: impl FnOnce(&mut AiRunProgress),
) {
    let snapshot = match state.lock() {
        Ok(mut progress) => {
            update(&mut progress);
            progress.clone()
        }
        Err(_) => {
            log::warn!(target: "app", "Could not update AI progress because its state is unavailable.");
            return;
        }
    };
    emit_ai_progress(app, &snapshot);
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
    let completed = suggestions.len();
    let outcome = if outcome == ai::AiRunOutcome::Error && completed > 0 {
        ai::AiRunOutcome::Complete
    } else {
        outcome
    };
    ai::AiRunResult {
        run_id: request.run_id.clone(),
        engine: engine.to_string(),
        model,
        reasoning,
        scope: request.scope,
        requested,
        completed,
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
    let mut groups = Vec::<(String, Vec<translations::ConditionalSaveEntry>)>::new();
    let mut completed = Vec::with_capacity(generated.len());
    let mut wanted_states = HashMap::<String, HashSet<String>>::new();
    for item in items {
        wanted_states
            .entry(item.identity.mod_unique_id.to_lowercase())
            .or_default()
            .insert(translations::entry_key(
                &item.identity.relative_dir,
                &item.identity.key,
            ));
    }
    let mut current_states = HashMap::new();
    let mut current_files = HashMap::new();
    for (item, mut suggestion) in items.iter().zip(generated) {
        if suggestion.identity != item.identity {
            return Err(
                "The validated AI result no longer matches its string identity.".to_string(),
            );
        }

        // Refresh each component and file once for this transaction. The
        // provider may have taken minutes; never reuse a previous chunk's view.
        // Conditional revisions still protect edits made after these reads.
        let mod_id = item.identity.mod_unique_id.to_lowercase();
        let wanted = &wanted_states[&mod_id];
        let current_state = match current_states.entry(mod_id.clone()) {
            std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
            std::collections::hash_map::Entry::Vacant(entry) => entry.insert(
                translations::load(translation_root, &item.identity.mod_unique_id)?
                    .into_iter()
                    .filter(|(key, _)| wanted.contains(key))
                    .collect::<translations::ModState>(),
            ),
        };
        let file = (
            mod_id,
            item.default_path.clone(),
            item.target_path.clone(),
            item.identity.relative_dir.clone(),
        );
        let current_rows = match current_files.entry(file) {
            std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
            std::collections::hash_map::Entry::Vacant(entry) => entry.insert(
                scanner::load_strings_checked(
                    &item.default_path,
                    &item.target_path,
                    current_state,
                    &item.identity.relative_dir,
                )?
                .into_iter()
                .filter(|row| {
                    wanted.contains(&translations::entry_key(
                        &item.identity.relative_dir,
                        &row.key,
                    ))
                })
                .map(|row| (row.key.clone(), row))
                .collect::<HashMap<_, _>>(),
            ),
        };
        let current = current_rows
            .get(&item.identity.key)
            .filter(|row| {
                row.source == item.source
                    && (row.status == "untranslated" || row.status == "outdated")
            })
            .ok_or_else(|| {
                "A string changed while AI translation was running. Any completed suggestions remain saved in Review."
                    .to_string()
            })?;
        let key = translations::entry_key(&item.identity.relative_dir, &item.identity.key);
        let entry = translations::StoredString {
            target: suggestion.text.clone(),
            status: "review-needed".to_string(),
            source_hash: translations::source_hash(&current.source),
        };
        let group = groups.iter_mut().find(|(mod_unique_id, _)| {
            mod_unique_id.eq_ignore_ascii_case(&item.identity.mod_unique_id)
        });
        let conditional = translations::ConditionalSaveEntry {
            key,
            expected: item.expected_stored.clone(),
            expected_revision: item.expected_revision,
            entry,
        };
        match group {
            Some((_, entries)) => entries.push(conditional),
            None => groups.push((item.identity.mod_unique_id.clone(), vec![conditional])),
        }
        suggestion.status = "review-needed".to_string();
        completed.push(suggestion);
    }

    if translations::save_groups_if_unchanged(translation_root, groups)?
        == translations::ConditionalSaveOutcome::Stale
    {
        return Err(
            "A string changed while AI translation was running. Any earlier completed chunks remain saved in Review."
                .to_string(),
        );
    }
    staged.extend(completed);
    Ok(())
}

/// ChatGPT review batches that could not complete and whose drafts were kept.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct ReviewSkips {
    items: usize,
    transient: bool,
    invalid_response: bool,
}

impl ReviewSkips {
    fn record(&mut self, item_count: usize, reason: ai_provider::ReviewSkipReason) {
        self.items = self.items.saturating_add(item_count);
        match reason {
            ai_provider::ReviewSkipReason::Transient => self.transient = true,
            ai_provider::ReviewSkipReason::InvalidResponse => self.invalid_response = true,
        }
    }

    fn absorb(&mut self, other: ReviewSkips) {
        self.items = self.items.saturating_add(other.items);
        self.transient |= other.transient;
        self.invalid_response |= other.invalid_response;
    }
}

/// A ChatGPT review that could not complete keeps the drafts. Only a completed
/// run gets the warning; cancelled and failed runs already report their cause.
fn review_skipped_warning(outcome: ai::AiRunOutcome, skips: ReviewSkips) -> Option<String> {
    if outcome != ai::AiRunOutcome::Complete || skips.items == 0 {
        return None;
    }
    let cause = match (skips.transient, skips.invalid_response) {
        (true, true) => "temporary ChatGPT failures and invalid review responses",
        (true, false) => "a temporary ChatGPT failure",
        _ => "an invalid review response",
    };
    Some(format!(
        "The ChatGPT quality review could not complete for {} string(s) ({cause}); their unreviewed translation drafts were kept. Check them carefully in Review.",
        skips.items
    ))
}

#[cfg(test)]
mod review_warning_tests {
    use super::{review_skipped_warning, ReviewSkips};
    use crate::ai::AiRunOutcome;
    use crate::ai_provider::ReviewSkipReason;

    #[test]
    fn review_warning_names_the_cause_and_only_attaches_to_completed_runs() {
        let mut skips = ReviewSkips::default();
        assert_eq!(review_skipped_warning(AiRunOutcome::Complete, skips), None);
        skips.record(3, ReviewSkipReason::Transient);
        let warning = review_skipped_warning(AiRunOutcome::Complete, skips).unwrap();
        assert!(warning.contains("could not complete for 3 string(s)"));
        assert!(warning.contains("temporary ChatGPT failure"));
        assert!(!warning.contains("retries"));
        assert_eq!(review_skipped_warning(AiRunOutcome::Cancelled, skips), None);
        assert_eq!(review_skipped_warning(AiRunOutcome::Error, skips), None);

        let mut saved = ReviewSkips::default();
        let mut chunk = ReviewSkips::default();
        chunk.record(1, ReviewSkipReason::InvalidResponse);
        saved.absorb(skips);
        saved.absorb(chunk);
        let warning = review_skipped_warning(AiRunOutcome::Complete, saved).unwrap();
        assert!(warning.contains("for 4 string(s)"));
        assert!(warning.contains("temporary ChatGPT failures and invalid review responses"));
    }
}

fn ai_operation_outcome(result: &ai::AiRunResult) -> operation_history::OperationOutcome {
    match result.outcome {
        ai::AiRunOutcome::Complete if result.error.is_none() => {
            operation_history::OperationOutcome::Success
        }
        ai::AiRunOutcome::Complete => operation_history::OperationOutcome::Warning,
        ai::AiRunOutcome::Cancelled => operation_history::OperationOutcome::Cancelled,
        ai::AiRunOutcome::Error => operation_history::OperationOutcome::Failed,
    }
}

fn remember_ai_run(
    history: &State<'_, operation_history::OperationHistoryState>,
    result: &ai::AiRunResult,
) {
    let engine_label = match result.engine.as_str() {
        "local" => "Local AI",
        "chatgpt" => "ChatGPT",
        "codex" => "Codex CLI",
        _ => "AI",
    };
    let scope = match result.scope {
        ai::AiScope::OneString => "One string",
        ai::AiScope::Selected => "Selected strings",
    };
    let summary = match result.outcome {
        ai::AiRunOutcome::Complete if result.error.is_some() => format!(
            "{} of {} suggestions saved in Review.",
            result.completed, result.requested
        ),
        ai::AiRunOutcome::Complete => {
            format!("{} suggestions staged for review.", result.completed)
        }
        ai::AiRunOutcome::Cancelled => format!(
            "Cancelled after {} of {} suggestions.",
            result.completed, result.requested
        ),
        ai::AiRunOutcome::Error => format!(
            "{} of {} suggestions saved in Review.",
            result.completed, result.requested
        ),
    };
    remember_operation(
        history,
        operation_history::CompletedOperation {
            kind: operation_history::OperationKind::Ai,
            outcome: ai_operation_outcome(result),
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
    let run_started_at = Instant::now();
    let log_run_id = safe_ai_run_id_for_log(&request.run_id).to_string();
    log::info!(
        target: "ai_run",
        "{}",
        serde_json::json!({
            "event": "run_started",
            "runId": log_run_id,
            "engine": "local",
            "total": prepared.len(),
            "batches": prepared.len(),
        })
    );
    let mut suggestions = Vec::with_capacity(prepared.len());
    let mut outcome = ai::AiRunOutcome::Complete;
    let mut terminal_error = None;
    let mut item_failures = Vec::new();
    let mut progress = AiRunProgress {
        run_id: request.run_id.clone(),
        phase: "preparing",
        completed: 0,
        translated: 0,
        translated_ids: HashSet::new(),
        total: prepared.len(),
        batch_index: None,
        batch_total: Some(prepared.len()),
        batch_size: None,
        active_batches: None,
        parallel_limit: None,
        retries: 0,
        splits: 0,
        recovery: None,
        provider_stage: None,
        provider_activity_sequence: 0,
        usage: None,
    };
    emit_ai_progress(&app, &progress);
    for (index, item) in prepared.iter().enumerate() {
        if lease.cancelled.load(Ordering::Acquire) {
            outcome = ai::AiRunOutcome::Cancelled;
            break;
        }
        progress.phase = "translating";
        progress.batch_index = Some(index + 1);
        progress.batch_size = Some(1);
        emit_ai_progress(&app, &progress);
        log::info!(
            target: "ai_run",
            "{}",
            serde_json::json!({
                "event": "batch_started",
                "runId": log_run_id,
                "batchIndex": index + 1,
                "batchTotal": prepared.len(),
                "batchSize": 1,
                "completed": suggestions.len(),
            })
        );
        let before_context = item
            .context
            .before
            .iter()
            .map(|entry| entry.source.clone())
            .collect::<Vec<_>>();
        let after_context = item
            .context
            .after
            .iter()
            .map(|entry| entry.source.clone())
            .collect::<Vec<_>>();
        let translation = tokio::select! {
            result = llm::translate_with_context(
                &local.base_url,
                &local.model,
                &item.source,
                &target_language,
                item.section.as_deref(),
                &item.glossary_pairs,
                &before_context,
                &after_context,
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
                    progress.record_translated([item.id.clone()]);
                    progress.phase = "saving";
                    emit_ai_progress(&app, &progress);
                    let staged_result = stage_ai_suggestions(
                        &translation_root,
                        std::slice::from_ref(item),
                        completed,
                        &mut suggestions,
                    );
                    progress.completed = suggestions.len();
                    emit_ai_progress(&app, &progress);
                    if let Err(cause) = staged_result {
                        log::info!(
                            target: "ai_run",
                            "{}",
                            serde_json::json!({
                                "event": "batch_finished",
                                "runId": log_run_id,
                                "batchIndex": index + 1,
                                "outcome": "savingError",
                            })
                        );
                        outcome = ai::AiRunOutcome::Error;
                        terminal_error = Some(cause);
                        break;
                    }
                    log::info!(
                        target: "ai_run",
                        "{}",
                        serde_json::json!({
                            "event": "batch_finished",
                            "runId": log_run_id,
                            "batchIndex": index + 1,
                            "outcome": "complete",
                            "completed": suggestions.len(),
                        })
                    );
                }
                Err(cause) => {
                    log::info!(
                        target: "ai_run",
                        "{}",
                        serde_json::json!({
                            "event": "batch_finished",
                            "runId": log_run_id,
                            "batchIndex": index + 1,
                            "outcome": "invalidResponse",
                            "errorCategory": "invalidResponse",
                        })
                    );
                    item_failures.push(LocalAiItemFailure {
                        identity: item.identity.clone(),
                        cause,
                    });
                }
            },
            Err(ai::ProviderFailure::Cancelled) => {
                log::info!(
                    target: "ai_run",
                    "{}",
                    serde_json::json!({
                        "event": "batch_finished",
                        "runId": log_run_id,
                        "batchIndex": index + 1,
                        "outcome": "cancelled",
                    })
                );
                outcome = ai::AiRunOutcome::Cancelled;
                break;
            }
            Err(
                ai::ProviderFailure::Message(cause)
                | ai::ProviderFailure::Transient(cause)
                | ai::ProviderFailure::InvalidResponse(cause),
            ) => {
                let error_category = local_ai_error_category(&cause);
                log::info!(
                    target: "ai_run",
                    "{}",
                    serde_json::json!({
                        "event": "batch_finished",
                        "runId": log_run_id,
                        "batchIndex": index + 1,
                        "outcome": "providerError",
                        "errorCategory": error_category,
                    })
                );
                item_failures.push(LocalAiItemFailure {
                    identity: item.identity.clone(),
                    cause,
                });
                if local_ai_error_is_systemic(error_category) {
                    outcome = ai::AiRunOutcome::Error;
                    break;
                }
            }
        }
    }
    if outcome == ai::AiRunOutcome::Complete && !item_failures.is_empty() {
        outcome = ai::AiRunOutcome::Error;
    }
    outcome = lease.finish(outcome)?;
    let error = combine_local_ai_errors(terminal_error, &item_failures);
    let result = ai_run_result(
        &request,
        prepared.len(),
        ("local", local.model, "default".to_string()),
        suggestions,
        outcome,
        error,
    );
    log::info!(
        target: "ai_run",
        "{}",
        serde_json::json!({
            "event": "run_finished",
            "runId": log_run_id,
            "engine": "local",
            "completed": result.completed,
            "total": result.requested,
            "failed": item_failures.len(),
            "outcome": result.outcome,
            "durationMs": u64::try_from(run_started_at.elapsed().as_millis()).unwrap_or(u64::MAX),
        })
    );
    remember_ai_run(&history, &result);
    Ok(result)
}

#[tauri::command]
async fn cloud_ai_status() -> ai_provider::CloudAiStatus {
    chatgpt::status().await
}

#[tauri::command]
async fn cloud_ai_models() -> Result<Vec<ai_provider::CloudAiModel>, String> {
    chatgpt::models().await
}

#[tauri::command]
async fn chatgpt_sign_in(app: AppHandle) -> Result<(), String> {
    let url = chatgpt_auth::login_url().await?;
    if app.opener().open_url(&url, None::<String>).is_err() {
        chatgpt_auth::abort_login().await;
        return Err("Could not open ChatGPT sign-in in your browser.".into());
    }
    Ok(())
}
#[tauri::command]
async fn chatgpt_sign_out() -> Result<(), String> {
    chatgpt_auth::logout().await
}

/// Signal native provider workers even if the command future is dropped.
struct CloudPipelineCancellation(Arc<AtomicBool>);

impl Drop for CloudPipelineCancellation {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

fn reduce_parallel_limit(limit: &AtomicUsize, retries: &AtomicUsize) {
    if retries.fetch_add(1, Ordering::AcqRel) % 2 == 1 {
        let mut current = limit.load(Ordering::Acquire);
        while let Err(observed) = limit.compare_exchange_weak(
            current,
            (current / 2).max(1),
            Ordering::AcqRel,
            Ordering::Acquire,
        ) {
            current = observed;
        }
    }
}

async fn complete_cloud_batch(
    model: Option<&str>,
    reasoning: &str,
    language: &str,
    quality_review: bool,
    chunk: &[ai::PreparedAiItem],
    cancelled: Arc<AtomicBool>,
    progress: ai_provider::ProviderProgressCallback,
) -> Result<(Vec<ai::ProviderTranslation>, bool), ai::ProviderFailure> {
    let translations = chatgpt::translate_chunk(
        model,
        reasoning,
        language,
        quality_review,
        chunk,
        Arc::clone(&cancelled),
        Arc::clone(&progress),
    )
    .await?;
    match chatgpt::repair_token_mismatches_once(
        model,
        reasoning,
        language,
        quality_review,
        chunk,
        &translations,
        cancelled,
        progress,
    )
    .await
    {
        Ok(repair) => Ok((repair.translations, repair.cancelled)),
        Err(ai::ProviderFailure::Cancelled) => Ok((translations, true)),
        Err(failure) => {
            log::warn!(target: "ai_run", "{}", serde_json::json!({"event":"token_repair_not_applied", "errorCategory":provider_failure_category(&failure)}));
            Ok((translations, false))
        }
    }
}

#[tauri::command]
async fn translate_with_cloud_ai(
    app: AppHandle,
    state: State<'_, ai::AiRuntimeState>,
    history: State<'_, operation_history::OperationHistoryState>,
    request: ai::AiTranslationRequest,
) -> Result<ai::AiRunResult, String> {
    ai::validate_request_shape(&request)?;
    let lease = state.begin_run(&request.run_id)?;
    let (settings, target_language, translation_root, prepared) =
        prepare_ai_request(&app, &request)?;
    let cloud_model = settings.ai.cloud_model.clone();
    let reasoning = ai::normalize_reasoning(&settings.ai.cloud_reasoning)?;
    let cloud_quality_review = settings.ai.cloud_quality_review;
    let mut suggestions = Vec::with_capacity(prepared.len());
    let mut outcome = ai::AiRunOutcome::Complete;
    let mut error = None;
    let chunks = ai::chunks(&prepared)?;
    let mut pending = chunks
        .into_iter()
        .enumerate()
        .map(|(index, chunk)| (index + 1, chunk))
        .collect::<VecDeque<_>>();
    let mut in_flight = FuturesUnordered::new();
    let pipeline_cancelled = Arc::new(AtomicBool::new(false));
    let _pipeline_lifetime = CloudPipelineCancellation(Arc::clone(&pipeline_cancelled));
    let parallel_limit = Arc::new(AtomicUsize::new(settings.ai.cloud_parallel_batches));
    let transient_retries = Arc::new(AtomicUsize::new(0));
    let mut stopping = false;
    let mut staging_available = true;
    let mut batch_attempt = 0usize;
    let mut batch_total = pending.len();
    let mut isolated_failures = 0usize;
    let mut last_isolated_failure = None;
    let run_started_at = Instant::now();
    let log_run_id = safe_ai_run_id_for_log(&request.run_id).to_string();
    let log_engine = "chatgpt";
    let log_transport = "responses";
    log::info!(
        target: "ai_run",
        "{}",
        serde_json::json!({
            "event": "run_started",
            "runId": log_run_id,
            "engine": log_engine,
            "transport": log_transport,
            "model": if cloud_model.is_some() { "configured" } else { "default" },
            "reasoning": reasoning,
            "total": prepared.len(),
            "batches": batch_total,
        })
    );
    let progress_state = Arc::new(Mutex::new(AiRunProgress {
        run_id: request.run_id.clone(),
        phase: "preparing",
        completed: 0,
        translated: 0,
        translated_ids: HashSet::new(),
        total: prepared.len(),
        batch_index: None,
        batch_total: Some(batch_total),
        batch_size: None,
        active_batches: None,
        parallel_limit: None,
        retries: 0,
        splits: 0,
        recovery: None,
        provider_stage: None,
        provider_activity_sequence: 0,
        usage: None,
    }));
    update_ai_progress(&app, &progress_state, |_| {});
    // Each pipeline owns its review skips; only successfully staged results count.
    let mut saved_review_skips = ReviewSkips::default();
    let cloud_progress = |batch_index: usize,
                          chunk_review_skips: Arc<Mutex<ReviewSkips>>|
     -> ai_provider::ProviderProgressCallback {
        let app = app.clone();
        let state = Arc::clone(&progress_state);
        let log_run_id = log_run_id.clone();
        let parallel_limit = Arc::clone(&parallel_limit);
        let transient_retries = Arc::clone(&transient_retries);
        Arc::new(move |event| {
            if let ai_provider::ProviderProgressEvent::ReviewSkipped { item_count, reason } = event
            {
                if let Ok(mut skips) = chunk_review_skips.lock() {
                    skips.record(item_count, reason);
                }
            }
            if matches!(event, ai_provider::ProviderProgressEvent::TransientRetry) {
                reduce_parallel_limit(&parallel_limit, &transient_retries);
            }
            let log_event = event.clone();
            update_ai_progress(&app, &state, |progress| {
                progress.batch_index = Some(batch_index);
                progress.parallel_limit = Some(parallel_limit.load(Ordering::Acquire));
                match event {
                    ai_provider::ProviderProgressEvent::DraftsReady { ids } => {
                        progress.record_translated(ids);
                    }
                    ai_provider::ProviderProgressEvent::Phase { phase, item_count } => {
                        progress.phase = match phase {
                            ai_provider::ProviderPhase::Translating => "translating",
                            ai_provider::ProviderPhase::Reviewing => "reviewing",
                            ai_provider::ProviderPhase::TerminologyRepair => "terminologyRepair",
                            ai_provider::ProviderPhase::TokenRepair => "tokenRepair",
                        };
                        progress.batch_size = Some(item_count);
                        progress.recovery = None;
                        progress.provider_stage = None;
                    }
                    ai_provider::ProviderProgressEvent::TransientRetry => {
                        progress.retries = progress.retries.saturating_add(1);
                        progress.recovery = Some("transientRetry");
                    }
                    ai_provider::ProviderProgressEvent::StructureRetry => {
                        progress.retries = progress.retries.saturating_add(1);
                        progress.recovery = Some("structureRetry");
                    }
                    ai_provider::ProviderProgressEvent::Split => {
                        progress.splits = progress.splits.saturating_add(1);
                        progress.recovery = Some("split");
                    }
                    ai_provider::ProviderProgressEvent::ReviewSkipped { .. } => {}
                    ai_provider::ProviderProgressEvent::Activity(activity) => {
                        progress.provider_stage = Some(provider_activity_stage(activity));
                        progress.provider_activity_sequence =
                            progress.provider_activity_sequence.saturating_add(1);
                    }
                    ai_provider::ProviderProgressEvent::Usage(usage) => {
                        let total = progress.usage.get_or_insert_with(AiRunTokenUsage::default);
                        total.input_tokens = total.input_tokens.saturating_add(usage.input_tokens);
                        total.cached_input_tokens = total
                            .cached_input_tokens
                            .saturating_add(usage.cached_input_tokens);
                        total.output_tokens =
                            total.output_tokens.saturating_add(usage.output_tokens);
                        total.reasoning_output_tokens = total
                            .reasoning_output_tokens
                            .saturating_add(usage.reasoning_output_tokens);
                    }
                }
            });
            match log_event {
                ai_provider::ProviderProgressEvent::DraftsReady { ids } => {
                    log::info!(target: "ai_run", "{}", serde_json::json!({
                        "event": "drafts_ready", "runId": log_run_id,
                        "itemCount": ids.len(),
                    }));
                }
                ai_provider::ProviderProgressEvent::Phase { phase, item_count } => {
                    let phase = match phase {
                        ai_provider::ProviderPhase::Translating => "translating",
                        ai_provider::ProviderPhase::Reviewing => "reviewing",
                        ai_provider::ProviderPhase::TerminologyRepair => "terminologyRepair",
                        ai_provider::ProviderPhase::TokenRepair => "tokenRepair",
                    };
                    log::info!(
                        target: "ai_run",
                        "{}",
                        serde_json::json!({
                            "event": "phase",
                            "runId": log_run_id,
                            "phase": phase,
                            "itemCount": item_count,
                        })
                    );
                }
                ai_provider::ProviderProgressEvent::TransientRetry => {
                    log::info!(
                        target: "ai_run",
                        "{}",
                        serde_json::json!({
                            "event": "recovery",
                            "runId": log_run_id,
                            "kind": "transientRetry",
                        })
                    );
                }
                ai_provider::ProviderProgressEvent::StructureRetry => {
                    log::info!(
                        target: "ai_run",
                        "{}",
                        serde_json::json!({
                            "event": "recovery",
                            "runId": log_run_id,
                            "kind": "structureRetry",
                        })
                    );
                }
                ai_provider::ProviderProgressEvent::Split => {
                    log::info!(
                        target: "ai_run",
                        "{}",
                        serde_json::json!({
                            "event": "recovery",
                            "runId": log_run_id,
                            "kind": "split",
                        })
                    );
                }
                ai_provider::ProviderProgressEvent::ReviewSkipped { item_count, reason } => {
                    log::warn!(
                        target: "ai_run",
                        "{}",
                        serde_json::json!({
                            "event": "review_skipped",
                            "runId": log_run_id,
                            "itemCount": item_count,
                            "reason": match reason {
                                ai_provider::ReviewSkipReason::Transient => "transient",
                                ai_provider::ReviewSkipReason::InvalidResponse => "invalidResponse",
                            },
                        })
                    );
                }
                ai_provider::ProviderProgressEvent::Activity(activity)
                    if matches!(
                        activity,
                        ai_provider::ProviderActivity::Starting
                            | ai_provider::ProviderActivity::Completed
                            | ai_provider::ProviderActivity::Failed
                    ) =>
                {
                    log::info!(
                        target: "ai_run",
                        "{}",
                        serde_json::json!({
                            "event": "provider_activity",
                            "runId": log_run_id,
                            "engine": log_engine,
                            "transport": log_transport,
                            "stage": provider_activity_stage(activity),
                        })
                    );
                }
                ai_provider::ProviderProgressEvent::Usage(usage) => {
                    log::info!(
                        target: "ai_run",
                        "{}",
                        serde_json::json!({
                            "event": "usage",
                            "runId": log_run_id,
                            "inputTokens": usage.input_tokens,
                            "cachedInputTokens": usage.cached_input_tokens,
                            "outputTokens": usage.output_tokens,
                            "reasoningOutputTokens": usage.reasoning_output_tokens,
                        })
                    );
                }
                ai_provider::ProviderProgressEvent::Activity(_) => {}
            }
        })
    };
    loop {
        if lease.cancelled.load(Ordering::Acquire) {
            stopping = true;
            pipeline_cancelled.store(true, Ordering::Release);
            if outcome == ai::AiRunOutcome::Complete {
                outcome = ai::AiRunOutcome::Cancelled;
            }
        }
        while !stopping && in_flight.len() < parallel_limit.load(Ordering::Acquire) {
            let Some((batch_index, chunk)) = pending.pop_front() else {
                break;
            };
            batch_attempt = batch_attempt.saturating_add(1);
            log::info!(
                target: "ai_run",
                "{}",
                serde_json::json!({
                    "event": "batch_started",
                    "runId": log_run_id,
                    "batchAttempt": batch_attempt,
                    "batchIndex": batch_index,
                    "batchTotal": batch_total,
                    "batchSize": chunk.len(),
                    "completed": suggestions.len(),
                })
            );
            update_ai_progress(&app, &progress_state, |progress| {
                progress.phase = "preparing";
                progress.batch_index = Some(batch_index);
                progress.batch_total = Some(batch_total);
                progress.batch_size = Some(chunk.len());
                progress.active_batches = Some(in_flight.len() + 1);
                progress.parallel_limit = Some(parallel_limit.load(Ordering::Acquire));
                progress.recovery = None;
                progress.provider_stage = None;
            });
            let chunk_review_skips = Arc::new(Mutex::new(ReviewSkips::default()));
            let progress = cloud_progress(batch_index, Arc::clone(&chunk_review_skips));
            let cancelled = Arc::clone(&pipeline_cancelled);
            let model = cloud_model.clone();
            let reasoning = reasoning.clone();
            let language = target_language.clone();
            let attempt = batch_attempt;
            in_flight.push(async move {
                let result = complete_cloud_batch(
                    model.as_deref(),
                    &reasoning,
                    &language,
                    cloud_quality_review,
                    chunk,
                    cancelled,
                    progress,
                )
                .await;
                (attempt, batch_index, chunk, result, chunk_review_skips)
            });
        }
        if in_flight.is_empty() {
            break;
        }
        let next = tokio::select! {
            next = in_flight.next() => next,
            _ = tokio::time::sleep(std::time::Duration::from_millis(100)) => continue,
        };
        let Some((batch_attempt, batch_index, chunk, result, chunk_review_skips)) = next else {
            break;
        };
        update_ai_progress(&app, &progress_state, |progress| {
            progress.batch_index = Some(batch_index);
            progress.active_batches = Some(in_flight.len());
        });
        match result {
            Ok((translations, cancel_after_staging)) => {
                if !staging_available {
                    continue;
                }
                match ai::suggestions(chunk, translations) {
                    Ok(completed) => {
                        update_ai_progress(&app, &progress_state, |progress| {
                            progress.phase = "saving";
                            progress.batch_size = Some(chunk.len());
                            progress.recovery = None;
                            progress.provider_stage = None;
                        });
                        let staged_result = stage_ai_suggestions(
                            &translation_root,
                            chunk,
                            completed,
                            &mut suggestions,
                        );
                        update_ai_progress(&app, &progress_state, |progress| {
                            progress.completed = suggestions.len();
                        });
                        if let Err(cause) = staged_result {
                            log::info!(
                                target: "ai_run",
                                "{}",
                                serde_json::json!({
                                    "event": "batch_finished",
                                    "runId": log_run_id,
                                    "batchAttempt": batch_attempt,
                                    "outcome": "savingError",
                                    "completed": suggestions.len(),
                                })
                            );
                            outcome = ai::AiRunOutcome::Error;
                            error = Some(cause);
                            stopping = true;
                            staging_available = false;
                            pipeline_cancelled.store(true, Ordering::Release);
                            continue;
                        }
                        if let Ok(skips) = chunk_review_skips.lock() {
                            saved_review_skips.absorb(*skips);
                        }
                        if cancel_after_staging {
                            log::info!(
                                target: "ai_run",
                                "{}",
                                serde_json::json!({
                                    "event": "batch_finished",
                                    "runId": log_run_id,
                                    "batchAttempt": batch_attempt,
                                    "outcome": "cancelled",
                                    "completed": suggestions.len(),
                                })
                            );
                            if outcome == ai::AiRunOutcome::Complete {
                                outcome = ai::AiRunOutcome::Cancelled;
                            }
                            stopping = true;
                            pipeline_cancelled.store(true, Ordering::Release);
                            continue;
                        }
                        log::info!(
                            target: "ai_run",
                            "{}",
                            serde_json::json!({
                                "event": "batch_finished",
                                "runId": log_run_id,
                                "batchAttempt": batch_attempt,
                                "outcome": "complete",
                                "completed": suggestions.len(),
                            })
                        );
                    }
                    Err(cause) => {
                        log::info!(
                            target: "ai_run",
                            "{}",
                            serde_json::json!({
                                "event": "batch_finished",
                                "runId": log_run_id,
                                "batchAttempt": batch_attempt,
                                "outcome": "invalidResponse",
                            })
                        );
                        outcome = ai::AiRunOutcome::Error;
                        error = Some(cause);
                        stopping = true;
                        pipeline_cancelled.store(true, Ordering::Release);
                    }
                }
            }
            Err(ai::ProviderFailure::Cancelled) => {
                log::info!(
                    target: "ai_run",
                    "{}",
                    serde_json::json!({
                        "event": "batch_finished",
                        "runId": log_run_id,
                        "batchAttempt": batch_attempt,
                        "outcome": "cancelled",
                        "completed": suggestions.len(),
                    })
                );
                if outcome == ai::AiRunOutcome::Complete {
                    outcome = ai::AiRunOutcome::Cancelled;
                }
                stopping = true;
                pipeline_cancelled.store(true, Ordering::Release);
            }
            Err(ai::ProviderFailure::InvalidResponse(_cause)) if chunk.len() > 1 => {
                let middle = ai::recovery_split_index(chunk)
                    .expect("a multi-item recovery chunk always has a split point");
                let (left, right) = chunk.split_at(middle);
                // Process the left half first while keeping the whole operation
                // iterative and bounded.
                if !stopping {
                    batch_total = batch_total.saturating_add(1);
                    pending.push_front((batch_total, right));
                    pending.push_front((batch_index, left));
                }
                update_ai_progress(&app, &progress_state, |progress| {
                    progress.phase = "preparing";
                    progress.batch_total = Some(batch_total);
                    progress.batch_size = Some(left.len());
                    progress.splits = progress.splits.saturating_add(1);
                    progress.recovery = Some("split");
                });
                log::info!(
                    target: "ai_run",
                    "{}",
                    serde_json::json!({
                        "event": "batch_finished",
                        "runId": log_run_id,
                        "batchAttempt": batch_attempt,
                        "outcome": "split",
                        "nextBatchSize": left.len(),
                        "batchTotal": batch_total,
                    })
                );
            }
            Err(ai::ProviderFailure::InvalidResponse(cause)) => {
                isolated_failures += 1;
                last_isolated_failure = Some(cause);
                log::info!(
                    target: "ai_run",
                    "{}",
                    serde_json::json!({
                        "event": "batch_finished",
                        "runId": log_run_id,
                        "batchAttempt": batch_attempt,
                        "outcome": "isolatedInvalidResponse",
                        "isolatedFailures": isolated_failures,
                    })
                );
            }
            Err(failure) => {
                let error_category = provider_failure_category(&failure);
                let cause = match failure {
                    ai::ProviderFailure::Message(cause) | ai::ProviderFailure::Transient(cause) => {
                        cause
                    }
                    ai::ProviderFailure::Cancelled | ai::ProviderFailure::InvalidResponse(_) => {
                        unreachable!("cancelled and invalid-response failures are handled above")
                    }
                };
                log::info!(
                    target: "ai_run",
                    "{}",
                    serde_json::json!({
                        "event": "batch_finished",
                        "runId": log_run_id,
                        "batchAttempt": batch_attempt,
                        "outcome": "error",
                        "errorCategory": error_category,
                    })
                );
                if outcome != ai::AiRunOutcome::Error {
                    error = Some(cause);
                }
                outcome = ai::AiRunOutcome::Error;
                stopping = true;
                pipeline_cancelled.store(true, Ordering::Release);
            }
        }
    }
    if outcome == ai::AiRunOutcome::Complete && isolated_failures > 0 {
        outcome = ai::AiRunOutcome::Error;
        let cause = last_isolated_failure
            .as_deref()
            .unwrap_or("The AI provider returned invalid structured translation data.");
        error = Some(format!(
            "{isolated_failures} selected string(s) could not be translated after bounded response recovery. {cause}"
        ));
    }
    update_ai_progress(&app, &progress_state, |progress| {
        progress.active_batches = Some(0);
    });
    let source_order = prepared
        .iter()
        .enumerate()
        .map(|(index, item)| (&item.identity, index))
        .collect::<std::collections::HashMap<_, _>>();
    suggestions.sort_by_key(|suggestion| {
        source_order
            .get(&suggestion.identity)
            .copied()
            .unwrap_or(usize::MAX)
    });
    outcome = lease.finish(outcome)?;
    if let Some(warning) = review_skipped_warning(outcome, saved_review_skips) {
        error = Some(match error {
            Some(error) => format!("{error} {warning}"),
            None => warning,
        });
    }
    let progress_snapshot = progress_state.lock().ok().map(|progress| progress.clone());
    let result = ai_run_result(
        &request,
        prepared.len(),
        (
            "chatgpt",
            cloud_model.unwrap_or_else(|| "ChatGPT default".to_string()),
            reasoning,
        ),
        suggestions,
        outcome,
        error,
    );
    log::info!(
        target: "ai_run",
        "{}",
        serde_json::json!({
            "event": "run_finished",
            "runId": log_run_id,
            "engine": log_engine,
            "transport": log_transport,
            "completed": result.completed,
            "total": result.requested,
            "outcome": result.outcome,
            "durationMs": u64::try_from(run_started_at.elapsed().as_millis()).unwrap_or(u64::MAX),
            "retries": progress_snapshot.as_ref().map_or(0, |progress| progress.retries),
            "splits": progress_snapshot.as_ref().map_or(0, |progress| progress.splits),
            "usage": progress_snapshot.as_ref().and_then(|progress| progress.usage.as_ref()),
            "errorCategory": result.error.as_ref().map(|_| "providerOrValidation"),
        })
    );
    remember_ai_run(&history, &result);
    Ok(result)
}

#[tauri::command]
fn cancel_ai_run(state: State<'_, ai::AiRuntimeState>, run_id: String) -> Result<bool, String> {
    let accepted = state.cancel_run(&run_id)?;
    log::info!(
        target: "ai_run",
        "{}",
        serde_json::json!({
            "event": "cancel_requested",
            "runId": safe_ai_run_id_for_log(&run_id),
            "accepted": accepted,
        })
    );
    Ok(accepted)
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
    log::error!(target: "app", "[frontend] {context}: {message}");
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
    let _export_guard = export_write_guard()?;
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
/// folder check before app construction still surfaces real problems to the user.
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
    // Tauri creates configured WebViews before calling setup. Own the profile
    // before constructing the app, its logging plugin, or any command handlers.
    let data_dir = match ensure_portable_data_dir() {
        Ok(directory) => directory,
        Err(error) => {
            portable_profile::show_startup_error(&error);
            return;
        }
    };
    let owner = match portable_profile::acquire(&data_dir) {
        Ok(owner) => owner,
        Err(error) => {
            portable_profile::show_startup_error(&error);
            return;
        }
    };
    tauri::Builder::default()
        .manage(owner)
        .manage(ai::AiRuntimeState::default())
        .manage(operation_history::OperationHistoryState::default())
        .plugin(log_plugin())
        .setup(move |app| {
            apply_diagnostic_logging(settings::load(&data_dir).diagnostic_logging);
            if let Err(error) = chatgpt_auth::initialize(data_dir) {
                chatgpt_auth::record_initialization_error(error);
            }
            log::info!(
                target: "app",
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
            save_string_groups_with_undo,
            list_operation_history,
            undo_batch_edit,
            export_mod,
            export_all_mods,
            preview_export,
            preview_translation_zip,
            pick_translation_zip_destination,
            build_translation_zip,
            preview_stardew_translator_output,
            build_stardew_translator_output,
            export_llm_batch,
            pick_llm_batch_destination,
            export_llm_batch_to_path,
            pick_llm_batch_file,
            preflight_llm_batch_path,
            import_llm_batch_path,
            build_glossary,
            glossary_status,
            load_glossary,
            llm_models,
            translate_with_local_ai,
            cloud_ai_status,
            cloud_ai_models,
            chatgpt_sign_in,
            chatgpt_sign_out,
            translate_with_cloud_ai,
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
mod output_history_tests {
    use super::*;

    #[test]
    fn combined_build_records_its_own_result_and_only_success_invalidates_undo() {
        let root = test_support::temp_dir("combined-output-history");
        let config = root.join("data");
        let mods = root.join("Mods");
        let component = mods.join("Example");
        std::fs::create_dir_all(component.join("i18n")).unwrap();
        std::fs::write(
            component.join("manifest.json"),
            r#"{"Name":"Example","UniqueID":"Fixture.Example"}"#,
        )
        .unwrap();
        std::fs::write(component.join("i18n/default.json"), r#"{"hello":"Hello"}"#).unwrap();
        settings::save(
            &config,
            &AppSettings {
                mods_path: Some(mods.display().to_string()),
                target_lang: Some("de".into()),
                ..Default::default()
            },
        )
        .unwrap();
        let history = operation_history::OperationHistoryState::default();
        let previous = release_zip::ZipBuildOutcome {
            path: root.join("previous.zip").display().to_string(),
            folder: root.display().to_string(),
            file_name: "previous.zip".into(),
            entries: 2,
            strings: 10,
        };
        remember_zip_operation(&history, &previous, "Translation ZIP created");
        let prior_entry = history.list().unwrap()[0].clone();
        let working = translations::language_root(&config, "de").unwrap();
        let batch = history
            .apply_reversible_batch_groups(
                &working,
                "Manual batch".into(),
                vec![(
                    "Fixture.Example".into(),
                    vec![(
                        translations::entry_key("i18n", "hello"),
                        translations::StoredString {
                            target: "Hallo".into(),
                            status: "translated".into(),
                            source_hash: translations::source_hash("Hello"),
                        },
                    )],
                )],
            )
            .unwrap();
        let destination = root.join("combined.zip");
        std::fs::write(&destination, "existing archive").unwrap();
        assert_eq!(
            build_output_with_history(&config, &history, &destination, false, &[]).unwrap_err(),
            "OVERWRITE_REQUIRED"
        );
        let after_failure = history.list().unwrap();
        assert_eq!(after_failure.len(), 2);
        assert_eq!(after_failure[0].id, batch.id);
        assert!(after_failure[0].can_undo);
        assert_eq!(std::fs::read(&destination).unwrap(), b"existing archive");

        let result = build_output_with_history(&config, &history, &destination, true, &[]).unwrap();
        let entries = history.list().unwrap();
        assert_eq!(entries.len(), 3);
        assert_ne!(entries[0].id, prior_entry.id);
        assert_eq!(entries[0].kind, operation_history::OperationKind::Zip);
        assert_eq!(entries[0].path.as_deref(), Some(result.path.as_str()));
        assert_eq!(entries[0].file_name.as_deref(), Some("combined.zip"));
        assert_eq!(entries[0].item_count, 1);
        assert_eq!(entries[2].id, prior_entry.id);
        assert_eq!(entries[2].path, prior_entry.path);
        assert!(!entries[1].can_undo);
        assert!(history.undo_reversible_batch(&working, &batch.id).is_err());
        std::fs::remove_dir_all(root).ok();
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
mod llm_batch_context_tests {
    use super::*;

    fn write(path: &Path, body: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    fn install_mod(mods: &Path, folder: &str, unique_id: &str, source: &str) -> PathBuf {
        let root = mods.join(folder);
        write(
            &root.join("manifest.json"),
            &format!(r#"{{ "Name": "{folder}", "UniqueID": "{unique_id}", "Version": "1.0.0" }}"#),
        );
        write(
            &root.join("i18n").join("default.json"),
            &format!(r#"{{ "hello": "{source}" }}"#),
        );
        root
    }

    #[test]
    fn llm_batch_context_ignores_webview_paths_and_refreshes_the_selected_component() {
        let root = test_support::temp_dir("llm-batch-context");
        let config = root.join("data");
        let mods = root.join("Mods");
        let selected = install_mod(&mods, "Selected", "Author.Selected", "Hello {{name}}");
        let other = install_mod(&mods, "Other", "Author.Other", "Wrong {{name}}");
        settings::save(
            &config,
            &settings::AppSettings {
                mods_path: Some(mods.to_string_lossy().to_string()),
                target_lang: Some("de".to_string()),
                ..settings::AppSettings::default()
            },
        )
        .unwrap();

        let items = [batch::BatchExportItem {
            relative_dir: "i18n".to_string(),
            key: "hello".to_string(),
            source: "Hello {{name}}".to_string(),
        }];
        let mut translated = batch::build_batch("Author.Selected", "de", &items);
        translated["files"]["i18n"]["hello"] =
            serde_json::Value::String("Hallo {{name}}".to_string());
        let batch_path = root.join("translated.json");
        write(
            &batch_path,
            &serde_json::to_string_pretty(&translated).unwrap(),
        );

        // These paths belong to another component. They intentionally mirror a
        // stale or substituted WebView selection and must never affect binding.
        let untrusted_files = [export::ExportFileInput {
            relative_dir: "i18n".to_string(),
            default_path: other
                .join("i18n")
                .join("default.json")
                .display()
                .to_string(),
            target_path: other.join("i18n").join("de.json").display().to_string(),
        }];

        let context = load_llm_batch_context_from_config(
            &config,
            "Author.Selected",
            &untrusted_files,
            &batch_path,
        )
        .unwrap();
        assert_eq!(context.rows_by_dir["i18n"][0].source, "Hello {{name}}");
        assert!(
            batch::preflight_batch(
                &context.parsed,
                "Author.Selected",
                &context.target_lang,
                &context.rows_by_dir,
            )
            .unwrap()
            .ready
        );

        write(
            &selected.join("i18n").join("default.json"),
            r#"{ "hello": "Changed {{name}}" }"#,
        );
        let refreshed = load_llm_batch_context_from_config(
            &config,
            "Author.Selected",
            &untrusted_files,
            &batch_path,
        )
        .unwrap();
        let report = batch::preflight_batch(
            &refreshed.parsed,
            "Author.Selected",
            &refreshed.target_lang,
            &refreshed.rows_by_dir,
        )
        .unwrap();
        assert_eq!(report.snapshot_result, batch::SnapshotResult::Mismatch);
        assert!(!report.ready);

        std::fs::remove_dir_all(root).ok();
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

    fn install_ai_fixture(mods: &Path, folder: &str, unique_id: &str, source: &str) {
        let component = mods.join(folder);
        let i18n = component.join("i18n");
        std::fs::create_dir_all(&i18n).unwrap();
        std::fs::write(
            component.join("manifest.json"),
            format!(r#"{{"Name":"{folder}","UniqueID":"{unique_id}"}}"#),
        )
        .unwrap();
        std::fs::write(i18n.join("default.json"), source).unwrap();
    }

    #[test]
    fn diagnostic_run_ids_allow_only_short_correlation_tokens() {
        assert_eq!(safe_ai_run_id_for_log("ai-123_test"), "ai-123_test");
        assert_eq!(safe_ai_run_id_for_log("source text"), "redacted");
        assert_eq!(safe_ai_run_id_for_log("line\nbreak"), "redacted");
    }

    #[test]
    fn local_ai_probe_diagnostics_are_categorized_without_provider_details() {
        let raw_error = "Could not reach http://localhost:11434/v1/models (private detail)";
        let diagnostic =
            local_ai_model_probe_diagnostic(local_ai_error_category(raw_error)).to_string();

        assert!(diagnostic.contains(r#""event":"model_probe_failed""#));
        assert!(diagnostic.contains(r#""errorCategory":"unreachable""#));
        assert!(!diagnostic.contains("localhost"));
        assert!(!diagnostic.contains("private detail"));
        assert_eq!(
            local_ai_error_category("The model timed out while waiting."),
            "timeout"
        );
        assert_eq!(
            local_ai_error_category("Server returned 503 for a local endpoint."),
            "httpStatus"
        );
        assert_eq!(
            local_ai_error_category("The server response is too large."),
            "responseTooLarge"
        );
    }

    #[test]
    fn ai_scope_rows_ignore_corrupt_state_from_unrequested_components() {
        let root = test_support::temp_dir("ai-scope-requested-components");
        let mods = root.join("Mods");
        let config = root.join("data");
        install_ai_fixture(&mods, "Good", "good.id", r#"{"one":"One","two":"Two"}"#);
        install_ai_fixture(&mods, "Bad", "bad.id", r#"{"bad":"Bad"}"#);
        let translation_root = translations::language_root(&config, "de").unwrap();
        let state_dir = translation_root.join("translations");
        std::fs::create_dir_all(&state_dir).unwrap();
        std::fs::write(state_dir.join("bad.id.json"), "not json").unwrap();

        let scan = scanner::scan_mods(&mods, "de", &config);
        assert_eq!(scan.mods.len(), 2);
        let rows = load_ai_scope_rows(
            scan,
            &translation_root,
            &HashSet::from(["good.id".to_string()]),
        )
        .unwrap();

        assert_eq!(rows.len(), 2);
        assert!(rows
            .iter()
            .all(|row| row.identity.mod_unique_id == "good.id"));
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn local_ai_stops_only_for_clearly_systemic_request_failures() {
        for category in ["unreachable", "httpStatus", "clientSetup", "configuration"] {
            assert!(local_ai_error_is_systemic(category), "{category}");
        }
        for category in ["invalidResponse", "responseTooLarge", "timeout", "provider"] {
            assert!(!local_ai_error_is_systemic(category), "{category}");
        }
    }

    #[test]
    fn local_ai_failure_summary_collects_ids_and_errors_without_unbounded_output() {
        let failures = vec![
            LocalAiItemFailure {
                identity: ai::AiStringIdentity {
                    mod_unique_id: "Example.Mod".to_string(),
                    relative_dir: "i18n".to_string(),
                    key: "dialogue.first".to_string(),
                },
                cause: "Permanent provider\nerror".to_string(),
            },
            LocalAiItemFailure {
                identity: ai::AiStringIdentity {
                    mod_unique_id: "Example.Mod".to_string(),
                    relative_dir: "assets/i18n".to_string(),
                    key: "dialogue.second".to_string(),
                },
                cause: "Invalid response".to_string(),
            },
        ];

        let summary = local_ai_failure_summary(&failures).unwrap();
        assert!(summary.contains("2 selected strings failed"));
        assert!(summary.contains("Any completed suggestions remain saved in Review"));
        assert!(!summary.contains("Completed suggestions remain saved in Review"));
        assert!(summary.contains("Example.Mod / i18n / dialogue.first"));
        assert!(summary.contains("Permanent provider error"));
        assert!(summary.contains("Example.Mod / assets/i18n / dialogue.second"));
        assert!(summary.contains("Invalid response"));

        let many_failures = (0..10)
            .map(|index| LocalAiItemFailure {
                identity: ai::AiStringIdentity {
                    mod_unique_id: "Example.Mod".to_string(),
                    relative_dir: "i18n".to_string(),
                    key: format!("key.{index}"),
                },
                cause: "failed".repeat(100),
            })
            .collect::<Vec<_>>();
        let bounded = local_ai_failure_summary(&many_failures).unwrap();
        assert!(bounded.contains("10 selected strings failed"));
        assert!(bounded.contains("2 additional failure(s) omitted"));
        assert!(bounded.len() < 4_000);
    }

    #[test]
    fn progress_contract_exposes_saved_count_phase_batch_recovery_and_usage() {
        let mut progress = AiRunProgress {
            run_id: "run-progress".to_string(),
            phase: "reviewing",
            completed: 320,
            translated: 407,
            translated_ids: HashSet::new(),
            total: 1_000,
            batch_index: Some(4),
            batch_total: Some(11),
            batch_size: Some(87),
            active_batches: Some(3),
            parallel_limit: Some(4),
            retries: 1,
            splits: 2,
            recovery: Some("structureRetry"),
            provider_stage: Some("reasoning"),
            provider_activity_sequence: 7,
            usage: Some(AiRunTokenUsage {
                input_tokens: 45_200,
                cached_input_tokens: 32_900,
                output_tokens: 2_100,
                reasoning_output_tokens: 900,
            }),
        };

        let value = serde_json::to_value(&progress).unwrap();
        assert_eq!(value["completed"], 320);
        assert_eq!(value["activeBatches"], 3);
        assert_eq!(value["parallelLimit"], 4);
        assert_eq!(value["translated"], 407);
        assert_eq!(value["phase"], "reviewing");
        assert_eq!(value["batchIndex"], 4);
        assert_eq!(value["recovery"], "structureRetry");
        assert_eq!(value["providerStage"], "reasoning");
        assert_eq!(value["providerActivitySequence"], 7);
        assert!(value.get("codexStage").is_none());
        assert!(value.get("codexActivitySequence").is_none());
        assert_eq!(value["usage"]["cachedInputTokens"], 32_900);
        assert!(value.get("translatedIds").is_none());
        progress.completed = 0;
        progress.translated = 0;
        progress.total = 282;
        let ids = |start, end| (start..end).map(|index| format!("item-{index:04}"));
        progress.record_translated(ids(0, 93));
        assert_eq!(progress.translated, 93);
        assert_eq!(progress.completed, 0);
        // Split recovery redrafts the same IDs; one failed item is not saved.
        progress.record_translated(ids(0, 46));
        progress.completed = 45;
        progress.record_translated(ids(46, 93));
        assert_eq!(progress.translated, 93);
        progress.completed = 92;
        // A new batch still counts every new draft despite the earlier gap.
        progress.record_translated(ids(93, 172));
        assert_eq!(progress.translated, 172);
        progress.record_translated(ids(0, 282));
        assert_eq!(progress.translated, 282);
    }

    #[test]
    fn partial_failed_run_is_completed_with_issues_and_keeps_saved_suggestions() {
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
            (
                "chatgpt",
                "ChatGPT default".to_string(),
                "medium".to_string(),
            ),
            vec![suggestion],
            ai::AiRunOutcome::Error,
            Some("provider stopped after one chunk".to_string()),
        );

        assert_eq!(result.requested, 3);
        assert_eq!(result.completed, 1);
        assert_eq!(result.outcome, ai::AiRunOutcome::Complete);
        assert_eq!(result.suggestions[0].identity, identity);
        assert_eq!(result.suggestions[0].status, "review-needed");
        assert!(result.error.is_some());
        assert_eq!(
            ai_operation_outcome(&result),
            operation_history::OperationOutcome::Warning
        );

        let failed = ai_run_result(
            &request,
            3,
            (
                "chatgpt",
                "ChatGPT default".to_string(),
                "medium".to_string(),
            ),
            Vec::new(),
            ai::AiRunOutcome::Error,
            Some("provider stopped before saving".to_string()),
        );
        assert_eq!(failed.completed, 0);
        assert_eq!(failed.outcome, ai::AiRunOutcome::Error);
        assert_eq!(
            ai_operation_outcome(&failed),
            operation_history::OperationOutcome::Failed
        );
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
            context: ai::AiPromptContext::isolated(0),
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

    #[test]
    fn cloud_parallel_limit_shrinks_after_repeated_retries_and_stays_bounded() {
        let limit = AtomicUsize::new(8);
        let retries = AtomicUsize::new(0);
        for expected in [8, 4, 4, 2, 2, 1, 1, 1] {
            reduce_parallel_limit(&limit, &retries);
            assert_eq!(limit.load(Ordering::Acquire), expected);
        }
    }

    #[test]
    fn dropping_cloud_pipeline_owner_signals_native_workers() {
        let cancelled = Arc::new(AtomicBool::new(false));
        let worker_flag = Arc::clone(&cancelled);
        {
            let _owner = CloudPipelineCancellation(cancelled);
            assert!(!worker_flag.load(Ordering::Acquire));
        }
        assert!(worker_flag.load(Ordering::Acquire));
    }

    #[test]
    fn out_of_order_batches_keep_saved_results_when_a_later_batch_is_stale() {
        let root = test_support::temp_dir("ai-out-of-order");
        let source = root.join("default.json");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(&source, r#"{"first":"One","second":"Two","third":"Three"}"#).unwrap();
        let state = root.join("state");
        let make_item = |key: &str, text: &str| ai::PreparedAiItem {
            id: key.into(),
            identity: ai::AiStringIdentity {
                mod_unique_id: "example.mod".into(),
                relative_dir: "i18n".into(),
                key: key.into(),
            },
            source: text.into(),
            section: None,
            glossary_pairs: Vec::new(),
            context: ai::AiPromptContext::isolated(0),
            default_path: source.clone(),
            target_path: root.join("de.json"),
            expected_stored: None,
            expected_revision: 0,
        };
        let first = make_item("first", "One");
        let second = make_item("second", "Two");
        let third = make_item("third", "Three");
        let suggestion = |item: &ai::PreparedAiItem, text: &str| ai::AiSuggestion {
            identity: item.identity.clone(),
            text: text.into(),
            status: "review-needed".into(),
            token_differences: Vec::new(),
            glossary_misses: Vec::new(),
        };
        let mut saved = Vec::new();
        stage_ai_suggestions(
            &state,
            std::slice::from_ref(&second),
            vec![suggestion(&second, "Zwei")],
            &mut saved,
        )
        .unwrap();
        stage_ai_suggestions(
            &state,
            std::slice::from_ref(&first),
            vec![suggestion(&first, "Eins")],
            &mut saved,
        )
        .unwrap();
        let third_key = translations::entry_key("i18n", "third");
        translations::save_one(
            &state,
            "example.mod",
            third_key.clone(),
            translations::StoredString {
                target: "Manual".into(),
                status: "translated".into(),
                source_hash: translations::source_hash("Three"),
            },
        )
        .unwrap();
        assert!(stage_ai_suggestions(
            &state,
            std::slice::from_ref(&third),
            vec![suggestion(&third, "Drei")],
            &mut saved
        )
        .is_err());
        let restarted = translations::load(&state, "example.mod").unwrap();
        assert_eq!(
            restarted[&translations::entry_key("i18n", "first")].target,
            "Eins"
        );
        assert_eq!(
            restarted[&translations::entry_key("i18n", "second")].target,
            "Zwei"
        );
        assert_eq!(restarted[&third_key].target, "Manual");
        assert_eq!(saved.len(), 2);
        assert!(!root.join("de.json").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn completed_ai_chunk_saves_nothing_when_a_later_string_is_stale() {
        let root = test_support::temp_dir("ai-stage-atomic-chunk");
        let i18n = root.join("fixture").join("i18n");
        std::fs::create_dir_all(&i18n).unwrap();
        let default_path = i18n.join("default.json");
        let target_path = i18n.join("de.json");
        std::fs::write(&default_path, r#"{"first":"One","second":"Two"}"#).unwrap();
        let translation_root = root.join("state");
        let make_item = |key: &str, source: &str| ai::PreparedAiItem {
            id: format!("item-{key}"),
            identity: ai::AiStringIdentity {
                mod_unique_id: "example.mod".to_string(),
                relative_dir: "i18n".to_string(),
                key: key.to_string(),
            },
            source: source.to_string(),
            section: None,
            glossary_pairs: Vec::new(),
            context: ai::AiPromptContext::isolated(0),
            default_path: default_path.clone(),
            target_path: target_path.clone(),
            expected_stored: None,
            expected_revision: 0,
        };
        let items = vec![make_item("first", "One"), make_item("second", "Two")];
        translations::save_one(
            &translation_root,
            "example.mod",
            translations::entry_key("i18n", "second"),
            translations::StoredString {
                target: "Manual".to_string(),
                status: "translated".to_string(),
                source_hash: translations::source_hash("Two"),
            },
        )
        .unwrap();
        let generated = items
            .iter()
            .map(|item| ai::AiSuggestion {
                identity: item.identity.clone(),
                text: format!("AI {}", item.source),
                status: "review-needed".to_string(),
                token_differences: Vec::new(),
                glossary_misses: Vec::new(),
            })
            .collect();

        assert!(
            stage_ai_suggestions(&translation_root, &items, generated, &mut Vec::new(),).is_err()
        );
        let state = translations::load(&translation_root, "example.mod").unwrap();
        assert!(!state.contains_key(&translations::entry_key("i18n", "first")));
        assert_eq!(
            state[&translations::entry_key("i18n", "second")].target,
            "Manual"
        );
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn ai_staging_refreshes_source_files_between_chunks() {
        let root = test_support::temp_dir("ai-stage-fresh-chunks");
        let i18n = root.join("i18n");
        std::fs::create_dir_all(&i18n).unwrap();
        let default_path = i18n.join("default.json");
        std::fs::write(&default_path, r#"{"first":"One","second":"Two"}"#).unwrap();
        let state_root = root.join("state");
        let item = |key: &str, source: &str| ai::PreparedAiItem {
            id: key.into(),
            identity: ai::AiStringIdentity {
                mod_unique_id: "Fixture.FreshChunks".into(),
                relative_dir: "i18n".into(),
                key: key.into(),
            },
            source: source.into(),
            section: None,
            glossary_pairs: Vec::new(),
            context: ai::AiPromptContext::isolated(0),
            default_path: default_path.clone(),
            target_path: i18n.join("de.json"),
            expected_stored: None,
            expected_revision: 0,
        };
        let generated = |item: &ai::PreparedAiItem| ai::AiSuggestion {
            identity: item.identity.clone(),
            text: format!("AI {}", item.source),
            status: "review-needed".into(),
            token_differences: Vec::new(),
            glossary_misses: Vec::new(),
        };
        let first = item("first", "One");
        let second = item("second", "Two");
        let mut staged = Vec::new();
        stage_ai_suggestions(
            &state_root,
            std::slice::from_ref(&first),
            vec![generated(&first)],
            &mut staged,
        )
        .unwrap();
        std::fs::write(&default_path, r#"{"first":"One","second":"Updated"}"#).unwrap();
        assert!(stage_ai_suggestions(
            &state_root,
            std::slice::from_ref(&second),
            vec![generated(&second)],
            &mut staged
        )
        .is_err());
        assert_eq!(staged.len(), 1);
        let state = translations::load(&state_root, "Fixture.FreshChunks").unwrap();
        assert_eq!(
            state[&translations::entry_key("i18n", "first")].target,
            "AI One"
        );
        assert!(!state.contains_key(&translations::entry_key("i18n", "second")));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ai_staging_keeps_identical_keys_in_different_files_and_components_separate() {
        let root = test_support::temp_dir("ai-stage-multiple-files");
        let mut items = Vec::new();
        for component in ["Fixture.First", "Fixture.Second"] {
            for unit in ["i18n", "extra/i18n"] {
                let directory = root.join(component).join(unit);
                std::fs::create_dir_all(&directory).unwrap();
                let source = format!("{component} {unit}");
                let default_path = directory.join("default.json");
                std::fs::write(
                    &default_path,
                    serde_json::json!({"same":source}).to_string(),
                )
                .unwrap();
                items.push(ai::PreparedAiItem {
                    id: format!("{}", items.len()),
                    identity: ai::AiStringIdentity {
                        mod_unique_id: component.into(),
                        relative_dir: unit.into(),
                        key: "same".into(),
                    },
                    source,
                    section: None,
                    glossary_pairs: Vec::new(),
                    context: ai::AiPromptContext::isolated(0),
                    default_path,
                    target_path: directory.join("de.json"),
                    expected_stored: None,
                    expected_revision: 0,
                });
            }
        }
        let generated = items
            .iter()
            .map(|item| ai::AiSuggestion {
                identity: item.identity.clone(),
                text: format!("AI {}", item.source),
                status: "review-needed".into(),
                token_differences: Vec::new(),
                glossary_misses: Vec::new(),
            })
            .collect();
        let state_root = root.join("state");
        let mut staged = Vec::new();
        stage_ai_suggestions(&state_root, &items, generated, &mut staged).unwrap();
        assert_eq!(staged.len(), 4);
        for item in items {
            let state = translations::load(&state_root, &item.identity.mod_unique_id).unwrap();
            let entry =
                &state[&translations::entry_key(&item.identity.relative_dir, &item.identity.key)];
            assert_eq!(entry.target, format!("AI {}", item.source));
            assert_eq!(entry.status, "review-needed");
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}
