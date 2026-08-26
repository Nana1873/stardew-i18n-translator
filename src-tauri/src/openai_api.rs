//! Direct OpenAI Responses API adapter.
//!
//! Production URLs are fixed. The API key exists only in `AiRuntimeState` for
//! the current process session and is never persisted, exported, or logged.

use std::sync::{atomic::AtomicBool, Arc};
use std::time::Duration;

use futures_util::TryStreamExt;
use reqwest::header::{HeaderValue, AUTHORIZATION};
use serde::{Deserialize, Serialize};
use serde_json::json;
use zeroize::{Zeroize, Zeroizing};

use crate::ai::{self, AiRuntimeState, PreparedAiItem, ProviderFailure, ProviderTranslation};

const OPENAI_API_BASE: &str = "https://api.openai.com/v1/";
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_REQUEST_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone)]
struct Endpoints {
    base: reqwest::Url,
}

impl Endpoints {
    fn production() -> Result<Self, String> {
        reqwest::Url::parse(OPENAI_API_BASE)
            .map(|base| Self { base })
            .map_err(|error| format!("Could not prepare the OpenAI API endpoint: {error}"))
    }

    fn path(&self, segments: &[&str]) -> Result<reqwest::Url, String> {
        let mut url = self.base.clone();
        {
            let mut path = url
                .path_segments_mut()
                .map_err(|_| "Could not prepare the OpenAI API endpoint.".to_string())?;
            path.pop_if_empty();
            for segment in segments {
                path.push(segment);
            }
        }
        Ok(url)
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpenAiSessionStatus {
    pub connected: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

fn validate_key(value: String) -> Result<Zeroizing<String>, String> {
    let key = value.trim().to_string();
    if key.is_empty() || key.len() > 512 || key.chars().any(char::is_control) {
        return Err("Enter a valid OpenAI API key for this session.".to_string());
    }
    Ok(Zeroizing::new(key))
}

pub(crate) fn validate_model(value: &str) -> Result<String, String> {
    let model = value.trim();
    if model.is_empty()
        || model.len() > 200
        || model.chars().any(char::is_control)
        || !model.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | ':')
        })
    {
        return Err("Enter a valid OpenAI model id.".to_string());
    }
    Ok(model.to_string())
}

fn client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(timeout)
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| format!("Could not create the OpenAI API client: {error}"))
}

fn authorization(key: &str) -> Result<HeaderValue, String> {
    let mut bytes = Zeroizing::new(Vec::with_capacity(7 + key.len()));
    bytes.extend_from_slice(b"Bearer ");
    bytes.extend_from_slice(key.as_bytes());
    let mut value = HeaderValue::from_bytes(&bytes)
        .map_err(|_| "The OpenAI API key contains invalid header data.".to_string())?;
    value.set_sensitive(true);
    Ok(value)
}

