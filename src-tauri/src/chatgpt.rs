//! Direct ChatGPT plan access in the desktop app. No external helper process.
use crate::{
    ai::{ProviderFailure, ProviderPrompt},
    ai_provider::*,
    chatgpt_auth,
};
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
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
        let started = std::time::Instant::now();
        let response = chatgpt_auth::client().map_err(ProviderFailure::Message)?.post(format!("{}/responses", chatgpt_auth::RESOURCE)).bearer_auth(token).json(&json!({
            "model": model, "instructions": prompt.instructions,
            "input": [{"role":"user","content":prompt.input}],
            "reasoning":{"effort":reasoning},
            "text":{"format":{"type":"json_schema","name":"translator_output","strict":true,"schema":prompt.schema}},
            "store":false,"stream":true,
        })).send().await.map_err(|error| {
            // The 10 s connect timeout also reports is_timeout(); that is a
            // network problem, not an oversized batch.
            if error.is_timeout() && !error.is_connect() && reached_time_limit(started) {
                timeout_failure()
            } else {
                ProviderFailure::Transient("Could not reach OpenAI. Check the network and try again.".into())
            }
        })?;
        if !response.status().is_success() {
            let status = response.status().as_u16();
            let bytes = chatgpt_auth::read_bounded(response).await?;
            let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
            return Err(chatgpt_auth::api_failure(status, &body));
        }
        crate::chatgpt_response::consume(response, progress, started).await
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
/// A request that hit the five-minute ceiling is too large for one attempt,
/// not a network problem. Recovery splits the batch without a same-size retry.
pub(crate) const TIMEOUT_MESSAGE: &str =
    "OpenAI did not finish within the five-minute limit for one attempt.";
/// A refusal concerns content, not the response structure.
pub(crate) const REFUSAL_MESSAGE: &str = "The model declined to translate part of this batch.";

/// reqwest also reports an operating-system `TimedOut` (a stalled connection)
/// as a timeout. Only an attempt that actually ran close to the five-minute
/// client limit counts as too large; an earlier stall is a network problem.
pub(crate) fn reached_time_limit(started: std::time::Instant) -> bool {
    started.elapsed() >= Duration::from_secs(290)
}

pub(crate) fn timeout_failure() -> ProviderFailure {
    ProviderFailure::InvalidResponse(TIMEOUT_MESSAGE.into())
}

#[path = "cloud_translation.rs"]
mod cloud_translation;
pub(crate) use cloud_translation::{repair_token_mismatches_once, translate_chunk};

#[cfg(test)]
mod time_limit_tests {
    use super::*;

    #[test]
    fn only_an_attempt_near_five_minutes_counts_as_the_time_limit() {
        let now = std::time::Instant::now();
        assert!(!reached_time_limit(now));
        let early = now.checked_sub(Duration::from_secs(20)).unwrap();
        assert!(!reached_time_limit(early));
        let late = now.checked_sub(Duration::from_secs(300)).unwrap();
        assert!(reached_time_limit(late));
    }
}
