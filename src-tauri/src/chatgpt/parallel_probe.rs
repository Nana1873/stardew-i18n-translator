//! Opt-in provider experiment. Uses the app's real ChatGPT pipeline and an
//! exclusively owned, already signed-in synthetic test profile.
use super::*;
use crate::{chatgpt::models, chatgpt_auth};
use futures_util::{stream, StreamExt};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, path::PathBuf, sync::Mutex, time::Duration};

const MODEL: &str = "gpt-6.1-sol";
const REASONING: &str = "medium";
const BATCH_COUNT: usize = 4;
const COPIED_MOD_ITEMS_PER_BATCH: usize = 75;

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Metrics {
    attempts: usize,
    transient_retries: usize,
    structure_retries: usize,
    splits: usize,
    review_skipped: usize,
    token_repair_items: usize,
    terminology_repair_items: usize,
    input_tokens: u64,
    cached_input_tokens: u64,
    output_tokens: u64,
    reasoning_output_tokens: u64,
    response_intervals_ms: Vec<(u64, u64)>,
    #[serde(skip)]
    response_started: Option<u64>,
}

impl Metrics {
    fn event(&mut self, event: ProviderProgressEvent, elapsed: u64) {
        match event {
            ProviderProgressEvent::Activity(ProviderActivity::Starting) => {
                self.attempts += 1;
                self.response_started = Some(elapsed);
            }
            ProviderProgressEvent::Activity(
                ProviderActivity::Completed | ProviderActivity::Failed,
            ) => self.finish_response(elapsed),
            ProviderProgressEvent::Usage(usage) => {
                self.input_tokens += usage.input_tokens;
                self.cached_input_tokens += usage.cached_input_tokens;
                self.output_tokens += usage.output_tokens;
                self.reasoning_output_tokens += usage.reasoning_output_tokens;
            }
            ProviderProgressEvent::TransientRetry => self.transient_retries += 1,
            ProviderProgressEvent::StructureRetry => self.structure_retries += 1,
            ProviderProgressEvent::Split => self.splits += 1,
            ProviderProgressEvent::ReviewSkipped { item_count, .. } => {
                self.review_skipped += item_count;
            }
            ProviderProgressEvent::Phase {
                phase: ProviderPhase::TokenRepair,
                item_count,
            } => {
                self.token_repair_items += item_count;
            }
            ProviderProgressEvent::Phase {
                phase: ProviderPhase::TerminologyRepair,
                item_count,
            } => {
                self.terminology_repair_items += item_count;
            }
            _ => {}
        }
    }

