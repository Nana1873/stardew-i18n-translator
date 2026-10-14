//! Protected-token extraction. See SPEC.md, Validation and Export.
//!
//! A faithful Rust port of the frontend `protectedTokens.ts`. Most results are
//! literal tokens a translation MUST preserve; well-formed gender switches use
//! a canonical per-block shape such as `${^}$` so separate blocks can't mask
//! each other's structural damage. The remaining forms cover Content Patcher
//! `{{...}}`, mail commands, dialogue breaks, recognized bracket tokens,
//! positional `{0}`, dialogue commands `$b`, structural `#` / paired `'`
//! quote delimiters, single-char `@`/`^`, and dialogue placeholders such as
//! `%spouse` or `%noturn`.
//!
//! Every difference carries a [`Severity`]. Only `Error` differences are
//! verified to break the game (raw syntax shown, dialogue split wrongly, lost
//! rewards or logic); `Warning` differences are cosmetic or legitimate
//! translation choices. Export omits a string only for an unaccepted `Error`.
//! Tokens are compared as multisets, so a dropped second `$b` is caught too.
//! Keeping this in sync with the TS reader is covered by shared-case tests in
//! both languages.

use std::collections::HashMap;

use serde::Serialize;

/// Extract every protected token or switch-shape identity from `value`.
pub fn extract(value: &str) -> Vec<String> {
    let chars: Vec<char> = value.chars().collect();
    match read_leading_command(&chars) {
        Some(end) => {
            // Arguments are split on spaces with empty entries removed by the
            // game, so only the spacing is canonicalized.
            let raw: String = chars[..end - 1].iter().collect();
            let command = raw
                .split(' ')
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>();
            let mut tokens = vec![format!("{}#", command.join(" "))];
            tokens.extend(extract_chars(&chars[end..]));
            tokens
        }
        None => extract_chars(&chars),
    }
}

/// Dialogue commands that take arguments up to the next `#` when they open a
/// string, e.g. `$q 305/306 null#`, `$1 metHarvey#`, `$p 305#`, `$c 0.5#`,
/// `$d bus#`. Their arguments are response ids, flags, and keys, not prose.
fn read_leading_command(chars: &[char]) -> Option<usize> {
    if chars.first() != Some(&'$')
        || !chars
            .get(1)
            .is_some_and(|c| matches!(c, 'q' | 'p' | 'c' | 'd' | '1'))
        || chars.get(2) != Some(&' ')
    {
        return None;
    }
    find_char(chars, 3, '#').map(|hash| hash + 1)
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

        // `#$y '…'`: the page break belongs to the quick response; without it
        // the game shows the command as text, so it is protected with it.
        if chars[offset] == '#' && quick_response_quote(chars, offset + 1).is_some() {
            if let Some((end, quick)) = read_quick_response(chars, offset + 1) {
                tokens.push("#$y".to_string());
                tokens.extend(quick.into_iter().skip(1));
                offset = end;
                continue;
            }
        }
        if let Some((end, action_tokens)) =
            read_betas_message(chars, offset).or_else(|| read_quick_response(chars, offset))
        {
            tokens.extend(action_tokens);
            offset = end;
            continue;
        }
        let end = read_content_patcher(chars, offset)
            .or_else(|| read_mail_command(chars, offset))
            .or_else(|| read_dialogue_break(chars, offset))
            .or_else(|| read_bracket(chars, offset))
            .or_else(|| read_positional(chars, offset))
            .or_else(|| read_simple_dialogue(chars, offset))
            .or_else(|| read_event_command(chars, offset))
            .or_else(|| read_percent_placeholder(chars, offset))
            .or_else(|| read_single_char(chars, offset));

        match end {
            Some(end) => {
                let raw: String = chars[offset..end].iter().collect();
                tokens.push(normalize_protected_token(&raw));
                offset = end;
            }
            None => offset += 1,
        }
    }

    tokens
}

/// Canonicalize only syntax differences which the game parser ignores.
fn normalize_protected_token(raw: &str) -> String {
    if let Some(command) = normalize_mail_command(raw) {
        return command;
    }
    if has_space_split_arguments(raw) {
        let command = raw[1..raw.len() - 1]
            .split(' ')
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        return format!("#{command}#");
    }
    raw.to_owned()
}

/// `%item type args %%` and `%action args %%`: `LetterViewerMenu` splits both
/// on ASCII spaces with empty entries removed and lowercases the item type
/// (`HandleItemCommand`, `TriggerActionManager.ParseAction`), so only the
/// spacing and that type's case are canonicalized. A quoted action argument
/// keeps its spaces, so such an action stays as written. Mirrors TS
/// `normalizeMailCommand`.
fn normalize_mail_command(raw: &str) -> Option<String> {
    let inner = raw.strip_suffix("%%")?;
    let (name, rest) = if let Some(rest) = inner.strip_prefix("%item ") {
        ("%item", rest)
    } else {
        ("%action", inner.strip_prefix("%action ")?)
    };
    if name == "%action" && rest.contains('"') {
        return None;
    }
    let mut parts: Vec<String> = rest
        .split(' ')
        .filter(|part| !part.is_empty())
        .map(str::to_string)
        .collect();
    if name == "%item" {
        if let Some(kind) = parts.first_mut() {
            *kind = kind.to_lowercase();
        }
    }
    parts.insert(0, name.to_string());
    parts.push("%%".to_string());
    Some(parts.join(" "))
}

/// `Dialogue.parseDialogueString` splits a `$command` from its arguments and
/// the arguments on ASCII spaces with empty entries removed
/// (`ArgUtility.SplitBySpace`), so only the spacing is canonicalized; every
/// argument stays exact. `$y` reads its raw text, and quoted `$action` or
/// `$query` arguments keep their inner spaces, so those stay as written.
/// Mirrors TS `hasSpaceSplitArguments`.
fn has_space_split_arguments(raw: &str) -> bool {
    let Some(rest) = raw.strip_prefix("#$") else {
        return false;
    };
    let name_len = rest
        .bytes()
        .take_while(|byte| byte.is_ascii_alphanumeric())
        .count();
    name_len > 0
        && rest.as_bytes().get(name_len) == Some(&b' ')
        && raw.ends_with('#')
        && !raw.starts_with("#$y ")
        && !raw.contains('"')
}

/// Tokens that are still *extracted* (the editor shows them as chips) but are
/// **exempt from the blocking token error**: they never skip the string on
/// export or trigger a pointless AI retry.
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

/// How serious a protected-token difference is, verified against the
/// Stardew 1.6 dialogue, mail, and token parsers.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    /// Breaks the game: raw syntax, a wrongly split dialogue, lost rewards or
    /// logic. Export omits the string unless the mismatch was accepted.
    Error,
    /// Cosmetic or a legitimate translation choice; never blocks.
    Warning,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TokenDifference {
    pub token: String,
    pub source_count: usize,
    pub target_count: usize,
    pub severity: Severity,
}

impl TokenDifference {
    pub fn is_error(&self) -> bool {
        self.severity == Severity::Error
    }
}

/// Only the differences that break the game. Empty means the translation is
/// safe to export, although warnings may still exist.
pub fn blocking_differences(source: &str, target: &str) -> Vec<TokenDifference> {
    token_differences(source, target)
        .into_iter()
        .filter(TokenDifference::is_error)
        .collect()
}

/// The differences an AI translation is asked to fix in one more attempt:
/// every error, plus a missing value the game would have filled in (a
/// placeholder, a value bracket token, `@`, or a `%` placeholder). Other
/// warnings are translation choices and never cost a request.
pub fn repair_differences(source: &str, target: &str) -> Vec<TokenDifference> {
    token_differences(source, target)
        .into_iter()
        .filter(|difference| {
            difference.is_error()
                || (difference.target_count < difference.source_count
                    && carries_value(&difference.token))
        })
        .collect()
}

/// A token the game replaces with a value, so a translation without it
/// loses that value. `[ArticleFor …]` is empty in other languages and
/// `%noturn` is removed, so neither carries one.
fn carries_value(token: &str) -> bool {
    is_placeholder(token)
        || token == "@"
        || (percent_placeholder_text(token).is_some() && token != "%noturn")
        || (is_text_bracket(token) && !token.to_ascii_lowercase().starts_with("[articlefor"))
}

/// Token characters an LLM or a CJK keyboard may write as their full-width
/// look-alikes (U+FF01..U+FF5E, ASCII + 0xFEE0). Mirrors TS
/// `FULL_WIDTH_LOOKALIKES`.
const FULL_WIDTH_LOOKALIKES: &str = "${}^#@%[]";

