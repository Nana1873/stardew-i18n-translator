//! Local-LLM client (M6, Issue 15) — OpenAI-compatible endpoints only.
//!
//! Both target servers (Ollama, LM Studio) expose an OpenAI-compatible HTTP API,
//! so a single client covers them plus any other compatible server (LocalAI, Jan,
//! llama.cpp, …). This is deliberately *not* a provider plugin system (SPEC §19
//! #6): just a base URL + a `GET /v1/models` reachability probe. The actual
//! translation call (`POST /v1/chat/completions`) lands in Issue 16.
//!
//! Everything is localhost/LAN HTTP — no API key, no external network (SPEC §19 #7).

use std::time::Duration;

use serde::Deserialize;

/// OpenAI-compatible `GET /v1/models` response: `{ "data": [ { "id": "…" }, … ] }`.
#[derive(Deserialize)]
struct ModelsResponse {
    #[serde(default)]
    data: Vec<ModelEntry>,
}

#[derive(Deserialize)]
struct ModelEntry {
    #[serde(default)]
    id: String,
}

/// Parse the model `id`s out of a `/v1/models` response body. Tolerant: a body
/// that does not match the shape yields an empty list rather than an error, so a
/// reachable-but-odd server still counts as "connected".
pub fn parse_model_ids(body: &str) -> Vec<String> {
    serde_json::from_str::<ModelsResponse>(body)
        .map(|response| {
            response
                .data
                .into_iter()
                .map(|entry| entry.id)
                .filter(|id| !id.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// Build the `/models` URL from a base URL, tolerating a trailing slash.
pub fn models_url(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    format!("{trimmed}/models")
}

/// List available models from an OpenAI-compatible server. A successful response
/// is the "connection OK" signal; the returned ids populate the model dropdown.
pub async fn list_models(base_url: &str) -> Result<Vec<String>, String> {
    let url = models_url(base_url);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|error| format!("Could not create HTTP client: {error}"))?;

    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|error| format!("Could not reach {url} — is the server running? ({error})"))?;

    if !response.status().is_success() {
        return Err(format!("Server returned {} for {url}.", response.status()));
    }

    let body = response
        .text()
        .await
        .map_err(|error| format!("Could not read the server response: {error}"))?;

    Ok(parse_model_ids(&body))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_openai_model_list() {
        let body = r#"{"object":"list","data":[{"id":"llama3.1:8b"},{"id":"qwen2.5"}]}"#;
        assert_eq!(parse_model_ids(body), vec!["llama3.1:8b", "qwen2.5"]);
    }

    #[test]
    fn empty_or_garbage_body_yields_no_models() {
        assert!(parse_model_ids("").is_empty());
        assert!(parse_model_ids("not json").is_empty());
        assert!(parse_model_ids(r#"{"data":[]}"#).is_empty());
    }

    #[test]
    fn skips_entries_without_an_id() {
        let body = r#"{"data":[{"id":""},{"id":"keep"},{}]}"#;
        assert_eq!(parse_model_ids(body), vec!["keep"]);
    }

    #[test]
    fn models_url_handles_trailing_slash_and_whitespace() {
        assert_eq!(models_url("http://localhost:1234/v1"), "http://localhost:1234/v1/models");
        assert_eq!(models_url("http://localhost:1234/v1/"), "http://localhost:1234/v1/models");
        assert_eq!(models_url("  http://localhost:11434/v1  "), "http://localhost:11434/v1/models");
    }
}
