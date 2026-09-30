use super::super::visible_models;
use super::*;
use serde_json::json;
use std::path::PathBuf;
fn prepared_item(id: &str, source: &str) -> PreparedAiItem {
    PreparedAiItem {
        id: id.to_string(),
        identity: crate::ai::AiStringIdentity {
            mod_unique_id: "synthetic.test".to_string(),
            relative_dir: "i18n".to_string(),
            key: id.to_string(),
        },
        source: source.to_string(),
        section: Some("Synthetic fixture".to_string()),
        glossary_pairs: Vec::new(),
        context: crate::ai::AiPromptContext::isolated(0),
        default_path: PathBuf::from(r"C:\synthetic\default.json"),
        target_path: PathBuf::from(r"C:\synthetic\de.json"),
        expected_stored: None,
        expected_revision: 0,
    }
}

fn provider_translation(id: &str, text: &str) -> ProviderTranslation {
    ProviderTranslation {
        id: id.to_string(),
        text: text.to_string(),
    }
}

#[test]
fn disabled_quality_review_returns_drafts_without_entering_review() {
    let items = vec![prepared_item("item-0000", "Hello, farmer!")];
    let drafts = vec![provider_translation("item-0000", "Hallo!")];
    let cancelled = Arc::new(AtomicBool::new(true));

    let disabled = tauri::async_runtime::block_on(apply_quality_review(
        false,
        None,
        "medium".to_string(),
        "German".to_string(),
        items.clone(),
        drafts.clone(),
        Arc::clone(&cancelled),
        no_progress_callback(),
    ))
    .unwrap();
    assert_eq!(disabled, drafts);

    let enabled = tauri::async_runtime::block_on(apply_quality_review(
        true,
        None,
        "medium".to_string(),
        "German".to_string(),
        items,
        drafts,
        cancelled,
        no_progress_callback(),
    ));
    assert!(matches!(enabled, Err(ProviderFailure::Cancelled)));
}

#[test]
fn disabled_quality_review_skips_final_token_repair() {
    let items = vec![prepared_item("item-0000", "Hello, {{name}}!")];
    let drafts = vec![provider_translation("item-0000", "Hallo!")];

    let outcome = tauri::async_runtime::block_on(repair_token_mismatches_once(
        Some("--invalid-model"),
        "invalid-reasoning",
        "German",
        false,
        &items,
        &drafts,
        Arc::new(AtomicBool::new(false)),
        no_progress_callback(),
    ))
    .unwrap();

    assert_eq!(outcome.translations, drafts);
    assert!(!outcome.cancelled);
}

#[test]
fn diagnostic_model_labels_reject_paths_and_free_text() {
    assert_eq!(safe_model_for_log(None), "default");
    assert_eq!(safe_model_for_log(Some("gpt-5.6-sol")), "gpt-5.6-sol");
    assert_eq!(safe_model_for_log(Some(r"C:\private\model")), "redacted");
    assert_eq!(safe_model_for_log(Some("private model")), "redacted");
}

#[test]
fn structural_retry_prompt_uses_only_a_bounded_validator_hint() {
    let item = prepared_item("item-0000", "Hello");
    let validator_error = format!("{} SHOULD_NOT_SURVIVE", "🦀".repeat(300));
    let prompt =
        build_translation_attempt_prompt("German", &[item], Some(&validator_error)).unwrap();

    assert!(prompt.instructions.contains("structure-correction attempt"));
    assert!(!prompt.instructions.contains("SHOULD_NOT_SURVIVE"));
    assert_eq!(
        bounded_structural_hint(&validator_error).chars().count(),
        MAX_STRUCTURAL_HINT_CHARS
    );
    assert!(complete_prompt_bytes(&prompt.instructions, &prompt.input) <= ai::MAX_CHUNK_BYTES);
}

#[test]
fn initial_chunks_reserve_the_complete_utf8_structure_retry_prompt() {
    let source = "x".repeat(47 * 1024);
    let items = vec![
        prepared_item("item-0000", &source),
        prepared_item("item-0001", &source),
    ];
    let unreserved = ai::build_provider_prompt("German", &items).unwrap();
    assert!(unreserved.input.len() <= ai::MAX_CHUNK_BYTES);
    assert!(matches!(
        build_translation_attempt_prompt(
            "German",
            &items,
            Some(&"🦀".repeat(MAX_STRUCTURAL_HINT_CHARS)),
        ),
        Err(ProviderFailure::InvalidResponse(_))
    ));

    let chunks = ai::chunks(&items).unwrap();
    assert_eq!(chunks.len(), 2);
    for chunk in chunks {
        let prompt = build_translation_attempt_prompt(
            "German",
            chunk,
            Some(&"🦀".repeat(MAX_STRUCTURAL_HINT_CHARS)),
        )
        .unwrap();
        assert!(complete_prompt_bytes(&prompt.instructions, &prompt.input) <= ai::MAX_CHUNK_BYTES);
    }
}

