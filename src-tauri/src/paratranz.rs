//! Explicit ParaTranz source upload and translation pull. Credentials and
//! import previews stay in memory; all local writes use the batch validator.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, State};

use crate::{batch, input_limits, language, scanner, settings, translations};

#[derive(Default)]
pub struct Runtime(Mutex<Session>);

#[derive(Default)]
struct Session {
    token: String,
    project: Option<Project>,
    preview: Option<Preview>,
    sequence: u64,
}

struct Preview {
    id: u64,
    mod_id: String,
    target_lang: String,
    batch: Value,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Project {
    id: u64,
    name: String,
    source: String,
    dest: String,
    privacy: u8,
}

#[derive(Serialize, Deserialize)]
pub struct RemoteFile {
    id: u64,
    name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    project: Project,
    files: Vec<RemoteFile>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileBinding {
    relative_dir: String,
    /// None explicitly creates a new source file; it never replaces another.
    file_id: Option<u64>,
}

#[derive(Deserialize)]
struct RemoteString {
    key: String,
    original: String,
    translation: String,
    stage: i32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    preview_id: u64,
    preflight: batch::ImportPreflight,
}

struct Context {
    root: PathBuf,
    lang: String,
    rows: HashMap<String, Vec<scanner::StringRow>>,
}

fn context(config: &Path, mod_id: &str) -> Result<Context, String> {
    let saved = settings::load_checked(config)?;
    let lang = language::normalize_target_code(
        saved
            .target_lang
            .as_deref()
            .ok_or("Choose a target language first.")?,
    )?;
    let mods = saved
        .mods_path
        .as_deref()
        .ok_or("Choose a Mods folder first.")?;
    if !Path::new(mods).is_dir() {
        return Err("The configured Mods folder is unavailable.".into());
    }
    let scanned = scanner::scan_mods(Path::new(mods), &lang, config)
        .mods
        .into_iter()
        .find(|item| item.unique_id == mod_id)
        .ok_or("The selected component is unavailable. Scan again.")?;
    let root = translations::language_root(config, &lang)?;
    let stored = translations::load(&root, mod_id)?;
    let mut rows = HashMap::new();
    for file in scanned.i18n_files {
        rows.insert(
            file.relative_dir.clone(),
            scanner::load_strings_checked(
                Path::new(&file.default_path),
                Path::new(&file.target_path),
                &stored,
                &file.relative_dir,
            )?,
        );
    }
    Ok(Context { root, lang, rows })
}

fn credentials(runtime: &Runtime) -> Result<(String, Project), String> {
    let session = runtime
        .0
        .lock()
        .map_err(|_| "ParaTranz session unavailable.")?;
    let project = session
        .project
        .clone()
        .ok_or("Connect ParaTranz in Settings first.")?;
    Ok((session.token.clone(), project))
}

fn check_language(project: &Project, lang: &str) -> Result<(), String> {
    if project.source != "en" || language::normalize_target_code(&project.dest)? != lang {
        return Err("ParaTranz project must use English and the current target language.".into());
    }
    Ok(())
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(45))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Could not initialize ParaTranz connection.".into())
}

// Fixed origin: personal tokens cannot be redirected to a configurable server.
fn request(
    token: &str,
    method: reqwest::Method,
    path: &str,
) -> Result<reqwest::RequestBuilder, String> {
    Ok(client()?
        .request(method, format!("https://paratranz.cn/api/{path}"))
        .bearer_auth(token))
}

async fn response(request: reqwest::RequestBuilder) -> Result<Value, String> {
    let mut result = request
        .send()
        .await
        .map_err(|_| "ParaTranz request failed or timed out.".to_string())?;
    if !result.status().is_success() {
        // Never expose provider bodies or HTTP diagnostics containing a token.
        return Err(format!(
            "ParaTranz returned HTTP {}. Check access and retry.",
            result.status().as_u16()
        ));
    }
    let mut body = Vec::new();
    while let Some(chunk) = result
        .chunk()
        .await
        .map_err(|_| "Could not read ParaTranz response.")?
    {
        if body.len() as u64 + chunk.len() as u64 > input_limits::MAX_JSON_BYTES {
            return Err("ParaTranz response exceeds the 64 MiB limit.".into());
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| "ParaTranz returned invalid JSON.".into())
}

async fn get<T: serde::de::DeserializeOwned>(token: &str, path: &str) -> Result<T, String> {
    serde_json::from_value(response(request(token, reqwest::Method::GET, path)?).await?)
        .map_err(|_| "ParaTranz returned an unsupported response.".into())
}

#[tauri::command]
pub async fn paratranz_connect(
    app: AppHandle,
    runtime: State<'_, Runtime>,
    project_id: u64,
    token: String,
) -> Result<Connection, String> {
    if project_id == 0
        || token.trim().is_empty()
        || token.len() > 4096
        || token.contains(['\r', '\n'])
    {
        return Err("Enter a project ID and a valid API token.".into());
    }
    let token = token.trim().to_string();
    let project: Project = get(&token, &format!("projects/{project_id}")).await?;
    if project.id != project_id {
        return Err("ParaTranz returned a different project.".into());
    }
    let saved = settings::load_checked(&crate::config_dir(&app)?)?;
    let lang = language::normalize_target_code(
        saved
            .target_lang
            .as_deref()
            .ok_or("Choose a target language first.")?,
    )?;
    check_language(&project, &lang)?;
    let files = get(&token, &format!("projects/{project_id}/files")).await?;
    let mut session = runtime
        .0
        .lock()
        .map_err(|_| "ParaTranz session unavailable.")?;
    session.token = token;
    session.project = Some(project.clone());
    session.preview = None;
    Ok(Connection { project, files })
}

#[tauri::command]
pub fn paratranz_disconnect(runtime: State<'_, Runtime>) -> Result<(), String> {
    let mut session = runtime
        .0
        .lock()
        .map_err(|_| "ParaTranz session unavailable.")?;
    session.token.clear();
    session.project = None;
    session.preview = None;
    Ok(())
}

#[tauri::command]
pub async fn paratranz_connection(
    runtime: State<'_, Runtime>,
) -> Result<Option<Connection>, String> {
    let Ok((token, project)) = credentials(&runtime) else {
        return Ok(None);
    };
    let files = get(&token, &format!("projects/{}/files", project.id)).await?;
    Ok(Some(Connection { project, files }))
}

fn validate_bindings(
    bindings: &[FileBinding],
    rows: &HashMap<String, Vec<scanner::StringRow>>,
) -> Result<(), String> {
    let mut dirs = HashSet::new();
    let mut ids = HashSet::new();
    for binding in bindings {
        if !rows.contains_key(&binding.relative_dir)
            || !dirs.insert(&binding.relative_dir)
            || binding.file_id.is_some_and(|id| id == 0 || !ids.insert(id))
        {
            return Err("Each source file must map to a distinct ParaTranz file.".into());
        }
    }
    if dirs.len() != rows.len() {
        return Err("Choose a mapping for every source file.".into());
    }
    Ok(())
}

fn convert_file(
    relative_dir: &str,
    rows: &[scanner::StringRow],
    remote: Vec<RemoteString>,
) -> Result<Vec<(batch::BatchExportItem, String)>, String> {
    let originals: HashMap<_, _> = rows
        .iter()
        .map(|row| (row.key.as_str(), row.source.as_str()))
        .collect();
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for item in remote {
        if !seen.insert(item.key.clone())
            || originals.get(item.key.as_str()) != Some(&item.original.as_str())
        {
            return Err("ParaTranz keys or English sources differ from this component. Nothing was imported.".into());
        }
        let translation = match item.stage {
            1 | 3 | 5 | 9 => item.translation,
            -1 | 0 | 2 => String::new(),
            _ => return Err("ParaTranz returned an unknown review stage.".into()),
        };
        result.push((
            batch::BatchExportItem {
                relative_dir: relative_dir.into(),
                key: item.key,
                source: item.original,
            },
            translation,
        ));
    }
    if seen.len() != originals.len() {
        return Err(
            "ParaTranz file does not contain the complete local source. Nothing was imported."
                .into(),
        );
    }
    Ok(result)
}

#[tauri::command]
pub async fn paratranz_preview(
    app: AppHandle,
    runtime: State<'_, Runtime>,
    mod_unique_id: String,
    bindings: Vec<FileBinding>,
) -> Result<ImportPreview, String> {
    let (token, project) = credentials(&runtime)?;
    let current = context(&crate::config_dir(&app)?, &mod_unique_id)?;
    check_language(&project, &current.lang)?;
    validate_bindings(&bindings, &current.rows)?;
    let mut entries = Vec::new();
    for binding in bindings {
        let id = binding
            .file_id
            .ok_or("Select an existing ParaTranz file before pulling translations.")?;
        let remote = get(
            &token,
            &format!("projects/{}/files/{id}/translation", project.id),
        )
        .await?;
        entries.extend(convert_file(
            &binding.relative_dir,
            &current.rows[&binding.relative_dir],
            remote,
        )?);
    }
    let items = entries
        .iter()
        .map(|(item, _)| item.clone())
        .collect::<Vec<_>>();
    let mut parsed = batch::build_batch(&mod_unique_id, &current.lang, &items);
    for (item, translation) in entries {
        parsed["files"][&item.relative_dir][&item.key] = Value::String(translation);
    }
    let preflight = batch::preflight_batch(&parsed, &mod_unique_id, &current.lang, &current.rows)?;
    let mut session = runtime
        .0
        .lock()
        .map_err(|_| "ParaTranz session unavailable.")?;
    if session.project.as_ref().map(|p| p.id) != Some(project.id) || session.token != token {
        return Err("ParaTranz connection changed. Pull again.".into());
    }
    session.sequence += 1;
    let preview_id = session.sequence;
    session.preview = Some(Preview {
        id: preview_id,
        mod_id: mod_unique_id,
        target_lang: current.lang,
        batch: parsed,
    });
    Ok(ImportPreview {
        preview_id,
        preflight,
    })
}

#[tauri::command]
pub fn paratranz_import(
    app: AppHandle,
    runtime: State<'_, Runtime>,
    preview_id: u64,
) -> Result<batch::ImportSummary, String> {
    let mut session = runtime
        .0
        .lock()
        .map_err(|_| "ParaTranz session unavailable.")?;
    let preview = session
        .preview
        .as_ref()
        .filter(|p| p.id == preview_id)
        .ok_or("Pull translations again before importing.")?;
    let current = context(&crate::config_dir(&app)?, &preview.mod_id)?;
    if current.lang != preview.target_lang {
        return Err("Target language changed. Pull again.".into());
    }
    let prepared = batch::apply_batch(
        &preview.batch,
        &preview.mod_id,
        &current.lang,
        &current.rows,
    )
    .map_err(|error| {
        error
            .replace("The batch file/key set", "The selected file/key set")
            .replace("since export", "since this preview")
            .replace("Create a new format-2 batch.", "Pull translations again.")
    })?;
    if !prepared.entries.is_empty() {
        translations::save_many(&current.root, &preview.mod_id, prepared.entries)?;
    }
    session.preview = None;
    Ok(prepared.summary)
}

#[tauri::command]
pub async fn paratranz_upload(
    app: AppHandle,
    runtime: State<'_, Runtime>,
    mod_unique_id: String,
    bindings: Vec<FileBinding>,
) -> Result<Vec<RemoteFile>, String> {
    let (token, project) = credentials(&runtime)?;
    let current = context(&crate::config_dir(&app)?, &mod_unique_id)?;
    check_language(&project, &current.lang)?;
    validate_bindings(&bindings, &current.rows)?;
    // Check every existing mapping before the first remote write. The initial
    // adapter refuses differing sources rather than replacing unrelated work.
    for binding in &bindings {
        if let Some(id) = binding.file_id {
            let remote = get(
                &token,
                &format!("projects/{}/files/{id}/translation", project.id),
            )
            .await?;
            convert_file(
                &binding.relative_dir,
                &current.rows[&binding.relative_dir],
                remote,
            )?;
        }
    }
    let mut files = Vec::new();
    for binding in bindings {
        let items = current.rows[&binding.relative_dir].iter().map(|row| serde_json::json!({
            "key": row.key, "original": row.source, "translation": "", "context": binding.relative_dir,
        })).collect::<Vec<_>>();
        let body =
            serde_json::to_string(&items).map_err(|_| "Could not prepare ParaTranz sources.")?;
        input_limits::ensure_json_output_size(body.len() as u64, "ParaTranz sources")?;
        let fingerprint = format!(
            "{:x}",
            Sha256::digest(format!("{mod_unique_id}\0{}", binding.relative_dir).as_bytes())
        );
        let filename = format!("sdv-{}.json", &fingerprint[..24]);
        let boundary = format!("sdv{}", &format!("{:x}", Sha256::digest(body.as_bytes())));
        if body.contains(&boundary) {
            return Err("Could not prepare a unique upload boundary.".into());
        }
        let payload = format!("--{boundary}\r\nContent-Disposition: form-data; name=\"incremental\"\r\n\r\ntrue\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\nContent-Type: application/json\r\n\r\n{body}\r\n--{boundary}--\r\n");
        let path = match binding.file_id {
            Some(id) => format!("projects/{}/files/{id}", project.id),
            None => format!("projects/{}/files", project.id),
        };
        let result = response(
            request(&token, reqwest::Method::POST, &path)?
                .header(
                    reqwest::header::CONTENT_TYPE,
                    format!("multipart/form-data; boundary={boundary}"),
                )
                .body(payload),
        )
        .await
        .map_err(|e| {
            format!("{e} Some earlier files may have uploaded; refresh before retrying.")
        })?;
        if let Some(file) = result.get("file") {
            files.push(
                serde_json::from_value(file.clone())
                    .map_err(|_| "Unsupported uploaded file response.")?,
            );
        } else if let Some(id) = binding.file_id {
            files.push(RemoteFile { id, name: filename });
        } else {
            return Err("Upload returned no file. Refresh before retrying.".into());
        }
    }
    runtime
        .0
        .lock()
        .map_err(|_| "ParaTranz session unavailable.")?
        .preview = None;
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows() -> Vec<scanner::StringRow> {
        vec![scanner::StringRow {
            key: "greeting".into(),
            source: "Hello {{PlayerName}}!".into(),
            target: String::new(),
            target_present: false,
            status: "untranslated".into(),
            token_mismatch_accepted: false,
            section: None,
        }]
    }

    fn remote(original: &str, stage: i32) -> Vec<RemoteString> {
        vec![RemoteString {
            key: "greeting".into(),
            original: original.into(),
            translation: "Chào {{PlayerName}}!".into(),
            stage,
        }]
    }

    #[test]
    fn stale_or_incomplete_remote_sources_fail_closed() {
        assert!(convert_file("i18n", &rows(), remote("Old source", 1)).is_err());
        assert!(convert_file("i18n", &rows(), vec![]).is_err());
        let mut duplicates = remote("Hello {{PlayerName}}!", 1);
        duplicates.extend(remote("Hello {{PlayerName}}!", 1));
        assert!(convert_file("i18n", &rows(), duplicates).is_err());
    }

    #[test]
    fn hidden_questioned_and_untranslated_values_are_excluded() {
        for stage in [-1, 0, 2] {
            assert_eq!(
                convert_file("i18n", &rows(), remote("Hello {{PlayerName}}!", stage)).unwrap()[0].1,
                ""
            );
        }
        assert!(convert_file("i18n", &rows(), remote("Hello {{PlayerName}}!", 8)).is_err());
    }

    #[test]
    fn reviewed_remote_text_still_uses_local_review_and_token_validation() {
        let converted = convert_file("i18n", &rows(), remote("Hello {{PlayerName}}!", 5)).unwrap();
        let items = converted
            .iter()
            .map(|(item, _)| item.clone())
            .collect::<Vec<_>>();
        let mut parsed = batch::build_batch("Author.Mod", "vi", &items);
        parsed["files"]["i18n"]["greeting"] = Value::String(converted[0].1.clone());
        let current = HashMap::from([("i18n".into(), rows())]);
        let prepared = batch::apply_batch(&parsed, "Author.Mod", "vi", &current).unwrap();
        assert_eq!(prepared.entries[0].1.status, "review-needed");
        parsed["files"]["i18n"]["greeting"] = Value::String("Missing placeholder".into());
        assert!(batch::apply_batch(&parsed, "Author.Mod", "vi", &current).is_err());
    }
}
