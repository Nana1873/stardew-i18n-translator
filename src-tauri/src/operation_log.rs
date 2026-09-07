//! Bounded lifecycle records for local commands; never serialize command payloads.
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

static NEXT_ID: AtomicU64 = AtomicU64::new(1);
static SESSION: OnceLock<u128> = OnceLock::new();

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    Success,
    Cancelled,
    Blocked,
    Partial,
}

pub(crate) struct Summary {
    pub outcome: Outcome,
    pub items: usize,
    pub files: usize,
    pub issues: usize,
}

impl Summary {
    pub fn new(outcome: Outcome, items: usize, files: usize, issues: usize) -> Self {
        Self {
            outcome,
            items,
            files,
            issues,
        }
    }
}

pub(crate) fn run<T>(
    name: &'static str,
    action: impl FnOnce() -> Result<T, String>,
    summarize: impl FnOnce(&T) -> Summary,
) -> Result<T, String> {
    record(
        log::log_enabled!(target: "app", log::Level::Info),
        name,
        action,
        summarize,
        |line| log::info!(target: "app", "{line}"),
    )
}

fn record<T>(
    enabled: bool,
    name: &'static str,
    action: impl FnOnce() -> Result<T, String>,
    summarize: impl FnOnce(&T) -> Summary,
    mut emit: impl FnMut(String),
) -> Result<T, String> {
    if !enabled {
        return action();
    }
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let started = Instant::now();
    // Names are code constants, not user data; cap them defensively too.
    let name: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
        .take(64)
        .collect();
    let session = SESSION.get_or_init(|| {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    });
    let prefix = format!(
        "operation={name} id={}-{}-{id}",
        std::process::id(),
        session
    );
    emit(format!("{prefix} event=start"));
    let result = action();
    let (outcome, items, files, issues) = match &result {
        Ok(value) => {
            let summary = summarize(value);
            let outcome = match summary.outcome {
                Outcome::Success => "success",
                Outcome::Cancelled => "cancelled",
                Outcome::Blocked => "blocked",
                Outcome::Partial => "partial",
            };
            (outcome, summary.items, summary.files, summary.issues)
        }
        Err(error) => (
            if error == "OVERWRITE_REQUIRED" {
                "confirmation_required"
            } else {
                "error"
            },
            0,
            0,
            0,
        ),
    };
    let category = result
        .as_ref()
        .err()
        .map(|error| error_category(error))
        .unwrap_or("none");
    // Errors can contain translation text or credentials. Only the safe category is logged.
    emit(format!("{prefix} event=end durationMs={} outcome={outcome} category={category} items={items} files={files} issues={issues}", started.elapsed().as_millis()));
    result
}

fn error_category(error: &str) -> &'static str {
    if error == "OVERWRITE_REQUIRED" {
        "overwrite"
    } else if error
        == "An export or settings update is already running. Wait for it to finish and try again."
    {
        "busy"
    } else if error.starts_with("Configure the Stardew Valley Mods folder")
        || error.starts_with("Choose a target language")
    {
        "invalid_context"
    } else if error.starts_with("Refusing export") || error.starts_with("Archive paths") {
        "validation"
    } else if error.starts_with("The selected Mods folder ") {
        "invalid_path"
    } else {
        "unknown"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn disabled_logging_bypasses_summary_and_events() {
        let value = record(
            false,
            "fixture",
            || Ok(7),
            |_| panic!("summary called"),
            |_| panic!("event emitted"),
        );
        assert_eq!(value, Ok(7));
    }
    #[test]
    fn known_errors_use_only_safe_categories() {
        assert_eq!(error_category("An export or settings update is already running. Wait for it to finish and try again."), "busy");
        assert_eq!(
            error_category("Choose a target language before editing translations."),
            "invalid_context"
        );
        assert_eq!(
            error_category("Refusing export: private payload"),
            "validation"
        );
        assert_eq!(
            error_category("The selected Mods folder private path is unavailable."),
            "invalid_path"
        );
        assert_eq!(error_category("private payload"), "unknown");
    }
    #[test]
    fn lifecycle_pairs_ids_and_preserves_results_without_payloads() {
        for outcome in [
            Outcome::Success,
            Outcome::Cancelled,
            Outcome::Blocked,
            Outcome::Partial,
        ] {
            let mut lines = Vec::new();
            let result = record(
                true,
                "fixture",
                || Ok("private translation"),
                |_| Summary::new(outcome, 3, 1, 2),
                |line| lines.push(line),
            );
            assert_eq!(result.unwrap(), "private translation");
            assert_eq!(lines.len(), 2);
            assert_eq!(
                lines[0].split(" event=").next(),
                lines[1].split(" event=").next()
            );
            assert!(lines[1].contains(&format!(
                "outcome={}",
                format!("{outcome:?}").to_lowercase()
            )));
            assert!(lines
                .iter()
                .all(|line| line.len() < 320 && !line.contains("private translation")));
        }
    }
    #[test]
    fn early_errors_and_confirmation_finish_once_without_error_payload() {
        for error in ["secret token=abc\nsource text", "OVERWRITE_REQUIRED"] {
            let mut lines = Vec::new();
            let result: Result<(), String> = record(
                true,
                "fixture",
                || Err(error.into()),
                |_| panic!("failure must not summarize"),
                |line| lines.push(line),
            );
            assert_eq!(result.unwrap_err(), error);
            assert_eq!(lines.len(), 2);
            assert!(lines[1].contains(if error == "OVERWRITE_REQUIRED" {
                "outcome=confirmation_required"
            } else {
                "outcome=error"
            }));
            assert!(lines
                .iter()
                .all(|line| !line.contains(error) && !line.contains('\n')));
        }
    }
}