#[test]
fn transient_and_structural_retry_budgets_are_independent_and_bounded() {
    let cancelled = Arc::new(AtomicBool::new(false));
    let mut scripted = std::collections::VecDeque::from([
        Err(ProviderFailure::Transient("temporary".to_string())),
        Err(ProviderFailure::InvalidResponse("wrong ids".to_string())),
        Ok(vec![provider_translation("item-0000", "Hallo")]),
    ]);
    let mut corrections = Vec::new();
    let mut progress = Vec::new();

    let result = tauri::async_runtime::block_on(translate_chunk_with_recovery_reporting(
        cancelled,
        |correction| {
            corrections.push(correction);
            std::future::ready(scripted.pop_front().expect("bounded attempt"))
        },
        |event| progress.push(event),
    ))
    .unwrap();

    assert_eq!(result[0].text, "Hallo");
    assert_eq!(corrections, vec![None, None, Some("wrong ids".to_string())]);
    assert_eq!(
        progress,
        [
            ProviderProgressEvent::TransientRetry,
            ProviderProgressEvent::StructureRetry
        ]
    );
    assert!(scripted.is_empty());
}

#[test]
fn repeated_same_class_failure_stops_after_its_single_retry() {
    for scripted in [
        std::collections::VecDeque::from([
            Err(ProviderFailure::Transient("first".to_string())),
            Err(ProviderFailure::Transient("second".to_string())),
        ]),
        std::collections::VecDeque::from([
            Err(ProviderFailure::InvalidResponse("first".to_string())),
            Err(ProviderFailure::InvalidResponse("second".to_string())),
        ]),
    ] {
        let cancelled = Arc::new(AtomicBool::new(false));
        let mut scripted = scripted;
        let mut attempts = 0usize;
        let result =
            tauri::async_runtime::block_on(translate_chunk_with_recovery(cancelled, |_| {
                attempts += 1;
                std::future::ready(scripted.pop_front().expect("bounded attempt"))
            }));
        assert!(result.is_err());
        assert_eq!(attempts, 2);
        assert!(scripted.is_empty());
    }
}

#[test]
fn cancellation_wins_before_a_scheduled_retry() {
    let cancelled = Arc::new(AtomicBool::new(false));
    let cancel_from_attempt = Arc::clone(&cancelled);
    let mut attempts = 0usize;
    let result = tauri::async_runtime::block_on(translate_chunk_with_recovery(cancelled, |_| {
        attempts += 1;
        cancel_from_attempt.store(true, Ordering::Release);
        std::future::ready(Err(ProviderFailure::Transient("temporary".to_string())))
    }));

    assert_eq!(result, Err(ProviderFailure::Cancelled));
    assert_eq!(attempts, 1);
}

#[test]
fn full_review_prompt_covers_every_quality_dimension_and_reuses_all_context() {
    let mut item = prepared_item("item-0000", "Parsnip soup for you, {{name}}.");
    item.section = Some("Abigail dialogue".to_string());
    item.glossary_pairs = vec![("Parsnip".to_string(), "Pastinake".to_string())];
    item.context.before.push(crate::ai::AiContextSource {
        source: "I made this myself.".to_string(),
    });
    item.context.after.push(crate::ai::AiContextSource {
        source: "Do you like it?".to_string(),
    });
    let draft = provider_translation("item-0000", "Rübensuppe für dich, {{name}}.");

    let prompt = build_review_attempt_prompt(
        "German",
        std::slice::from_ref(&item),
        std::slice::from_ref(&draft),
        Some("wrong ids"),
    )
    .unwrap();

    for required in [
        "natural language",
        "accurate meaning",
        "terminology",
        "grammar",
        "register",
        "implied speaker voice",
        "dialogue continuity",
    ] {
        assert!(prompt.instructions.contains(required), "missing {required}");
    }
    assert!(prompt.instructions.contains("every supplied draft"));
    assert!(prompt.instructions.contains("not a glossary-only check"));
    assert!(prompt.instructions.contains("omit unchanged ids"));
    assert!(prompt.instructions.contains("empty `translations` array"));
    assert!(prompt.instructions.contains("structure-correction attempt"));
    assert_eq!(prompt.schema["properties"]["translations"]["minItems"], 0);
    assert_eq!(prompt.schema["properties"]["translations"]["maxItems"], 1);
    let input: serde_json::Value = serde_json::from_str(&prompt.input).unwrap();
    let reviewed = &input["strings"][0];
    assert_eq!(reviewed["source"], item.source);
    assert_eq!(reviewed["draft"], draft.text);
    assert_eq!(reviewed["section"], "Abigail dialogue");
    assert_eq!(reviewed["glossary"][0]["target"], "Pastinake");
    let context_sources = input["contextSources"].as_array().unwrap();
    let before = reviewed["context"]["before"][0].as_u64().unwrap() as usize;
    let after = reviewed["context"]["after"][0].as_u64().unwrap() as usize;
    assert_eq!(context_sources[before], "I made this myself.");
    assert_eq!(context_sources[after], "Do you like it?");
    assert!(complete_prompt_bytes(&prompt.instructions, &prompt.input) <= ai::MAX_CHUNK_BYTES);
}

