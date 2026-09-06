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
// Missing-dictionary diagnosis is intentionally limited to small translation ZIPs.
const MAX_DIAGNOSTIC_ARCHIVE: u64 = 8 * 1024 * 1024;

#[derive(Serialize, Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub struct InstalledNexusTranslation {
    pub source_nexus_id: u64,
    pub mod_id: u64,
    pub file_id: u64,
    pub state: InstalledTranslationState,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum InstalledTranslationState {
    Deployed,
    MissingDictionary,
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

/// Cheap invalidation hint only. This neither reads the manifest contents nor
/// proves that a translation is installed; callers must rescan after a change.
pub(crate) fn deployment_stamp(root: &Path) -> Option<String> {
    let path = plain_path(&root.join("vortex.deployment.json"))?;
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    let modified = metadata
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?;
    Some(format!("{}:{}", modified.as_nanos(), metadata.len()))
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
struct SourceProof {
    mod_id: u64,
    file_id: u64,
    targets: HashSet<String>,
    archive_path: PathBuf,
    archive_digest: String,
}

struct Evidence {
    root: PathBuf,
    staging: PathBuf,
    download_root: PathBuf,
    manifest_path: PathBuf,
    backup_path: PathBuf,
    manifest_bytes: Vec<u8>,
    backup_bytes: Vec<u8>,
    manifest: Value,
    backup: Value,
}
impl Evidence {
    fn read(root: &Path, vortex: &Path) -> Option<Self> {
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
        let download_root =
            plain_path(Path::new(backup["settings"]["downloads"]["path"].as_str()?))?;
        let files = manifest["files"].as_array()?;
        if files.len() > 200_000 || mods.len() > MAX_ENTRIES || downloads.len() > MAX_ENTRIES {
            return None;
        }
        Some(Self {
            root,
            staging,
            download_root,
            manifest_path,
            backup_path,
            manifest_bytes,
            backup_bytes,
            manifest,
            backup,
        })
    }
    fn deployed(&self) -> Option<HashMap<String, &Value>> {
        let mut deployed = HashMap::new();
        for file in self.manifest["files"].as_array()? {
            let rel = relative(file["relPath"].as_str()?)?;
            let target = match file["target"].as_str() {
                None | Some("") => rel,
                Some(prefix) => relative(prefix)?.join(rel),
            };
            if deployed.insert(key(&target), file).is_some() {
                return None;
            }
        }
        Some(deployed)
    }
    fn unchanged(&self, vortex: &Path) -> Option<()> {
        if bounded(&self.manifest_path, MAX_JSON)? != self.manifest_bytes
            || bounded(&self.backup_path, MAX_JSON)? != self.backup_bytes
            || newest_backup(vortex)? != self.backup_path
        {
            return None;
        }
        Some(())
    }
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
    let evidence = Evidence::read(root, vortex)?;
    let root = &evidence.root;
    let staging = &evidence.staging;
    let download_root = &evidence.download_root;
    let mods = evidence.backup["persistent"]["mods"]["stardewvalley"].as_object()?;
    let downloads = evidence.backup["persistent"]["downloads"]["files"].as_object()?;
    let deployed = evidence.deployed()?;
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
            if let Ok(rel) = effective.strip_prefix(root) {
                targets.entry(key(rel)).or_default().extend(&ids);
            } else if let Some(effective) = plain_path(&effective) {
                if let Ok(rel) = effective.strip_prefix(root) {
                    targets.entry(key(rel)).or_default().extend(&ids);
                }
            } else if absent_plain_path(&effective) {
                // Missing targets cannot be canonicalized. Their existing i18n
                // parent still binds the expected destination to the scan root.
                if let Some(parent) = effective.parent().and_then(plain_path) {
                    if let Some(name) = effective.file_name() {
                        if let Ok(rel) = parent.join(name).strip_prefix(root) {
                            targets.entry(key(rel)).or_default().extend(&ids);
                        }
                    }
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
        if let Some(proof) = prove_source(
            source,
            Some(language),
            root,
            staging,
            download_root,
            mods,
            downloads,
            &deployed,
            &targets,
            &mut budget,
            &mut verified_files,
        ) {
            for target in &proof.targets {
                for source_nexus_id in targets.get(target).into_iter().flatten() {
                    result.insert(InstalledNexusTranslation {
                        source_nexus_id: *source_nexus_id,
                        mod_id: proof.mod_id,
                        file_id: proof.file_id,
                        state: InstalledTranslationState::Deployed,
                    });
                }
            }
        }
    }
    let mut problems = Vec::new();
    let candidates: BTreeSet<_> = deployed
        .iter()
        .filter(|(path, _)| path.starts_with("mods/") && path.ends_with("/manifest.json"))
        .filter_map(|(_, file)| file["source"].as_str())
        .collect();
    let mut candidates: Vec<_> = candidates
        .into_iter()
        .filter_map(|source| {
            let source_rel = relative(source)?;
            if source_rel.components().any(|part| {
                part.as_os_str()
                    .to_string_lossy()
                    .to_lowercase()
                    .ends_with(".installing")
            }) {
                return None;
            }
            let mut installed = mods
                .values()
                .filter(|entry| entry["installationPath"].as_str() == Some(source));
            let entry = installed.next()?;
            if installed.next().is_some() || entry["state"] != "installed" {
                return None;
            }
            let download = downloads.get(entry["archiveId"].as_str()?)?;
            if download["state"] != "finished" {
                return None;
            }
            let archive = relative(download["localPath"].as_str()?)?;
            if archive.components().count() != 1
                || !archive.extension()?.eq_ignore_ascii_case("zip")
            {
                return None;
            }
            let path = plain_path(&download_root.join("stardewvalley").join(archive))?;
            let size = fs::metadata(path).ok()?.len();
            (size <= MAX_DIAGNOSTIC_ARCHIVE).then_some((size, source))
        })
        .collect();
    candidates.sort_unstable();
    let mut text_budget = MAX_JSON;
    if candidates.len() <= MAX_CANDIDATES {
        for (_, source) in candidates {
            if let Some(problem) = missing_dictionary(
                source,
                language,
                scan,
                &evidence,
                &deployed,
                &targets,
                &mut budget,
                &mut text_budget,
                &mut verified_files,
            ) {
                problems.push(problem);
            }
        }
    }
    before_final_check();
    for problem in problems {
        if problem
            .snapshots
            .iter()
            .all(|(path, bytes)| bounded(path, MAX_JSON).as_ref() == Some(bytes))
            && bounded(&problem.archive_path, MAX_ARCHIVE)
                .is_some_and(|bytes| format!("{:x}", md5::compute(bytes)) == problem.archive_digest)
            && problem.missing.iter().all(|path| absent_plain_path(path))
        {
            result.extend(problem.records);
        }
    }
    // Recheck all earlier files after later sources have finished. Retained
    // handles also detect a replacement with identical bytes and new hardlinks.
    recheck_files(&verified_files)?;
    // A deployment or backup rotation during this scan invalidates the projection.
    evidence.unchanged(vortex)?;
    Some(result.into_iter().collect())
}

#[allow(clippy::too_many_arguments)]
fn prove_source(
    source: &str,
    language: Option<&str>,
    root: &Path,
    staging: &Path,
    download_root: &Path,
    mods: &serde_json::Map<String, Value>,
    downloads: &serde_json::Map<String, Value>,
    deployed: &HashMap<String, &Value>,
    targets: &HashMap<String, BTreeSet<u64>>,
    budget: &mut (u64, u64),
    verified_files: &mut Vec<VerifiedFile>,
) -> Option<SourceProof> {
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
        // Original archives include large assets that are never decompressed.
        // Keep the existing all-entry expansion cap for translation ZIP proof.
        if language.is_some() || targets.contains_key(&rel_key) {
            expanded = expanded.checked_add(file.size())?;
            budget.1 = budget.1.checked_sub(file.size())?;
        }
        if expanded > MAX_EXPANDED {
            return None;
        }
        if file.is_dir() {
            continue;
        }
        let name = rel.file_name()?.to_str()?;
        let selected = match language {
            Some(language) => {
                name.eq_ignore_ascii_case(&format!("{language}.json"))
                    || (language == "pt" && name.eq_ignore_ascii_case("pt-BR.json"))
            }
            None => targets.contains_key(&rel_key),
        };
        if !selected {
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
    if verified_targets.is_empty() || bounded(&archive_path, MAX_ARCHIVE)? != archive_bytes {
        return None;
    }
    Some(SourceProof {
        mod_id,
        file_id,
        targets: verified_targets,
        archive_path,
        archive_digest: digest,
    })
}

struct MissingDictionaryProof {
    records: Vec<InstalledNexusTranslation>,
    missing: Vec<PathBuf>,
    snapshots: Vec<(PathBuf, Vec<u8>)>,
    archive_path: PathBuf,
    archive_digest: String,
}

// NotFound alone is insufficient: a missing leaf may sit below a reparse point.
fn absent_plain_path(path: &Path) -> bool {
    if !path.is_absolute() {
        return false;
    }
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        _ => return false,
    }
    for ancestor in path.ancestors().skip(1) {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) => return metadata.is_dir() && plain_path(ancestor).is_some(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            _ => return false,
        }
    }
    false
}

#[allow(clippy::too_many_arguments)]
fn missing_dictionary(
    source: &str,
    language: &str,
    scan: &ScanResult,
    evidence: &Evidence,
    deployed: &HashMap<String, &Value>,
    targets: &HashMap<String, BTreeSet<u64>>,
    budget: &mut (u64, u64),
    text_budget: &mut u64,
    verified_files: &mut Vec<VerifiedFile>,
) -> Option<MissingDictionaryProof> {
    let source_rel = relative(source)?;
    // Prove every deployed file from this source, not merely a checker name.
    let anchors: HashMap<_, _> = deployed
        .iter()
        .filter(|(_, record)| record["source"].as_str() == Some(source))
        .map(|(path, _)| (path.clone(), BTreeSet::new()))
        .collect();
    let proof = prove_source(
        source,
        None,
        &evidence.root,
        &evidence.staging,
        &evidence.download_root,
        evidence.backup["persistent"]["mods"]["stardewvalley"].as_object()?,
        evidence.backup["persistent"]["downloads"]["files"].as_object()?,
        deployed,
        &anchors,
        budget,
        verified_files,
    )?;
    if anchors.len() != proof.targets.len() {
        return None;
    }
    // Reserve the inspection and final archive recheck in the shared scan budget.
    budget.0 = budget.0.checked_sub(
        fs::metadata(&proof.archive_path)
            .ok()?
            .len()
            .checked_mul(2)?,
    )?;
    let bytes = bounded(&proof.archive_path, MAX_ARCHIVE)?;
    if format!("{:x}", md5::compute(&bytes)) != proof.archive_digest {
        return None;
    }
    let mut archive = zip::ZipArchive::new(Cursor::new(&bytes)).ok()?;
    let mut source_ids = BTreeSet::new();
    let mut missing = Vec::new();
    let mut snapshots = Vec::new();
    let mut checked_components = HashSet::new();
    let mut checker = false;
    for index in 0..archive.len() {
        let mut file = archive.by_index(index).ok()?;
        budget.1 = budget.1.checked_sub(file.size())?;
        if file.is_dir() {
            continue;
        }
        let rel = relative(file.name())?;
        let rel_key = key(&rel);
        if rel_key.starts_with("mods/")
            && rel_key.ends_with("/manifest.json")
            && anchors.contains_key(&rel_key)
        {
            let manifest = bounded(&evidence.root.join(&rel), MAX_JSON)?;
            *text_budget = text_budget.checked_sub(manifest.len() as u64)?;
            let value =
                crate::scanner::parse_json_lenient(std::str::from_utf8(&manifest).ok()?).ok()?;
            let keys: Vec<_> = value["UpdateKeys"]
                .as_array()?
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect();
            checker |= crate::scanner::extract_nexus_id(&keys) == Some(proof.mod_id);
        }
        let name = rel.file_name()?.to_str()?;
        if !(name.eq_ignore_ascii_case(&format!("{language}.json"))
            || language == "pt" && name.eq_ignore_ascii_case("pt-BR.json"))
        {
            continue;
        }
        // One literal Mods/ wrapper is the only supported installer layout here.
        // Match the entire scanned destination, never a basename or package title.
        let stripped = rel_key.strip_prefix("mods/")?;
        let ids = targets.get(stripped)?;
        if ids.len() != 1
            || ids.contains(&proof.mod_id)
            || deployed.contains_key(stripped)
            || deployed.contains_key(&rel_key)
        {
            return None;
        }
        let mut components = scan.mods.iter().enumerate().filter(|(_, component)| {
            component.i18n_files.iter().any(|file| {
                let path = Path::new(&file.default_path);
                plain_path(path)
                    .and_then(|path| path.parent().map(|parent| parent.join(name)))
                    .and_then(|path| path.strip_prefix(&evidence.root).ok().map(key))
                    .is_some_and(|path| path == stripped)
            })
        });
        let (index, component) = components.next()?;
        if components.next().is_some() || component.nexus_id != ids.first().copied() {
            return None;
        }
        if checked_components.insert(index) {
            snapshots.extend(component_snapshots(component, text_budget)?);
        }
        let stripped_rel = relative(stripped)?;
        let mut paths = vec![
            evidence.root.join(&stripped_rel),
            evidence.root.join(&rel),
            evidence.staging.join(&source_rel).join(&rel),
            evidence.staging.join(&source_rel).join(&stripped_rel),
        ];
        if language == "pt" {
            for path in paths.clone() {
                paths.push(path.with_file_name("pt.json"));
                paths.push(path.with_file_name("pt-BR.json"));
            }
        }
        if !paths.iter().all(|path| absent_plain_path(path)) {
            return None;
        }
        let mut dictionary = Vec::new();
        (&mut file)
            .take(MAX_JSON + 1)
            .read_to_end(&mut dictionary)
            .ok()?;
        if dictionary.len() as u64 > MAX_JSON || dictionary.len() as u64 != file.size() {
            return None;
        }
        crate::scanner::parse_flat_object(std::str::from_utf8(&dictionary).ok()?, &rel).ok()?;
        source_ids.extend(ids);
        missing.extend(paths);
    }
    if !checker || source_ids.is_empty() {
        return None;
    }
    Some(MissingDictionaryProof {
        records: source_ids
            .into_iter()
            .map(|source_nexus_id| InstalledNexusTranslation {
                source_nexus_id,
                mod_id: proof.mod_id,
                file_id: proof.file_id,
                state: InstalledTranslationState::MissingDictionary,
            })
            .collect(),
        missing,
        snapshots,
        archive_path: proof.archive_path,
        archive_digest: proof.archive_digest,
    })
}

fn recheck_files(verified_files: &[VerifiedFile]) -> Option<()> {
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
    Some(())
}

pub(crate) fn resolve_original_ids(root: &Path, scan: &mut ScanResult) {
    let Some(appdata) = std::env::var_os("APPDATA") else {
        return;
    };
    if let Some(ids) =
        original_ids_checked(root, scan, &PathBuf::from(appdata).join("Vortex"), || {})
    {
        for (index, id) in ids {
            if scan.mods[index].nexus_id.is_none() {
                scan.mods[index].nexus_id = Some(id);
                scan.mods[index].nexus_id_source = Some("vortex");
            }
        }
    }
}

struct OriginalCandidate {
    index: usize,
    source: String,
    paths: HashSet<String>,
    snapshots: Vec<(PathBuf, Vec<u8>)>,
}

fn original_candidate(
    index: usize,
    component: &crate::scanner::ScannedMod,
    evidence: &Evidence,
    deployed: &HashMap<String, &Value>,
    text_budget: &mut u64,
) -> Option<OriginalCandidate> {
    let snapshots = component_snapshots(component, text_budget)?;
    let mut paths = HashSet::new();
    let mut sources = BTreeSet::new();
    for (path, _) in &snapshots {
        let rel = key(path.strip_prefix(&evidence.root).ok()?);
        sources.insert(deployed.get(&rel)?["source"].as_str()?.to_owned());
        if !paths.insert(rel) {
            return None;
        }
    }
    if sources.len() != 1 {
        return None;
    }
    Some(OriginalCandidate {
        index,
        source: sources.into_iter().next()?,
        paths,
        snapshots,
    })
}

fn component_snapshots(
    component: &crate::scanner::ScannedMod,
    text_budget: &mut u64,
) -> Option<Vec<(PathBuf, Vec<u8>)>> {
    let manifest_path = plain_path(&Path::new(&component.folder_path).join("manifest.json"))?;
    let manifest_bytes = bounded(&manifest_path, MAX_JSON)?;
    *text_budget = text_budget.checked_sub(manifest_bytes.len() as u64)?;
    let manifest =
        crate::scanner::parse_json_lenient(std::str::from_utf8(&manifest_bytes).ok()?).ok()?;
    if manifest["UniqueID"].as_str()? != component.unique_id
        || manifest["Version"].as_str().unwrap_or_default() != component.version
    {
        return None;
    }
    let update_keys: Vec<_> = manifest["UpdateKeys"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect();
    if crate::scanner::extract_nexus_id(&update_keys) != component.nexus_id {
        return None;
    }
    let mut snapshots = vec![(manifest_path, manifest_bytes)];
    for file in &component.i18n_files {
        let path = plain_path(Path::new(&file.default_path))?;
        let bytes = bounded(&path, MAX_JSON)?;
        *text_budget = text_budget.checked_sub(bytes.len() as u64)?;
        let source =
            crate::scanner::parse_flat_object(std::str::from_utf8(&bytes).ok()?, &path).ok()?;
        // Bind the proof to the source inventory actually shown by this scan.
        if source
            .keys()
            .filter(|key| key.as_str() != "$schema")
            .count()
            != file.source_hashes.len()
            || file.source_hashes.iter().any(|entry| {
                source
                    .get(&entry.key)
                    .and_then(Value::as_str)
                    .is_none_or(|text| crate::translations::source_hash(text) != entry.source_hash)
            })
        {
            return None;
        }
        snapshots.push((path, bytes));
    }
    if snapshots.len() < 2 {
        return None;
    }
    Some(snapshots)
}

fn original_ids_checked(
    root: &Path,
    scan: &ScanResult,
    vortex: &Path,
    before_final_check: impl FnOnce(),
) -> Option<Vec<(usize, u64)>> {
    if !scan.traversal_complete
        || scan
            .skipped_components
            .iter()
            .any(|item| item.requires_attention)
    {
        return None;
    }
    let identified_packages: HashSet<_> = scan
        .mods
        .iter()
        .filter(|component| component.nexus_id.is_some())
        .map(|component| component.package_id.as_str())
        .collect();
    if scan
        .mods
        .iter()
        .all(|component| identified_packages.contains(component.package_id.as_str()))
    {
        return Some(Vec::new());
    }
    let evidence = Evidence::read(root, vortex)?;
    let deployed = evidence.deployed()?;
    let mut candidates = Vec::new();
    let mut grouped: std::collections::BTreeMap<String, HashMap<String, BTreeSet<u64>>> =
        std::collections::BTreeMap::new();
    let mut owners = HashSet::new();
    let mut text_budget = MAX_EXPANDED;
    for (index, component) in scan.mods.iter().enumerate().filter(|(_, component)| {
        component.nexus_id.is_none() && !identified_packages.contains(component.package_id.as_str())
    }) {
        let Some(candidate) =
            original_candidate(index, component, &evidence, &deployed, &mut text_budget)
        else {
            continue;
        };
        for path in &candidate.paths {
            if !owners.insert(path.clone()) {
                return None;
            }
            grouped
                .entry(candidate.source.clone())
                .or_default()
                .insert(path.clone(), BTreeSet::new());
        }
        candidates.push(candidate);
    }
    if grouped.len() > MAX_CANDIDATES {
        return None;
    }
    // Independent from translation ZIP limits: originals contain large assets,
    // but only selected manifests/default dictionaries are decompressed.
    let mut budget = (384 * 1024 * 1024u64, MAX_EXPANDED);
    let mut verified_files = Vec::new();
    let mut proofs = HashMap::new();
    for (source, targets) in &grouped {
        if let Some(proof) = prove_source(
            source,
            None,
            &evidence.root,
            &evidence.staging,
            &evidence.download_root,
            evidence.backup["persistent"]["mods"]["stardewvalley"].as_object()?,
            evidence.backup["persistent"]["downloads"]["files"].as_object()?,
            &deployed,
            targets,
            &mut budget,
            &mut verified_files,
        ) {
            proofs.insert(source, proof);
        }
    }
    let mut result = Vec::new();
    for candidate in candidates {
        let Some(proof) = proofs.get(&candidate.source) else {
            continue;
        };
        if candidate.paths.is_subset(&proof.targets)
            && candidate
                .snapshots
                .iter()
                .all(|(path, bytes)| bounded(path, MAX_JSON).as_ref() == Some(bytes))
        {
            result.push((candidate.index, proof.mod_id));
        }
    }
    let mut package_ids: HashMap<&str, BTreeSet<u64>> = HashMap::new();
    for component in &scan.mods {
        if let Some(id) = component.nexus_id {
            package_ids
                .entry(&component.package_id)
                .or_default()
                .insert(id);
        }
    }
    for (index, id) in &result {
        package_ids
            .entry(&scan.mods[*index].package_id)
            .or_default()
            .insert(*id);
    }
    result.retain(|(index, _)| package_ids[scan.mods[*index].package_id.as_str()].len() == 1);
    before_final_check();
    recheck_files(&verified_files)?;
    evidence.unchanged(vortex)?;
    Some(result)
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
        fn add_original(&mut self, folder: &str, id: u64) {
            let source_name = format!("original-{folder}");
            let manifest = serde_json::to_vec(&json!({"Name":folder,"UniqueID":format!("Test.{folder}"),"Version":"1.0","UpdateKeys":["Nexus:???"]})).unwrap();
            let source = br#"{"first":"First"}"#;
            let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
            for (rel, content) in [
                (format!("{folder}/manifest.json"), manifest.as_slice()),
                (format!("{folder}/i18n/default.json"), source.as_slice()),
            ] {
                let staged = self.base.join("staging").join(&source_name).join(&rel);
                let target = self.root.join(&rel);
                fs::create_dir_all(staged.parent().unwrap()).unwrap();
                fs::create_dir_all(target.parent().unwrap()).unwrap();
                fs::write(&staged, content).unwrap();
                fs::hard_link(staged, target).unwrap();
                self.manifest["files"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({"relPath":rel,"source":source_name}));
                zip.start_file(&rel, zip::write::SimpleFileOptions::default())
                    .unwrap();
                zip.write_all(content).unwrap();
            }
            let bytes = zip.finish().unwrap().into_inner();
            let hash = format!("{:x}", md5::compute(&bytes));
            fs::write(
                self.base
                    .join("downloads/stardewvalley")
                    .join(format!("{}.zip", folder.replace('/', "-"))),
                bytes,
            )
            .unwrap();
            let mut entry = self.backup["persistent"]["mods"]["stardewvalley"]["entry"].clone();
            entry["installationPath"] = json!(source_name);
            entry["archiveId"] = json!(source_name);
            entry["attributes"]["modId"] = json!(id);
            entry["attributes"]["fileMD5"] = json!(hash);
            self.backup["persistent"]["mods"]["stardewvalley"][&source_name] = entry;
            let mut download = self.backup["persistent"]["downloads"]["files"]["archive"].clone();
            download["modInfo"]["nexus"]["ids"]["modId"] = json!(id);
            download["fileMD5"] = json!(hash);
            download["localPath"] = json!(format!("{}.zip", folder.replace('/', "-")));
            self.backup["persistent"]["downloads"]["files"][&source_name] = download;
            self.save();
        }
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
    fn deployment_stamp_tracks_metadata_without_reading_manifest_contents() {
        let root = crate::test_support::temp_dir("vortex-stamp");
        fs::create_dir_all(&root).unwrap();
        let path = root.join("vortex.deployment.json");
        assert_eq!(deployment_stamp(&root), None);
        fs::write(&path, b"not JSON").unwrap();
        let first_time = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1000);
        let set_time = |time| {
            File::options()
                .write(true)
                .open(&path)
                .unwrap()
                .set_times(fs::FileTimes::new().set_modified(time))
                .unwrap();
        };
        set_time(first_time);
        let first = deployment_stamp(&root).unwrap();
        assert_eq!(deployment_stamp(&root).as_ref(), Some(&first));
        fs::write(&path, b"still not JSON").unwrap();
        set_time(first_time);
        let resized = deployment_stamp(&root).unwrap();
        assert_ne!(first, resized);
        set_time(first_time + std::time::Duration::from_secs(1));
        assert_ne!(deployment_stamp(&root).unwrap(), resized);
        fs::remove_file(&path).unwrap();
        assert_eq!(deployment_stamp(&root), None);
        fs::create_dir(&path).unwrap();
        assert_eq!(deployment_stamp(&root), None);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn original_packages_are_proved_without_using_translation_overlay_ids() {
        let mut f = Fixture::new();
        f.add_original("One", 11);
        f.add_original("Two", 22);
        f.add_target("One/i18n/de.json", BODY);
        f.save();
        let scan = f.scan();
        let ids = original_ids_checked(&f.root, &scan, &f.vortex, || {}).unwrap();
        let actual: BTreeSet<_> = ids
            .iter()
            .map(|(index, id)| (scan.mods[*index].unique_id.as_str(), *id))
            .collect();
        assert_eq!(actual, BTreeSet::from([("Test.One", 11), ("Test.Two", 22)]));
        let explicit = scan
            .mods
            .iter()
            .find(|item| item.unique_id == "Test.Example")
            .unwrap();
        assert_eq!(explicit.nexus_id, Some(100));
        assert_eq!(explicit.nexus_id_source, Some("manifest"));
        assert!(!ids.iter().any(|(_, id)| *id == 200));
    }

    #[test]
    fn original_proof_rejects_overlay_source_conflicts_missing_and_ambiguous_evidence() {
        for failure in ["overlay", "missing", "duplicate", "copied", "id-mismatch"] {
            let mut f = Fixture::new();
            f.add_original("One", 11);
            match failure {
                "overlay" => {
                    for record in f.manifest["files"].as_array_mut().unwrap() {
                        if record["relPath"] == "One/i18n/default.json" {
                            record["source"] = json!("translation");
                        }
                    }
                }
                "missing" => {
                    fs::remove_file(f.base.join("downloads/stardewvalley/One.zip")).unwrap()
                }
                "duplicate" => {
                    f.backup["persistent"]["mods"]["stardewvalley"]["duplicate"] =
                        f.backup["persistent"]["mods"]["stardewvalley"]["original-One"].clone()
                }
                "copied" => {
                    let path = f.root.join("One/manifest.json");
                    let bytes = fs::read(&path).unwrap();
                    fs::remove_file(&path).unwrap();
                    fs::write(path, bytes).unwrap();
                }
                _ => {
                    f.backup["persistent"]["downloads"]["files"]["original-One"]["modInfo"]
                        ["nexus"]["ids"]["modId"] = json!(99)
                }
            }
            f.save();
            assert!(
                original_ids_checked(&f.root, &f.scan(), &f.vortex, || {})
                    .unwrap_or_default()
                    .is_empty(),
                "{failure}"
            );
        }
    }

    #[test]
    fn original_ids_do_not_introduce_conflicting_package_ids() {
        let mut f = Fixture::new();
        f.add_original("One", 11);
        f.add_original("One/Child", 22);
        let mut scan = f.scan();
        assert!(original_ids_checked(&f.root, &scan, &f.vortex, || {})
            .unwrap()
            .is_empty());
        let owner = scan
            .mods
            .iter_mut()
            .find(|component| component.unique_id == "Test.One")
            .unwrap();
        owner.nexus_id = Some(99);
        owner.nexus_id_source = Some("manifest");
        assert!(original_ids_checked(&f.root, &scan, &f.vortex, || {})
            .unwrap()
            .is_empty());
        assert_eq!(
            scan.mods
                .iter()
                .find(|component| component.unique_id == "Test.One")
                .unwrap()
                .nexus_id,
            Some(99)
        );
    }

    #[test]
    fn original_proof_binds_scan_inventory_and_rechecks_deployment_at_the_end() {
        let mut f = Fixture::new();
        f.add_original("One", 11);
        let scan = f.scan();
        let result = original_ids_checked(&f.root, &scan, &f.vortex, || {
            fs::write(
                f.root.join("One/i18n/default.json"),
                br#"{"first":"Updated"}"#,
            )
            .unwrap();
        });
        assert!(result.is_none());
        assert!(original_ids_checked(&f.root, &scan, &f.vortex, || {})
            .unwrap()
            .is_empty());
        for change in ["copy", "backup"] {
            let mut f = Fixture::new();
            f.add_original("One", 11);
            let scan = f.scan();
            assert!(
                original_ids_checked(&f.root, &scan, &f.vortex, || {
                    if change == "copy" {
                        let path = f.root.join("One/manifest.json");
                        let bytes = fs::read(&path).unwrap();
                        fs::remove_file(&path).unwrap();
                        fs::write(path, bytes).unwrap();
                    } else {
                        fs::write(f.vortex.join("temp/state_backups_full/hourly.json"), b"{}")
                            .unwrap();
                    }
                })
                .is_none(),
                "{change}"
            );
        }
    }

    #[test]
    #[ignore = "Read-only original-ID proof using real Mods and a fresh temporary scan config"]
    fn live_original_ids_read_only() {
        let root = PathBuf::from(
            std::env::var_os("SIT_VORTEX_SMOKE_MODS").expect("Set SIT_VORTEX_SMOKE_MODS"),
        );
        let config = crate::test_support::temp_dir("vortex-original-live");
        let mut scan = crate::scanner::scan_mods(&root, "de", &config);
        let started = std::time::Instant::now();
        resolve_original_ids(&root, &mut scan);
        println!("original_resolution_ms={}", started.elapsed().as_millis());
        for component in scan
            .mods
            .iter()
            .filter(|component| component.nexus_id_source == Some("vortex"))
        {
            println!(
                "component={} original_id={}",
                component.unique_id,
                component.nexus_id.unwrap()
            );
        }
        for (unique, id) in [
            ("Lemurkat.EastScarp", 5787),
            ("FlashShifter.StardewValleyExpandedCP", 3753),
        ] {
            assert!(scan
                .mods
                .iter()
                .any(|component| component.unique_id == unique
                    && component.nexus_id == Some(id)
                    && component.nexus_id_source == Some("vortex")));
        }
        if config.exists() {
            fs::remove_dir_all(config).unwrap();
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
                file_id: 300,
                state: InstalledTranslationState::Deployed,
            }]
        );
    }

    const CHECKER: &str = "Mods/TranslationChecker/manifest.json";
    const CHECKER_BODY: &[u8] = br#"{"Name":"Checker","UniqueID":"Test.Checker","Version":"1.0","UpdateKeys":["Nexus:200"]}"#;
    const OMITTED: &str = "Mods/Example/i18n/de.json";

    fn missing_dictionary_fixture() -> Fixture {
        let mut f = Fixture::new();
        fs::remove_file(f.root.join(REL)).unwrap();
        fs::remove_file(f.base.join("staging/translation").join(REL)).unwrap();
        f.manifest["files"] = json!([]);
        f.add_target(CHECKER, CHECKER_BODY);
        f.add_target("Mods/TranslationChecker/content.json", b"{}");
        f.archive(&[
            (OMITTED, BODY),
            (CHECKER, CHECKER_BODY),
            ("Mods/TranslationChecker/content.json", b"{}"),
        ]);
        f.save();
        f
    }

    #[test]
    fn missing_dictionary_proves_exact_file_without_claiming_text_coverage() {
        let f = missing_dictionary_fixture();
        let scan = f.scan();
        let original = scan
            .mods
            .iter()
            .find(|m| m.unique_id == "Test.Example")
            .unwrap();
        assert_eq!(original.disk_translated_keys, 0);
        assert_eq!(
            f.proofs(),
            vec![InstalledNexusTranslation {
                source_nexus_id: 100,
                mod_id: 200,
                file_id: 300,
                state: InstalledTranslationState::MissingDictionary,
            }]
        );
        assert_eq!(
            serde_json::to_value(f.proofs()).unwrap()[0]["state"],
            "missing_dictionary"
        );
    }

    #[test]
    fn missing_dictionary_rejects_present_staging_target_or_ambiguous_siblings() {
        for location in ["target", "wrapper_target", "staging", "wrapper_staging"] {
            let f = missing_dictionary_fixture();
            let path = match location {
                "target" => f.root.join(REL),
                "wrapper_target" => f.root.join(OMITTED),
                "staging" => f.base.join("staging/translation").join(REL),
                _ => f.base.join("staging/translation").join(OMITTED),
            };
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, BODY).unwrap();
            assert!(f.proofs().is_empty(), "{location}");
        }
        for extra in [
            "Mods/Unknown/i18n/de.json",
            "Other/Example/i18n/de.json",
            "Mods/Example/i18n/DE.json",
        ] {
            let mut f = missing_dictionary_fixture();
            f.archive(&[
                (OMITTED, BODY),
                (extra, BODY),
                (CHECKER, CHECKER_BODY),
                ("Mods/TranslationChecker/content.json", b"{}"),
            ]);
            assert!(f.proofs().is_empty(), "{extra}");
        }
    }

    #[test]
    fn missing_dictionary_rejects_uncertain_metadata_context_and_checker() {
        for change in [
            "id",
            "archive",
            "copied",
            "changed",
            "original",
            "source",
            "language",
            "incomplete",
            "foreign",
        ] {
            let mut f = missing_dictionary_fixture();
            let mut scan = f.scan();
            match change {
                "id" => {
                    f.backup["persistent"]["downloads"]["files"]["archive"]["modInfo"]["nexus"]
                        ["ids"]["fileId"] = json!(999)
                }
                "archive" => fs::write(
                    f.base.join("downloads/stardewvalley/unrelated-name.zip"),
                    b"changed",
                )
                .unwrap(),
                "copied" => {
                    fs::remove_file(f.root.join(CHECKER)).unwrap();
                    fs::write(f.root.join(CHECKER), CHECKER_BODY).unwrap();
                }
                "changed" => fs::write(f.root.join(CHECKER), b"{}").unwrap(),
                "original" => fs::write(f.root.join("Example/manifest.json"), b"{}").unwrap(),
                "source" => fs::write(
                    f.root.join("Example/i18n/default.json"),
                    br#"{"first":"Changed"}"#,
                )
                .unwrap(),
                "incomplete" => scan.traversal_complete = false,
                "foreign" => f.manifest["files"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({"relPath":REL,"source":"other"})),
                _ => {}
            }
            f.save();
            let result = detect_at(
                &f.root,
                if change == "language" { "fr" } else { "de" },
                &scan,
                &f.vortex,
            )
            .unwrap_or_default();
            assert!(result.is_empty(), "{change}");
        }
    }

    #[test]
    fn missing_dictionary_rechecks_absence_archive_and_original_after_proof() {
        for change in [
            "target", "staging", "checker", "archive", "default", "manifest", "backup",
        ] {
            let f = missing_dictionary_fixture();
            let scan = f.scan();
            let result = detect_checked(&f.root, "de", &scan, &f.vortex, || {
                let path = match change {
                    "target" => f.root.join(REL),
                    "staging" => f.base.join("staging/translation").join(OMITTED),
                    "checker" => f.root.join(CHECKER),
                    "archive" => f.base.join("downloads/stardewvalley/unrelated-name.zip"),
                    "default" => f.root.join("Example/i18n/default.json"),
                    "manifest" => f.root.join("vortex.deployment.json"),
                    _ => f.vortex.join("temp/state_backups_full/hourly.json"),
                };
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                fs::write(path, b"changed").unwrap();
            })
            .unwrap_or_default();
            assert!(result.is_empty(), "{change}");
        }
    }

    #[test]
    fn missing_dictionary_respects_portuguese_fallback_and_size_budget() {
        for location in ["none", "target", "staging"] {
            let mut f = missing_dictionary_fixture();
            f.archive(&[
                ("Mods/Example/i18n/pt.json", BODY),
                (CHECKER, CHECKER_BODY),
                ("Mods/TranslationChecker/content.json", b"{}"),
            ]);
            if location != "none" {
                let path = if location == "target" {
                    f.root.join("Example/i18n/pt-BR.json")
                } else {
                    f.base
                        .join("staging/translation/Mods/Example/i18n/pt-BR.json")
                };
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                fs::write(path, BODY).unwrap();
            }
            f.save();
            let scan = crate::scanner::scan_mods(&f.root, "pt", &f.base.join("config"));
            let proofs = detect_at(&f.root, "pt", &scan, &f.vortex).unwrap();
            assert_eq!(proofs.len(), usize::from(location == "none"), "{location}");
        }
        let mut f = missing_dictionary_fixture();
        // An unrelated huge original ZIP is pruned before reads or budget reservation.
        let large = f.base.join("downloads/stardewvalley/large.zip");
        File::create(&large)
            .unwrap()
            .set_len(MAX_DIAGNOSTIC_ARCHIVE + 1)
            .unwrap();
        let mut entry = f.backup["persistent"]["mods"]["stardewvalley"]["entry"].clone();
        entry["installationPath"] = json!("aaa-large");
        entry["archiveId"] = json!("large");
        f.backup["persistent"]["mods"]["stardewvalley"]["large"] = entry;
        let mut download = f.backup["persistent"]["downloads"]["files"]["archive"].clone();
        download["localPath"] = json!("large.zip");
        f.backup["persistent"]["downloads"]["files"]["large"] = download;
        f.manifest["files"]
            .as_array_mut()
            .unwrap()
            .push(json!({"relPath":"Mods/Large/manifest.json","source":"aaa-large"}));
        assert_eq!(f.proofs().len(), 1);
        File::options()
            .write(true)
            .open(f.base.join("downloads/stardewvalley/unrelated-name.zip"))
            .unwrap()
            .set_len(MAX_DIAGNOSTIC_ARCHIVE + 1)
            .unwrap();
        assert!(f.proofs().is_empty());
    }

    #[test]
    fn missing_dictionary_absence_requires_real_not_found_and_plain_ancestors() {
        let f = missing_dictionary_fixture();
        assert!(absent_plain_path(&f.root.join("missing/i18n/de.json")));
        assert!(!absent_plain_path(Path::new("relative/de.json")));
        assert!(!absent_plain_path(&f.root.join(CHECKER)));
        assert!(!absent_plain_path(&f.root));
        assert!(!absent_plain_path(&f.root.join(CHECKER).join("de.json")));
        #[cfg(windows)]
        {
            let link = f.root.join("linked");
            let linked = std::os::windows::fs::symlink_dir(f.base.join("staging"), &link);
            match linked {
                Ok(()) => {
                    assert!(!absent_plain_path(&link.join("missing/i18n/de.json")));
                    fs::remove_dir(link).unwrap();
                }
                Err(error) => assert_eq!(error.raw_os_error(), Some(1314)),
            }
        }
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
                file_id: 300,
                state: InstalledTranslationState::Deployed,
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
            let components: Vec<_> = scan
                .mods
                .iter()
                .filter(|component| component.nexus_id == Some(proof.source_nexus_id))
                .collect();
            println!(
                "source={} mod={} file={} state={:?} disk_translated={} total={} empty_sources={}",
                proof.source_nexus_id,
                proof.mod_id,
                proof.file_id,
                proof.state,
                components
                    .iter()
                    .map(|component| component.disk_translated_keys)
                    .sum::<usize>(),
                components
                    .iter()
                    .map(|component| component.total_keys)
                    .sum::<usize>(),
                components
                    .iter()
                    .map(|component| component.disk_no_translation_needed_keys)
                    .sum::<usize>(),
            );
        }
        println!("proof_count={}", proofs.len());
        if config.exists() {
            fs::remove_dir_all(config).unwrap();
        }
        assert!(proofs.contains(&InstalledNexusTranslation {
            source_nexus_id: 7286,
            mod_id: 20792,
            file_id: 117404,
            state: InstalledTranslationState::Deployed,
        }));
    }
}
