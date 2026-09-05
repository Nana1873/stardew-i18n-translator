//! External LLM batch format v2. See SPEC.md, External LLM Batches.
//!
//! The batch deliberately carries only one binding hash for the complete
//! source selection. The LLM translates values inside `files` and copies the
//! small metadata object unchanged. Import validates the complete binding and
//! every token before writing any translation state.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::scanner::StringRow;
use crate::tokens;
use crate::translations::{self, StoredString};

pub const BATCH_FORMAT: &str = "stardew-translator-llm-batch";
pub const BATCH_VERSION: u64 = 2;

/// One string selected for batch export (mirrors the frontend payload).
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BatchExportItem {
    pub relative_dir: String,
    pub key: String,
    pub source: String,
}

/// Build the intentionally small v2 document. The one snapshot binds the mod,
/// language, selected file/key set, and every current English source string.
pub fn build_batch(mod_unique_id: &str, target_lang: &str, items: &[BatchExportItem]) -> Value {
    let mut files: Map<String, Value> = Map::new();
    for item in items {
        let entry = files
            .entry(item.relative_dir.clone())
            .or_insert_with(|| Value::Object(Map::new()));
        if let Some(group) = entry.as_object_mut() {
            group.insert(item.key.clone(), Value::String(item.source.clone()));
        }
    }

    let mut metadata = Map::new();
    metadata.insert(
        "modUniqueId".into(),
        Value::String(mod_unique_id.to_string()),
    );
    metadata.insert("targetLang".into(), Value::String(target_lang.to_string()));
    metadata.insert(
        "sourceSnapshot".into(),
        Value::String(source_snapshot(items.iter().map(|item| {
            (
                item.relative_dir.as_str(),
                item.key.as_str(),
                item.source.as_str(),
            )
        }))),
    );

    let mut root = Map::new();
    root.insert("format".into(), Value::String(BATCH_FORMAT.to_string()));
    root.insert("version".into(), Value::from(BATCH_VERSION));
    root.insert("metadata".into(), Value::Object(metadata));
    root.insert("files".into(), Value::Object(files));
    Value::Object(root)
}

fn source_snapshot<'a>(entries: impl Iterator<Item = (&'a str, &'a str, &'a str)>) -> String {
    let mut entries: Vec<[&str; 3]> = entries
        .map(|(relative_dir, key, source)| [relative_dir, key, source])
        .collect();
    entries.sort_unstable();
    let canonical = serde_json::to_vec(&entries).expect("string triples always serialize");
    let mut hasher = Sha256::new();
    hasher.update(canonical);
    format!("{:x}", hasher.finalize())
}

#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    /// Values staged as `review-needed`.
    pub imported: usize,
    /// Untouched because a non-empty local translation already exists.
    pub skipped_translated: usize,
    /// Empty translation values intentionally skipped.
    pub unmatched: usize,
    pub identical_to_source: usize,
    pub total_in_file: usize,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportTokenDifference {
    pub token: String,
    pub source_count: usize,
    pub target_count: usize,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportTokenIssue {
    pub relative_dir: String,
    pub key: String,
    pub differences: Vec<ImportTokenDifference>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SnapshotResult {
    Matched,
    Mismatch,
    NotChecked,
}

/// Read-only analysis shown before an external LLM batch can write state.
/// A structurally valid file always returns its binding metadata, including
/// wrong-mod/wrong-language files so the UI can offer a deliberate switch to
/// another currently scanned component and rerun this preflight there.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreflight {
    pub batch_mod_unique_id: String,
    pub batch_target_lang: String,
    pub selected_mod_unique_id: String,
    pub selected_target_lang: String,
    pub mod_matches: bool,
    pub language_matches: bool,
    pub snapshot_result: SnapshotResult,
    pub supplied_strings: usize,
    pub matched_strings: usize,
    pub preserved_local: usize,
    pub skipped_empty: usize,
    pub identical_to_source: usize,
    pub importable: usize,
    pub protected_token_issues: Vec<ImportTokenIssue>,
    pub ready: bool,
    pub blocking_reason: Option<String>,
}

/// The staged outcome of an import: entries ready for one `save_many` call,
/// plus the user-facing summary.
#[derive(Debug)]
pub struct PreparedImport {
    pub entries: Vec<(String, StoredString)>,
    pub summary: ImportSummary,
}

struct BatchEnvelope<'a> {
    mod_unique_id: &'a str,
    target_lang: &'a str,
    source_snapshot: &'a str,
    files: &'a Map<String, Value>,
    supplied_strings: usize,
}

