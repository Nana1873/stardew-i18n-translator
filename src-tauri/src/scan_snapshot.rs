//! Portable English-source inventory used for previous-scan deltas.
//!
//! This is deliberately one small derived snapshot, not a scan-history or job
//! system. It stores hashes only and is rebuilt after every complete scan.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

use crate::scanner::{ScanDeltas, ScanResult, ScanStringIdentity};
use crate::{input_limits, translations};

const SNAPSHOT_VERSION: u32 = 2;
const SNAPSHOT_FILE: &str = "scan-source-snapshot.json";

static SNAPSHOT_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Serialize, Deserialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct SourceSnapshot {
    version: u32,
    mods_root_hash: String,
    entries: BTreeMap<String, SnapshotEntry>,
}

/// One source hash. Version 2 also records the owning component (lowercase
/// UniqueID) so a component the scan had to skip keeps its baseline; version 1
/// baselines stored the hash alone.
#[derive(Serialize, Deserialize, Debug, PartialEq, Eq, Clone)]
#[serde(untagged)]
enum SnapshotEntry {
    Owned { owner: String, source: String },
    Legacy(String),
}

impl SnapshotEntry {
    fn source(&self) -> &str {
        match self {
            Self::Owned { source, .. } | Self::Legacy(source) => source,
        }
    }

    fn owner(&self) -> Option<&str> {
        match self {
            Self::Owned { owner, .. } => Some(owner),
            Self::Legacy(_) => None,
        }
    }
}

