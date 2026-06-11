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

use serde::{Deserialize, Serialize};

use crate::tokens;

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

// ---------------------------------------------------------------------------
// Translation (Issue 16): translate one string via POST /v1/chat/completions.
// ---------------------------------------------------------------------------

/// Result of a single-string translation. `missing_tokens` is non-empty when the
/// model dropped a protected token even after one stricter retry — the UI flags
/// it for a manual fix (never a silent corruption). `glossary_misses` lists
/// injected official terms the model appears not to have used — a **soft**
/// warning only (German inflection makes exact matching too strict to enforce).
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TranslationResult {
    pub text: String,
    pub missing_tokens: Vec<String>,
    pub glossary_misses: Vec<String>,
}

#[derive(Serialize)]
struct ChatMessage {
    role: &'static str,
    content: String,
}

#[derive(Serialize)]
struct ChatRequest {
    model: String,
    messages: Vec<ChatMessage>,
    temperature: f32,
    stream: bool,
    /// Hard cap on generated tokens. Without it a weak model can run away for
    /// thousands of tokens (observed: a 4-word source produced a 6000-token
    /// essay), which both wastes time and trips the request timeout.
    max_tokens: u32,
    /// Stop sequences. For a single-line source we stop at the first newline:
    /// a newline is a protected token, so a one-line source must translate to
    /// one line — this turns a chatty model's runaway into just the translation.
    #[serde(skip_serializing_if = "Option::is_none")]
    stop: Option<Vec<String>>,
}

/// A bounded output-token budget for translating `source`. Generous (≈2× the
/// source character count, so well above a real translation's need) but capped,
/// so a runaway model is stopped quickly instead of hanging.
fn output_token_budget(source: &str) -> u32 {
    ((source.chars().count() as u32).saturating_mul(2)).clamp(64, 1024)
}

/// Stop sequences for translating `source`. A source with no newline must
/// translate to a single line (newlines are protected tokens), so we stop at the
/// first `\n` — cutting off a model that keeps talking after the translation.
/// Multi-line sources get no stop (their own newlines are legitimate).
fn stop_sequences(source: &str) -> Option<Vec<String>> {
    if source.contains('\n') {
        None
    } else {
        Some(vec!["\n".to_string()])
    }
}

/// The default sampling temperature: low — translation wants consistency.
const DEFAULT_TEMPERATURE: f32 = 0.2;

/// The temperature to request: the user's setting, clamped to a sane sampling
/// range, or the low default.
fn effective_temperature(setting: Option<f32>) -> f32 {
    setting
        .filter(|t| t.is_finite())
        .map(|t| t.clamp(0.0, 2.0))
        .unwrap_or(DEFAULT_TEMPERATURE)
}

/// Injected glossary terms the translation appears not to use, as
/// `"English -> Target"` labels. **Soft** check: a case-insensitive substring
/// match on the target term, so inflected forms still count (German
/// "Pastinaken" contains "Pastinake"). Misses are a hint, never an error.
fn glossary_misses(target: &str, glossary_pairs: &[(String, String)]) -> Vec<String> {
    let haystack = target.to_lowercase();
    glossary_pairs
        .iter()
        .filter(|(_, term)| !haystack.contains(&term.to_lowercase()))
        .map(|(en, term)| format!("{en} -> {term}"))
        .collect()
}

#[derive(Deserialize)]
struct ChatResponse {
    #[serde(default)]
    choices: Vec<ChatChoice>,
}

#[derive(Deserialize)]
struct ChatChoice {
    message: ChatChoiceMessage,
}

#[derive(Deserialize)]
struct ChatChoiceMessage {
    #[serde(default)]
    content: String,
}

