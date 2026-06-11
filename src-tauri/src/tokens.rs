//! Protected-token extraction — M3 (SPEC §10).
//!
//! A faithful Rust port of the frontend `protectedTokens.ts`. These are the
//! tokens a translation MUST preserve or the mod breaks at runtime (Content
//! Patcher `{{...}}`, gender switch `${...}$`, mail commands, dialogue breaks,
//! brackets, positional `{0}`, dialogue commands `$b`, structural `#` / paired
//! `'` quote delimiters, and single-char `@`/`^`).
//!
//! The exporter uses [`missing_tokens`] to skip strings that dropped a required
//! source token (the `token-missing` error rule). Tokens are compared as
//! multisets, so a dropped *second* `$b` is caught too. Keeping this in sync
//! with the TS reader is covered by shared-case tests in both languages.

use std::collections::HashMap;

/// Extract every protected token from `value`, in order, as raw substrings.
pub fn extract(value: &str) -> Vec<String> {
    let chars: Vec<char> = value.chars().collect();
    let mut tokens = Vec::new();
    let mut offset = 0;

    while offset < chars.len() {
        let end = read_content_patcher(&chars, offset)
            .or_else(|| read_gender_switch(&chars, offset))
            .or_else(|| read_mail_command(&chars, offset))
            .or_else(|| read_dialogue_break(&chars, offset))
            .or_else(|| read_bracket(&chars, offset))
            .or_else(|| read_positional(&chars, offset))
            .or_else(|| read_simple_dialogue(&chars, offset))
            .or_else(|| read_single_char(&chars, offset));

        match end {
            Some(end) => {
                tokens.push(chars[offset..end].iter().collect());
                offset = end;
            }
            None => offset += 1,
        }
    }

    tokens
}

/// Newlines are **layout, not syntax**: a translation often legitimately needs
/// a different number of line breaks (German runs ~25% longer than English),
/// and a changed `\n` count never breaks the mod at runtime. They are still
/// *extracted* (the editor shows them as chips and the frontend raises the
/// `newline-mismatch` **warning**), but they are excluded from the
/// missing-token **error** — which would skip the string on export and make
/// the AI retry pointlessly (SPEC §10).
fn is_layout_token(token: &str) -> bool {
    token == "\n"
}

/// True if `target` is missing (or under-represents) any protected token that
/// appears in `source` — the export `token-missing` skip rule. Layout tokens
/// (newlines) are exempt; they surface as a warning, never an error.
pub fn missing_tokens(source: &str, target: &str) -> bool {
    let source_counts = counts(source);
    let target_counts = counts(target);
    source_counts
        .iter()
        .filter(|(token, _)| !is_layout_token(token))
        .any(|(token, count)| target_counts.get(token).copied().unwrap_or(0) < *count)
}

/// The protected tokens that `target` is missing (or under-represents) relative
/// to `source`, each listed once. Empty when nothing is missing. Used by the
/// local-LLM translator (M6) to flag/retry a result that dropped a token.
/// Layout tokens (newlines) are exempt, like in [`missing_tokens`].
pub fn missing_token_list(source: &str, target: &str) -> Vec<String> {
    let source_counts = counts(source);
    let target_counts = counts(target);
    let mut missing: Vec<String> = source_counts
        .iter()
        .filter(|(token, _)| !is_layout_token(token))
        .filter(|(token, count)| target_counts.get(*token).copied().unwrap_or(0) < **count)
        .map(|(token, _)| token.clone())
        .collect();
    missing.sort();
    missing
}

fn counts(value: &str) -> HashMap<String, usize> {
    let mut map = HashMap::new();
    for token in extract(value) {
        *map.entry(token).or_insert(0) += 1;
    }
    map
}

fn starts_with(chars: &[char], offset: usize, pat: &str) -> bool {
    let pattern: Vec<char> = pat.chars().collect();
    offset + pattern.len() <= chars.len() && chars[offset..offset + pattern.len()] == pattern[..]
}