/// Compare the completed scan to the immediately preceding scan of the same
/// Mods root, then replace the rebuildable hash snapshot. A first scan begins
/// tracking with zero observed changes. A component the scan had to skip
/// (wholly or in part) is left out of the comparison and keeps its previous
/// baseline, so one broken mod does not hide changes in all others. A bounded
/// or failed directory traversal, or a skip that names no component (such as
/// an unreadable manifest), still makes the whole comparison unavailable and
/// leaves the last valid snapshot intact. Expected exclusions are ignored.
pub(crate) fn apply(
    result: &mut ScanResult,
    mods_root: &Path,
    data_dir: &Path,
) -> Result<(), String> {
    let attention: Vec<_> = result
        .skipped_components
        .iter()
        .filter(|component| component.requires_attention)
        .collect();
    if !result.traversal_complete
        || attention
            .iter()
            .any(|component| component.component_unique_id.is_none())
    {
        result.source_deltas = None;
        return Ok(());
    }
    let skipped: HashSet<String> = attention
        .iter()
        .filter_map(|component| component.component_unique_id.as_deref())
        .map(str::to_lowercase)
        .collect();

    let mutex = SNAPSHOT_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    let root_hash = mods_root_hash(mods_root)?;
    let (mut current, current_identities) = current_snapshot(result, root_hash, &skipped)?;
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

    let same_root = previous
        .as_ref()
        .filter(|snapshot| snapshot.mods_root_hash == current.mods_root_hash);
    let deltas = same_root
        .map(|snapshot| compare(snapshot, &current, &current_identities, &skipped))
        .unwrap_or_default();
    // Skipped components keep their last baseline for the next healthy scan.
    if let Some(snapshot) = same_root {
        for (identity, entry) in &snapshot.entries {
            if entry.owner().is_some_and(|owner| skipped.contains(owner)) {
                current.entries.insert(identity.clone(), entry.clone());
            }
        }
    }

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
    skipped: &HashSet<String>,
) -> Result<(SourceSnapshot, BTreeMap<String, ScanStringIdentity>), String> {
    let mut entries = BTreeMap::new();
    let mut identities = BTreeMap::new();

    for scanned_mod in &result.mods {
        let owner = scanned_mod.unique_id.to_lowercase();
        if skipped.contains(&owner) {
            continue;
        }
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
                entries.insert(
                    identity_hash.clone(),
                    SnapshotEntry::Owned {
                        owner: owner.clone(),
                        source: source.source_hash.clone(),
                    },
                );
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
    skipped: &HashSet<String>,
) -> ScanDeltas {
    let mut added_strings = Vec::new();
    let mut changed_sources = Vec::new();

    for (identity_hash, entry) in &current.entries {
        let source_hash = entry.source();
        match previous
            .entries
            .get(identity_hash)
            .map(SnapshotEntry::source)
        {
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
        .iter()
        .filter(|(_, entry)| !entry.owner().is_some_and(|owner| skipped.contains(owner)))
        .filter(|(identity, _)| !current.entries.contains_key(*identity))
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
    if snapshot.version != SNAPSHOT_VERSION && snapshot.version != 1 {
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
    fn a_skipped_component_keeps_its_baseline_until_it_scans_again() {
        let root = crate::test_support::temp_dir("scan-snapshot-incomplete");
        let data = root.join("data");
        let mods = fixture(
            &root,
            "Example.Mod",
            r#"{"keep":"Hello","change":"Before","remove":"Gone"}"#,
            "{}",
        );

        scan_with_snapshot(&mods, &data, "de");
        let baseline_path = snapshot_path(&data);
        let baseline = std::fs::read(&baseline_path).unwrap();

        write(&mods.join("Example/i18n/default.json"), r#"{"broken":"#);
        let incomplete = scan_with_snapshot(&mods, &data, "de");
        assert!(incomplete
            .skipped_components
            .iter()
            .any(|component| component.requires_attention));
        // Only the broken component is left out; nothing else changed.
        assert_eq!(incomplete.source_deltas, Some(ScanDeltas::default()));
        assert_eq!(std::fs::read(&baseline_path).unwrap(), baseline);

        write(
            &mods.join("Example/i18n/default.json"),
            r#"{"keep":"Hello","change":"After","add":"New"}"#,
        );
        let repaired = scan_with_snapshot(&mods, &data, "de");
        let deltas = repaired.source_deltas.unwrap();
        assert_eq!(deltas.sources_changed, 1);
        assert_eq!(deltas.strings_added, 1);
        assert_eq!(deltas.strings_removed, 1);

        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn one_broken_component_does_not_hide_changes_in_another() {
        let root = crate::test_support::temp_dir("scan-snapshot-per-component");
        let data = root.join("data");
        let mods = root.join("Mods");
        for (folder, unique_id) in [("Broken", "Example.Broken"), ("Healthy", "Example.Healthy")] {
            write(
                &mods.join(folder).join("manifest.json"),
                &format!(r#"{{"Name":"{folder}","UniqueID":"{unique_id}","Version":"1.0.0"}}"#),
            );
            write(
                &mods.join(folder).join("i18n/default.json"),
                r#"{"line":"Before"}"#,
            );
        }
        scan_with_snapshot(&mods, &data, "de");

        write(&mods.join("Broken/i18n/default.json"), r#"{"broken":"#);
        write(
            &mods.join("Healthy/i18n/default.json"),
            r#"{"line":"After"}"#,
        );
        let partial = scan_with_snapshot(&mods, &data, "de");
        let deltas = partial
            .source_deltas
            .expect("the healthy component is compared");
        assert_eq!(deltas.sources_changed, 1);
        assert_eq!(deltas.changed_sources[0].mod_unique_id, "Example.Healthy");
        assert_eq!(
            deltas.strings_removed, 0,
            "the broken component's strings are not removed"
        );

        // Repaired, the broken component compares against its kept baseline.
        write(
            &mods.join("Broken/i18n/default.json"),
            r#"{"line":"Changed"}"#,
        );
        let repaired = scan_with_snapshot(&mods, &data, "de")
            .source_deltas
            .unwrap();
        assert_eq!(repaired.sources_changed, 1);
        assert_eq!(repaired.changed_sources[0].mod_unique_id, "Example.Broken");

        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn version_one_baselines_are_still_compared() {
        let root = crate::test_support::temp_dir("scan-snapshot-v1");
        let data = root.join("data");
        let mods = fixture(&root, "Example.Mod", r#"{"line":"Before"}"#, "{}");
        scan_with_snapshot(&mods, &data, "de");
        // Rewrite the saved baseline in the version 1 shape (hash only).
        let path = snapshot_path(&data);
        let mut value: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        value["version"] = 1.into();
        for entry in value["entries"].as_object_mut().unwrap().values_mut() {
            *entry = entry["source"].clone();
        }
        std::fs::write(&path, value.to_string()).unwrap();

        write(
            &mods.join("Example/i18n/default.json"),
            r#"{"line":"After"}"#,
        );
        let rescanned = scan_with_snapshot(&mods, &data, "de");
        assert!(rescanned.warnings.is_empty(), "{:?}", rescanned.warnings);
        assert_eq!(rescanned.source_deltas.unwrap().sources_changed, 1);
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn traversal_limit_preserves_the_last_valid_snapshot() {
        let root = crate::test_support::temp_dir("scan-snapshot-traversal-limit");
        let data = root.join("data");
        let mods = fixture(&root, "Example.Mod", r#"{"greeting":"Hello"}"#, "{}");

        scan_with_snapshot(&mods, &data, "de");
        let baseline_path = snapshot_path(&data);
        let baseline = std::fs::read(&baseline_path).unwrap();

        let mut deep_parent = mods.join("Deep");
        for index in 0..=crate::scanner::MAX_DEPTH {
            deep_parent = deep_parent.join(format!("level-{index}"));
        }
        std::fs::create_dir_all(&deep_parent).unwrap();
        std::fs::rename(mods.join("Example"), deep_parent.join("Example")).unwrap();

        let incomplete = scan_with_snapshot(&mods, &data, "de");
        assert!(!incomplete.traversal_complete);
        assert_eq!(incomplete.source_deltas, None);
        assert!(incomplete
            .warnings
            .iter()
            .any(|warning| warning.contains("could not be scanned completely")));
        assert_eq!(std::fs::read(&baseline_path).unwrap(), baseline);

        std::fs::rename(deep_parent.join("Example"), mods.join("Example")).unwrap();
        std::fs::remove_dir_all(mods.join("Deep")).unwrap();
        let repaired = scan_with_snapshot(&mods, &data, "de");
        assert!(repaired.traversal_complete);
        assert_eq!(repaired.source_deltas, Some(ScanDeltas::default()));

        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn expected_exclusions_still_advance_the_snapshot() {
        let root = crate::test_support::temp_dir("scan-snapshot-expected-exclusion");
        let data = root.join("data");
        let mods = fixture(&root, "Example.Mod", r#"{"greeting":"Before"}"#, "{}");

        let expected_exclusion = crate::scanner::SkippedComponent {
            package_id: Some("Example.LanguagePack".to_string()),
            component_unique_id: Some("Example.LanguagePack".to_string()),
            component_name: Some("Example Language Pack".to_string()),
            relative_location: "Example Language Pack".to_string(),
            reason: "Detected as a community language pack, not a translation target.".to_string(),
            requires_attention: false,
            rest_of_package_loaded: false,
        };

        let mut first = crate::scanner::scan_mods(&mods, "de", &data);
        first.skipped_components.push(expected_exclusion.clone());
        apply(&mut first, &mods, &data).unwrap();
        assert_eq!(first.source_deltas, Some(ScanDeltas::default()));

        write(
            &mods.join("Example/i18n/default.json"),
            r#"{"greeting":"After"}"#,
        );
        let mut second = crate::scanner::scan_mods(&mods, "de", &data);
        second.skipped_components.push(expected_exclusion);
        apply(&mut second, &mods, &data).unwrap();
        assert_eq!(second.source_deltas.unwrap().sources_changed, 1);

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
