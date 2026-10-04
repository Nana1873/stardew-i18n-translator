//! App-owned public-client OAuth. Tokens never enter the WebView or logs.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ring::{
    rand::{SecureRandom, SystemRandom},
    signature,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        OnceLock,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::Mutex,
    task::AbortHandle,
};

pub const AUTH: &str = "https://auth.openai.com";
pub const RESOURCE: &str = "https://api.openai.com/v1";
const PLAN_SCOPE: &str = "chatgpt.tokens.use.direct";
static STATE: OnceLock<Mutex<AuthState>> = OnceLock::new();
static INITIALIZATION_ERROR: OnceLock<String> = OnceLock::new();
static GENERATION: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Registration {
    host_id: String,
    client_id: Option<String>,
    subject: Option<String>,
}
// Deliberately no Debug: these values must not appear in diagnostics.
#[derive(Clone, Serialize, Deserialize)]
struct Session {
    client_id: String,
    subject: String,
    email: Option<String>,
    access_token: String,
    refresh_token: Option<String>,
    id_token: Option<String>,
    scope: String,
    expires_at: u64,
}
struct AuthState {
    directory: PathBuf,
    registration: Registration,
    session: Option<Session>,
    pending: Option<AbortHandle>,
    error: Option<String>,
}
fn state() -> Result<&'static Mutex<AuthState>, String> {
    STATE.get().ok_or_else(|| {
        INITIALIZATION_ERROR
            .get()
            .cloned()
            .unwrap_or_else(|| "ChatGPT sign-in is unavailable in this session.".into())
    })
}
pub fn record_initialization_error(error: String) {
    let _ = INITIALIZATION_ERROR.set(error);
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn random() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| "Could not prepare secure sign-in.")?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}
pub fn generation() -> u64 {
    GENERATION.load(Ordering::Acquire)
}

pub fn initialize(directory: PathBuf) -> Result<(), String> {
    let path = directory.join("chatgpt-registration.json");
    let registration = if path.exists() {
        serde_json::from_slice::<Registration>(&bounded_file(&path)?).map_err(|_| {
            "ChatGPT registration is unreadable. Restore its backup before signing in."
        })?
    } else {
        let mut bytes = [0_u8; 16];
        SystemRandom::new()
            .fill(&mut bytes)
            .map_err(|_| "Could not create the ChatGPT host identity.")?;
        bytes[6] = (bytes[6] & 15) | 64;
        bytes[8] = (bytes[8] & 63) | 128;
        let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        let registration = Registration {
            host_id: format!(
                "urn:uuid:{}-{}-{}-{}-{}",
                &hex[..8],
                &hex[8..12],
                &hex[12..16],
                &hex[16..20],
                &hex[20..]
            ),
            client_id: None,
            subject: None,
        };
        write_private(
            &path,
            &serde_json::to_vec(&registration)
                .map_err(|_| "Could not save ChatGPT registration.")?,
        )?;
        registration
    };
    if !registration.host_id.starts_with("urn:uuid:")
        || registration.host_id.len() != 45
        || registration
            .client_id
            .as_deref()
            .is_some_and(|id| !valid_client(id))
    {
        return Err("ChatGPT registration is invalid.".into());
    }
    let stored = directory.join("chatgpt-session.bin");
    let loaded = if stored.exists() {
        bounded_file(&stored).and_then(|bytes| protect(&bytes, &registration.host_id, false))
            .and_then(|bytes| serde_json::from_slice::<Session>(&bytes).map_err(|_| "Saved ChatGPT session is unreadable. Sign in again.".into()))
            .and_then(|s| {
                if registration.client_id.as_deref() != Some(&s.client_id)
                    || registration.subject.as_deref() != Some(&s.subject) {
                    Err("Saved ChatGPT session does not match this app registration. Sign in again.".into())
                } else { Ok(s) }
            })
    } else {
        Err(String::new())
    };
    let (session, error) = match loaded {
        Ok(s) => (Some(s), None),
        Err(e) => (None, (!e.is_empty()).then_some(e)),
    };
    STATE
        .set(Mutex::new(AuthState {
            directory,
            registration,
            session,
            pending: None,
            error,
        }))
        .map_err(|_| "ChatGPT sign-in was already initialized.".into())
}
fn bounded_file(path: &Path) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let file =
        std::fs::File::open(path).map_err(|_| "Could not read the saved ChatGPT connection.")?;
    let mut bytes = Vec::new();
    file.take(256 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Could not read the saved ChatGPT connection.")?;
    if bytes.len() > 256 * 1024 {
        return Err("Saved ChatGPT connection exceeds its size limit.".into());
    }
    Ok(bytes)
}
fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let temporary = path.with_extension(format!("{}.tmp", random()?));
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| "Could not save the ChatGPT connection.")?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "Could not save the ChatGPT connection.")?;
        drop(file);
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            use windows_sys::Win32::Storage::FileSystem::{
                MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
            };
            let from: Vec<u16> = temporary.as_os_str().encode_wide().chain(Some(0)).collect();
            let to: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
            // Both NUL-terminated paths stay alive through the atomic replacement.
            if unsafe {
                MoveFileExW(
                    from.as_ptr(),
                    to.as_ptr(),
                    MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
                )
            } == 0
            {
                return Err("Could not replace the saved ChatGPT connection.".to_string());
            }
        }
        #[cfg(not(windows))]
        std::fs::rename(&temporary, path)
            .map_err(|_| "Could not replace the saved ChatGPT connection.")?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}
