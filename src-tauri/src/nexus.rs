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
}
#[derive(Default)]
struct Session {
    archives: HashMap<String, Archive>,
    auth: Option<(String, Instant, bool)>,
    preflights: HashMap<String, (Instant, String)>,
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
async fn request(key: &str, path: &str, body: Option<Value>) -> Result<Value, String> {
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
    let bytes = bounded(
        req.send()
            .await
            .map_err(|_| "Nexus request failed (network, timeout, or redirect).")?,
        JSON_LIMIT,
    )
    .await?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| "Invalid Nexus API response.")?;
    if value.get("errors").is_some() {
        return Err("Nexus GraphQL search unavailable (API access or schema error).".into());
    }
    Ok(value)
}
async fn validate(key: &str) -> Result<bool, String> {
    let fingerprint = format!("{:x}", Sha256::digest(key.as_bytes()));
    if let Some((hash, at, premium)) = &lock().auth {
        if hash == &fingerprint && at.elapsed() < TTL {
            return Ok(*premium);
        }
    }
    let account = request(key, "/v1/users/validate.json", None).await?;
    if number(&account["user_id"]).unwrap_or(0) == 0 {
        return Err("Nexus API key validation failed.".into());
    }
    let premium = account["is_premium"] == true;
    lock().auth = Some((fingerprint, Instant::now(), premium));
    Ok(premium)
}
#[tauri::command]
pub async fn nexus_status(force_refresh: Option<bool>) -> Result<NexusStatus, String> {
    if force_refresh.unwrap_or(false) {
        lock().auth = None;
    }
    let Some(key) = environment_key() else {
        return Ok(NexusStatus {
            configured: false,
            premium: false,
            validated: false,
        });
    };
    if !force_refresh.unwrap_or(false) {
        let fingerprint = format!("{:x}", Sha256::digest(key.as_bytes()));
        let cached = lock()
            .auth
            .as_ref()
            .filter(|(hash, at, _)| hash == &fingerprint && at.elapsed() < TTL)
            .map(|(_, _, p)| *p);
        return Ok(NexusStatus {
            configured: true,
            premium: cached.unwrap_or(false),
            validated: cached.is_some(),
        });
    }
    Ok(NexusStatus {
        configured: true,
        premium: validate(&key).await?,
        validated: true,
    })
}
#[tauri::command]
pub async fn nexus_save_key(key: String) -> Result<NexusStatus, String> {
    let key = key.trim();
    if key.is_empty() || key.len() > 4096 {
        return Err("Enter a valid Nexus API key.".into());
    }
    lock().auth = None;
    let premium = validate(key).await?;
    #[cfg(windows)]
    {
        let env = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
            .open_subkey_with_flags("Environment", winreg::enums::KEY_SET_VALUE)
            .map_err(|_| "Could not open Windows user environment.")?;
        env.set_value("NEXUS_API_KEY", &key)
            .map_err(|_| "Could not save Nexus key to Windows user environment.")?;
    }
    #[cfg(not(windows))]
    {
        return Err("Nexus setup is supported on Windows only.".into());
    }
    {
        let mut s = lock();
        s.archives.clear();
        s.preflights.clear();
    }
    #[allow(unreachable_code)]
    Ok(NexusStatus {
        configured: true,
        premium,
        validated: true,
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
    search_name(value)
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
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
            let prefix = normalized(&title);
            let source = normalized(&name);
            let tier = if prefix == source || prefix.starts_with(&format!("{source} ")) {
                "possible-original-translation"
            } else {
                "possible-addon-or-other-translation"
            };
            found.insert(
                id,
                Candidate {
                    mod_id: id,
                    name: title,
                    summary,
                    version: text(row, "version"),
                    updated_at: text(row, "updatedAt"),
                    relationship_tier: tier.into(),
                },
            );
        }
    }
    let mut candidates: Vec<_> = found.into_values().collect();
    candidates.sort_by(|a, b| {
        a.relationship_tier
            .cmp(&b.relationship_tier)
            .reverse()
            .then(b.updated_at.cmp(&a.updated_at))
    });
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
    let archive = inspect_zip(bytes)?;
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
                status: "review-needed".into(),
                source_hash: translations::source_hash(&row.source),
            },
        ));
    }
    Ok((counts, entries))
}
fn import_from_config(
    config: &Path,
    archive_id: &str,
    archive_path: &str,
    mod_unique_id: &str,
    relative_dir: &str,
    save: bool,
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
    let (mut counts, entries) = analyze(
        &rows,
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
        log::info!(target: "app", "event=nexus_import_complete imported={} preserved_local={} token_invalid={} empty={} missing={} extra={} destination=review_state exported=0", counts.imported, counts.conflicts, counts.token_invalid, counts.empty, counts.missing, counts.extra);
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
) -> Result<ImportCounts, String> {
    import_from_config(
        &crate::config_dir(&app)?,
        &archive_id,
        &archive_path,
        &mod_unique_id,
        &relative_dir,
        false,
    )
}
#[tauri::command]
pub fn nexus_import_translation(
    app: AppHandle,
    archive_id: String,
    archive_path: String,
    mod_unique_id: String,
    relative_dir: String,
) -> Result<ImportCounts, String> {
    import_from_config(
        &crate::config_dir(&app)?,
        &archive_id,
        &archive_path,
        &mod_unique_id,
        &relative_dir,
        true,
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
        assert!(entries.iter().all(|(_, v)| v.status == "review-needed"));
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
    fn native_import_requires_preflight_and_only_writes_review_state() {
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
        assert_eq!(entry.status, "review-needed");
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
        // Vortex v2.6.3 forwards --install to its NXM handler with install=true.
        "--install".into(),
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
        return Err(
            "Choose the Vortex workflow in Settings before requesting installation.".into(),
        );
    }
    let configured = saved
        .vortex_executable
        .ok_or("Configure Vortex.exe in Settings before requesting installation.")?;
    let executable = vortex_path(Path::new(&configured))?;
    launch(&executable, &args)?;
    log::info!(target: "app", "event=nexus_vortex_handoff_requested mod_id={} file_id={} action=download_install_requested download_confirmed=false install_confirmed=false deployment_confirmed=false", mod_id, file_id);
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
            assert_eq!(args, &["--install", "nxm://stardewvalley/mods/10/files/20"]);
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
            "Choose the Vortex workflow in Settings before requesting installation."
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
            assert_eq!(args[0], "--install");
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