/// A plain-language explanation of game-breaking differences for export and
/// release results. Gender-switch damage is described as one structural
/// problem instead of its raw `${`, `}$`, and `^` counts (mirrors the TS
/// `describeTokenIssue`). `translation` is the target text the differences
/// come from; full-width look-alikes in it get one extra hint.
pub fn explain_differences(differences: &[TokenDifference], translation: &str) -> String {
    let delta = |token: &str| {
        differences
            .iter()
            .find(|difference| difference.token == token)
            .map_or(0, |difference| {
                difference.target_count as isize - difference.source_count as isize
            })
    };
    let extra_openers = delta("${");
    let extra_closers = delta("}$");
    // A page-counting command the translation broke still counts.
    let pages_counted = counts_pages(translation)
        || differences
            .iter()
            .any(|difference| is_page_counting_command(&difference.token));
    let mut messages = Vec::new();
    let mut switch_damaged = false;
    if extra_openers > 0 && extra_closers <= 0 {
        messages.push("A he/she switch ${…^…}$ is missing its closing }$, so the game would show broken text.".to_string());
        switch_damaged = true;
    } else if extra_closers > 0 && extra_openers <= 0 {
        messages.push("A he/she switch ${…^…}$ is missing its opening ${, so the game would show broken text.".to_string());
        switch_damaged = true;
    } else if extra_openers > 0 && extra_closers > 0 {
        messages.push(
            "A he/she switch needs two or three variants separated by ^, like ${he^she}$, and cannot contain another switch."
                .to_string(),
        );
        switch_damaged = true;
    }
    // A wrong-case command and the correct one it replaced are one finding.
    let mut merged: Vec<&TokenDifference> = Vec::new();
    for difference in differences {
        let token = difference.token.as_str();
        if merged.iter().any(|item| std::ptr::eq(*item, difference)) {
            continue;
        }
        let suggestion = (difference.target_count > difference.source_count)
            .then(|| case_variant_command(token))
            .flatten();
        if let Some(suggestion) = suggestion {
            let partner = case_variant_partner(differences, &suggestion);
            merged.extend(partner.filter(|partner| covers_partner(difference, partner)));
            let error = difference.is_error() || partner.is_some_and(TokenDifference::is_error);
            messages.push(case_variant_message(token, partner, error));
            continue;
        }
        if switch_damaged
            && (matches!(token, "${" | "}$")
                || is_gender_switch_shape(token)
                || (token == "^" && difference.target_count > difference.source_count))
        {
            continue;
        }
        messages.push(difference_message(difference, pages_counted));
    }
    // A look-alike explains a token difference but never adds one.
    if !messages.is_empty() {
        messages.extend(full_width_hint(differences, translation));
    }
    messages.join(" ")
}

/// A hint when the translation has the full-width form of a character of a
/// token that went missing or changed. `％［］` are ordinary CJK punctuation,
/// so they only count when such a token needs them. Mirrors TS
/// `fullWidthHint`.
fn full_width_hint(differences: &[TokenDifference], translation: &str) -> Option<String> {
    let full_width = |c: char| char::from_u32(c as u32 + 0xfee0).unwrap_or(c);
    let found: Vec<char> = FULL_WIDTH_LOOKALIKES
        .chars()
        .filter(|c| {
            differences.iter().any(|difference| {
                difference.target_count < difference.source_count && difference.token.contains(*c)
            }) && translation.contains(full_width(*c))
        })
        .collect();
    if found.is_empty() {
        return None;
    }
    let wide: String = found.iter().map(|c| full_width(*c)).collect();
    let ascii = found
        .iter()
        .map(char::to_string)
        .collect::<Vec<_>>()
        .join(" ");
    Some(format!(
        "The text contains full-width {wide} where the English text has {ascii}. The game shows them as they are; use the normal characters."
    ))
}

/// How a token count differs, in words (mirrors TS `changePhrase`).
fn change_phrase(source_count: usize, target_count: usize) -> String {
    let times = |n: usize| {
        if n == 1 {
            "1 time".to_string()
        } else {
            format!("{n} times")
        }
    };
    if target_count < source_count {
        if target_count == 0 {
            "is missing from the translation".to_string()
        } else {
            format!(
                "appears {} in the translation instead of {source_count}",
                times(target_count)
            )
        }
    } else if source_count == 0 {
        "is not in the English text".to_string()
    } else {
        format!(
            "appears {} in the translation instead of {source_count}",
            times(target_count)
        )
    }
}

/// One plain-language sentence for a difference (mirrors TS `genericMessage`).
fn difference_message(difference: &TokenDifference, pages_counted: bool) -> String {
    let token = difference.token.as_str();
    let missing = difference.target_count < difference.source_count;
    let change = change_phrase(difference.source_count, difference.target_count);
    if is_gender_switch_shape(token) {
        return if missing {
            "A he/she variant ${…^…}$ was removed; everyone sees the same text. Fine if intended."
                .to_string()
        } else {
            "The he/she switches differ from the English text. Fine if intended.".to_string()
        };
    }
    if is_portrait_command(token) {
        return if difference.is_error() {
            format!("The portrait {token} {change}: one dialogue box now has two different portraits, so the second shows as raw text.")
        } else {
            format!("The portrait {token} {change}: the character shows a different face. Fine if intended.")
        };
    }
    match token {
        "@" => return format!("The player name @ {change}. Fine if intended."),
        "#" if difference.is_error() && pages_counted => return format!("# {change}. A $1, $c, or $d command here counts dialogue pages, so a different line or an empty box would show."),
        "^" | "#" if difference.is_error() => return format!("{token} {change}: one dialogue box now has two different portraits, so the second shows as raw text."),
        "^" => return format!("^ {change}. In dialogue, ^ splits the text into male and female versions; in a letter it is a line break. Fine if intended."),
        "}" if difference.is_error() => return format!("A single }} {change}. The game turns the text before it into a hidden flag, so that text disappears."),
        "{" if difference.is_error() => return format!("A single {{ {change}. Mods that fill in values such as {{0}} would fail on it, and dialogue reads it as a command."),
        "{" if missing => return format!("A single {{ {change}. In dialogue it keeps the conversation going into the next box. Fine if intended."),
        "{" | "}" => return format!("A single {token} {change}. Fine if intended."),
        "#" => return format!("# {change}. In dialogue, # separates dialogue boxes; elsewhere it is plain text. Fine if intended."),
        _ => {}
    }
    format!(
        "{token} {change}. {}",
        token_consequence(difference, pages_counted)
    )
}

/// Dialogue command names the game knows (Stardew 1.6 `Dialogue.cs`). The
/// game matches them case-sensitively, so `$B` is shown as text. Mirrors TS
/// `DIALOGUE_COMMANDS`.
const DIALOGUE_COMMANDS: [&str; 19] = [
    "a", "action", "b", "c", "d", "e", "h", "k", "l", "neutral", "p", "q", "query", "r", "s", "t",
    "u", "v", "y",
];

/// The correct-case form of a token that is a known dialogue command typed in
/// the wrong letter case, e.g. `#$B#` -> `#$b#` or `$Q` -> `$q`. Mirrors TS
/// `caseVariantCommand`.
fn case_variant_command(token: &str) -> Option<String> {
    let (prefix, rest) = if let Some(rest) = token.strip_prefix("#$") {
        ("#$", rest)
    } else {
        ("$", token.strip_prefix('$')?)
    };
    let name_len = rest
        .bytes()
        .take_while(|byte| byte.is_ascii_alphabetic())
        .count();
    let name = &rest[..name_len];
    let lower = name.to_ascii_lowercase();
    if name == lower || !DIALOGUE_COMMANDS.contains(&lower.as_str()) {
        return None;
    }
    Some(format!("{prefix}{lower}{}", &rest[name_len..]))
}

/// The missing token that a wrong-case command most likely replaced: the
/// correct form itself, or that command with its arguments. Mirrors TS
/// `caseVariantPartner`.
fn case_variant_partner<'a>(
    differences: &'a [TokenDifference],
    suggestion: &str,
) -> Option<&'a TokenDifference> {
    differences.iter().find(|item| {
        item.target_count < item.source_count
            && (item.token == suggestion
                || item
                    .token
                    .strip_prefix(suggestion)
                    .is_some_and(|rest| rest.starts_with(' ')))
    })
}

/// One finding for a dialogue command typed in the wrong letter case. Only
/// when the correct command is missing from the translation is it suggested.
/// Mirrors TS `caseVariantMessage`.
fn case_variant_message(token: &str, partner: Option<&TokenDifference>, error: bool) -> String {
    let text =
        format!("{token} is not a dialogue command the game knows, so it would show as text.");
    if !error {
        // Only a letter, where dialogue commands are plain text anyway.
        return format!("{text} Fine if intended.");
    }
    let Some(partner) = partner else {
        return text;
    };
    let suggestion = format!("{text} Did you mean {}?", partner.token);
    // `#$e#` itself does nothing, so its purpose would only confuse here.
    match dialogue_command_consequence(&partner.token) {
        Some(purpose) if !is_skipped_page(&partner.token) => format!("{suggestion} {purpose}"),
        _ => suggestion,
    }
}

/// Whether the wrong-case command accounts for every missing copy of its
/// partner; otherwise the partner keeps its own message for the rest. Mirrors
/// TS `coversPartner`.
fn covers_partner(difference: &TokenDifference, partner: &TokenDifference) -> bool {
    partner.source_count - partner.target_count <= difference.target_count - difference.source_count
}

/// `#$e#` and `#$k#` on their own page: SDV 1.6 recognizes `$e` and `$k` in
/// `Dialogue.parseDialogueString` but adds nothing for them (the page is
/// dropped; `Dialogue.dialogueEnd` is unused, and `$k` only acts inside a
/// text line). `#$e$` or `#$e*` is not that command and shows as text.
/// Mirrors TS `isSkippedPage`.
fn is_skipped_page(token: &str) -> bool {
    matches!(token, "#$e#" | "#$k#")
}

