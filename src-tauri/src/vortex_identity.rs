//! Narrow, read-only proof for an exact Nexus ZIP already deployed by Vortex.
//! Vortex's manifest has no Nexus IDs and may be stale. Require a state-backup
//! identity, the matching archive fingerprint, and unchanged deployed hardlinks.
//! Unsupported layouts and unavailable evidence deliberately yield no proof.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs::{self, File, Metadata};
use std::io::{Cursor, Read};
use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::scanner::ScanResult;

const MAX_JSON: u64 = 64 * 1024 * 1024;
const MAX_ARCHIVE: u64 = 128 * 1024 * 1024;
const MAX_EXPANDED: u64 = 64 * 1024 * 1024;
const MAX_ENTRIES: usize = 20_000;
const MAX_CANDIDATES: usize = 128;

#[derive(Serialize, Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub struct InstalledNexusTranslation {
    pub source_nexus_id: u64,
    pub mod_id: u64,
    pub file_id: u64,
}

pub(crate) fn detect(
    root: &Path,
    language: &str,
    scan: &ScanResult,
) -> Vec<InstalledNexusTranslation> {
    let Some(appdata) = std::env::var_os("APPDATA") else {
        return Vec::new();
    };
    detect_at(root, language, scan, &PathBuf::from(appdata).join("Vortex")).unwrap_or_default()
}

// Reject links/reparse points along the entire path, including configured roots.
fn plain_path(path: &Path) -> Option<PathBuf> {
    if !path.is_absolute() {
        return None;
    }
    for ancestor in path.ancestors() {
        let metadata = fs::symlink_metadata(ancestor).ok()?;
        if metadata.file_type().is_symlink() || reparse(&metadata) {
            return None;
        }
    }
    fs::canonicalize(path).ok()
}

#[cfg(windows)]
fn reparse(metadata: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn reparse(_: &Metadata) -> bool {
    false
}

fn relative(value: &str) -> Option<PathBuf> {
    if value.is_empty() || value.contains(':') || value.contains('\0') {
        return None;
    }
    let normalized = value.replace('\\', "/");
    if normalized
        .split('/')
        .any(|part| part.is_empty() || part == "." || part == ".." || part.ends_with([' ', '.']))
    {
        return None;
    }
    let path = PathBuf::from(normalized);
    path.components()
        .all(|component| matches!(component, Component::Normal(_)))
        .then_some(path)
}

fn key(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/").to_lowercase()
}

fn bounded(path: &Path, limit: u64) -> Option<Vec<u8>> {
    let canonical = plain_path(path)?;
    let mut file = File::open(&canonical).ok()?;
    let identity = same_file::Handle::from_file(file.try_clone().ok()?).ok()?;
    let before = file.metadata().ok()?;
    if !before.is_file() || before.len() > limit {
        return None;
    }
    let mut bytes = Vec::new();
    (&mut file).take(limit + 1).read_to_end(&mut bytes).ok()?;
    let after = file.metadata().ok()?;
    if bytes.len() as u64 != before.len()
        || before.len() != after.len()
        || before.modified().ok()? != after.modified().ok()?
        || identity != same_file::Handle::from_path(path).ok()?
    {
        return None;
    }
    Some(bytes)
}

fn json(path: &Path) -> Option<(Vec<u8>, Value)> {
    let bytes = bounded(path, MAX_JSON)?;
    let value =
        serde_json::from_slice(bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&bytes)).ok()?;
    Some((bytes, value))
}

fn positive(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .filter(|id| *id > 0 && *id <= 9_007_199_254_740_991)
}

fn newest_backup(vortex: &Path) -> Option<PathBuf> {
    let dir = vortex.join("temp/state_backups_full");
    let mut files = Vec::new();
    for name in ["hourly.json", "manual.json", "startup.json"] {
        let path = dir.join(name);
        if path.exists() {
            plain_path(&path)?;
            files.push((fs::metadata(&path).ok()?.modified().ok()?, path));
        }
    }
    files.sort_by_key(|file| std::cmp::Reverse(file.0));
    let first = files.first()?;
    // Equally recent but distinct snapshots are not an ordered source of truth.
    if files.get(1).is_some_and(|other| other.0 == first.0) {
        return None;
    }
    Some(first.1.clone())
}