#[test]
fn review_plans_keep_context_groups_together_and_bound_retry_prompts() {
    let mut first = prepared_item("item-0000", "First");
    first.context = crate::ai::AiPromptContext::isolated(0);
    let mut second = prepared_item("item-0001", "Second");
    second.context = crate::ai::AiPromptContext::isolated(0);
    let mut third = prepared_item("item-0002", "Third");
    third.context = crate::ai::AiPromptContext::isolated(1);
    let items = vec![first, second, third];
    let drafts = vec![
        provider_translation("item-0000", &"a".repeat(15 * 1024)),
        provider_translation("item-0001", &"b".repeat(15 * 1024)),
        provider_translation("item-0002", &"c".repeat(65 * 1024)),
    ];

    let plans = build_review_plans("German", &items, &drafts).unwrap();
    let scheduled = plans
        .iter()
        .flat_map(|plan| plan.items.iter().map(|item| item.id.clone()))
        .collect::<Vec<_>>();

    assert_eq!(plans.len(), 2);
    assert_eq!(plans[0].items.len(), 2);
    assert_eq!(plans[1].items.len(), 1);
    assert_eq!(scheduled, vec!["item-0000", "item-0001", "item-0002"]);
    for plan in &plans {
        let prompt = build_review_attempt_prompt(
            "German",
            &plan.items,
            &plan.drafts,
            Some(&"🦀".repeat(MAX_STRUCTURAL_HINT_CHARS)),
        )
        .unwrap();
        assert!(complete_prompt_bytes(&prompt.instructions, &prompt.input) <= ai::MAX_CHUNK_BYTES);
    }
    assert_eq!(plans[0].drafts, drafts[..2]);
    assert_eq!(plans[1].drafts, drafts[2..]);
}

#[test]
fn review_fit_trims_only_context_and_rejects_oversized_source_or_draft() {
    let mut item = prepared_item("item-0000", "Keep this source byte-for-byte.");
    item.context.before.push(crate::ai::AiContextSource {
        source: "b".repeat(ai::MAX_CHUNK_BYTES / 2),
    });
    item.context.after.push(crate::ai::AiContextSource {
        source: "a".repeat(ai::MAX_CHUNK_BYTES / 3),
    });
    let draft_text = "d".repeat(ai::MAX_CHUNK_BYTES / 3);
    let draft = provider_translation("item-0000", &draft_text);

    let plans = build_review_plans(
        "German",
        std::slice::from_ref(&item),
        std::slice::from_ref(&draft),
    )
    .unwrap();

    assert_eq!(plans.len(), 1);
    assert_eq!(plans[0].items[0].source, item.source);
    assert_eq!(plans[0].drafts[0].text, draft_text);
    assert!(plans[0].items[0].context.before.is_empty());
    assert_eq!(plans[0].items[0].context.after.len(), 1);

    let oversized_item = prepared_item("item-0001", "Source must not be trimmed");
    let oversized_draft = provider_translation("item-0001", &"x".repeat(ai::MAX_CHUNK_BYTES));
    assert!(matches!(
        build_review_plans(
            "German",
            std::slice::from_ref(&oversized_item),
            std::slice::from_ref(&oversized_draft),
        ),
        Err(ProviderFailure::InvalidResponse(_))
    ));
}