/// Whether a page starts with `$1 <flag>`, `$c <chance>`, or `$d <check>`:
/// `$1` and `$c` jump three pages ahead (`i += 3` in
/// `Dialogue.parseDialogueString`) and `$d` picks a version by splitting the
/// rest at `|` or `#`, so every page counts, an empty `$e` one included.
/// Mirrors TS `countsPages`.
fn counts_pages(value: &str) -> bool {
    value
        .split('#')
        .any(|page| page.starts_with("$1 ") || page.starts_with("$c ") || page.starts_with("$d "))
}

/// A `$1`, `$c`, or `$d` command token, at the start of the string or after
/// a `#`. Mirrors TS `isPageCountingCommand`.
fn is_page_counting_command(token: &str) -> bool {
    let command = token.strip_prefix('#').unwrap_or(token);
    command.starts_with("$1 ") || command.starts_with("$c ") || command.starts_with("$d ")
}

/// Whether a page starts with `$d <check>`, whose two versions are split at
/// `|` (`Dialogue.parseDialogueString`). Mirrors TS `picksVersion`.
fn picks_version(value: &str) -> bool {
    value.split('#').any(|page| page.starts_with("$d "))
}

/// Warnings with their own explanation; any other warning is dialogue syntax
/// in a letter. Mirrors TS `hasWarningText`.
fn has_warning_text(token: &str) -> bool {
    is_skipped_page(token)
        || is_malformed_break(token)
        || matches!(token, "#$b#" | "*" | "[#]" | "||")
        || is_letter_format(token)
        || percent_placeholder_text(token).is_some()
        || is_placeholder(token)
        || is_text_bracket(token)
        || is_empty_bracket(token)
}

/// Tokens that split dialogue pages, which `$1`, `$c`, and `$d` count.
fn is_page_token(token: &str) -> bool {
    matches!(token, "#" | "#$b#" | "|") || is_skipped_page(token)
}

/// `#$b#` with a `$` or `*` instead of its closing `#` is no command; the game
/// shows it as text in the English line too.
fn is_malformed_break(token: &str) -> bool {
    matches!(token, "#$b$" | "#$b*")
}

/// `[]` or `[ ]`: `TokenParser.ParseTag` reads the first word of an empty
/// token and throws, so dialogue shows "..." and a Mail Framework Mod letter
/// cannot be opened.
fn is_empty_bracket(token: &str) -> bool {
    token
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
        .is_some_and(|body| body.chars().all(|c| c == ' '))
}

/// Bracket tokens that give an item in dialogue (`Dialogue.cs` item grab) or
/// split a letter. Other bracket tokens only insert text, and an unknown or
/// broken one stays visible as `[...]` (`TokenParser`).
fn is_logic_bracket(token: &str) -> bool {
    let Some(body) = token
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
    else {
        return false;
    };
    body == "#" || is_ascii_digits(body) || is_qualified_item_id(body) || is_item_id_pool(body)
}

fn is_text_bracket(token: &str) -> bool {
    token.starts_with('[')
        && !is_logic_bracket(token)
        && !is_empty_bracket(token)
        && !is_letter_format(token)
}

/// `[letterbg …]` and `[textcolor …]` set a letter's background and text
/// color (`LetterViewerMenu.ApplyCustomFormatting`). A missing one or an
/// unknown color only changes the look; a misspelled command word or a
/// background that is no number stays visible as text. Mirrors TS
/// `isLetterFormat`.
fn is_letter_format(token: &str) -> bool {
    let lower = token.to_ascii_lowercase();
    lower.starts_with("[letterbg ") || lower.starts_with("[textcolor ")
}

/// Whether the game applies (and removes) the letter command: it compares
/// the command word case-sensitively and parses the background as a number.
/// Mirrors TS `letterFormatWorks`.
fn letter_format_works(token: &str) -> bool {
    let body = token.trim_start_matches('[').trim_end_matches(']');
    let words: Vec<&str> = body.split(' ').filter(|word| !word.is_empty()).collect();
    match words.first() {
        Some(&"textcolor") => true,
        Some(&"letterbg") => words.last().is_some_and(|last| is_ascii_digits(last)),
        _ => false,
    }
}

/// Bracket tokens `TokenParser` always resolves: built-in values without
/// arguments, and `[ArticleFor …]`, which is empty in other languages. Any
/// other new bracket token may not resolve, and then it is left as raw text.
/// `[SuggestedItem]` only resolves in shop dialogue (`ShopMenu`), so it is
/// not one of them. Mirrors TS `alwaysResolves`.
fn always_resolves(token: &str) -> bool {
    let Some(body) = token
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
    else {
        return false;
    };
    let (name, arguments) = split_bracket_name(body);
    let name = name.to_ascii_lowercase();
    name == "articlefor"
        || (arguments.is_empty()
            && matches!(
                name.as_str(),
                "dayofmonth" | "farmeruniqueid" | "farmname" | "season" | "positiveadjective"
            ))
}

/// What makes a bracket token resolve: its name plus its key, name, or item
/// ID (the first argument). Tokens whose arguments are visible text, and the
/// fallback text of `[ItemName …]` or the format values of
/// `[LocalizedText …]`, may be translated, so they are not part of it.
/// Mirrors TS `bracketKey`.
fn bracket_key(token: &str) -> String {
    let body = token
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
        .unwrap_or(token);
    let (name, arguments) = split_bracket_name(body);
    let name = name.to_ascii_lowercase();
    if matches!(
        name.as_str(),
        "genderedtext"
            | "spousefarmertext"
            | "spousegenderedtext"
            | "capitalizefirstletter"
            | "escapedtext"
    ) {
        return name;
    }
    match arguments.split_whitespace().next() {
        Some(key) => format!("{name} {key}"),
        None => name,
    }
}

/// Whether `candidate` is a better AI result than `previous`, both as
/// [`repair_differences`]: no error moves further from its English count,
/// and either the errors shrink or they stay and the lost values shrink
/// without one getting worse. A result that removes errors wins even if it
/// loses a value.
pub fn repair_improves(previous: &[TokenDifference], candidate: &[TokenDifference]) -> bool {
    let (previous_errors, previous_values) = split_errors(previous);
    let (candidate_errors, candidate_values) = split_errors(candidate);
    if worsens(&previous_errors, &candidate_errors) {
        return false;
    }
    let total = |items: &[&TokenDifference]| items.iter().map(|item| distance(item)).sum::<usize>();
    total(&candidate_errors) < total(&previous_errors)
        || (total(&candidate_errors) == total(&previous_errors)
            && !worsens(&previous_values, &candidate_values)
            && total(&candidate_values) < total(&previous_values))
}

/// Whether `candidate` is a worse AI result than `previous`, both as
/// [`repair_differences`]: an error moves further from its English count, or
/// the errors stay and a lost value gets worse.
pub fn repair_worsens(previous: &[TokenDifference], candidate: &[TokenDifference]) -> bool {
    let (previous_errors, previous_values) = split_errors(previous);
    let (candidate_errors, candidate_values) = split_errors(candidate);
    let total = |items: &[&TokenDifference]| items.iter().map(|item| distance(item)).sum::<usize>();
    worsens(&previous_errors, &candidate_errors)
        || (total(&candidate_errors) >= total(&previous_errors)
            && worsens(&previous_values, &candidate_values))
}

fn split_errors(differences: &[TokenDifference]) -> (Vec<&TokenDifference>, Vec<&TokenDifference>) {
    differences
        .iter()
        .partition(|difference| difference.is_error())
}

fn distance(difference: &TokenDifference) -> usize {
    difference.source_count.abs_diff(difference.target_count)
}

/// Whether any token in `candidate` is further from its English count than in
/// `previous`; a token `previous` does not list counts as zero there.
fn worsens(previous: &[&TokenDifference], candidate: &[&TokenDifference]) -> bool {
    candidate.iter().any(|difference| {
        let before = previous
            .iter()
            .find(|item| item.token == difference.token)
            .map_or(0, |item| distance(item));
        distance(difference) > before
    })
}

/// What a dialogue break or command does, or `None` for other tokens. Mirrors
/// TS `dialogueCommandConsequence`.
fn dialogue_command_consequence(token: &str) -> Option<&'static str> {
    let page_marker = token
        .chars()
        .nth(3)
        .is_some_and(|c| matches!(c, '#' | '$' | '*'));
    if token.starts_with("#$b") && page_marker {
        return Some(
            "It starts a new dialogue box, so the text would be split into boxes differently.",
        );
    }
    if is_skipped_page(token) {
        return Some(
            "The game skips this command, so the dialogue plays the same. Fine if intended.",
        );
    }
    if token.starts_with("#$action")
        || ((token.starts_with("#$") || token.starts_with('$')) && token.ends_with('#'))
    {
        return Some("The game needs it to run the dialogue (answers, flags, or events).");
    }
    None
}