struct BatchAnalysis {
    preflight: ImportPreflight,
    entries: Vec<(String, StoredString)>,
}

fn batch_envelope(result: &Value) -> Result<BatchEnvelope<'_>, String> {
    let object = result.as_object().ok_or("The file is not a JSON object.")?;
    let format = object.get("format").and_then(Value::as_str).unwrap_or("");
    let version = object.get("version").and_then(Value::as_u64);
    if format != BATCH_FORMAT || version != Some(BATCH_VERSION) {
        if version == Some(1) {
            return Err(
                "LLM batch format 1 is no longer supported. Import and review old batches with v1.4.1 or earlier before updating. No changes were made."
                    .to_string(),
            );
        }
        return Err(format!(
            "Unsupported LLM batch format or version (expected {BATCH_FORMAT} version {BATCH_VERSION}). No changes were made."
        ));
    }

    let metadata = object
        .get("metadata")
        .and_then(Value::as_object)
        .ok_or("The batch has no valid metadata object. No changes were made.")?;
    let mod_unique_id = required_metadata(metadata, "modUniqueId")?;
    let target_lang = required_metadata(metadata, "targetLang")?;
    let source_snapshot = required_metadata(metadata, "sourceSnapshot")?;
    let files = object
        .get("files")
        .and_then(Value::as_object)
        .ok_or("The batch has no valid files object. No changes were made.")?;
    if files.is_empty() {
        return Err("The batch contains no files. No changes were made.".to_string());
    }

    let mut supplied_strings = 0usize;
    for (relative_dir, group) in files {
        let group = group.as_object().ok_or_else(|| {
            format!("Batch file group \"{relative_dir}\" is not an object. No changes were made.")
        })?;
        if group.is_empty() {
            return Err(format!(
                "Batch file group \"{relative_dir}\" is empty. No changes were made."
            ));
        }
        for (key, value) in group {
            supplied_strings += 1;
            if !value.is_string() {
                return Err(format!(
                    "Translation \"{relative_dir} · {key}\" is not a string. No changes were made."
                ));
            }
        }
    }

    Ok(BatchEnvelope {
        mod_unique_id,
        target_lang,
        source_snapshot,
        files,
        supplied_strings,
    })
}

