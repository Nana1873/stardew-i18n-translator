use crate::{language, scanner, settings, translations};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommunitySource {
    pub archive_id: String,
    pub archive_path: String,
    pub source_url: Option<String>,
}

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
    #[serde(default)]
    pub sources: Vec<CommunitySource>,
}

// Attempts live beside the accepted entries in the same context-scoped document.
// A locale receipt alone never proves that an entire archive was processed.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommunityImportAttempt {
    pub source_url: String,
    pub complete: bool,
    attempt_id: String,
}

#[derive(Default, Serialize, Deserialize)]
struct LibraryDocument {
    entries: Vec<CommunityLibraryEntry>,
    #[serde(default)]
    attempts: Vec<CommunityImportAttempt>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum StoredLibrary {
    Document(LibraryDocument),
    Legacy(Vec<CommunityLibraryEntry>),
}

static LIBRARY_LOCK: Mutex<()> = Mutex::new(());
static ATTEMPT_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn read_document(path: &Path) -> Result<LibraryDocument, String> {
    if !path.exists() {
        return Ok(LibraryDocument::default());
    }
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    match serde_json::from_slice(&bytes)
        .map_err(|e| format!("Community library is unreadable: {e}"))?
    {
        StoredLibrary::Document(document) => Ok(document),
        StoredLibrary::Legacy(entries) => Ok(LibraryDocument {
            entries,
            attempts: vec![],
        }),
    }
}

fn write_document(path: &Path, document: &LibraryDocument) -> Result<(), String> {
    std::fs::create_dir_all(path.parent().ok_or("Invalid library path")?)
        .map_err(|e| e.to_string())?;
    let temp = path.with_extension("json.tmp");
    std::fs::write(
        &temp,
        serde_json::to_vec_pretty(document).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    crate::release_zip::replace_file(&temp, path, true)
}

pub(crate) fn begin_attempt(config: &Path, mod_id: u64, file_id: u64) -> Result<String, String> {
    if mod_id == 0 || file_id == 0 {
        return Err("Invalid Nexus file identity.".into());
    }
    let _guard = LIBRARY_LOCK.lock().map_err(|_| "Library busy")?;
    let (_, _, path) = context(config)?;
    let mut document = read_document(&path)?;
    let source_url = format!(
        "https://www.nexusmods.com/stardewvalley/mods/{mod_id}?tab=files&file_id={file_id}"
    );
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let sequence = ATTEMPT_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let attempt_id = format!(
        "{:x}",
        Sha256::digest(format!("{}:{source_url}:{stamp}:{sequence}", path.display()).as_bytes())
    );
    document
        .attempts
        .retain(|attempt| attempt.source_url != source_url);
    document.attempts.push(CommunityImportAttempt {
        source_url,
        complete: false,
        attempt_id: attempt_id.clone(),
    });
    write_document(&path, &document)?;
    Ok(attempt_id)
}

pub(crate) fn finish_attempt(
    config: &Path,
    attempt_id: &str,
    complete: bool,
) -> Result<(), String> {
    let _guard = LIBRARY_LOCK.lock().map_err(|_| "Library busy")?;
    let (_, _, path) = context(config)?;
    let mut document = read_document(&path)?;
    let attempt = document
        .attempts
        .iter_mut()
        .find(|attempt| attempt.attempt_id == attempt_id)
        .ok_or("Import context or attempt changed. Retry the archive in the current workspace.")?;
    attempt.complete = complete;
    write_document(&path, &document)
}

#[tauri::command]
pub fn begin_community_import_attempt(
    app: tauri::AppHandle,
    mod_id: u64,
    file_id: u64,
) -> Result<String, String> {
    begin_attempt(&crate::config_dir(&app)?, mod_id, file_id)
}

#[tauri::command]
pub fn finish_community_import_attempt(
    app: tauri::AppHandle,
    attempt_id: String,
    complete: bool,
) -> Result<(), String> {
    finish_attempt(&crate::config_dir(&app)?, &attempt_id, complete)
}

#[tauri::command]
pub fn list_community_import_attempts(
    app: tauri::AppHandle,
) -> Result<Vec<CommunityImportAttempt>, String> {
    let (_, _, path) = context(&crate::config_dir(&app)?)?;
    Ok(read_document(&path)?.attempts)
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
    Ok(read_document(&path)?.entries)
}

pub(crate) fn store(config: &Path, entry: CommunityLibraryEntry) -> Result<(), String> {
    let _guard = LIBRARY_LOCK.lock().map_err(|_| "Library busy")?;
    let (_, _, path) = context(config)?;
    let mut document = read_document(&path)?;
    let entries = &mut document.entries;
    let mut entry = entry;
    if let Some(index) = entries.iter().position(|old| {
        old.mod_unique_id == entry.mod_unique_id && old.relative_dir == entry.relative_dir
    }) {
        let old = &entries[index];
        let incoming_source = CommunitySource {
            archive_id: entry.archive_id.clone(),
            archive_path: entry.archive_path.clone(),
            source_url: entry.source_url.clone(),
        };
        let mut sources = old.sources.clone();
        if sources.is_empty() {
            sources.push(CommunitySource {
                archive_id: old.archive_id.clone(),
                archive_path: old.archive_path.clone(),
                source_url: old.source_url.clone(),
            });
        }
        if !sources.contains(&incoming_source) {
            sources.push(incoming_source);
        }
        let mut base = if old.archive_id == entry.archive_id {
            old.base.clone()
        } else {
            entry.base.clone()
        };
        if old.archive_id == entry.archive_id {
            base.extend(entry.base);
        } else {
            base.extend(old.base.clone());
        }
        entry.base = base;
        entry.strings = entry.base.len();
        entry.archive_id = old.archive_id.clone();
        entry.archive_path = old.archive_path.clone();
        entry.source_url = old.source_url.clone();
        entry.sources = sources;
        entries.remove(index);
    }
    let (mods, _, _) = context(config)?;
    let identity = format!(
        "{:x}",
        Sha256::digest(mods.to_string_lossy().to_lowercase().as_bytes())
    );
    std::fs::write(config.join("community-work-context.json"), identity)
        .map_err(|e| e.to_string())?;
    if entry.sources.is_empty() {
        entry.sources.push(CommunitySource {
            archive_id: entry.archive_id.clone(),
            archive_path: entry.archive_path.clone(),
            source_url: entry.source_url.clone(),
        });
    }
    entries.push(entry);
    write_document(&path, &document)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(label: &str) -> (PathBuf, settings::AppSettings) {
        let config = crate::test_support::temp_dir(label);
        let mods = config.join("Mods");
        std::fs::create_dir_all(&mods).unwrap();
        let saved = settings::AppSettings {
            mods_path: Some(mods.display().to_string()),
            target_lang: Some("de".into()),
            ..Default::default()
        };
        settings::save(&config, &saved).unwrap();
        (config, saved)
    }

    fn entry() -> CommunityLibraryEntry {
        CommunityLibraryEntry {
            mod_unique_id: "Example.Mod".into(),
            relative_dir: "i18n".into(),
            archive_path: "Example/i18n/de.json".into(),
            strings: 0,
            source_url: Some(
                "https://www.nexusmods.com/stardewvalley/mods/123?tab=files&file_id=456".into(),
            ),
            archive_id: "archive".into(),
            base: Default::default(),
            sources: vec![],
        }
    }

    #[test]
    fn legacy_receipts_stay_unknown_and_migration_preserves_entries() {
        let (config, _) = fixture("community-attempt-migrate");
        let (_, _, path) = context(&config).unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, serde_json::to_vec(&vec![entry()]).unwrap()).unwrap();
        assert!(read_document(&path).unwrap().attempts.is_empty());
        let original = serde_json::to_value(list(&config).unwrap()).unwrap();
        let attempt = begin_attempt(&config, 123, 456).unwrap();
        assert!(!read_document(&path).unwrap().attempts[0].complete);
        finish_attempt(&config, &attempt, true).unwrap();
        assert!(read_document(&path).unwrap().attempts[0].complete);
        assert_eq!(
            serde_json::to_value(list(&config).unwrap()).unwrap(),
            original
        );
    }

    #[test]
    fn latest_attempt_and_exact_file_identity_survive_restart_and_locale_changes() {
        let (config, mut saved) = fixture("community-attempt-scope");
        let first = begin_attempt(&config, 123, 456).unwrap();
        finish_attempt(&config, &first, true).unwrap();
        let retry = begin_attempt(&config, 123, 456).unwrap();
        assert!(finish_attempt(&config, &first, true).is_err());
        let newer = begin_attempt(&config, 123, 457).unwrap();
        finish_attempt(&config, &newer, true).unwrap();
        let (_, _, path) = context(&config).unwrap();
        let attempts = read_document(&path).unwrap().attempts;
        assert_eq!(attempts.len(), 2);
        assert!(!attempts[0].complete);
        assert!(attempts[1].complete);
        saved.target_lang = Some("fr".into());
        settings::save(&config, &saved).unwrap();
        assert!(finish_attempt(&config, &retry, true).is_err());
        let (_, _, other) = context(&config).unwrap();
        assert!(read_document(&other).unwrap().attempts.is_empty());
        saved.target_lang = Some("de".into());
        let original_mods = saved.mods_path.clone();
        let other_mods = config.join("OtherMods");
        std::fs::create_dir_all(&other_mods).unwrap();
        saved.mods_path = Some(other_mods.display().to_string());
        settings::save(&config, &saved).unwrap();
        assert!(finish_attempt(&config, &retry, true).is_err());
        saved.mods_path = original_mods;
        settings::save(&config, &saved).unwrap();
        finish_attempt(&config, &retry, false).unwrap();
        assert!(!read_document(&path).unwrap().attempts[0].complete);
    }

    #[test]
    fn entry_store_preserves_attempt_and_attempt_does_not_touch_personal_state() {
        let (config, _) = fixture("community-attempt-preserve");
        let working = translations::language_root(&config, "de").unwrap();
        translations::save_one(
            &working,
            "Example.Mod",
            "key".into(),
            translations::StoredString {
                target: "Personal edit".into(),
                status: "translated".into(),
                source_hash: translations::source_hash("Original"),
            },
        )
        .unwrap();
        let personal = translations::load(&working, "Example.Mod").unwrap();
        let attempt = begin_attempt(&config, 123, 456).unwrap();
        store(&config, entry()).unwrap();
        finish_attempt(&config, &attempt, true).unwrap();
        let (_, _, path) = context(&config).unwrap();
        let document = read_document(&path).unwrap();
        assert_eq!(document.entries.len(), 1);
        assert!(document.attempts[0].complete);
        assert_eq!(
            serde_json::to_value(translations::load(&working, "Example.Mod").unwrap()).unwrap(),
            serde_json::to_value(personal).unwrap()
        );
    }
}
