//! Local desktop prototype transport. OAuth credentials stay inside the Node
//! helper. The existing bounded translation/review pipeline consumes its output.
//! Enabled only in the explicitly built prototype, never in ordinary builds.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde_json::{json, Map, Value};

use crate::ai::{self, PreparedAiItem, ProviderFailure, ProviderPrompt, ProviderTranslation};
use crate::ai_provider::*;
use std::collections::{HashMap, VecDeque};
use std::future::Future;

pub fn enabled() -> bool {
    cfg!(feature = "chatgpt-prototype")
}

struct Bridge {
    client: reqwest::Client,
    origin: String,
    csrf: String,
}

impl Bridge {
    async fn connect() -> Result<Self, String> {
        if !enabled() {
            return Err("This build does not enable the ChatGPT prototype.".into());
        }
        let origin = std::env::var("CHATGPT_TRANSLATOR_BRIDGE").map_err(|_| {
            "Start this prototype with start-chatgpt-translator-prototype.cmd.".to_string()
        })?;
        let url = reqwest::Url::parse(&origin).map_err(|_| "Invalid local ChatGPT helper URL.")?;
        if url.scheme() != "http"
            || url.host_str() != Some("127.0.0.1")
            || url.port().is_none()
            || url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err("The ChatGPT prototype helper must use a loopback origin.".into());
        }
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(3))
            .timeout(Duration::from_secs(310))
            .build()
            .map_err(|_| "Could not create the local ChatGPT connection.".to_string())?;
        let response = client
            .get(&origin)
            .timeout(Duration::from_secs(5))
            .send()
            .await
            .map_err(|_| {
                "The ChatGPT connection is unavailable. Restart the app using its launcher."
                    .to_string()
            })?;
        let bytes = read_bounded(response)
            .await
            .map_err(provider_error_message)?;
        let page = String::from_utf8(bytes)
            .map_err(|_| "Invalid local ChatGPT helper page.".to_string())?;
        let marker = "name=\"prototype-csrf\" content=\"";
        let csrf = page
            .split_once(marker)
            .and_then(|(_, rest)| rest.split_once('"'))
            .map(|(csrf, _)| csrf.to_string())
            .filter(|csrf| {
                csrf.len() == 43
                    && csrf
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            })
            .ok_or_else(|| {
                "The local ChatGPT helper did not provide its request guard.".to_string()
            })?;
        Ok(Self {
            client,
            origin,
            csrf,
        })
    }

    async fn call(&self, route: &str, body: Value) -> Result<Value, String> {
        self.call_provider(route, body)
            .await
            .map_err(provider_error_message)
    }

    async fn call_provider(&self, route: &str, body: Value) -> Result<Value, ProviderFailure> {
        let response = self
            .client
            .post(format!("{}/api/{route}", self.origin))
            .header("Origin", &self.origin)
            .header("X-Prototype-CSRF", &self.csrf)
            .json(&body)
            .send()
            .await
            .map_err(|_| {
                ProviderFailure::Transient(
                    "The local ChatGPT request was interrupted or timed out.".into(),
                )
            })?;
        let success = response.status().is_success();
        let body: Value = serde_json::from_slice(&read_bounded(response).await?).map_err(|_| {
            ProviderFailure::InvalidResponse(
                "The local ChatGPT helper returned invalid data.".into(),
            )
        })?;
        if !success {
            return Err(helper_failure(&body));
        }
        Ok(body)
    }
}

fn helper_failure(body: &Value) -> ProviderFailure {
    let message = body
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("ChatGPT could not complete the request.")
        .chars()
        .take(500)
        .collect();
    match body["failureCategory"].as_str() {
        Some("transient") => ProviderFailure::Transient(message),
        Some("invalid_response") => ProviderFailure::InvalidResponse(message),
        Some("cancelled") => ProviderFailure::Cancelled,
        _ => ProviderFailure::Message(message),
    }
}

fn provider_error_message(failure: ProviderFailure) -> String {
    match failure {
        ProviderFailure::Cancelled => "The request was cancelled.".into(),
        ProviderFailure::Transient(message)
        | ProviderFailure::InvalidResponse(message)
        | ProviderFailure::Message(message) => message,
    }
}

async fn read_bounded(response: reqwest::Response) -> Result<Vec<u8>, ProviderFailure> {
    let mut stream = response.bytes_stream();
    let mut body = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| {
            ProviderFailure::Transient("The local ChatGPT response was interrupted.".into())
        })?;
        if body.len().saturating_add(chunk.len()) > 2 * 1024 * 1024 {
            return Err(ProviderFailure::InvalidResponse(
                "The local ChatGPT response exceeded the output limit.".into(),
            ));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

pub async fn status() -> CloudAiStatus {
    let result = async { Bridge::connect().await?.call("status", json!({})).await }.await;
    match result {
        Ok(state) => {
            let authenticated = state["signedIn"].as_bool() == Some(true)
                && state["planEnabled"].as_bool() == Some(true);
            CloudAiStatus {
                installed: true,
                authenticated,
                version: None,
                authentication: authenticated.then(|| "ChatGPT plan · direct login".into()),
                error: (!authenticated).then(|| {
                    let error = state["error"].as_str().unwrap_or("");
                    if error.is_empty() {
                        "Sign in with ChatGPT to use your plan.".into()
                    } else {
                        error.to_string()
                    }
                }),
            }
        }
        Err(error) => CloudAiStatus {
            installed: false,
            authenticated: false,
            version: None,
            authentication: None,
            error: Some(error),
        },
    }
}

pub async fn models() -> Result<Vec<CloudAiModel>, String> {
    let state = Bridge::connect().await?.call("models", json!({})).await?;
    let models = state["models"]
        .as_array()
        .ok_or("ChatGPT did not return a model catalog.")?;
    Ok(models
        .iter()
        .enumerate()
        .filter_map(|(index, model)| {
            Some(CloudAiModel {
                model: model["id"].as_str()?.into(),
                display_name: model["name"].as_str()?.into(),
                is_default: index == 0,
                default_reasoning_effort: Some("medium".into()),
                supported_reasoning_efforts: model["supportedReasoningEfforts"]
                    .as_array()
                    .map(|values| {
                        values
                            .iter()
                            .filter_map(Value::as_str)
                            .filter(|value| ["low", "medium", "high"].contains(value))
                            .map(str::to_string)
                            .collect()
                    })
                    .unwrap_or_default(),
            })
        })
        .collect())
}

pub async fn login_url() -> Result<String, String> {
    let value = Bridge::connect().await?.call("login", json!({})).await?;
    let url = value["authorizationUrl"]
        .as_str()
        .ok_or("ChatGPT did not return a sign-in URL.")?;
    let parsed = reqwest::Url::parse(url).map_err(|_| "Invalid ChatGPT sign-in URL.")?;
    if parsed.scheme() != "https"
        || parsed.host_str() != Some("auth.openai.com")
        || parsed.port().is_some()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("Unexpected ChatGPT sign-in destination.".into());
    }
    Ok(url.into())
}