fn analyze_batch(
    result: &Value,
    expected_mod_unique_id: &str,
    expected_target_lang: &str,
    rows_by_dir: &HashMap<String, Vec<StringRow>>,
) -> Result<BatchAnalysis, String> {
    let batch = batch_envelope(result)?;
    let mod_matches = batch.mod_unique_id == expected_mod_unique_id;
    let language_matches = batch.target_lang == expected_target_lang;
    let mut preflight = ImportPreflight {
        batch_mod_unique_id: batch.mod_unique_id.to_string(),
        batch_target_lang: batch.target_lang.to_string(),
        selected_mod_unique_id: expected_mod_unique_id.to_string(),
        selected_target_lang: expected_target_lang.to_string(),
        mod_matches,
        language_matches,
        snapshot_result: SnapshotResult::NotChecked,
        supplied_strings: batch.supplied_strings,
        matched_strings: 0,
        preserved_local: 0,
        skipped_empty: 0,
        identical_to_source: 0,
        importable: 0,
        protected_token_issues: Vec::new(),
        ready: false,
        blocking_reason: None,
    };

    if !mod_matches {
        preflight.blocking_reason = Some(format!(
            "This batch belongs to mod \"{}\", not \"{expected_mod_unique_id}\". No changes were made.",
            batch.mod_unique_id
        ));
        return Ok(BatchAnalysis {
            preflight,
            entries: Vec::new(),
        });
    }
    if !language_matches {
        preflight.blocking_reason = Some(format!(
            "This batch targets language \"{}\", not \"{expected_target_lang}\". No changes were made.",
            batch.target_lang
        ));
        return Ok(BatchAnalysis {
            preflight,
            entries: Vec::new(),
        });
    }

    let mut current_entries = Vec::with_capacity(batch.supplied_strings);
    let mut first_binding_error = None;
    for (relative_dir, group) in batch.files {
        let Some(rows) = rows_by_dir.get(relative_dir) else {
            first_binding_error.get_or_insert_with(|| {
                format!("Batch contains unknown file \"{relative_dir}\". No changes were made.")
            });
            continue;
        };
        for key in group
            .as_object()
            .expect("batch_envelope validated every file group")
            .keys()
        {
            let Some(row) = rows.iter().find(|row| row.key == *key) else {
                first_binding_error.get_or_insert_with(|| {
                    format!(
                        "Batch contains unknown key \"{relative_dir} · {key}\". No changes were made."
                    )
                });
                continue;
            };
            preflight.matched_strings += 1;
            current_entries.push((relative_dir.as_str(), key.as_str(), row.source.as_str()));
        }
    }

    let snapshot_matches = first_binding_error.is_none()
        && preflight.matched_strings == batch.supplied_strings
        && source_snapshot(current_entries.into_iter()) == batch.source_snapshot;
    preflight.snapshot_result = if snapshot_matches {
        SnapshotResult::Matched
    } else {
        SnapshotResult::Mismatch
    };
    if !snapshot_matches {
        preflight.blocking_reason = Some(first_binding_error.unwrap_or_else(|| {
            "The batch file/key set or English source text changed since export. Create a new format-2 batch. No changes were made."
                .to_string()
        }));
        return Ok(BatchAnalysis {
            preflight,
            entries: Vec::new(),
        });
    }

    let mut entries = Vec::new();
    for (relative_dir, group) in batch.files {
        let rows = rows_by_dir
            .get(relative_dir)
            .expect("snapshot validation proved this file binding");
        for (key, value) in group
            .as_object()
            .expect("batch_envelope validated every file group")
        {
            let text = value
                .as_str()
                .expect("batch_envelope validated every translation value");
            if text.trim().is_empty() {
                preflight.skipped_empty += 1;
                continue;
            }
            let row = rows
                .iter()
                .find(|row| row.key == *key)
                .expect("snapshot validation proved this key binding");
            if !row.target.trim().is_empty() {
                preflight.preserved_local += 1;
                continue;
            }
            let differences = tokens::token_differences(&row.source, text);
            if !differences.is_empty() {
                preflight.protected_token_issues.push(ImportTokenIssue {
                    relative_dir: relative_dir.clone(),
                    key: key.clone(),
                    differences: differences
                        .into_iter()
                        .map(|difference| ImportTokenDifference {
                            token: difference.token,
                            source_count: difference.source_count,
                            target_count: difference.target_count,
                        })
                        .collect(),
                });
                continue;
            }
            if text.trim() == row.source.trim() {
                preflight.identical_to_source += 1;
            }
            preflight.importable += 1;
            entries.push((
                translations::entry_key(relative_dir, key),
                StoredString {
                    target: text.to_string(),
                    status: "review-needed".to_string(),
                    source_hash: translations::source_hash(&row.source),
                },
            ));
        }
    }

    if preflight.protected_token_issues.is_empty() {
        preflight.ready = true;
    } else {
        let labels = preflight
            .protected_token_issues
            .iter()
            .map(|issue| format!("{} · {}", issue.relative_dir, issue.key))
            .collect::<Vec<_>>()
            .join(", ");
        preflight.blocking_reason = Some(format!(
            "Protected tokens changed in: {labels}. Fix the batch and retry. No changes were made."
        ));
    }

    Ok(BatchAnalysis { preflight, entries })
}

/// Analyze a translated batch without writing translation state.
pub fn preflight_batch(
    result: &Value,
    expected_mod_unique_id: &str,
    expected_target_lang: &str,
    rows_by_dir: &HashMap<String, Vec<StringRow>>,
) -> Result<ImportPreflight, String> {
    analyze_batch(
        result,
        expected_mod_unique_id,
        expected_target_lang,
        rows_by_dir,
    )
    .map(|analysis| analysis.preflight)
}

/// Validate a translated v2 batch against the selected mod and current source
/// rows. No caller writes anything unless this complete function succeeds.
pub fn apply_batch(
    result: &Value,
    expected_mod_unique_id: &str,
    expected_target_lang: &str,
    rows_by_dir: &HashMap<String, Vec<StringRow>>,
) -> Result<PreparedImport, String> {
    let analysis = analyze_batch(
        result,
        expected_mod_unique_id,
        expected_target_lang,
        rows_by_dir,
    )?;
    if let Some(reason) = analysis.preflight.blocking_reason {
        return Err(reason);
    }

    Ok(PreparedImport {
        entries: analysis.entries,
        summary: ImportSummary {
            imported: analysis.preflight.importable,
            skipped_translated: analysis.preflight.preserved_local,
            unmatched: analysis.preflight.skipped_empty,
            identical_to_source: analysis.preflight.identical_to_source,
            total_in_file: analysis.preflight.supplied_strings,
        },
    })
}

