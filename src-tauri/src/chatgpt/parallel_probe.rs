//! Opt-in provider experiment. Uses the app's real ChatGPT pipeline and an
//! exclusively owned, already signed-in synthetic test profile.
use super::*;
use futures_util::{stream, StreamExt};
use serde::Serialize;
use std::{path::PathBuf, sync::Mutex};

const MODEL: &str = "gpt-6.1-sol";
const REASONING: &str = "medium";
const BATCH_COUNT: usize = 4;
const ITEMS_PER_BATCH: usize = 12;

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Metrics {
    attempts: usize,
    transient_retries: usize,
    structure_retries: usize,
    splits: usize,
    review_skipped: usize,
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

fn failure_category(failure: &ProviderFailure) -> &'static str {
    match failure {
        ProviderFailure::Cancelled => "cancelled",
        ProviderFailure::Transient(_) => "transient_error",
        ProviderFailure::InvalidResponse(_) => "invalid_response",
        ProviderFailure::Message(_) => "provider_error",
    }
}

async fn run_batch(items: &[PreparedAiItem], batch: usize, started: Instant) -> BatchResult {
    let started_ms = millis(started);
    let metrics = Arc::new(Mutex::new(Metrics::default()));
    let captured = Arc::clone(&metrics);
    let progress: ProviderProgressCallback = Arc::new(move |event| {
        captured.lock().unwrap().event(event, millis(started));
    });
    let cancelled = Arc::new(AtomicBool::new(false));
    // The experiment bounds each complete translate/review/repair pipeline,
    // while retaining the provider's existing per-attempt timeout/recovery.
    let translated = tokio::time::timeout(Duration::from_secs(240), async {
        let drafts = translate_chunk(
            Some(MODEL),
            REASONING,
            "German",
            true,
            items,
            Arc::clone(&cancelled),
            Arc::clone(&progress),
        )
        .await?;
        let repaired = repair_token_mismatches_once(
            Some(MODEL),
            REASONING,
            "German",
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

fn valid_batch(batch: &BatchResult) -> bool {
    batch.outcome == "complete"
        && batch.suggestions.len() == ITEMS_PER_BATCH
        && batch.metrics.review_skipped == 0
        && batch
            .suggestions
            .iter()
            .enumerate()
            .all(|(index, suggestion)| {
                suggestion.identity.key == format!("batch-{}-item-{index}", batch.batch)
                    && suggestion.status == "review-needed"
                    && suggestion.token_differences.is_empty()
                    && suggestion.glossary_misses.is_empty()
            })
}

async fn compare(profile: PathBuf, output: PathBuf) -> Result<(), String> {
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
    let batches = fixture();
    let mut report = Comparison {
        schema_version: 1,
        model: MODEL,
        reasoning: REASONING,
        quality_review: true,
        model_advertised,
        batch_count: BATCH_COUNT,
        items_per_batch: ITEMS_PER_BATCH,
        fixture: batches
            .iter()
            .map(|items| items.iter().map(|item| item.source.clone()).collect())
            .collect(),
        runs: Vec::new(),
    };
    for concurrency in [1, 2, 4] {
        println!("Starting {BATCH_COUNT} fixed batches at concurrency {concurrency}: {MODEL}, {REASONING}, quality review enabled.");
        let started = Instant::now();
        let mut pending = stream::iter(
            batches
                .iter()
                .enumerate()
                .map(|(batch, items)| run_batch(items, batch, started)),
        )
        .buffer_unordered(concurrency);
        let mut results = Vec::new();
        while let Some(batch) = pending.next().await {
            let valid = valid_batch(&batch);
            results.push(batch);
            if !valid {
                break;
            }
        }
        drop(pending);
        results.sort_by_key(|batch| batch.batch);
        let overlap = maximum_overlap(&results);
        let valid = results.len() == BATCH_COUNT
            && results.iter().all(valid_batch)
            && overlap == concurrency;
        let duration_ms = millis(started);
        println!("Concurrency {concurrency}: {duration_ms} ms, maximum overlapping requests {overlap}, valid {valid}.");
        report.runs.push(RunResult {
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
    Ok(())
}

#[test]
#[ignore = "Live ChatGPT plan usage: four synthetic batches at concurrency 1, 2 and 4"]
fn compare_parallel_chatgpt_batches() {
    let profile = std::env::var_os("SIT_PARALLEL_PROBE_PROFILE")
        .map(PathBuf::from)
        .expect("Set SIT_PARALLEL_PROBE_PROFILE to a closed, isolated signed-in test profile.");
    let output = std::env::var_os("SIT_PARALLEL_PROBE_OUTPUT")
        .map(PathBuf::from)
        .expect("Set SIT_PARALLEL_PROBE_OUTPUT to an ignored experiment artifact directory.");
    tauri::async_runtime::block_on(compare(profile, output)).unwrap();
}