/// First index `>= from` where `pat` begins, if any.
fn find_sub(chars: &[char], from: usize, pat: &str) -> Option<usize> {
    (from..chars.len()).find(|&i| starts_with(chars, i, pat))
}

fn find_char(chars: &[char], from: usize, c: char) -> Option<usize> {
    (from..chars.len()).find(|&i| chars[i] == c)
}

/// Match a positional placeholder `{<digits>}` at `i`, returning its end index.
fn match_positional(chars: &[char], i: usize) -> Option<usize> {
    if chars.get(i) != Some(&'{') {
        return None;
    }
    let mut j = i + 1;
    let first_digit = j;
    while j < chars.len() && chars[j].is_ascii_digit() {
        j += 1;
    }
    if j == first_digit || chars.get(j) != Some(&'}') {
        return None;
    }
    Some(j + 1)
}

fn read_content_patcher(chars: &[char], offset: usize) -> Option<usize> {
    if !starts_with(chars, offset, "{{") {
        return None;
    }
    let mut depth: i32 = 0;
    let mut index = offset;
    let limit = chars.len().saturating_sub(1);
    while index < limit {
        if let Some(end) = match_positional(chars, index) {
            index = end;
            continue;
        }
        if starts_with(chars, index, "{{") {
            depth += 1;
            index += 2;
            continue;
        }
        if starts_with(chars, index, "}}") {
            depth -= 1;
            index += 2;
            if depth == 0 {
                return Some(index);
            }
            continue;
        }
        index += 1;
    }
    None
}

fn read_gender_switch(chars: &[char], offset: usize) -> Option<usize> {
    if !starts_with(chars, offset, "${") {
        return None;
    }
    find_sub(chars, offset + 2, "}$").map(|i| i + 2)
}

fn read_mail_command(chars: &[char], offset: usize) -> Option<usize> {
    if starts_with(chars, offset, "[#]") {
        return Some(offset + 3);
    }
    if !starts_with(chars, offset, "%item ") && !starts_with(chars, offset, "%action ") {
        return None;
    }
    find_sub(chars, offset, "%%").map(|i| i + 2)
}

fn read_dialogue_break(chars: &[char], offset: usize) -> Option<usize> {
    if !starts_with(chars, offset, "#$") {
        return None;
    }
    find_char(chars, offset + 2, '#').map(|i| i + 1)
}

fn read_bracket(chars: &[char], offset: usize) -> Option<usize> {
    if chars.get(offset) != Some(&'[') {
        return None;
    }
    find_char(chars, offset + 1, ']').map(|i| i + 1)
}

fn read_positional(chars: &[char], offset: usize) -> Option<usize> {
    match_positional(chars, offset)
}

fn read_simple_dialogue(chars: &[char], offset: usize) -> Option<usize> {
    if chars.get(offset) != Some(&'$') {
        return None;
    }
    let mut j = offset + 1;
    if j < chars.len() && chars[j].is_ascii_alphabetic() {
        while j < chars.len() && chars[j].is_ascii_alphabetic() {
            j += 1;
        }
        Some(j)
    } else if j < chars.len() && chars[j].is_ascii_digit() {
        while j < chars.len() && chars[j].is_ascii_digit() {
            j += 1;
        }
        Some(j)
    } else {
        None
    }
}

fn read_single_char(chars: &[char], offset: usize) -> Option<usize> {
    match chars.get(offset) {
        Some('@') | Some('^') | Some('#') | Some('\n') => Some(offset + 1),
        Some('\'') if is_paired_quote_delimiter(chars, offset) => Some(offset + 1),
        _ => None,
    }
}

/// Apostrophes inside words (`don't`, `farmer's`) are prose, not syntax.
/// Standalone single quotes are protected only when they form a balanced pair.
fn is_paired_quote_delimiter(chars: &[char], offset: usize) -> bool {
    if chars.get(offset) != Some(&'\'') || is_word_apostrophe(chars, offset) {
        return false;
    }
    let delimiters = chars
        .iter()
        .enumerate()
        .filter(|(index, ch)| **ch == '\'' && !is_word_apostrophe(chars, *index))
        .count();
    delimiters >= 2 && delimiters % 2 == 0
}

