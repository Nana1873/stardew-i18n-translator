//! Direct ChatGPT plan access in the desktop app. No external helper process.
use crate::{
    ai::{self, PreparedAiItem, ProviderFailure, ProviderPrompt, ProviderTranslation},
    ai_provider::*,
    chatgpt_auth,
};
use serde_json::{json, Map, Value};
use std::{
    collections::{HashMap, VecDeque},
    future::Future,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

pub async fn status() -> CloudAiStatus {
    chatgpt_auth::status().await
}
pub async fn models() -> Result<Vec<CloudAiModel>, String> {
    let token = chatgpt_auth::access_token()
        .await
        .map_err(chatgpt_auth::message)?;
    let response = chatgpt_auth::client()?
        .get(format!("{}/models", chatgpt_auth::RESOURCE))
        .bearer_auth(token)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|_| "Could not load ChatGPT models. Check the network and try again.")?;
    let status = response.status();
    let body: Value = serde_json::from_slice(
        &chatgpt_auth::read_bounded(response)
            .await
            .map_err(chatgpt_auth::message)?,
    )
    .map_err(|_| "OpenAI returned an unreadable model catalog.")?;
    if !status.is_success() {
        return Err(chatgpt_auth::message(chatgpt_auth::api_failure(
            status.as_u16(),
            &body,
        )));
    }
    visible_models(&body)
}
fn visible_models(body: &Value) -> Result<Vec<CloudAiModel>, String> {
    let models = body["models"]
        .as_array()
        .ok_or("OpenAI did not return the ChatGPT model catalog.")?;
    Ok(models
        .iter()
        .filter(|m| m["visibility"] == "list")
        .filter_map(|m| {
            let id = m["slug"].as_str().filter(|s| {
                !s.is_empty()
                    && s.len() <= 160
                    && s.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b))
            })?;
            let advertised = m["supported_reasoning_levels"]
                .as_array()
                .or_else(|| m["supported_reasoning_efforts"].as_array());
            let efforts = advertised
                .map(|values| {
                    values
                        .iter()
                        .filter_map(|v| {
                            v.as_str()
                                .or_else(|| v["effort"].as_str())
                                .or_else(|| v["reasoning_effort"].as_str())
                        })
                        .filter(|v| ["low", "medium", "high"].contains(v))
                        .map(str::to_string)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            Some(CloudAiModel {
                model: id.into(),
                display_name: m["display_name"]
                    .as_str()
                    .unwrap_or(id)
                    .chars()
                    .take(200)
                    .collect(),
                is_default: false,
                default_reasoning_effort: Some("medium".into()),
                supported_reasoning_efforts: efforts,
            })
        })
        .enumerate()
        .map(|(i, mut m)| {
            m.is_default = i == 0;
            m
        })
        .collect())
}
pub async fn run_prompt(
    model: Option<String>,
    reasoning: String,
    prompt: ProviderPrompt,
    cancelled: Arc<AtomicBool>,
    progress: ProviderProgressCallback,
) -> Result<String, ProviderFailure> {
    if cancelled.load(Ordering::Acquire) {
        return Err(ProviderFailure::Cancelled);
    }
    let epoch = chatgpt_auth::generation();
    let model = model.ok_or_else(|| {
        ProviderFailure::Message("Select a ChatGPT model in Settings before translating.".into())
    })?;
    let request = async {
        // Finish a serialized refresh even if the translation is cancelled, so
        // a rotating refresh token can be saved before another attempt uses it.
        let refresh = tokio::spawn(chatgpt_auth::access_token());
        let token = refresh.await.map_err(|_| {
            ProviderFailure::Message("Could not restore the ChatGPT session.".into())
        })??;
        if cancelled.load(Ordering::Acquire) || epoch != chatgpt_auth::generation() {
            return Err(ProviderFailure::Cancelled);
        }
        progress(ProviderProgressEvent::Activity(ProviderActivity::Starting));
        let response = chatgpt_auth::client().map_err(ProviderFailure::Message)?.post(format!("{}/responses", chatgpt_auth::RESOURCE)).bearer_auth(token).json(&json!({
            "model": model, "instructions": prompt.instructions,
            "input": [{"role":"user","content":prompt.input}],
            "reasoning":{"effort":reasoning},
            "text":{"format":{"type":"json_schema","name":"translator_output","strict":true,"schema":prompt.schema}},
            "store":false,"stream":true,
        })).send().await.map_err(|_| ProviderFailure::Transient("Could not reach OpenAI. Check the network and try again.".into()))?;
        if !response.status().is_success() {
            let status = response.status().as_u16();
            let bytes = chatgpt_auth::read_bounded(response).await?;
            let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
            return Err(chatgpt_auth::api_failure(status, &body));
        }
        crate::chatgpt_response::consume(response, progress).await
    };
    tokio::pin!(request);
    loop {
        if cancelled.load(Ordering::Acquire) || epoch != chatgpt_auth::generation() {
            return Err(ProviderFailure::Cancelled);
        }
        tokio::select! {
            result = &mut request => {
                if cancelled.load(Ordering::Acquire) || epoch != chatgpt_auth::generation() { return Err(ProviderFailure::Cancelled); }
                return result;
            },
            _ = tokio::time::sleep(Duration::from_millis(100)) => {}
        }
    }
}
include!("cloud_translation.rs");