/// Build the chat messages for one translation. Pure (no I/O) so it is unit-
/// tested. `glossary_pairs` are injected as exact-term guidance; `retry_missing`,
/// when present, adds a stricter reminder listing tokens a prior attempt dropped.
fn build_messages(
    source: &str,
    target_language: &str,
    glossary_pairs: &[(String, String)],
    retry_missing: Option<&[String]>,
) -> Vec<ChatMessage> {
    let mut system = String::new();
    system.push_str(&format!(
        "You are a professional translator for Stardew Valley mods. \
         Translate the user's text from English into {target_language}.\n\
         Rules:\n\
         - Output ONLY the translation. No quotes, no explanations, no notes.\n\
         - Preserve every placeholder/token EXACTLY as written and untranslated, \
           e.g. {{{{Token}}}}, {{0}}, $b, ${{a^b}}$, [item], %item ... %%, @, ^, #$b#. \
           Do not add, remove, reorder, or alter them.\n\
         - Keep the same line breaks.\n\
         - Translate naturally and concisely; keep game terminology consistent."
    ));

    if !glossary_pairs.is_empty() {
        system
            .push_str("\nOfficial glossary — use these exact target terms when the word appears:");
        for (en, target) in glossary_pairs {
            system.push_str(&format!("\n- {en} -> {target}"));
        }
    }

    if let Some(missing) = retry_missing {
        if !missing.is_empty() {
            system.push_str(&format!(
                "\nIMPORTANT: your previous attempt dropped these required tokens: {}. \
                 You MUST include every one of them verbatim in the translation.",
                missing.join(", ")
            ));
        }
    }

    vec![
        ChatMessage {
            role: "system",
            content: system,
        },
        ChatMessage {
            role: "user",
            content: source.to_string(),
        },
    ]
}

/// POST one chat completion and return the assistant's (trimmed) content.
async fn chat(
    base_url: &str,
    model: &str,
    messages: Vec<ChatMessage>,
    temperature: f32,
    max_tokens: u32,
    stop: Option<Vec<String>>,
) -> Result<String, String> {
    let url = {
        let trimmed = base_url.trim().trim_end_matches('/');
        format!("{trimmed}/chat/completions")
    };
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|error| format!("Could not create HTTP client: {error}"))?;

    let response = client
        .post(&url)
        .json(&ChatRequest {
            model: model.to_string(),
            messages,
            temperature,
            stream: false,
            max_tokens,
            stop,
        })
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                format!(
                    "The model timed out — it may be too slow or stuck. Try a smaller/faster \
                     instruct model, or a shorter string. ({url})"
                )
            } else {
                format!("Could not reach {url} — is the server running? ({error})")
            }
        })?;

    if !response.status().is_success() {
        return Err(format!("Server returned {} for {url}.", response.status()));
    }

    let parsed: ChatResponse = response
        .json()
        .await
        .map_err(|error| format!("Could not parse the model response: {error}"))?;

    parsed
        .choices
        .into_iter()
        .next()
        .map(|choice| choice.message.content.trim().to_string())
        .filter(|text| !text.is_empty())
        .ok_or_else(|| "The model returned an empty response.".to_string())
}