#[test]
fn persistent_review_failure_keeps_drafts_and_cancellation_propagates() {
    let items = vec![prepared_item("item-0000", "Hello")];
    let drafts = vec![provider_translation("item-0000", "Hallo")];
    let plans = build_review_plans("German", &items, &drafts).unwrap();
    let mut attempts = 0usize;
    let failed = tauri::async_runtime::block_on(execute_review_plans(
        &items,
        &drafts,
        plans,
        Arc::new(AtomicBool::new(false)),
        no_progress_callback(),
        |_, _, _| {
            attempts += 1;
            std::future::ready(Err::<Vec<ProviderTranslation>, _>(
                ProviderFailure::InvalidResponse("wrong ids".to_string()),
            ))
        },
    ));

    assert_eq!(failed, Ok(drafts.clone()));
    assert_eq!(attempts, 2);

    let cancelled = Arc::new(AtomicBool::new(true));
    let mut cancelled_calls = 0usize;
    let cancellation = tauri::async_runtime::block_on(execute_review_plans(
        &items,
        &drafts,
        build_review_plans("German", &items, &drafts).unwrap(),
        cancelled,
        no_progress_callback(),
        |_, _, _| {
            cancelled_calls += 1;
            std::future::ready(Ok(Vec::new()))
        },
    ));
    assert_eq!(cancellation, Err(ProviderFailure::Cancelled));
    assert_eq!(cancelled_calls, 0);
}

#[test]
fn sparse_review_merges_changes_by_identity_and_retains_omitted_drafts() {
    let mut first = prepared_item("item-0000", "First");
    first.context = crate::ai::AiPromptContext::isolated(0);
    let mut second = prepared_item("item-0001", "Second");
    second.context = crate::ai::AiPromptContext::isolated(0);
    let mut third = prepared_item("item-0002", "Third");
    third.context = crate::ai::AiPromptContext::isolated(0);
    let items = vec![first, second, third];
    let drafts = vec![
        provider_translation("item-0000", "Erster Entwurf"),
        provider_translation("item-0001", "Zweiter Entwurf"),
        provider_translation("item-0002", "Dritter Entwurf"),
    ];
    let plans = build_review_plans("German", &items, &drafts).unwrap();
    let mut calls = 0usize;

    let reviewed = tauri::async_runtime::block_on(execute_review_plans(
        &items,
        &drafts,
        plans,
        Arc::new(AtomicBool::new(false)),
        no_progress_callback(),
        |_, _, _| {
            calls += 1;
            std::future::ready(Ok(vec![provider_translation(
                "item-0001",
                "Korrigierter zweiter Entwurf",
            )]))
        },
    ))
    .unwrap();

    assert_eq!(calls, 1);
    assert_eq!(reviewed[0], drafts[0]);
    assert_eq!(reviewed[1].text, "Korrigierter zweiter Entwurf");
    assert_eq!(reviewed[2], drafts[2]);
}

#[test]
fn empty_sparse_review_keeps_every_draft_without_retry() {
    let items = vec![prepared_item("item-0000", "Hello")];
    let drafts = vec![provider_translation("item-0000", "Hallo")];
    let plans = build_review_plans("German", &items, &drafts).unwrap();
    let mut calls = 0usize;

    let reviewed = tauri::async_runtime::block_on(execute_review_plans(
        &items,
        &drafts,
        plans,
        Arc::new(AtomicBool::new(false)),
        no_progress_callback(),
        |_, _, _| {
            calls += 1;
            std::future::ready(Ok(Vec::new()))
        },
    ))
    .unwrap();

    assert_eq!(calls, 1);
    assert_eq!(reviewed, drafts);
}

#[test]
fn review_token_damage_is_rejected_and_keeps_the_draft() {
    let items = vec![prepared_item("item-0000", "Hello, {{name}}.")];
    let drafts = vec![provider_translation("item-0000", "Hallo, {{name}}.")];
    let plans = build_review_plans("German", &items, &drafts).unwrap();

    let reviewed = tauri::async_runtime::block_on(execute_review_plans(
        &items,
        &drafts,
        plans,
        Arc::new(AtomicBool::new(false)),
        no_progress_callback(),
        |_, _, _| {
            std::future::ready(Ok(vec![provider_translation(
                "item-0000",
                "Eine natürlichere Begrüßung.",
            )]))
        },
    ))
    .unwrap();

    assert_eq!(reviewed, drafts);
    assert!(build_token_repair_plans("German", &items, &reviewed)
        .unwrap()
        .is_empty());
}

#[test]
fn full_review_runs_without_glossary_and_schedules_no_terminology_repair() {
    let items = vec![prepared_item("item-0000", "This sounds awkward.")];
    let drafts = vec![provider_translation("item-0000", "Dies klingt unbeholfen.")];
    let plans = build_review_plans("German", &items, &drafts).unwrap();
    let mut review_calls = 0usize;

    let reviewed = tauri::async_runtime::block_on(execute_review_plans(
        &items,
        &drafts,
        plans,
        Arc::new(AtomicBool::new(false)),
        no_progress_callback(),
        |review_items, _, _| {
            review_calls += 1;
            std::future::ready(Ok(vec![provider_translation(
                &review_items[0].id,
                "Das klingt unnatürlich.",
            )]))
        },
    ))
    .unwrap();
    let terminology = build_terminology_repair_plans("German", &items, &reviewed).unwrap();

    assert_eq!(review_calls, 1);
    assert_eq!(reviewed[0].text, "Das klingt unnatürlich.");
    assert!(terminology.is_empty());
}

