//! Bounded Responses parser. Only completed messages become translations.
use crate::{ai::ProviderFailure, ai_provider::*};
use futures_util::StreamExt;
use serde_json::Value;
use std::collections::BTreeMap;

const MAX_BODY: usize = 2 * 1024 * 1024;
const MAX_TEXT: usize = 512 * 1024;
fn invalid() -> ProviderFailure {
    ProviderFailure::InvalidResponse(
        "OpenAI did not return a valid completed translation. Partial output was discarded.".into(),
    )
}
#[derive(Default)]
struct ResponseState {
    items: BTreeMap<u64, Value>,
    delta_bytes: usize,
    stage: Option<ProviderActivity>,
}
impl ResponseState {
    fn activity(&mut self, stage: ProviderActivity, progress: &ProviderProgressCallback) {
        if self.stage != Some(stage) {
            self.stage = Some(stage);
            progress(ProviderProgressEvent::Activity(stage));
        }
    }
    fn event(
        &mut self,
        event: Value,
        progress: &ProviderProgressCallback,
    ) -> Result<Option<String>, ProviderFailure> {
        let kind = event["type"].as_str().ok_or_else(invalid)?;
        match kind {
            "response.output_item.done" => {
                let index = event["output_index"]
                    .as_u64()
                    .filter(|i| *i <= 100)
                    .ok_or_else(invalid)?;
                if !event["item"].is_object()
                    || self.items.insert(index, event["item"].clone()).is_some()
                {
                    return Err(invalid());
                }
            }
            "response.output_text.delta" => {
                let delta = event["delta"].as_str().ok_or_else(invalid)?;
                self.delta_bytes = self.delta_bytes.saturating_add(delta.len());
                if self.delta_bytes > MAX_TEXT {
                    return Err(invalid());
                }
                self.activity(ProviderActivity::WritingResponse, progress);
            }
            "response.completed" => {
                return self.finish(&event["response"], true, progress).map(Some)
            }
            "response.failed" | "error" => {
                // A plain `error` event carries its code at the top level.
                let error = event
                    .pointer("/response/error")
                    .or_else(|| event.get("error"))
                    .filter(|error| !error.is_null())
                    .unwrap_or(&event);
                return Err(crate::chatgpt_auth::stream_failure(error));
            }
            "response.incomplete" => return Err(invalid()),
            // A refusal concerns the content of this batch, not the run: treat
            // it like invalid output so the batch is split until the refused
            // string is isolated and every other string is still translated.
            "response.refusal.delta" | "response.refusal.done" => {
                return Err(ProviderFailure::InvalidResponse(
                    crate::chatgpt::REFUSAL_MESSAGE.into(),
                ))
            }
            kind if kind.contains("reasoning") => {
                self.activity(ProviderActivity::Reasoning, progress)
            }
            "response.created" | "response.in_progress" => {
                self.activity(ProviderActivity::Working, progress)
            }
            _ => {}
        }
        Ok(None)
    }
    fn finish(
        &self,
        response: &Value,
        sse: bool,
        progress: &ProviderProgressCallback,
    ) -> Result<String, ProviderFailure> {
        if response["status"] != "completed" || response.get("error").is_some_and(|e| !e.is_null())
        {
            return Err(invalid());
        }
        let mut output: Vec<&Value> = response["output"]
            .as_array()
            .ok_or_else(invalid)?
            .iter()
            .collect();
        // The direct ChatGPT route sometimes leaves terminal output empty.
        // Completed item events are authoritative; text deltas are never enough.
        if output.is_empty() && sse {
            output = self.items.values().collect();
        }
        let mut text = String::new();
        for item in output {
            if !item.is_object() {
                return Err(invalid());
            }
            if item["type"] != "message" || item["role"] != "assistant" {
                continue;
            }
            if item.get("status").is_some_and(|s| s != "completed") {
                return Err(invalid());
            }
            for part in item["content"].as_array().ok_or_else(invalid)? {
                if part["type"] == "refusal" {
                    return Err(invalid());
                }
                if part["type"] == "output_text" {
                    text.push_str(part["text"].as_str().ok_or_else(invalid)?);
                    if text.len() > MAX_TEXT {
                        return Err(invalid());
                    }
                }
            }
        }
        if text.trim().is_empty() {
            return Err(invalid());
        }
        if response["usage"].is_object() {
            progress(ProviderProgressEvent::Usage(ProviderTokenUsage {
                input_tokens: response["usage"]["input_tokens"].as_u64().unwrap_or(0),
                cached_input_tokens: response["usage"]["input_tokens_details"]["cached_tokens"]
                    .as_u64()
                    .unwrap_or(0),
                output_tokens: response["usage"]["output_tokens"].as_u64().unwrap_or(0),
                reasoning_output_tokens: response["usage"]["output_tokens_details"]
                    ["reasoning_tokens"]
                    .as_u64()
                    .unwrap_or(0),
            }));
        }
        progress(ProviderProgressEvent::Activity(ProviderActivity::Completed));
        Ok(text)
    }
    fn block(
        &mut self,
        bytes: &[u8],
        progress: &ProviderProgressCallback,
    ) -> Result<Option<String>, ProviderFailure> {
        let block = std::str::from_utf8(bytes).map_err(|_| invalid())?;
        let data = block
            .lines()
            .filter_map(|line| line.strip_prefix("data:"))
            .map(|s| s.strip_prefix(' ').unwrap_or(s))
            .collect::<Vec<_>>()
            .join("\n");
        if data.is_empty() || data == "[DONE]" {
            return Ok(None);
        }
        self.event(
            serde_json::from_str(&data).map_err(|_| invalid())?,
            progress,
        )
    }
}
fn separator(bytes: &[u8]) -> Option<(usize, usize)> {
    (0..bytes.len()).find_map(|i| {
        if bytes[i..].starts_with(b"\r\n\r\n") {
            Some((i, 4))
        } else if bytes[i..].starts_with(b"\n\n") {
            Some((i, 2))
        } else {
            None
        }
    })
}
pub async fn consume(
    response: reqwest::Response,
    progress: ProviderProgressCallback,
    started: std::time::Instant,
) -> Result<String, ProviderFailure> {
    let mut stream = response.bytes_stream();
    let mut buffer = Vec::new();
    let mut total = 0_usize;
    let mut state = ResponseState::default();
    let mut is_json = None;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| {
            if error.is_timeout()
                && !error.is_connect()
                && crate::chatgpt::reached_time_limit(started)
            {
                crate::chatgpt::timeout_failure()
            } else {
                ProviderFailure::Transient(
                    "The OpenAI response stream was interrupted. Try again.".into(),
                    None,
                )
            }
        })?;
        total = total.saturating_add(chunk.len());
        if total > MAX_BODY {
            return Err(invalid());
        }
        buffer.extend_from_slice(&chunk);
        if is_json.is_none() {
            is_json = buffer
                .iter()
                .find(|b| !b.is_ascii_whitespace())
                .map(|b| *b == b'{');
        }
        // Sniff the actual body: the direct route may omit the SSE media type.
        if is_json != Some(false) {
            continue;
        }
        while let Some((offset, length)) = separator(&buffer) {
            if let Some(text) = state.block(&buffer[..offset], &progress)? {
                return Ok(text);
            }
            buffer.drain(..offset + length);
        }
    }
    if is_json == Some(true) {
        let data: Value = serde_json::from_slice(&buffer).map_err(|_| invalid())?;
        if data["type"] == "response.completed" {
            return state.finish(&data["response"], false, &progress);
        }
        if data["object"] == "response" {
            return state.finish(&data, false, &progress);
        }
    } else if let Some(text) = state.block(&buffer, &progress)? {
        return Ok(text);
    }
    Err(invalid())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Arc;
    fn progress() -> ProviderProgressCallback {
        Arc::new(|_| {})
    }
    fn message() -> Value {
        json!({"type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"{\"items\":[]}"}]})
    }
    #[test]
    fn finished_items_supply_text_when_terminal_output_is_empty() {
        let mut state = ResponseState::default();
        assert!(state
            .event(
                json!({"type":"response.output_item.done","output_index":0,"item":message()}),
                &progress()
            )
            .unwrap()
            .is_none());
        assert_eq!(state.event(json!({"type":"response.completed","response":{"status":"completed","output":[]}}), &progress()).unwrap(), Some("{\"items\":[]}".into()));
    }
    #[test]
    fn deltas_never_authorize_partial_output() {
        let mut state = ResponseState::default();
        state
            .event(
                json!({"type":"response.output_text.delta","delta":"partial"}),
                &progress(),
            )
            .unwrap();
        assert!(state
            .finish(
                &json!({"status":"completed","output":[]}),
                true,
                &progress()
            )
            .is_err());
        assert!(state
            .finish(
                &json!({"status":"incomplete","output":[message()]}),
                true,
                &progress()
            )
            .is_err());
    }
    #[test]
    fn incomplete_responses_discard_finished_items_and_deltas() {
        let mut state = ResponseState::default();
        state
            .event(
                json!({"type":"response.output_item.done","output_index":0,"item":message()}),
                &progress(),
            )
            .unwrap();
        state
            .event(
                json!({"type":"response.output_text.delta","delta":"partial"}),
                &progress(),
            )
            .unwrap();
        let failure = state
            .event(
                json!({"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}}}),
                &progress(),
            )
            .unwrap_err();
        let ProviderFailure::InvalidResponse(message) = failure else {
            panic!("an incomplete response is invalid output, not a transient failure");
        };
        assert!(message.contains("Partial output was discarded"));
    }
    #[test]
    fn refusal_events_are_splittable_batch_failures() {
        for kind in ["response.refusal.delta", "response.refusal.done"] {
            let mut state = ResponseState::default();
            let failure = state
                .event(json!({"type": kind, "delta": "no"}), &progress())
                .unwrap_err();
            assert!(
                matches!(failure, ProviderFailure::InvalidResponse(_)),
                "{kind}"
            );
        }
    }
    #[test]
    fn stream_error_events_report_no_http_status_and_busy_codes_are_transient() {
        let fail = |event: Value| {
            ResponseState::default()
                .event(event, &progress())
                .unwrap_err()
        };
        for event in [
            json!({"type":"response.failed","response":{"error":{"code":"server_is_overloaded"}}}),
            json!({"type":"error","error":{"code":"server_error"}}),
        ] {
            assert!(
                matches!(fail(event.clone()), ProviderFailure::Transient(..)),
                "{event}"
            );
        }
        for event in [
            json!({"type":"error","code":"invalid_prompt","message":"SECRET"}),
            // Rate limits stop the run until real 429 data says otherwise (PD-3).
            json!({"type":"error","code":"rate_limit_exceeded","message":"SECRET"}),
            json!({"type":"response.failed","response":{"error":null}}),
        ] {
            let ProviderFailure::Message(message) = fail(event) else {
                panic!("an unknown stream error is not retried");
            };
            assert!(!message.contains("HTTP"));
            assert!(!message.contains("SECRET"));
        }
        let ProviderFailure::Message(message) =
            fail(json!({"type":"error","code":"subscription_sharing_usage_limit_exceeded"}))
        else {
            panic!("a usage limit is not retried");
        };
        assert!(message.contains("usage limit"));
        assert!(!message.contains("HTTP"));
    }
    #[test]
    fn invalid_duplicate_and_refused_output_is_rejected() {
        let mut state = ResponseState::default();
        let item = json!({"type":"response.output_item.done","output_index":0,"item":message()});
        state.event(item.clone(), &progress()).unwrap();
        assert!(state.event(item, &progress()).is_err());
        assert!(state
            .event(
                json!({"type":"response.output_item.done","output_index":101,"item":message()}),
                &progress()
            )
            .is_err());
        for status in ["failed", "incomplete"] {
            assert!(state
                .finish(
                    &json!({"status":status,"output":[message()]}),
                    true,
                    &progress()
                )
                .is_err());
        }
        let refused = json!({"type":"message","role":"assistant","content":[{"type":"refusal"}]});
        assert!(state
            .finish(
                &json!({"status":"completed","output":[refused]}),
                true,
                &progress()
            )
            .is_err());
    }
    #[test]
    fn crlf_and_multiline_sse_parse_and_utf8_is_strict() {
        assert_eq!(separator(b"event: x\r\ndata: x\r\n\r\n"), Some((17, 4)));
        let bytes = b"event: response.completed\r\ndata: {\"type\":\"response.completed\",\r\ndata: \"response\":{\"status\":\"completed\",\"output\":[{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"Hallo\"}]}]}}";
        assert_eq!(
            ResponseState::default().block(bytes, &progress()).unwrap(),
            Some("Hallo".into())
        );
        assert!(ResponseState::default()
            .block(&[0xff], &progress())
            .is_err());
    }
    #[tokio::test]
    async fn actual_http_stream_handles_split_utf8_missing_media_type_and_completion() {
        use tokio::{
            io::{AsyncReadExt, AsyncWriteExt},
            net::TcpListener,
        };
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let output = json!({"type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Grüße"}]});
        let body = format!(
            "data: {}\r\n\r\ndata: {}\r\n\r\n",
            json!({"type":"response.output_item.done","output_index":0,"item":output}),
            json!({"type":"response.completed","response":{"status":"completed","output":[]}})
        );
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 4096];
            assert!(stream.read(&mut request).await.unwrap() > 0);
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
                )
                .await
                .unwrap();
            // Single-byte chunks split both UTF-8 codepoints and SSE delimiters.
            for byte in body.bytes() {
                stream
                    .write_all(&[b'1', b'\r', b'\n', byte, b'\r', b'\n'])
                    .await
                    .unwrap();
            }
            let _ = stream.write_all(b"0\r\n\r\n").await;
        });
        let response = reqwest::Client::new()
            .get(format!("http://{address}"))
            .send()
            .await
            .unwrap();
        assert_eq!(
            consume(response, progress(), std::time::Instant::now())
                .await
                .unwrap(),
            "Grüße"
        );
        server.await.unwrap();
    }
}
