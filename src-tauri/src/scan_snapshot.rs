//! Portable English-source inventory used for previous-scan deltas.
//!
//! This is deliberately one small derived snapshot, not a scan-history or job
//! system. It stores hashes only and is rebuilt after every successful scan.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

use crate::scanner::{ScanDeltas, ScanResult, ScanStringIdentity};
use crate::{input_limits, translations};

const SNAPSHOT_VERSION: u32 = 1;
const SNAPSHOT_FILE: &str = "scan-source-snapshot.json";

static SNAPSHOT_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Serialize, Deserialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct SourceSnapshot {
    version: u32,
    mods_root_hash: String,
    entries: BTreeMap<String, String>,
}

/// Compare the completed scan to the immediately preceding scan of the same
/// Mods root, then replace the rebuildable hash snapshot. A first scan begins
/// tracking with zero observed changes.
pub(crate) fn apply(
    result: &mut ScanResult,
    mods_root: &Path,
    data_dir: &Path,
) -> Result<(), String> {
    let mutex = SNAPSHOT_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    let root_hash = mods_root_hash(mods_root)?;
    let (current, current_identities) = current_snapshot(result, root_hash)?;
    let path = snapshot_path(data_dir);
    let previous = match load(&path) {
        Ok(snapshot) => snapshot,
        Err(error) => {
            result.warnings.push(format!(
                "Previous source-change comparison was unavailable ({error}). A new scan baseline was saved."
            ));
            None
        }
    };

    let deltas = previous
        .as_ref()
        .filter(|snapshot| snapshot.mods_root_hash == current.mods_root_hash)
        .map(|snapshot| compare(snapshot, &current, &current_identities))
        .unwrap_or_default();

    save_atomic(&path, &current)?;
    result.source_deltas = Some(deltas);
    Ok(())
}

fn snapshot_path(data_dir: &Path) -> PathBuf {
    data_dir.join(SNAPSHOT_FILE)
}

fn mods_root_hash(mods_root: &Path) -> Result<String, String> {
    let canonical = std::fs::canonicalize(mods_root).map_err(|error| {
        format!(
            "Could not resolve the selected Mods folder {}: {error}",
            mods_root.display()
        )
    })?;
    if !canonical.is_dir() {
        return Err(format!(
            "The selected Mods folder {} is not a directory.",
            mods_root.display()
        ));
    }
    let normalized = canonical
        .to_string_lossy()
        .replace('\\', "/")
        .to_lowercase();
    Ok(translations::source_hash(&normalized))
}

fn current_snapshot(
    result: &ScanResult,
    mods_root_hash: String,
) -> Result<(SourceSnapshot, BTreeMap<String, ScanStringIdentity>), String> {
    let mut entries = BTreeMap::new();
    let mut identities = BTreeMap::new();

    for scanned_mod in &result.mods {
        for file in &scanned_mod.i18n_files {
            for source in &file.source_hashes {
                let identity = ScanStringIdentity {
                    mod_unique_id: scanned_mod.unique_id.clone(),
                    relative_dir: file.relative_dir.clone(),
                    key: source.key.clone(),
                };
                let identity_json = serde_json::to_string(&(
                    &identity.mod_unique_id,
                    &identity.relative_dir,
                    &identity.key,
                ))
                .map_err(|error| format!("Could not serialize a scan identity: {error}"))?;
                let identity_hash = translations::source_hash(&identity_json);
                entries.insert(identity_hash.clone(), source.source_hash.clone());
                identities.insert(identity_hash, identity);
            }
        }
    }

    Ok((
        SourceSnapshot {
            version: SNAPSHOT_VERSION,
            mods_root_hash,
            entries,
        },
        identities,
    ))
}

fn compare(
    previous: &SourceSnapshot,
    current: &SourceSnapshot,
    current_identities: &BTreeMap<String, ScanStringIdentity>,
) -> ScanDeltas {
    let mut added_strings = Vec::new();
    let mut changed_sources = Vec::new();

    for (identity_hash, source_hash) in &current.entries {
        match previous.entries.get(identity_hash) {
            None => {
                if let Some(identity) = current_identities.get(identity_hash) {
                    added_strings.push(identity.clone());
                }
            }
            Some(previous_hash) if previous_hash != source_hash => {
                if let Some(identity) = current_identities.get(identity_hash) {
                    changed_sources.push(identity.clone());
                }
            }
            Some(_) => {}
        }
    }

    added_strings.sort();
    changed_sources.sort();
    let strings_removed = previous
        .entries
        .keys()
        .filter(|identity| !current.entries.contains_key(*identity))
        .count();

    ScanDeltas {
        sources_changed: changed_sources.len(),
        strings_added: added_strings.len(),
        strings_removed,
        added_strings,
        changed_sources,
    }
}

fn load(path: &Path) -> Result<Option<SourceSnapshot>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let body = input_limits::read_json_text(path)?;
    let snapshot: SourceSnapshot = serde_json::from_str(&body)
        .map_err(|error| format!("the saved scan baseline is invalid JSON: {error}"))?;
    if snapshot.version != SNAPSHOT_VERSION {
        return Err(format!(
            "scan baseline version {} is not supported",
            snapshot.version
        ));
    }
    Ok(Some(snapshot))
}