fn is_word_apostrophe(chars: &[char], offset: usize) -> bool {
    offset > 0
        && offset + 1 < chars.len()
        && chars[offset - 1].is_alphanumeric()
        && chars[offset + 1].is_alphanumeric()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_content_patcher_and_dialogue_tokens() {
        let tokens = extract("Hi {{name}}, welcome!#$b#See you @ soon^bye");
        assert_eq!(tokens, vec!["{{name}}", "#$b#", "@", "^"]);
    }

    #[test]
    fn extracts_structural_hash_quotes_and_repeated_carets() {
        assert_eq!(
            extract("'test' # next^^line"),
            vec!["'", "'", "#", "^", "^"]
        );
        assert!(extract("Don't change the farmer's hat.").is_empty());
    }

    #[test]
    fn extracts_nested_content_patcher() {
        let tokens = extract("{{Lookup:{{Other}}}}");
        assert_eq!(tokens, vec!["{{Lookup:{{Other}}}}"]);
    }

    #[test]
    fn extracts_gender_switch_and_mail_and_bracket() {
        let tokens = extract("${he^she}$ got [#] and %item 388 5 %%");
        assert_eq!(tokens, vec!["${he^she}$", "[#]", "%item 388 5 %%"]);
    }

    #[test]
    fn missing_token_detected_as_multiset() {
        // Source has two `$b`; target keeps only one -> missing.
        assert!(missing_tokens("a$b c$b d", "a$b c d"));
        // All present -> not missing.
        assert!(!missing_tokens("Hi {{name}}", "Hallo {{name}}"));
        // Extra token in target is not a *missing* one.
        assert!(!missing_tokens("Hi", "Hallo {{name}}"));
    }

    #[test]
    fn missing_token_list_reports_each_missing_token_once() {
        // Two `$b` in source, one in target -> `$b` reported; `{{name}}` is fine.
        assert_eq!(
            missing_token_list("Hi {{name}}$b more$b", "Hallo {{name}}$b mehr"),
            vec!["$b".to_string()],
        );
        // Nothing missing.
        assert!(missing_token_list("Hi {{name}}", "Hallo {{name}}").is_empty());
    }

    #[test]
    fn plain_text_has_no_tokens() {
        assert!(extract("Just some plain words.").is_empty());
        assert!(!missing_tokens("Hello world", "Hallo Welt"));
    }

    #[test]
    fn newline_differences_are_layout_not_missing_tokens() {
        // A translation may rewrap lines freely (German runs longer) — fewer
        // or more newlines must never block export or trigger an AI retry.
        assert!(!missing_tokens(
            "line one\nline two\nline three",
            "Zeile eins\nZeile zwei"
        ));
        assert!(missing_token_list("a\nb\nc", "abc").is_empty());
        // Real tokens are still enforced even when newlines also differ.
        assert!(missing_tokens("Hi {{name}}\nmore", "Hallo"));
        assert_eq!(
            missing_token_list("Hi {{name}}\nmore", "Hallo"),
            vec!["{{name}}"]
        );
    }

    /// Drift guard against the TS extractor: both suites run the same fixture
    /// (`tests/fixtures/token-cases.json`). The two implementations are
    /// hand-synced ports — a divergence means the editor's live validation and
    /// the export skip rule disagree, the worst kind of inconsistency.
    #[test]
    fn shared_fixture_cases_match() {
        let body = include_str!("../../tests/fixtures/token-cases.json");
        let parsed: serde_json::Value = serde_json::from_str(body).unwrap();
        let cases = parsed["cases"].as_array().expect("fixture has cases");
        assert!(cases.len() >= 10, "fixture should stay comprehensive");
        for case in cases {
            let value = case["value"].as_str().unwrap();
            let expected: Vec<String> = case["tokens"]
                .as_array()
                .unwrap()
                .iter()
                .map(|token| token.as_str().unwrap().to_string())
                .collect();
            assert_eq!(extract(value), expected, "extract({value:?})");
        }
    }
}
