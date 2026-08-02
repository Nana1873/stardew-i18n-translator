//! Export — M3 (SPEC §17, milestone m3-export).
//!
//! Writes a mod's saved translations to its `i18n/<lang>.json`, preserving the
//! key order of `default.json` (diff-friendly; never alphabetized), UTF-8
//! without BOM, 2-space indent. Safety rules:
//!  - Existing target files are copied to `<file>.json.bak` before overwrite.
//!  - The new content is written to a `.tmp` sibling, re-parsed to verify it is
//!    valid JSON, then renamed over the target (atomic on the same volume).
//!  - **Untranslated** keys are omitted (SMAPI falls back to `default.json`).
//!    Kept-original strings (v1.5, SPEC §9) carry the source as their target
//!    and are written like any other translation.
//!  - Any protected-token count mismatch blocks the complete mod export before
//!    backups or target writes begin.
//!
//! Saved translation state on disk is the source of truth: every edit is
//! persisted immediately via `save_string`, so export reads it back here.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::scanner;
use crate::tokens;
use crate::translations;

/// One i18n file to export (mirrors the frontend's `ScannedI18nFile`).
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExportFileInput {
    pub relative_dir: String,
    pub default_path: String,
    pub target_path: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkippedKey {
    pub relative_dir: String,
    pub key: String,
    pub reason: String,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExportFileResult {
    pub relative_dir: String,
    pub target_path: String,
    /// The target file was (re)written.
    pub written: bool,
    /// Every translation was cleared, so the now-stale target file was removed
    /// (after a backup) — SMAPI falls back to `default.json`.
    pub removed: bool,
    /// An existing target file was backed up to `<file>.bak`.
    pub backed_up: bool,
    pub written_keys: usize,
    /// Omitted because they have no translation (fall back to `default.json`).
    pub untranslated: usize,
    /// Exported, but stale (source changed since translating) — review advised.
    pub outdated: usize,
    /// Exported, but an unreviewed AI suggestion (M6) — review advised.
    pub review_needed: usize,
    /// Keys present in the **existing** target file but absent from
    /// `default.json` (SMAPI ignores them). They are dropped from the rewritten
    /// file — reported here so a community translation is never pruned
    /// silently. The pre-export content survives in `<file>.bak`.
    pub orphan_keys: Vec<String>,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub files: Vec<ExportFileResult>,
    pub skipped: Vec<SkippedKey>,
    pub files_written: usize,
    /// Target files removed because every translation was cleared.
    pub files_removed: usize,
    pub total_written_keys: usize,
    pub total_untranslated: usize,
    pub total_outdated: usize,
    pub total_review_needed: usize,
    /// Total keys dropped from existing target files because `default.json`
    /// no longer (or never) contains them.
    pub total_orphan_keys: usize,
    /// Token errors prevented every file in this mod from being written.
    pub blocked: bool,
}

struct PreparedFile {
    result: ExportFileResult,
    target_path: PathBuf,
    body: Option<String>,
    removals: Vec<PathBuf>,
}

/// Export every i18n file of one mod. Returns a per-file + aggregate summary.
pub fn export_mod(
    config_dir: &Path,
    unique_id: &str,
    files: &[ExportFileInput],
) -> Result<ExportResult, String> {
    // A corrupted state file aborts the export — exporting with a silently
    // empty state would write a near-empty <lang>.json over a good one.
    let state = translations::load(config_dir, unique_id)?;
    let mut result = ExportResult::default();

    let mut prepared_rows = Vec::new();
    // Validate the complete mod first. A token mismatch must not leave a
    // partially exported mod or create backups for files that were not replaced.
    for file in files {
        let rows = scanner::load_strings_checked(
            Path::new(&file.default_path),
            Path::new(&file.target_path),
            &state,
            &file.relative_dir,
        )?;
        for row in &rows {
            if row.target.trim().is_empty() {
                continue;
            }
            let differences = tokens::token_differences(&row.source, &row.target);
            if differences.is_empty() || row.token_mismatch_accepted {
                continue;
            }
            let detail = differences
                .iter()
                .map(|difference| {
                    format!(
                        "{}: expected {}, found {}",
                        difference.token, difference.source_count, difference.target_count
                    )
                })
                .collect::<Vec<_>>()
                .join("; ");
            result.skipped.push(SkippedKey {
                relative_dir: file.relative_dir.clone(),
                key: row.key.clone(),
                reason: format!("token count mismatch ({detail})"),
            });
        }
        prepared_rows.push((file, rows));
    }
    if !result.skipped.is_empty() {
        result.blocked = true;
        return Ok(result);
    }

    let mut prepared = Vec::new();
    for (file, rows) in prepared_rows {
        let default_path = Path::new(&file.default_path);
        let target_path = Path::new(&file.target_path);
        validate_portuguese_variants(target_path)?;

        let mut out: Map<String, Value> = Map::new();
        let mut file_result = ExportFileResult {
            relative_dir: file.relative_dir.clone(),
            target_path: file.target_path.clone(),
            orphan_keys: orphan_keys_checked(default_path, target_path)?,
            ..Default::default()
        };

        for row in rows {
            if row.target.trim().is_empty() {
                file_result.untranslated += 1;
                continue;
            }
            if row.status == "outdated" {
                file_result.outdated += 1;
            }
            if row.status == "review-needed" {
                file_result.review_needed += 1;
            }
            out.insert(row.key, Value::String(row.target));
        }

        file_result.written_keys = out.len();
        let body = (!out.is_empty())
            .then(|| serialize_target(&out))
            .transpose()?;
        let removals = target_variants(target_path)
            .into_iter()
            .filter(|path| path.is_file())
            .collect();
        prepared.push(PreparedFile {
            result: file_result,
            target_path: target_path.to_path_buf(),
            body,
            removals,
        });
    }

    for mut file in prepared {
        if let Some(body) = file.body.as_deref() {
            file.result.backed_up = write_target(&file.target_path, body)
                .map_err(|error| export_io_error(&error, &result.files, &file.target_path))?;
            for obsolete in file
                .removals
                .iter()
                .filter(|path| path.as_path() != file.target_path)
            {
                file.result.backed_up |= remove_target(obsolete)
                    .map_err(|error| export_io_error(&error, &result.files, &file.target_path))?;
            }
            file.result.written = true;
            result.files_written += 1;
        } else {
            for existing in &file.removals {
                file.result.backed_up |= remove_target(existing)
                    .map_err(|error| export_io_error(&error, &result.files, &file.target_path))?;
            }
            if !file.removals.is_empty() {
                // Every translation was cleared. Leaving the old <lang>.json on disk
                // keeps those stale strings live in SMAPI, so remove it (after a
                // backup) — the mod then cleanly falls back to default.json.
                // Portuguese may have been imported from pt-BR.json while the
                // canonical export path is pt.json, so remove the file that was
                // actually read rather than checking only the canonical path.
                file.result.removed = true;
                result.files_removed += 1;
            }
        }

        result.total_written_keys += file.result.written_keys;
        result.total_untranslated += file.result.untranslated;
        result.total_outdated += file.result.outdated;
        result.total_review_needed += file.result.review_needed;
        result.total_orphan_keys += file.result.orphan_keys.len();
        result.files.push(file.result);
    }

    Ok(result)
}

/// Keys in the existing target file that `default.json` does not contain
/// (matched with SMAPI key semantics: case-insensitive, trimmed). These get
/// dropped by the rewrite, so the summary must surface them.
fn orphan_keys_checked(default_path: &Path, target_path: &Path) -> Result<Vec<String>, String> {
    let target = scanner::read_target_object_checked(target_path)?;
    let source = scanner::read_object_checked(default_path)?;
    let source_folded: std::collections::HashSet<String> =
        source.keys().map(|key| scanner::folded_key(key)).collect();
    Ok(target
        .keys()
        .filter(|key| key.as_str() != "$schema")
        .filter(|key| !source_folded.contains(&scanner::folded_key(key)))
        .cloned()
        .collect())
}

/// Serialize `map` and write it to `target_path` safely: back up an existing
/// file, write+verify a temp sibling, then rename over the target. Returns
/// whether a backup was created.
fn serialize_target(map: &Map<String, Value>) -> Result<String, String> {
    let mut body = serde_json::to_string_pretty(map)
        .map_err(|error| format!("Could not serialize export JSON: {error}"))?;
    body.push('\n');
    // Defensive: re-parse what we are about to write.
    serde_json::from_str::<Value>(&body)
        .map_err(|error| format!("Generated invalid JSON: {error}"))?;

    Ok(body)
}

fn write_target(target_path: &Path, body: &str) -> Result<bool, String> {
    if let Some(parent) = target_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create target dir: {error}"))?;
    }

    let backed_up = target_path.is_file();
    if backed_up {
        let backup = sibling(target_path, ".bak");
        std::fs::copy(target_path, &backup)
            .map_err(|error| format!("Could not back up {}: {error}", target_path.display()))?;
    }

    let temp = sibling(target_path, ".tmp");
    std::fs::write(&temp, body.as_bytes())
        .map_err(|error| format!("Could not write temp file: {error}"))?;
    std::fs::rename(&temp, target_path)
        .map_err(|error| format!("Could not finalize {}: {error}", target_path.display()))?;

    Ok(backed_up)
}

fn is_portuguese_target(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("pt.json"))
}