async fn read_limited_body(response: reqwest::Response) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err("The OpenAI API response is too large.".to_string());
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream
        .try_next()
        .await
        .map_err(|error| format!("Could not read the OpenAI API response: {error}"))?
    {
        if body.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            body.zeroize();
            return Err("The OpenAI API response is too large.".to_string());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

#[derive(Deserialize)]
struct ErrorEnvelope {
    error: Option<ApiError>,
}

#[derive(Deserialize)]
struct ApiError {
    #[serde(default)]
    code: Option<String>,
}

fn api_error(status: reqwest::StatusCode, body: &[u8]) -> String {
    let code = serde_json::from_slice::<ErrorEnvelope>(body)
        .ok()
        .and_then(|envelope| envelope.error)
        .and_then(|error| error.code)
        .unwrap_or_default()
        .to_ascii_lowercase();
    match status.as_u16() {
        401 => "The OpenAI API key was rejected.".to_string(),
        403 => {
            "This OpenAI API project is not permitted to use the requested resource.".to_string()
        }
        404 => "The configured OpenAI model was not found or is unavailable to this API project."
            .to_string(),
        429 if code.contains("quota") || code.contains("credit") || code.contains("billing") => {
            "The OpenAI API project has no available quota or billing capacity.".to_string()
        }
        429 => "The OpenAI API rate limit was reached. Try again later.".to_string(),
        400 => "OpenAI rejected the translation request for the configured model.".to_string(),
        500..=599 => "The OpenAI API is temporarily unavailable.".to_string(),
        _ => format!("The OpenAI API returned HTTP {status}."),
    }
}

async fn validate_access_at(endpoints: &Endpoints, key: &str, model: &str) -> Result<(), String> {
    let url = endpoints.path(&["models", model])?;
    let response = client(Duration::from_secs(15))?
        .get(url)
        .header(AUTHORIZATION, authorization(key)?)
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                "The OpenAI API validation timed out.".to_string()
            } else {
                "Could not reach the OpenAI API for validation.".to_string()
            }
        })?;
    let status = response.status();
    let mut body = read_limited_body(response).await?;
    let result = if status.is_success() {
        #[derive(Deserialize)]
        struct ModelResponse {
            id: String,
        }
        serde_json::from_slice::<ModelResponse>(&body)
            .map_err(|_| "OpenAI returned an invalid model validation response.".to_string())
            .and_then(|response| {
                (response.id == model)
                    .then_some(())
                    .ok_or_else(|| "OpenAI validated a different model id.".to_string())
            })
    } else {
        Err(api_error(status, &body))
    };
    body.zeroize();
    result
}

pub async fn connect(
    state: &AiRuntimeState,
    api_key: String,
    model: String,
) -> Result<OpenAiSessionStatus, String> {
    let key = validate_key(api_key)?;
    let model = validate_model(&model)?;
    validate_access_at(&Endpoints::production()?, &key, &model).await?;
    // Replace only after successful remote validation, so a failed reconnect
    // cannot discard the previous working session.
    state.set_openai_session(key, model.clone())?;
    Ok(OpenAiSessionStatus {
        connected: true,
        model: Some(model),
    })
}

pub fn status(state: &AiRuntimeState) -> Result<OpenAiSessionStatus, String> {
    let model = state.openai_session_model()?;
    Ok(OpenAiSessionStatus {
        connected: model.is_some(),
        model,
    })
}

#[derive(Deserialize)]
struct ResponsesEnvelope {
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    output_text: Option<String>,
    #[serde(default)]
    output: Vec<serde_json::Value>,
}

fn response_output_text(body: &[u8]) -> Result<String, String> {
    let response: ResponsesEnvelope = serde_json::from_slice(body)
        .map_err(|_| "OpenAI returned invalid response data.".to_string())?;
    if response.status.as_deref() != Some("completed") {
        return Err("The OpenAI response did not complete.".to_string());
    }
    if response.output.is_empty() {
        return response
            .output_text
            .filter(|text| !text.trim().is_empty())
            .ok_or_else(|| "OpenAI returned no completed translation result.".to_string());
    }

    let mut texts = Vec::new();
    for item in response.output {
        match item.get("type").and_then(serde_json::Value::as_str) {
            Some("reasoning") => continue,
            Some("message") => {
                let Some(content) = item.get("content").and_then(serde_json::Value::as_array)
                else {
                    return Err("OpenAI returned an invalid message item.".to_string());
                };
                for part in content {
                    match part.get("type").and_then(serde_json::Value::as_str) {
                        Some("output_text") => {
                            let text = part
                                .get("text")
                                .and_then(serde_json::Value::as_str)
                                .ok_or_else(|| {
                                    "OpenAI returned invalid output text.".to_string()
                                })?;
                            texts.push(text.to_string());
                        }
                        Some("refusal") => {
                            return Err("OpenAI refused this translation request.".to_string());
                        }
                        Some(_) | None => {
                            return Err("OpenAI returned an unsupported message item.".to_string());
                        }
                    }
                }
            }
            Some(_) | None => {
                return Err("OpenAI returned an unexpected tool or output item.".to_string());
            }
        }
    }
    if texts.len() != 1 || texts[0].trim().is_empty() {
        return Err("OpenAI returned no single completed translation result.".to_string());
    }
    let text = texts.remove(0);
    if response
        .output_text
        .as_deref()
        .is_some_and(|summary| !summary.trim().is_empty() && summary != text)
    {
        return Err("OpenAI returned inconsistent translation output.".to_string());
    }
    Ok(text)
}