/// Translate one source string. Validates protected tokens against the source;
/// on a dropped token, retries once with a stricter reminder and returns the
/// better of the two attempts (with any still-missing tokens flagged). Injected
/// glossary terms that the result does not appear to use are reported softly.
pub async fn translate(
    base_url: &str,
    model: &str,
    source: &str,
    target_language: &str,
    glossary_pairs: &[(String, String)],
    temperature: Option<f32>,
) -> Result<TranslationResult, String> {
    let budget = output_token_budget(source);
    let stop = stop_sequences(source);
    let temperature = effective_temperature(temperature);
    let result = |text: String, missing_tokens: Vec<String>| TranslationResult {
        glossary_misses: glossary_misses(&text, glossary_pairs),
        text,
        missing_tokens,
    };

    let first = chat(
        base_url,
        model,
        build_messages(source, target_language, glossary_pairs, None),
        temperature,
        budget,
        stop.clone(),
    )
    .await?;
    let missing = tokens::missing_token_list(source, &first);
    if missing.is_empty() {
        return Ok(result(first, vec![]));
    }

    let second = chat(
        base_url,
        model,
        build_messages(source, target_language, glossary_pairs, Some(&missing)),
        temperature,
        budget,
        stop,
    )
    .await?;
    let missing_second = tokens::missing_token_list(source, &second);

    // Prefer the retry only if it is at least as good as the first attempt.
    if missing_second.len() <= missing.len() {
        Ok(result(second, missing_second))
    } else {
        Ok(result(first, missing))
    }
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
        assert_eq!(
            models_url("http://localhost:1234/v1"),
            "http://localhost:1234/v1/models"
        );
        assert_eq!(
            models_url("http://localhost:1234/v1/"),
            "http://localhost:1234/v1/models"
        );
        assert_eq!(
            models_url("  http://localhost:11434/v1  "),
            "http://localhost:11434/v1/models"
        );
    }

    #[test]
    fn messages_carry_target_language_rules_and_source() {
        let messages = build_messages("Hello {{name}}", "German", &[], None);
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, "system");
        assert!(messages[0].content.contains("into German"));
        assert!(messages[0]
            .content
            .contains("Preserve every placeholder/token"));
        assert_eq!(messages[1].role, "user");
        assert_eq!(messages[1].content, "Hello {{name}}");
    }

    #[test]
    fn glossary_pairs_are_injected_into_the_system_prompt() {
        let pairs = vec![("Parsnip".to_string(), "Pastinake".to_string())];
        let messages = build_messages("A parsnip", "German", &pairs, None);
        assert!(messages[0].content.contains("Official glossary"));
        assert!(messages[0].content.contains("Parsnip -> Pastinake"));
    }

    #[test]
    fn single_line_source_stops_at_newline() {
        // One-line source → stop at the first newline (cuts a chatty model off).
        assert_eq!(
            stop_sequences("UI Info Suite Options"),
            Some(vec!["\n".to_string()])
        );
        // Multi-line source → no stop (its newlines are legitimate).
        assert_eq!(stop_sequences("Hello#$b#World\nmore"), None);
    }

    #[test]
    fn output_budget_is_bounded() {
        // Short source → the floor (so a runaway is cut off quickly).
        assert_eq!(output_token_budget("UI Info Suite Options"), 64);
        // Long source → scales, but stays capped.
        let long = "x".repeat(5000);
        assert_eq!(output_token_budget(&long), 1024);
        // Mid-length source → ~2× the character count.
        assert_eq!(output_token_budget(&"y".repeat(100)), 200);
    }

    #[test]
    fn effective_temperature_defaults_and_clamps() {
        assert_eq!(effective_temperature(None), 0.2);
        assert_eq!(effective_temperature(Some(0.7)), 0.7);
        // Out-of-range / nonsense values are clamped or fall back.
        assert_eq!(effective_temperature(Some(-1.0)), 0.0);
        assert_eq!(effective_temperature(Some(99.0)), 2.0);
        assert_eq!(effective_temperature(Some(f32::NAN)), 0.2);
    }

    #[test]
    fn glossary_misses_are_soft_and_inflection_tolerant() {
        let pairs = vec![
            ("Parsnip".to_string(), "Pastinake".to_string()),
            ("Spring".to_string(), "Frühling".to_string()),
        ];
        // Inflected form ("Pastinaken") still counts as used; "Frühling" absent.
        assert_eq!(
            glossary_misses("Ich pflanze Pastinaken an.", &pairs),
            vec!["Spring -> Frühling".to_string()],
        );
        // Case-insensitive.
        assert!(glossary_misses("FRÜHLING und pastinake", &pairs).is_empty());
        // No injected pairs -> no misses.
        assert!(glossary_misses("anything", &[]).is_empty());
    }

    #[test]
    fn retry_reminder_lists_the_dropped_tokens() {
        let missing = vec!["{{name}}".to_string(), "$b".to_string()];
        let messages = build_messages("Hi {{name}}$b", "German", &[], Some(&missing));
        assert!(messages[0]
            .content
            .contains("dropped these required tokens"));
        assert!(messages[0].content.contains("{{name}}"));
        assert!(messages[0].content.contains("$b"));
    }
}