    fn finish_response(&mut self, elapsed: u64) {
        if let Some(started) = self.response_started.take() {
            self.response_intervals_ms.push((started, elapsed));
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BatchResult {
    batch: usize,
    started_ms: u64,
    finished_ms: u64,
    outcome: &'static str,
    suggestions: Vec<ai::AiSuggestion>,
    metrics: Metrics,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RunResult {
    round: usize,
    concurrency: usize,
    duration_ms: u64,
    max_overlapping_requests: usize,
    valid: bool,
    batches: Vec<BatchResult>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Comparison {
    schema_version: u32,
    model: &'static str,
    reasoning: &'static str,
    quality_review: bool,
    model_advertised: bool,
    target_language: String,
    glossary_pairs: usize,
    fixture_kind: &'static str,
    source_sha256: Option<String>,
    total_strings: usize,
    token_rows: usize,
    distinct_protected_tokens: BTreeSet<String>,
    rows_with_neighbor_context: usize,
    batch_sizes: Vec<usize>,
    prompt_bytes: Vec<usize>,
    batch_count: usize,
    items_per_batch: usize,
    fixture: Vec<Vec<String>>,
    runs: Vec<RunResult>,
}

fn millis(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

fn fixture() -> Vec<Vec<PreparedAiItem>> {
    let sources = [
        "Good morning, {{name}}! The parsnips are ready to harvest.",
        "I left a basket of fresh fruit by your front door.",
        "The rain sounds lovely against the greenhouse roof.",
        "Would you join me for a walk along the river tonight?",
        "I tried baking a pie. Let's call it a learning experience.",
        "Thank you for listening. Today has been a little difficult.",
        "Please bring {{count}} pieces of wood to the old workshop.",
        "The festival begins at noon. Don't forget your sun hat!",
        "That was a brave choice, even if it didn't work out.",
        "The flowers by the fence remind me of our first spring here.",
        "Someone moved my fishing rod again. Very funny, {{name}}.",
        "Take your time. The farm will still be here tomorrow.",
    ];
    (0..BATCH_COUNT)
        .map(|batch| {
            sources
                .iter()
                .enumerate()
                .map(|(index, source)| {
                    let id = format!("batch-{batch}-item-{index}");
                    PreparedAiItem {
                        identity: ai::AiStringIdentity {
                            mod_unique_id: "synthetic.parallel-probe".into(),
                            relative_dir: "i18n".into(),
                            key: id.clone(),
                        },
                        id,
                        source: (*source).into(),
                        section: Some("Synthetic village dialogue".into()),
                        glossary_pairs: if index == 0 {
                            vec![("parsnip".into(), "Pastinake".into())]
                        } else {
                            Vec::new()
                        },
                        context: ai::AiPromptContext::isolated(batch),
                        default_path: PathBuf::from("synthetic/default.json"),
                        target_path: PathBuf::from("synthetic/de.json"),
                        expected_stored: None,
                        expected_revision: 0,
                    }
                })
                .collect()
        })
        .collect()
}

fn copied_mod_fixture(source: &std::path::Path) -> Result<Vec<Vec<PreparedAiItem>>, String> {
    copied_mod_fixture_with_options(source, COPIED_MOD_ITEMS_PER_BATCH, &[])
}

fn copied_mod_fixture_with_options(
    source: &std::path::Path,
    batch_size: usize,
    glossary: &[(String, String)],
) -> Result<Vec<Vec<PreparedAiItem>>, String> {
    // Inputs are an ignored temporary copy. No target language file or saved
    // user state is loaded, so this measures a complete translation from scratch.
    let body = crate::input_limits::read_json_text(source)?;
    let object = crate::scanner::parse_flat_object(&body, source)?;
    let sections = crate::scanner::extract_sections(&body);
    let parent = source
        .parent()
        .ok_or("The copied source needs a parent folder.")?;
    let rows = object
        .iter()
        .filter_map(|(key, value)| {
            let text = value.as_str()?;
            (!text.trim().is_empty()).then(|| ai::AiScopeRow {
                identity: ai::AiStringIdentity {
                    mod_unique_id: "parallel-probe.copied-mod".into(),
                    relative_dir: "i18n".into(),
                    key: key.clone(),
                },
                source: text.into(),
                section: sections.get(&crate::scanner::folded_key(key)).cloned(),
                status: "untranslated".into(),
                default_path: source.to_path_buf(),
                target_path: parent.join("de.json"),
                expected_stored: None,
                expected_revision: 0,
            })
        })
        .collect::<Vec<_>>();
    let prepared = ai::prepare_items_with_context(&rows, &rows, |source| {
        let source = source.to_lowercase();
        glossary
            .iter()
            .filter(|(term, _)| source.contains(&term.to_lowercase()))
            .cloned()
            .collect()
    })?;
    let batches = prepared
        .chunks(batch_size)
        .map(|items| items.to_vec())
        .collect::<Vec<_>>();
    if batches.is_empty() {
        return Err("The copied mod has no eligible strings.".into());
    }
    for items in &batches {
        build_translation_attempt_prompt("German", items, None).map_err(chatgpt_auth::message)?;
    }
    Ok(batches)
}

fn failure_category(failure: &ProviderFailure) -> &'static str {
    match failure {
        ProviderFailure::Cancelled => "cancelled",
        ProviderFailure::Transient(_) => "transient_error",
        ProviderFailure::InvalidResponse(_) => "invalid_response",
        ProviderFailure::Message(_) => "provider_error",
    }
}

async fn run_batch(
    items: &[PreparedAiItem],
    batch: usize,
    started: Instant,
    pipeline_timeout: Duration,
    target_language: &str,
) -> BatchResult {
    let started_ms = millis(started);
    let metrics = Arc::new(Mutex::new(Metrics::default()));
    let captured = Arc::clone(&metrics);
    let progress: ProviderProgressCallback = Arc::new(move |event| {
        captured.lock().unwrap().event(event, millis(started));
    });
    let cancelled = Arc::new(AtomicBool::new(false));
    // The experiment bounds each complete translate/review/repair pipeline,
    // while retaining the provider's existing per-attempt timeout/recovery.
    let translated = tokio::time::timeout(pipeline_timeout, async {
        let drafts = translate_chunk(
            Some(MODEL),
            REASONING,
            target_language,
            true,
            items,
            Arc::clone(&cancelled),
            Arc::clone(&progress),
        )
        .await?;
        let repaired = repair_token_mismatches_once(
            Some(MODEL),
            REASONING,
            target_language,
            true,
            items,
            &drafts,
            Arc::clone(&cancelled),
            Arc::clone(&progress),
        )
        .await?;
        ai::suggestions(items, repaired.translations).map_err(ProviderFailure::InvalidResponse)
    })
    .await;
    cancelled.store(true, Ordering::Release);
    let (outcome, suggestions) = match translated {
        Ok(Ok(suggestions)) => ("complete", suggestions),
        Ok(Err(failure)) => {
            // Only the app's bounded, sanitized error message reaches the
            // terminal. Reports contain fixed categories, never raw responses.
            let category = failure_category(&failure);
            eprintln!("Batch {batch}: {}", chatgpt_auth::message(failure));
            (category, Vec::new())
        }
        Err(_) => ("timeout", Vec::new()),
    };
    let finished_ms = millis(started);
    let mut captured = std::mem::take(&mut *metrics.lock().unwrap());
    captured.finish_response(finished_ms);
    println!(
        "Batch {batch}: {outcome}, {} suggestions, {} ms",
        suggestions.len(),
        finished_ms - started_ms
    );
    BatchResult {
        batch,
        started_ms,
        finished_ms,
        outcome,
        suggestions,
        metrics: captured,
    }
}

fn maximum_overlap(batches: &[BatchResult]) -> usize {
    let mut events = batches
        .iter()
        .flat_map(|batch| {
            batch
                .metrics
                .response_intervals_ms
                .iter()
                .flat_map(|&(start, end)| [(start, 1_i32), (end, -1)])
        })
        .collect::<Vec<_>>();
    // A request finishing at a timestamp precedes one starting at that time.
    events.sort_unstable();
    let mut active = 0_i32;
    let mut maximum = 0_i32;
    for (_, delta) in events {
        active += delta;
        maximum = maximum.max(active);
    }
    maximum as usize
}

fn valid_batch(batch: &BatchResult, expected: &[PreparedAiItem]) -> bool {
    batch.outcome == "complete"
        && batch.suggestions.len() == expected.len()
        && batch.metrics.review_skipped == 0
        && batch
            .suggestions
            .iter()
            .zip(expected)
            .all(|(suggestion, item)| {
                suggestion.identity == item.identity
                    && suggestion.status == "review-needed"
                    && suggestion.token_differences.is_empty()
                    && suggestion.glossary_misses.is_empty()
            })
}

async fn compare(profile: PathBuf, output: PathBuf) -> Result<(), String> {
    let parse_number = |name: &str, default: usize, maximum: usize| -> Result<usize, String> {
        let value = std::env::var(name)
            .ok()
            .map(|value| value.parse::<usize>())
            .transpose()
            .map_err(|_| format!("{name} must be a positive integer."))?
            .unwrap_or(default);
        if value == 0 || value > maximum {
            return Err(format!("{name} is outside its bounded range."));
        }
        Ok(value)
    };
    let batch_size = parse_number(
        "SIT_PARALLEL_PROBE_BATCH_SIZE",
        COPIED_MOD_ITEMS_PER_BATCH,
        ai::MAX_CHUNK_ITEMS,
    )?;
    let rounds = parse_number("SIT_PARALLEL_PROBE_ROUNDS", 1, 3)?;
    let levels = std::env::var("SIT_PARALLEL_PROBE_LEVELS")
        .unwrap_or_else(|_| "1,2,4".into())
        .split(',')
        .map(|level| {
            level
                .trim()
                .parse::<usize>()
                .map_err(|_| "Invalid concurrency level.".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    if levels.is_empty() || levels.len() > 8 || levels.iter().any(|level| !(1..=8).contains(level))
    {
        return Err("Concurrency levels must be bounded between 1 and 8.".into());
    }
    let target_language =
        std::env::var("SIT_PARALLEL_PROBE_LANGUAGE").unwrap_or_else(|_| "German".into());
    if !["German", "French", "Spanish", "Japanese"].contains(&target_language.as_str()) {
        return Err("Unsupported experiment target language.".into());
    }
    let glossary: Vec<(String, String)> = std::env::var_os("SIT_PARALLEL_PROBE_GLOSSARY")
        .map(|file| {
            crate::input_limits::read_json_text(std::path::Path::new(&file))
                .and_then(|body| serde_json::from_str(&body).map_err(|error| error.to_string()))
        })
        .transpose()?
        .unwrap_or_default();
    let copied_source = std::env::var_os("SIT_PARALLEL_PROBE_SOURCE").map(PathBuf::from);
    let (batches, fixture_kind, source_sha256, pipeline_timeout) =
        if let Some(source) = copied_source {
            let batches = copied_mod_fixture_with_options(&source, batch_size, &glossary)?;
            let bytes = std::fs::read(&source).map_err(|error| error.to_string())?;
            (
                batches,
                "copied_mod",
                Some(format!("{:x}", Sha256::digest(bytes))),
                Duration::from_secs(600),
            )
        } else {
            (fixture(), "synthetic", None, Duration::from_secs(240))
        };
    let batch_count = batches.len();
    let total_strings = batches.iter().map(Vec::len).sum();
    let distinct_protected_tokens = batches
        .iter()
        .flatten()
        .flat_map(|item| {
            crate::tokens::extract(&item.source)
                .into_iter()
                .filter(|token| token != "\n" && token != "'")
        })
        .collect();
    let token_rows = batches
        .iter()
        .flatten()
        .filter(|item| {
            crate::tokens::extract(&item.source)
                .iter()
                .any(|token| token != "\n" && token != "'")
        })
        .count();
    let rows_with_neighbor_context = batches
        .iter()
        .flatten()
        .filter(|item| !item.context.before.is_empty() || !item.context.after.is_empty())
        .count();
    let prompt_bytes = batches
        .iter()
        .map(|items| {
            let prompt = build_translation_attempt_prompt(&target_language, items, None)
                .map_err(chatgpt_auth::message)?;
            Ok(complete_prompt_bytes(&prompt.instructions, &prompt.input))
        })
        .collect::<Result<Vec<_>, String>>()?;
    println!("Fixture: {total_strings} strings, {batch_count} batches, {token_rows} token-bearing rows, {rows_with_neighbor_context} rows with native neighboring context.");
    // The desktop now acquires ownership before initializing authentication.
    // This standalone probe must retain the same guard for its entire run.
    let _profile_owner = crate::portable_profile::acquire(&profile)?;
    if !profile.join("chatgpt-session.bin").is_file() {
        return Err("Sign in in an isolated Translator test profile first; the probe does not open login or use CLI credentials.".into());
    }
    chatgpt_auth::initialize(profile)?;
    if !chatgpt_auth::status().await.authenticated {
        return Err(
            "The isolated ChatGPT test session is unavailable. Sign in again in that test profile."
                .into(),
        );
    }
    let catalog = models().await?;
    let model_advertised = catalog.iter().any(|model| model.model == MODEL);
    println!("Exact requested model advertised: {model_advertised}; inference decides access.");
    std::fs::create_dir_all(&output).map_err(|error| error.to_string())?;
    let mut report = Comparison {
        schema_version: 3,
        model: MODEL,
        reasoning: REASONING,
        quality_review: true,
        model_advertised,
        target_language: target_language.clone(),
        glossary_pairs: glossary.len(),
        fixture_kind,
        source_sha256,
        total_strings,
        token_rows,
        distinct_protected_tokens,
        rows_with_neighbor_context,
        batch_sizes: batches.iter().map(Vec::len).collect(),
        prompt_bytes,
        batch_count,
        items_per_batch: batches[0].len(),
        fixture: batches
            .iter()
            .map(|items| items.iter().map(|item| item.source.clone()).collect())
            .collect(),
        runs: Vec::new(),
    };
    for round in 1..=rounds {
        let mut order = levels.clone();
        if round % 2 == 0 {
            order.reverse();
        }
        for concurrency in order {
            println!("Round {round}: starting {batch_count} fixed batches at concurrency {concurrency}: {MODEL}, {REASONING}, quality review enabled.");
            let started = Instant::now();
            let mut pending = stream::iter(batches.iter().enumerate().map(|(batch, items)| {
                run_batch(items, batch, started, pipeline_timeout, &target_language)
            }))
            .buffer_unordered(concurrency);
            let mut results = Vec::new();
            while let Some(batch) = pending.next().await {
                let valid = valid_batch(&batch, &batches[batch.batch]);
                results.push(batch);
                if !valid {
                    break;
                }
            }
            drop(pending);
            results.sort_by_key(|batch| batch.batch);
            let overlap = maximum_overlap(&results);
            let valid = results.len() == batch_count
                && results
                    .iter()
                    .all(|batch| valid_batch(batch, &batches[batch.batch]))
                && overlap == concurrency.min(batch_count);
            let duration_ms = millis(started);
            println!("Concurrency {concurrency}: {duration_ms} ms, maximum overlapping requests {overlap}, valid {valid}.");
            report.runs.push(RunResult {
                round,
                concurrency,
                duration_ms,
                max_overlapping_requests: overlap,
                valid,
                batches: results,
            });
            let encoded = serde_json::to_vec_pretty(&report).map_err(|error| error.to_string())?;
            std::fs::write(output.join("comparison.json"), encoded)
                .map_err(|error| error.to_string())?;
            if !valid {
                return Err("A concurrency level failed validation; higher levels were not attempted. Inspect the synthetic comparison artifact.".into());
            }
        }
    }
    Ok(())
}

#[test]
#[ignore = "Live ChatGPT plan usage: independent batches at concurrency 1, 2 and 4"]
fn compare_parallel_chatgpt_batches() {
    let profile = std::env::var_os("SIT_PARALLEL_PROBE_PROFILE")
        .map(PathBuf::from)
        .expect("Set SIT_PARALLEL_PROBE_PROFILE to a closed, isolated signed-in test profile.");
    let output = std::env::var_os("SIT_PARALLEL_PROBE_OUTPUT")
        .map(PathBuf::from)
        .expect("Set SIT_PARALLEL_PROBE_OUTPUT to an ignored experiment artifact directory.");
    tauri::async_runtime::block_on(compare(profile, output)).unwrap();
}

#[test]
fn copied_mod_preparation_preserves_keys_sections_context_and_batch_bounds() {
    let root = crate::test_support::temp_dir("parallel-probe-copied-mod");
    std::fs::create_dir_all(&root).unwrap();
    let source = root.join("default.json");
    let rows = (0..76)
        .map(|index| format!("\"dialogue.line{index}\": \"Hello {{{{name}}}}, reward {{0}}.\""))
        .collect::<Vec<_>>()
        .join(",\n");
    std::fs::write(&source, format!("{{\n// Synthetic section\n{rows}\n}}")).unwrap();
    let batches = copied_mod_fixture(&source).unwrap();
    assert_eq!(batches.iter().map(Vec::len).collect::<Vec<_>>(), [75, 1]);
    assert_eq!(batches[1][0].identity.key, "dialogue.line75");
    assert_eq!(batches[1][0].id, "75");
    assert_eq!(batches[1][0].section.as_deref(), Some("Synthetic section"));
    assert_eq!(batches[1][0].context.before.len(), 2);
    assert!(batches[1][0].context.after.is_empty());
    for batch in &batches {
        let prompt = build_translation_attempt_prompt("German", batch, None).unwrap();
        assert!(complete_prompt_bytes(&prompt.instructions, &prompt.input) <= ai::MAX_CHUNK_BYTES);
    }
    assert!(!root.join("de.json").exists());
    std::fs::remove_dir_all(root).unwrap();
}