#[allow(clippy::too_many_arguments)]
async fn run_prompt_once(
    model: Option<String>,
    reasoning: String,
    prompt: ProviderPrompt,
    expected: Vec<PreparedAiItem>,
    output_contract: PromptOutputContract,
    cancelled: Arc<AtomicBool>,
    progress: ProviderProgressCallback,
) -> Result<Vec<ProviderTranslation>, ProviderFailure> {
    let started = Instant::now();
    log::info!(target: "chatgpt", "{}", serde_json::json!({
        "event": "attempt_started", "engine": "chatgpt", "transport": "responses",
        "itemCount": expected.len(), "model": safe_model_for_log(model.as_deref()), "reasoning": reasoning,
    }));
    let result = async {
        let text = run_prompt(model, reasoning, prompt, cancelled, Arc::clone(&progress)).await?;
        let parsed = ai::parse_provider_output(&text).map_err(ProviderFailure::InvalidResponse)?;
        match output_contract {
            PromptOutputContract::Exact => ai::validate_provider_output(&expected, parsed),
            PromptOutputContract::Sparse => ai::validate_provider_output_subset(&expected, parsed),
        }
        .map_err(ProviderFailure::InvalidResponse)
    }
    .await;
    let outcome = match &result {
        Ok(_) => "complete",
        Err(ProviderFailure::Cancelled) => "cancelled",
        Err(ProviderFailure::Transient(_)) => "transient_error",
        Err(ProviderFailure::InvalidResponse(_)) => "invalid_response",
        Err(ProviderFailure::Message(_)) => "error",
    };
    if result.is_err() && !matches!(&result, Err(ProviderFailure::Cancelled)) {
        progress(ProviderProgressEvent::Activity(ProviderActivity::Failed));
    }
    log::info!(target: "chatgpt", "{}", serde_json::json!({
        "event": "attempt_finished", "engine": "chatgpt", "transport": "responses",
        "itemCount": expected.len(), "durationMs": u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX), "outcome": outcome,
    }));
    result
}

#[cfg(test)]
#[path = "cloud_translation/merge_followup_tests.rs"]
mod merge_followup_tests;
#[cfg(test)]
#[path = "cloud_translation/review_failure_tests.rs"]
mod review_failure_tests;
#[cfg(test)]
#[path = "cloud_translation/tests.rs"]
mod tests;

#[cfg(test)]
#[path = "chatgpt/parallel_probe.rs"]
mod parallel_probe;
