//! Bounded in-session operation feedback for the result tray.
//!
//! This is deliberately not a project log. Only the five latest completed
//! backend operations are retained, and the sole undo snapshot is kept in
//! memory so portable data never accumulates hidden history.

use std::collections::VecDeque;
use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::translations::{self, StoredString};

const MAX_HISTORY: usize = 5;
const MAX_WARNINGS: usize = 5;
const MAX_DETAILS: usize = 10;
const MAX_TITLE_CHARS: usize = 120;
const MAX_SUMMARY_CHARS: usize = 600;
const MAX_WARNING_CHARS: usize = 600;
const MAX_DETAIL_LABEL_CHARS: usize = 80;
const MAX_DETAIL_VALUE_CHARS: usize = 1_000;

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum OperationKind {
    Import,
    Export,
    Zip,
    BatchExport,
    BatchEdit,
    BatchUndo,
    Ai,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum OperationOutcome {
    Success,
    Warning,
    Cancelled,
    Blocked,
    Failed,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OperationDetail {
    pub label: String,
    pub value: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OperationHistoryEntry {
    pub id: String,
    pub kind: OperationKind,
    pub outcome: OperationOutcome,
    pub title: String,
    pub summary: String,
    pub item_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
    pub warnings: Vec<String>,
    pub details: Vec<OperationDetail>,
    pub can_undo: bool,
    pub completed_at_epoch_ms: u64,
}

#[derive(Clone, Debug)]
pub struct CompletedOperation {
    pub kind: OperationKind,
    pub outcome: OperationOutcome,
    pub title: String,
    pub summary: String,
    pub item_count: usize,
    pub path: Option<String>,
    pub file_name: Option<String>,
    pub warnings: Vec<String>,
    pub details: Vec<OperationDetail>,
}

#[derive(Clone)]
struct UndoSnapshot {
    operation_id: String,
    batch: translations::ReversibleBatch,
}

#[derive(Default)]
struct HistoryInner {
    sequence: u64,
    entries: VecDeque<OperationHistoryEntry>,
    undo: Option<UndoSnapshot>,
}

#[derive(Default)]
pub struct OperationHistoryState {
    inner: Mutex<HistoryInner>,
}

fn completed_at_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn truncate_chars(value: String, max: usize) -> String {
    if value.chars().count() <= max {
        return value;
    }
    let retained = max.saturating_sub(3);
    format!("{}...", value.chars().take(retained).collect::<String>())
}

fn bounded_warnings(warnings: Vec<String>) -> Vec<String> {
    let total = warnings.len();
    let keep = if total > MAX_WARNINGS {
        MAX_WARNINGS.saturating_sub(1)
    } else {
        total
    };
    let mut bounded = warnings
        .into_iter()
        .take(keep)
        .map(|warning| truncate_chars(warning, MAX_WARNING_CHARS))
        .collect::<Vec<_>>();
    if total > keep {
        bounded.push(format!("{} additional warnings omitted.", total - keep));
    }
    bounded
}

fn bounded_details(details: Vec<OperationDetail>) -> Vec<OperationDetail> {
    let total = details.len();
    let keep = if total > MAX_DETAILS {
        MAX_DETAILS.saturating_sub(1)
    } else {
        total
    };
    let mut bounded = details
        .into_iter()
        .take(keep)
        .map(|detail| OperationDetail {
            label: truncate_chars(detail.label, MAX_DETAIL_LABEL_CHARS),
            value: truncate_chars(detail.value, MAX_DETAIL_VALUE_CHARS),
        })
        .collect::<Vec<_>>();
    if total > keep {
        bounded.push(OperationDetail {
            label: "Additional details".to_string(),
            value: format!("{} omitted.", total - keep),
        });
    }
    bounded
}

fn next_id(inner: &mut HistoryInner) -> String {
    inner.sequence = inner.sequence.wrapping_add(1).max(1);
    format!("operation-{}", inner.sequence)
}

fn invalidate_undo(inner: &mut HistoryInner) {
    if let Some(snapshot) = inner.undo.take() {
        if let Some(entry) = inner
            .entries
            .iter_mut()
            .find(|entry| entry.id == snapshot.operation_id)
        {
            entry.can_undo = false;
        }
    }
}

fn push_entry(inner: &mut HistoryInner, entry: OperationHistoryEntry) {
    inner.entries.push_front(entry);
    inner.entries.truncate(MAX_HISTORY);
}

impl OperationHistoryState {
    pub fn list(&self) -> Result<Vec<OperationHistoryEntry>, String> {
        self.inner
            .lock()
            .map(|inner| inner.entries.iter().cloned().collect())
            .map_err(|_| "The operation result history is unavailable.".to_string())
    }

    pub fn record(&self, operation: CompletedOperation) -> Result<OperationHistoryEntry, String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "The operation result history is unavailable.".to_string())?;
        invalidate_undo(&mut inner);
        let entry = OperationHistoryEntry {
            id: next_id(&mut inner),
            kind: operation.kind,
            outcome: operation.outcome,
            title: truncate_chars(operation.title, MAX_TITLE_CHARS),
            summary: truncate_chars(operation.summary, MAX_SUMMARY_CHARS),
            item_count: operation.item_count,
            path: operation.path,
            file_name: operation.file_name,
            warnings: bounded_warnings(operation.warnings),
            details: bounded_details(operation.details),
            can_undo: false,
            completed_at_epoch_ms: completed_at_epoch_ms(),
        };
        push_entry(&mut inner, entry.clone());
        Ok(entry)
    }

    pub fn apply_reversible_batch_groups(
        &self,
        config_dir: &Path,
        title: String,
        groups: Vec<(String, Vec<(String, StoredString)>)>,
    ) -> Result<OperationHistoryEntry, String> {
        let component_count = groups.len();
        let item_count = groups.iter().try_fold(0_usize, |total, (_, entries)| {
            total
                .checked_add(entries.len())
                .ok_or_else(|| "The batch edit is too large.".to_string())
        })?;
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "The operation result history is unavailable.".to_string())?;
        // Serialize the state write with history updates. Otherwise a second
        // completed operation could invalidate an undo snapshot while this
        // batch is still being written, then this older batch could publish a
        // fresh snapshot afterward.
        let batch = translations::save_groups_with_previous(config_dir, groups)?;
        invalidate_undo(&mut inner);
        let id = next_id(&mut inner);
        let summary = if component_count == 1 {
            format!(
                "{} {} changed. Undo remains available until another operation or later edit replaces this result.",
                item_count,
                if item_count == 1 { "string was" } else { "strings were" }
            )
        } else {
            format!(
                "{item_count} strings across {component_count} components were changed. Undo remains available until another operation or later edit replaces this result."
            )
        };
        let entry = OperationHistoryEntry {
            id: id.clone(),
            kind: OperationKind::BatchEdit,
            outcome: OperationOutcome::Success,
            title,
            summary,
            item_count,
            path: None,
            file_name: None,
            warnings: Vec::new(),
            details: vec![OperationDetail {
                label: "Components".to_string(),
                value: component_count.to_string(),
            }],
            can_undo: true,
            completed_at_epoch_ms: completed_at_epoch_ms(),
        };
        inner.undo = Some(UndoSnapshot {
            operation_id: id,
            batch,
        });
        push_entry(&mut inner, entry.clone());
        Ok(entry)
    }

    pub fn undo_reversible_batch(
        &self,
        config_dir: &Path,
        operation_id: &str,
    ) -> Result<OperationHistoryEntry, String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "The operation result history is unavailable.".to_string())?;
        let snapshot = inner
            .undo
            .as_ref()
            .filter(|snapshot| snapshot.operation_id == operation_id)
            .cloned()
            .ok_or_else(|| "This batch edit is no longer available to undo.".to_string())?;

        // Keep the history lock until the conditional restore is complete so
        // another result cannot replace this snapshot midway through undo.
        let restore = translations::restore_groups_if_unchanged(config_dir, &snapshot.batch)?;
        if restore == translations::RestoreManyOutcome::Stale {
            invalidate_undo(&mut inner);
            return Err(
                "This batch edit can no longer be undone because one of its strings changed."
                    .to_string(),
            );
        }

        let component_count = snapshot.batch.edits.len();
        let restored = snapshot
            .batch
            .edits
            .iter()
            .map(|edit| edit.expected_current.len())
            .sum::<usize>();
        invalidate_undo(&mut inner);
        let entry = OperationHistoryEntry {
            id: next_id(&mut inner),
            kind: OperationKind::BatchUndo,
            outcome: OperationOutcome::Success,
            title: "Batch edit undone".to_string(),
            summary: format!(
                "{} {} restored to the exact previous values.",
                restored,
                if restored == 1 {
                    "string was"
                } else {
                    "strings were"
                }
            ),
            item_count: restored,
            path: None,
            file_name: None,
            warnings: Vec::new(),
            details: vec![OperationDetail {
                label: "Components".to_string(),
                value: component_count.to_string(),
            }],
            can_undo: false,
            completed_at_epoch_ms: completed_at_epoch_ms(),
        };
        push_entry(&mut inner, entry.clone());
        Ok(entry)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn operation(index: usize) -> CompletedOperation {
        CompletedOperation {
            kind: OperationKind::Export,
            outcome: OperationOutcome::Success,
            title: format!("Export {index}"),
            summary: "Complete".to_string(),
            item_count: index,
            path: None,
            file_name: None,
            warnings: Vec::new(),
            details: Vec::new(),
        }
    }

    fn stored(source: &str, target: &str, status: &str) -> StoredString {
        StoredString {
            target: target.to_string(),
            status: status.to_string(),
            source_hash: translations::source_hash(source),
        }
    }

    #[test]
    fn history_is_newest_first_and_bounded_to_five() {
        let history = OperationHistoryState::default();
        for index in 0..7 {
            history.record(operation(index)).unwrap();
        }
        let entries = history.list().unwrap();
        assert_eq!(entries.len(), MAX_HISTORY);
        assert_eq!(entries[0].title, "Export 6");
        assert_eq!(entries[4].title, "Export 2");
    }

    #[test]
    fn batch_undo_restores_exact_state_and_a_new_result_invalidates_it() {
        let dir = crate::test_support::temp_dir("operation-history-undo");
        translations::save_one(
            &dir,
            "mod",
            "i18n\0a".into(),
            stored("A", "Old", "translated"),
        )
        .unwrap();
        let history = OperationHistoryState::default();
        let changed = vec![
            ("i18n\0a".to_string(), stored("A", "New", "review-needed")),
            ("i18n\0b".to_string(), stored("B", "Added", "review-needed")),
        ];
        let batch = history
            .apply_reversible_batch_groups(
                &dir,
                "Marked for review".to_string(),
                vec![("mod".to_string(), changed)],
            )
            .unwrap();
        assert!(batch.can_undo);

        let undone = history.undo_reversible_batch(&dir, &batch.id).unwrap();
        assert_eq!(undone.kind, OperationKind::BatchUndo);
        let restored = translations::load(&dir, "mod").unwrap();
        assert_eq!(restored["i18n\0a"].target, "Old");
        assert!(!restored.contains_key("i18n\0b"));

        let next = history
            .apply_reversible_batch_groups(
                &dir,
                "Changed again".to_string(),
                vec![(
                    "mod".to_string(),
                    vec![("i18n\0a".to_string(), stored("A", "Again", "translated"))],
                )],
            )
            .unwrap();
        history.record(operation(9)).unwrap();
        assert!(history.undo_reversible_batch(&dir, &next.id).is_err());
        assert!(
            !history
                .list()
                .unwrap()
                .iter()
                .find(|entry| entry.id == next.id)
                .unwrap()
                .can_undo
        );
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn stale_batch_undo_is_invalidated_permanently() {
        let dir = crate::test_support::temp_dir("operation-history-stale-undo");
        let history = OperationHistoryState::default();
        let expected = stored("A", "Batch", "translated");
        let batch = history
            .apply_reversible_batch_groups(
                &dir,
                "Batch edit".to_string(),
                vec![(
                    "mod".to_string(),
                    vec![("key".to_string(), expected.clone())],
                )],
            )
            .unwrap();
        translations::save_one(
            &dir,
            "mod",
            "key".to_string(),
            stored("A", "Newer", "translated"),
        )
        .unwrap();
        // Returning to the batch-written value must not erase the fact that a
        // later successful edit already made this snapshot stale.
        translations::save_one(&dir, "mod", "key".to_string(), expected).unwrap();
        assert!(history.undo_reversible_batch(&dir, &batch.id).is_err());
        assert!(!history.list().unwrap()[0].can_undo);
        assert_eq!(
            translations::load(&dir, "mod").unwrap()["key"].target,
            "Batch"
        );
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn one_history_entry_and_undo_cover_multiple_components() {
        let dir = crate::test_support::temp_dir("operation-history-multi-component");
        translations::save_one(
            &dir,
            "component-a",
            "a".into(),
            stored("A", "Old A", "translated"),
        )
        .unwrap();
        translations::save_one(
            &dir,
            "component-b",
            "b".into(),
            stored("B", "Old B", "translated"),
        )
        .unwrap();
        let history = OperationHistoryState::default();
        let batch = history
            .apply_reversible_batch_groups(
                &dir,
                "Marked as done".to_string(),
                vec![
                    (
                        "component-a".to_string(),
                        vec![("a".to_string(), stored("A", "New A", "translated"))],
                    ),
                    (
                        "component-b".to_string(),
                        vec![
                            ("b".to_string(), stored("B", "New B", "translated")),
                            ("c".to_string(), stored("C", "Added C", "translated")),
                        ],
                    ),
                ],
            )
            .unwrap();
        assert_eq!(batch.item_count, 3);
        assert_eq!(batch.details[0].value, "2");
        assert_eq!(history.list().unwrap().len(), 1);

        let undo = history.undo_reversible_batch(&dir, &batch.id).unwrap();
        assert_eq!(undo.item_count, 3);
        assert_eq!(undo.details[0].value, "2");
        assert_eq!(
            translations::load(&dir, "component-a").unwrap()["a"].target,
            "Old A"
        );
        let restored_b = translations::load(&dir, "component-b").unwrap();
        assert_eq!(restored_b["b"].target, "Old B");
        assert!(!restored_b.contains_key("c"));
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn retained_warning_and_detail_payloads_are_bounded() {
        let history = OperationHistoryState::default();
        let mut completed = operation(1);
        completed.outcome = OperationOutcome::Warning;
        completed.warnings = (0..8)
            .map(|index| format!("warning-{index}-{}", "x".repeat(MAX_WARNING_CHARS + 20)))
            .collect();
        completed.details = (0..13)
            .map(|index| OperationDetail {
                label: format!("Detail {index}"),
                value: "y".repeat(MAX_DETAIL_VALUE_CHARS + 20),
            })
            .collect();

        let entry = history.record(completed).unwrap();
        assert_eq!(entry.outcome, OperationOutcome::Warning);
        assert_eq!(entry.warnings.len(), MAX_WARNINGS);
        assert!(entry.warnings.last().unwrap().contains("omitted"));
        assert_eq!(entry.details.len(), MAX_DETAILS);
        assert_eq!(entry.details.last().unwrap().label, "Additional details");
        assert!(entry
            .warnings
            .iter()
            .all(|warning| warning.chars().count() <= MAX_WARNING_CHARS));
        assert!(entry
            .details
            .iter()
            .all(|detail| detail.value.chars().count() <= MAX_DETAIL_VALUE_CHARS));
    }
}