/// What a token difference does in the game, as one sentence. Errors name the
/// consequence; warnings end with "Fine if intended." Mirrors TS
/// `tokenConsequence` word for word.
fn token_consequence(difference: &TokenDifference, pages_counted: bool) -> &'static str {
    let token = difference.token.as_str();
    let missing = difference.target_count < difference.source_count;
    let chars: Vec<char> = token.chars().collect();
    if matches!(token, "${" | "}$") {
        return if difference.is_error() {
            "A he/she switch is not opened and closed properly, so the game would show broken text."
        } else {
            "Fine if intended."
        };
    }
    if !difference.is_error() && !has_warning_text(token) {
        return "In a letter the game shows it as plain text. Fine if intended.";
    }
    if token == "|" && difference.is_error() {
        return "In a $d dialogue it separates the two versions, so the game would show the wrong one or only \"...\".";
    }
    if is_page_token(token) && difference.is_error() && pages_counted {
        return "A $1, $c, or $d command here counts dialogue pages, so a different line or an empty box would show.";
    }
    if token == "#$b#" {
        return if difference.is_error() {
            "A # took its place, which ends the conversation there: the rest shows only the next time the player talks to the character, or never in an event."
        } else {
            "It starts a new dialogue box; without it the game still moves long text into extra boxes. Fine if intended."
        };
    }
    if is_malformed_break(token) {
        return "The game does not read it as a command and shows it as text, as in the English text. Fine if intended.";
    }
    if token == "||" {
        return "In dialogue it splits the text into versions that change every week; elsewhere it is plain text. Fine if intended.";
    }
    if is_empty_bracket(token) {
        return if missing {
            "The game could not read it in the English text either. Fine if intended."
        } else {
            "The game cannot read an empty [], so the dialogue shows only \"...\" or the letter cannot be opened."
        };
    }
    if let Some(command) = dialogue_command_consequence(token) {
        if difference.is_error() || is_skipped_page(token) {
            return command;
        }
    }
    if token.starts_with("%item") || token.starts_with("%action") {
        return if missing {
            "The attached item or reward would not be given."
        } else {
            "It adds an item or reward the English mail does not give."
        };
    }
    if token == "#$y" {
        return "It starts the quick question in a new dialogue box; without it the game shows the command as text.";
    }
    if token == "*" {
        return "In a quick-question reply it starts a new dialogue box. Fine if intended.";
    }
    if token == "_" {
        return "It separates the question, answers, and replies of a quick question; without it the game mixes them up.";
    }
    if token == "[#]" && !missing && !difference.is_error() {
        return "The game shows only the letter text before the first [#], so text after another [#], such as a female version after ¦, never appears. Fine if intended.";
    }
    if token == "[#]" {
        return if missing {
            "The letter title would show at the end of the letter text. Fine if intended."
        } else {
            "Text after it would become the letter title."
        };
    }
    if token == "%fork" || token.starts_with("%revealtaste") {
        return if missing {
            "The event choice or gift-taste reveal would not happen."
        } else {
            "It adds event behavior the English text does not have."
        };
    }
    if let Some(text) = percent_placeholder_text(token) {
        return text;
    }
    if token.starts_with("{{") || match_positional(&chars, 0) == Some(chars.len()) {
        if missing {
            return "The game shows nothing in its place. Fine if intended.";
        }
        if !difference.is_error() {
            return "The game fills in a value the English text already uses. Fine if intended.";
        }
        return if token.starts_with("{{") {
            "The game would show it as raw text."
        } else {
            "The game has no value for it, so the text breaks."
        };
    }
    if token.to_ascii_lowercase().starts_with("[articlefor") {
        return if missing {
            "Only the a/an article is lost. Fine if intended."
        } else {
            "The game puts no article here in other languages. Fine if intended."
        };
    }
    if is_letter_format(token) && difference.is_error() {
        return "The game does not recognize this command, so it shows as text in the letter. Write the command word in lowercase and the background as a number, like in the English text.";
    }
    if is_letter_format(token) {
        return if missing {
            "The letter uses its default background or text color. Fine if intended."
        } else {
            "It sets the letter's background or text color; if it is not written like in the English text, the letter may show it as text. Fine if intended."
        };
    }
    if is_text_bracket(token) {
        return if missing {
            "The game would not insert this value. Fine if intended."
        } else if difference.is_error() {
            "If the game cannot resolve it, for example because its name or key was translated, players see it as raw text."
        } else {
            "The game fills it in. Fine if intended."
        };
    }
    if token.starts_with('[') {
        return if missing {
            "The game would not give this item."
        } else {
            "It adds an item the English text does not give."
        };
    }
    if token.starts_with('$') && !is_portrait_command(token) {
        return "The game would show it as text or change the dialogue flow.";
    }
    "The game would show it as raw text or misread the line."
}

/// Portrait/emotion commands only change the face; a missing sheet index falls
/// back to portrait 0 (DialogueBox bounds check).
fn is_portrait_command(token: &str) -> bool {
    matches!(token, "$h" | "$s" | "$u" | "$l" | "$a")
        || token
            .strip_prefix('$')
            .is_some_and(|rest| !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit()))
}

/// `Dialogue.applyGenderSwitch` also cuts a page at its first bare `^`: the
/// male player sees the left part, everyone else the right part. Letters have
/// no portraits, so this split never affects them. Mirrors TS `genderHalf`.
fn gender_half(page: &str, branch: usize) -> &str {
    match page.find('^') {
        None => page,
        Some(caret) if branch == 0 => &page[..caret],
        Some(caret) => &page[caret + 1..],
    }
}

/// The text a player sees for one gender: every well-formed switch is
/// replaced by its branch `branch` (the last branch when it has fewer).
fn branch_text(chars: &[char], branch: usize) -> String {
    let mut text = String::new();
    let mut index = 0;
    while index < chars.len() {
        if starts_with(chars, index, "${") {
            if let Some(close) = find_switch_close(chars, index) {
                if let Some((_, delimiters)) = top_level_gender_delimiters(chars, index + 2, close)
                {
                    let chosen = branch.min(delimiters.len());
                    let start = if chosen == 0 {
                        index + 2
                    } else {
                        delimiters[chosen - 1] + 1
                    };
                    let end = delimiters.get(chosen).copied().unwrap_or(close);
                    text.push_str(&branch_text(&chars[start..end], branch));
                    index = close + 2;
                    continue;
                }
            }
        }
        text.push(chars[index]);
        index += 1;
    }
    text
}

/// The game applies one emotion per dialogue page and removes every copy of
/// it (`Dialogue.checkEmotions` uses `Replace`), so a repeated portrait is
/// harmless; a second, different one stays visible as raw text. Mirrors TS
/// `pagesWithMultiplePortraits`.
fn pages_with_multiple_portraits(value: &str) -> usize {
    let chars: Vec<char> = value.chars().collect();
    // Each switch branch is what one player gender sees; count the worst one.
    (0..3)
        .map(|branch| {
            branch_text(&chars, branch)
                .split('#')
                .map(|page| gender_half(page, branch))
                .filter(|page| {
                    extract(page)
                        .into_iter()
                        .filter(|token| is_portrait_command(token))
                        .collect::<std::collections::HashSet<_>>()
                        .len()
                        > 1
                })
                .count()
        })
        .max()
        .unwrap_or(0)
}

fn is_placeholder(token: &str) -> bool {
    let chars: Vec<char> = token.chars().collect();
    (token.starts_with("{{") && token.ends_with("}}"))
        || match_positional(&chars, 0) == Some(chars.len())
}

/// What a comparison knows about the whole string, for [`token_severity`].
/// Mirrors TS `SeverityContext`.
#[derive(Clone, Default)]
struct SeverityContext {
    /// The translation puts two different portraits on one page.
    introduces_multiple_portraits: bool,
    /// `$1`, `$c`, or `$d` count the dialogue pages.
    pages_counted: bool,
    /// The translation has more bare `#` than the English text.
    adds_page_breaks: bool,
    /// The highest `{n}` index in the English text, if any.
    max_positional: Option<u64>,
    /// A letter: only the text before `[#]` is shown and dialogue syntax is
    /// plain text there (`LetterViewerMenu`).
    letter: bool,
    /// The [`bracket_key`] of every bracket token in the English text.
    source_bracket_keys: std::collections::HashSet<String>,
}

fn positional_index(token: &str) -> Option<u64> {
    let chars: Vec<char> = token.chars().collect();
    (match_positional(&chars, 0) == Some(chars.len()))
        .then(|| token[1..token.len() - 1].parse().ok())
        .flatten()
}

/// Tokens that still act in a letter: rewards, actions, he/she switches, and
/// placeholders the mod fills in.
fn acts_in_letter(token: &str) -> bool {
    token.starts_with("%item")
        || token.starts_with("%action")
        || matches!(token, "${" | "}$")
        || is_placeholder(token)
        || is_empty_bracket(token)
        || is_letter_format(token)
}