#[cfg(windows)]
fn protect(bytes: &[u8], entropy: &str, encrypt: bool) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        },
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_ptr().cast_mut(),
    };
    let entropy = CRYPT_INTEGER_BLOB {
        cbData: entropy.len() as u32,
        pbData: entropy.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    // DPAPI binds the encrypted record to the current Windows user. No UI,
    // machine-wide flag, or plaintext fallback is permitted.
    let success = unsafe {
        if encrypt {
            CryptProtectData(
                &input,
                std::ptr::null(),
                &entropy,
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                &entropy,
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
    };
    if success == 0 {
        return Err("Windows could not protect or restore the ChatGPT session. Sign in again on this Windows account.".into());
    }
    if output.cbData == 0 || output.cbData > 256 * 1024 || output.pbData.is_null() {
        unsafe {
            LocalFree(output.pbData.cast());
        }
        return Err("Windows returned an invalid protected ChatGPT session.".into());
    }
    // The successful DPAPI call owns this allocation; copy before LocalFree.
    let result =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        LocalFree(output.pbData.cast());
    }
    Ok(result)
}
#[cfg(not(windows))]
fn protect(_: &[u8], _: &str, _: bool) -> Result<Vec<u8>, String> {
    Err("ChatGPT credential storage requires Windows.".into())
}
fn save_session(state: &AuthState, session: &Session) -> Result<(), String> {
    let bytes = serde_json::to_vec(session).map_err(|_| "Could not save the ChatGPT session.")?;
    write_private(
        &state.directory.join("chatgpt-session.bin"),
        &protect(&bytes, &state.registration.host_id, true)?,
    )
}
pub fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|_| "Could not prepare the ChatGPT connection.".into())
}
pub async fn read_bounded(
    response: reqwest::Response,
) -> Result<Vec<u8>, crate::ai::ProviderFailure> {
    use futures_util::StreamExt;
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| {
            crate::ai::ProviderFailure::Transient("The OpenAI response was interrupted.".into())
        })?;
        if bytes.len().saturating_add(chunk.len()) > 2 * 1024 * 1024 {
            return Err(crate::ai::ProviderFailure::InvalidResponse(
                "OpenAI's response exceeded the size limit.".into(),
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
pub fn message(error: crate::ai::ProviderFailure) -> String {
    use crate::ai::ProviderFailure::*;
    match error {
        Cancelled => "The request was cancelled.".into(),
        Transient(e) | InvalidResponse(e) | Message(e) => e,
    }
}
pub fn api_failure(status: u16, body: &Value) -> crate::ai::ProviderFailure {
    use crate::ai::ProviderFailure;
    let guidance = match body["error"]["code"]
        .as_str()
        .or_else(|| body["error"].as_str())
    {
        Some("subscription_sharing_user_not_eligible") => {
            "ChatGPT plan use is not available for this account or workspace yet."
        }
        Some("subscription_sharing_usage_limit_exceeded") => {
            "A ChatGPT plan or app usage limit was reached. Check ChatGPT usage settings."
        }
        Some("subscription_sharing_usage_unavailable") => {
            "ChatGPT plan usage is temporarily unavailable. Try later."
        }
        Some("invalid_grant") => "The ChatGPT session expired. Sign in again.",
        _ => match status {
            401 => "OpenAI did not accept this session. Sign in again.",
            403 => "OpenAI refused this request under the current account or workspace policy.",
            429 => "OpenAI's usage limit was reached. Check ChatGPT usage settings.",
            _ => "OpenAI could not complete the request.",
        },
    };
    let safe = format!("{guidance} HTTP {status}.");
    if status >= 500 {
        ProviderFailure::Transient(safe)
    } else {
        ProviderFailure::Message(safe)
    }
}
async fn json(request: reqwest::RequestBuilder) -> Result<Value, crate::ai::ProviderFailure> {
    let response = request
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|_| {
            crate::ai::ProviderFailure::Transient(
                "Could not reach OpenAI. Check the network and try again.".into(),
            )
        })?;
    let status = response.status();
    let body = read_bounded(response).await?;
    let body: Value = serde_json::from_slice(&body).map_err(|_| {
        crate::ai::ProviderFailure::InvalidResponse(
            "OpenAI returned unreadable response data.".into(),
        )
    })?;
    if !status.is_success() {
        return Err(api_failure(status.as_u16(), &body));
    }
    Ok(body)
}
fn trusted_endpoint(value: &Value) -> Result<reqwest::Url, String> {
    let url = value
        .as_str()
        .and_then(|v| reqwest::Url::parse(v).ok())
        .ok_or("OpenAI discovery returned an invalid endpoint.")?;
    if url.origin().ascii_serialization() != AUTH
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("OpenAI discovery returned an unexpected endpoint.".into());
    }
    Ok(url)
}
async fn discovery(client: &reqwest::Client) -> Result<Value, String> {
    let value = json(client.get(format!("{AUTH}/.well-known/openid-configuration")))
        .await
        .map_err(message)?;
    if value["issuer"] != AUTH {
        return Err("OpenAI discovery returned an unexpected issuer.".into());
    }
    trusted_endpoint(&value["jwks_uri"])?;
    trusted_endpoint(&value["revocation_endpoint"])?;
    Ok(value)
}
fn valid_client(id: &str) -> bool {
    !id.is_empty()
        && id != "dynamic_agent_client"
        && id.len() <= 200
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
struct Attempt {
    state: String,
    nonce: String,
    verifier: String,
    redirect: String,
    registration: Registration,
}
fn callback(url: &reqwest::Url, attempt: &Attempt) -> Result<(String, String), String> {
    let pairs: Vec<_> = url.query_pairs().collect();
    let value = |key: &str| {
        pairs
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_ref())
    };
    for key in ["state", "code", "client_id", "error", "iss"] {
        if pairs.iter().filter(|(k, _)| k == key).count() > 1 {
            return Err("The sign-in callback contains duplicate parameters.".into());
        }
    }
    // Compare the complete random state, without logging callback values.
    if value("state") != Some(attempt.state.as_str()) {
        return Err("This sign-in attempt is invalid or expired.".into());
    }
    if value("iss").is_some_and(|issuer| issuer != AUTH) {
        return Err("The sign-in issuer does not match OpenAI.".into());
    }
    if value("error").is_some() {
        return Err("Sign-in was declined. Start again when ready.".into());
    }
    let code = value("code")
        .filter(|v| !v.is_empty() && v.len() <= 4096)
        .ok_or("The sign-in callback is incomplete.")?;
    let id = value("client_id")
        .or(attempt.registration.client_id.as_deref())
        .filter(|id| valid_client(id))
        .ok_or("ChatGPT registration is incomplete.")?;
    if attempt
        .registration
        .client_id
        .as_deref()
        .is_some_and(|saved| saved != id)
    {
        return Err("The sign-in client does not match this registration.".into());
    }
    Ok((code.into(), id.into()))
}
fn validate_identity(
    token: &str,
    keys: &Value,
    client: &str,
    nonce: &str,
    expected: Option<&str>,
    time: u64,
) -> Result<(String, Option<String>), String> {
    let invalid = || "The ChatGPT identity token did not pass validation.".to_string();
    let parts: Vec<_> = token.split('.').collect();
    if token.len() > 64 * 1024 || parts.len() != 3 {
        return Err(invalid());
    }
    let decode = |part: &str| URL_SAFE_NO_PAD.decode(part).map_err(|_| invalid());
    let header: Value = serde_json::from_slice(&decode(parts[0])?).map_err(|_| invalid())?;
    let claims: Value = serde_json::from_slice(&decode(parts[1])?).map_err(|_| invalid())?;
    if header["alg"] != "RS256" || header.get("crit").is_some() || !header["kid"].is_string() {
        return Err(invalid());
    }
    let candidates: Vec<_> = keys["keys"]
        .as_array()
        .ok_or_else(invalid)?
        .iter()
        .filter(|k| {
            k["kid"] == header["kid"]
                && k["kty"] == "RSA"
                && k.get("use").is_none_or(|u| u == "sig")
                && k.get("alg").is_none_or(|a| a == "RS256")
        })
        .collect();
    if candidates.len() != 1 {
        return Err(invalid());
    }
    let n = decode(candidates[0]["n"].as_str().ok_or_else(invalid)?)?;
    let e = decode(candidates[0]["e"].as_str().ok_or_else(invalid)?)?;
    signature::RsaPublicKeyComponents { n: &n, e: &e }
        .verify(
            &signature::RSA_PKCS1_2048_8192_SHA256,
            format!("{}.{}", parts[0], parts[1]).as_bytes(),
            &decode(parts[2])?,
        )
        .map_err(|_| invalid())?;
    let audience = claims["aud"]
        .as_str()
        .map(|s| vec![s])
        .or_else(|| {
            claims["aud"]
                .as_array()
                .and_then(|a| a.iter().map(Value::as_str).collect::<Option<Vec<_>>>())
        })
        .ok_or_else(invalid)?;
    if claims["iss"] != AUTH
        || !audience.contains(&client)
        || (audience.len() > 1 && claims["azp"] != client)
        || claims.get("azp").is_some_and(|a| a != client)
        || claims["exp"].as_u64().is_none_or(|exp| exp <= time)
        || claims["iat"].as_u64().is_none_or(|iat| iat > time + 60)
        || claims
            .get("nbf")
            .is_some_and(|n| n.as_u64().is_none_or(|n| n > time + 60))
        || claims["nonce"] != nonce
    {
        return Err(invalid());
    }
    let subject = claims["sub"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 512)
        .ok_or_else(invalid)?;
    if expected.is_some_and(|s| s != subject) {
        return Err(invalid());
    }
    Ok((
        subject.into(),
        claims["email"]
            .as_str()
            .map(|s| s.chars().take(254).collect()),
    ))
}
fn token_session(
    data: &Value,
    client_id: String,
    subject: String,
    email: Option<String>,
    previous: Option<&Session>,
) -> Result<Session, String> {
    let token = |key: &str| {
        data[key]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 64 * 1024)
            .map(str::to_string)
    };
    let access_token =
        token("access_token").ok_or("OpenAI returned an incomplete access token.")?;
    let expires = data["expires_in"]
        .as_u64()
        .filter(|n| *n > 0 && *n <= 365 * 24 * 3600)
        .ok_or("OpenAI returned an invalid token expiry.")?;
    if !data["token_type"]
        .as_str()
        .is_some_and(|s| s.eq_ignore_ascii_case("bearer"))
    {
        return Err("OpenAI returned an unsupported token type.".into());
    }
    let scope = data["scope"]
        .as_str()
        .or_else(|| previous.map(|p| p.scope.as_str()))
        .filter(|s| s.len() <= 4096)
        .ok_or("OpenAI did not return granted permissions.")?
        .into();
    Ok(Session {
        client_id,
        subject,
        email,
        access_token,
        refresh_token: token("refresh_token")
            .or_else(|| previous.and_then(|p| p.refresh_token.clone())),
        id_token: previous
            .map(|p| p.id_token.clone())
            .unwrap_or_else(|| token("id_token")),
        scope,
        expires_at: now().saturating_add(expires),
    })
}
async fn exchange(attempt: &Attempt, code: &str, id: &str) -> Result<Session, String> {
    let client = client()?;
    let data = json(
        client
            .post(format!("{AUTH}/api/accounts/oauth/token"))
            .form(&[
                ("grant_type", "authorization_code"),
                ("client_id", id),
                ("code", code),
                ("code_verifier", &attempt.verifier),
                ("redirect_uri", &attempt.redirect),
                ("resource", RESOURCE),
            ]),
    )
    .await
    .map_err(message)?;
    let config = discovery(&client).await?;
    let keys = json(client.get(trusted_endpoint(&config["jwks_uri"])?))
        .await
        .map_err(message)?;
    let token = data["id_token"]
        .as_str()
        .ok_or("OpenAI did not return an identity token.")?;
    let (subject, email) = validate_identity(
        token,
        &keys,
        id,
        &attempt.nonce,
        attempt.registration.subject.as_deref(),
        now(),
    )?;
    token_session(&data, id.into(), subject, email, None)
}
pub async fn login_url() -> Result<String, String> {
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(|_| "Could not start the local sign-in callback.")?;
    let port = listener
        .local_addr()
        .map_err(|_| "Could not start the sign-in callback.")?
        .port();
    let mut state = state()?.lock().await;
    if let Some(task) = state.pending.take() {
        task.abort();
    }
    let epoch = GENERATION.fetch_add(1, Ordering::AcqRel) + 1;
    state.error = None;
    let attempt = Attempt {
        state: random()?,
        nonce: random()?,
        verifier: random()?,
        redirect: format!("http://127.0.0.1:{port}/auth/callback"),
        registration: state.registration.clone(),
    };
    let mut url = reqwest::Url::parse(&format!("{AUTH}/api/accounts/authorize"))
        .map_err(|_| "Could not prepare sign-in.")?;
    {
        let mut query = url.query_pairs_mut();
        query.extend_pairs([
            (
                "client_id",
                attempt
                    .registration
                    .client_id
                    .as_deref()
                    .unwrap_or("dynamic_agent_client"),
            ),
            ("ext_agent_host_id", &attempt.registration.host_id),
            ("response_type", "code"),
            ("redirect_uri", &attempt.redirect),
            (
                "scope",
                "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
            ),
            ("resource", RESOURCE),
            ("state", &attempt.state),
            ("nonce", &attempt.nonce),
            ("code_challenge_method", "S256"),
            (
                "code_challenge",
                &URL_SAFE_NO_PAD.encode(Sha256::digest(attempt.verifier.as_bytes())),
            ),
        ]);
        if attempt.registration.client_id.is_none() {
            query.append_pair("agent_name_hint", "Stardew i18n Translator");
        }
        if let Some(token) = state.session.as_ref().and_then(|s| s.id_token.as_deref()) {
            query.append_pair("id_token_hint", token);
        }
    }
    let task = tokio::spawn(async move {
        let result =
            tokio::time::timeout(Duration::from_secs(600), accept_callback(listener, attempt))
                .await
                .unwrap_or_else(|_| Err("ChatGPT sign-in timed out. Start again.".into()));
        let Ok(state) = self::state() else {
            return;
        };
        let mut state = state.lock().await;
        if generation() != epoch {
            return;
        }
        state.pending = None;
        match result {
            Ok(session) => {
                state.registration.client_id = Some(session.client_id.clone());
                state.registration.subject = Some(session.subject.clone());
                let saved = serde_json::to_vec(&state.registration)
                    .map_err(|_| "Could not save ChatGPT registration.".to_string())
                    .and_then(|bytes| {
                        write_private(&state.directory.join("chatgpt-registration.json"), &bytes)
                    })
                    .and_then(|_| save_session(&state, &session));
                match saved {
                    Ok(()) => {
                        state.session = Some(session);
                        state.error = None;
                    }
                    Err(e) => state.error = Some(e),
                }
            }
            Err(e) => state.error = Some(e),
        }
    });
    state.pending = Some(task.abort_handle());
    Ok(url.into())
}
fn callback_response() -> String {
    let style = r#":root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, "Segoe UI", sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100svh; display: grid; place-items: center; padding: 24px; background: #101214; color: #f2f3f5; }
main { width: 100%; max-width: 440px; padding: 32px; background: #1b1f24; border: 1px solid #414953; border-radius: 12px; }
.brand { margin: 0 0 24px; color: #e3b85f; font-size: 13px; font-weight: 600; }
h1 { margin: 0 0 12px; font-size: 24px; line-height: 1.3; }
.hint { margin: 0; color: #b0b6be; font-size: 14px; line-height: 1.6; }"#;
    let style_hash =
        base64::engine::general_purpose::STANDARD.encode(Sha256::digest(style.as_bytes()));
    let body = format!(
        r#"<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Stardew i18n Translator</title><style>{style}</style></head>
<body><main aria-labelledby="callback-title"><p class="brand">Stardew i18n Translator</p>
<h1 id="callback-title">You can close this tab.</h1>
<p class="hint">Your sign-in status is shown in the app.</p></main></body></html>"#
    );
    format!("HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nContent-Security-Policy: default-src 'none'; style-src 'sha256-{style_hash}'; frame-ancestors 'none'\r\nContent-Length: {}\r\n\r\n{body}", body.len())
}

async fn accept_callback(listener: TcpListener, attempt: Attempt) -> Result<Session, String> {
    loop {
        let (mut stream, _) = listener
            .accept()
            .await
            .map_err(|_| "The sign-in callback stopped.")?;
        let read = tokio::time::timeout(Duration::from_secs(3), async {
            let mut bytes = Vec::new();
            loop {
                let mut chunk = [0_u8; 1024];
                let count = stream.read(&mut chunk).await.map_err(|_| ())?;
                if count == 0 {
                    return Err(());
                }
                bytes.extend_from_slice(&chunk[..count]);
                if bytes.len() > 8192 {
                    return Err(());
                }
                if bytes.windows(4).any(|w| w == b"\r\n\r\n") {
                    return Ok(bytes);
                }
            }
        })
        .await;
        let request = match read {
            Ok(Ok(b)) => String::from_utf8(b).ok(),
            _ => None,
        };
        let target = request.as_deref().and_then(|r| {
            let first: Vec<_> = r.lines().next()?.split_whitespace().collect();
            if first.len() != 3
                || first[0] != "GET"
                || first[2] != "HTTP/1.1"
                || !first[1].starts_with("/auth/callback?")
            {
                return None;
            }
            let expected = reqwest::Url::parse(&attempt.redirect)
                .ok()?
                .authority()
                .to_string();
            let hosts: Vec<_> = r
                .lines()
                .skip(1)
                .filter_map(|line| line.split_once(':'))
                .filter(|(name, _)| name.eq_ignore_ascii_case("host"))
                .collect();
            if hosts.len() != 1 || hosts[0].1.trim() != expected {
                return None;
            }
            reqwest::Url::parse(&format!("http://{expected}{}", first[1])).ok()
        });
        let valid_state = target.as_ref().is_some_and(|url| {
            url.query_pairs()
                .any(|(k, v)| k == "state" && v == attempt.state)
        });
        if !valid_state {
            let _ = tokio::time::timeout(
                Duration::from_secs(2),
                stream.write_all(
                    b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
                ),
            )
            .await;
            continue;
        }
        let result = match callback(&target.ok_or("Invalid sign-in callback.")?, &attempt) {
            Ok((code, id)) => exchange(&attempt, &code, &id).await,
            Err(e) => Err(e),
        };
        let response = callback_response();
        let _ = tokio::time::timeout(
            Duration::from_secs(2),
            stream.write_all(response.as_bytes()),
        )
        .await;
        return result;
    }
}
pub async fn access_token() -> Result<String, crate::ai::ProviderFailure> {
    let epoch = generation();
    let mut state = state()?.lock().await;
    let session = state.session.clone().ok_or_else(|| {
        state
            .error
            .clone()
            .unwrap_or_else(|| "Sign in with ChatGPT in Settings.".into())
    })?;
    if !session.scope.split_whitespace().any(|s| s == PLAN_SCOPE) {
        return Err("Sign in again and allow this app to use your ChatGPT plan.".into());
    }
    if session.expires_at > now() + 60 {
        return Ok(session.access_token);
    }
    let refresh = session
        .refresh_token
        .as_deref()
        .ok_or("The ChatGPT session expired. Sign in again.")?;
    let data = json(
        client()?
            .post(format!("{AUTH}/api/accounts/oauth/token"))
            .form(&[
                ("grant_type", "refresh_token"),
                ("client_id", &session.client_id),
                ("refresh_token", refresh),
                ("resource", RESOURCE),
            ]),
    )
    .await?;
    let updated = token_session(
        &data,
        session.client_id.clone(),
        session.subject.clone(),
        session.email.clone(),
        Some(&session),
    )?;
    // A sign-out may be waiting for this mutex. Retain the rotated token
    // before observing cancellation, so that sign-out revokes the latest token.
    let saved = save_session(&state, &updated);
    let token = updated.access_token.clone();
    let plan = updated.scope.split_whitespace().any(|s| s == PLAN_SCOPE);
    state.session = Some(updated);
    saved?;
    if generation() != epoch {
        return Err(crate::ai::ProviderFailure::Cancelled);
    }
    if !plan {
        return Err("ChatGPT plan permission is no longer enabled. Sign in again.".into());
    }
    Ok(token)
}
pub async fn status() -> crate::ai_provider::CloudAiStatus {
    let mut error = access_token().await.err().map(message);
    let authenticated = error.is_none();
    let mut authentication = None;
    let mut sign_in_pending = false;
    if let Ok(state) = state() {
        let state = state.lock().await;
        sign_in_pending = state.pending.is_some();
        if state.session.is_none() {
            // A signed-out profile is normal, not a failed connection.
            error = state.error.clone();
        } else if let Some(latest) = &state.error {
            error = Some(latest.clone());
        }
        if authenticated {
            authentication = state
                .session
                .as_ref()
                .and_then(|s| s.email.clone())
                .or_else(|| Some("ChatGPT browser sign-in".into()));
        }
    }
    crate::ai_provider::CloudAiStatus {
        authenticated,
        sign_in_pending,
        authentication,
        error,
    }
}
pub async fn abort_login() {
    GENERATION.fetch_add(1, Ordering::AcqRel);
    if let Ok(state) = state() {
        if let Some(task) = state.lock().await.pending.take() {
            task.abort();
        }
    }
}
pub async fn logout() -> Result<(), String> {
    GENERATION.fetch_add(1, Ordering::AcqRel);
    let mut state = state()?.lock().await;
    if let Some(task) = state.pending.take() {
        task.abort();
    }
    let session = state.session.take();
    state.error = None;
    let remote = async {
        let Some(session) = session else { return Ok(()); };
        let Some(refresh) = session.refresh_token else { return Ok(()); };
        let client = client()?;
        let config = discovery(&client).await?;
        let endpoint = trusted_endpoint(&config["revocation_endpoint"])?;
        for retry in 0..2 {
            let result = client.post(endpoint.clone()).timeout(Duration::from_secs(15))
                .form(&[("token", refresh.as_str()), ("token_type_hint", "refresh_token"), ("client_id", session.client_id.as_str())]).send().await;
            if matches!(&result, Ok(response) if response.status().as_u16() == 200) { return Ok(()); }
            if retry == 0 { tokio::time::sleep(Duration::from_millis(500)).await; }
        }
        Err("Signed out locally. Remote revocation was not confirmed; disconnect this app in ChatGPT settings.".to_string())
    }.await;
    let path = state.directory.join("chatgpt-session.bin");
    match std::fs::remove_file(path) { Ok(()) => {}, Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}, Err(_) => return Err("Signed out in memory, but the saved session could not be removed. Close the app and remove data/chatgpt-session.bin before restarting.".into()) }
    remote.map_err(|_| "Signed out locally. Remote revocation was not confirmed; disconnect this app in ChatGPT settings.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn callback_page_has_app_colors_and_only_allows_its_static_style() {
        let response = callback_response();
        let (headers, body) = response.split_once("\r\n\r\n").unwrap();
        let style = body
            .split_once("<style>")
            .unwrap()
            .1
            .split_once("</style>")
            .unwrap()
            .0;
        let hash =
            base64::engine::general_purpose::STANDARD.encode(Sha256::digest(style.as_bytes()));
        assert!(headers.contains(&format!("style-src 'sha256-{hash}'")));
        assert!(headers.contains("default-src 'none'"));
        assert!(headers.contains("Cache-Control: no-store"));
        assert!(headers.contains(&format!("Content-Length: {}", body.len())));
        assert!(body.contains("background: #101214"));
        assert!(body.contains("You can close this tab."));
        assert!(!body.contains("<script"));
        assert!(!body.contains("https://"));
    }

    #[test]
    fn callback_is_bound_to_state_and_registration() {
        let attempt = Attempt {
            state: "expected".into(),
            nonce: "n".into(),
            verifier: "v".into(),
            redirect: "http://127.0.0.1:1/auth/callback".into(),
            registration: Registration {
                host_id: "h".into(),
                client_id: Some("oaiapp_saved".into()),
                subject: None,
            },
        };
        let parse = |query| reqwest::Url::parse(&format!("{}?{query}", attempt.redirect)).unwrap();
        assert_eq!(
            callback(&parse("state=expected&code=c"), &attempt).unwrap(),
            ("c".into(), "oaiapp_saved".into())
        );
        for query in [
            "state=wrong&code=c",
            "state=expected&state=expected&code=c",
            "state=expected&code=c&client_id=other",
            "state=expected&error=access_denied",
            "state=expected&code=c&iss=https://evil.example",
            "state=expected&code=c&client_id=dynamic_agent_client",
        ] {
            assert!(callback(&parse(query), &attempt).is_err());
        }
    }
    #[test]
    fn discovery_never_redirects_credentials_to_another_origin() {
        for url in [
            "http://auth.openai.com/keys",
            "https://evil.example/keys",
            "https://auth.openai.com@evil.example/",
            "https://auth.openai.com/keys#fragment",
        ] {
            assert!(trusted_endpoint(&Value::String(url.into())).is_err());
        }
        assert!(trusted_endpoint(&Value::String(format!("{AUTH}/keys"))).is_ok());
    }
    #[test]
    fn identity_rejects_unsigned_and_untrusted_tokens() {
        for token in ["", "a.b.c", "eyJhbGciOiJub25lIn0.e30."] {
            assert!(validate_identity(
                token,
                &serde_json::json!({"keys":[]}),
                "app",
                "nonce",
                None,
                1
            )
            .is_err());
        }
    }
    #[test]
    fn signed_identity_checks_signature_issuer_audience_nonce_subject_and_time() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/chatgpt/synthetic-identity.json"
        ))
        .unwrap();
        let validate = |name: &str, client, nonce, subject, time| {
            validate_identity(
                fixture[name].as_str().unwrap(),
                &fixture,
                client,
                nonce,
                subject,
                time,
            )
        };
        for name in ["valid", "multipleAudience"] {
            assert_eq!(
                validate(
                    name,
                    "synthetic-client",
                    "synthetic-nonce",
                    Some("synthetic-subject"),
                    1001
                )
                .unwrap()
                .0,
                "synthetic-subject"
            );
        }
        for name in ["wrongIssuer", "missingAzp", "invalidAudience"] {
            assert!(validate(name, "synthetic-client", "synthetic-nonce", None, 1001).is_err());
        }
        for (client, nonce, subject, time) in [
            ("other", "synthetic-nonce", None, 1001),
            ("synthetic-client", "wrong", None, 1001),
            ("synthetic-client", "synthetic-nonce", Some("other"), 1001),
            ("synthetic-client", "synthetic-nonce", None, 2000),
            ("synthetic-client", "synthetic-nonce", None, 900),
        ] {
            assert!(validate("valid", client, nonce, subject, time).is_err());
        }
        let mut duplicate_keys = fixture.clone();
        duplicate_keys["keys"]
            .as_array_mut()
            .unwrap()
            .push(fixture["keys"][0].clone());
        assert!(validate_identity(
            fixture["valid"].as_str().unwrap(),
            &duplicate_keys,
            "synthetic-client",
            "synthetic-nonce",
            None,
            1001
        )
        .is_err());
        let mut tampered = fixture["valid"].as_str().unwrap().to_string();
        tampered.replace_range(..1, "a");
        assert!(validate_identity(
            &tampered,
            &fixture,
            "synthetic-client",
            "synthetic-nonce",
            None,
            1001
        )
        .is_err());
    }
    #[test]
    fn errors_do_not_echo_remote_messages() {
        let body = serde_json::json!({"error":{"message":"SECRET", "code":"unknown"}});
        assert!(!message(api_failure(400, &body)).contains("SECRET"));
        assert!(matches!(
            api_failure(503, &body),
            crate::ai::ProviderFailure::Transient(_)
        ));
    }
    #[cfg(windows)]
    #[test]
    fn saved_tokens_are_encrypted_and_bound_to_the_host() {
        let secret = b"synthetic refresh token";
        let encrypted = protect(secret, "synthetic-host", true).unwrap();
        assert!(!encrypted.windows(secret.len()).any(|w| w == secret));
        assert_eq!(
            protect(&encrypted, "synthetic-host", false).unwrap(),
            secret
        );
        assert!(protect(&encrypted, "another-host", false).is_err());
    }
}