#[test]
fn terminology_prompt_is_conservative_exact_and_bounded() {
    let mut item = prepared_item("item-0000", "A parsnip is ready.");
    item.glossary_pairs = vec![("Parsnip".to_string(), "Pastinake".to_string())];
    let items = vec![item.clone()];
    let translations = vec![provider_translation("item-0000", "Eine Rübe ist fertig.")];

    assert_eq!(
        conservative_glossary_candidates(&item, &translations[0].text),
        item.glossary_pairs
    );
    assert!(conservative_glossary_candidates(&item, "Pastinakenernte ist fertig.").is_empty());

    let mut plans = build_terminology_repair_plans("German", &items, &translations).unwrap();
    assert_eq!(plans.len(), 1);
    let plan = plans.pop().unwrap();
    let prompt = build_terminology_repair_attempt_prompt(
        "German",
        &plan.items,
        &plan.translations,
        &plan.findings,
        None,
    )
    .unwrap();
    let input: serde_json::Value = serde_json::from_str(&prompt.input).unwrap();
    let strings = input["strings"].as_array().unwrap();
    let lower_instructions = prompt.instructions.to_ascii_lowercase();

    assert_eq!(plan.items.len(), 1);
    assert_eq!(plan.items[0].id, "item-0000");
    assert_eq!(strings.len(), 1);
    assert_eq!(strings[0]["terminologyFindings"][0]["source"], "Parsnip");
    assert_eq!(strings[0]["terminologyFindings"][0]["target"], "Pastinake");
    assert!(strings[0].get("glossary").is_none());
    assert_eq!(
        strings[0]["terminologyFindings"][0]["kind"],
        "glossaryTargetNotDetected"
    );
    assert!(lower_instructions.contains("conservative candidates"));
    assert!(!lower_instructions.contains("official"));
    assert!(!lower_instructions.contains("high-confidence"));
    assert!(prompt.instructions.contains("returned unchanged"));
    assert!(prompt
        .instructions
        .contains("Do not add, remove, reorder, translate, or alter those tokens."));
    assert!(prompt
        .instructions
        .contains("Gender-switch blocks `${...}$` contain translatable branch prose."));
    assert!(prompt
        .instructions
        .contains("Preserve every existing quote character EXACTLY."));
    assert!(prompt.instructions.contains("Keep the same line breaks."));
    let correction = build_terminology_repair_attempt_prompt(
        "German",
        &plan.items,
        &plan.translations,
        &plan.findings,
        Some("wrong ids"),
    )
    .unwrap();
    assert!(correction
        .instructions
        .contains("structure-correction attempt"));
    assert!(correction
        .instructions
        .contains("single focused terminology-repair phase"));
    assert_eq!(correction.input, prompt.input);
    assert!(
        complete_prompt_bytes(&correction.instructions, &correction.input) <= ai::MAX_CHUNK_BYTES
    );
}

#[test]
fn terminology_plans_split_and_bound_retry_prompts() {
    let mut items = vec![
        prepared_item("item-0000", "Parsnip one"),
        prepared_item("item-0001", "Parsnip two"),
        prepared_item("item-0002", "Parsnip three"),
    ];
    for item in &mut items {
        item.glossary_pairs = vec![("Parsnip".to_string(), "Pastinake".to_string())];
    }
    let large = "x".repeat(ai::MAX_CHUNK_BYTES / 3);
    let translations = items
        .iter()
        .map(|item| provider_translation(&item.id, &large))
        .collect::<Vec<_>>();

    let plans = build_terminology_repair_plans("German", &items, &translations).unwrap();
    let scheduled = plans
        .iter()
        .flat_map(|plan| plan.items.iter().map(|item| item.id.clone()))
        .collect::<Vec<_>>();

    assert!(plans.len() >= 2);
    assert_eq!(scheduled, vec!["item-0000", "item-0001", "item-0002"]);
    for plan in &plans {
        let prompt = build_terminology_repair_attempt_prompt(
            "German",
            &plan.items,
            &plan.translations,
            &plan.findings,
            Some(&"🦀".repeat(MAX_STRUCTURAL_HINT_CHARS)),
        )
        .unwrap();
        assert!(complete_prompt_bytes(&prompt.instructions, &prompt.input) <= ai::MAX_CHUNK_BYTES);
    }
}

