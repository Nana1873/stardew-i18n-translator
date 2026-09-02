//! Protected-token extraction (SPEC §10).
//!
//! A faithful Rust port of the frontend `protectedTokens.ts`. Most results are
//! literal tokens a translation MUST preserve; well-formed gender switches use
//! a canonical per-block shape such as `${^}$` so separate blocks can't mask
//! each other's structural damage. The remaining forms cover Content Patcher
//! `{{...}}`, mail commands, dialogue breaks, recognized bracket tokens,
//! positional `{0}`, dialogue commands `$b`, structural `#` / paired `'`
//! quote delimiters, and single-char `@`/`^`.
//!
//! Export and batch import use [`token_differences`] for their blocking
//! `token-missing` rule. Tokens are compared as multisets, so a dropped second
//! `$b` is caught too. Keeping this in sync with the TS reader is covered by
//! shared-case tests in both languages.

use std::collections::HashMap;

/// Extract every protected token or switch-shape identity from `value`.
pub fn extract(value: &str) -> Vec<String> {
    let chars: Vec<char> = value.chars().collect();
    extract_chars(&chars)
}

fn extract_chars(chars: &[char]) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut offset = 0;

    while offset < chars.len() {
        if starts_with(chars, offset, "${") {
            if let Some((end, switch_tokens)) = read_gender_switch(chars, offset) {
                tokens.extend(switch_tokens);
                offset = end;
            } else {
                // Keep a damaged opener visible to the multiset comparison.
                // Scanning resumes inside it so any remaining runtime tokens
                // and an eventual orphan closer are still extracted.
                tokens.push("${".to_string());
                offset += 2;
            }
            continue;
        }
        if starts_with(chars, offset, "}$") {
            // A valid switch consumes its closer above. Reaching one here
            // means it is orphaned or belongs to a malformed switch.
            tokens.push("}$".to_string());
            offset += 2;
            continue;
        }

        let end = read_content_patcher(chars, offset)
            .or_else(|| read_mail_command(chars, offset))
            .or_else(|| read_dialogue_break(chars, offset))
            .or_else(|| read_bracket(chars, offset))
            .or_else(|| read_positional(chars, offset))
            .or_else(|| read_simple_dialogue(chars, offset))
            .or_else(|| read_single_char(chars, offset));

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

/// Tokens that are still *extracted* (the editor shows them as chips) but are
/// **exempt from the blocking token error**: they never skip the string on
/// export or trigger a pointless AI retry (SPEC §10).
///  - `\n` is **layout, not syntax**: a translation often needs a different
///    number of line breaks (German runs ~25% longer than English), and a
///    changed `\n` count never breaks the mod at runtime.
///  - `'` paired quote delimiters are **punctuation, not runtime syntax** in
///    SMAPI i18n (unlike `{{...}}`, `$b`, `#`, `^`, `@`): adding, removing, or
///    restyling quotes never breaks a mod, so a quote-only difference must not
///    block export.
fn is_soft_token(token: &str) -> bool {
    token == "\n" || token == "'"
}

/// True if `target` is missing (or under-represents) any protected token that
/// appears in `source`. Soft tokens (newlines, quote delimiters) are exempt.
#[cfg(test)]
pub fn missing_tokens(source: &str, target: &str) -> bool {
    token_differences(source, target)
        .iter()
        .any(|difference| difference.target_count < difference.source_count)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TokenDifference {
    pub token: String,
    pub source_count: usize,
    pub target_count: usize,
}

/// Every protected-token count that differs between source and target.
/// Soft tokens (newlines, quote delimiters) are deliberately excluded.
pub fn token_differences(source: &str, target: &str) -> Vec<TokenDifference> {
    let source_counts = counts(source);
    let target_counts = counts(target);
    let source_has_gender_switch = source_counts
        .keys()
        .any(|token| is_gender_switch_shape(token));
    let mut tokens: Vec<String> = source_counts
        .keys()
        .chain(target_counts.keys())
        .filter(|token| !is_soft_token(token))
        .cloned()
        .collect();
    tokens.sort();
    tokens.dedup();
    tokens
        .into_iter()
        .filter_map(|token| {
            let source_count = source_counts.get(&token).copied().unwrap_or(0);
            let target_count = target_counts.get(&token).copied().unwrap_or(0);
            // A translation may introduce gender grammar when the source has
            // no switch at all. Once source switches exist, keep exact shape
            // counts so a changed block cannot be masked by an extra block.
            if !source_has_gender_switch
                && target_count > source_count
                && is_gender_switch_shape(&token)
            {
                return None;
            }
            (source_count != target_count).then_some(TokenDifference {
                token,
                source_count,
                target_count,
            })
        })
        .collect()
}

/// The protected tokens that `target` is missing (or under-represents) relative
/// to `source`, each listed once. Empty when nothing is missing. Used by the
/// local-LLM translator to flag/retry a result that dropped a token.
/// Soft tokens (newlines, quote delimiters) are exempt, like in [`missing_tokens`].
pub fn missing_token_list(source: &str, target: &str) -> Vec<String> {
    let source_counts = counts(source);
    let target_counts = counts(target);
    let mut missing: Vec<String> = source_counts
        .iter()
        .filter(|(token, _)| !is_soft_token(token))
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

/// Read one well-formed 1.6 gender-switch block. Branch prose is deliberately
/// not protected: only the raw opener, top-level delimiter(s), closer, and any
/// real tokens nested inside each branch are returned. `\u{00a6}` takes
/// precedence over `^`, since the alternate delimiter exists specifically so
/// carets inside branch text retain their later dialogue/mail meaning.
fn read_gender_switch(chars: &[char], offset: usize) -> Option<(usize, Vec<String>)> {
    if !starts_with(chars, offset, "${") {
        return None;
    }

    let close = find_switch_close(chars, offset)?;
    let content_start = offset + 2;
    let (delimiter, delimiters) = top_level_gender_delimiters(chars, content_start, close)?;

    let mut tokens = vec![gender_switch_shape(delimiter, delimiters.len())];
    let mut branch_start = content_start;
    for delimiter_offset in delimiters {
        tokens.extend(extract_chars(&chars[branch_start..delimiter_offset]));
        branch_start = delimiter_offset + 1;
    }
    tokens.extend(extract_chars(&chars[branch_start..close]));

    Some((close + 2, tokens))
}

fn gender_switch_shape(delimiter: char, delimiter_count: usize) -> String {
    format!("${{{}}}$", delimiter.to_string().repeat(delimiter_count))
}

pub fn is_gender_switch_shape(token: &str) -> bool {
    matches!(token, "${^}$" | "${^^}$" | "${¦}$" | "${¦¦}$")
}

/// Find the closer paired with the switch at `offset`, ignoring switch-like
/// text inside a balanced Content Patcher token and respecting nested blocks.
fn find_switch_close(chars: &[char], offset: usize) -> Option<usize> {
    let mut depth = 1usize;
    let mut index = offset + 2;

    while index < chars.len() {
        if starts_with(chars, index, "{{") {
            if let Some(end) = read_content_patcher(chars, index) {
                index = end;
                continue;
            }
        }
        if starts_with(chars, index, "${") {
            depth += 1;
            index += 2;
            continue;
        }
        if starts_with(chars, index, "}$") {
            depth -= 1;
            if depth == 0 {
                return Some(index);
            }
            index += 2;
            continue;
        }
        index += 1;
    }

    None
}

/// Return the chosen delimiter and its top-level positions. Stardew 1.6
/// supports exactly two or three gender branches. When `\u{00a6}` occurs at
/// the top level it is the delimiter, and top-level carets remain branch text.
fn top_level_gender_delimiters(
    chars: &[char],
    start: usize,
    end: usize,
) -> Option<(char, Vec<usize>)> {
    let mut carets = Vec::new();
    let mut broken_bars = Vec::new();
    let mut depth = 0usize;
    let mut index = start;

    while index < end {
        if starts_with(chars, index, "{{") {
            if let Some(token_end) = read_content_patcher(chars, index) {
                index = token_end;
                continue;
            }
        }
        if starts_with(chars, index, "${") {
            depth += 1;
            index += 2;
            continue;
        }
        if starts_with(chars, index, "}$") && depth > 0 {
            depth -= 1;
            index += 2;
            continue;
        }
        if depth == 0 {
            match chars[index] {
                '^' => carets.push(index),
                '\u{00a6}' => broken_bars.push(index),
                _ => {}
            }
        }
        index += 1;
    }

    let (delimiter, positions) = if broken_bars.is_empty() {
        ('^', carets)
    } else {
        ('\u{00a6}', broken_bars)
    };
    (1..=2)
        .contains(&positions.len())
        .then_some((delimiter, positions))
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

    // Some real mods contain a malformed `#$b$Text` sequence instead of the
    // documented `#$b#Text`. Stop at that second `$`; otherwise the generic
    // next-`#` reader would turn all following prose into one opaque token.
    if let Some(command_end) = read_simple_dialogue(chars, offset + 1) {
        if chars.get(command_end) == Some(&'$') {
            return Some(command_end + 1);
        }
    }

    find_char(chars, offset + 2, '#').map(|i| i + 1)
}

fn read_bracket(chars: &[char], offset: usize) -> Option<usize> {
    if chars.get(offset) != Some(&'[') {
        return None;
    }
    let end = find_balanced_bracket_end(chars, offset)?;
    let body: String = chars[offset + 1..end - 1].iter().collect();
    is_protected_bracket_body(&body).then_some(end)
}

fn find_balanced_bracket_end(chars: &[char], offset: usize) -> Option<usize> {
    let mut depth = 0usize;
    for (index, ch) in chars.iter().enumerate().skip(offset) {
        match ch {
            '[' => depth += 1,
            ']' => {
                depth = depth.checked_sub(1)?;
                if depth == 0 {
                    return Some(index + 1);
                }
            }
            _ => {}
        }
    }
    None
}

fn is_protected_bracket_body(body: &str) -> bool {
    if body == "#" || is_ascii_digits(body) || is_qualified_item_id(body) || is_item_id_pool(body) {
        return true;
    }

    let (name, arguments) = split_bracket_name(body);
    if name.is_empty() {
        return false;
    }
    let lower = name.to_ascii_lowercase();

    match lower.as_str() {
        // Built-in Stardew 1.6 values with no arguments.
        "dayofmonth" | "farmeruniqueid" | "farmname" | "season" | "positiveadjective" => {
            arguments.is_empty()
        }

        // Built-in ID/key/control-value forms whose arguments aren't visible
        // prose. Keep the accepted arities intentionally narrow.
        "farmerstat"
        | "achievementname"
        | "charactername"
        | "locationname"
        | "moviename"
        | "specialordername"
        | "numberwithseparators" => has_atomic_argument_count(arguments, 1, 1),
        "articlefor" => {
            has_atomic_argument_count(arguments, 1, 1)
                || is_single_protected_bracket_argument(arguments)
        }
        "suggesteditem" => has_atomic_argument_count(arguments, 0, 2),
        "itemnamewithflavor" => has_atomic_argument_count(arguments, 2, 2),
        "toolname" => has_atomic_argument_count(arguments, 1, 2),

        // A fallback may be visible text, but this is still genuine runtime
        // syntax. Keep the existing whole-raw safety behavior until arguments
        // have a typed representation.
        "itemname" => arguments
            .split_whitespace()
            .next()
            .map(is_item_id)
            .unwrap_or(false),

        // These genuine 1.6 forms may contain visible text. Preserve the
        // complete expression for runtime safety rather than dropping the
        // token name and brackets from validation.
        "localizedtext"
        | "genderedtext"
        | "spousefarmertext"
        | "spousegenderedtext"
        | "capitalizefirstletter" => !arguments.is_empty(),
        "escapedtext" => true,

        // C# mods are expected to namespace custom token names. Their argument
        // semantics are unknown, so retain the existing whole-raw protection.
        _ => is_namespaced_custom_token(name),
    }
}

fn split_bracket_name(body: &str) -> (&str, &str) {
    let name_end = body.find(char::is_whitespace).unwrap_or(body.len());
    (&body[..name_end], body[name_end..].trim())
}

fn atomic_arguments(arguments: &str) -> Vec<&str> {
    if arguments.contains('[') || arguments.contains(']') {
        return Vec::new();
    }
    arguments.split_whitespace().collect()
}

fn has_atomic_argument_count(arguments: &str, min: usize, max: usize) -> bool {
    if arguments.is_empty() {
        return min == 0;
    }
    if arguments.contains('[') || arguments.contains(']') {
        return false;
    }
    let args = atomic_arguments(arguments);
    (min..=max).contains(&args.len())
}

fn is_single_protected_bracket_argument(arguments: &str) -> bool {
    let chars: Vec<char> = arguments.chars().collect();
    if chars.first() != Some(&'[') || find_balanced_bracket_end(&chars, 0) != Some(chars.len()) {
        return false;
    }
    let inner: String = chars[1..chars.len() - 1].iter().collect();
    is_protected_bracket_body(inner.trim())
}

fn is_ascii_digits(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn is_item_id(value: &str) -> bool {
    is_ascii_id_segment(value) || is_qualified_item_id(value)
}

fn is_item_id_pool(value: &str) -> bool {
    if value.trim() != value {
        return false;
    }
    let item_ids: Vec<&str> = value.split_whitespace().collect();
    if item_ids.len() < 2 {
        return false;
    }

    // Bare string item IDs are indistinguishable from bracketed UI prose
    // without the game's item registry. Accept only numeric or qualified IDs
    // here so `[buff 5]`, `[(O)198 prose]`, and status labels stay translatable.
    item_ids
        .into_iter()
        .all(|item_id| is_ascii_digits(item_id) || is_qualified_item_id(item_id))
}

fn is_qualified_item_id(value: &str) -> bool {
    let Some(close) = value.find(')') else {
        return false;
    };
    value.starts_with('(')
        && close > 1
        && is_ascii_id_segment(&value[1..close])
        && is_ascii_id_segment(&value[close + 1..])
}

fn is_ascii_id_segment(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.'))
}

fn is_namespaced_custom_token(name: &str) -> bool {
    let mut segments = name.split('.');
    let Some(first) = segments.next() else {
        return false;
    };
    let mut has_namespace = false;
    if !is_ascii_token_name_segment(first) {
        return false;
    }
    for segment in segments {
        has_namespace = true;
        if !is_ascii_token_name_segment(segment) {
            return false;
        }
    }
    has_namespace
}

fn is_ascii_token_name_segment(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
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
    fn dollar_terminated_dialogue_marker_does_not_absorb_following_prose() {
        let source = "First.$0#$b$Second line.$3#$e#Last.$0";
        let target = "Erste.$0#$b$Zweite Zeile.$3#$e#Letzte.$0";

        assert_eq!(extract(source), vec!["$0", "#$b$", "$3", "#$e#", "$0"]);
        assert!(token_differences(source, target).is_empty());
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
    fn extracts_gender_switch_structure_and_mail_tokens() {
        let tokens = extract("${he^she}$ got [#] and %item 388 5 %%");
        assert_eq!(tokens, vec!["${^}$", "[#]", "%item 388 5 %%"]);
    }

    #[test]
    fn gender_switch_branch_prose_is_translatable_but_nested_tokens_are_not() {
        let source = "${@ with you #$b# $7^Your love @}$";
        let target = "${Mit dir @ #$b# $7^Deine Liebe @}$";

        assert_eq!(extract(source), vec!["${^}$", "@", "#$b#", "$7", "@"]);
        assert!(token_differences(source, target).is_empty());
    }

    #[test]
    fn gender_switch_supports_three_branches_and_broken_bar_delimiters() {
        assert_eq!(
            extract("${first^line @¦second #$b#¦third $7}$"),
            vec!["${¦¦}$", "^", "@", "#$b#", "$7"]
        );
    }

    #[test]
    fn gender_switch_matching_is_depth_aware_and_lexical() {
        assert_eq!(
            extract("${Hello ${lad^lass}$ @¦Goodbye #$b# $7}$"),
            vec!["${¦}$", "${^}$", "@", "#$b#", "$7"]
        );
    }

    #[test]
    fn gender_switch_shapes_do_not_cancel_out_across_blocks() {
        let source = "${a^b}$ ${c^d}$";
        let target = "${x^y^z}$ ${w}$";
        assert_eq!(extract(source), vec!["${^}$", "${^}$"]);
        assert_eq!(extract(target), vec!["${^^}$", "${", "}$"]);
        assert!(!token_differences(source, target).is_empty());
    }

    #[test]
    fn target_language_may_add_a_well_formed_gender_switch() {
        assert!(token_differences("Dear @.", "${Lieber^Liebe}$ @.").is_empty());

        // A source switch is still required, and malformed target-only switch
        // fragments are still reported as added runtime tokens.
        assert!(!token_differences("${Dear^Dear}$ @.", "Hallo @.").is_empty());
        assert!(!token_differences("Dear @.", "${Lieber}$ @.").is_empty());
    }

    #[test]
    fn target_switch_addition_cannot_mask_a_changed_source_switch_shape() {
        let source = "${a^b}$";
        let target = "${x^y^z}$ ${neu^neu}$";

        assert!(!token_differences(source, target).is_empty());
    }

    #[test]
    fn malformed_gender_switch_fragments_remain_protected() {
        assert_eq!(extract("${he^she}"), vec!["${", "^"]);
        assert_eq!(extract("{he^she}$"), vec!["^", "}$"]);
        assert_eq!(extract("${only}$"), vec!["${", "}$"]);
        assert!(!token_differences("${he^she}$", "${he^she}").is_empty());
    }

    #[test]
    fn bracket_reader_accepts_documented_runtime_shapes() {
        let value = r#"[#] [128] [(O)163] [FarmName] [FARMERSTAT stepsTaken] [SuggestedItem] [SuggestedItem day Shop] [ArticleFor [SuggestedItem]] [ItemName (O)128] [ItemName 128 fallback] [ItemNameWithFlavor SmokedFish (O)128] [LocalizedText Strings\UI:Key] [LocalizedText Strings/UI:Key value] [LocalizedText [EscapedText Strings\BundleNames:Quality Fish]] [GenderedText he¦she] [SpouseFarmerText a b] [SpouseGenderedText a b] [CapitalizeFirstLetter hello] [EscapedText visible] [ToolName (T)IridiumAxe 4] [Example.Mod.Token] [Example.Mod.Token arg]"#;
        assert_eq!(
            extract(value),
            vec![
                "[#]",
                "[128]",
                "[(O)163]",
                "[FarmName]",
                "[FARMERSTAT stepsTaken]",
                "[SuggestedItem]",
                "[SuggestedItem day Shop]",
                "[ArticleFor [SuggestedItem]]",
                "[ItemName (O)128]",
                "[ItemName 128 fallback]",
                "[ItemNameWithFlavor SmokedFish (O)128]",
                "[LocalizedText Strings\\UI:Key]",
                "[LocalizedText Strings/UI:Key value]",
                "[LocalizedText [EscapedText Strings\\BundleNames:Quality Fish]]",
                "[GenderedText he¦she]",
                "[SpouseFarmerText a b]",
                "[SpouseGenderedText a b]",
                "[CapitalizeFirstLetter hello]",
                "[EscapedText visible]",
                "[ToolName (T)IridiumAxe 4]",
                "[Example.Mod.Token]",
                "[Example.Mod.Token arg]",
            ]
        );
    }

    #[test]
    fn bracket_reader_rejects_ui_labels_status_prose_and_unknown_shapes() {
        let value = "[LEFT] [Right] [Reached global max Power Grid speed] [buff 5] [ 128 ] \
            [InputArgument name] \
            [SuggestedItem [EscapedText day]]";
        // The invalid outer SuggestedItem form is ignored, but its genuine
        // nested EscapedText token must still remain protected.
        assert_eq!(extract(value), vec!["[EscapedText day]"]);
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
    fn token_differences_include_missing_and_added_counts() {
        assert_eq!(
            token_differences("Hi {{name}} #", "Hallo {{name}} {{name}}"),
            vec![
                TokenDifference {
                    token: "#".into(),
                    source_count: 1,
                    target_count: 0,
                },
                TokenDifference {
                    token: "{{name}}".into(),
                    source_count: 1,
                    target_count: 2,
                },
            ]
        );
        assert!(token_differences("a\nb", "ab").is_empty());
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

    #[test]
    fn quote_delimiters_are_soft_not_blocking() {
        // The source uses backticks (no `'`); the translation introduces a
        // paired `'…'`. That is punctuation, not runtime syntax, so it must not
        // appear as a blocking difference or a missing token (SPEC §10).
        let source = "Use `Default` to modify the settings.";
        let target = "'Standard' verwenden, um die Einstellungen anzupassen.";
        assert!(token_differences(source, target).is_empty());
        assert!(!missing_tokens(source, target));
        assert!(missing_token_list(source, target).is_empty());

        // A dropped quote delimiter is equally non-blocking.
        assert!(!missing_tokens("'test'", "test"));
        assert!(missing_token_list("'test'", "test").is_empty());

        // Real tokens are still enforced when a quote difference also exists.
        assert!(missing_tokens("Hi {{name}} 'q'", "Hallo"));
        assert_eq!(
            missing_token_list("Hi {{name}} 'q'", "Hallo"),
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