fn token_severity(
    token: &str,
    source_count: usize,
    target_count: usize,
    context: &SeverityContext,
) -> Severity {
    let dropped = target_count < source_count;
    if context.letter && !acts_in_letter(token) {
        return Severity::Warning;
    }
    // `$1`, `$c`, and `$d` count pages, so any page change shows another line.
    if context.pages_counted && is_page_token(token) {
        return Severity::Error;
    }
    let introduces_multiple_portraits = context.introduces_multiple_portraits;
    let harmless = is_gender_switch_shape(token)
        || token == "@"
        // The game fills in or drops these placeholders; a missing, extra, or
        // renamed one only changes or shows text.
        || percent_placeholder_text(token).is_some()
        // A bare `^` or `#` changes the page or gender split in dialogue but is
        // plain text in letters and UI strings; translators decide (PD-1),
        // unless the change puts two different portraits on one page.
        || (matches!(token, "^" | "#") && !introduces_multiple_portraits)
        || (is_portrait_command(token) && !introduces_multiple_portraits)
        // A missing placeholder only drops its value. A renamed or extra
        // `{{...}}` stays literal, and in dialogue its `}` hides the text
        // before it; a `{n}` above the English ones makes string.Format throw.
        || (dropped && is_placeholder(token))
        || positional_index(token)
            .is_some_and(|index| context.max_positional.is_some_and(|max| index <= max))
        || is_skipped_page(token)
        // Without `#$b#` the game moves long text into extra boxes itself;
        // a bare `#` in its place ends the conversation early.
        || (token == "#$b#" && !(dropped && context.adds_page_breaks))
        || is_malformed_break(token)
        // A `*` in a `$y` reply becomes `#$b#` (Dialogue.cs).
        || token == "*"
        // A lone `{` in the English text cannot be a format item, and in
        // dialogue it only keeps the conversation going.
        || (dropped && token == "{")
        || (dropped && token == MAIL_TITLE)
        // `||` only changes which text shows in which week (Dialogue.cs).
        || token == "||"
        // An empty `[]` already fails in the English text.
        || (dropped && is_empty_bracket(token))
        // A letter command the game does not recognize stays visible.
        || (is_letter_format(token)
            && (dropped || source_count > 0 || letter_format_works(token)))
        // A missing value token only drops its value. A new one that is not
        // in the English text may not resolve and then shows as raw text.
        || (is_text_bracket(token)
            && (dropped
                || source_count > 0
                || always_resolves(token)
                || context.source_bracket_keys.contains(&bracket_key(token))));
    if harmless {
        Severity::Warning
    } else {
        Severity::Error
    }
}

/// Every protected-token count that differs between source and target.
/// Soft tokens (newlines, quote delimiters) are deliberately excluded.
pub fn token_differences(source: &str, target: &str) -> Vec<TokenDifference> {
    mail_differences(source, target).unwrap_or_else(|| text_differences(source, target, false))
}

const MAIL_TITLE: &str = "[#]";

/// A letter: the game shows only the text before the first `[#]`, split into
/// a male and a female version at its first bare `¦`, and the letter
/// collection shows the text after it as the title, unprocessed
/// (`LetterViewerMenu`, `CollectionsPage`; SDV 1.6). Text after a second
/// `[#]` never appears. So for an English letter with one `[#]` only the
/// letter text is compared, per player gender; a missing title stays an
/// error and extra `[#]` are a note. Mirrors TS `mailDifferences`.
fn mail_differences(source: &str, target: &str) -> Option<Vec<TokenDifference>> {
    if source.matches(MAIL_TITLE).count() != 1 {
        return None;
    }
    let target_titles = target.matches(MAIL_TITLE).count();
    let source_views = gender_views(source.split(MAIL_TITLE).next().unwrap_or_default());
    let target_views = gender_views(target.split(MAIL_TITLE).next().unwrap_or_default());
    let mut merged: Vec<TokenDifference> = Vec::new();
    for index in 0..source_views.len().max(target_views.len()) {
        let source_view = source_views[index.min(source_views.len() - 1)];
        let target_view = target_views[index.min(target_views.len() - 1)];
        for difference in text_differences(source_view, target_view, true) {
            // Keep the worse gender view: an error first, then the larger gap.
            let rank = |item: &TokenDifference| {
                (
                    item.is_error(),
                    item.source_count.abs_diff(item.target_count),
                )
            };
            match merged
                .iter_mut()
                .find(|known| known.token == difference.token)
            {
                Some(known) if rank(&difference) > rank(known) => *known = difference,
                Some(_) => {}
                None => merged.push(difference),
            }
        }
    }
    if target_titles == 0 {
        merged.push(TokenDifference {
            token: MAIL_TITLE.to_string(),
            source_count: 1,
            target_count: 0,
            severity: Severity::Warning,
        });
    }
    if target_titles > 1 {
        merged.push(TokenDifference {
            token: MAIL_TITLE.to_string(),
            source_count: 1,
            target_count: target_titles,
            severity: Severity::Warning,
        });
    }
    merged.sort_by(|left, right| left.token.cmp(&right.token));
    Some(merged)
}

/// The male and female letter text: the game splits at the first `¦` outside
/// a `${…}$` switch. A text without one reads the same for both.
fn gender_views(body: &str) -> Vec<&str> {
    let mut depth = 0usize;
    let mut rest = body.char_indices().peekable();
    while let Some((byte, char)) = rest.next() {
        let tail = &body[byte..];
        if tail.starts_with("${") {
            depth += 1;
            rest.next();
        } else if depth > 0 && tail.starts_with("}$") {
            depth -= 1;
            rest.next();
        } else if depth == 0 && char == '¦' {
            return vec![&body[..byte], &body[byte + char.len_utf8()..]];
        }
    }
    vec![body]
}

fn text_differences(source: &str, target: &str, letter: bool) -> Vec<TokenDifference> {
    let mut source_counts = counts(source);
    let mut target_counts = counts(target);
    // A switch removed (languages without grammatical gender) or added (the
    // source has none) changes only which branch a player reads. Compare the
    // side that has the switch as a player sees it, so tokens repeated in
    // every branch are not counted once per branch.
    let has_switch =
        |counts: &HashMap<String, usize>| counts.keys().any(|token| is_gender_switch_shape(token));
    let (source_switches, target_switches) =
        (has_switch(&source_counts), has_switch(&target_counts));
    if source_switches && !target_switches {
        source_counts = player_view_counts(source, &source_counts);
    }
    if target_switches && !source_switches {
        target_counts = player_view_counts(target, &target_counts);
    }
    (source_counts, target_counts) = unify_placeholder_spellings(&source_counts, &target_counts);
    allow_article_for_arguments(&mut source_counts, &target_counts);
    let pages_counted = counts_pages(source) || counts_pages(target);
    let versions = picks_version(source) || picks_version(target);
    count_dialogue_separators(source, &mut source_counts, versions);
    count_dialogue_separators(target, &mut target_counts, versions);
    let source_has_gender_switch = source_counts
        .keys()
        .any(|token| is_gender_switch_shape(token));
    let context = SeverityContext {
        introduces_multiple_portraits: pages_with_multiple_portraits(target)
            > pages_with_multiple_portraits(source),
        pages_counted,
        adds_page_breaks: target_counts.get("#").copied().unwrap_or(0)
            > source_counts.get("#").copied().unwrap_or(0),
        max_positional: source_counts
            .keys()
            .filter_map(|token| positional_index(token))
            .max(),
        letter,
        source_bracket_keys: source_counts
            .keys()
            .filter(|token| is_text_bracket(token))
            .map(|token| bracket_key(token))
            .collect(),
    };
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
            (source_count != target_count).then(|| TokenDifference {
                severity: token_severity(&token, source_count, target_count, &context),
                token,
                source_count,
                target_count,
            })
        })
        .collect()
}

/// `||` splits dialogue into versions that change every week, and in a `$d`
/// dialogue a single `|` separates its two versions (`Dialogue.cs`). Both
/// are counted next to the extracted tokens; elsewhere `|` is plain text.
/// Mirrors TS `countDialogueSeparators`.
fn count_dialogue_separators(value: &str, counts: &mut HashMap<String, usize>, versions: bool) {
    let weekly = value.matches("||").count();
    if weekly > 0 {
        counts.insert("||".to_string(), weekly);
    }
    let single = value.matches('|').count() - 2 * weekly;
    if versions && single > 0 {
        counts.insert("|".to_string(), single);
    }
}

/// SMAPI trims `{{…}}` token names and looks them up case-insensitively, and
/// Content Patcher tokens are case-insensitive too, so `{{ name }}`,
/// `{{name}}`, and `{{Name}}` are one placeholder. Each group keeps one
/// spelling as written: the first in code-point order from the English text,
/// else from the translation. Mirrors TS `unifyPlaceholderSpellings`.
fn unify_placeholder_spellings(
    source: &HashMap<String, usize>,
    target: &HashMap<String, usize>,
) -> (HashMap<String, usize>, HashMap<String, usize>) {
    let mut spelling: HashMap<String, String> = HashMap::new();
    for counts in [source, target] {
        let mut own: HashMap<String, String> = HashMap::new();
        for token in counts.keys().filter(|token| token.starts_with("{{")) {
            let key = placeholder_key(token);
            if spelling.contains_key(&key) {
                continue;
            }
            let entry = own.entry(key).or_insert_with(|| token.clone());
            if token < entry {
                *entry = token.clone();
            }
        }
        spelling.extend(own);
    }
    let merge = |counts: &HashMap<String, usize>| {
        let mut merged: HashMap<String, usize> = HashMap::new();
        for (token, count) in counts {
            let name = if token.starts_with("{{") {
                spelling
                    .get(&placeholder_key(token))
                    .cloned()
                    .unwrap_or_else(|| token.clone())
            } else {
                token.clone()
            };
            *merged.entry(name).or_insert(0) += count;
        }
        merged
    };
    (merge(source), merge(target))
}