#[test]
fn terminology_repair_has_independent_bounded_transient_and_structure_retries() {
    let mut item = prepared_item("item-0000", "Parsnip");
    item.glossary_pairs = vec![("Parsnip".to_string(), "Pastinake".to_string())];
    let items = vec![item];
    let reviewed = vec![provider_translation("item-0000", "Rübe")];
    let plans = build_terminology_repair_plans("German", &items, &reviewed).unwrap();
    let mut scripted = std::collections::VecDeque::from([
        Err(ProviderFailure::Transient("temporary".to_string())),
        Err(ProviderFailure::InvalidResponse("wrong ids".to_string())),
        Ok(vec![provider_translation("item-0000", "Pastinake")]),
    ]);
    let mut corrections = Vec::new();

    let outcome = tauri::async_runtime::block_on(execute_terminology_repair_plans(
        &items,
        &reviewed,
        plans,
        Arc::new(AtomicBool::new(false)),
        no_progress_callback(),
        |_, _, _, structural_error| {
            corrections.push(structural_error);
            std::future::ready(scripted.pop_front().expect("bounded attempt"))
        },
    ))
    .unwrap();

    assert_eq!(outcome[0].text, "Pastinake");
    assert_eq!(corrections, vec![None, None, Some("wrong ids".to_string())]);
    assert!(scripted.is_empty());
}

#[test]
fn persistent_invalid_terminology_repair_is_bisected_without_resending_successes() {
    let mut items = vec![
        prepared_item("item-0000", "Parsnip one"),
        prepared_item("item-0001", "Parsnip two"),
    ];
    for item in &mut items {
        item.glossary_pairs = vec![("Parsnip".to_string(), "Pastinake".to_string())];
    }
    let reviewed = vec![
        provider_translation("item-0000", "Rübe eins"),
        provider_translation("item-0001", "Rübe zwei"),
    ];
    let plans = build_terminology_repair_plans("German", &items, &reviewed).unwrap();
    assert_eq!(plans.len(), 1);
    let mut calls = Vec::new();

    let outcome = tauri::async_runtime::block_on(execute_terminology_repair_plans(
        &items,
        &reviewed,
        plans,
        Arc::new(AtomicBool::new(false)),
        no_progress_callback(),
        |repair_items, _, _, _| {
            let ids = repair_items
                .iter()
                .map(|item| item.id.clone())
                .collect::<Vec<_>>();
            calls.push(ids.clone());
            let result = if ids.len() > 1 || ids[0] == "item-0000" {
                Err(ProviderFailure::InvalidResponse("wrong ids".to_string()))
            } else {
                Ok(vec![provider_translation("item-0001", "Pastinake zwei")])
            };
            std::future::ready(result)
        },
    ))
    .unwrap();

    assert_eq!(calls.len(), 5);
    assert_eq!(
        calls
            .iter()
            .filter(|ids| ids.as_slice() == ["item-0001".to_string()])
            .count(),
        1
    );
    assert_eq!(outcome[0], reviewed[0]);
    assert_eq!(outcome[1].text, "Pastinake zwei");

    let cancellation = tauri::async_runtime::block_on(execute_terminology_repair_plans(
        &items,
        &reviewed,
        build_terminology_repair_plans("German", &items, &reviewed).unwrap(),
        Arc::new(AtomicBool::new(false)),
        no_progress_callback(),
        |_, _, _, _| {
            std::future::ready(Err::<Vec<ProviderTranslation>, _>(
                ProviderFailure::Cancelled,
            ))
        },
    ));
    assert_eq!(cancellation, Err(ProviderFailure::Cancelled));
}

#[test]
fn existing_token_damage_reaches_failed_final_repair_as_blocking_diff() {
    let mut item = prepared_item("item-0000", "Parsnip for {{name}}");
    item.glossary_pairs = vec![("Parsnip".to_string(), "Pastinake".to_string())];
    let items = vec![item];
    // The reviewed draft already lacks {{name}}, so the terminology fix adds
    // no new mismatch and is accepted; the old damage still needs repair.
    let reviewed = vec![provider_translation("item-0000", "Rübe für dich")];
    let plans = build_terminology_repair_plans("German", &items, &reviewed).unwrap();
    let mut calls = 0usize;

    let terminology = tauri::async_runtime::block_on(execute_terminology_repair_plans(
        &items,
        &reviewed,
        plans,
        Arc::new(AtomicBool::new(false)),
        no_progress_callback(),
        |expected, _, _, _| {
            calls += 1;
            std::future::ready(Ok(vec![provider_translation(
                &expected[0].id,
                "Pastinake für dich",
            )]))
        },
    ))
    .unwrap();

    assert_eq!(calls, 1);
    assert_eq!(terminology[0].text, "Pastinake für dich");

    let token_plans = build_token_repair_plans("German", &items, &terminology).unwrap();
    assert_eq!(token_plans.len(), 1);
    let token_outcome = tauri::async_runtime::block_on(execute_token_repair_plans(
        &items,
        &terminology,
        token_plans,
        Arc::new(AtomicBool::new(false)),
        no_progress_callback(),
        |_, _| {
            std::future::ready(Err::<Vec<ProviderTranslation>, _>(
                ProviderFailure::Transient("temporary".to_string()),
            ))
        },
    ))
    .unwrap();
    assert!(!token_outcome.cancelled);
    assert_eq!(token_outcome.translations, terminology);
    let suggestions = ai::suggestions(&items, token_outcome.translations).unwrap();
    assert!(!suggestions[0].token_differences.is_empty());
}