fn required_metadata<'a>(metadata: &'a Map<String, Value>, key: &str) -> Result<&'a str, String> {
    metadata
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            format!("Batch metadata \"{key}\" is missing or invalid. No changes were made.")
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn item(dir: &str, key: &str, source: &str) -> BatchExportItem {
        BatchExportItem {
            relative_dir: dir.into(),
            key: key.into(),
            source: source.into(),
        }
    }

    fn row(key: &str, source: &str, target: &str, status: &str) -> StringRow {
        StringRow {
            key: key.into(),
            source: source.into(),
            target: target.into(),
            target_present: !target.is_empty(),
            status: status.into(),
            token_mismatch_accepted: false,
            section: None,
        }
    }

    fn rows() -> HashMap<String, Vec<StringRow>> {
        HashMap::from([
            (
                "i18n".to_string(),
                vec![
                    row("hello", "Hello {{name}}", "", "untranslated"),
                    row("done", "Done", "Fertig", "translated"),
                ],
            ),
            (
                "sub/i18n".to_string(),
                vec![row("bye", "Bye", "", "untranslated")],
            ),
        ])
    }

    fn translated_batch() -> Value {
        let mut batch = build_batch(
            "Author.Mod",
            "de",
            &[
                item("i18n", "hello", "Hello {{name}}"),
                item("i18n", "done", "Done"),
                item("sub/i18n", "bye", "Bye"),
            ],
        );
        batch["files"]["i18n"]["hello"] = Value::String("Hallo {{name}}".into());
        batch["files"]["i18n"]["done"] = Value::String("Erledigt".into());
        batch["files"]["sub/i18n"]["bye"] = Value::String("Tschüss".into());
        batch
    }

    #[test]
    fn v2_has_only_one_snapshot_and_the_minimal_shape() {
        let batch = build_batch(
            "Author.Mod",
            "de",
            &[item("i18n", "hello", "Hello"), item("i18n", "bye", "Bye")],
        );
        let root = batch.as_object().unwrap();
        assert_eq!(root.keys().collect::<HashSet<_>>().len(), 4);
        assert_eq!(batch["format"], BATCH_FORMAT);
        assert_eq!(batch["version"], 2);
        assert_eq!(batch["metadata"]["modUniqueId"], "Author.Mod");
        assert_eq!(batch["metadata"]["targetLang"], "de");
        assert_eq!(
            batch["metadata"]
                .as_object()
                .unwrap()
                .keys()
                .collect::<HashSet<_>>()
                .len(),
            3
        );
        assert_eq!(
            batch["metadata"]["sourceSnapshot"].as_str().unwrap().len(),
            64
        );
        assert!(root.get("instructions").is_none());
        assert!(root.get("glossary").is_none());
        assert!(root.get("sections").is_none());
    }

    #[test]
    fn snapshot_is_stable_across_item_order() {
        let a = build_batch(
            "Author.Mod",
            "de",
            &[item("i18n", "a", "A"), item("sub/i18n", "b", "B")],
        );
        let b = build_batch(
            "Author.Mod",
            "de",
            &[item("sub/i18n", "b", "B"), item("i18n", "a", "A")],
        );
        assert_eq!(
            a["metadata"]["sourceSnapshot"],
            b["metadata"]["sourceSnapshot"]
        );
    }

    #[test]
    fn v2_roundtrip_imports_review_needed_and_protects_local_work() {
        let prepared = apply_batch(&translated_batch(), "Author.Mod", "de", &rows()).unwrap();
        assert_eq!(prepared.summary.total_in_file, 3);
        assert_eq!(prepared.summary.imported, 2);
        assert_eq!(prepared.summary.skipped_translated, 1);
        assert!(prepared
            .entries
            .iter()
            .all(|(_, entry)| entry.status == "review-needed"));
    }

    #[test]
    fn preflight_reports_the_complete_ready_import_without_writing() {
        let report = preflight_batch(&translated_batch(), "Author.Mod", "de", &rows()).unwrap();

        assert_eq!(report.batch_mod_unique_id, "Author.Mod");
        assert_eq!(report.batch_target_lang, "de");
        assert!(report.mod_matches);
        assert!(report.language_matches);
        assert_eq!(report.snapshot_result, SnapshotResult::Matched);
        assert_eq!(report.supplied_strings, 3);
        assert_eq!(report.matched_strings, 3);
        assert_eq!(report.preserved_local, 1);
        assert_eq!(report.skipped_empty, 0);
        assert_eq!(report.importable, 2);
        assert!(report.protected_token_issues.is_empty());
        assert!(report.ready);
        assert_eq!(report.blocking_reason, None);
    }

    #[test]
    fn preflight_exposes_wrong_mod_metadata_for_an_explicit_switch() {
        let report = preflight_batch(&translated_batch(), "Other.Mod", "de", &rows()).unwrap();

        assert_eq!(report.batch_mod_unique_id, "Author.Mod");
        assert_eq!(report.selected_mod_unique_id, "Other.Mod");
        assert!(!report.mod_matches);
        assert!(report.language_matches);
        assert_eq!(report.snapshot_result, SnapshotResult::NotChecked);
        assert_eq!(report.supplied_strings, 3);
        assert_eq!(report.matched_strings, 0);
        assert!(!report.ready);
        assert!(report
            .blocking_reason
            .as_deref()
            .unwrap()
            .contains("belongs to mod"));
    }

    #[test]
    fn preflight_reports_wrong_language_without_checking_the_snapshot() {
        let report = preflight_batch(&translated_batch(), "Author.Mod", "fr", &rows()).unwrap();

        assert!(report.mod_matches);
        assert!(!report.language_matches);
        assert_eq!(report.batch_target_lang, "de");
        assert_eq!(report.selected_target_lang, "fr");
        assert_eq!(report.snapshot_result, SnapshotResult::NotChecked);
        assert_eq!(report.supplied_strings, 3);
        assert_eq!(report.matched_strings, 0);
        assert!(!report.ready);
        assert!(report
            .blocking_reason
            .as_deref()
            .unwrap()
            .contains("targets language"));
    }

    #[test]
    fn preflight_reports_snapshot_mismatch_and_matched_count() {
        let mut current = rows();
        current.get_mut("i18n").unwrap()[0].source = "Changed".into();

        let report = preflight_batch(&translated_batch(), "Author.Mod", "de", &current).unwrap();

        assert_eq!(report.snapshot_result, SnapshotResult::Mismatch);
        assert_eq!(report.supplied_strings, 3);
        assert_eq!(report.matched_strings, 3);
        assert!(!report.ready);
        assert!(report
            .blocking_reason
            .as_deref()
            .unwrap()
            .contains("English source text changed"));
    }

    #[test]
    fn preflight_counts_partial_matches_for_an_unknown_file() {
        let mut batch = translated_batch();
        batch["files"]["ghost/i18n"] = serde_json::json!({ "unknown": "Unbekannt" });

        let report = preflight_batch(&batch, "Author.Mod", "de", &rows()).unwrap();

        assert_eq!(report.snapshot_result, SnapshotResult::Mismatch);
        assert_eq!(report.supplied_strings, 4);
        assert_eq!(report.matched_strings, 3);
        assert!(!report.ready);
        assert!(report
            .blocking_reason
            .as_deref()
            .unwrap()
            .contains("unknown file"));
    }

    #[test]
    fn preflight_returns_structured_token_issues_and_empty_counts() {
        let mut batch = translated_batch();
        batch["files"]["i18n"]["hello"] = Value::String("Hallo".into());
        batch["files"]["sub/i18n"]["bye"] = Value::String(" ".into());

        let report = preflight_batch(&batch, "Author.Mod", "de", &rows()).unwrap();

        assert_eq!(report.snapshot_result, SnapshotResult::Matched);
        assert_eq!(report.skipped_empty, 1);
        assert_eq!(report.preserved_local, 1);
        assert_eq!(report.importable, 0);
        assert!(!report.ready);
        assert_eq!(report.protected_token_issues.len(), 1);
        assert_eq!(report.protected_token_issues[0].relative_dir, "i18n");
        assert_eq!(report.protected_token_issues[0].key, "hello");
        assert_eq!(
            report.protected_token_issues[0].differences[0].token,
            "{{name}}"
        );
        assert_eq!(
            report.protected_token_issues[0].differences[0].source_count,
            1
        );
        assert_eq!(
            report.protected_token_issues[0].differences[0].target_count,
            0
        );
    }

    #[test]
    fn import_revalidates_after_a_successful_preflight() {
        let batch = translated_batch();
        let original = rows();
        assert!(
            preflight_batch(&batch, "Author.Mod", "de", &original)
                .unwrap()
                .ready
        );

        let mut changed = original;
        changed.get_mut("sub/i18n").unwrap()[0].source = "Changed after preflight".into();

        let error = apply_batch(&batch, "Author.Mod", "de", &changed).unwrap_err();
        assert!(error.contains("English source text changed"));
    }

    #[test]
    fn wrong_mod_language_source_and_v1_are_rejected() {
        let current = rows();
        let batch = translated_batch();
        assert!(apply_batch(&batch, "Other.Mod", "de", &current).is_err());
        assert!(apply_batch(&batch, "Author.Mod", "fr", &current).is_err());

        let mut changed = current.clone();
        changed.get_mut("i18n").unwrap()[0].source = "Changed".into();
        assert!(apply_batch(&batch, "Author.Mod", "de", &changed).is_err());

        let mut v1 = batch;
        v1["version"] = Value::from(1);
        assert!(apply_batch(&v1, "Author.Mod", "de", &current)
            .unwrap_err()
            .contains("v1.4.1 or earlier"));
    }

    #[test]
    fn changed_files_keys_and_non_strings_are_rejected() {
        let current = rows();
        let mut missing = translated_batch();
        missing["files"]["i18n"]
            .as_object_mut()
            .unwrap()
            .remove("hello");
        assert!(apply_batch(&missing, "Author.Mod", "de", &current).is_err());

        let mut unknown = translated_batch();
        unknown["files"]["i18n"]["ghost"] = Value::String("Geist".into());
        assert!(apply_batch(&unknown, "Author.Mod", "de", &current).is_err());

        let mut non_string = translated_batch();
        non_string["files"]["i18n"]["hello"] = Value::from(42);
        assert!(apply_batch(&non_string, "Author.Mod", "de", &current).is_err());
    }

    #[test]
    fn empty_values_are_skipped_but_token_changes_reject_everything() {
        let current = rows();
        let mut empty = translated_batch();
        empty["files"]["sub/i18n"]["bye"] = Value::String(" ".into());
        let prepared = apply_batch(&empty, "Author.Mod", "de", &current).unwrap();
        assert_eq!(prepared.summary.unmatched, 1);
        assert_eq!(prepared.summary.imported, 1);

        let mut broken = translated_batch();
        broken["files"]["i18n"]["hello"] = Value::String("Hallo".into());
        assert!(apply_batch(&broken, "Author.Mod", "de", &current)
            .unwrap_err()
            .contains("Protected tokens changed"));
    }

    #[test]
    fn broken_tokens_in_a_preserved_local_translation_do_not_block_import() {
        let current = HashMap::from([(
            "i18n".to_string(),
            vec![
                row(
                    "preserved",
                    "Hello {{name}}",
                    "Hallo {{name}}",
                    "translated",
                ),
                row("open", "Bye {{name}}", "", "untranslated"),
            ],
        )]);
        let mut batch = build_batch(
            "Author.Mod",
            "de",
            &[
                item("i18n", "preserved", "Hello {{name}}"),
                item("i18n", "open", "Bye {{name}}"),
            ],
        );
        batch["files"]["i18n"]["preserved"] = Value::String("Kaputt".into());
        batch["files"]["i18n"]["open"] = Value::String("Tschüss {{name}}".into());

        let report = preflight_batch(&batch, "Author.Mod", "de", &current).unwrap();
        assert!(report.ready);
        assert_eq!(report.preserved_local, 1);
        assert_eq!(report.importable, 1);
        assert!(report.protected_token_issues.is_empty());

        let prepared = apply_batch(&batch, "Author.Mod", "de", &current).unwrap();
        assert_eq!(prepared.summary.skipped_translated, 1);
        assert_eq!(prepared.summary.imported, 1);
        assert_eq!(prepared.entries.len(), 1);
        assert_eq!(prepared.entries[0].1.target, "Tschüss {{name}}");
    }
}