fn detect_at(
    root: &Path,
    language: &str,
    scan: &ScanResult,
    vortex: &Path,
) -> Option<Vec<InstalledNexusTranslation>> {
    detect_checked(root, language, scan, vortex, || {})
}

struct VerifiedFile {
    target: PathBuf,
    staging: PathBuf,
    identity: same_file::Handle,
    digest: Vec<u8>,
}

fn detect_checked(
    root: &Path,
    language: &str,
    scan: &ScanResult,
    vortex: &Path,
    before_final_check: impl FnOnce(),
) -> Option<Vec<InstalledNexusTranslation>> {
    if !scan.traversal_complete
        || scan
            .skipped_components
            .iter()
            .any(|item| item.requires_attention)
    {
        return None;
    }
    let root = plain_path(root)?;
    let manifest_path = root.join("vortex.deployment.json");
    let (manifest_bytes, manifest) = json(&manifest_path)?;
    if manifest["version"] != 1
        || manifest["gameId"] != "stardewvalley"
        || manifest["deploymentMethod"] != "hardlink_activator"
        || plain_path(Path::new(manifest["targetPath"].as_str()?))? != root
    {
        return None;
    }
    let staging = plain_path(Path::new(manifest["stagingPath"].as_str()?))?;
    let backup_path = newest_backup(vortex)?;
    let (backup_bytes, backup) = json(&backup_path)?;
    let instance = manifest["instance"].as_str()?;
    if instance.is_empty() || backup["app"]["instanceId"].as_str()? != instance {
        return None;
    }
    let mods = backup["persistent"]["mods"]["stardewvalley"].as_object()?;
    let downloads = backup["persistent"]["downloads"]["files"].as_object()?;
    let download_root = plain_path(Path::new(backup["settings"]["downloads"]["path"].as_str()?))?;
    let files = manifest["files"].as_array()?;
    if files.len() > 200_000 || mods.len() > MAX_ENTRIES || downloads.len() > MAX_ENTRIES {
        return None;
    }
    let mut deployed = HashMap::new();
    for file in files {
        let rel = relative(file["relPath"].as_str()?)?;
        let target = match file["target"].as_str() {
            None | Some("") => rel,
            Some(prefix) => relative(prefix)?.join(rel),
        };
        if deployed.insert(key(&target), file).is_some() {
            return None;
        }
    }
    let mut targets: HashMap<String, BTreeSet<u64>> = HashMap::new();
    for component in &scan.mods {
        let package_ids: BTreeSet<_> = scan
            .mods
            .iter()
            .filter(|other| other.package_id == component.package_id)
            .filter_map(|other| other.nexus_id)
            .filter(|id| *id > 0 && *id <= 9_007_199_254_740_991)
            .collect();
        let ids = component
            .nexus_id
            .filter(|id| *id > 0 && *id <= 9_007_199_254_740_991)
            .map(|id| BTreeSet::from([id]))
            .unwrap_or(package_ids);
        if ids.len() != 1 {
            continue;
        }
        for file in &component.i18n_files {
            let effective = crate::scanner::target_read_path(Path::new(&file.target_path));
            if let Ok(rel) = effective.strip_prefix(&root) {
                targets.entry(key(rel)).or_default().extend(&ids);
            } else if let Some(effective) = plain_path(&effective) {
                if let Ok(rel) = effective.strip_prefix(&root) {
                    targets.entry(key(rel)).or_default().extend(&ids);
                }
            }
        }
    }
    let sources: BTreeSet<_> = targets
        .keys()
        .filter_map(|target| deployed.get(target))
        .filter_map(|file| file["source"].as_str())
        .collect();
    if sources.len() > MAX_CANDIDATES {
        return None;
    }
    let mut result = BTreeSet::new();
    let mut verified_files = Vec::new();
    let mut budget = (256 * 1024 * 1024u64, MAX_EXPANDED);
    for source in sources {
        if let Some(proofs) = prove_source(
            source,
            language,
            &root,
            &staging,
            &download_root,
            mods,
            downloads,
            &deployed,
            &targets,
            &mut budget,
            &mut verified_files,
        ) {
            result.extend(proofs);
        }
    }
    before_final_check();
    // Recheck all earlier files after later sources have finished. Retained
    // handles also detect a replacement with identical bytes and new hardlinks.
    for verified in verified_files {
        plain_path(&verified.staging)?;
        if verified.identity != same_file::Handle::from_path(&verified.target).ok()?
            || verified.identity != same_file::Handle::from_path(&verified.staging).ok()?
            || Sha256::digest(bounded(&verified.target, MAX_JSON)?).as_slice() != verified.digest
            || verified.identity != same_file::Handle::from_path(&verified.target).ok()?
            || verified.identity != same_file::Handle::from_path(&verified.staging).ok()?
        {
            return None;
        }
    }
    // A deployment or backup rotation during this scan invalidates the projection.
    if bounded(&manifest_path, MAX_JSON)? != manifest_bytes
        || bounded(&backup_path, MAX_JSON)? != backup_bytes
        || newest_backup(vortex)? != backup_path
    {
        return None;
    }
    Some(result.into_iter().collect())
}