#[test]
fn token_repair_plan_contains_only_affected_ids_and_concrete_counts() {
    let items = vec![
        prepared_item("item-0000", "Hello {{name}}"),
        prepared_item("item-0001", "Plain source"),
    ];
    let translations = vec![
        provider_translation("item-0000", "Hallo {{other}}"),
        provider_translation("item-0001", "Einfacher Text"),
    ];

    let mut plans = build_token_repair_plans("German", &items, &translations).unwrap();
    assert_eq!(plans.len(), 1);
    let plan = plans.pop().unwrap();
    let input: serde_json::Value = serde_json::from_str(&plan.prompt.input).unwrap();
    let strings = input["strings"].as_array().unwrap();

    assert_eq!(plan.items.len(), 1);
    assert_eq!(plan.items[0].id, "item-0000");
    assert_eq!(strings.len(), 1);
    assert_eq!(strings[0]["id"], "item-0000");
    assert_eq!(strings[0]["source"], "Hello {{name}}");
    assert_eq!(strings[0]["translation"], "Hallo {{other}}");
    assert_eq!(strings[0]["tokenDifferences"].as_array().unwrap().len(), 2);
    assert!(plan
        .prompt
        .instructions
        .contains("gender-switch shape descriptors, not literal empty text"));
    assert_eq!(
        plan.prompt.schema["properties"]["translations"]["minItems"],
        1
    );
    assert!(!plan.prompt.input.contains("Plain source"));
    assert!(
        complete_prompt_bytes(&plan.prompt.instructions, &plan.prompt.input) <= ai::MAX_CHUNK_BYTES
    );
}

#[test]
fn token_repair_plans_split_by_serialized_size_and_schedule_each_item_once() {
    let items = vec![
        prepared_item("item-0000", "Hello {{name}}"),
        prepared_item("item-0001", "Hello {{name}}"),
        prepared_item("item-0002", "Hello {{name}}"),
    ];
    let large = "x".repeat(ai::MAX_CHUNK_BYTES / 2);
    let translations = vec![
        provider_translation("item-0000", &large),
        provider_translation("item-0001", &large),
        provider_translation("item-0002", "Kurz"),
    ];

    let plans = build_token_repair_plans("German", &items, &translations).unwrap();
    let scheduled = plans
        .iter()
        .flat_map(|plan| plan.items.iter().map(|item| item.id.as_str()))
        .collect::<Vec<_>>();

    assert!(plans.len() >= 2);
    assert!(plans.iter().all(|plan| complete_prompt_bytes(
        &plan.prompt.instructions,
        &plan.prompt.input
    ) <= ai::MAX_CHUNK_BYTES));
    assert_eq!(scheduled, vec!["item-0000", "item-0001", "item-0002"]);
}

#[test]
fn token_repair_merge_replaces_only_fully_valid_repairs() {
    let items = vec![
        prepared_item("item-0000", "Hello {{name}}"),
        prepared_item("item-0001", "Count {0}"),
    ];
    let originals = vec![
        provider_translation("item-0000", "Hallo"),
        provider_translation("item-0001", "Anzahl"),
    ];
    let repairs = vec![
        provider_translation("item-0000", "Hallo {{name}}"),
        provider_translation("item-0001", "Noch immer ohne Token"),
    ];

    let merged = merge_valid_token_repairs(&items, &originals, &items, repairs);

    assert_eq!(merged[0].text, "Hallo {{name}}");
    assert_eq!(merged[1].text, "Anzahl");
}

