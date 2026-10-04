use super::*;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::Instant;

fn completions(replies: &[&str]) -> (String, std::thread::JoinHandle<Vec<serde_json::Value>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    listener.set_nonblocking(true).unwrap();
    let replies = replies
        .iter()
        .map(|reply| reply.to_string())
        .collect::<Vec<_>>();
    let worker = std::thread::spawn(move || {
        let mut requests = Vec::new();
        for reply in replies {
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(
                            Instant::now() < deadline,
                            "Expected a bounded translation request."
                        );
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("Mock completion accept failed: {error}"),
                }
            };
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut bytes = Vec::new();
            let (body_start, length) = loop {
                let mut chunk = [0u8; 4096];
                let read = stream.read(&mut chunk).unwrap();
                assert!(read > 0, "Request ended before its headers.");
                bytes.extend_from_slice(&chunk[..read]);
                if let Some(end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
                    let headers = std::str::from_utf8(&bytes[..end]).unwrap();
                    assert!(headers.starts_with("POST /v1/chat/completions HTTP/1.1"));
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            let (key, value) = line.split_once(':')?;
                            key.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().unwrap())
                        })
                        .unwrap();
                    break (end + 4, length);
                }
            };
            while bytes.len() < body_start + length {
                let mut chunk = [0u8; 4096];
                let read = stream.read(&mut chunk).unwrap();
                assert!(read > 0, "Request ended before its JSON body.");
                bytes.extend_from_slice(&chunk[..read]);
            }
            requests.push(serde_json::from_slice(&bytes[body_start..body_start + length]).unwrap());
            let body = serde_json::to_vec(&serde_json::json!({
                "choices": [{"message": {"content": reply}, "finish_reason": "stop"}]
            }))
            .unwrap();
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).unwrap();
            stream.write_all(&body).unwrap();
        }
        requests
    });
    (format!("http://{address}/v1"), worker)
}

fn translate(source: &str, replies: &[&str]) -> (TranslationResult, Vec<serde_json::Value>) {
    let (url, worker) = completions(replies);
    let result = tauri::async_runtime::block_on(translate_with_context(
        &url,
        "synthetic-instruct",
        source,
        "German",
        None,
        &[],
        &["Neighbor {{Other}}".to_string()],
        &[],
        None,
    ));
    let requests = worker.join().unwrap();
    (result.unwrap(), requests)
}

#[test]
fn repairs_missing_unexpected_duplicate_and_underrepresented_runtime_tokens() {
    for (source, first, repaired) in [
        ("Hello {{name}}!", "Hallo!", "Hallo {{name}}!"),
        (
            "Hello {{name}}!",
            "Hallo {{name}} {{Other}}!",
            "Hallo {{name}}!",
        ),
        (
            "Hello {{name}}!",
            "Hallo {{name}} {{name}}!",
            "Hallo {{name}}!",
        ),
        (
            "{{Count}} now, {{Count}} later.",
            "{{Count}} jetzt.",
            "{{Count}} jetzt, {{Count}} später.",
        ),
        (
            "${He^She}$ has {{Item}}.",
            "${Er^Sie}$ ${Er^Sie}$ hat {{Item}}.",
            "${Er^Sie}$ hat {{Item}}.",
        ),
    ] {
        let (result, requests) = translate(source, &[first, repaired]);
        assert_eq!(result.text, repaired);
        assert!(result.missing_tokens.is_empty());
        assert!(tokens::token_differences(source, &result.text).is_empty());
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0]["messages"][1], requests[1]["messages"][1]);
        let reminder = requests[1]["messages"][0]["content"].as_str().unwrap();
        for difference in tokens::token_differences(source, first) {
            let token = serde_json::to_string(&difference.token).unwrap();
            assert!(reminder.contains(&format!(
                "{token}: expected {}, previous response {}",
                difference.source_count, difference.target_count
            )));
        }
        assert_eq!(requests[0]["temperature"], requests[1]["temperature"]);
        assert_eq!(requests[0]["max_tokens"], requests[1]["max_tokens"]);
    }
}

#[test]
fn retains_first_draft_when_retry_is_equal_worse_or_damages_another_token() {
    for (source, first, retry) in [
        ("Hello {{name}}!", "Hallo!", "Guten Tag!"),
        ("Hello {{name}}!", "Hallo!", "Hallo {{name}} {{name}}!"),
        (
            "{{name}} gets {{Item}}.",
            "Hallo!",
            "{{name}} bekommt {{Item}} {{Other}}.",
        ),
        (
            "Hello {{name}}!",
            "Hallo {{name}} {{Other}}!",
            "Hallo {{name}} {{Other}} {{Other}}!",
        ),
    ] {
        let (result, requests) = translate(source, &[first, retry]);
        assert_eq!(result.text, first);
        assert_eq!(requests.len(), 2);
        assert!(!tokens::token_differences(source, &result.text).is_empty());
    }
}

#[test]
fn partially_improved_retry_remains_invalid_without_a_third_request() {
    let source = "{{Count}} now, {{Count}} later.";
    let (result, requests) = translate(
        source,
        &["Jetzt und später.", "{{Count}} jetzt und später."],
    );
    assert_eq!(result.text, "{{Count}} jetzt und später.");
    assert_eq!(result.missing_tokens, vec!["{{Count}}"]);
    assert_eq!(requests.len(), 2);
    assert!(!tokens::token_differences(source, &result.text).is_empty());
}

#[test]
fn preserves_legitimate_quotes_and_does_not_retry_soft_layout_differences() {
    for (source, translated) in [
        ("\"Hello {{name}}!\"", "\"Hallo {{name}}!\""),
        ("'Hello {{name}}!'", "'Hallo {{name}}!'"),
        ("Hello {{name}}!", "Hallo\n{{name}}!"),
    ] {
        let (result, requests) = translate(source, &[translated]);
        assert_eq!(result.text, translated);
        assert_eq!(requests.len(), 1);
        assert!(result.missing_tokens.is_empty());
    }
}

#[test]
fn encoded_translation_is_decoded_before_saving_or_retrying_tokens() {
    for (source, translated) in [
        ("Hello {{name}}!", "Hallo {{name}}!"),
        ("\"Hello {{name}}!\"", "\"Hallo {{name}}!\""),
    ] {
        let encoded = serde_json::to_string(translated).unwrap();
        let (result, requests) = translate(source, &[&encoded]);
        assert_eq!(result.text, translated);
        assert_eq!(requests.len(), 1);
    }
    let first = serde_json::to_string("Hallo {{name}} {{Other}}!").unwrap();
    let repaired = serde_json::to_string("Hallo {{name}}!").unwrap();
    let (result, requests) = translate("Hello {{name}}!", &[&first, &repaired]);
    assert_eq!(result.text, "Hallo {{name}}!");
    assert_eq!(requests.len(), 2);
    assert!(requests[1]["messages"][0]["content"]
        .as_str()
        .unwrap()
        .contains("\"{{Other}}\": expected 0, previous response 1"));
}
