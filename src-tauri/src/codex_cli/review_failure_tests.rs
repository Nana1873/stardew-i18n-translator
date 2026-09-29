//! Review loop behavior when a Codex review batch cannot complete.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use super::{
    build_terminology_repair_plans, execute_review_plans, execute_terminology_repair_plans,
    PreparedAiItem, ProviderFailure, ProviderProgressCallback, ProviderProgressEvent,
    ProviderTranslation, ReviewPlan, ReviewSkipReason,
};

fn item(id: &str, source: &str, group: usize) -> PreparedAiItem {
    PreparedAiItem {
        id: id.to_string(),
        identity: crate::ai::AiStringIdentity {
            mod_unique_id: "synthetic.test".to_string(),
            relative_dir: "i18n".to_string(),
            key: id.to_string(),
        },
        source: source.to_string(),
        section: None,
        glossary_pairs: Vec::new(),
        context: crate::ai::AiPromptContext::isolated(group),
        default_path: PathBuf::from(r"C:\synthetic\default.json"),
        target_path: PathBuf::from(r"C:\synthetic\de.json"),
        expected_stored: None,
        expected_revision: 0,
    }
}

fn translation(id: &str, text: &str) -> ProviderTranslation {
    ProviderTranslation {
        id: id.to_string(),
        text: text.to_string(),
    }
}

fn recorder() -> (
    ProviderProgressCallback,
    Arc<Mutex<Vec<ProviderProgressEvent>>>,
) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&events);
    (
        Arc::new(move |event| recorded.lock().unwrap().push(event)),
        events,
    )
}

fn skipped(events: &[ProviderProgressEvent]) -> Vec<(usize, ReviewSkipReason)> {
    events
        .iter()
        .filter_map(|event| match *event {
            ProviderProgressEvent::ReviewSkipped { item_count, reason } => {
                Some((item_count, reason))
            }
            _ => None,
        })
        .collect()
}

/// Two items in separate review plans (one plan per item).
fn two_plans() -> (
    Vec<PreparedAiItem>,
    Vec<ProviderTranslation>,
    Vec<ReviewPlan>,
) {
    let items = vec![
        item("item-0000", "First", 0),
        item("item-0001", "Second", 1),
    ];
    let drafts = vec![
        translation("item-0000", "Erster Entwurf"),
        translation("item-0001", "Zweiter Entwurf"),
    ];
    let plans = items
        .iter()
        .zip(&drafts)
        .map(|(item, draft)| ReviewPlan {
            items: vec![item.clone()],
            drafts: vec![draft.clone()],
        })
        .collect();
    (items, drafts, plans)
}

#[test]
fn persistent_transient_review_failure_keeps_drafts_and_reports_a_warning() {
    let items = vec![item("item-0000", "Hello, {{name}}.", 0)];
    let drafts = vec![translation("item-0000", "Hallo, {{name}}.")];
    let plans = vec![ReviewPlan {
        items: items.clone(),
        drafts: drafts.clone(),
    }];
    let (progress, events) = recorder();
    let mut attempts = 0usize;

    let reviewed = tauri::async_runtime::block_on(execute_review_plans(
        &items,
        &drafts,
        plans,
        Arc::new(AtomicBool::new(false)),
        progress,
        |_, _, _| {
            attempts += 1;
            std::future::ready(Err::<Vec<ProviderTranslation>, _>(
                ProviderFailure::Transient("provider unavailable".to_string()),
            ))
        },
    ));

    assert_eq!(reviewed, Ok(drafts));
    assert_eq!(attempts, 2);
    let events = events.lock().unwrap();
    assert!(events.contains(&ProviderProgressEvent::TransientRetry));
    assert_eq!(skipped(&events), vec![(1, ReviewSkipReason::Transient)]);
}

#[test]
fn one_failing_plan_keeps_its_draft_while_other_plans_are_reviewed() {
    let (items, drafts, plans) = two_plans();
    let (progress, events) = recorder();

    let reviewed = tauri::async_runtime::block_on(execute_review_plans(
        &items,
        &drafts,
        plans,
        Arc::new(AtomicBool::new(false)),
        progress,
        |review_items, _, _| {
            std::future::ready(if review_items[0].id == "item-0000" {
                Err(ProviderFailure::Transient("temporary".to_string()))
            } else {
                Ok(vec![translation("item-0001", "Zweiter, geprüft")])
            })
        },
    ))
    .unwrap();

    assert_eq!(reviewed[0], drafts[0]);
    assert_eq!(reviewed[1].text, "Zweiter, geprüft");
    assert_eq!(
        skipped(&events.lock().unwrap()),
        vec![(1, ReviewSkipReason::Transient)]
    );
}