fn save_atomic(path: &Path, snapshot: &SourceSnapshot) -> Result<(), String> {
    let body = serde_json::to_string_pretty(snapshot)
        .map_err(|error| format!("Could not serialize the scan baseline: {error}"))?;
    input_limits::ensure_json_output_size(body.len() as u64, "Scan baseline JSON")?;
    serde_json::from_str::<SourceSnapshot>(&body)
        .map_err(|error| format!("Generated an invalid scan baseline: {error}"))?;

    let parent = path
        .parent()
        .ok_or_else(|| "Could not resolve the scan baseline folder.".to_string())?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create the scan baseline folder: {error}"))?;
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, body.as_bytes())
        .map_err(|error| format!("Could not write the temporary scan baseline: {error}"))?;
    if let Err(error) = std::fs::rename(&temp, path) {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("Could not finalize the scan baseline: {error}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, body: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    fn fixture(root: &Path, unique_id: &str, source: &str, target: &str) -> PathBuf {
        let component = root.join("Mods").join("Example");
        write(
            &component.join("manifest.json"),
            &format!(r#"{{"Name":"Example","UniqueID":"{unique_id}","Version":"1.0.0"}}"#),
        );
        write(&component.join("i18n/default.json"), source);
        write(&component.join("i18n/de.json"), target);
        root.join("Mods")
    }

    fn scan_with_snapshot(mods: &Path, data: &Path, language: &str) -> ScanResult {
        let mut result = crate::scanner::scan_mods(mods, language, data);
        apply(&mut result, mods, data).unwrap();
        result
    }

    #[test]
    fn first_scan_starts_at_zero_then_reports_changed_added_and_removed() {
        let root = crate::test_support::temp_dir("scan-snapshot-deltas");
        let data = root.join("data");
        let mods = fixture(
            &root,
            "Example.Mod",
            r#"{"keep":"Hello","change":"Before","remove":"Gone"}"#,
            "{}",
        );

        let first = scan_with_snapshot(&mods, &data, "de");
        assert_eq!(first.source_deltas, Some(ScanDeltas::default()));
        assert!(snapshot_path(&data).is_file());

        write(
            &mods.join("Example/i18n/default.json"),
            r#"{"keep":"Hello","change":"After","add":"New"}"#,
        );
        let second = scan_with_snapshot(&mods, &data, "de");
        let deltas = second.source_deltas.unwrap();
        assert_eq!(deltas.sources_changed, 1);
        assert_eq!(deltas.strings_added, 1);
        assert_eq!(deltas.strings_removed, 1);
        assert_eq!(deltas.changed_sources[0].key, "change");
        assert_eq!(deltas.added_strings[0].key, "add");

        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn semantic_source_and_target_only_edits_do_not_create_deltas() {
        let root = crate::test_support::temp_dir("scan-snapshot-semantic");
        let data = root.join("data");
        let mods = fixture(
            &root,
            "Example.Mod",
            "{\n  // comment\n  \"greeting\": \"Hello\\u0020world\"\n}",
            r#"{"greeting":"Hallo"}"#,
        );
        scan_with_snapshot(&mods, &data, "de");

        write(
            &mods.join("Example/i18n/default.json"),
            r#"{"greeting":"Hello world"}"#,
        );
        write(
            &mods.join("Example/i18n/fr.json"),
            r#"{"greeting":"Bonjour"}"#,
        );
        let second = scan_with_snapshot(&mods, &data, "fr");
        assert_eq!(second.source_deltas, Some(ScanDeltas::default()));

        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn identities_include_component_and_relative_i18n_directory() {
        let root = crate::test_support::temp_dir("scan-snapshot-identities");
        let data = root.join("data");
        let mods = root.join("Mods");
        for (folder, unique_id, relative_dir) in [
            ("One", "Example.One", "i18n"),
            ("Two", "Example.Two", "optional/i18n"),
        ] {
            write(
                &mods.join(folder).join("manifest.json"),
                &format!(r#"{{"Name":"{folder}","UniqueID":"{unique_id}","Version":"1.0.0"}}"#),
            );
            write(
                &mods.join(folder).join(relative_dir).join("default.json"),
                r#"{"same":"Before"}"#,
            );
        }
        scan_with_snapshot(&mods, &data, "de");

        write(&mods.join("One/i18n/default.json"), r#"{"same":"After"}"#);
        write(
            &mods.join("Two/optional/i18n/default.json"),
            r#"{"same":"After"}"#,
        );
        let second = scan_with_snapshot(&mods, &data, "de");
        let deltas = second.source_deltas.unwrap();
        assert_eq!(deltas.sources_changed, 2);
        assert_eq!(deltas.changed_sources[0].mod_unique_id, "Example.One");
        assert_eq!(deltas.changed_sources[1].relative_dir, "optional/i18n");

        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn a_different_mods_root_starts_a_new_zero_baseline() {
        let root = crate::test_support::temp_dir("scan-snapshot-roots");
        let data = root.join("data");
        let first_mods = fixture(&root.join("First"), "Example.Mod", r#"{"a":"A"}"#, "{}");
        let second_mods = fixture(
            &root.join("Second"),
            "Example.Mod",
            r#"{"a":"Changed","b":"B"}"#,
            "{}",
        );
        scan_with_snapshot(&first_mods, &data, "de");
        let second = scan_with_snapshot(&second_mods, &data, "de");
        assert_eq!(second.source_deltas, Some(ScanDeltas::default()));

        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn corrupt_snapshot_is_replaced_and_reported_as_one_scanner_warning() {
        let root = crate::test_support::temp_dir("scan-snapshot-corrupt");
        let data = root.join("data");
        let mods = fixture(&root, "Example.Mod", r#"{"a":"A"}"#, "{}");
        write(&snapshot_path(&data), "{ broken");

        let result = scan_with_snapshot(&mods, &data, "de");
        assert_eq!(result.source_deltas, Some(ScanDeltas::default()));
        assert_eq!(
            result
                .warnings
                .iter()
                .filter(|warning| warning.contains("Previous source-change comparison"))
                .count(),
            1
        );
        assert!(load(&snapshot_path(&data)).unwrap().is_some());

        std::fs::remove_dir_all(root).ok();
    }
}