fn target_variants(target_path: &Path) -> Vec<PathBuf> {
    if is_portuguese_target(target_path) {
        vec![
            target_path.to_path_buf(),
            target_path.with_file_name("pt-BR.json"),
        ]
    } else {
        vec![target_path.to_path_buf()]
    }
}

fn validate_portuguese_variants(target_path: &Path) -> Result<(), String> {
    if is_portuguese_target(target_path) {
        for path in target_variants(target_path)
            .into_iter()
            .filter(|path| path.is_file())
        {
            scanner::read_object_checked(&path)?;
        }
    }
    Ok(())
}

fn export_io_error(error: &str, completed: &[ExportFileResult], current: &Path) -> String {
    let changed = completed
        .iter()
        .filter(|file| file.written || file.removed)
        .map(|file| file.target_path.clone())
        .collect::<Vec<_>>();
    let backups = changed
        .iter()
        .cloned()
        .chain(std::iter::once(current.display().to_string()))
        .flat_map(|path| target_variants(Path::new(&path)))
        .map(|path| sibling(&path, ".bak"))
        .filter(|path| path.exists())
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>();
    format!(
        "{error} Completed changes before the failure: {}. Failed while processing: {}. Backups present: {}.",
        if changed.is_empty() {
            "none".to_string()
        } else {
            changed.join(", ")
        },
        current.display(),
        if backups.is_empty() {
            "none".to_string()
        } else {
            backups.join(", ")
        }
    )
}