#[test]
fn message_error_mid_review_aborts_without_retry_or_warning() {
    let (items, drafts, plans) = two_plans();
    let (progress, events) = recorder();
    let mut calls = Vec::new();

    let reviewed = tauri::async_runtime::block_on(execute_review_plans(
        &items,
        &drafts,
        plans,
        Arc::new(AtomicBool::new(false)),
        progress,
        |review_items, _, _| {
            calls.push(review_items[0].id.clone());
            std::future::ready(if review_items[0].id == "item-0000" {
                Ok(vec![translation("item-0000", "Erster, geprüft")])
            } else {
                Err(ProviderFailure::Message(
                    "Codex CLI is not signed in. Check its status in Settings.".to_string(),
                ))
            })
        },
    ));

    assert_eq!(
        reviewed,
        Err(ProviderFailure::Message(
            "Codex CLI is not signed in. Check its status in Settings.".to_string()
        ))
    );
    assert_eq!(calls, vec!["item-0000", "item-0001"]);
    let events = events.lock().unwrap();
    assert!(skipped(&events).is_empty());
    assert!(!events.contains(&ProviderProgressEvent::TransientRetry));
}

#[test]
fn cancellation_during_a_running_review_stops_before_the_next_plan() {
    let (items, drafts, plans) = two_plans();
    let cancelled = Arc::new(AtomicBool::new(false));
    let cancel = Arc::clone(&cancelled);
    let (progress, events) = recorder();
    let mut calls = 0usize;

    let reviewed = tauri::async_runtime::block_on(execute_review_plans(
        &items,
        &drafts,
        plans,
        Arc::clone(&cancelled),
        progress,
        |_, _, _| {
            calls += 1;
            // The user cancels while this review call is running.
            cancel.store(true, Ordering::Release);
            std::future::ready(Err::<Vec<ProviderTranslation>, _>(
                ProviderFailure::Cancelled,
            ))
        },
    ));

    assert_eq!(reviewed, Err(ProviderFailure::Cancelled));
    assert_eq!(calls, 1);
    assert!(skipped(&events.lock().unwrap()).is_empty());
}

#[test]
fn invalid_review_response_splits_the_plan_and_skips_only_the_bad_item() {
    let items = vec![
        item("item-0000", "First", 0),
        item("item-0001", "Second", 1),
    ];
    let drafts = vec![
        translation("item-0000", "Erster Entwurf"),
        translation("item-0001", "Zweiter Entwurf"),
    ];
    let plans = vec![ReviewPlan {
        items: items.clone(),
        drafts: drafts.clone(),
    }];
    let (progress, events) = recorder();
    let mut calls = Vec::new();

    let reviewed = tauri::async_runtime::block_on(execute_review_plans(
        &items,
        &drafts,
        plans,
        Arc::new(AtomicBool::new(false)),
        progress,
        |review_items, _, _| {
            let ids = review_items
                .iter()
                .map(|item| item.id.clone())
                .collect::<Vec<_>>();
            calls.push(ids.clone());
            std::future::ready(if ids == ["item-0001"] {
                Ok(vec![translation("item-0001", "Zweiter, geprüft")])
            } else {
                Err(ProviderFailure::InvalidResponse("wrong ids".to_string()))
            })
        },
    ))
    .unwrap();

    // Two attempts for the pair, two for item-0000 alone, one for item-0001.
    assert_eq!(calls.len(), 5);
    assert_eq!(reviewed[0], drafts[0]);
    assert_eq!(reviewed[1].text, "Zweiter, geprüft");
    let events = events.lock().unwrap();
    assert!(events.contains(&ProviderProgressEvent::Split));
    assert_eq!(
        skipped(&events),
        vec![(1, ReviewSkipReason::InvalidResponse)]
    );
}

#[test]
fn terminology_followup_that_newly_damages_a_token_is_rejected() {
    let mut parsnip = item("item-0000", "Parsnip for {{name}}", 0);
    parsnip.glossary_pairs = vec![("Parsnip".to_string(), "Pastinake".to_string())];
    let items = vec![parsnip];
    let reviewed = vec![translation("item-0000", "Rübe für {{name}}")];
    let plans = build_terminology_repair_plans("German", &items, &reviewed).unwrap();
    assert_eq!(plans.len(), 1);
    let mut calls = 0usize;

    let terminology = tauri::async_runtime::block_on(execute_terminology_repair_plans(
        &items,
        &reviewed,
        plans,
        Arc::new(AtomicBool::new(false)),
        super::no_progress_callback(),
        |expected, _, _, _| {
            calls += 1;
            std::future::ready(Ok(vec![translation(&expected[0].id, "Pastinake für dich")]))
        },
    ))
    .unwrap();

    assert_eq!(calls, 1);
    assert_eq!(terminology, reviewed);
}