#[allow(clippy::too_many_arguments)]
fn prove_source(
    source: &str,
    language: &str,
    root: &Path,
    staging: &Path,
    download_root: &Path,
    mods: &serde_json::Map<String, Value>,
    downloads: &serde_json::Map<String, Value>,
    deployed: &HashMap<String, &Value>,
    targets: &HashMap<String, BTreeSet<u64>>,
    budget: &mut (u64, u64),
    verified_files: &mut Vec<VerifiedFile>,
) -> Option<Vec<InstalledNexusTranslation>> {
    let source_rel = relative(source)?;
    let mut matching = mods
        .values()
        .filter(|entry| entry["installationPath"].as_str() == Some(source));
    let installed = matching.next()?;
    if matching.next().is_some() || installed["state"] != "installed" {
        return None;
    }
    let attr = &installed["attributes"];
    let mod_id = positive(&attr["modId"])?;
    let file_id = positive(&attr["fileId"])?;
    if attr["source"] != "nexus" || attr["downloadGame"] != "stardewvalley" {
        return None;
    }
    let download = downloads.get(installed["archiveId"].as_str()?)?;
    let ids = &download["modInfo"]["nexus"]["ids"];
    if download["state"] != "finished"
        || ids["gameId"] != "stardewvalley"
        || positive(&ids["modId"])? != mod_id
        || positive(&ids["fileId"])? != file_id
        || !download["game"]
            .as_array()?
            .iter()
            .any(|game| game == "stardewvalley")
    {
        return None;
    }
    let archive_name = relative(download["localPath"].as_str()?)?;
    if archive_name.components().count() != 1
        || !archive_name.extension()?.eq_ignore_ascii_case("zip")
    {
        return None;
    }
    let archive_path = download_root.join("stardewvalley").join(archive_name);
    // Reserve both bounded archive reads before opening a potentially large ZIP.
    let archive_cost = fs::metadata(&archive_path).ok()?.len().checked_mul(2)?;
    budget.0 = budget.0.checked_sub(archive_cost)?;
    let archive_bytes = bounded(&archive_path, MAX_ARCHIVE)?;
    let digest = format!("{:x}", md5::compute(&archive_bytes));
    if !digest.eq_ignore_ascii_case(attr["fileMD5"].as_str()?)
        || !digest.eq_ignore_ascii_case(download["fileMD5"].as_str()?)
    {
        return None;
    }
    let mut archive = zip::ZipArchive::new(Cursor::new(&archive_bytes)).ok()?;
    if archive.len() > MAX_ENTRIES {
        return None;
    }
    let mut seen = HashSet::new();
    let mut verified_targets = HashSet::new();
    let mut expanded = 0u64;
    let mut proofs = BTreeSet::new();
    for index in 0..archive.len() {
        let mut file = archive.by_index(index).ok()?;
        let rel = relative(file.name().trim_end_matches('/'))?;
        let rel_key = key(&rel);
        if !seen.insert(rel_key.clone())
            || file
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return None;
        }
        expanded = expanded.checked_add(file.size())?;
        budget.1 = budget.1.checked_sub(file.size())?;
        if expanded > MAX_EXPANDED {
            return None;
        }
        if file.is_dir() {
            continue;
        }
        let name = rel.file_name()?.to_str()?;
        let is_language = name.eq_ignore_ascii_case(&format!("{language}.json"))
            || (language == "pt" && name.eq_ignore_ascii_case("pt-BR.json"));
        if !is_language {
            continue;
        }
        // Only direct path-preserving ZIP layouts are supported. No guessed
        // installer transformations, basename matches, or archive-name IDs.
        let record = deployed.get(&rel_key)?;
        if record["source"].as_str()? != source
            || record["merged"]
                .as_array()
                .is_some_and(|merged| !merged.is_empty())
            || record["target"]
                .as_str()
                .is_some_and(|target| !target.is_empty())
        {
            return None;
        }
        let target = root.join(&rel);
        let staging_file = staging.join(&source_rel).join(&rel);
        plain_path(&target)?;
        plain_path(&staging_file)?;
        let identity = same_file::Handle::from_path(&target).ok()?;
        if !same_file::is_same_file(&target, &staging_file).ok()? {
            return None;
        }
        let mut content = Vec::new();
        (&mut file)
            .take(MAX_JSON + 1)
            .read_to_end(&mut content)
            .ok()?;
        if content.len() as u64 > MAX_JSON
            || content.len() as u64 != file.size()
            || bounded(&target, MAX_JSON)? != content
            || !same_file::is_same_file(&target, &staging_file).ok()?
            || identity != same_file::Handle::from_path(&target).ok()?
        {
            return None;
        }
        verified_files.push(VerifiedFile {
            target,
            staging: staging_file,
            identity,
            digest: Sha256::digest(&content).to_vec(),
        });
        verified_targets.insert(rel_key.clone());
        if let Some(source_ids) = targets.get(&rel_key) {
            for source_nexus_id in source_ids {
                proofs.insert(InstalledNexusTranslation {
                    source_nexus_id: *source_nexus_id,
                    mod_id,
                    file_id,
                });
            }
        }
    }
    // An archive missing another deployed language target must not establish
    // the identity of the entire translation from just one matching component.
    for target in targets.keys() {
        if deployed
            .get(target)
            .is_some_and(|record| record["source"].as_str() == Some(source))
            && !verified_targets.contains(target)
        {
            return None;
        }
    }
    if proofs.is_empty() || bounded(&archive_path, MAX_ARCHIVE)? != archive_bytes {
        return None;
    }
    Some(proofs.into_iter().collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Write;

    const REL: &str = "Example/i18n/de.json";
    const BODY: &[u8] = br#"{"first":"Translated"}"#;

    struct Fixture {
        base: PathBuf,
        root: PathBuf,
        vortex: PathBuf,
        manifest: Value,
        backup: Value,
    }

    impl Fixture {
        fn new() -> Self {
            let base = crate::test_support::temp_dir("vortex-identity");
            let root = base.join("Mods");
            let staging = base.join("staging");
            let vortex = base.join("Vortex");
            let downloads = base.join("downloads");
            for dir in [
                &root,
                &staging,
                &downloads,
                &vortex.join("temp/state_backups_full"),
            ] {
                fs::create_dir_all(dir).unwrap();
            }
            let mut fixture = Self {
                base,
                root: root.clone(),
                vortex,
                manifest: json!({"version":1,"gameId":"stardewvalley", "deploymentMethod":"hardlink_activator",
                    "targetPath":root,"stagingPath":staging,"instance":"test-instance", "files":[]}),
                backup: json!({"app":{"instanceId":"test-instance"},
                    "settings":{"downloads":{"path":downloads}},
                    "persistent":{"mods":{"stardewvalley":{"entry":{
                        "installationPath":"translation", "archiveId":"archive", "state":"installed",
                        "attributes":{"source":"nexus","downloadGame":"stardewvalley","modId":200,"fileId":300}}}},
                        "downloads":{"files":{"archive":{"state":"finished","game":["stardewvalley"],
                            "localPath":"unrelated-name.zip","modInfo":{"nexus":{"ids":{"gameId":"stardewvalley","modId":200,"fileId":300}}}}}}}}),
            };
            fixture.add_target(REL, BODY);
            fs::write(root.join("Example/manifest.json"), br#"{"Name":"Example","UniqueID":"Test.Example","Version":"1.0.0","UpdateKeys":["Nexus:100"]}"#).unwrap();
            fs::write(
                root.join("Example/i18n/default.json"),
                br#"{"first":"First","missing":"Missing"}"#,
            )
            .unwrap();
            fixture.archive(&[(REL, BODY)]);
            fixture.save();
            fixture
        }
        fn add_target(&mut self, rel: &str, bytes: &[u8]) {
            let staged = self.base.join("staging/translation").join(rel);
            let target = self.root.join(rel);
            fs::create_dir_all(staged.parent().unwrap()).unwrap();
            fs::create_dir_all(target.parent().unwrap()).unwrap();
            fs::write(&staged, bytes).unwrap();
            fs::hard_link(staged, target).unwrap();
            self.manifest["files"]
                .as_array_mut()
                .unwrap()
                .push(json!({"relPath":rel,"source":"translation"}));
        }
        fn archive(&mut self, entries: &[(&str, &[u8])]) {
            let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
            for (name, body) in entries {
                zip.start_file(*name, zip::write::SimpleFileOptions::default())
                    .unwrap();
                zip.write_all(body).unwrap();
            }
            let bytes = zip.finish().unwrap().into_inner();
            let digest = format!("{:x}", md5::compute(&bytes));
            let path = self.base.join("downloads/stardewvalley/unrelated-name.zip");
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, bytes).unwrap();
            self.backup["persistent"]["mods"]["stardewvalley"]["entry"]["attributes"]["fileMD5"] =
                json!(digest);
            self.backup["persistent"]["downloads"]["files"]["archive"]["fileMD5"] = json!(digest);
        }
        fn save(&self) {
            fs::write(
                self.root.join("vortex.deployment.json"),
                serde_json::to_vec(&self.manifest).unwrap(),
            )
            .unwrap();
            fs::write(
                self.vortex.join("temp/state_backups_full/hourly.json"),
                serde_json::to_vec(&self.backup).unwrap(),
            )
            .unwrap();
        }
        fn scan(&self) -> ScanResult {
            crate::scanner::scan_mods(&self.root, "de", &self.base.join("config"))
        }
        fn proofs(&self) -> Vec<InstalledNexusTranslation> {
            self.save();
            detect_at(&self.root, "de", &self.scan(), &self.vortex).unwrap_or_default()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.base).unwrap();
        }
    }

    #[test]
    fn proves_exact_file_despite_incomplete_coverage_and_arbitrary_archive_name() {
        let f = Fixture::new();
        let scan = f.scan();
        assert_eq!(scan.mods[0].disk_translated_keys, 1);
        assert_eq!(scan.mods[0].total_keys, 2);
        assert_eq!(
            f.proofs(),
            vec![InstalledNexusTranslation {
                source_nexus_id: 100,
                mod_id: 200,
                file_id: 300
            }]
        );
    }

    #[test]
    fn rejects_conflicting_or_missing_metadata() {
        for pointer in [
            "/app/instanceId",
            "/persistent/mods/stardewvalley/entry/installationPath",
            "/persistent/mods/stardewvalley/entry/archiveId",
            "/persistent/mods/stardewvalley/entry/attributes/source",
            "/persistent/mods/stardewvalley/entry/attributes/downloadGame",
            "/persistent/mods/stardewvalley/entry/attributes/fileMD5",
            "/persistent/downloads/files/archive/modInfo/nexus/ids/gameId",
            "/persistent/downloads/files/archive/modInfo/nexus/ids/modId",
            "/persistent/downloads/files/archive/modInfo/nexus/ids/fileId",
            "/persistent/downloads/files/archive/fileMD5",
            "/persistent/downloads/files/archive/state",
        ] {
            let mut f = Fixture::new();
            *f.backup.pointer_mut(pointer).unwrap() = json!("wrong");
            assert!(f.proofs().is_empty(), "{pointer}");
        }
    }

    #[test]
    fn rejects_wrong_manifest_and_deployment_collisions() {
        for pointer in [
            "/version",
            "/gameId",
            "/deploymentMethod",
            "/targetPath",
            "/stagingPath",
            "/instance",
        ] {
            let mut f = Fixture::new();
            *f.manifest.pointer_mut(pointer).unwrap() = json!("wrong");
            assert!(f.proofs().is_empty(), "{pointer}");
        }
        let mut f = Fixture::new();
        f.manifest["files"]
            .as_array_mut()
            .unwrap()
            .push(json!({"relPath":"EXAMPLE/i18n/DE.json","source":"other"}));
        assert!(f.proofs().is_empty());
    }

    #[test]
    fn rejects_copied_changed_or_missing_deployed_files() {
        let f = Fixture::new();
        fs::remove_file(f.root.join(REL)).unwrap();
        fs::write(f.root.join(REL), BODY).unwrap();
        assert!(f.proofs().is_empty());
        let f = Fixture::new();
        fs::write(f.root.join(REL), b"changed").unwrap();
        assert!(f.proofs().is_empty());
        fs::remove_file(f.root.join(REL)).unwrap();
        assert!(f.proofs().is_empty());
    }

    #[test]
    fn rejects_missing_archive_backup_and_duplicate_installation() {
        let f = Fixture::new();
        fs::remove_file(f.base.join("downloads/stardewvalley/unrelated-name.zip")).unwrap();
        assert!(f.proofs().is_empty());
        let f = Fixture::new();
        fs::remove_file(f.vortex.join("temp/state_backups_full/hourly.json")).unwrap();
        assert!(detect_at(&f.root, "de", &f.scan(), &f.vortex).is_none());
        let mut f = Fixture::new();
        f.backup["persistent"]["mods"]["stardewvalley"]["duplicate"] =
            f.backup["persistent"]["mods"]["stardewvalley"]["entry"].clone();
        assert!(f.proofs().is_empty());
    }

    #[test]
    fn rejects_unsafe_archive_paths_and_case_collisions() {
        for bad in [
            "../escape",
            "C:/escape",
            "Example/i18n/DE.json",
            "dir./de.json",
        ] {
            let mut f = Fixture::new();
            f.archive(&[(REL, BODY), (bad, BODY)]);
            assert!(f.proofs().is_empty(), "{bad}");
        }
        for bad in [
            "", "../x", "/x", "C:\\x", "x:stream", "x//y", "x/./y", "x\\..\\y", "x./y", "x /y",
        ] {
            assert!(relative(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn rejects_partial_multicomponent_proof() {
        let mut f = Fixture::new();
        f.add_target("Example/extra/i18n/de.json", BODY);
        fs::write(
            f.root.join("Example/extra/i18n/default.json"),
            br#"{"first":"First"}"#,
        )
        .unwrap();
        assert!(f.proofs().is_empty());
        f.archive(&[(REL, BODY), ("Example/extra/i18n/de.json", BODY)]);
        assert_eq!(f.proofs().len(), 1);
    }

    #[test]
    fn bounded_reads_and_newer_invalid_snapshot_fail_closed() {
        let f = Fixture::new();
        assert!(bounded(&f.root.join(REL), 2).is_none());
        let backup = f.vortex.join("temp/state_backups_full/hourly.json");
        let other = f.vortex.join("temp/state_backups_full/manual.json");
        fs::write(&other, b"{}").unwrap();
        let time = fs::metadata(&backup).unwrap().modified().unwrap();
        File::options()
            .write(true)
            .open(&other)
            .unwrap()
            .set_modified(time)
            .unwrap();
        assert!(newest_backup(&f.vortex).is_none());
        File::options()
            .write(true)
            .open(&other)
            .unwrap()
            .set_modified(time + std::time::Duration::from_secs(1))
            .unwrap();
        assert!(f.proofs().is_empty());
    }

    #[test]
    fn final_pass_rejects_changes_removal_and_replacement_after_initial_proof() {
        for action in ["change", "remove", "replace", "staging"] {
            let f = Fixture::new();
            let scan = f.scan();
            let result = detect_checked(&f.root, "de", &scan, &f.vortex, || {
                let target = f.root.join(REL);
                match action {
                    "change" => fs::write(&target, b"changed").unwrap(),
                    "remove" => fs::remove_file(&target).unwrap(),
                    "replace" => {
                        fs::remove_file(&target).unwrap();
                        fs::write(&target, BODY).unwrap();
                        let staging = f.base.join("staging/translation").join(REL);
                        fs::remove_file(&staging).unwrap();
                        fs::hard_link(&target, staging).unwrap();
                    }
                    _ => fs::remove_file(f.base.join("staging/translation").join(REL)).unwrap(),
                }
            });
            assert!(result.is_none(), "{action}");
        }
    }

    #[test]
    fn informational_language_pack_skip_preserves_proof_but_attention_invalidates_it() {
        let f = Fixture::new();
        let mut scan = f.scan();
        scan.skipped_components
            .push(crate::scanner::SkippedComponent {
                package_id: Some("LanguagePack".into()),
                component_unique_id: Some("Test.LanguagePack".into()),
                component_name: Some("Language Pack".into()),
                relative_location: "LanguagePack".into(),
                reason: "Community language pack".into(),
                requires_attention: false,
                rest_of_package_loaded: false,
            });
        assert_eq!(
            detect_at(&f.root, "de", &scan, &f.vortex).unwrap(),
            vec![InstalledNexusTranslation {
                source_nexus_id: 100,
                mod_id: 200,
                file_id: 300
            }]
        );
        scan.skipped_components[0].requires_attention = true;
        assert!(detect_at(&f.root, "de", &scan, &f.vortex).is_none());
    }

    #[test]
    fn rejects_unsafe_ids_and_ambiguous_package_fallback() {
        assert!(positive(&json!(9_007_199_254_740_992u64)).is_none());
        assert!(positive(&json!(0)).is_none());
        assert!(positive(&json!("100")).is_none());
        let f = Fixture::new();
        let mut scan = f.scan();
        let mut sibling = scan.mods[0].clone();
        sibling.i18n_files.clear();
        sibling.nexus_id = Some(101);
        scan.mods.push(sibling.clone());
        sibling.nexus_id = Some(102);
        scan.mods.push(sibling);
        scan.mods[0].nexus_id = None;
        assert!(detect_at(&f.root, "de", &scan, &f.vortex)
            .unwrap()
            .is_empty());
        scan.mods.pop();
        assert_eq!(
            detect_at(&f.root, "de", &scan, &f.vortex).unwrap()[0].source_nexus_id,
            101
        );
        scan.traversal_complete = false;
        assert!(detect_at(&f.root, "de", &scan, &f.vortex).is_none());
    }

    #[test]
    #[ignore = "Read-only local Vortex proof; requires the user's deployed fixture"]
    fn live_deployed_translation_read_only() {
        let config = crate::test_support::temp_dir("vortex-live-config");
        let root = PathBuf::from(
            std::env::var_os("SIT_VORTEX_SMOKE_MODS")
                .expect("Set SIT_VORTEX_SMOKE_MODS for the read-only fixture"),
        );
        let scan = crate::scanner::scan_mods(&root, "de", &config);
        let proofs = detect(&root, "de", &scan);
        for proof in &proofs {
            println!(
                "source={} mod={} file={}",
                proof.source_nexus_id, proof.mod_id, proof.file_id
            );
        }
        println!("proof_count={}", proofs.len());
        if config.exists() {
            fs::remove_dir_all(config).unwrap();
        }
        assert!(proofs.contains(&InstalledNexusTranslation {
            source_nexus_id: 7286,
            mod_id: 20792,
            file_id: 117404
        }));
    }
}
