//! Token-count rules for `merge_followup`. Self-contained so the tests can
//! also be run against earlier versions of `chatgpt.rs`.

use std::path::PathBuf;

use super::{merge_followup, PreparedAiItem, ProviderTranslation};

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

/// Merge one follow-up for a single item and return the resulting text.
fn merged_text(source: &str, previous: &str, candidate: &str) -> String {
    let items = vec![item("item-0000", source)];
    let previous = vec![translation("item-0000", previous)];
    merge_followup(&items, &previous, vec![translation("item-0000", candidate)])
        .remove(0)
        .text
}

const TWO_ZEROS: &str = "{0} gave {0} coins.";

#[test]
fn clean_followup_is_accepted_and_new_damage_is_rejected() {
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
            translation("item-0000", "Hallo, Bauer."),
            translation("item-0001", "Du besitzt {0} Münzen."),
        ],
    );

    assert_eq!(merged[0], previous[0]);
    assert_eq!(merged[1].text, "Du besitzt {0} Münzen.");
}

#[test]
fn multi_occurrence_token_losing_its_last_occurrence_is_rejected() {
    // Source 2x {0}, previous 1x, candidate 0x: the count gets worse.
    assert_eq!(
        merged_text(TWO_ZEROS, "{0} gab Münzen.", "Er gab Münzen."),
        "{0} gab Münzen."
    );
}

#[test]
fn multi_occurrence_token_overshooting_further_is_rejected() {
    // Source 2x {0}. Previous 1x (distance 1), candidate 4x (distance 2).
    assert_eq!(
        merged_text(TWO_ZEROS, "{0} gab Münzen.", "{0} gab {0} {0} {0} Münzen."),
        "{0} gab Münzen."
    );
    // Previous 3x (distance 1), candidate 4x (distance 2).
    assert_eq!(
        merged_text(
            TWO_ZEROS,
            "{0} gab {0} {0} Münzen.",
            "{0} {0} gab {0} {0} Münzen."
        ),
        "{0} gab {0} {0} Münzen."
    );
    // Previous 1x and candidate 3x are equally far from 2x: not worse.
    assert_eq!(
        merged_text(TWO_ZEROS, "{0} gab Münzen.", "{0} gab {0} {0} Münzen."),
        "{0} gab {0} {0} Münzen."
    );
}

#[test]
fn new_foreign_token_is_rejected_unless_previous_had_as_many() {
    assert_eq!(
        merged_text("Hello.", "Hallo.", "Hallo, {{name}}."),
        "Hallo."
    );
    assert_eq!(
        merged_text("Hello.", "Hallo, {{name}}.", "Hallo du, {{name}}."),
        "Hallo du, {{name}}."
    );
}

#[test]
fn followup_that_improves_or_keeps_a_miscount_is_accepted() {
    // Improves: 1x -> 2x matches the source.
    assert_eq!(
        merged_text(TWO_ZEROS, "{0} gab Münzen.", "{0} gab {0} Münzen."),
        "{0} gab {0} Münzen."
    );
    // Keeps: still 1x, other wording.
    assert_eq!(
        merged_text(TWO_ZEROS, "{0} gab Münzen.", "{0} schenkte Münzen."),
        "{0} schenkte Münzen."
    );
    // Keeps an existing missing token.
    assert_eq!(
        merged_text("Hello, {{name}}.", "Hallo.", "Hallo zusammen."),
        "Hallo zusammen."
    );
}
