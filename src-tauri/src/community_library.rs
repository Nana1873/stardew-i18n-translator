use crate::{language, scanner, settings, translations};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommunityLibraryEntry {
    pub mod_unique_id: String,
    pub relative_dir: String,
    pub archive_path: String,
    pub strings: usize,
    pub source_url: Option<String>,
    pub archive_id: String,
    pub base: translations::ModState,
}

pub(crate) fn context(config: &Path) -> Result<(PathBuf, String, PathBuf), String> {
    let saved = settings::load_checked(config)?;
    let mods = saved
        .mods_path
        .ok_or("Choose an explicit Mods folder for this prototype.")?;
    let mods = Path::new(&mods).canonicalize().map_err(|e| e.to_string())?;
    let lang = language::normalize_target_code(
        saved
            .target_lang
            .as_deref()
            .ok_or("Choose a target language.")?,
    )?;
    let identity = format!(
        "{:x}",
        Sha256::digest(mods.to_string_lossy().to_lowercase().as_bytes())
    );
    let binding = config.join("community-work-context.json");
    if binding.exists() && std::fs::read_to_string(&binding).map_err(|e| e.to_string())? != identity
    {
        return Err("This prototype's personal work is bound to another Mods folder. Return to that folder; automatic cross-context reuse is disabled.".into());
    }
    Ok((
        mods,
        lang.clone(),
        config
            .join("community-library")
            .join(identity)
            .join(format!("{lang}.json")),
    ))
}

pub(crate) fn list(config: &Path) -> Result<Vec<CommunityLibraryEntry>, String> {
    let (_, _, path) = context(config)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|e| format!("Community library is unreadable: {e}"))
}

pub(crate) fn store(config: &Path, entry: CommunityLibraryEntry) -> Result<(), String> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    let _guard = LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "Library busy")?;
    let (_, _, path) = context(config)?;
    let mut entries = list(config)?;
    if let Some(old) = entries.iter().find(|old| {
        old.mod_unique_id == entry.mod_unique_id && old.relative_dir == entry.relative_dir
    }) {
        if old.archive_id == entry.archive_id {
            return Ok(());
        }
        return Err("This component already has a community base. Updating it requires base/personal conflict review, which is not yet supported in this prototype.".into());
    }
    let (mods, _, _) = context(config)?;
    let identity = format!(
        "{:x}",
        Sha256::digest(mods.to_string_lossy().to_lowercase().as_bytes())
    );
    std::fs::write(config.join("community-work-context.json"), identity)
        .map_err(|e| e.to_string())?;
    entries.push(entry);
    std::fs::create_dir_all(path.parent().ok_or("Invalid library path")?)
        .map_err(|e| e.to_string())?;
    let temp = path.with_extension("json.tmp");
    std::fs::write(
        &temp,
        serde_json::to_vec_pretty(&entries).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    crate::release_zip::replace_file(&temp, &path, true)
}

#[tauri::command]
pub fn list_community_library(app: tauri::AppHandle) -> Result<Vec<CommunityLibraryEntry>, String> {
    list(&crate::config_dir(&app)?)
}

#[tauri::command]
pub fn build_private_output(
    app: tauri::AppHandle,
    destination: String,
    overwrite: bool,
) -> Result<crate::release_zip::ZipBuildOutcome, String> {
    build(&crate::config_dir(&app)?, &destination, overwrite)
}

pub(crate) fn build(
    config: &Path,
    destination: &str,
    overwrite: bool,
) -> Result<crate::release_zip::ZipBuildOutcome, String> {
    let (mods, lang, _) = context(config)?;
    let library = list(config)?;
    if library.is_empty() {
        return Err("Import a community translation into the library first.".into());
    }
    let scan = scanner::scan_mods(&mods, &lang, config);
    if !scan.traversal_complete {
        return Err("Resolve incomplete scan traversal before building private output.".into());
    }
    let working = translations::language_root(config, &lang)?;
    let temp = config.join(format!(
        "output-work-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos()
    ));
    std::fs::create_dir_all(&temp).map_err(|e| e.to_string())?;
    struct Cleanup(PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let _cleanup = Cleanup(temp.clone());
    let mut components = Vec::new();
    for entry in &library {
        let component = scan
            .mods
            .iter()
            .find(|m| m.unique_id == entry.mod_unique_id)
            .ok_or("A library component is missing from the current scan.")?;
        let file = component
            .i18n_files
            .iter()
            .find(|f| f.relative_dir == entry.relative_dir)
            .ok_or("A library i18n path is missing from the current scan.")?;
        let mut state = translations::load(&temp, &entry.mod_unique_id)?;
        state.extend(entry.base.clone());
        state.extend(translations::load(&working, &entry.mod_unique_id)?);
        translations::save_many(&temp, &entry.mod_unique_id, state.into_iter().collect())?;
        components.push(crate::release_zip::ZipComponentInput {
            unique_id: component.unique_id.clone(),
            name: component.name.clone(),
            version: component.version.clone(),
            folder_path: component.folder_path.clone(),
            files: vec![crate::export::ExportFileInput {
                relative_dir: file.relative_dir.clone(),
                default_path: file.default_path.clone(),
                target_path: temp.join("absent.json").display().to_string(),
            }],
        });
    }
    // Never use deployed locale files here: they may be our previous output.
    crate::release_zip::build_combined(&temp, &mods, &lang, components, destination, overwrite)
}
