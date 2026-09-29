//! Kept in a separate file so the tests can also be run against `main`'s
//! `codex_cli.rs` (with only this module declaration added).

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use super::{
    build_review_plans, execute_review_plans, merge_followup, CodexProgressCallback,
    PreparedAiItem, ProviderFailure, ProviderTranslation,
};

fn item(id: &str, source: &str) -> PreparedAiItem {
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
        context: crate::ai::AiPromptContext::isolated(0),
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

#[test]
fn permanent_review_failure_keeps_drafts_and_reports_a_warning() {
    let items = vec![item("item-0000", "Hello, {{name}}.")];
    let drafts = vec![translation("item-0000", "Hallo, {{name}}.")];
    let plans = build_review_plans("German", &items, &drafts).unwrap();
    let events = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&events);
    // Events are compared by their Debug form so this file also compiles
    // against a codex_cli.rs without the warning event.
    let progress: CodexProgressCallback =
        Arc::new(move |event| recorded.lock().unwrap().push(format!("{event:?}")));

    let reviewed = tauri::async_runtime::block_on(execute_review_plans(
        &items,
        &drafts,
        plans,
        Arc::new(AtomicBool::new(false)),
        progress,
        |_, _, _| {
            std::future::ready(Err::<Vec<ProviderTranslation>, _>(
                ProviderFailure::Transient("provider unavailable".to_string()),
            ))
        },
    ));

    assert_eq!(reviewed, Ok(drafts));
    let events = events.lock().unwrap();
    assert!(events.iter().any(|event| event == "TransientRetry"));
    assert!(events
        .iter()
        .any(|event| event == "ReviewSkipped { item_count: 1 }"));
}

#[test]
fn merge_followup_rejects_new_token_mismatches_and_accepts_clean_followups() {
    let items = vec![
        item("item-0000", "Hello, {{name}}."),
        item("item-0001", "You have {0} coins."),
    ];
    let previous = vec![
        translation("item-0000", "Hallo, {{name}}."),
        translation("item-0001", "Du hast {0} Münzen."),
    ];

    let merged = merge_followup(
        &items,
        &previous,
        vec![
            // Drops {{name}}: a new mismatch, so the previous draft stays.
            translation("item-0000", "Hallo, Bauer."),
            // Keeps {0}: clean, so it is accepted.
            translation("item-0001", "Du besitzt {0} Münzen."),
        ],
    );

    assert_eq!(merged[0], previous[0]);
    assert_eq!(merged[1].text, "Du besitzt {0} Münzen.");
}

#[test]
fn merge_followup_accepts_a_followup_that_keeps_an_existing_mismatch() {
    let items = vec![item("item-0000", "Hello, {{name}}.")];
    let previous = vec![translation("item-0000", "Hallo.")];

    let merged = merge_followup(
        &items,
        &previous,
        vec![translation("item-0000", "Hallo zusammen.")],
    );

    assert_eq!(merged[0].text, "Hallo zusammen.");
}