/// Lowercase, with ASCII spaces removed right inside each `{{` and `}}`.
/// SMAPI only replaces `{{([ \w\.\-]+)}}`, so a tab, U+00A0, or U+3000 there
/// stays visible and keeps the token different. Mirrors TS `placeholderKey`
/// character for character.
fn placeholder_key(token: &str) -> String {
    let chars: Vec<char> = token.to_lowercase().chars().collect();
    let is_space = |index: usize| chars.get(index) == Some(&' ');
    let mut key = String::new();
    let mut index = 0;
    while index < chars.len() {
        if starts_with(&chars, index, "{{") {
            key.push_str("{{");
            index += 2;
            while is_space(index) {
                index += 1;
            }
            continue;
        }
        if is_space(index) {
            let mut end = index;
            while is_space(end) {
                end += 1;
            }
            if starts_with(&chars, end, "}}") {
                index = end;
                continue;
            }
        }
        key.push(chars[index]);
        index += 1;
    }
    key
}

/// A translation that drops `[ArticleFor [X]]` but keeps `[X]` itself (to
/// write its own article) loses only the article. The inner `[X]` is provided
/// by the dropped wrapper, so it is not also reported as added. Mirrors TS
/// `allowArticleForArguments`.
fn allow_article_for_arguments(
    source: &mut HashMap<String, usize>,
    target: &HashMap<String, usize>,
) {
    let mut dropped: HashMap<String, usize> = HashMap::new();
    for (token, count) in source.iter() {
        let Some(inner) = article_for_argument(token) else {
            continue;
        };
        let lost = count.saturating_sub(target.get(token).copied().unwrap_or(0));
        if lost > 0 {
            *dropped.entry(inner.to_string()).or_insert(0) += lost;
        }
    }
    for (inner, lost) in dropped {
        let expected = source.get(&inner).copied().unwrap_or(0);
        let extra = target
            .get(&inner)
            .copied()
            .unwrap_or(0)
            .saturating_sub(expected);
        if extra > 0 {
            source.insert(inner, expected + lost.min(extra));
        }
    }
}

/// The inner bracket token of `[ArticleFor [X]]`, i.e. `[X]`, or `None` when
/// the token is no such wrapper. Mirrors TS `articleForArgument`.
fn article_for_argument(token: &str) -> Option<&str> {
    let body = token.strip_prefix('[')?.strip_suffix(']')?;
    let (name, arguments) = split_bracket_name(body);
    (name.eq_ignore_ascii_case("articlefor") && is_single_protected_bracket_argument(arguments))
        .then_some(arguments)
}

/// The protected tokens that `target` is missing (or under-represents) relative
/// to `source` in a way that breaks the game, each listed once. Empty when
/// nothing blocking is missing. Used by the local-LLM translator to flag/retry
/// a result that dropped a token.
pub fn missing_token_list(source: &str, target: &str) -> Vec<String> {
    blocking_differences(source, target)
        .into_iter()
        .filter(|difference| difference.target_count < difference.source_count)
        .map(|difference| difference.token)
        .collect()
}