#[test]
fn individually_oversized_token_repair_is_skipped_and_keeps_its_original() {
    let items = vec![prepared_item("item-0000", "Hello {{name}}")];
    let instructions = token_repair_instructions("German");
    let translation =
        "x".repeat(ai::MAX_CHUNK_BYTES - instructions.len() - PROMPT_INPUT_SEPARATOR.len());
    let translations = vec![provider_translation("item-0000", &translation)];
    let differences = crate::tokens::token_differences(&items[0].source, &translation);
    let input = serialize_token_repair_input(&[serde_json::json!({
        "id": items[0].id,
        "source": items[0].source,
        "translation": translation,
        "tokenDifferences": differences.iter().map(|difference| serde_json::json!({
            "token": difference.token,
            "sourceCount": difference.source_count,
            "targetCount": difference.target_count,
        })).collect::<Vec<_>>(),
    })])
    .unwrap();

    assert!(input.len() <= ai::MAX_CHUNK_BYTES);
    assert!(complete_prompt_bytes(&instructions, &input) > ai::MAX_CHUNK_BYTES);

    let plans = build_token_repair_plans("German", &items, &translations).unwrap();

    assert!(plans.is_empty());
}

#[test]
fn failed_token_repair_sub_batch_keeps_its_original_and_later_plans_continue() {
    let items = vec![
        prepared_item("item-0000", "Hello {{name}}"),
        prepared_item("item-0001", "Hello {{name}}"),
    ];
    let large = "x".repeat(ai::MAX_CHUNK_BYTES / 2);
    let originals = vec![
        provider_translation("item-0000", &large),
        provider_translation("item-0001", &large),
    ];
    let plans = build_token_repair_plans("German", &items, &originals).unwrap();
    assert_eq!(plans.len(), 2);
    let mut calls = 0usize;

    let outcome = tauri::async_runtime::block_on(execute_token_repair_plans(
        &items,
        &originals,
        plans,
        Arc::new(AtomicBool::new(false)),
        no_progress_callback(),
        |_, expected| {
            calls += 1;
            let result = if calls == 1 {
                Err(ProviderFailure::Transient("temporary".to_string()))
            } else {
                Ok(expected
                    .iter()
                    .map(|item| provider_translation(&item.id, "Repaired {{name}}"))
                    .collect())
            };
            std::future::ready(result)
        },
    ))
    .unwrap();

    assert_eq!(calls, 2);
    assert!(!outcome.cancelled);
    assert_eq!(outcome.translations[0].text, large);
    assert_eq!(outcome.translations[1].text, "Repaired {{name}}");
}

#[test]
fn cancellation_returns_repairs_completed_by_earlier_sub_batches() {
    let items = vec![
        prepared_item("item-0000", "Hello {{name}}"),
        prepared_item("item-0001", "Hello {{name}}"),
    ];
    let large = "x".repeat(ai::MAX_CHUNK_BYTES / 2);
    let originals = vec![
        provider_translation("item-0000", &large),
        provider_translation("item-0001", &large),
    ];
    let plans = build_token_repair_plans("German", &items, &originals).unwrap();
    let mut calls = 0usize;

    let outcome = tauri::async_runtime::block_on(execute_token_repair_plans(
        &items,
        &originals,
        plans,
        Arc::new(AtomicBool::new(false)),
        no_progress_callback(),
        |_, expected| {
            calls += 1;
            let result = if calls == 1 {
                Ok(expected
                    .iter()
                    .map(|item| provider_translation(&item.id, "Repaired {{name}}"))
                    .collect())
            } else {
                Err(ProviderFailure::Cancelled)
            };
            std::future::ready(result)
        },
    ))
    .unwrap();

    assert_eq!(calls, 2);
    assert!(outcome.cancelled);
    assert_eq!(outcome.translations[0].text, "Repaired {{name}}");
    assert_eq!(outcome.translations[1].text, large);
}

#[test]
fn model_catalog_uses_account_models_and_advertised_reasoning() {
    let body = json!({"models":[{"slug":"account-model","display_name":"Account model","visibility":"list","supported_reasoning_levels":[{"effort":"low"},{"effort":"high"}]},{"slug":"hidden-model","visibility":"hidden"},{"slug":"bad model","visibility":"list"}]});
    let models = visible_models(&body).unwrap();
    assert_eq!(models.len(), 1);
    assert_eq!(models[0].model, "account-model");
    assert!(models[0].is_default);
    assert_eq!(models[0].supported_reasoning_efforts, vec!["low", "high"]);
    assert!(visible_models(&json!({"data":[]})).is_err());
}
#[test]
fn cancellation_prevents_authentication_and_inference_start() {
    let prompt =
        ai::build_provider_prompt("German", &[prepared_item("item-0000", "Hello")]).unwrap();
    let result = tauri::async_runtime::block_on(run_prompt(
        None,
        "medium".into(),
        prompt,
        Arc::new(AtomicBool::new(true)),
        no_progress_callback(),
    ));
    assert_eq!(result, Err(ProviderFailure::Cancelled));
}