pub async fn logout() -> Result<(), String> {
    let state = Bridge::connect().await?.call("logout", json!({})).await?;
    if state["revoked"].as_bool() != Some(true) {
        return Err("Signed out locally. Remote revocation was not confirmed; disconnect this app in ChatGPT settings.".into());
    }
    Ok(())
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
    let bridge = Bridge::connect().await.map_err(ProviderFailure::Message)?;
    let model = model.ok_or_else(|| {
        ProviderFailure::Message("Select a ChatGPT model in Settings before translating.".into())
    })?;
    progress(ProviderProgressEvent::Activity(ProviderActivity::Starting));
    let request = bridge.call_provider("inference", json!({"model": model, "reasoning": reasoning, "instructions": prompt.instructions, "input": prompt.input, "schema": prompt.schema}));
    tokio::pin!(request);
    let mut sequence = None;
    loop {
        tokio::select! {
            result = &mut request => {
                let result = result?;
                if cancelled.load(Ordering::Acquire) {return Err(ProviderFailure::Cancelled);}
                let usage = &result["usage"];
                if usage.is_object() {progress(ProviderProgressEvent::Usage(ProviderTokenUsage {
                    input_tokens: usage["inputTokens"].as_u64().unwrap_or(0),
                    cached_input_tokens: usage["cachedInputTokens"].as_u64().unwrap_or(0),
                    output_tokens: usage["outputTokens"].as_u64().unwrap_or(0),
                    reasoning_output_tokens: usage["reasoningOutputTokens"].as_u64().unwrap_or(0),
                }));}
                progress(ProviderProgressEvent::Activity(ProviderActivity::Completed));
                return result["text"].as_str().map(str::to_string).ok_or_else(|| ProviderFailure::InvalidResponse("ChatGPT returned no completed translation text.".into()));
            },
            _ = tokio::time::sleep(Duration::from_millis(200)) => {
                if cancelled.load(Ordering::Acquire) {
                    let _ = tokio::time::timeout(Duration::from_secs(5), bridge.call("cancel", json!({}))).await;
                    return Err(ProviderFailure::Cancelled);
                }
                let state = tokio::time::timeout(Duration::from_secs(2), bridge.call("status", json!({}))).await;
                if let Ok(Ok(state)) = state {
                    let next_sequence = state["activitySequence"].as_u64();
                    if sequence != next_sequence {
                        sequence = next_sequence;
                        let activity = match state["activity"].as_str() {
                            // Completion is emitted once when the inference
                            // response has been read, never from status polling.
                            Some("completed") => continue,
                            Some("starting") => ProviderActivity::Starting,
                            Some("reasoning") => ProviderActivity::Reasoning,
                            Some("writingResponse") => ProviderActivity::WritingResponse,
                            _ => ProviderActivity::Working,
                        };
                        progress(ProviderProgressEvent::Activity(activity));
                    }
                }
            }
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
        let text = crate::chatgpt_prototype::run_prompt(
            model,
            reasoning,
            prompt,
            cancelled,
            Arc::clone(&progress),
        )
        .await?;
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

pub async fn rate_limits() -> Result<Option<crate::ai_provider::CloudAiRateLimits>, String> {
    Ok(None)
}

#[cfg(test)]
#[path = "codex_cli/merge_followup_tests.rs"]
mod merge_followup_tests;
#[cfg(test)]
#[path = "codex_cli/review_failure_tests.rs"]
mod review_failure_tests;

#[cfg(test)]
mod transport_tests {
    use super::*;
    #[test]
    fn helper_failure_preserves_recovery_categories_and_unknowns_fail_closed() {
        for (category, expected) in [
            ("transient", ProviderFailure::Transient("Safe error".into())),
            (
                "invalid_response",
                ProviderFailure::InvalidResponse("Safe error".into()),
            ),
            ("cancelled", ProviderFailure::Cancelled),
            ("message", ProviderFailure::Message("Safe error".into())),
            ("future", ProviderFailure::Message("Safe error".into())),
        ] {
            assert_eq!(
                helper_failure(&json!({"error":"Safe error", "failureCategory":category})),
                expected
            );
        }
        assert!(
            matches!(helper_failure(&json!({"error":"x".repeat(1000)})), ProviderFailure::Message(message) if message.len() == 500)
        );
    }
}