/// Token counts as one player sees them: switch-shape identities keep their
/// full count, every other token takes its highest count over the gender
/// branches instead of the sum of all branches (mirrors TS `playerViewCounts`).
fn player_view_counts(value: &str, all: &HashMap<String, usize>) -> HashMap<String, usize> {
    let chars: Vec<char> = value.chars().collect();
    let mut view: HashMap<String, usize> = all
        .iter()
        .filter(|(token, _)| is_gender_switch_shape(token))
        .map(|(token, count)| (token.clone(), *count))
        .collect();
    for branch in 0..3 {
        for (token, count) in counts(&branch_text(&chars, branch)) {
            let entry = view.entry(token).or_insert(0);
            *entry = (*entry).max(count);
        }
    }
    view
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

/// Find the closer of the switch at `offset`, ignoring switch-like text inside
/// a balanced Content Patcher token. The game closes a switch at the first
/// `}$` and does not nest (Stardew 1.6 `Dialogue.applyGenderSwitchBlocks`), so
/// a switch inside a switch is not read as one block; its markers stay visible
/// to validation. Mirrors TS `findGenderSwitchClose`.
fn find_switch_close(chars: &[char], offset: usize) -> Option<usize> {
    let mut index = offset + 2;

    while index < chars.len() {
        if starts_with(chars, index, "{{") {
            if let Some(end) = read_content_patcher(chars, index) {
                index = end;
                continue;
            }
        }
        if starts_with(chars, index, "${") {
            return None;
        }
        if starts_with(chars, index, "}$") {
            return Some(index);
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

/// Index of the opening quote when `$y` and spaces start a quick response at
/// `offset` (the game reads the command word, then the first `'`). Mirrors TS
/// `quickResponseQuote`.
fn quick_response_quote(chars: &[char], offset: usize) -> Option<usize> {
    if !starts_with(chars, offset, "$y ") {
        return None;
    }
    let mut index = offset + 3;
    while chars.get(index) == Some(&' ') {
        index += 1;
    }
    (chars.get(index) == Some(&'\'')).then_some(index)
}

/// `$y 'question_answer_reply_answer_reply'`: the game splits the quoted text
/// at `_` into a question and answer/reply pairs, so every separator is
/// protected. Underscores inside `{{tokens}}` or `[tokens]` are not
/// separators. A single `*` in a reply becomes a `#$b#` page break in the game
/// (`**` is a literal asterisk), so it is protected too. Mirrors TS
/// `readQuickResponse`.
fn read_quick_response(chars: &[char], offset: usize) -> Option<(usize, Vec<String>)> {
    let start = quick_response_quote(chars, offset)? + 1;
    // The last quote before the next page break closes it, so an apostrophe
    // such as "Don't" stays part of the text.
    let page = find_char(chars, start, '#').unwrap_or(chars.len());
    let close = (start..page).rev().find(|&i| chars[i] == '\'')?;
    let body = &chars[start..close];
    let mut tokens = vec!["$y".to_string(), "'".to_string(), "'".to_string()];
    // Segment 0 is the question, odd segments are answers, and even segments
    // from 2 on are replies; only replies turn `*` into a page break.
    let mut segment = 0;
    let mut index = 0;
    while index < body.len() {
        if let Some(end) = read_content_patcher(body, index).or_else(|| read_bracket(body, index)) {
            index = end;
            continue;
        }
        if starts_with(body, index, "**") {
            index += 2;
            continue;
        }
        if body[index] == '_' {
            tokens.push("_".to_string());
            segment += 1;
        } else if body[index] == '*' && segment >= 2 && segment % 2 == 0 {
            tokens.push("*".to_string());
        }
        index += 1;
    }
    tokens.extend(extract_chars(body));
    Some((close + 1, tokens))
}

/// BETAS DialogueBox argument 2 accepts prose or a runtime translation key.
/// NPC and remaining arguments stay literal; complex messages stay opaque.
fn read_betas_message(chars: &[char], offset: usize) -> Option<(usize, Vec<String>)> {
    let prefix = "#$action Spiderbuttons.BETAS_DialogueBox ";
    if !starts_with(chars, offset, prefix) {
        return None;
    }
    let mut cursor = offset + prefix.chars().count();
    let npc_start = cursor;
    while chars
        .get(cursor)
        .is_some_and(|c| !c.is_whitespace() && *c != '#' && *c != '"')
    {
        cursor += 1;
    }
    if cursor == npc_start {
        return None;
    }
    while chars.get(cursor) == Some(&' ') {
        cursor += 1;
    }
    let quote = if starts_with(chars, cursor, "\\\"") {
        "\\\""
    } else if chars.get(cursor) == Some(&'"') {
        "\""
    } else {
        return None;
    };
    let width = quote.chars().count();
    let start = cursor + width;
    let close = find_sub(chars, start, quote)?;
    let body = &chars[start..close];
    // Keep complex/argument-bearing message commands opaque until their
    // grammar is supported; numeric portraits and ordinary tokens are safe.
    if body.iter().any(|c| matches!(c, '%' | '\\' | '"'))
        || body
            .iter()
            .enumerate()
            .any(|(i, c)| *c == '$' && !body.get(i + 1).is_some_and(char::is_ascii_digit))
    {
        return None;
    }
    let end = find_char(chars, close + width, '#').unwrap_or(chars.len());
    let suffix = &chars[close + width..end];
    if suffix.iter().any(|c| *c == '"' || *c == '|') {
        return None;
    }
    // A quoted asset:key still resolves at runtime. Preserve its whole action,
    // including terminal actions without a closing #. URLs remain ordinary text.
    let is_lookup_key = body.iter().position(|c| *c == ':').is_some_and(|colon| {
        colon > 0
            && colon + 1 < body.len()
            && !body.iter().any(|c| c.is_whitespace())
            && !body[colon + 1..].contains(&':')
            && !starts_with(body, colon, "://")
    });
    if is_lookup_key {
        return Some((end, vec![chars[offset..end].iter().collect()]));
    }
    let mut raw: String = chars[offset..start].iter().collect();
    raw.extend(chars[close..end].iter());
    let mut result = vec![raw];
    result.extend(extract_chars(body));
    Some((end, result))
}

fn read_dialogue_break(chars: &[char], offset: usize) -> Option<usize> {
    if !starts_with(chars, offset, "#$") {
        return None;
    }

    // Some real mods omit the closing `#` from the argumentless `#$b#` marker
    // and put prose directly after a `$` or `*`, e.g. `#$b$Text` or `#$b*Text`.
    // Keep that malformed prefix literal but stop before the prose; otherwise
    // the generic next-`#` reader would turn all following prose into one token.
    if let Some(command_end) = read_simple_dialogue(chars, offset + 1) {
        if chars.get(command_end) == Some(&'$') {
            return Some(command_end + 1);
        }
        if starts_with(chars, offset + 1, "$b")
            && command_end == offset + 3
            && chars.get(command_end) == Some(&'*')
        {
            return Some(command_end + 1);
        }
        // `#$hSo happy!` starts a new page with a portrait followed by prose;
        // only `#` is the separator (mirrors TS `readDialogueBreak`).
        // An uppercase ASCII letter or any character that is not an ASCII
        // letter, digit, or `#` (CJK, `¡`, `«`, `Ä`, a space) starts the prose.
        if command_end == offset + 3
            && matches!(chars[offset + 2], 'h' | 's' | 'u' | 'l' | 'a')
            && chars.get(command_end).is_some_and(|next| {
                *next != '#' && (next.is_ascii_uppercase() || !next.is_ascii_alphanumeric())
            })
        {
            return None;
        }
    }
    // `#${He^She}$ ...` starts a new page with a gender switch.
    if chars.get(offset + 2) == Some(&'{') {
        return None;
    }
    // `#$y '…'` starts a quick response on a new page; its own reader protects
    // the separators instead of one opaque token for the whole page.
    if quick_response_quote(chars, offset + 1).is_some() {
        return None;
    }

    // Only the first unquoted query branch pipe may end action arguments.
    // Later pipes inside opaque actions remain protected.
    if starts_with(chars, offset, "#$action ") && starts_with(chars, 0, "$query ") {
        if let Some(pipe) = find_char(chars, offset + 2, '|') {
            let end = find_char(chars, offset + 2, '#').unwrap_or(chars.len());
            let header = &chars[offset..pipe];
            if pipe < end
                && find_char(chars, 0, '|') == Some(pipe)
                && !chars[..offset].contains(&'"')
                && !header.contains(&'"')
            {
                return Some(pipe + 1);
            }
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
    // `[]` or `[ ]` makes `TokenParser` throw.
    if body.chars().all(|c| c == ' ') {
        return true;
    }
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

        // Letter formatting (`LetterViewerMenu.ApplyCustomFormatting`).
        "letterbg" => has_atomic_argument_count(arguments, 1, 2),
        "textcolor" => has_atomic_argument_count(arguments, 1, 1),

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
    // The game strips these emotion tokens by substring (Dialogue.checkEmotions),
    // so `$sHallo` is portrait `$s` followed by prose.
    if chars
        .get(offset + 1)
        .is_some_and(|c| matches!(c, 'h' | 's' | 'u' | 'l' | 'a'))
        && chars.get(offset + 2).is_some_and(char::is_ascii_uppercase)
    {
        return Some(offset + 2);
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

/// Dialogue event/gift commands: `%fork` sets an event branch and
/// `%revealtaste:NPC:item` reveals a gift taste (Utility.ParseGiftReveals).
fn read_event_command(chars: &[char], offset: usize) -> Option<usize> {
    if starts_with(chars, offset, "%fork") {
        return Some(offset + 5);
    }
    if !starts_with(chars, offset, "%revealtaste") {
        return None;
    }
    let mut end = offset + "%revealtaste".len();
    while chars
        .get(end)
        .is_some_and(|c| !c.is_whitespace() && !matches!(c, '#' | '%' | '$' | '{' | '^' | '*'))
    {
        end += 1;
    }
    Some(end)
}

/// Dialogue placeholders the game fills in (Stardew 1.6
/// `Dialogue.percentTokens`), plus `%noturn`, which the game removes and which
/// keeps the speaker from turning to the player, each with what the game does
/// with it. The game replaces them with an exact, case-sensitive substring
/// replace, so `%Spouse` stays literal text and `50%` is never one. Longest
/// names first. Mirrors TS `PERCENT_PLACEHOLDERS` and
/// `PERCENT_PLACEHOLDER_TEXT`.
const PERCENT_PLACEHOLDERS: [(&str, &str); 17] = [
    (
        "%firstnameletter",
        "The game puts the first half of the player's name here. Fine if intended.",
    ),
    (
        "%favorite",
        "The game puts the player's favorite thing here. Fine if intended.",
    ),
    (
        "%season",
        "The game puts the current season here. Fine if intended.",
    ),
    (
        "%spouse",
        "The game puts the spouse's name here. Fine if intended.",
    ),
    (
        "%noturn",
        "It keeps the character from turning to face the player. Fine if intended.",
    ),
    (
        "%place",
        "The game puts a random place name here. Fine if intended.",
    ),
    (
        "%band",
        "The game puts the name of Sam's band here. Fine if intended.",
    ),
    (
        "%book",
        "The game puts the name of Elliott's book here. Fine if intended.",
    ),
    (
        "%farm",
        "The game puts the farm's name here. Fine if intended.",
    ),
    (
        "%kid1",
        "The game puts the first child's name here. Fine if intended.",
    ),
    (
        "%kid2",
        "The game puts the second child's name here. Fine if intended.",
    ),
    (
        "%name",
        "The game puts a random name here. Fine if intended.",
    ),
    (
        "%noun",
        "The game puts a random noun here. Fine if intended.",
    ),
    (
        "%time",
        "The game puts the current time here. Fine if intended.",
    ),
    (
        "%year",
        "The game puts the current year here. Fine if intended.",
    ),
    (
        "%adj",
        "The game puts a random adjective here. Fine if intended.",
    ),
    (
        "%pet",
        "The game puts the pet's name here. Fine if intended.",
    ),
];

fn percent_placeholder_text(token: &str) -> Option<&'static str> {
    PERCENT_PLACEHOLDERS
        .iter()
        .find(|(name, _)| *name == token)
        .map(|(_, text)| *text)
}

fn read_percent_placeholder(chars: &[char], offset: usize) -> Option<usize> {
    if chars.get(offset) != Some(&'%') {
        return None;
    }
    PERCENT_PLACEHOLDERS
        .iter()
        .find(|(name, _)| starts_with(chars, offset, name))
        .map(|(name, _)| offset + name.chars().count())
}

fn read_single_char(chars: &[char], offset: usize) -> Option<usize> {
    match chars.get(offset) {
        // In dialogue a stray `{` marks "continues on next screen" and a `}`
        // turns the text before it into a mail flag (Dialogue.cs).
        Some('@') | Some('^') | Some('#') | Some('\n') | Some('{') | Some('}') => Some(offset + 1),
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

    /// True if `target` is missing (or under-represents) any protected token
    /// that appears in `source`. Soft tokens (newlines, quote delimiters) are
    /// exempt.
    fn missing_tokens(source: &str, target: &str) -> bool {
        token_differences(source, target)
            .iter()
            .any(|difference| difference.target_count < difference.source_count)
    }

    #[test]
    fn case_variant_command_only_matches_known_commands_in_the_wrong_case() {
        assert_eq!(case_variant_command("#$B#").as_deref(), Some("#$b#"));
        assert_eq!(case_variant_command("#$E$").as_deref(), Some("#$e$"));
        assert_eq!(case_variant_command("$Q").as_deref(), Some("$q"));
        assert_eq!(
            case_variant_command("#$Action AddMoney 5#").as_deref(),
            Some("#$action AddMoney 5#")
        );
        assert_eq!(case_variant_command("#$b#"), None);
        assert_eq!(case_variant_command("$Euro"), None);
        assert_eq!(case_variant_command("{{B}}"), None);
    }

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
    fn asterisk_prefixed_malformed_break_does_not_absorb_following_prose() {
        let source = "First.#$b*Visible prose.$7#$b#Last.$2";
        let target = "Erste.#$b*Sichtbarer Text.$7#$b#Letzte.$2";

        assert_eq!(extract(source), vec!["#$b*", "$7", "#$b#", "$2"]);
        assert!(token_differences(source, target).is_empty());
    }

    #[test]
    fn dialogue_response_ignores_extra_ascii_spaces() {
        let source = "Question.#$r -1 0 event_key#Answer.";
        let target = "Frage.#$r  -1  0 event_key #Antwort.";

        assert_eq!(extract(target), vec!["#$r -1 0 event_key#"]);
        assert!(token_differences(source, target).is_empty());
        assert!(!token_differences(source, "Frage.#$r -1 0 Ereignis#Antwort.").is_empty());
        assert!(!token_differences(source, "Frage.#$r\t-1 0 event_key#Antwort.").is_empty());
    }

    #[test]
    fn translatable_text_exceptions_do_not_relax_runtime_payloads() {
        assert!(
            token_differences("Question.#$r -1 -1 Yes#Yes.", "Frage.#$r -1 -1 Yes#Ja.").is_empty()
        );
        assert!(
            !token_differences("Question.#$r -1 -1 Yes#Yes.", "Frage.#$r -1 -1 Ja#Ja.").is_empty()
        );
        assert!(!token_differences("Dinner [196 649].", "Abendessen [196 650].").is_empty());
        assert!(!token_differences(
            "Prize%item money 2500 2501 %%",
            "Preis%item Geld 2500 2501 %%"
        )
        .is_empty());
        assert!(!token_differences(
            "Request%item quest 120 %%",
            "Anfrage%Gegenstandsquest 120%%"
        )
        .is_empty());
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
    fn a_switch_inside_a_switch_is_not_one_block_like_in_the_game() {
        // Dialogue.applyGenderSwitchBlocks closes at the first `}$`, so the
        // outer markers are left over as broken text.
        assert_eq!(
            extract("${Hello ${lad^lass}$ @¦Goodbye #$b# $7}$"),
            vec!["${", "${^}$", "@", "#$b#", "$7", "}$"]
        );
        assert!(!token_differences("${he^she}$ is here", "${er ${x^y}$^sie}$ ist da").is_empty());
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
        assert_eq!(extract("${he^she}"), vec!["${", "^", "}"]);
        assert_eq!(extract("{he^she}$"), vec!["{", "^", "}$"]);
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
                    severity: Severity::Warning,
                },
                TokenDifference {
                    token: "{{name}}".into(),
                    source_count: 1,
                    target_count: 2,
                    severity: Severity::Error,
                },
            ]
        );
        assert!(token_differences("a\nb", "ab").is_empty());
    }

    fn severities(source: &str, target: &str) -> Vec<(String, Severity)> {
        token_differences(source, target)
            .into_iter()
            .map(|difference| (difference.token, difference.severity))
            .collect()
    }

    #[test]
    fn repair_comparison_puts_errors_before_lost_values() {
        let source = "Hi {{name}}, @!";
        let repair = |target: &str| repair_differences(source, target);
        // Removing an error wins although `@` is lost.
        let blocking = repair("Hallo {{other}}, @!");
        let fixed = repair("Hallo {{name}}!");
        assert!(repair_improves(&blocking, &fixed));
        assert!(!repair_worsens(&blocking, &fixed));
        // With the same errors, losing another value is worse.
        let clean = repair("Hallo {{name}}, @!");
        assert!(repair_worsens(&clean, &fixed));
        assert!(!repair_improves(&clean, &fixed));
        assert!(repair_improves(&fixed, &clean));
    }

    #[test]
    fn repair_differences_keep_errors_and_lost_values_only() {
        let tokens = |source: &str, target: &str| -> Vec<String> {
            repair_differences(source, target)
                .into_iter()
                .map(|difference| difference.token)
                .collect()
        };
        assert_eq!(
            tokens("Hello [FarmName], {{name}} and @!", "Hallo!"),
            vec!["@", "[FarmName]", "{{name}}"]
        );
        assert_eq!(tokens("Here.[128]", "Hier."), vec!["[128]"]);
        // Translation choices never cost a retry.
        assert!(tokens("Hi.$h#$b#Bye.", "Hallo. Tschüss.").is_empty());
        assert!(tokens(
            "Bring [ArticleFor [SuggestedItem]].",
            "Bring [SuggestedItem]."
        )
        .is_empty());
        assert!(tokens("Wait, %noturn friend.", "Warte, Freund.").is_empty());
    }

    #[test]
    fn harmless_differences_are_warnings() {
        // A missing portrait index falls back to portrait 0.
        assert_eq!(
            severities("Hi.$8#$b#Bye.$1", "Привет.$7#$b#Пока.$1"),
            vec![
                ("$7".to_string(), Severity::Warning),
                ("$8".to_string(), Severity::Warning)
            ]
        );
        // A cleanly removed gender switch shows the same text to everyone.
        assert_eq!(
            severities("My ${handsome^beautiful}$ wizard.$1", "Mein Zauberer.$1"),
            vec![("${^}$".to_string(), Severity::Warning)]
        );
        assert!(blocking_differences("Hi @!", "Hallo!").is_empty());
        assert!(blocking_differences("You have {{count}} items", "Du hast Items").is_empty());
        assert!(blocking_differences("{0} gold", "Gold").is_empty());
    }

    #[test]
    fn game_breaking_differences_are_errors() {
        // Unclosed switch: raw `${` and the plain `^` split cut the page.
        assert!(!blocking_differences(
            "My brave ${husband^wife}$?$4",
            "Mein ${Ehemann^Ehefrau}?$4"
        )
        .is_empty());
        // A bare `^` or `#` is a note only: plain text outside dialogue.
        assert!(blocking_differences("Hello there.", "Hallo^du.").is_empty());
        // Renamed or added placeholders stay literal.
        assert!(!blocking_differences("Hi {{name}}", "Hallo {{Name2}}").is_empty());
        assert!(!blocking_differences("Hi", "Hallo {{name}}").is_empty());
        // A second portrait on one page shows as raw text.
        assert!(!blocking_differences("Hi.$h", "Hallo.$h nett$s").is_empty());
        // Stray braces hide text or set mail flags.
        assert!(!blocking_differences("Hi.", "Hallo}.").is_empty());
        // Event and gift-taste commands carry logic.
        assert!(!blocking_differences("Yes%fork", "Ja").is_empty());
        assert!(
            !blocking_differences("Try it %revealtaste:Haley:(O)221 now", "Probier es jetzt")
                .is_empty()
        );
    }

    #[test]
    fn event_commands_and_stray_braces_are_extracted() {
        assert_eq!(
            extract("A%fork b %revealtaste:Haley:(O)221#$b#c } {"),
            vec!["%fork", "%revealtaste:Haley:(O)221", "#$b#", "}", "{"]
        );
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
        assert!(missing_tokens("Hi$b\nmore", "Hallo"));
        assert_eq!(missing_token_list("Hi$b\nmore", "Hallo"), vec!["$b"]);
    }

    #[test]
    fn quote_delimiters_are_soft_not_blocking() {
        // The source uses backticks (no `'`); the translation introduces a
        // paired `'…'`. That is punctuation, not runtime syntax, so it must not
        // appear as a blocking difference or a missing token.
        let source = "Use `Default` to modify the settings.";
        let target = "'Standard' verwenden, um die Einstellungen anzupassen.";
        assert!(token_differences(source, target).is_empty());
        assert!(!missing_tokens(source, target));
        assert!(missing_token_list(source, target).is_empty());

        // A dropped quote delimiter is equally non-blocking.
        assert!(!missing_tokens("'test'", "test"));
        assert!(missing_token_list("'test'", "test").is_empty());

        // Real tokens are still enforced when a quote difference also exists.
        assert!(missing_tokens("Hi$b 'q'", "Hallo"));
        assert_eq!(missing_token_list("Hi$b 'q'", "Hallo"), vec!["$b"]);
    }

    /// Drift guard against the TS extractor: both suites run the same fixture
    /// (`tests/fixtures/token-cases.json`). The two implementations are
    /// hand-synced ports — a divergence means the editor's live validation and
    /// the export skip rule disagree, the worst kind of inconsistency.
    #[test]
    fn shared_fixture_cases_match() {
        let body = include_str!("../../tests/fixtures/token-cases.json");
        let parsed: serde_json::Value = serde_json::from_str(body).unwrap();
        for case in parsed["comparisons"].as_array().unwrap() {
            let blocked = !blocking_differences(
                case["source"].as_str().unwrap(),
                case["target"].as_str().unwrap(),
            )
            .is_empty();
            assert_eq!(
                blocked,
                case["blocked"].as_bool().unwrap(),
                "{}",
                case["name"]
            );
        }
        for case in parsed["explanations"].as_array().unwrap() {
            let (source, target) = (
                case["source"].as_str().unwrap(),
                case["target"].as_str().unwrap(),
            );
            let differences = token_differences(source, target);
            assert_eq!(
                explain_differences(&differences, target),
                case["text"].as_str().unwrap(),
                "explain({target:?})"
            );
            // Order and severity per difference, as TS `tokenDifferences`.
            if let Some(expected) = case["differences"].as_array() {
                let actual: Vec<serde_json::Value> = differences
                    .iter()
                    .map(|difference| {
                        serde_json::json!({
                            "token": difference.token,
                            "sourceCount": difference.source_count,
                            "targetCount": difference.target_count,
                            "severity": difference.severity,
                        })
                    })
                    .collect();
                assert_eq!(&actual, expected, "differences({target:?})");
            }
            // The export explains only the errors that leave a string out.
            if let Some(errors_text) = case["errorsText"].as_str() {
                assert_eq!(
                    explain_differences(&blocking_differences(source, target), target),
                    errors_text,
                    "explain errors({target:?})"
                );
            }
        }
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