/// Remove a target file whose translations were all cleared, backing it up to
/// `<file>.bak` first so the old content is recoverable. SMAPI then falls back
/// to `default.json`. Returns whether a backup was created (always true — the
/// caller only invokes this for an existing file).
fn remove_target(target_path: &Path) -> Result<bool, String> {
    let backup = sibling(target_path, ".bak");
    std::fs::copy(target_path, &backup)
        .map_err(|error| format!("Could not back up {}: {error}", target_path.display()))?;
    std::fs::remove_file(target_path)
        .map_err(|error| format!("Could not remove {}: {error}", target_path.display()))?;
    Ok(true)
}

/// A sibling path with `suffix` appended to the full file name, so
/// `i18n/de.json` + `.bak` -> `i18n/de.json.bak` (not `i18n/de.bak`).
fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(suffix);
    path.with_file_name(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, body: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    #[test]
    fn removes_target_file_when_every_translation_is_cleared() {
        // An existing <lang>.json whose only key has been cleared must be
        // removed (after a backup), not left on disk with stale content —
        // otherwise SMAPI keeps loading the old translation.
        let root = crate::test_support::temp_dir("export-clear-all");
        let i18n = root.join("i18n");
        write(&i18n.join("default.json"), "{ \"k\": \"Hello\" }");
        write(&i18n.join("de.json"), "{ \"k\": \"Hallo\" }");

        crate::translations::save_one(
            &root,
            "mod.id",
            crate::translations::entry_key("i18n", "k"),
            crate::translations::StoredString {
                target: String::new(),
                status: "untranslated".into(),
                source_hash: crate::translations::source_hash("Hello"),
            },
        )
        .unwrap();

        let files = vec![ExportFileInput {
            relative_dir: "i18n".into(),
            default_path: i18n.join("default.json").display().to_string(),
            target_path: i18n.join("de.json").display().to_string(),
        }];
        let result = export_mod(&root, "mod.id", &files).unwrap();

        assert!(
            !i18n.join("de.json").is_file(),
            "the cleared target file must be removed"
        );
        assert!(
            i18n.join("de.json.bak").is_file(),
            "removal keeps the old content in a .bak"
        );
        assert_eq!(result.files_removed, 1);
        assert_eq!(result.files_written, 0);
        assert!(result.files[0].removed);
        assert!(!result.files[0].written);
        assert!(result.files[0].backed_up);
        assert_eq!(result.files[0].written_keys, 0);

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn empty_export_with_no_existing_target_removes_nothing() {
        // No translations and no existing file: nothing to write or remove.
        let root = crate::test_support::temp_dir("export-empty-noop");
        let i18n = root.join("i18n");
        write(&i18n.join("default.json"), "{ \"k\": \"Hello\" }");

        let files = vec![ExportFileInput {
            relative_dir: "i18n".into(),
            default_path: i18n.join("default.json").display().to_string(),
            target_path: i18n.join("de.json").display().to_string(),
        }];
        let result = export_mod(&root, "mod.id", &files).unwrap();

        assert_eq!(result.files_removed, 0);
        assert_eq!(result.files_written, 0);
        assert!(!result.files[0].removed);
        assert!(!i18n.join("de.json.bak").exists());

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn clearing_portuguese_import_removes_pt_br_fallback() {
        let root = crate::test_support::temp_dir("export-clear-portuguese");
        let i18n = root.join("i18n");
        write(&i18n.join("default.json"), "{ \"k\": \"Hello\" }");
        write(&i18n.join("pt-BR.json"), "{ \"k\": \"Olá\" }");

        crate::translations::save_one(
            &root,
            "mod.id",
            crate::translations::entry_key("i18n", "k"),
            crate::translations::StoredString {
                target: String::new(),
                status: "untranslated".into(),
                source_hash: crate::translations::source_hash("Hello"),
            },
        )
        .unwrap();

        let files = vec![ExportFileInput {
            relative_dir: "i18n".into(),
            default_path: i18n.join("default.json").display().to_string(),
            target_path: i18n.join("pt.json").display().to_string(),
        }];
        let result = export_mod(&root, "mod.id", &files).unwrap();

        assert!(!i18n.join("pt-BR.json").is_file());
        assert!(i18n.join("pt-BR.json.bak").is_file());
        assert!(!i18n.join("pt.json").exists());
        assert_eq!(result.files_removed, 1);
        assert!(result.files[0].removed);

        std::fs::remove_dir_all(&root).ok();
    }

    fn read(path: &Path) -> String {
        std::fs::read_to_string(path).unwrap()
    }

    fn input(i18n: &Path) -> Vec<ExportFileInput> {
        vec![ExportFileInput {
            relative_dir: "i18n".to_string(),
            default_path: i18n.join("default.json").display().to_string(),
            target_path: i18n.join("de.json").display().to_string(),
        }]
    }

    #[test]
    fn writes_in_default_key_order_and_omits_untranslated() {
        let root = crate::test_support::temp_dir("export-order");
        let i18n = root.join("i18n");
        // Non-alphabetical on purpose; only some keys are translated.
        write(
            &i18n.join("default.json"),
            "{ \"zeta\": \"Z\", \"alpha\": \"A\", \"mid\": \"M\" }",
        );
        translations::save_one(
            &root,
            "mod.id",
            translations::entry_key("i18n", "zeta"),
            translations::StoredString {
                target: "Zett".into(),
                status: "translated".into(),
                source_hash: translations::source_hash("Z"),
            },
        )
        .unwrap();
        translations::save_one(
            &root,
            "mod.id",
            translations::entry_key("i18n", "alpha"),
            translations::StoredString {
                target: "Alfa".into(),
                status: "translated".into(),
                source_hash: translations::source_hash("A"),
            },
        )
        .unwrap();
        // `mid` left untranslated -> omitted.

        let result = export_mod(&root, "mod.id", &input(&i18n)).unwrap();
        assert_eq!(result.files_written, 1);
        assert_eq!(result.total_written_keys, 2);
        assert_eq!(result.total_untranslated, 1);

        let body = read(&i18n.join("de.json"));
        // Default order preserved (zeta before alpha), `mid` absent.
        let zeta = body.find("zeta").unwrap();
        let alpha = body.find("alpha").unwrap();
        assert!(zeta < alpha, "key order should follow default.json");
        assert!(!body.contains("mid"));
        assert!(body.contains("\"Zett\""));
        assert!(
            body.ends_with("}\n"),
            "2-space pretty JSON + trailing newline"
        );
        assert!(body.contains("\n  \"zeta\""), "2-space indent");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn backs_up_existing_target_before_overwrite() {
        let root = crate::test_support::temp_dir("export-backup");
        let i18n = root.join("i18n");
        write(&i18n.join("default.json"), "{ \"k\": \"Hello\" }");
        write(&i18n.join("de.json"), "{ \"k\": \"OldValue\" }");
        translations::save_one(
            &root,
            "mod.id",
            translations::entry_key("i18n", "k"),
            translations::StoredString {
                target: "Hallo".into(),
                status: "translated".into(),
                source_hash: translations::source_hash("Hello"),
            },
        )
        .unwrap();

        let result = export_mod(&root, "mod.id", &input(&i18n)).unwrap();
        assert!(result.files[0].backed_up);
        assert_eq!(read(&i18n.join("de.json.bak")), "{ \"k\": \"OldValue\" }");
        assert!(read(&i18n.join("de.json")).contains("\"Hallo\""));
        // No temp file is left behind.
        assert!(!i18n.join("de.json.tmp").exists());

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn blocks_the_complete_mod_before_writing_on_any_token_mismatch() {
        let root = crate::test_support::temp_dir("export-skip");
        let i18n = root.join("i18n");
        write(
            &i18n.join("default.json"),
            "{ \"ok\": \"Hi {{name}}\", \"bad\": \"Bye {{name}}\" }",
        );
        write(&i18n.join("de.json"), "{ \"old\": \"untouched\" }");
        // `ok` keeps the token; `bad` drops it -> complete mod is blocked.
        translations::save_one(
            &root,
            "mod.id",
            translations::entry_key("i18n", "ok"),
            translations::StoredString {
                target: "Hallo {{name}}".into(),
                status: "translated".into(),
                source_hash: translations::source_hash("Hi {{name}}"),
            },
        )
        .unwrap();
        translations::save_one(
            &root,
            "mod.id",
            translations::entry_key("i18n", "bad"),
            translations::StoredString {
                target: "Tschüss".into(),
                status: "translated".into(),
                source_hash: translations::source_hash("Bye {{name}}"),
            },
        )
        .unwrap();

        let result = export_mod(&root, "mod.id", &input(&i18n)).unwrap();
        assert!(result.blocked);
        assert_eq!(result.total_written_keys, 0);
        assert_eq!(result.skipped.len(), 1);
        assert_eq!(result.skipped[0].key, "bad");
        assert!(result.skipped[0].reason.contains("expected 1, found 0"));
        let body = read(&i18n.join("de.json"));
        assert_eq!(body, "{ \"old\": \"untouched\" }");
        assert!(!i18n.join("de.json.bak").exists());

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn added_token_also_blocks_the_complete_mod() {
        let root = crate::test_support::temp_dir("export-added-token");
        let i18n = root.join("i18n");
        write(&i18n.join("default.json"), "{ \"bad\": \"Hello #\" }");
        translations::save_one(
            &root,
            "mod.id",
            translations::entry_key("i18n", "bad"),
            translations::StoredString {
                target: "Hallo ##".into(),
                status: "translated".into(),
                source_hash: translations::source_hash("Hello #"),
            },
        )
        .unwrap();

        let result = export_mod(&root, "mod.id", &input(&i18n)).unwrap();
        assert!(result.blocked);
        assert_eq!(result.skipped.len(), 1);
        assert!(result.skipped[0].reason.contains("expected 1, found 2"));
        assert!(!i18n.join("de.json").exists());
        assert!(!i18n.join("de.json.bak").exists());

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn exports_multiple_token_mismatches_after_each_string_is_accepted() {
        let root = crate::test_support::temp_dir("export-accepted-tokens");
        let i18n = root.join("i18n");
        write(
            &i18n.join("default.json"),
            r#"{"a":"First$8","b":"Second$9"}"#,
        );
        for (key, source, target) in [
            ("a", "First$8", "Erste Zeile$7"),
            ("b", "Second$9", "Zweite Zeile$6"),
        ] {
            translations::save_one(
                &root,
                "mod.id",
                translations::entry_key("i18n", key),
                translations::StoredString {
                    target: target.into(),
                    status: translations::TOKEN_MISMATCH_ACCEPTED_STATUS.into(),
                    source_hash: translations::source_hash(source),
                },
            )
            .unwrap();
        }

        let result = export_mod(&root, "mod.id", &input(&i18n)).unwrap();
        assert!(!result.blocked);
        assert!(result.skipped.is_empty());
        assert_eq!(result.total_written_keys, 2);
        let body = read(&i18n.join("de.json"));
        assert!(body.contains("Erste Zeile$7"));
        assert!(body.contains("Zweite Zeile$6"));

        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn quote_delimiter_difference_does_not_block_export() {
        // The source uses backticks (no `'`); the translation adds a paired
        // `'…'`. Quotes are punctuation, not runtime syntax, so the export must
        // proceed instead of blocking the whole mod (SPEC §10).
        let root = crate::test_support::temp_dir("export-quote-soft");
        let i18n = root.join("i18n");
        write(
            &i18n.join("default.json"),
            "{ \"k\": \"Use `Default` here\" }",
        );
        translations::save_one(
            &root,
            "mod.id",
            translations::entry_key("i18n", "k"),
            translations::StoredString {
                target: "'Standard' hier verwenden".into(),
                status: "translated".into(),
                source_hash: translations::source_hash("Use `Default` here"),
            },
        )
        .unwrap();

        let result = export_mod(&root, "mod.id", &input(&i18n)).unwrap();
        assert!(!result.blocked, "a quote-only difference must not block");
        assert_eq!(result.total_written_keys, 1);
        assert!(read(&i18n.join("de.json")).contains("'Standard'"));

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn untranslated_strings_do_not_block_export() {
        let root = crate::test_support::temp_dir("export-untranslated-token");
        let i18n = root.join("i18n");
        write(
            &i18n.join("default.json"),
            "{ \"translated\": \"Hello #\", \"empty\": \"Bye {{name}}\" }",
        );
        translations::save_one(
            &root,
            "mod.id",
            translations::entry_key("i18n", "translated"),
            translations::StoredString {
                target: "Hallo #".into(),
                status: "translated".into(),
                source_hash: translations::source_hash("Hello #"),
            },
        )
        .unwrap();

        let result = export_mod(&root, "mod.id", &input(&i18n)).unwrap();
        assert!(!result.blocked);
        assert_eq!(result.total_written_keys, 1);
        assert_eq!(result.total_untranslated, 1);

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn exports_review_needed_strings_but_counts_them() {
        let root = crate::test_support::temp_dir("export-review");
        let i18n = root.join("i18n");
        write(&i18n.join("default.json"), "{ \"k\": \"Hello\" }");
        // An AI suggestion (review-needed) has content -> exported, but flagged.
        translations::save_one(
            &root,
            "mod.id",
            translations::entry_key("i18n", "k"),
            translations::StoredString {
                target: "Hallo".into(),
                status: "review-needed".into(),
                source_hash: translations::source_hash("Hello"),
            },
        )
        .unwrap();

        let result = export_mod(&root, "mod.id", &input(&i18n)).unwrap();
        assert_eq!(result.total_written_keys, 1);
        assert_eq!(result.total_review_needed, 1);
        assert!(read(&i18n.join("de.json")).contains("\"Hallo\""));

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn reports_orphan_keys_dropped_from_an_existing_target() {
        let root = crate::test_support::temp_dir("export-orphans");
        let i18n = root.join("i18n");
        write(&i18n.join("default.json"), "{ \"kept\": \"Hello\" }");
        // The existing community translation has an extra key the mod no
        // longer ships ("legacy") and a case-variant of a real key (not an
        // orphan, per SMAPI's case-insensitive keys).
        write(
            &i18n.join("de.json"),
            "{ \"KEPT\": \"Hallo\", \"legacy\": \"Alt\" }",
        );

        let result = export_mod(&root, "mod.id", &input(&i18n)).unwrap();
        assert_eq!(result.files[0].orphan_keys, vec!["legacy".to_string()]);
        assert_eq!(result.total_orphan_keys, 1);

        // The rewritten file keeps the canonical key, drops the orphan; the
        // pre-export content survives in the .bak.
        let body = read(&i18n.join("de.json"));
        assert!(body.contains("\"kept\""));
        assert!(!body.contains("legacy"));
        assert!(read(&i18n.join("de.json.bak")).contains("legacy"));

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn legacy_not_translatable_exports_the_source_text() {
        // Pre-v1.5 "not-translatable" state entries migrate to "keep
        // original": the export writes an explicit identical translation
        // instead of omitting the key (SPEC §9).
        let root = crate::test_support::temp_dir("export-keep-original");
        let i18n = root.join("i18n");
        write(&i18n.join("default.json"), "{ \"k\": \"Hello\" }");
        translations::save_one(
            &root,
            "mod.id",
            translations::entry_key("i18n", "k"),
            translations::StoredString {
                target: String::new(),
                status: "not-translatable".into(),
                source_hash: translations::source_hash("Hello"),
            },
        )
        .unwrap();

        let result = export_mod(&root, "mod.id", &input(&i18n)).unwrap();
        assert_eq!(result.files_written, 1);
        assert_eq!(result.total_written_keys, 1);
        let body = read(&i18n.join("de.json"));
        assert!(body.contains("\"k\": \"Hello\""));

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn does_not_write_a_file_with_no_translations() {
        let root = crate::test_support::temp_dir("export-empty");
        let i18n = root.join("i18n");
        write(&i18n.join("default.json"), "{ \"k\": \"Hello\" }");

        let result = export_mod(&root, "mod.id", &input(&i18n)).unwrap();
        assert_eq!(result.files_written, 0);
        assert_eq!(result.total_untranslated, 1);
        assert!(!result.files[0].written);
        // Nothing written -> no target file created.
        assert!(!i18n.join("de.json").exists());

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn malformed_second_file_leaves_every_target_untouched() {
        let root = crate::test_support::temp_dir("export-preflight-second-file");
        let first = root.join("first/i18n");
        let second = root.join("second/i18n");
        write(&first.join("default.json"), r#"{"k":"Hello"}"#);
        write(&first.join("de.json"), r#"{"k":"Alt"}"#);
        write(&second.join("default.json"), "{ broken");
        write(&second.join("de.json"), r#"{"k":"Zuvor"}"#);
        let files = vec![
            ExportFileInput {
                relative_dir: "first/i18n".into(),
                default_path: first.join("default.json").display().to_string(),
                target_path: first.join("de.json").display().to_string(),
            },
            ExportFileInput {
                relative_dir: "second/i18n".into(),
                default_path: second.join("default.json").display().to_string(),
                target_path: second.join("de.json").display().to_string(),
            },
        ];
        assert!(export_mod(&root, "mod.id", &files).is_err());
        assert_eq!(read(&first.join("de.json")), r#"{"k":"Alt"}"#);
        assert!(!first.join("de.json.bak").exists());
        assert_eq!(read(&second.join("de.json")), r#"{"k":"Zuvor"}"#);

        write(&second.join("default.json"), r#"{"k":"Hello"}"#);
        write(&second.join("de.json"), "[");
        assert!(export_mod(&root, "mod.id", &files).is_err());
        assert_eq!(read(&first.join("de.json")), r#"{"k":"Alt"}"#);
        assert!(!first.join("de.json.bak").exists());
        assert_eq!(read(&second.join("de.json")), "[");
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn portuguese_prefers_pt_br_then_canonicalizes_and_backs_up_both_variants() {
        let root = crate::test_support::temp_dir("export-pt-both");
        let i18n = root.join("i18n");
        write(&i18n.join("default.json"), r#"{"k":"Hello"}"#);
        write(&i18n.join("pt.json"), r#"{"k":"Canonical old"}"#);
        write(&i18n.join("pt-BR.json"), r#"{"k":"Brazil first"}"#);
        let files = vec![ExportFileInput {
            relative_dir: "i18n".into(),
            default_path: i18n.join("default.json").display().to_string(),
            target_path: i18n.join("pt.json").display().to_string(),
        }];

        export_mod(&root, "mod.id", &files).unwrap();
        assert!(read(&i18n.join("pt.json")).contains("Brazil first"));
        assert!(read(&i18n.join("pt.json.bak")).contains("Canonical old"));
        assert!(read(&i18n.join("pt-BR.json.bak")).contains("Brazil first"));
        assert!(!i18n.join("pt-BR.json").exists());
        std::fs::remove_dir_all(root).ok();
    }
}
