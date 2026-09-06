//! Optional Nexus discovery, explicit Vortex download/install requests, and state-only ZIP import.
use crate::{language, scanner, settings, tokens, translations};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    io::{Cursor, Read},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

const API: &str = "https://api.nexusmods.com";
const JSON_LIMIT: usize = 2_000_000;
const ARCHIVE_JSON_LIMIT: usize = 16 * 1024 * 1024;
const DOWNLOAD_LIMIT: usize = 64 * 1024 * 1024;
const TTL: Duration = Duration::from_secs(900);
const SEARCH_TTL_MS: u64 = 24 * 60 * 60 * 1000;
const CACHE_LIMIT: usize = 8 * 1024 * 1024;
const NOTICE: &str = "Heuristic candidates only; bounded search cannot prove absence. Archive paths and versions do not prove compatibility. Source changes before first import are unknown. Review before export.";
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NexusStatus {
    configured: bool,
    premium: bool,
    validated: bool,
    account_status: &'static str,
    checked_at: Option<u64>,
    error: Option<String>,
    quota: Vec<NexusQuota>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NexusQuota {
    scope: &'static str,
    observed_at: u64,
    hourly_limit: Option<u64>,
    hourly_remaining: Option<u64>,
    hourly_reset: Option<String>,
    daily_limit: Option<u64>,
    daily_remaining: Option<u64>,
    daily_reset: Option<String>,
    retry_after_seconds: Option<u64>,
    blocked_until: Option<u64>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    mod_id: u64,
    name: String,
    summary: String,
    version: String,
    updated_at: String,
    relationship_tier: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Discovery {
    mod_id: u64,
    original_name: String,
    candidates: Vec<Candidate>,
    limited: bool,
    notice: String,
    fetched_at: u64,
    expires_at: u64,
    cache_status: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NexusFile {
    file_id: u64,
    name: String,
    version: String,
    uploaded_at: String,
    file_name: String,
    category: String,
    description: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveFile {
    path: String,
    manifest_unique_id: Option<String>,
    is_default: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchivePreview {
    archive_id: String,
    files: Vec<ArchiveFile>,
    notice: String,
}
#[derive(Clone)]
struct Archive {
    created: Instant,
    files: Vec<ArchiveFile>,
    documents: HashMap<String, String>,
    source_url: Option<String>,
}
#[derive(Default)]
struct Session {
    archives: HashMap<String, Archive>,
    auth: Option<(String, Instant, bool)>,
    preflights: HashMap<String, (Instant, String)>,
    credential: Option<String>,
    quota: Vec<NexusQuota>,
    checked_at: Option<u64>,
    auth_error: Option<(&'static str, String)>,
}
fn fingerprint(key: &str) -> String {
    format!("{:x}", Sha256::digest(key.as_bytes()))
}
impl Session {
    // The caller holds the session lock while reading the saved credential and
    // preparing refresh. Never clear auth in a later, separate critical section.
    fn begin_status(&mut self, key: Option<&str>, refresh: bool) {
        self.activate(key);
        if refresh {
            self.auth = None;
            self.auth_error = None;
        }
    }
    fn activate(&mut self, key: Option<&str>) {
        let credential = key.map(fingerprint);
        if self.credential != credential {
            *self = Self {
                credential,
                ..Self::default()
            };
        }
    }
    fn status(&self) -> NexusStatus {
        let premium = self
            .auth
            .as_ref()
            .filter(|(_, at, _)| at.elapsed() < TTL)
            .map(|(_, _, premium)| *premium);
        NexusStatus {
            configured: self.credential.is_some(),
            premium: premium.unwrap_or(false),
            validated: premium.is_some(),
            account_status: if self.credential.is_none() {
                "unconfigured"
            } else if let Some(premium) = premium {
                if premium {
                    "premium"
                } else {
                    "free"
                }
            } else if let Some((status, _)) = &self.auth_error {
                status
            } else {
                "unknown"
            },
            checked_at: self.checked_at,
            error: self.auth_error.as_ref().map(|(_, error)| error.clone()),
            quota: self.quota.clone(),
        }
    }
    fn check_request(&self, key: &str, _scope: &str, now: u64) -> Result<(), String> {
        if self.credential.as_deref() != Some(&fingerprint(key)) {
            return Err("Nexus credentials changed; start the action again.".into());
        }
        if let Some(("invalid", error)) = &self.auth_error {
            return Err(error.clone());
        }
        self.check_backoff(now)
    }
    fn check_backoff(&self, now: u64) -> Result<(), String> {
        // A cautious local pause across this credential's API calls does not
        // assert that REST and GraphQL share a server-side allowance.
        if self
            .quota
            .iter()
            .any(|q| q.blocked_until.is_some_and(|until| until > now))
        {
            return Err("Nexus rate limit reached (HTTP 429). Wait before retrying; see API usage for retry details.".into());
        }
        Ok(())
    }
    fn commit_candidate(
        &mut self,
        candidate: Session,
        persist: impl FnOnce() -> Result<(), String>,
    ) -> Result<NexusStatus, String> {
        persist()?;
        *self = candidate;
        Ok(self.status())
    }
    fn observe(
        &mut self,
        key: &str,
        scope: &'static str,
        headers: &reqwest::header::HeaderMap,
        status: u16,
        now: u64,
    ) {
        if self.credential.as_deref() != Some(&fingerprint(key)) {
            return;
        }
        let counter = |name: &str| {
            headers
                .get(name)?
                .to_str()
                .ok()?
                .parse::<u64>()
                .ok()
                .filter(|v| *v <= 9_007_199_254_740_991)
        };
        let reset = |name: &str| reset_value(headers.get(name)?.to_str().ok()?);
        let retry_after_seconds = counter("retry-after");
        let quota = NexusQuota {
            scope,
            observed_at: now,
            hourly_limit: counter("x-rl-hourly-limit"),
            hourly_remaining: counter("x-rl-hourly-remaining"),
            hourly_reset: reset("x-rl-hourly-reset"),
            daily_limit: counter("x-rl-daily-limit"),
            daily_remaining: counter("x-rl-daily-remaining"),
            daily_reset: reset("x-rl-daily-reset"),
            retry_after_seconds,
            // The documented daily allowance can fall back to the hourly
            // allowance. Only an actual 429 starts this local backoff.
            blocked_until: (status == 429).then(|| {
                now.saturating_add(
                    retry_after_seconds
                        .unwrap_or(60)
                        .max(1)
                        .saturating_mul(1000),
                )
            }),
        };
        self.quota.retain(|q| q.scope != scope);
        self.quota.push(quota);
        if status == 401 || status == 403 {
            self.auth = None;
            self.checked_at = Some(now);
            self.auth_error = Some((
                if status == 401 { "invalid" } else { "error" },
                api_error(status),
            ));
        }
    }
}
fn api_error(status: u16) -> String {
    match status {
        401 => "Nexus rejected the API key (HTTP 401). Replace the key and reconnect.".into(),
        403 => "Nexus denied API access (HTTP 403). Check the account and API permissions.".into(),
        429 => "Nexus rate limit reached (HTTP 429). Wait before retrying; see API usage for retry details.".into(),
        _ => format!("Nexus request failed (HTTP {status}). Retry later or check API setup."),
    }
}
fn reset_value(value: &str) -> Option<String> {
    if value.len() > 64 || value.is_empty() {
        return None;
    }
    if value.bytes().all(|c| c.is_ascii_digit()) {
        return value
            .parse::<u64>()
            .ok()
            .filter(|v| *v <= 9_007_199_254_740_991)
            .map(|_| value.to_owned());
    }
    // Accept a bounded UTC ISO timestamp; unsupported wire formats stay unknown.
    let bytes = value.as_bytes();
    if bytes.len() < 20
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
        || bytes.last() != Some(&b'Z')
    {
        return None;
    }
    for (start, end, min, max) in [
        (0, 4, 1, 9999),
        (5, 7, 1, 12),
        (8, 10, 1, 31),
        (11, 13, 0, 23),
        (14, 16, 0, 59),
        (17, 19, 0, 59),
    ] {
        let part = bytes.get(start..end)?;
        if !part.iter().all(u8::is_ascii_digit) {
            return None;
        }
        let number = std::str::from_utf8(part).ok()?.parse::<u32>().ok()?;
        if number < min || number > max {
            return None;
        }
    }
    if bytes.len() > 20
        && (bytes[19] != b'.'
            || bytes.len() == 21
            || !bytes[20..bytes.len() - 1].iter().all(u8::is_ascii_digit))
    {
        return None;
    }
    Some(value.into())
}
fn account_premium(account: &Value) -> Result<bool, String> {
    if number(&account["user_id"]).unwrap_or(0) == 0 {
        return Err("Nexus API key validation failed.".into());
    }
    account["is_premium"]
        .as_bool()
        .ok_or_else(|| "Nexus account status is unavailable; reconnect later.".into())
}
fn session() -> &'static Mutex<Session> {
    static S: OnceLock<Mutex<Session>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(Session::default()))
}
fn lock() -> std::sync::MutexGuard<'static, Session> {
    session().lock().unwrap_or_else(|p| p.into_inner())
}
fn positive(id: u64) -> Result<(), String> {
    if id == 0 || id > 9_007_199_254_740_991 {
        Err("Invalid Nexus ID.".into())
    } else {
        Ok(())
    }
}
fn text(v: &Value, key: &str) -> String {
    v[key]
        .as_str()
        .unwrap_or_default()
        .chars()
        .take(2000)
        .collect()
}
fn number(v: &Value) -> Option<u64> {
    v.as_u64().or_else(|| v.as_str()?.parse().ok())
}
fn environment_key() -> Option<String> {
    #[cfg(windows)]
    if let Ok(env) =
        winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER).open_subkey("Environment")
    {
        if let Ok(value) = env.get_value::<String, _>("NEXUS_API_KEY") {
            if !value.trim().is_empty() {
                return Some(value.trim().to_owned());
            }
        }
    }
    std::env::var("NEXUS_API_KEY")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim().to_owned())
}
fn client(seconds: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(seconds))
        .build()
        .map_err(|_| "Could not initialize Nexus connection.".into())
}
async fn bounded(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>, String> {
    if !response.status().is_success() {
        return Err(format!(
            "Nexus request failed (HTTP {}). Retry later or check API setup.",
            response.status().as_u16()
        ));
    }
    if response.content_length().is_some_and(|n| n > limit as u64) {
        return Err("Nexus response exceeds size limit.".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Nexus response failed or timed out.")?
    {
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err("Nexus response exceeds size limit.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
async fn send_api(key: &str, path: &str, body: Option<Value>) -> Result<reqwest::Response, String> {
    let c = client(20)?;
    let mut req = if body.is_some() {
        c.post(format!("{API}{path}"))
    } else {
        c.get(format!("{API}{path}"))
    };
    let mut secret =
        reqwest::header::HeaderValue::from_str(key).map_err(|_| "Invalid Nexus API key format.")?;
    secret.set_sensitive(true);
    req = req
        .header("apikey", secret)
        .header("Application-Name", "Stardew i18n Translator")
        .header("Application-Version", env!("CARGO_PKG_VERSION"));
    if let Some(body) = body {
        req = req.json(&body);
    }
    req.send()
        .await
        .map_err(|_| "Nexus request failed (network, timeout, or redirect).".into())
}
fn api_gate() -> &'static tokio::sync::Mutex<()> {
    static REQUEST_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    REQUEST_LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}
async fn request(key: &str, path: &str, body: Option<Value>) -> Result<Value, String> {
    // Queued calls recheck backoff; no automatic retries or background polling.
    let _guard = api_gate().lock().await;
    let scope = if path.starts_with("/v2/") {
        "graphql-v2"
    } else {
        "rest-v1"
    };
    lock().check_request(key, scope, now_ms())?;
    let response = send_api(key, path, body).await?;
    let status = response.status().as_u16();
    lock().observe(key, scope, response.headers(), status, now_ms());
    if !response.status().is_success() {
        return Err(api_error(status));
    }
    let bytes = bounded(response, JSON_LIMIT).await?;
    lock().check_request(key, scope, now_ms())?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| "Invalid Nexus API response.")?;
    if value.get("errors").is_some() {
        return Err("Nexus GraphQL search unavailable (API access or schema error).".into());
    }
    Ok(value)
}
async fn validate(key: &str) -> Result<bool, String> {
    let fingerprint = fingerprint(key);
    {
        let mut session = lock();
        if environment_key().as_deref() != Some(key) {
            return Err("Nexus credentials changed; start the action again.".into());
        }
        session.activate(Some(key));
    }
    if let Some((hash, at, premium)) = &lock().auth {
        if hash == &fingerprint && at.elapsed() < TTL {
            return Ok(*premium);
        }
    }
    let account = request(key, "/v1/users/validate.json", None).await?;
    let premium = account_premium(&account)?;
    let mut session = lock();
    if session.credential.as_ref() != Some(&fingerprint) {
        return Err("Nexus credentials changed; start the action again.".into());
    }
    session.auth = Some((fingerprint, Instant::now(), premium));
    session.checked_at = Some(now_ms());
    session.auth_error = None;
    Ok(premium)
}
#[tauri::command]
pub async fn nexus_status(force_refresh: Option<bool>) -> Result<NexusStatus, String> {
    let key = {
        let mut session = lock();
        let key = environment_key();
        session.begin_status(key.as_deref(), force_refresh.unwrap_or(false));
        key
    };
    if let Some(key) = key.filter(|_| force_refresh.unwrap_or(false)) {
        if let Err(error) = validate(&key).await {
            let mut session = lock();
            if session.credential.as_deref() == Some(&fingerprint(&key)) {
                session.checked_at = Some(now_ms());
                if session
                    .auth_error
                    .as_ref()
                    .is_none_or(|(kind, _)| *kind != "invalid")
                {
                    session.auth_error = Some(("error", error));
                }
            }
        }
    }
    Ok(lock().status())
}
#[tauri::command]
pub async fn nexus_save_key(key: String) -> Result<NexusStatus, String> {
    let key = key.trim();
    if key.is_empty() || key.len() > 4096 {
        return Err("Enter a valid Nexus API key.".into());
    }
    let _guard = api_gate().lock().await;
    {
        let session = lock();
        if session.credential.as_deref() == Some(&fingerprint(key)) {
            session.check_backoff(now_ms())?;
        }
    }
    // Validate in isolation: passive snapshots continue to describe the saved
    // connection until persistence and session activation succeed together.
    let mut candidate = Session::default();
    candidate.activate(Some(key));
    let response = send_api(key, "/v1/users/validate.json", None).await?;
    let status = response.status().as_u16();
    candidate.observe(key, "rest-v1", response.headers(), status, now_ms());
    // Rechecking the saved key may update its observed headers even on 429;
    // an unsaved replacement must not overwrite the saved connection's data.
    lock().observe(key, "rest-v1", response.headers(), status, now_ms());
    if !response.status().is_success() {
        return Err(api_error(status));
    }
    let bytes = bounded(response, JSON_LIMIT).await?;
    let account: Value =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid Nexus API response.")?;
    let premium = account_premium(&account)?;
    candidate.auth = Some((fingerprint(key), Instant::now(), premium));
    candidate.checked_at = Some(now_ms());
    lock().commit_candidate(candidate, || {
        #[cfg(windows)]
        {
            let env = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
                .open_subkey_with_flags("Environment", winreg::enums::KEY_SET_VALUE)
                .map_err(|_| "Could not open Windows user environment.")?;
            env.set_value("NEXUS_API_KEY", &key)
                .map_err(|_| "Could not save Nexus key to Windows user environment.")?;
            Ok(())
        }
        #[cfg(not(windows))]
        {
            Err("Nexus setup is supported on Windows only.".into())
        }
    })
}
fn language_words(lang: &str) -> &'static [&'static str] {
    match lang {
        "de" => &["german", "deutsch", "deutsche", "deutschen"],
        "fr" => &["french", "français", "francais"],
        "es" => &["spanish", "español", "espanol"],
        "pt" => &["portuguese", "português", "brazilian"],
        "it" => &["italian", "italiano"],
        "ru" => &["russian", "русский"],
        "zh" => &["chinese", "中文", "汉化"],
        "ja" => &["japanese", "日本語"],
        "ko" => &["korean", "한국어"],
        "tr" => &["turkish", "türkçe"],
        "hu" => &["hungarian", "magyar"],
        "vi" => &["vietnamese", "việt"],
        "en" => &["english"],
        _ => &[],
    }
}
fn language_match(value: &str, lang: &str) -> bool {
    let lower = value.to_lowercase();
    let aliases: &[&str] = match lang {
        "de" => &["ger"],
        "ja" => &["jp"],
        "zh" => &["chs", "cht"],
        _ => &[],
    };
    if lower
        .split(|c: char| !c.is_alphanumeric())
        .any(|part| aliases.contains(&part))
        || lower.contains(&format!("[{lang}]"))
        || lower.contains(&format!("({lang})"))
    {
        return true;
    }
    language_words(lang).iter().any(|word| {
        lower
            .split(|c: char| !c.is_alphanumeric())
            .any(|part| part == *word)
            || (!word.is_ascii() && lower.contains(word))
    })
}
fn normalized(value: &str) -> String {
    value
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}
fn relationship_tier(original: &str, title: &str, lang: &str) -> &'static str {
    let joined_translation_label = |word: &str| {
        word.strip_suffix("translation")
            .is_some_and(|language| language_words(lang).contains(&language))
    };
    let translation_qualifier = |word: &str| {
        language_words(lang).contains(&word)
            || joined_translation_label(word)
            || word == lang
            || matches!(word, "translation" | "translations")
            || (lang == "de" && matches!(word, "ger" | "übersetzung"))
            || (lang == "ja" && word == "jp")
            || (lang == "zh" && matches!(word, "chs" | "cht" | "simplified" | "traditional"))
    };
    let has_language = |words: &[&str]| {
        words.contains(&lang)
            || language_match(&words.join(" "), lang)
            || words.iter().any(|word| joined_translation_label(word))
    };
    let source = normalized(&search_name(original));
    // Keep candidate qualifiers, including parentheses: they may name an add-on.
    let title = normalized(title);
    let source: Vec<_> = source.split_whitespace().collect();
    let title: Vec<_> = title.split_whitespace().collect();
    if !source.is_empty() && title.len() >= source.len() {
        for start in 0..=title.len() - source.len() {
            if title[start..start + source.len()] != source {
                continue;
            }
            let qualifiers: Vec<_> = title[..start]
                .iter()
                .chain(&title[start + source.len()..])
                .copied()
                .collect();
            if has_language(&qualifiers)
                && qualifiers.iter().all(|word| translation_qualifier(word))
            {
                return "possible-original-translation";
            }
        }
    }
    // A translation may reorder a subtitle ("NPC Rodney" -> "Rodney a new
    // NPC"). Require every full-title token, including parenthetical subjects,
    // before allowing that wording. Extra named subjects still identify add-ons.
    let full_source = normalized(original);
    let mut qualifiers = title.clone();
    if !full_source.is_empty()
        && full_source.split_whitespace().all(|word| {
            if let Some(index) = qualifiers.iter().position(|candidate| *candidate == word) {
                qualifiers.remove(index);
                true
            } else {
                false
            }
        })
        && has_language(&qualifiers)
        && qualifiers
            .iter()
            .all(|word| translation_qualifier(word) || matches!(*word, "a" | "new" | "for"))
    {
        return "possible-original-translation";
    }
    "possible-addon-or-other-translation"
}

fn classify_candidates(original: &str, lang: &str, candidates: &mut [Candidate]) {
    for candidate in candidates.iter_mut() {
        candidate.relationship_tier = relationship_tier(original, &candidate.name, lang).into();
    }
    candidates.sort_by(|a, b| {
        a.relationship_tier
            .cmp(&b.relationship_tier)
            .reverse()
            .then(b.updated_at.cmp(&a.updated_at))
    });
}
fn search_name(value: &str) -> String {
    // Canonical titles often append aliases such as "(GMCM)". The search
    // interprets all terms, so requiring that alias hides otherwise exact titles.
    let mut depth = 0usize;
    value
        .chars()
        .filter(|c| match c {
            '(' | '[' => {
                depth += 1;
                false
            }
            ')' | ']' => {
                depth = depth.saturating_sub(1);
                false
            }
            _ => depth == 0,
        })
        .collect::<String>()
        .trim()
        .to_owned()
}
#[tauri::command]
pub async fn nexus_find_translations(
    app: AppHandle,
    mod_id: u64,
    target_lang: String,
    force_refresh: Option<bool>,
) -> Result<Discovery, String> {
    find_translations(
        &crate::config_dir(&app)?,
        mod_id,
        &target_lang,
        force_refresh.unwrap_or(false),
    )
    .await
}

async fn find_translations(
    config: &Path,
    mod_id: u64,
    target_lang: &str,
    force_refresh: bool,
) -> Result<Discovery, String> {
    positive(mod_id)?;
    let lang = language::normalize_target_code(target_lang)?;
    if let Some(result) = cached_discovery(config, mod_id, &lang, now_ms(), force_refresh) {
        return Ok(result);
    }
    let key = environment_key().ok_or("Configure NEXUS_API_KEY first.")?;
    validate(&key).await?;
    let original = request(
        &key,
        &format!("/v1/games/stardewvalley/mods/{mod_id}.json"),
        None,
    )
    .await?;
    if number(&original["mod_id"]) != Some(mod_id) {
        return Err("Original Nexus metadata identity mismatch.".into());
    }
    let name = text(&original, "name");
    if name.is_empty() {
        return Err("Original Nexus name unavailable.".into());
    }
    let query="query Search($filter:ModsFilter,$offset:Int,$count:Int){mods(filter:$filter,sort:[{updatedAt:{direction:DESC}}],offset:$offset,count:$count){totalCount nodes{modId gameId name summary updatedAt version}}}";
    let mut found = HashMap::new();
    let mut limited = false;
    let search_title = search_name(&name);
    let mut searches = vec![search_title.clone()];
    if let Some(word) = language_words(&lang).first() {
        searches.push(format!("{search_title} {word}"));
    }
    for search in searches {
        let data=request(&key,"/v2/graphql",Some(json!({"query":query,"variables":{"filter":{"gameDomainName":[{"op":"EQUALS","value":"stardewvalley"}],"nameStemmed":[{"op":"MATCHES","value":search}]},"offset":0,"count":30}}))).await?;
        let page = &data["data"]["mods"];
        let rows = page["nodes"]
            .as_array()
            .ok_or("Unexpected Nexus search response.")?;
        limited |= page["totalCount"].as_u64().unwrap_or(u64::MAX) > rows.len() as u64;
        for row in rows.iter().take(30) {
            let Some(id) = number(&row["modId"]) else {
                continue;
            };
            if id == mod_id || id == 0 || number(&row["gameId"]) != Some(1303) {
                continue;
            }
            let title = text(row, "name");
            let summary = text(row, "summary");
            if !language_match(&format!("{title} {summary}"), &lang) {
                continue;
            }
            found.insert(
                id,
                Candidate {
                    mod_id: id,
                    name: title,
                    summary,
                    version: text(row, "version"),
                    updated_at: text(row, "updatedAt"),
                    relationship_tier: String::new(),
                },
            );
        }
    }
    let mut candidates: Vec<_> = found.into_values().collect();
    classify_candidates(&name, &lang, &mut candidates);
    limited |= candidates.len() > 30;
    candidates.truncate(30);
    let fetched_at = now_ms();
    let result = Discovery {
        mod_id,
        original_name: name,
        candidates,
        limited,
        notice: NOTICE.into(),
        fetched_at,
        expires_at: fetched_at.saturating_add(SEARCH_TTL_MS),
        cache_status: "fresh".into(),
    };
    if store_discovery(config, &lang, &result).is_err() {
        log::warn!(target: "app", "Nexus metadata cache could not be saved; current search results remain available.");
    }
    Ok(result)
}
#[tauri::command]
pub async fn nexus_list_files(mod_id: u64) -> Result<Vec<NexusFile>, String> {
    positive(mod_id)?;
    let key = environment_key().ok_or("Configure NEXUS_API_KEY first.")?;
    validate(&key).await?;
    let data = request(
        &key,
        &format!("/v1/games/stardewvalley/mods/{mod_id}/files.json"),
        None,
    )
    .await?;
    let rows = data["files"]
        .as_array()
        .ok_or("Unexpected Nexus file list.")?;
    let mut files: Vec<_> = rows
        .iter()
        .filter(|r| {
            !matches!(
                r["category_name"].as_str(),
                Some("OLD_VERSION" | "ARCHIVED" | "REMOVED")
            )
        })
        .filter_map(|r| {
            Some(NexusFile {
                file_id: number(&r["file_id"]).filter(|n| *n > 0)?,
                name: text(r, "name"),
                version: text(r, "version"),
                uploaded_at: text(r, "uploaded_time"),
                file_name: text(r, "file_name"),
                category: text(r, "category_name"),
                description: text(r, "description"),
            })
        })
        .collect();
    files.sort_by(|a, b| b.uploaded_at.cmp(&a.uploaded_at));
    files.truncate(100);
    Ok(files)
}
fn cdn_url(value: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(value).map_err(|_| "Invalid Nexus CDN URL.")?;
    let host = url.host_str().unwrap_or_default();
    let allowed = host == "premium.nexusmods.com"
        || host == "cf-files.nexusmods.com"
        || host.strip_suffix(".nexus-cdn.com").is_some_and(|s| {
            !s.is_empty() && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
        });
    if url.scheme() != "https"
        || !allowed
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
    {
        return Err("Nexus CDN destination blocked.".into());
    }
    Ok(url)
}
#[tauri::command]
pub async fn nexus_download_preflight(mod_id: u64, file_id: u64) -> Result<ArchivePreview, String> {
    positive(mod_id)?;
    positive(file_id)?;
    let key = environment_key().ok_or("Configure NEXUS_API_KEY first.")?;
    if !validate(&key).await? {
        return Err("Official API downloads require Nexus Premium.".into());
    }
    let metadata = request(
        &key,
        &format!("/v1/games/stardewvalley/mods/{mod_id}/files/{file_id}.json"),
        None,
    )
    .await?;
    if number(&metadata["file_id"]) != Some(file_id) {
        return Err("Nexus file identity mismatch.".into());
    }
    if !text(&metadata, "file_name")
        .to_lowercase()
        .ends_with(".zip")
    {
        return Err(
            "This local build supports ZIP translation archives only. RAR and 7z are unsupported."
                .into(),
        );
    }
    let expected = number(&metadata["size_in_bytes"]);
    if expected.is_some_and(|n| n > DOWNLOAD_LIMIT as u64) {
        return Err("Translation archive exceeds 64 MiB download limit.".into());
    }
    let links = request(
        &key,
        &format!("/v1/games/stardewvalley/mods/{mod_id}/files/{file_id}/download_link.json"),
        None,
    )
    .await?;
    let url = cdn_url(
        links[0]["URI"]
            .as_str()
            .ok_or("Official download URL unavailable.")?,
    )?;
    // Separate client/request: no API key, account headers, cookies, or referrer.
    let bytes = bounded(
        client(120)?
            .get(url)
            .send()
            .await
            .map_err(|_| "Nexus CDN download failed or timed out.")?,
        DOWNLOAD_LIMIT,
    )
    .await?;
    if expected.is_some_and(|n| n != bytes.len() as u64) {
        return Err("Downloaded archive size differs from Nexus metadata.".into());
    }
    let downloaded_bytes = bytes.len();
    let archive_id = format!("{:x}", Sha256::digest(&bytes));
    let mut archive = inspect_zip(bytes)?;
    archive.source_url = Some(format!(
        "https://www.nexusmods.com/stardewvalley/mods/{mod_id}?tab=files&file_id={file_id}"
    ));
    let preview = ArchivePreview {
        archive_id: archive_id.clone(),
        files: archive.files.clone(),
        notice: NOTICE.into(),
    };
    let mut s = lock();
    s.archives.retain(|_, a| a.created.elapsed() < TTL);
    if s.archives.len() >= 3 {
        s.archives.clear();
    }
    s.archives.insert(archive_id, archive);
    // Completion means the selected ZIP passed inspection and is available for
    // mapping in this session. It does not mean any translation was imported.
    log::info!(target: "app", "event=nexus_download_complete mod_id={} file_id={} downloaded_bytes={} i18n_json_files={} storage=memory imported=0 exported=0", mod_id, file_id, downloaded_bytes, preview.files.len());
    Ok(preview)
}
fn safe_archive_path(path: &str) -> Result<String, String> {
    let path = path.replace('\\', "/");
    if path.is_empty()
        || path.starts_with('/')
        || path.contains(':')
        || path.contains('\0')
        || path.split('/').any(|p| p == ".." || p == ".")
    {
        return Err("Unsafe ZIP entry path.".into());
    }
    Ok(path)
}
fn inspect_zip(bytes: Vec<u8>) -> Result<Archive, String> {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|_| "Unsupported or invalid ZIP archive.")?;
    if zip.len() > 5000 {
        return Err("ZIP contains too many entries.".into());
    }
    let mut documents = HashMap::new();
    let mut seen = HashSet::new();
    let mut total = 0u64;
    for i in 0..zip.len() {
        let mut entry = zip
            .by_index(i)
            .map_err(|_| "Unreadable or encrypted ZIP entry.")?;
        let path = safe_archive_path(entry.name())?;
        if !seen.insert(path.to_lowercase()) {
            return Err("ZIP contains ambiguous duplicate paths.".into());
        }
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err("ZIP symlinks are unsupported.".into());
        }
        let lower = path.to_lowercase();
        if entry.is_dir() || !lower.ends_with(".json") {
            continue;
        }
        let is_i18n = lower.split('/').rev().nth(1) == Some("i18n")
            && !lower.starts_with("assets/i18n/")
            && !lower.contains("/assets/i18n/");
        if !is_i18n && !lower.ends_with("manifest.json") {
            continue;
        }
        total = total.saturating_add(entry.size());
        if entry.size() > ARCHIVE_JSON_LIMIT as u64 || total > 32 * 1024 * 1024 {
            return Err("ZIP JSON exceeds decompression limits.".into());
        }
        let mut bytes = Vec::new();
        (&mut entry)
            .take(ARCHIVE_JSON_LIMIT as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "Could not read ZIP JSON.")?;
        if bytes.len() > ARCHIVE_JSON_LIMIT {
            return Err("ZIP JSON exceeds size limit.".into());
        }
        documents.insert(
            path,
            String::from_utf8(bytes).map_err(|_| "ZIP JSON must be UTF-8.")?,
        );
    }
    let mut manifests = HashMap::new();
    for (path, body) in &documents {
        if path
            .rsplit('/')
            .next()
            .is_some_and(|s| s.eq_ignore_ascii_case("manifest.json"))
        {
            let v =
                scanner::parse_json_lenient(body).map_err(|_| "Invalid archive manifest JSON.")?;
            let uid = v["UniqueID"]
                .as_str()
                .filter(|s| !s.trim().is_empty())
                .ok_or("Archive manifest has no valid UniqueID.")?;
            manifests.insert(
                path.rsplit_once('/')
                    .map(|(p, _)| p)
                    .unwrap_or("")
                    .to_lowercase(),
                uid.to_owned(),
            );
        }
    }
    let mut files = Vec::new();
    for path in documents.keys() {
        let lower = path.to_lowercase();
        if lower.split('/').rev().nth(1) != Some("i18n") {
            continue;
        }
        let mut parent = path.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
        let mut uid = None;
        loop {
            if let Some(found) = manifests.get(&parent.to_lowercase()) {
                uid = Some(found.clone());
                break;
            }
            if parent.is_empty() {
                break;
            }
            parent = parent.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
        }
        files.push(ArchiveFile {
            path: path.clone(),
            manifest_unique_id: uid,
            is_default: lower.ends_with("/default.json"),
        });
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    if files.is_empty() {
        return Err("ZIP contains no supported i18n JSON files.".into());
    }
    Ok(Archive {
        source_url: None,
        created: Instant::now(),
        files,
        documents,
    })
}
#[derive(Default, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportCounts {
    matched: usize,
    missing: usize,
    extra: usize,
    empty: usize,
    source_equal: usize,
    token_invalid: usize,
    conflicts: usize,
    importable: usize,
    imported: usize,
    notice: String,
}
fn analyze(
    rows: &[scanner::StringRow],
    body: &str,
    relative_dir: &str,
) -> Result<(ImportCounts, Vec<(String, translations::StoredString)>), String> {
    let map = scanner::parse_flat_object(body, Path::new("selected archive JSON"))?;
    let mut values = HashMap::new();
    for (key, value) in &map {
        if key == "$schema" {
            continue;
        }
        if values
            .insert(
                key.trim().to_lowercase(),
                value.as_str().unwrap_or_default(),
            )
            .is_some()
        {
            return Err("Archive JSON has ambiguous case-insensitive keys.".into());
        }
    }
    let source_keys: HashSet<_> = rows.iter().map(|r| r.key.trim().to_lowercase()).collect();
    let mut counts = ImportCounts {
        extra: values.keys().filter(|k| !source_keys.contains(*k)).count(),
        notice: NOTICE.into(),
        ..Default::default()
    };
    let mut entries = Vec::new();
    for row in rows {
        let Some(value) = values.get(&row.key.trim().to_lowercase()) else {
            counts.missing += 1;
            continue;
        };
        counts.matched += 1;
        if value.trim().is_empty() {
            counts.empty += 1;
            continue;
        }
        if *value == row.source {
            counts.source_equal += 1;
        }
        if !tokens::token_differences(&row.source, value).is_empty() {
            counts.token_invalid += 1;
            continue;
        }
        if !row.target.trim().is_empty() {
            counts.conflicts += 1;
            continue;
        }
        counts.importable += 1;
        entries.push((
            translations::entry_key(relative_dir, &row.key),
            translations::StoredString {
                target: (*value).into(),
                status: "translated".into(),
                source_hash: translations::source_hash(&row.source),
            },
        ));
    }
    Ok((counts, entries))
}
fn import_from_config_mode(
    config: &Path,
    archive_id: &str,
    archive_path: &str,
    mod_unique_id: &str,
    relative_dir: &str,
    save: bool,
    community_library: bool,
) -> Result<ImportCounts, String> {
    let archive = lock()
        .archives
        .get(archive_id)
        .filter(|a| a.created.elapsed() < TTL)
        .cloned()
        .ok_or("Archive expired. Select and download the file again.")?;
    let file = archive
        .files
        .iter()
        .find(|f| f.path == archive_path)
        .ok_or("Select an archive i18n file.")?;
    if file
        .manifest_unique_id
        .as_deref()
        .is_some_and(|uid| !uid.eq_ignore_ascii_case(mod_unique_id))
    {
        return Err(
            "Archive manifest UniqueID does not match the selected installed component.".into(),
        );
    }
    let saved = settings::load_checked(config)?;
    let lang = language::normalize_target_code(
        saved
            .target_lang
            .as_deref()
            .ok_or("Choose a target language.")?,
    )?;
    let filename = archive_path
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .to_lowercase();
    if !file.is_default
        && filename != format!("{lang}.json")
        && !(lang == "pt" && filename == "pt-br.json")
    {
        return Err(
            "Selected archive locale does not match the configured target language.".into(),
        );
    }
    let mods_path = saved
        .mods_path
        .map(std::path::PathBuf::from)
        .or_else(|| {
            saved
                .stardew_path
                .map(|p| crate::detection::mods_path_for(Path::new(&p)))
        })
        .ok_or("Choose a Mods folder.")?;
    if !mods_path.is_dir() {
        return Err("Configured Mods folder is unavailable.".into());
    }
    let scan = scanner::scan_mods(&mods_path, &lang, config);
    let component = scan
        .mods
        .iter()
        .find(|m| m.unique_id == mod_unique_id)
        .ok_or("Selected component is unavailable in a fresh scan.")?;
    let target = component
        .i18n_files
        .iter()
        .find(|f| f.relative_dir == relative_dir)
        .ok_or("Selected i18n component path is unavailable in a fresh scan.")?;
    let root = translations::language_root(config, &lang)?;
    let snapshot = translations::load_snapshot(&root, mod_unique_id)?;
    let rows = scanner::load_strings_checked(
        Path::new(&target.default_path),
        Path::new(&target.target_path),
        &snapshot.state,
        relative_dir,
    )?;
    let mut import_rows = rows.clone();
    if community_library {
        for row in &mut import_rows {
            if !snapshot
                .state
                .contains_key(&translations::entry_key(relative_dir, &row.key))
            {
                // Installed values are base content, not a personal draft.
                row.target.clear();
            }
        }
    }
    let (mut counts, entries) = analyze(
        &import_rows,
        archive
            .documents
            .get(archive_path)
            .ok_or("Archive JSON unavailable.")?,
        relative_dir,
    )?;
    // Bind the displayed preflight to this exact source and effective local state.
    // A newer scan or edit requires another preview, rather than silently changing
    // the scope the user just confirmed.
    let binding_key = serde_json::to_string(&(
        config,
        &mods_path,
        &lang,
        archive_id,
        archive_path,
        mod_unique_id,
        relative_dir,
        community_library,
    ))
    .map_err(|_| "Could not bind import context.")?;
    let binding = format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(
                &rows
                    .iter()
                    .map(|r| (&r.key, &r.source, &r.target))
                    .collect::<Vec<_>>()
            )
            .map_err(|_| "Could not bind import source.")?
        )
    );
    {
        let mut s = lock();
        s.preflights.retain(|_, (at, _)| at.elapsed() < TTL);
        if save {
            if s.preflights
                .get(&binding_key)
                .is_none_or(|(_, expected)| expected != &binding)
            {
                return Err(
                    "Source, local translations, or import scope changed. Run preflight again."
                        .into(),
                );
            }
        } else {
            if s.preflights.len() >= 128 {
                s.preflights.clear();
            }
            s.preflights.insert(binding_key, (Instant::now(), binding));
        }
    }
    if community_library {
        if file.is_default {
            return Err(
                "Community library requires a target-language JSON, not default.json.".into(),
            );
        }
        let document: serde_json::Map<String, Value> = serde_json::from_str(
            archive
                .documents
                .get(archive_path)
                .ok_or("Archive JSON unavailable")?,
        )
        .map_err(|e| e.to_string())?;
        let mut base = translations::ModState::new();
        // Capture underlying locale once, separately from personal saved work.
        // Existing library bases are immutable in this prototype; repeated import
        // cannot replace them with a subsequently deployed generated output.
        for row in scanner::load_strings_checked(
            Path::new(&target.default_path),
            Path::new(&target.target_path),
            &translations::ModState::new(),
            relative_dir,
        )? {
            if !row.target.trim().is_empty()
                && tokens::token_differences(&row.source, &row.target).is_empty()
            {
                base.insert(
                    translations::entry_key(relative_dir, &row.key),
                    translations::StoredString {
                        target: row.target,
                        status: "translated".into(),
                        source_hash: translations::source_hash(&row.source),
                    },
                );
            }
        }

        let mut matched_archive_values = 0;
        for row in &rows {
            if let Some(value) = document
                .get(&row.key)
                .and_then(Value::as_str)
                .filter(|v| !v.trim().is_empty())
            {
                if !tokens::token_differences(&row.source, value).is_empty() {
                    continue;
                }
                matched_archive_values += 1;
                base.insert(
                    translations::entry_key(relative_dir, &row.key),
                    translations::StoredString {
                        target: value.into(),
                        status: "translated".into(),
                        source_hash: translations::source_hash(&row.source),
                    },
                );
            }
        }
        if matched_archive_values == 0 {
            return Err("No valid target-language strings for this component.".into());
        }
        if crate::community_library::list(config)?.iter().any(|e| {
            e.mod_unique_id == mod_unique_id
                && e.relative_dir == relative_dir
                && e.archive_id != archive_id
        }) {
            return Err(
                "Community update requires base/personal review; existing base preserved.".into(),
            );
        }
        if save {
            crate::community_library::store(
                config,
                crate::community_library::CommunityLibraryEntry {
                    mod_unique_id: mod_unique_id.into(),
                    relative_dir: relative_dir.into(),
                    archive_path: archive_path.into(),
                    strings: base.len(),
                    source_url: archive.source_url.clone(),
                    archive_id: archive_id.into(),
                    base,
                },
            )?;
        }
    }
    if save && !entries.is_empty() {
        let entries = entries
            .into_iter()
            .map(|(key, entry)| translations::ConditionalSaveEntry {
                expected: snapshot.state.get(&key).cloned(),
                expected_revision: snapshot.entry_revision(&key),
                key,
                entry,
            })
            .collect();
        let result =
            translations::save_groups_if_unchanged(&root, vec![(mod_unique_id.into(), entries)])?;
        if result == translations::ConditionalSaveOutcome::Stale {
            return Err("Local translations changed during import. Run preflight again.".into());
        }
        counts.imported = counts.importable;
    }
    if save {
        // Counts only: no archive paths, translated text, API keys or signed
        // URLs enter diagnostics. Emit after the conditional transaction, never
        // for a preview or a failed/stale write.
        log::info!(target: "app", "event=nexus_import_complete imported={} preserved_local={} token_invalid={} empty={} missing={} extra={} destination=translation_state exported=0", counts.imported, counts.conflicts, counts.token_invalid, counts.empty, counts.missing, counts.extra);
    }
    Ok(counts)
}
#[tauri::command]
pub fn nexus_preflight_import(
    app: AppHandle,
    archive_id: String,
    archive_path: String,
    mod_unique_id: String,
    relative_dir: String,
    community_library: Option<bool>,
) -> Result<ImportCounts, String> {
    import_from_config_mode(
        &crate::config_dir(&app)?,
        &archive_id,
        &archive_path,
        &mod_unique_id,
        &relative_dir,
        false,
        community_library.unwrap_or(false),
    )
}
#[tauri::command]
pub fn nexus_import_translation(
    app: AppHandle,
    archive_id: String,
    archive_path: String,
    mod_unique_id: String,
    relative_dir: String,
    community_library: Option<bool>,
) -> Result<ImportCounts, String> {
    import_from_config_mode(
        &crate::config_dir(&app)?,
        &archive_id,
        &archive_path,
        &mod_unique_id,
        &relative_dir,
        true,
        community_library.unwrap_or(false),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    fn zip_bytes(entries: &[(&str, &str)]) -> Vec<u8> {
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, body) in entries {
            zip.start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(body.as_bytes()).unwrap();
        }
        zip.finish().unwrap().into_inner()
    }
    fn row(key: &str, source: &str, target: &str) -> scanner::StringRow {
        scanner::StringRow {
            key: key.into(),
            source: source.into(),
            target: target.into(),
            status: "untranslated".into(),
            target_present: !target.is_empty(),
            token_mismatch_accepted: false,
            section: None,
        }
    }
    #[test]
    fn cdn_rejects_untrusted_destinations_and_userinfo() {
        for url in [
            "http://premium.nexusmods.com/x",
            "https://premium.nexusmods.com.evil.test/x",
            "https://evil.test/x",
            "https://user@premium.nexusmods.com/x",
            "https://premium.nexusmods.com:8443/x",
            "https://a.b.nexus-cdn.com/x",
            "https://premium.nexusmods.com/x#secret",
        ] {
            assert!(cdn_url(url).is_err(), "{url}");
        }
        assert!(cdn_url("https://cf-files.nexusmods.com/x?token=opaque").is_ok());
        assert!(cdn_url("https://a-1.nexus-cdn.com/x").is_ok());
    }
    #[test]
    fn traversal_and_ambiguous_archive_paths_fail() {
        for name in [
            "../i18n/de.json",
            "C:/i18n/de.json",
            "/i18n/de.json",
            "x/../i18n/de.json",
        ] {
            assert!(inspect_zip(zip_bytes(&[(name, "{}")])).is_err());
        }
        assert!(inspect_zip(zip_bytes(&[("i18n/de.json", "{}"), ("I18N/DE.JSON", "{}")])).is_err());
    }
    #[test]
    fn manifests_bind_nearest_component_and_ignore_assets() {
        let archive = inspect_zip(zip_bytes(&[
            ("mod/manifest.json", r#"{"UniqueID":"root"}"#),
            ("mod/sub/manifest.json", r#"{"UniqueID":"child"}"#),
            ("mod/sub/i18n/de.json", "{}"),
            ("mod/assets/i18n/de.json", "{}"),
            ("mod/i18n/default.json", "{}"),
        ]))
        .unwrap();
        assert_eq!(archive.files.len(), 2);
        assert_eq!(
            archive
                .files
                .iter()
                .find(|f| f.path.contains("sub/"))
                .unwrap()
                .manifest_unique_id
                .as_deref(),
            Some("child")
        );
        assert!(archive.files.iter().any(|f| f.is_default));
    }
    #[test]
    fn rejects_non_zip_and_oversize_json() {
        assert!(inspect_zip(b"7z not zip".to_vec()).is_err());
        let huge = " ".repeat(ARCHIVE_JSON_LIMIT + 1);
        assert!(inspect_zip(zip_bytes(&[("i18n/de.json", &huge)])).is_err());
    }
    #[test]
    fn preflight_counts_and_preserves_local_text() {
        let rows = vec![
            row("new", "Hello", ""),
            row("local", "Keep", "Local"),
            row("empty", "Empty", ""),
            row("same", "Same", ""),
            row("missing", "Missing", ""),
        ];
        let (counts, entries) = analyze(
            &rows,
            r#"{" NEW ":"Hallo","local":"Overwrite","empty":" ","same":"Same","extra":"Extra"}"#,
            "i18n",
        )
        .unwrap();
        assert_eq!(
            (
                counts.matched,
                counts.missing,
                counts.extra,
                counts.empty,
                counts.source_equal,
                counts.conflicts,
                counts.importable
            ),
            (4, 1, 1, 1, 1, 1, 2)
        );
        assert_eq!(entries.len(), 2);
        assert!(entries.iter().all(|(_, v)| v.status == "translated"));
    }
    #[test]
    fn rejects_added_and_missing_tokens_but_keeps_other_valid_values() {
        let rows = vec![
            row("added", "Hello", ""),
            row("missing", "Hello {{name}}", ""),
            row("good", "Good {{name}}", ""),
        ];
        let (counts, entries) = analyze(
            &rows,
            r#"{"added":"Hallo {{extra}}","missing":"Hallo","good":"Gut {{name}}"}"#,
            "i18n",
        )
        .unwrap();
        assert_eq!(counts.token_invalid, 2);
        assert_eq!(entries.len(), 1);
    }
    #[test]
    fn flat_parser_and_folded_key_ambiguity_reject_invalid_json() {
        let rows = vec![row("key", "Hello", "")];
        for body in [
            r#"{"key":12}"#,
            r#"{"key":{},"other":"a"}"#,
            r#"{"Key":"a"," key ":"b"}"#,
        ] {
            assert!(analyze(&rows, body, "i18n").is_err());
        }
    }
    #[test]
    fn language_signals_do_not_treat_embedded_substrings_as_language() {
        assert!(language_match("Automate German Translation", "de"));
        assert!(!language_match("Germanium machine", "de"));
        assert!(!language_match("model de deluxe", "de"));
        assert_eq!(
            search_name("Generic Mod Config Menu (GMCM)"),
            "Generic Mod Config Menu"
        );
    }
    fn fixture(label: &str) -> (std::path::PathBuf, std::path::PathBuf, String) {
        let root = crate::test_support::temp_dir(label);
        let mods = root.join("Mods");
        std::fs::create_dir_all(mods.join("Example/i18n")).unwrap();
        std::fs::write(
            mods.join("Example/manifest.json"),
            r#"{"Name":"Example","UniqueID":"Example.Mod","Version":"1.0.0","Author":"Fixture"}"#,
        )
        .unwrap();
        std::fs::write(
            mods.join("Example/i18n/default.json"),
            r#"{"new":"Hello","local":"Keep"}"#,
        )
        .unwrap();
        std::fs::write(mods.join("Example/i18n/de.json"), r#"{"local":"Existing"}"#).unwrap();
        let config = root.join("data");
        settings::save(
            &config,
            &settings::AppSettings {
                mods_path: Some(mods.display().to_string()),
                target_lang: Some("de".into()),
                ..Default::default()
            },
        )
        .unwrap();
        let id = root.display().to_string();
        let archive = inspect_zip(zip_bytes(&[
            ("i18n/de.json", r#"{"new":"Hallo","local":"Overwrite"}"#),
            ("i18n/fr.json", r#"{"new":"Bonjour"}"#),
        ]))
        .unwrap();
        lock().archives.insert(id.clone(), archive);
        (config, mods, id)
    }
    #[test]
    fn community_two_component_output_preserves_base_personal_and_ignores_deployed_output() {
        let (config, mods, id) = fixture("community-output");
        std::fs::create_dir_all(mods.join("Second/i18n")).unwrap();
        std::fs::write(
            mods.join("Second/manifest.json"),
            r#"{"Name":"Second","UniqueID":"Second.Mod","Version":"1.0.0","Author":"Fixture"}"#,
        )
        .unwrap();
        std::fs::write(
            mods.join("Second/i18n/default.json"),
            r#"{"new":"Hello","local":"Keep"}"#,
        )
        .unwrap();
        for uid in ["Example.Mod", "Second.Mod"] {
            import_from_config_mode(&config, &id, "i18n/de.json", uid, "i18n", false, true)
                .unwrap();
            import_from_config_mode(&config, &id, "i18n/de.json", uid, "i18n", true, true).unwrap();
        }
        std::fs::create_dir_all(mods.join("Example/nested/i18n")).unwrap();
        std::fs::write(
            mods.join("Example/nested/i18n/default.json"),
            r#"{"new":"Hello","local":"Keep"}"#,
        )
        .unwrap();
        import_from_config_mode(
            &config,
            &id,
            "i18n/de.json",
            "Example.Mod",
            "nested/i18n",
            false,
            true,
        )
        .unwrap();
        import_from_config_mode(
            &config,
            &id,
            "i18n/de.json",
            "Example.Mod",
            "nested/i18n",
            true,
            true,
        )
        .unwrap();
        let working = translations::language_root(&config, "de").unwrap();
        translations::save_one(
            &working,
            "Example.Mod",
            translations::entry_key("i18n", "new"),
            translations::StoredString {
                target: "Personal".into(),
                status: "translated".into(),
                source_hash: translations::source_hash("Hello"),
            },
        )
        .unwrap();
        // Simulate our own previous output without letting it become the new base.
        std::fs::write(
            mods.join("Example/i18n/de.json"),
            r#"{"new":"Previous output","local":"Previous output"}"#,
        )
        .unwrap();
        let destination = config.join("Stardew Translator Output.zip");
        let built =
            crate::community_library::build(&config, destination.to_str().unwrap(), false).unwrap();
        assert_eq!(built.entries, 3);
        let mut zip = zip::ZipArchive::new(std::fs::File::open(&destination).unwrap()).unwrap();
        let mut body = String::new();
        zip.by_name("Example/i18n/de.json")
            .unwrap()
            .read_to_string(&mut body)
            .unwrap();
        let values: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(values["new"], "Personal");
        assert_eq!(values["local"], "Overwrite");
        assert!(zip.by_name("Example/manifest.json").is_err());
        assert!(zip.by_name("Example/nested/i18n/de.json").is_ok());
        let good_zip = std::fs::read(&destination).unwrap();
        translations::save_one(
            &working,
            "Example.Mod",
            translations::entry_key("i18n", "new"),
            translations::StoredString {
                target: "Broken {{token}}".into(),
                status: "translated".into(),
                source_hash: translations::source_hash("Hello"),
            },
        )
        .unwrap();
        assert!(
            crate::community_library::build(&config, destination.to_str().unwrap(), true).is_err()
        );
        assert_eq!(std::fs::read(&destination).unwrap(), good_zip);
        translations::save_one(
            &working,
            "Example.Mod",
            translations::entry_key("i18n", "new"),
            translations::StoredString {
                target: "Personal".into(),
                status: "translated".into(),
                source_hash: translations::source_hash("Hello"),
            },
        )
        .unwrap();
        let library = crate::community_library::list(&config).unwrap();
        assert_eq!(library.len(), 3);
        assert_eq!(
            library[0].base[&translations::entry_key("i18n", "new")].target,
            "Hallo"
        );
        assert!(
            crate::community_library::build(&config, destination.to_str().unwrap(), false)
                .unwrap_err()
                .contains("OVERWRITE_REQUIRED")
        );
        crate::community_library::build(&config, destination.to_str().unwrap(), true).unwrap();
        let other = config.join("OtherMods");
        std::fs::create_dir_all(&other).unwrap();
        let mut settings = settings::load_checked(&config).unwrap();
        settings.mods_path = Some(other.display().to_string());
        settings::save(&config, &settings).unwrap();
        assert!(crate::community_library::list(&config).is_err());
        assert!(
            crate::community_library::build(&config, destination.to_str().unwrap(), true).is_err()
        );
    }

    #[test]
    fn local_locale_json_reuses_guarded_import_and_preserves_local_provenance() {
        let (config, mods, _) = fixture("locale-json");
        let file = config.join("de.json");
        std::fs::write(&file, r#"{"new":"Hallo","local":"Replacement"}"#).unwrap();
        let (preview, archive) = inspect_locale_json(&file, "de").unwrap();
        lock().archives.insert(preview.archive_id.clone(), archive);
        let path = &preview.files[0].path;
        assert!(path.ends_with("/de.json"));
        assert!(preview.files[0].manifest_unique_id.is_none());
        assert!(import_from_config_mode(
            &config,
            &preview.archive_id,
            path,
            "Example.Mod",
            "i18n",
            true,
            true
        )
        .is_err());
        import_from_config_mode(
            &config,
            &preview.archive_id,
            path,
            "Example.Mod",
            "i18n",
            false,
            true,
        )
        .unwrap();
        import_from_config_mode(
            &config,
            &preview.archive_id,
            path,
            "Example.Mod",
            "i18n",
            true,
            true,
        )
        .unwrap();
        let library = crate::community_library::list(&config).unwrap();
        assert_eq!(library[0].archive_path, *path);
        assert!(library[0].source_url.is_none());
        assert_eq!(
            std::fs::read_to_string(mods.join("Example/i18n/de.json")).unwrap(),
            r#"{"local":"Existing"}"#
        );
        assert!(inspect_locale_json(&file, "fr").is_err());
        for body in [r#"{"key":12}"#, r#"{"Key":"a"," key ":"b"}"#, "[]"] {
            std::fs::write(&file, body).unwrap();
            assert!(inspect_locale_json(&file, "de").is_err());
        }
    }

    #[test]
    fn archive_mapping_resolves_sve_components_without_nexus_group_representative() {
        let (config, mods, _) = fixture("archive-components");
        for (folder, uid) in [
            ("Stardew Valley Expanded Code", "SVE.Code"),
            ("[CP] Stardew Valley Expanded", "SVE.CP"),
            ("Frontier Farm", "SVE.Frontier"),
        ] {
            let root = mods.join("Stardew Valley Expanded").join(folder);
            std::fs::create_dir_all(root.join("i18n")).unwrap();
            std::fs::write(root.join("manifest.json"), serde_json::json!({"Name":folder,"UniqueID":uid,"Version":"1.0.0","Author":"Fixture","UpdateKeys":["Nexus:3753"]}).to_string()).unwrap();
            std::fs::write(root.join("i18n/default.json"), r#"{"hello":"Hello"}"#).unwrap();
        }
        let scan = scanner::scan_mods(&mods, "de", &config);
        let archive = inspect_zip(zip_bytes(&[
            (
                "Stardew Valley Expanded/Stardew Valley Expanded Code/i18n/de.json",
                r#"{"hello":"Hallo"}"#,
            ),
            (
                "Stardew Valley Expanded/[CP] Stardew Valley Expanded/i18n/de.json",
                r#"{"hello":"Hallo"}"#,
            ),
            ("unrelated/i18n/de.json", r#"{"hello":"Hallo"}"#),
        ]))
        .unwrap();
        let resolved = resolve_archive_components("sve", &archive, &scan.mods, "de");
        assert_eq!(resolved.mappings.len(), 2);
        assert_eq!(resolved.unresolved.len(), 1);
        assert!(resolved
            .mappings
            .iter()
            .all(|m| m.mod_unique_id != "SVE.Frontier"));
        assert!(resolved
            .mappings
            .iter()
            .any(|m| m.mod_unique_id == "SVE.Code"));
        assert!(resolved
            .mappings
            .iter()
            .any(|m| m.mod_unique_id == "SVE.CP"));
        let multilingual = inspect_zip(zip_bytes(&[
            (
                "Stardew Valley Expanded/Stardew Valley Expanded Code/i18n/de.json",
                r#"{"hello":"Hallo"}"#,
            ),
            (
                "Stardew Valley Expanded/Stardew Valley Expanded Code/i18n/default.json",
                r#"{"hello":"Hello"}"#,
            ),
            (
                "Stardew Valley Expanded/Stardew Valley Expanded Code/i18n/fr.json",
                r#"{"hello":"Bonjour"}"#,
            ),
        ]))
        .unwrap();
        let mapped = resolve_archive_components("multilingual", &multilingual, &scan.mods, "de");
        assert_eq!(mapped.mappings.len(), 1);
        assert!(mapped.unresolved.is_empty());
        let default_only =
            inspect_zip(zip_bytes(&[("i18n/default.json", r#"{"hello":"Hallo"}"#)])).unwrap();
        assert_eq!(
            resolve_archive_components("default-only", &default_only, &scan.mods, "de")
                .unresolved
                .len(),
            1
        );
        let duplicate = inspect_zip(zip_bytes(&[
            (
                "first/Stardew Valley Expanded Code/i18n/de.json",
                r#"{"hello":"Hallo"}"#,
            ),
            (
                "second/Stardew Valley Expanded Code/i18n/de.json",
                r#"{"hello":"Hallo"}"#,
            ),
        ]))
        .unwrap();
        assert!(
            resolve_archive_components("dup", &duplicate, &scan.mods, "de")
                .mappings
                .is_empty()
        );
        let manifest = inspect_zip(zip_bytes(&[
            ("Wrapper/manifest.json", r#"{"UniqueID":"SVE.CP"}"#),
            ("Wrapper/i18n/de.json", r#"{"hello":"Hallo"}"#),
        ]))
        .unwrap();
        assert_eq!(
            resolve_archive_components("manifest", &manifest, &scan.mods, "de").mappings[0]
                .mod_unique_id,
            "SVE.CP"
        );
    }

    #[test]
    fn numbered_fishing_folder_alias_requires_substantial_unique_source_evidence() {
        let (config, mods, _) = fixture("fishing-alias");
        let keys: serde_json::Map<String, Value> = (0..12)
            .map(|n| {
                (
                    format!("config.fishing.option{n}"),
                    Value::String("Fixture".into()),
                )
            })
            .collect();
        let root = mods.join("FishingAssistant");
        std::fs::create_dir_all(root.join("i18n")).unwrap();
        std::fs::write(root.join("manifest.json"), r#"{"Name":"Fishing","UniqueID":"Fixture.Fishing","Version":"3.4.0","Author":"Fixture"}"#).unwrap();
        std::fs::write(
            root.join("i18n/default.json"),
            serde_json::to_vec(&keys).unwrap(),
        )
        .unwrap();
        let archive = inspect_zip(zip_bytes(&[(
            "FishingAssistant3/i18n/de.json",
            &serde_json::to_string(&keys).unwrap(),
        )]))
        .unwrap();
        let scan = scanner::scan_mods(&mods, "de", &config);
        assert_eq!(
            resolve_archive_components("alias", &archive, &scan.mods, "de").mappings[0]
                .mod_unique_id,
            "Fixture.Fishing"
        );
        let tiny = inspect_zip(zip_bytes(&[(
            "FishingAssistant3/i18n/de.json",
            r#"{"ok":"OK","cancel":"Cancel"}"#,
        )]))
        .unwrap();
        assert!(resolve_archive_components("tiny", &tiny, &scan.mods, "de")
            .mappings
            .is_empty());
        let second = mods.join("FishingAssistant2");
        std::fs::create_dir_all(second.join("i18n")).unwrap();
        std::fs::write(second.join("manifest.json"), r#"{"Name":"Other version","UniqueID":"Fixture.OtherFishing","Version":"2.0.0","Author":"Fixture"}"#).unwrap();
        std::fs::write(
            second.join("i18n/default.json"),
            serde_json::to_vec(&keys).unwrap(),
        )
        .unwrap();
        let scan = scanner::scan_mods(&mods, "de", &config);
        assert!(
            resolve_archive_components("conflict", &archive, &scan.mods, "de")
                .mappings
                .is_empty()
        );
    }

    #[test]
    fn native_import_requires_preflight_and_only_writes_done_state() {
        let (config, mods, id) = fixture("nexus-import");
        let source = std::fs::read(mods.join("Example/i18n/default.json")).unwrap();
        let target = std::fs::read(mods.join("Example/i18n/de.json")).unwrap();
        assert!(
            import_from_config(&config, &id, "i18n/de.json", "Example.Mod", "i18n", true).is_err()
        );
        let preview =
            import_from_config(&config, &id, "i18n/de.json", "Example.Mod", "i18n", false).unwrap();
        assert_eq!((preview.importable, preview.conflicts), (1, 1));
        let imported =
            import_from_config(&config, &id, "i18n/de.json", "Example.Mod", "i18n", true).unwrap();
        assert_eq!(imported.imported, 1);
        let state = translations::load(
            &translations::language_root(&config, "de").unwrap(),
            "Example.Mod",
        )
        .unwrap();
        let entry = &state[&translations::entry_key("i18n", "new")];
        assert_eq!(entry.status, "translated");
        assert_eq!(entry.source_hash, translations::source_hash("Hello"));
        assert_eq!(
            std::fs::read(mods.join("Example/i18n/default.json")).unwrap(),
            source
        );
        assert_eq!(
            std::fs::read(mods.join("Example/i18n/de.json")).unwrap(),
            target
        );
    }
    #[test]
    fn changed_source_or_local_text_invalidates_confirmation() {
        let (config, mods, id) = fixture("nexus-stale");
        import_from_config(&config, &id, "i18n/de.json", "Example.Mod", "i18n", false).unwrap();
        std::fs::write(
            mods.join("Example/i18n/default.json"),
            r#"{"new":"Changed","local":"Keep"}"#,
        )
        .unwrap();
        assert!(
            import_from_config(&config, &id, "i18n/de.json", "Example.Mod", "i18n", true)
                .unwrap_err()
                .contains("preflight")
        );
        import_from_config(&config, &id, "i18n/de.json", "Example.Mod", "i18n", false).unwrap();
        translations::save_one(
            &translations::language_root(&config, "de").unwrap(),
            "Example.Mod",
            translations::entry_key("i18n", "new"),
            translations::StoredString {
                target: "New local edit".into(),
                status: "translated".into(),
                source_hash: translations::source_hash("Changed"),
            },
        )
        .unwrap();
        assert!(
            import_from_config(&config, &id, "i18n/de.json", "Example.Mod", "i18n", true).is_err()
        );
    }
    #[test]
    fn mapping_rejects_wrong_locale_path_and_manifest_id() {
        let (config, _mods, id) = fixture("nexus-map");
        assert!(
            import_from_config(&config, &id, "i18n/fr.json", "Example.Mod", "i18n", false).is_err()
        );
        assert!(import_from_config(
            &config,
            &id,
            "i18n/de.json",
            "Example.Mod",
            "../../i18n",
            false
        )
        .is_err());
        lock().archives.get_mut(&id).unwrap().files[0].manifest_unique_id =
            Some("Other.Mod".into());
        assert!(
            import_from_config(&config, &id, "i18n/de.json", "Example.Mod", "i18n", false).is_err()
        );
    }
    #[tokio::test]
    #[ignore = "Explicit opt-in live Nexus API/Premium ZIP smoke; never writes game files"]
    async fn live_native_nexus_smoke() {
        let mod_id = std::env::var("NEXUS_NATIVE_LIVE_MOD_ID")
            .expect("Set NEXUS_NATIVE_LIVE_MOD_ID explicitly")
            .parse()
            .unwrap();
        let status = nexus_status(Some(true)).await.unwrap();
        assert!(status.configured && status.premium);
        let config = crate::test_support::temp_dir("nexus-live-cache");
        let result = find_translations(&config, mod_id, "de", true)
            .await
            .unwrap();
        assert!(!result.original_name.is_empty());
        let files = nexus_list_files(mod_id).await.unwrap();
        let file = files
            .iter()
            .find(|f| f.file_id == 145906)
            .expect("Explicitly selected GMCM ZIP file");
        let archive = nexus_download_preflight(mod_id, file.file_id)
            .await
            .unwrap();
        assert!(!archive.files.is_empty());
        println!("Native Nexus smoke: source {}, candidates {}, selected original file {}, i18n JSON files {}",mod_id,result.candidates.len(),file.file_id,archive.files.len());
        // Explicitly requested real large-dictionary regression, selected official file.
        let vietnamese = find_translations(&config, 7286, "vi", true).await.unwrap();
        assert!(
            vietnamese.candidates.iter().any(|c| c.mod_id == 30342),
            "Known Vietnamese translation should be discoverable"
        );
        let large = nexus_download_preflight(30342, 170961).await.unwrap();
        let stored = lock().archives.get(&large.archive_id).unwrap().clone();
        let vi = large
            .files
            .iter()
            .find(|f| {
                f.path.to_lowercase().ends_with("/i18n/vi.json")
                    && stored.documents[&f.path].len() > 2_000_000
            })
            .expect("Large Vietnamese i18n dictionary");
        let parsed = scanner::parse_flat_object(
            &stored.documents[&vi.path],
            Path::new("live archive vi JSON"),
        )
        .unwrap();
        println!(
            "Native large ZIP smoke: mod 30342, file 170961, JSON bytes {}, keys {}",
            stored.documents[&vi.path].len(),
            parsed.len()
        );
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}
#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct DiscoveryCache {
    schema: u32,
    game: String,
    entries: HashMap<String, Discovery>,
}
fn cache_guard() -> &'static Mutex<()> {
    static GUARD: OnceLock<Mutex<()>> = OnceLock::new();
    GUARD.get_or_init(|| Mutex::new(()))
}
fn cache_key(mod_id: u64, lang: &str) -> String {
    format!("{mod_id}:{lang}")
}
fn read_discovery_cache(config: &Path) -> DiscoveryCache {
    let read = || -> Option<DiscoveryCache> {
        let file = std::fs::File::open(config.join("nexus-discovery-cache.json")).ok()?;
        if file.metadata().ok()?.len() > CACHE_LIMIT as u64 {
            return None;
        }
        let mut bytes = Vec::new();
        file.take(CACHE_LIMIT as u64 + 1)
            .read_to_end(&mut bytes)
            .ok()?;
        if bytes.len() > CACHE_LIMIT {
            return None;
        }
        let cache: DiscoveryCache = serde_json::from_slice(&bytes).ok()?;
        (cache.schema == 1 && cache.game == "stardewvalley" && cache.entries.len() <= 512)
            .then_some(cache)
    };
    read().unwrap_or_default()
}
fn cached_discovery(
    config: &Path,
    mod_id: u64,
    lang: &str,
    now: u64,
    force_refresh: bool,
) -> Option<Discovery> {
    if force_refresh {
        return None;
    }
    let _guard = cache_guard().lock().unwrap_or_else(|p| p.into_inner());
    let mut result = read_discovery_cache(config)
        .entries
        .remove(&cache_key(mod_id, lang))?;
    if result.mod_id != mod_id
        || result.fetched_at > now
        || result.expires_at <= now
        || result.expires_at != result.fetched_at.checked_add(SEARCH_TTL_MS)?
        || result.candidates.len() > 30
        || result
            .candidates
            .iter()
            .any(|c| positive(c.mod_id).is_err())
    {
        return None;
    }
    classify_candidates(&result.original_name, lang, &mut result.candidates);
    result.cache_status = "cached".into();
    Some(result)
}
fn metadata_text(value: &str) -> String {
    value
        .split_whitespace()
        .filter(|part| !part.contains("://") && !part.contains('?') && !part.contains('='))
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(2000)
        .collect()
}
fn store_discovery(config: &Path, lang: &str, result: &Discovery) -> Result<(), String> {
    let _guard = cache_guard().lock().unwrap_or_else(|p| p.into_inner());
    let mut cache = read_discovery_cache(config);
    cache.schema = 1;
    cache.game = "stardewvalley".into();
    cache
        .entries
        .retain(|_, entry| entry.expires_at > result.fetched_at);
    if cache.entries.len() >= 512 {
        cache.entries.clear();
    }
    let mut safe = result.clone();
    safe.original_name = metadata_text(&safe.original_name);
    safe.notice = NOTICE.into();
    for candidate in &mut safe.candidates {
        // The cache deliberately omits free-form descriptions and URLs.
        candidate.summary.clear();
        candidate.name = metadata_text(&candidate.name);
        candidate.version = metadata_text(&candidate.version);
        candidate.updated_at = metadata_text(&candidate.updated_at);
    }
    cache.entries.insert(cache_key(result.mod_id, lang), safe);
    let bytes = serde_json::to_vec(&cache).map_err(|_| "Could not encode Nexus cache.")?;
    if bytes.len() > CACHE_LIMIT {
        return Err("Nexus metadata cache exceeds size limit.".into());
    }
    std::fs::create_dir_all(config).map_err(|_| "Could not create Nexus cache directory.")?;
    let temporary = config.join("nexus-discovery-cache.json.tmp");
    std::fs::write(&temporary, bytes).map_err(|_| "Could not write Nexus cache.")?;
    std::fs::rename(&temporary, config.join("nexus-discovery-cache.json"))
        .map_err(|_| "Could not replace Nexus cache.".to_string())
}

fn vortex_path(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute()
        || !path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case("Vortex.exe"))
        || !path.is_file()
    {
        return Err("Choose an existing absolute path to Vortex.exe in Nexus setup.".into());
    }
    let canonical = path
        .canonicalize()
        .map_err(|_| "Configured Vortex executable is unavailable.")?;
    if !canonical
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("Vortex.exe"))
    {
        return Err("Configured path does not resolve to Vortex.exe.".into());
    }
    let mut signature = [0; 2];
    std::fs::File::open(&canonical)
        .and_then(|mut f| f.read_exact(&mut signature))
        .map_err(|_| "Configured Vortex executable is unreadable.")?;
    if signature != *b"MZ" {
        return Err("Configured Vortex file is not a Windows executable.".into());
    }
    Ok(canonical)
}
// Registry values are hints only. Never execute a registered command or expand its arguments.
#[cfg(windows)]
fn registered_executable(value: &str, command: bool) -> Option<PathBuf> {
    let value = value.trim();
    let path = if let Some(quoted) = value.strip_prefix('"') {
        let (path, rest) = quoted.split_once('"')?;
        if (!command && !rest.trim().is_empty())
            || (command && !rest.is_empty() && !rest.starts_with(char::is_whitespace))
        {
            return None;
        }
        path
    } else if command {
        value.split_whitespace().next()?
    } else {
        value
    };
    (!path.is_empty() && !path.contains('"')).then(|| PathBuf::from(path))
}

#[cfg(windows)]
fn registered_icon(value: &str) -> Option<PathBuf> {
    let value = value.trim();
    let path = match value.rsplit_once(',') {
        Some((path, index)) if index.trim().parse::<i32>().is_ok() => path,
        _ => value,
    };
    registered_executable(path, false)
}

#[cfg(windows)]
fn local_vortex_candidate(path: &Path) -> bool {
    use std::path::{Component, Prefix};
    path.has_root()
        && matches!(
            path.components().next(),
            Some(Component::Prefix(prefix))
                if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_))
        )
}

#[cfg(windows)]
fn detected_vortex_path(registered: Vec<PathBuf>, standard: Vec<PathBuf>) -> Option<String> {
    for candidates in [registered, standard] {
        let mut found: Option<PathBuf> = None;
        for candidate in candidates {
            // Silent detection must not access a network or device path from registry hints.
            if !local_vortex_candidate(&candidate) {
                continue;
            }
            let Ok(path) = vortex_path(&candidate) else {
                continue;
            };
            if let Some(previous) = &found {
                if !previous
                    .to_string_lossy()
                    .eq_ignore_ascii_case(&path.to_string_lossy())
                {
                    // Conflicting valid installations require the user's Browse choice.
                    return None;
                }
            } else {
                found = Some(path);
            }
        }
        if let Some(path) = found {
            return Some(path.display().to_string());
        }
    }
    None
}

#[tauri::command]
pub fn detect_vortex_executable() -> Option<String> {
    #[cfg(windows)]
    {
        use winreg::{enums::*, RegKey};
        let mut candidates = Vec::new();
        for hive in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
            for view in [KEY_WOW64_64KEY, KEY_WOW64_32KEY] {
                let root = RegKey::predef(hive);
                let read = |key: &str, name: &str| -> Option<String> {
                    root.open_subkey_with_flags(key, KEY_READ | view)
                        .ok()?
                        .get_value(name)
                        .ok()
                };
                if let Some(value) = read(
                    r"Software\Microsoft\Windows\CurrentVersion\App Paths\Vortex.exe",
                    "",
                ) {
                    candidates.extend(registered_executable(&value, false));
                }
                // Observed Vortex installer app ID; optional hint, without enumerating software.
                let uninstall = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\57979c68-f490-55b8-8fed-8b017a5af2fe";
                if read(uninstall, "DisplayName").as_deref() == Some("Vortex") {
                    if let Some(value) = read(uninstall, "InstallLocation") {
                        candidates.extend(
                            registered_executable(&value, false).map(|p| p.join("Vortex.exe")),
                        );
                    }
                    if let Some(value) = read(uninstall, "DisplayIcon") {
                        candidates.extend(registered_icon(&value));
                    }
                }
                if let Some(value) = read(r"Software\Classes\nxm\shell\open\command", "") {
                    candidates.extend(registered_executable(&value, true));
                }
            }
        }
        let mut standard = Vec::new();
        for variable in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(root) = std::env::var_os(variable) {
                standard.push(PathBuf::from(root).join("Vortex").join("Vortex.exe"));
            }
        }
        if let Some(root) = std::env::var_os("LOCALAPPDATA") {
            standard.push(PathBuf::from(root).join("Programs/Vortex/Vortex.exe"));
        }
        detected_vortex_path(candidates, standard)
    }
    #[cfg(not(windows))]
    None
}

#[tauri::command]
pub fn pick_vortex_executable(app: AppHandle) -> Result<Option<String>, String> {
    let Some(file) = app
        .dialog()
        .file()
        .set_title("Choose the installed Vortex.exe")
        .add_filter("Vortex executable", &["exe"])
        .blocking_pick_file()
    else {
        return Ok(None);
    };
    let path = file
        .into_path()
        .map_err(|_| "Could not read the selected executable path.")?;
    vortex_path(&path).map(|path| Some(path.display().to_string()))
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VortexHandoff {
    mod_id: u64,
    file_id: u64,
    status: &'static str,
}
fn handoff_arguments(mod_id: u64, file_id: u64) -> Result<[String; 2], String> {
    positive(mod_id)?;
    positive(file_id)?;
    Ok([
        // Let Vortex's download automation handle installation. --install adds
        // a second install callback that can race with that automation.
        "--download".into(),
        format!("nxm://stardewvalley/mods/{mod_id}/files/{file_id}"),
    ])
}
fn request_vortex_handoff(
    config: &Path,
    mod_id: u64,
    file_id: u64,
    launch: impl FnOnce(&Path, &[String; 2]) -> Result<(), String>,
) -> Result<VortexHandoff, String> {
    let args = handoff_arguments(mod_id, file_id)?;
    let saved = settings::load_checked(config)?;
    if saved.installation_method != Some(settings::InstallationMethod::Vortex) {
        return Err("Choose the Vortex workflow in Settings before requesting a download.".into());
    }
    let configured = saved
        .vortex_executable
        .ok_or("Configure Vortex.exe in Settings before requesting a download.")?;
    let executable = vortex_path(Path::new(&configured))?;
    launch(&executable, &args)?;
    log::info!(target: "app", "event=nexus_vortex_handoff_requested mod_id={} file_id={} action=download_requested download_confirmed=false install_confirmed=false deployment_confirmed=false", mod_id, file_id);
    Ok(VortexHandoff {
        mod_id,
        file_id,
        status: "handoff-requested",
    })
}
fn vortex_command(executable: &Path, args: &[String; 2]) -> Command {
    let mut command = Command::new(executable);
    command
        .args(args)
        .env_remove("NEXUS_API_KEY")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
}
#[tauri::command]
pub fn nexus_handoff_to_vortex(
    app: AppHandle,
    mod_id: u64,
    file_id: u64,
) -> Result<VortexHandoff, String> {
    request_vortex_handoff(
        &crate::config_dir(&app)?,
        mod_id,
        file_id,
        |executable, args| {
            let mut child = vortex_command(executable, args).spawn().map_err(|_| {
                "Could not launch configured Vortex. Download and installation are not confirmed."
            })?;
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            Ok(())
        },
    )
}

#[cfg(test)]
mod workflow_tests {
    use super::*;
    #[cfg(windows)]
    #[test]
    fn vortex_detection_rejects_non_disk_paths_before_file_access() {
        for path in [r"C:\Vortex\Vortex.exe", r"\\?\C:\Vortex\Vortex.exe"] {
            assert!(local_vortex_candidate(Path::new(path)), "{path}");
        }
        for path in [
            r"\\server\share\Vortex.exe",
            r"\\?\UNC\server\share\Vortex.exe",
            r"\\.\C:\Vortex\Vortex.exe",
            r"\\.\pipe\Vortex.exe",
            r"\\?\Volume{example}\Vortex.exe",
            r"\??\C:\Vortex\Vortex.exe",
            r"\Vortex\Vortex.exe",
            r"C:Vortex.exe",
            r"Vortex.exe",
            "",
        ] {
            assert!(!local_vortex_candidate(Path::new(path)), "{path}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn vortex_detection_parses_only_executable_hints() {
        let expected = Some(PathBuf::from(r"C:\Example Vortex\Vortex.exe"));
        assert_eq!(
            registered_executable(r#""C:\Example Vortex\Vortex.exe" -d "%1""#, true),
            expected
        );
        assert_eq!(
            registered_executable(r"C:\Vortex\Vortex.exe --install %1", true),
            Some(PathBuf::from(r"C:\Vortex\Vortex.exe"))
        );
        assert_eq!(
            registered_executable(r#""C:\Example Vortex\Vortex.exe""#, false),
            expected
        );
        assert_eq!(
            registered_icon(r#""C:\Example Vortex\Vortex.exe",-1"#),
            expected
        );
        assert_eq!(registered_icon(r"C:\Example Vortex\Vortex.exe,0"), expected);
        assert_eq!(registered_icon(r"C:\Example Vortex\Vortex.exe"), expected);
        for malformed in ["", "\"unterminated", "\"Vortex.exe\"suffix", "\"\""] {
            assert!(registered_executable(malformed, true).is_none());
        }
        assert!(registered_executable(r#""C:\Vortex\Vortex.exe" --install"#, false).is_none());
        // No guessing where an unquoted path containing spaces ends.
        assert_eq!(
            registered_executable(r"C:\Example Vortex\Vortex.exe -d %1", true),
            Some(PathBuf::from(r"C:\Example"))
        );
    }

    #[cfg(windows)]
    #[test]
    fn vortex_detection_validates_falls_back_and_rejects_ambiguity() {
        let root = crate::test_support::temp_dir("vortex-detection");
        let first = root.join("first/Vortex.exe");
        let second = root.join("second/Vortex.exe");
        let invalid = root.join("invalid/Vortex.exe");
        let wrong_name = root.join("Other.exe");
        for path in [&first, &second, &invalid] {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, b"MZ synthetic fixture").unwrap();
        }
        std::fs::write(&invalid, b"not executable").unwrap();
        std::fs::write(&wrong_name, b"MZ wrong name").unwrap();
        let expected = Some(first.canonicalize().unwrap().display().to_string());
        let stale = vec![
            invalid,
            wrong_name,
            root.join("missing/Vortex.exe"),
            PathBuf::from("Vortex.exe"),
            root.clone(),
        ];
        assert!(detected_vortex_path(stale.clone(), vec![]).is_none());
        assert_eq!(
            detected_vortex_path(stale.clone(), vec![first.clone()]),
            expected
        );
        let mut hints = stale;
        hints.extend([first.clone(), first.parent().unwrap().join("./Vortex.exe")]);
        assert_eq!(detected_vortex_path(hints, vec![second.clone()]), expected);
        assert!(
            detected_vortex_path(vec![first.clone(), second.clone()], vec![first.clone()])
                .is_none()
        );
        assert!(detected_vortex_path(vec![], vec![first, second]).is_none());
        assert!(detected_vortex_path(vec![], vec![]).is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    fn discovery(now: u64) -> Discovery {
        Discovery {
            mod_id: 10,
            original_name: "Example".into(),
            candidates: vec![Candidate {
                mod_id: 20,
                name: "Example German".into(),
                summary: "Description with https://example.invalid/?signed=secret".into(),
                version: "1.0".into(),
                updated_at: "2026-09-05".into(),
                relationship_tier: "possible-original-translation".into(),
            }],
            limited: false,
            notice: NOTICE.into(),
            fetched_at: now,
            expires_at: now + SEARCH_TTL_MS,
            cache_status: "fresh".into(),
        }
    }
    #[test]
    fn candidate_titles_require_only_translation_qualifiers_around_the_full_original() {
        for (original, title, lang) in [
            (
                "Stardew Valley Expanded",
                "Stardew Valley Expanded - Chinese",
                "zh",
            ),
            (
                "Ridgeside Village",
                "Ridgeside Village - Chinese Simplified",
                "zh",
            ),
            ("Ridgeside Village", "[Chinese] Ridgeside Village", "zh"),
            ("Ridgeside Village", "Ridgeside Village (zh)", "zh"),
            ("Fishing Assistant 3", "Fishing Assistant 3 - Deutsch", "de"),
            ("Example", "Example - German Translation", "de"),
            ("Example (Alias)", "Example - German", "de"),
        ] {
            assert_eq!(
                relationship_tier(original, title, lang),
                "possible-original-translation",
                "{title}"
            );
        }
        for title in [
            "Stardew Valley Expanded Forage Crops and Bushes Chinese",
            "Stardew Valley Expanded-image translation-Chinese fix",
            "Stardew Valley Expanded (NPC Adventures) Chinese",
            "Chinese Stardew Valley Expanded Companion",
            "Stardew Valley Expanded",
            "Stardew Valley Expanded - German",
        ] {
            assert_eq!(
                relationship_tier("Stardew Valley Expanded", title, "zh"),
                "possible-addon-or-other-translation",
                "{title}"
            );
        }
        for title in [
            "Ridgeside Village for Mobile Phone-Chinese translation",
            "Ridgeside Village NPC Adventures Chinese",
            "Ridgeside Village-image translation-Chinese",
            "Reimagined Interior for Ridgeside Village - Chinese translation",
            "Ridgeside Villager Chinese",
        ] {
            assert_eq!(
                relationship_tier("Ridgeside Village", title, "zh"),
                "possible-addon-or-other-translation",
                "{title}"
            );
        }
    }

    #[test]
    fn candidate_titles_preserve_full_identity_when_subtitles_are_reworded() {
        let leilani = "Leilani (NPC for Ridgeside Village) new Chinese";
        let rodney = "Chinese translation-Creative Differences - Rodney a new NPC for East Scarp";
        for (original, title) in [
            ("Leilani (NPC for Ridgeside Village)", leilani),
            ("Creative Differences - NPC Rodney (East Scarp)", rodney),
            ("Quest Helper", "Quest Helper-ChineseTranslation"),
        ] {
            assert_eq!(
                relationship_tier(original, title, "zh"),
                "possible-original-translation"
            );
            assert_eq!(
                relationship_tier(original, title, "de"),
                "possible-addon-or-other-translation"
            );
        }
        for (original, title) in [
            ("Ridgeside Village", leilani),
            ("East Scarp", rodney),
            ("Ridgeside Village", "Ridgeside Village Fish Chinese"),
            ("Leilani (NPC for Ridgeside Village)", "Leilani new Chinese"),
            ("Leilani (NPC for Ridgeside Village)", "Leilani (NPC for Ridgeside Village) Interior Chinese"),
            ("Creative Differences - NPC Rodney (East Scarp)", "Chinese translation-Creative Differences - Rodney a new NPC for Ridgeside Village"),
            ("Creative Differences - NPC Rodney (East Scarp)", "Chinese translation-Creative Differences - Rodney a new NPC for East Scarp Adventures"),
            ("Example Example", "Example Chinese"),
            ("Quest Helper", "Quest Helper-ChineseTranslationAddon"),
        ] {
            assert_eq!(
                relationship_tier(original, title, "zh"),
                "possible-addon-or-other-translation",
                "{original}: {title}"
            );
        }
    }

    #[test]
    fn cached_candidates_are_reclassified_and_ranked_without_rewriting_cache() {
        let root = crate::test_support::temp_dir("nexus-candidate-cache");
        let mut value = discovery(1000);
        value.original_name = "Ridgeside Village".into();
        value.candidates[0].name = "Ridgeside Village for Mobile Phone-Chinese translation".into();
        let mut direct = value.candidates[0].clone();
        direct.mod_id = 21;
        direct.name = "Ridgeside Village - Chinese".into();
        direct.updated_at = "2020-01-01".into();
        direct.relationship_tier = "possible-addon-or-other-translation".into();
        value.candidates.push(direct);
        store_discovery(&root, "zh", &value).unwrap();
        let path = root.join("nexus-discovery-cache.json");
        let before = std::fs::read(&path).unwrap();
        let result = cached_discovery(&root, 10, "zh", 1001, false).unwrap();
        assert_eq!(result.candidates.len(), 2);
        assert_eq!(result.candidates[0].mod_id, 21);
        assert_eq!(
            result.candidates[0].relationship_tier,
            "possible-original-translation"
        );
        assert_eq!(result.candidates[1].mod_id, 20);
        assert_eq!(
            result.candidates[1].relationship_tier,
            "possible-addon-or-other-translation"
        );
        assert_eq!(result.fetched_at, value.fetched_at);
        assert_eq!(result.expires_at, value.expires_at);
        assert_eq!(result.cache_status, "cached");
        assert_eq!(std::fs::read(path).unwrap(), before);
    }
    #[test]
    fn metadata_cache_survives_restart_and_is_scoped_and_expiring() {
        let root = crate::test_support::temp_dir("nexus-persistent-cache");
        store_discovery(&root, "de", &discovery(1000)).unwrap();
        let result = cached_discovery(&root, 10, "de", 1001, false).unwrap();
        assert_eq!(result.cache_status, "cached");
        assert_eq!(result.fetched_at, 1000);
        assert!(cached_discovery(&root, 10, "fr", 1001, false).is_none());
        assert!(cached_discovery(&root, 11, "de", 1001, false).is_none());
        assert!(cached_discovery(&root, 10, "de", 999, false).is_none());
        assert!(cached_discovery(&root, 10, "de", 1000 + SEARCH_TTL_MS, false).is_none());
        assert!(cached_discovery(&root, 10, "de", 1001, true).is_none());
        let bytes = std::fs::read_to_string(root.join("nexus-discovery-cache.json")).unwrap();
        assert!(!bytes.contains("https://"));
        assert!(!bytes.contains("secret"));
        assert!(!bytes.contains("NEXUS_API_KEY"));
        store_discovery(&root, "fr", &discovery(1002)).unwrap();
        assert!(cached_discovery(&root, 10, "de", 1003, false).is_some());
        assert!(cached_discovery(&root, 10, "fr", 1003, false).is_some());
    }
    #[test]
    fn metadata_cache_rejects_corruption_wrong_schema_game_and_oversize() {
        let root = crate::test_support::temp_dir("nexus-cache-corrupt");
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("nexus-discovery-cache.json");
        for body in [
            "invalid".to_owned(),
            r#"{"schema":2,"game":"stardewvalley","entries":{}}"#.into(),
            r#"{"schema":1,"game":"skyrim","entries":{}}"#.into(),
            " ".repeat(CACHE_LIMIT + 1),
        ] {
            std::fs::write(&path, body).unwrap();
            assert!(cached_discovery(&root, 10, "de", 1001, false).is_none());
        }
        store_discovery(&root, "de", &discovery(1000)).unwrap();
        assert!(cached_discovery(&root, 10, "de", 1001, false).is_some());
    }
    fn configured_vortex() -> (PathBuf, PathBuf) {
        let root = crate::test_support::temp_dir("vortex-handoff");
        std::fs::create_dir_all(&root).unwrap();
        let executable = root.join("Vortex.exe");
        // Never executable-launched: synthetic header only, used with a stub launcher.
        std::fs::write(&executable, b"MZ synthetic test fixture").unwrap();
        settings::save(
            &root,
            &settings::AppSettings {
                installation_method: Some(settings::InstallationMethod::Vortex),
                vortex_executable: Some(executable.display().to_string()),
                ..Default::default()
            },
        )
        .unwrap();
        (root, executable)
    }
    #[test]
    fn vortex_handoff_builds_only_fixed_nxm_arguments_and_removes_key_environment() {
        assert!(handoff_arguments(0, 1).is_err());
        assert!(handoff_arguments(1, 0).is_err());
        assert!(handoff_arguments(u64::MAX, 1).is_err());
        let (root, executable) = configured_vortex();
        let receipt = request_vortex_handoff(&root, 10, 20, |path, args| {
            assert_eq!(path, executable.canonicalize().unwrap());
            assert_eq!(
                args,
                &["--download", "nxm://stardewvalley/mods/10/files/20"]
            );
            let command = vortex_command(path, args);
            assert_eq!(
                command.get_args().collect::<Vec<_>>(),
                args.iter().map(std::ffi::OsStr::new).collect::<Vec<_>>()
            );
            assert!(command
                .get_envs()
                .any(|(key, value)| key == "NEXUS_API_KEY" && value.is_none()));
            Ok(())
        })
        .unwrap();
        let json = serde_json::to_value(receipt).unwrap();
        assert_eq!(
            json,
            json!({"modId":10,"fileId":20,"status":"handoff-requested"})
        );
    }
    #[test]
    fn vortex_handoff_never_reports_success_after_launcher_failure_or_invalid_configuration() {
        let (root, executable) = configured_vortex();
        assert!(request_vortex_handoff(&root, 10, 20, |_, _| Err(
            "Synthetic launch failure".into()
        ))
        .is_err());
        std::fs::remove_file(executable).unwrap();
        assert!(request_vortex_handoff(&root, 10, 20, |_, _| panic!(
            "Unavailable executable must not launch"
        ))
        .is_err());
        assert!(vortex_path(Path::new("Vortex.exe")).is_err());
        let invalid = root.join("Vortex.exe");
        std::fs::write(&invalid, "not an executable").unwrap();
        assert!(vortex_path(&invalid).is_err());
        let wrong = root.join("other.exe");
        std::fs::write(&wrong, b"MZ").unwrap();
        assert!(vortex_path(&wrong).is_err());
    }
    #[test]
    fn vortex_handoff_rejects_folder_workflow_with_retained_executable() {
        let (root, _) = configured_vortex();
        let mut saved = settings::load_checked(&root).unwrap();
        saved.installation_method = Some(settings::InstallationMethod::Folder);
        settings::save(&root, &saved).unwrap();
        let error = request_vortex_handoff(&root, 10, 20, |_, _| {
            panic!("Folder workflow must not launch retained Vortex executable")
        })
        .unwrap_err();
        assert_eq!(
            error,
            "Choose the Vortex workflow in Settings before requesting a download."
        );
        assert_eq!(
            settings::load_checked(&root).unwrap().vortex_executable,
            saved.vortex_executable
        );
    }
    #[test]
    fn vortex_handoff_preserves_legacy_configured_workflow() {
        let (root, executable) = configured_vortex();
        std::fs::write(
            settings::settings_path(&root),
            serde_json::to_vec(&json!({
                "vortexExecutable": executable.display().to_string()
            }))
            .unwrap(),
        )
        .unwrap();
        let receipt = request_vortex_handoff(&root, 10, 20, |_, args| {
            assert_eq!(args[0], "--download");
            Ok(())
        })
        .unwrap();
        assert_eq!(receipt.status, "handoff-requested");
    }
    #[test]
    fn language_aliases_are_bounded_and_de_is_not_a_prose_signal() {
        for (title, code) in [
            ("Example GER", "de"),
            ("Example [DE]", "de"),
            ("Example JP", "ja"),
            ("Example CHS", "zh"),
            ("Example CHT", "zh"),
        ] {
            assert!(language_match(title, code));
        }
        assert!(!language_match("Example de configuration", "de"));
        assert!(!language_match("GERMANIUM", "de"));
    }
}

#[cfg(test)]
mod status_tests {
    use super::*;
    use reqwest::header::{HeaderMap, HeaderValue};
    fn headers(values: &[(&'static str, &'static str)]) -> HeaderMap {
        let mut result = HeaderMap::new();
        for (name, value) in values {
            result.insert(*name, HeaderValue::from_static(value));
        }
        result
    }
    #[test]
    fn observed_scoped_quota_distinguishes_unknown_zero_and_hourly_fallback() {
        let mut s = Session::default();
        s.activate(Some("synthetic-one"));
        s.observe(
            "synthetic-one",
            "rest-v1",
            &headers(&[
                ("x-rl-daily-limit", "20000"),
                ("x-rl-daily-remaining", "0"),
                ("x-rl-hourly-remaining", "499"),
                ("x-rl-daily-reset", "2026-09-07T00:00:00Z"),
            ]),
            200,
            1000,
        );
        let quota = &s.status().quota[0];
        assert_eq!(quota.daily_remaining, Some(0));
        assert_eq!(quota.hourly_remaining, Some(499));
        assert_eq!(quota.hourly_limit, None);
        assert_eq!(quota.hourly_reset, None);
        assert_eq!(quota.observed_at, 1000);
        assert!(s.check_request("synthetic-one", "rest-v1", 1001).is_ok());
        s.observe("synthetic-one", "graphql-v2", &HeaderMap::new(), 200, 1002);
        assert_eq!(s.status().quota.len(), 2);
        assert_eq!(s.status().quota[1].daily_remaining, None);
        assert_eq!(s.status().quota[0].daily_remaining, Some(0));
        assert!(!s.status().validated);
        assert_eq!(s.status().account_status, "unknown");
    }
    #[test]
    fn rate_limit_keeps_headers_and_blocks_queued_requests_until_backoff() {
        let mut s = Session::default();
        s.activate(Some("synthetic"));
        s.observe(
            "synthetic",
            "rest-v1",
            &headers(&[
                ("retry-after", "120"),
                ("x-rl-daily-remaining", "0"),
                ("x-rl-hourly-remaining", "0"),
            ]),
            429,
            1000,
        );
        assert_eq!(s.status().quota[0].blocked_until, Some(121000));
        assert_eq!(s.status().quota[0].hourly_remaining, Some(0));
        assert!(s
            .check_request("synthetic", "rest-v1", 120999)
            .unwrap_err()
            .contains("429"));
        assert!(s.check_request("synthetic", "rest-v1", 121000).is_ok());
        assert!(s.check_request("synthetic", "graphql-v2", 1001).is_err());
        s.observe("synthetic", "rest-v1", &HeaderMap::new(), 429, 200000);
        assert_eq!(s.status().quota[0].retry_after_seconds, None);
        assert_eq!(s.status().quota[0].blocked_until, Some(260000));
    }
    #[test]
    fn old_refresh_cannot_clear_a_connection_committed_after_refresh_preparation() {
        let mut saved = Session::default();
        saved.activate(Some("old-key"));
        saved.auth = Some((fingerprint("old-key"), Instant::now(), false));
        saved.begin_status(Some("old-key"), true);
        assert!(!saved.status().validated);
        let mut candidate = Session::default();
        candidate.activate(Some("new-key"));
        candidate.auth = Some((fingerprint("new-key"), Instant::now(), true));
        candidate.checked_at = Some(1000);
        saved.commit_candidate(candidate, || Ok(())).unwrap();
        // The earlier refresh now resumes. Its old-credential request is
        // rejected without a second auth-clear step affecting the new account.
        assert!(saved.check_request("old-key", "rest-v1", 1001).is_err());
        let status = saved.status();
        assert!(status.validated && status.premium);
        assert_eq!(status.account_status, "premium");
        assert_eq!(status.checked_at, Some(1000));
        saved.begin_status(Some("new-key"), false);
        assert!(saved.status().validated);
    }

    #[test]
    fn candidate_validation_survives_passive_reads_and_only_commits_after_persistence() {
        let mut saved = Session::default();
        saved.activate(Some("saved-key"));
        saved.auth = Some((fingerprint("saved-key"), Instant::now(), false));
        saved.observe(
            "saved-key",
            "rest-v1",
            &headers(&[("x-rl-hourly-remaining", "10")]),
            200,
            1,
        );
        let mut candidate = Session::default();
        candidate.activate(Some("candidate-key"));
        // A local snapshot during the remote candidate request reads the old
        // persisted key and cannot disturb the candidate's isolated response.
        saved.activate(Some("saved-key"));
        assert_eq!(saved.status().account_status, "free");
        candidate.observe(
            "candidate-key",
            "rest-v1",
            &headers(&[("x-rl-hourly-remaining", "20")]),
            200,
            2,
        );
        candidate.auth = Some((fingerprint("candidate-key"), Instant::now(), true));
        candidate.checked_at = Some(2);
        assert_eq!(saved.status().quota[0].hourly_remaining, Some(10));
        let result = saved.commit_candidate(candidate, || Ok(())).unwrap();
        assert_eq!(result.account_status, "premium");
        assert_eq!(result.quota[0].hourly_remaining, Some(20));
        let mut failing = Session::default();
        failing.activate(Some("unsaved-key"));
        failing.observe("unsaved-key", "rest-v1", &HeaderMap::new(), 429, 3);
        assert!(saved
            .commit_candidate(failing, || Err("Synthetic persistence failure".into()))
            .is_err());
        assert_eq!(saved.status().account_status, "premium");
        assert_eq!(saved.status().quota[0].hourly_remaining, Some(20));
        assert!(saved.check_request("candidate-key", "rest-v1", 4).is_ok());
    }

    #[test]
    fn key_change_clears_account_quota_and_ignores_old_responses() {
        let mut s = Session::default();
        s.activate(Some("synthetic-old"));
        s.auth = Some((fingerprint("synthetic-old"), Instant::now(), true));
        s.checked_at = Some(1000);
        s.observe(
            "synthetic-old",
            "rest-v1",
            &headers(&[("x-rl-hourly-remaining", "10")]),
            200,
            1001,
        );
        assert!(s.status().premium);
        s.activate(Some("synthetic-new"));
        assert!(!s.status().validated);
        assert_eq!(s.status().checked_at, None);
        assert!(s.status().quota.is_empty());
        s.observe(
            "synthetic-old",
            "rest-v1",
            &headers(&[("x-rl-hourly-remaining", "8")]),
            200,
            1002,
        );
        assert!(s.status().quota.is_empty());
        assert!(s.check_request("synthetic-old", "rest-v1", 1003).is_err());
        let serialized = serde_json::to_string(&s.status()).unwrap();
        assert!(
            !serialized.contains("synthetic")
                && !serialized.contains(&fingerprint("synthetic-new"))
        );
        s.activate(None);
        assert_eq!(s.status().account_status, "unconfigured");
    }
    #[test]
    fn malformed_headers_account_errors_and_expiry_stay_unknown() {
        let mut s = Session::default();
        s.activate(Some("synthetic"));
        s.observe(
            "synthetic",
            "rest-v1",
            &headers(&[
                ("x-rl-daily-remaining", "-1"),
                ("x-rl-hourly-limit", "9007199254740992"),
                ("x-rl-daily-reset", "secret-value"),
                ("x-rl-hourly-reset", ":::."),
            ]),
            200,
            1,
        );
        let quota = &s.status().quota[0];
        assert_eq!(quota.daily_remaining, None);
        assert_eq!(quota.hourly_limit, None);
        assert_eq!(quota.daily_reset, None);
        assert_eq!(quota.hourly_reset, None);
        assert_eq!(reset_value("2026-99-01T00:00:00Z"), None);
        assert_eq!(reset_value("1788739200"), Some("1788739200".into()));
        assert!(!account_premium(&json!({"user_id":1,"is_premium":false})).unwrap());
        assert!(account_premium(&json!({"user_id":1})).is_err());
        assert!(account_premium(&json!({"is_premium":true})).is_err());
        s.auth = Some((fingerprint("synthetic"), Instant::now() - TTL, true));
        assert_eq!(s.status().account_status, "unknown");
        assert!(!s.status().premium);
        s.observe("synthetic", "rest-v1", &HeaderMap::new(), 401, 2);
        assert_eq!(s.status().account_status, "invalid");
        assert!(s.check_request("synthetic", "rest-v1", 3).is_err());
        s.observe("synthetic", "rest-v1", &HeaderMap::new(), 403, 4);
        assert_eq!(s.status().account_status, "error");
    }
    #[tokio::test]
    #[ignore = "Two explicit read-only official API requests; prints only account/quota status"]
    async fn live_account_and_quota_headers_read_only() {
        let status = nexus_status(Some(true)).await.unwrap();
        assert!(status.validated, "Account validation must succeed");
        let key = environment_key().expect("Configure the existing environment key");
        let graph = request(&key, "/v2/graphql", Some(json!({"query":"{ __typename }"}))).await;
        println!("graphql_request_succeeded={}", graph.is_ok());
        println!(
            "{}",
            serde_json::to_string(&nexus_status(Some(false)).await.unwrap()).unwrap()
        );
    }
}

#[cfg(test)]
fn import_from_config(
    config: &Path,
    archive_id: &str,
    archive_path: &str,
    mod_unique_id: &str,
    relative_dir: &str,
    save: bool,
) -> Result<ImportCounts, String> {
    import_from_config_mode(
        config,
        archive_id,
        archive_path,
        mod_unique_id,
        relative_dir,
        save,
        false,
    )
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedArchiveMapping {
    archive_id: String,
    archive_path: String,
    mod_unique_id: String,
    relative_dir: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnresolvedArchiveMapping {
    archive_path: String,
    reason: String,
}
#[derive(Serialize)]
pub struct ArchiveResolution {
    mappings: Vec<ResolvedArchiveMapping>,
    unresolved: Vec<UnresolvedArchiveMapping>,
}

fn resolve_archive_components(
    archive_id: &str,
    archive: &Archive,
    mods: &[scanner::ScannedMod],
    lang: &str,
) -> ArchiveResolution {
    let mut result = ArchiveResolution {
        mappings: Vec::new(),
        unresolved: Vec::new(),
    };
    let has_target_locale = archive.files.iter().any(|file| {
        let filename = file
            .path
            .rsplit('/')
            .next()
            .unwrap_or_default()
            .to_lowercase();
        !file.is_default
            && (filename == format!("{lang}.json") || (lang == "pt" && filename == "pt-br.json"))
    });
    for file in &archive.files {
        let path = file.path.replace('\\', "/").to_lowercase();
        let filename = path.rsplit('/').next().unwrap_or_default();
        if file.is_default
            || (filename != format!("{lang}.json") && !(lang == "pt" && filename == "pt-br.json"))
        {
            if file.is_default && !has_target_locale {
                result.unresolved.push(UnresolvedArchiveMapping {
                    archive_path: file.path.clone(),
                    reason: "This archive has no explicit target-language file. Translated default.json files require explicit import and are not automatically mapped.".into(),
                });
            }
            continue;
        }
        let parent = path.rsplit_once('/').map(|(p, _)| p).unwrap_or_default();
        let mut candidates: Vec<_> = mods
            .iter()
            .flat_map(|component| {
                let folder = component.folder_path.replace('\\', "/");
                let name = folder
                    .trim_end_matches('/')
                    .rsplit('/')
                    .next()
                    .unwrap_or_default()
                    .to_lowercase();
                component.i18n_files.iter().filter_map(move |i18n| {
                    let relative = i18n.relative_dir.replace('\\', "/").to_lowercase();
                    let suffix = format!("{name}/{relative}");
                    let identity_matches = match &file.manifest_unique_id {
                        Some(uid) => uid.eq_ignore_ascii_case(&component.unique_id),
                        None => {
                            !matches!(
                                name.as_str(),
                                "mod"
                                    | "mods"
                                    | "code"
                                    | "data"
                                    | "i18n"
                                    | "translation"
                                    | "translations"
                                    | "content"
                                    | "contentpack"
                                    | "cp"
                                    | "plugin"
                            ) && (parent == suffix || parent.ends_with(&format!("/{suffix}")))
                        }
                    };
                    let relative_matches =
                        parent == relative || parent.ends_with(&format!("/{relative}"));
                    (identity_matches && relative_matches).then_some((component, i18n))
                })
            })
            .collect();
        // A numbered folder alias is considered only after exact identity/path
        // failed, and only with substantial source-key corroboration.
        if candidates.is_empty() && file.manifest_unique_id.is_none() {
            let keys: HashSet<String> = archive
                .documents
                .get(&file.path)
                .and_then(|body| scanner::parse_flat_object(body, Path::new("archive locale")).ok())
                .map(|map| {
                    map.keys()
                        .filter(|k| k.as_str() != "$schema")
                        .cloned()
                        .collect()
                })
                .unwrap_or_default();
            if keys.len() >= 8 {
                for component in mods {
                    let folder = component.folder_path.replace('\\', "/");
                    let name = folder
                        .trim_end_matches('/')
                        .rsplit('/')
                        .next()
                        .unwrap_or_default()
                        .to_lowercase();
                    let stem = name.trim_end_matches(|c: char| c.is_ascii_digit());
                    if stem.len() < 8 {
                        continue;
                    }
                    for i18n in &component.i18n_files {
                        let relative = i18n.relative_dir.replace('\\', "/").to_lowercase();
                        let prefix = parent
                            .strip_suffix(&format!("/{relative}"))
                            .unwrap_or_default();
                        let archive_folder = prefix.rsplit('/').next().unwrap_or_default();
                        if archive_folder == name
                            || archive_folder.trim_end_matches(|c: char| c.is_ascii_digit()) != stem
                        {
                            continue;
                        }
                        if let Some(source) = std::fs::read_to_string(&i18n.default_path)
                            .ok()
                            .and_then(|body| {
                                scanner::parse_flat_object(&body, Path::new(&i18n.default_path))
                                    .ok()
                            })
                        {
                            let matched =
                                keys.iter().filter(|key| source.contains_key(*key)).count();
                            let substantive = keys
                                .iter()
                                .filter(|key| key.len() >= 12 && source.contains_key(*key))
                                .count();
                            if matched * 100 >= keys.len() * 90 && substantive >= 8 {
                                candidates.push((component, i18n));
                            }
                        }
                    }
                }
            }
        }
        if let [(component, i18n)] = candidates.as_slice() {
            result.mappings.push(ResolvedArchiveMapping {
                archive_id: archive_id.into(),
                archive_path: file.path.clone(),
                mod_unique_id: component.unique_id.clone(),
                relative_dir: i18n.relative_dir.clone(),
            });
        } else {
            result.unresolved.push(UnresolvedArchiveMapping {
                archive_path: file.path.clone(),
                reason: if candidates.is_empty() {
                    "No installed component with matching manifest identity or component path."
                } else {
                    "More than one installed component/path matches; no automatic target selected."
                }
                .into(),
            });
        }
    }
    let mut counts = HashMap::new();
    for mapping in &result.mappings {
        *counts
            .entry((
                mapping.mod_unique_id.to_lowercase(),
                mapping.relative_dir.to_lowercase(),
            ))
            .or_insert(0) += 1;
    }
    result.mappings.retain(|mapping| {
        if counts[&(mapping.mod_unique_id.to_lowercase(), mapping.relative_dir.to_lowercase())] == 1 {true} else {
            result.unresolved.push(UnresolvedArchiveMapping {archive_path: mapping.archive_path.clone(), reason: "Multiple archive files target the same installed locale; no automatic winner selected.".into()});false
        }
    });
    result
}

#[tauri::command]
pub fn nexus_resolve_archive(
    app: AppHandle,
    archive_id: String,
) -> Result<ArchiveResolution, String> {
    let archive = lock()
        .archives
        .get(&archive_id)
        .filter(|a| a.created.elapsed() < TTL)
        .cloned()
        .ok_or("Archive expired. Select it again.")?;
    let config = crate::config_dir(&app)?;
    let saved = settings::load_checked(&config)?;
    let lang = language::normalize_target_code(
        saved
            .target_lang
            .as_deref()
            .ok_or("Choose a target language.")?,
    )?;
    let mods = saved.mods_path.ok_or("Choose a Mods folder.")?;
    let scan = scanner::scan_mods(Path::new(&mods), &lang, &config);
    if !scan.traversal_complete {
        return Err("Scan traversal is incomplete; automatic mapping is unavailable.".into());
    }
    Ok(resolve_archive_components(
        &archive_id,
        &archive,
        &scan.mods,
        &lang,
    ))
}

fn inspect_locale_json(
    path: &Path,
    target_lang: &str,
) -> Result<(ArchivePreview, Archive), String> {
    let lang = language::normalize_target_code(target_lang)?;
    let filename = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("Invalid locale filename.")?
        .to_lowercase();
    if filename != format!("{lang}.json") && !(lang == "pt" && filename == "pt-br.json") {
        return Err(format!("Select {lang}.json for the configured target language. Files are not automatically relabelled."));
    }
    let path = path
        .canonicalize()
        .map_err(|e| format!("Could not resolve locale JSON: {e}"))?;
    let mut bytes = Vec::new();
    std::fs::File::open(&path)
        .map_err(|e| e.to_string())?
        .take(ARCHIVE_JSON_LIMIT as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > ARCHIVE_JSON_LIMIT {
        return Err("Locale JSON exceeds 16 MiB limit.".into());
    }
    let body = std::str::from_utf8(&bytes).map_err(|_| "Locale JSON must be UTF-8.")?;
    let object = scanner::parse_flat_object(body, &path)?;
    // Reuse duplicate/folded-key validation before retaining the document.
    analyze(&[], body, "i18n")?;
    let local_path = path.to_string_lossy().replace('\\', "/");
    let archive_id = format!(
        "local-json:{:x}",
        Sha256::digest([local_path.as_bytes(), &bytes].concat())
    );
    let file = ArchiveFile {
        path: local_path.clone(),
        manifest_unique_id: None,
        is_default: false,
    };
    let archive = Archive {
        created: Instant::now(),
        files: vec![file.clone()],
        documents: HashMap::from([(
            local_path,
            serde_json::to_string(&object).map_err(|e| e.to_string())?,
        )]),
        source_url: None,
    };
    Ok((ArchivePreview {
        archive_id,
        files: vec![file],
        notice: "Local locale JSON; confirm its target component. No Nexus source identity is inferred.".into(),
    }, archive))
}

#[tauri::command]
pub fn nexus_pick_locale_json(app: AppHandle) -> Result<Option<ArchivePreview>, String> {
    let config = crate::config_dir(&app)?;
    let settings = settings::load_checked(&config)?;
    let lang = settings
        .target_lang
        .as_deref()
        .ok_or("Choose a target language first.")?;
    let Some(file) = app
        .dialog()
        .file()
        .set_title(format!("Import {lang}.json"))
        .add_filter("Locale JSON", &["json"])
        .blocking_pick_file()
    else {
        return Ok(None);
    };
    let (preview, archive) =
        inspect_locale_json(&file.into_path().map_err(|e| e.to_string())?, lang)?;
    let mut session = lock();
    session.archives.retain(|_, a| a.created.elapsed() < TTL);
    if session.archives.len() >= 3 {
        session.archives.clear();
    }
    session.archives.insert(preview.archive_id.clone(), archive);
    Ok(Some(preview))
}

#[tauri::command]
pub fn nexus_pick_archive(app: AppHandle) -> Result<Option<ArchivePreview>, String> {
    let Some(file) = app
        .dialog()
        .file()
        .add_filter("Translation ZIP", &["zip"])
        .blocking_pick_file()
    else {
        return Ok(None);
    };
    let path = file.into_path().map_err(|e| e.to_string())?;
    if std::fs::metadata(&path).map_err(|e| e.to_string())?.len() > DOWNLOAD_LIMIT as u64 {
        return Err("Archive exceeds 64 MiB limit".into());
    }
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let archive_id = format!("{:x}", Sha256::digest(&bytes));
    let archive = inspect_zip(bytes)?;
    let preview = ArchivePreview {
        archive_id: archive_id.clone(),
        files: archive.files.clone(),
        notice: NOTICE.into(),
    };
    let mut session = lock();
    session.archives.retain(|_, a| a.created.elapsed() < TTL);
    if session.archives.len() >= 3 {
        session.archives.clear();
    }
    session.archives.insert(archive_id, archive);
    Ok(Some(preview))
}