fn output_budget(items: &[PreparedAiItem]) -> u32 {
    let characters: u32 = items
        .iter()
        .map(|item| item.source.chars().count() as u32)
        .sum();
    characters
        .saturating_mul(3)
        .saturating_add((items.len() as u32).saturating_mul(64))
        .clamp(1024, 32_768)
}

fn response_request(
    model: String,
    reasoning: String,
    prompt: ai::ProviderPrompt,
    items: &[PreparedAiItem],
) -> serde_json::Value {
    json!({
        "model": model,
        "instructions": prompt.instructions,
        "input": prompt.input,
        "text": {
            "format": {
                "type": "json_schema",
                "name": "stardew_translations",
                "strict": true,
                "schema": prompt.schema
            }
        },
        "reasoning": {"effort": reasoning},
        "tools": [],
        "tool_choice": "none",
        "parallel_tool_calls": false,
        "store": false,
        "stream": false,
        "max_output_tokens": output_budget(items)
    })
}

pub async fn translate_chunk(
    key: Zeroizing<String>,
    model: &str,
    reasoning: &str,
    target_language: &str,
    items: &[PreparedAiItem],
    cancelled: Arc<AtomicBool>,
) -> Result<Vec<ProviderTranslation>, ProviderFailure> {
    let model = validate_model(model)?;
    let reasoning = ai::normalize_reasoning(reasoning)?;
    let prompt = ai::build_provider_prompt(target_language, items)?;
    let request = response_request(model, reasoning, prompt, items);
    let mut body = serde_json::to_vec(&request).map_err(|error| {
        ProviderFailure::Message(format!("Could not prepare the OpenAI request: {error}"))
    })?;
    if body.len() > MAX_REQUEST_BYTES {
        body.zeroize();
        return Err(ProviderFailure::Message(
            "The prepared OpenAI request is too large. Narrow the scope and try again.".to_string(),
        ));
    }
    let endpoint = Endpoints::production()?.path(&["responses"])?;
    let send = client(Duration::from_secs(120))?
        .post(endpoint)
        .header(AUTHORIZATION, authorization(&key)?)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body.clone())
        .send();
    body.zeroize();
    let request_and_body = async {
        let response = send.await.map_err(|error| {
            if error.is_timeout() {
                ProviderFailure::Message("The OpenAI translation request timed out.".to_string())
            } else {
                ProviderFailure::Message("Could not reach the OpenAI API.".to_string())
            }
        })?;
        let status = response.status();
        let body = read_limited_body(response)
            .await
            .map_err(ProviderFailure::Message)?;
        Ok::<_, ProviderFailure>((status, body))
    };
    let (status, mut response_body) = tokio::select! {
        result = request_and_body => result?,
        () = ai::wait_for_cancel(Arc::clone(&cancelled)) => return Err(ProviderFailure::Cancelled),
    };
    if !status.is_success() {
        let error = api_error(status, &response_body);
        response_body.zeroize();
        return Err(ProviderFailure::Message(error));
    }
    let output = response_output_text(&response_body);
    response_body.zeroize();
    let translations = ai::parse_provider_output(&output?)?;
    ai::validate_provider_output(items, translations).map_err(ProviderFailure::Message)
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;

    use super::*;

    #[test]
    fn model_and_key_validation_are_bounded_without_prefix_guessing() {
        assert_eq!(validate_model(" gpt-example ").unwrap(), "gpt-example");
        assert!(validate_model("bad/model").is_err());
        assert!(validate_key("not-prefixed-but-valid".to_string()).is_ok());
        assert!(validate_key("\n".to_string()).is_err());
    }

    #[test]
    fn response_requires_completed_structured_text_and_rejects_tools_or_refusals() {
        assert_eq!(
            response_output_text(
                br#"{"status":"completed","output_text":"{\"translations\":[]}"}"#
            )
            .unwrap(),
            r#"{"translations":[]}"#
        );
        for body in [
            br#"{"status":"incomplete","output_text":"{}"}"#.as_slice(),
            br#"{"status":"completed","output":[{"type":"message","content":[{"type":"refusal","refusal":"no"}]}]}"#.as_slice(),
            br#"{"status":"completed","output":[{"type":"function_call"}]}"#.as_slice(),
            br#"{"status":"completed","output_text":"{\"translations\":[]}","output":[{"type":"function_call"}]}"#.as_slice(),
        ] {
            assert!(response_output_text(body).is_err());
        }
    }

    #[test]
    fn response_request_is_non_persistent_tool_free_and_hides_real_identities() {
        let items = vec![PreparedAiItem {
            id: "item-0000".to_string(),
            identity: crate::ai::AiStringIdentity {
                mod_unique_id: "private.mod".to_string(),
                relative_dir: "assets/i18n".to_string(),
                key: "secret.key".to_string(),
            },
            source: "Hello".to_string(),
            section: Some("Greeting".to_string()),
            glossary_pairs: vec![("Farmer".to_string(), "Bauer".to_string())],
            default_path: std::path::PathBuf::from(r"C:\private\default.json"),
            target_path: std::path::PathBuf::from(r"C:\private\de.json"),
            expected_stored: None,
            expected_revision: 0,
        }];
        let prompt = ai::build_provider_prompt("German", &items).unwrap();
        let request = response_request(
            "gpt-example".to_string(),
            "medium".to_string(),
            prompt,
            &items,
        );

        assert_eq!(request["store"], false);
        assert_eq!(request["stream"], false);
        assert_eq!(request["tool_choice"], "none");
        assert_eq!(request["tools"], serde_json::json!([]));
        assert_eq!(request["text"]["format"]["strict"], true);
        let input = request["input"].as_str().unwrap();
        assert!(input.contains("item-0000"));
        assert!(input.contains("Hello"));
        assert!(!input.contains("private.mod"));
        assert!(!input.contains(r"C:\private"));
        assert!(!input.contains("secret.key"));
    }

    #[test]
    fn api_errors_are_sanitized_and_never_echo_the_server_message() {
        let body = br#"{"error":{"message":"secret echoed body","code":"insufficient_quota"}}"#;
        let message = api_error(reqwest::StatusCode::TOO_MANY_REQUESTS, body);
        assert!(message.contains("quota"));
        assert!(!message.contains("secret"));
        assert_eq!(
            api_error(reqwest::StatusCode::UNAUTHORIZED, body),
            "The OpenAI API key was rejected."
        );
    }

    #[test]
    fn validation_uses_get_model_authorization_and_refuses_redirects() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 4096];
            let read = stream.read(&mut request).unwrap();
            let request = String::from_utf8_lossy(&request[..read]);
            assert!(request.starts_with("GET /v1/models/gpt-test HTTP/1.1"));
            assert!(request.contains("authorization: Bearer session-secret"));
            stream
                .write_all(
                    b"HTTP/1.1 302 Found\r\nLocation: https://example.com/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .unwrap();
        });
        let endpoints = Endpoints {
            base: reqwest::Url::parse(&format!("http://{address}/v1/")).unwrap(),
        };
        let result = tauri::async_runtime::block_on(validate_access_at(
            &endpoints,
            "session-secret",
            "gpt-test",
        ));
        server.join().unwrap();
        assert!(result.unwrap_err().contains("HTTP 302"));
    }

    #[test]
    fn session_status_exposes_model_but_never_the_key() {
        let state = AiRuntimeState::default();
        state
            .set_openai_session(
                Zeroizing::new("session-secret".to_string()),
                "gpt-test".to_string(),
            )
            .unwrap();
        let serialized = serde_json::to_string(&status(&state).unwrap()).unwrap();
        assert!(serialized.contains("gpt-test"));
        assert!(!serialized.contains("session-secret"));
        assert!(state.clear_openai_session().unwrap());
        assert!(!status(&state).unwrap().connected);
    }
}
