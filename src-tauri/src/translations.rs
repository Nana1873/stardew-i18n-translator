//! Persisted translation state (SPEC §14).
//!
//! Work-in-progress translations are stored **separately** from the mod's own
//! files: one JSON per mod (keyed by UniqueID) and target language in the
//! portable `data/` folder. The mod's `default.json` is never touched; export
//! writes the final `i18n/<lang>.json`. Each entry records the target text,
//! its status, and a hash of the source text at save time (for `outdated`
//! detection on re-scan).
//!
//! Safety rules (this file holds the user's only copy of their work):
//!  - Writes are **serialized** by a process-wide lock — concurrent bulk saves
//!    must never interleave their load-modify-write cycles (lost updates).
//!  - Writes are **atomic**: serialize → verify → `.tmp` sibling → rename.
//!  - The first overwrite of an existing state file per session copies it to
//!    `<file>.bak` first.
//!  - A corrupted state file is a **loud error**, never silently treated as
//!    empty — and it is never overwritten by a subsequent save.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoredString {
    pub target: String,
    pub status: String,
    /// SHA-256 of the source text when this entry was last saved.
    pub source_hash: String,
}

/// Stored status used when the translator explicitly accepts a protected-token
/// mismatch. The scanner exposes it as the normal `translated` status while
/// retaining the export waiver for the exact saved source text.
pub const TOKEN_MISMATCH_ACCEPTED_STATUS: &str = "translated-token-mismatch-accepted";

/// Stored status used when an unreviewed Local-AI suggestion has an explicitly
/// accepted protected-token mismatch. It remains `review-needed` in the UI;
/// the separate storage value preserves the waiver across reloads without
/// promoting AI output to a confirmed translation.
pub const REVIEW_NEEDED_TOKEN_MISMATCH_ACCEPTED_STATUS: &str =
    "review-needed-token-mismatch-accepted";

/// Per-mod state: entry key -> stored translation.
pub type ModState = HashMap<String, StoredString>;

/// SHA-256 hex of a source string (for outdated detection).
pub fn source_hash(text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// Composite key for a string within a mod: `<relativeDir>\0<key>`.
pub fn entry_key(relative_dir: &str, key: &str) -> String {
    format!("{relative_dir}\u{0}{key}")
}

/// Return the isolated state root for one target language. A pre-v1.1
/// `data/translations/` folder is moved once into the first active language,
/// which is the language stored in settings when upgrading.
pub fn language_root(config_dir: &Path, target_lang: &str) -> Result<PathBuf, String> {
    let safe_lang = crate::language::normalize_target_code(target_lang)?;
    let root = config_dir.join("language-state").join(safe_lang);
    let legacy = config_dir.join("translations");
    let destination = root.join("translations");
    if legacy.is_dir() && !destination.exists() {
        std::fs::create_dir_all(&root).map_err(|error| {
            format!(
                "Could not prepare language-specific translation state {}: {error}",
                root.display()
            )
        })?;
        std::fs::rename(&legacy, &destination).map_err(|error| {
            format!(
                "Could not migrate translation state from {} to {}: {error}",
                legacy.display(),
                destination.display()
            )
        })?;
    }
    Ok(root)
}

#[derive(Default)]
struct WriteSession {
    backed_up: HashSet<PathBuf>,
    revisions: HashMap<PathBuf, u64>,
    entry_revisions: HashMap<(PathBuf, String), u64>,
}

impl WriteSession {
    fn record_mutation(&mut self, path: &Path, touched_keys: &[String]) {
        let revision = self.revisions.entry(path.to_path_buf()).or_default();
        *revision = revision.wrapping_add(1).max(1);
        for key in touched_keys {
            let revision = self
                .entry_revisions
                .entry((path.to_path_buf(), key.clone()))
                .or_default();
            *revision = revision.wrapping_add(1).max(1);
        }
    }

    fn revision(&self, path: &Path) -> u64 {
        self.revisions.get(path).copied().unwrap_or_default()
    }

    fn entry_revision(&self, path: &Path, key: &str) -> u64 {
        self.entry_revisions
            .get(&(path.to_path_buf(), key.to_string()))
            .copied()
            .unwrap_or_default()
    }
}

/// Process-wide write guard: serializes every load-modify-write cycle,
/// remembers backups, and advances each component's in-session revision after
/// every successful state mutation so stale undo cannot revive after an edit.
fn write_guard() -> &'static Mutex<WriteSession> {
    static GUARD: OnceLock<Mutex<WriteSession>> = OnceLock::new();
    GUARD.get_or_init(|| Mutex::new(WriteSession::default()))
}

fn state_path(config_dir: &Path, unique_id: &str) -> PathBuf {
    if is_safe_windows_stem(unique_id) {
        return config_dir
            .join("translations")
            .join(format!("{unique_id}.json"));
    }
    let mut hasher = Sha256::new();
    hasher.update(unique_id.as_bytes());
    config_dir
        .join("translations")
        .join(format!("state-{:x}.json", hasher.finalize()))
}

fn legacy_state_path(config_dir: &Path, unique_id: &str) -> PathBuf {
    let safe: String = unique_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect();
    config_dir.join("translations").join(format!("{safe}.json"))
}

fn is_safe_windows_stem(value: &str) -> bool {
    if value.is_empty()
        || value.len() > 240
        || value.ends_with([' ', '.'])
        || !value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
    {
        return false;
    }
    let base = value
        .split('.')
        .next()
        .unwrap_or(value)
        .to_ascii_uppercase();
    !matches!(
        base.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    )
}

pub fn prepare_state_paths(
    config_dir: &Path,
    unique_ids: &[String],
) -> (HashSet<String>, Vec<String>) {
    let mut blocked = HashSet::new();
    let mut warnings = Vec::new();
    let mut by_id: std::collections::BTreeMap<String, Vec<&String>> =
        std::collections::BTreeMap::new();
    let mut by_legacy: std::collections::BTreeMap<String, Vec<&String>> =
        std::collections::BTreeMap::new();
    for id in unique_ids {
        by_id.entry(id.to_lowercase()).or_default().push(id);
        let legacy = legacy_state_path(config_dir, id)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .to_lowercase();
        by_legacy.entry(legacy).or_default().push(id);
    }
    for ids in by_id.values().filter(|ids| ids.len() > 1) {
        for id in ids {
            blocked.insert(id.to_lowercase());
        }
        warnings.push(format!(
            "Case-insensitive duplicate mod UniqueID: {}. Their translation files were excluded until the duplicate is removed.",
            ids.iter().map(|id| id.as_str()).collect::<Vec<_>>().join(", ")
        ));
    }
    for ids in by_legacy.values().filter(|ids| ids.len() > 1) {
        if ids.iter().any(|id| !is_safe_windows_stem(id)) {
            for id in ids {
                blocked.insert(id.to_lowercase());
            }
            warnings.push(format!(
                "Multiple mods map to the same legacy translation-state file: {}. No state was migrated or opened for writing.",
                ids.iter().map(|id| id.as_str()).collect::<Vec<_>>().join(", ")
            ));
        }
    }
    for id in unique_ids {
        if blocked.contains(&id.to_lowercase()) || is_safe_windows_stem(id) {
            continue;
        }
        let legacy = legacy_state_path(config_dir, id);
        let destination = state_path(config_dir, id);
        if !legacy.is_file() || destination.exists() {
            continue;
        }
        let migration = crate::input_limits::read_json_text(&legacy)
            .and_then(|body| {
                serde_json::from_str::<ModState>(&body)
                    .map(|_| body)
                    .map_err(|error| error.to_string())
            })
            .and_then(|body| {
                if let Some(parent) = destination.parent() {
                    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
                }
                let temp = sibling(&destination, ".tmp");
                std::fs::write(&temp, body).map_err(|error| error.to_string())?;
                std::fs::rename(&temp, &destination).map_err(|error| error.to_string())
            });
        if let Err(error) = migration {
            blocked.insert(id.to_lowercase());
            warnings.push(format!(
                "Could not safely migrate translation state for {id}: {error}. The legacy file was left untouched."
            ));
        }
    }
    (blocked, warnings)
}

/// A sibling path with `suffix` appended to the full file name
/// (`Some.Mod.json` + `.bak` -> `Some.Mod.json.bak`).
fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(suffix);
    path.with_file_name(name)
}

/// Load a mod's saved state. A missing file is an empty state; an unreadable
/// or unparseable file is a **loud error** (the UI must show it instead of
/// silently presenting everything as untranslated — and saves must refuse to
/// overwrite the file while it is in this condition).
pub fn load(config_dir: &Path, unique_id: &str) -> Result<ModState, String> {
    let path = state_path(config_dir, unique_id);
    if !path.exists() {
        return Ok(ModState::new());
    }
    match crate::input_limits::read_json_text(&path) {
        Ok(body) => serde_json::from_str(&body).map_err(|error| {
            format!(
                "Saved translation state for {unique_id} is corrupted ({}): {error}. \
                 The file is left untouched — restore it from the .bak sibling or \
                 remove it to start over.",
                path.display()
            )
        }),
        Err(error) => Err(format!(
            "Could not read translation state {}: {error}",
            path.display()
        )),
    }
}

pub(crate) struct ModStateSnapshot {
    pub state: ModState,
    entry_revisions: HashMap<String, u64>,
}

impl ModStateSnapshot {
    pub fn entry_revision(&self, key: &str) -> u64 {
        self.entry_revisions.get(key).copied().unwrap_or_default()
    }
}

/// Read one component's persisted values and per-string in-session revisions
/// under the same writer lock. Live AI uses this as its stale-write snapshot.
pub(crate) fn load_snapshot(
    config_dir: &Path,
    unique_id: &str,
) -> Result<ModStateSnapshot, String> {
    let session = write_guard()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = state_path(config_dir, unique_id);
    let state = load(config_dir, unique_id)?;
    let entry_revisions = session
        .entry_revisions
        .iter()
        .filter(|((entry_path, _), _)| entry_path == &path)
        .map(|((_, key), revision)| (key.clone(), *revision))
        .collect();
    Ok(ModStateSnapshot {
        state,
        entry_revisions,
    })
}

/// Serialize and validate a state before any file in a multi-component batch
/// is changed.
fn serialize_state(state: &ModState) -> Result<String, String> {
    let body = serde_json::to_string_pretty(state)
        .map_err(|error| format!("Could not serialize translation state: {error}"))?;
    crate::input_limits::ensure_json_output_size(body.len() as u64, "Translation state")?;
    // Defensive: re-parse what we are about to write (mirrors export.rs).
    serde_json::from_str::<ModState>(&body)
        .map_err(|error| format!("Generated invalid translation state JSON: {error}"))?;
    Ok(body)
}

fn write_serialized_state(
    path: &Path,
    body: &str,
    session: &mut WriteSession,
    touched_keys: &[String],
) -> Result<(), String> {
    stage_serialized_state(path, body)?;
    if let Err(error) = finalize_staged_state(path, session, touched_keys) {
        let _ = std::fs::remove_file(sibling(path, ".tmp"));
        return Err(error);
    }
    Ok(())
}

fn stage_serialized_state(path: &Path, body: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create translations dir: {error}"))?;
    }

    std::fs::write(sibling(path, ".tmp"), body.as_bytes())
        .map_err(|error| format!("Could not write temp state file: {error}"))
}

fn finalize_staged_state(
    path: &Path,
    session: &mut WriteSession,
    touched_keys: &[String],
) -> Result<(), String> {
    if path.is_file() && !session.backed_up.contains(path) {
        std::fs::copy(path, sibling(path, ".bak"))
            .map_err(|error| format!("Could not back up {}: {error}", path.display()))?;
        session.backed_up.insert(path.to_path_buf());
    }

    let temp = sibling(path, ".tmp");
    std::fs::rename(&temp, path)
        .map_err(|error| format!("Could not finalize {}: {error}", path.display()))?;
    session.record_mutation(path, touched_keys);
    Ok(())
}

fn write_state(
    path: &Path,
    state: &ModState,
    session: &mut WriteSession,
    touched_keys: &[String],
) -> Result<(), String> {
    let body = serialize_state(state)?;
    write_serialized_state(path, &body, session, touched_keys)
}

/// Upsert a single string's saved state (one serialized load-modify-write).
pub fn save_one(
    config_dir: &Path,
    unique_id: &str,
    key: String,
    entry: StoredString,
) -> Result<(), String> {
    save_many(config_dir, unique_id, vec![(key, entry)])
}

/// Upsert many strings in **one** load-modify-write cycle, serialized against
/// every other save in this process. This is the bulk-action path: N parallel
/// `save_one` calls would race their read-modify-write cycles and lose updates.
pub fn save_many(
    config_dir: &Path,
    unique_id: &str,
    entries: Vec<(String, StoredString)>,
) -> Result<(), String> {
    let mut session = write_guard()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut state = load(config_dir, unique_id)?;
    let touched_keys = entries
        .iter()
        .map(|(key, _)| key.clone())
        .collect::<Vec<_>>();
    for (key, entry) in entries {
        state.insert(key, entry);
    }
    write_state(
        &state_path(config_dir, unique_id),
        &state,
        &mut session,
        &touched_keys,
    )
}

#[derive(Clone, Debug)]
pub(crate) struct ReversibleModEdit {
    pub mod_unique_id: String,
    pub expected_current: Vec<(String, StoredString)>,
    pub previous: Vec<(String, Option<StoredString>)>,
    expected_revision: u64,
}

#[derive(Clone, Debug)]
pub(crate) struct ReversibleBatch {
    pub edits: Vec<ReversibleModEdit>,
}

struct PreparedStateWrite {
    path: PathBuf,
    existed: bool,
    before: ModState,
    after_body: String,
    touched_keys: Vec<String>,
}

fn restore_exact_state(
    write: &PreparedStateWrite,
    session: &mut WriteSession,
) -> Result<(), String> {
    let _ = std::fs::remove_file(sibling(&write.path, ".tmp"));
    if write.existed {
        write_state(&write.path, &write.before, session, &write.touched_keys)
    } else if write.path.exists() {
        std::fs::remove_file(&write.path).map_err(|error| {
            format!(
                "Could not remove partial state {}: {error}",
                write.path.display()
            )
        })?;
        session.record_mutation(&write.path, &write.touched_keys);
        Ok(())
    } else {
        Ok(())
    }
}

fn commit_state_writes(
    writes: &[PreparedStateWrite],
    session: &mut WriteSession,
) -> Result<(), String> {
    for (index, write) in writes.iter().enumerate() {
        if let Err(error) = stage_serialized_state(&write.path, &write.after_body) {
            for staged in &writes[..=index] {
                let _ = std::fs::remove_file(sibling(&staged.path, ".tmp"));
            }
            return Err(error);
        }
    }

    for (index, write) in writes.iter().enumerate() {
        let already_backed_up = session.backed_up.contains(&write.path);
        if let Err(error) = finalize_staged_state(&write.path, session, &write.touched_keys) {
            let mut rollback_errors = Vec::new();
            for unfinished in &writes[index..] {
                let temp = sibling(&unfinished.path, ".tmp");
                if !temp.exists() {
                    continue;
                }
                if let Err(cleanup) = std::fs::remove_file(&temp) {
                    rollback_errors.push(format!(
                        "Could not remove partial state {}: {cleanup}",
                        temp.display()
                    ));
                }
            }
            if !already_backed_up && session.backed_up.contains(&write.path) {
                let backup = sibling(&write.path, ".bak");
                match std::fs::remove_file(&backup) {
                    Ok(()) => {
                        session.backed_up.remove(&write.path);
                    }
                    Err(cleanup) => rollback_errors.push(format!(
                        "Could not remove partial backup {}: {cleanup}",
                        backup.display()
                    )),
                }
            }
            // A failed atomic rename leaves the current target untouched; only
            // writes that completed before it need their original contents
            // restored.
            for prior in writes[..index].iter().rev() {
                if let Err(rollback) = restore_exact_state(prior, session) {
                    rollback_errors.push(rollback);
                }
            }
            if rollback_errors.is_empty() {
                return Err(error);
            }
            return Err(format!(
                "{error} The batch rollback was incomplete: {}",
                rollback_errors.join(" ")
            ));
        }
    }
    Ok(())
}

fn validate_reversible_groups(
    groups: &[(String, Vec<(String, StoredString)>)],
) -> Result<(), String> {
    if groups.is_empty() {
        return Err("Choose at least one string for the batch edit.".to_string());
    }
    let mut mods = HashSet::with_capacity(groups.len());
    for (mod_unique_id, entries) in groups {
        if entries.is_empty() {
            return Err("A batch edit group contains no strings.".to_string());
        }
        if mod_unique_id.trim().is_empty() {
            return Err("A batch edit group has no component identity.".to_string());
        }
        if !mods.insert(mod_unique_id.to_lowercase()) {
            return Err("The batch edit contains the same mod more than once.".to_string());
        }
        let mut keys = HashSet::with_capacity(entries.len());
        if entries.iter().any(|(key, _)| !keys.insert(key)) {
            return Err("The batch edit contains the same string more than once.".to_string());
        }
    }
    Ok(())
}

/// Apply one multi-mod batch while holding the process-wide translation lock.
/// Every state is loaded before the first write, and a later write failure
/// restores earlier files to their exact pre-batch state before returning.
pub(crate) fn save_groups_with_previous(
    config_dir: &Path,
    groups: Vec<(String, Vec<(String, StoredString)>)>,
) -> Result<ReversibleBatch, String> {
    validate_reversible_groups(&groups)?;
    let mut session = write_guard()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut writes = Vec::with_capacity(groups.len());
    let mut snapshots = Vec::with_capacity(groups.len());
    for (mod_unique_id, entries) in groups {
        let path = state_path(config_dir, &mod_unique_id);
        let existed = path.is_file();
        let before = load(config_dir, &mod_unique_id)?;
        let previous = entries
            .iter()
            .map(|(key, _)| (key.clone(), before.get(key).cloned()))
            .collect();
        let mut after = before.clone();
        for (key, entry) in &entries {
            after.insert(key.clone(), entry.clone());
        }
        let after_body = serialize_state(&after)?;
        let touched_keys = entries.iter().map(|(key, _)| key.clone()).collect();
        writes.push(PreparedStateWrite {
            path,
            existed,
            before,
            after_body,
            touched_keys,
        });
        snapshots.push(ReversibleModEdit {
            mod_unique_id,
            expected_current: entries,
            previous,
            expected_revision: 0,
        });
    }
    commit_state_writes(&writes, &mut session)?;
    for (snapshot, write) in snapshots.iter_mut().zip(&writes) {
        snapshot.expected_revision = session.revision(&write.path);
    }
    Ok(ReversibleBatch { edits: snapshots })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ConditionalSaveOutcome {
    Saved,
    Stale,
}

#[derive(Clone, Debug)]
pub(crate) struct ConditionalSaveEntry {
    pub key: String,
    pub expected: Option<StoredString>,
    pub expected_revision: u64,
    pub entry: StoredString,
}

/// Save one completed AI chunk as a single conditional transaction. Every
/// requested entry is checked under the process-wide writer lock before any
/// component state is staged or changed. Edits to unrelated strings remain
/// allowed and are preserved.
pub(crate) fn save_groups_if_unchanged(
    config_dir: &Path,
    groups: Vec<(String, Vec<ConditionalSaveEntry>)>,
) -> Result<ConditionalSaveOutcome, String> {
    if groups.is_empty() {
        return Err("The completed AI chunk contains no component groups.".to_string());
    }
    let mut session = write_guard()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut component_ids = HashSet::with_capacity(groups.len());
    let mut writes = Vec::with_capacity(groups.len());

    for (mod_unique_id, entries) in groups {
        if entries.is_empty() {
            return Err("A completed AI chunk contains an empty component group.".to_string());
        }
        if !component_ids.insert(mod_unique_id.to_lowercase()) {
            return Err(
                "A completed AI chunk contains the same component more than once.".to_string(),
            );
        }

        let path = state_path(config_dir, &mod_unique_id);
        let existed = path.is_file();
        let before = load(config_dir, &mod_unique_id)?;
        let mut keys = HashSet::with_capacity(entries.len());
        for item in &entries {
            if !keys.insert(item.key.clone()) {
                return Err(
                    "A completed AI chunk contains the same string more than once.".to_string(),
                );
            }
            if session.entry_revision(&path, &item.key) != item.expected_revision
                || before.get(&item.key) != item.expected.as_ref()
            {
                return Ok(ConditionalSaveOutcome::Stale);
            }
        }

        let mut after = before.clone();
        let touched_keys = entries
            .iter()
            .map(|item| item.key.clone())
            .collect::<Vec<_>>();
        for item in entries {
            after.insert(item.key, item.entry);
        }
        writes.push(PreparedStateWrite {
            path,
            existed,
            before,
            after_body: serialize_state(&after)?,
            touched_keys,
        });
    }

    commit_state_writes(&writes, &mut session)?;
    Ok(ConditionalSaveOutcome::Saved)
}

/// Restore a prior bulk snapshot only while every touched entry still equals
/// the value written by that batch. A later single-string or batch edit makes
/// the undo stale instead of silently overwriting newer user work.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RestoreManyOutcome {
    Restored,
    Stale,
}

pub(crate) fn restore_groups_if_unchanged(
    config_dir: &Path,
    batch: &ReversibleBatch,
) -> Result<RestoreManyOutcome, String> {
    let mut session = write_guard()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut writes = Vec::with_capacity(batch.edits.len());
    for snapshot in &batch.edits {
        let path = state_path(config_dir, &snapshot.mod_unique_id);
        if session.revision(&path) != snapshot.expected_revision {
            return Ok(RestoreManyOutcome::Stale);
        }
        let existed = path.is_file();
        let before = load(config_dir, &snapshot.mod_unique_id)?;
        if snapshot
            .expected_current
            .iter()
            .any(|(key, expected)| before.get(key) != Some(expected))
        {
            return Ok(RestoreManyOutcome::Stale);
        }
        let mut after = before.clone();
        for (key, entry) in &snapshot.previous {
            match entry {
                Some(entry) => {
                    after.insert(key.clone(), entry.clone());
                }
                None => {
                    after.remove(key);
                }
            }
        }
        let after_body = serialize_state(&after)?;
        let touched_keys = snapshot
            .expected_current
            .iter()
            .map(|(key, _)| key.clone())
            .collect();
        writes.push(PreparedStateWrite {
            path,
            existed,
            before,
            after_body,
            touched_keys,
        });
    }
    commit_state_writes(&writes, &mut session)?;
    Ok(RestoreManyOutcome::Restored)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(target: &str) -> StoredString {
        StoredString {
            target: target.into(),
            status: "translated".into(),
            source_hash: source_hash("Hello"),
        }
    }

    fn conditional_group(
        key: &str,
        expected: Option<StoredString>,
        expected_revision: u64,
        target: &str,
    ) -> Vec<(String, Vec<ConditionalSaveEntry>)> {
        vec![(
            "mod".to_string(),
            vec![ConditionalSaveEntry {
                key: key.to_string(),
                expected,
                expected_revision,
                entry: StoredString {
                    target: target.to_string(),
                    status: "review-needed".to_string(),
                    source_hash: source_hash("Hello"),
                },
            }],
        )]
    }

    #[test]
    fn hash_is_stable_and_distinct() {
        assert_eq!(source_hash("hello"), source_hash("hello"));
        assert_ne!(source_hash("hello"), source_hash("hello!"));
    }

    #[test]
    fn save_one_then_load_roundtrips() {
        let dir = crate::test_support::temp_dir("translations");
        let entry = StoredString {
            target: "Hallo".into(),
            status: "done".into(),
            source_hash: source_hash("Hello"),
        };
        save_one(
            &dir,
            "Some.Mod",
            entry_key("i18n", "greeting"),
            entry.clone(),
        )
        .unwrap();

        let state = load(&dir, "Some.Mod").unwrap();
        assert_eq!(state.get(&entry_key("i18n", "greeting")), Some(&entry));
        // No temp file is left behind.
        assert!(!sibling(&state_path(&dir, "Some.Mod"), ".tmp").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn reversible_bulk_save_restores_existing_and_absent_entries() {
        let dir = crate::test_support::temp_dir("translations-bulk-undo");
        save_one(&dir, "mod", "existing".into(), entry("Before")).unwrap();
        let changed = vec![
            ("existing".to_string(), entry("After")),
            ("new".to_string(), entry("Added")),
        ];

        let snapshots =
            save_groups_with_previous(&dir, vec![("mod".to_string(), changed.clone())]).unwrap();
        assert_eq!(load(&dir, "mod").unwrap()["existing"].target, "After");
        assert!(load(&dir, "mod").unwrap().contains_key("new"));

        assert_eq!(
            restore_groups_if_unchanged(&dir, &snapshots).unwrap(),
            RestoreManyOutcome::Restored
        );
        let restored = load(&dir, "mod").unwrap();
        assert_eq!(restored["existing"].target, "Before");
        assert!(!restored.contains_key("new"));
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn reversible_bulk_save_refuses_to_overwrite_a_later_edit() {
        let dir = crate::test_support::temp_dir("translations-stale-bulk-undo");
        let changed = vec![("key".to_string(), entry("Batch"))];
        let snapshots =
            save_groups_with_previous(&dir, vec![("mod".to_string(), changed)]).unwrap();
        save_one(&dir, "mod", "key".into(), entry("Newer")).unwrap();

        assert_eq!(
            restore_groups_if_unchanged(&dir, &snapshots).unwrap(),
            RestoreManyOutcome::Stale
        );
        assert_eq!(load(&dir, "mod").unwrap()["key"].target, "Newer");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn multi_mod_restore_stays_stale_after_edit_is_reverted() {
        let dir = crate::test_support::temp_dir("translations-multi-mod-restore");
        save_one(&dir, "mod-a", "a".into(), entry("Old A")).unwrap();
        save_one(&dir, "mod-b", "b".into(), entry("Old B")).unwrap();

        let first = vec![
            ("a".to_string(), entry("Batch A")),
            ("added".to_string(), entry("Added")),
        ];
        let second = vec![("b".to_string(), entry("Batch B"))];
        let snapshots = save_groups_with_previous(
            &dir,
            vec![
                ("mod-a".to_string(), first),
                ("mod-b".to_string(), second.clone()),
            ],
        )
        .unwrap();

        save_one(&dir, "mod-b", "b".into(), entry("Later B")).unwrap();
        assert_eq!(
            restore_groups_if_unchanged(&dir, &snapshots).unwrap(),
            RestoreManyOutcome::Stale
        );
        assert_eq!(load(&dir, "mod-a").unwrap()["a"].target, "Batch A");
        assert_eq!(load(&dir, "mod-b").unwrap()["b"].target, "Later B");

        save_many(&dir, "mod-b", second).unwrap();
        assert_eq!(
            restore_groups_if_unchanged(&dir, &snapshots).unwrap(),
            RestoreManyOutcome::Stale
        );
        let unchanged_a = load(&dir, "mod-a").unwrap();
        let unchanged_b = load(&dir, "mod-b").unwrap();
        assert_eq!(unchanged_a["a"].target, "Batch A");
        assert!(unchanged_a.contains_key("added"));
        assert_eq!(unchanged_b["b"].target, "Batch B");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn later_oversized_group_fails_before_any_component_is_written() {
        let dir = crate::test_support::temp_dir("translations-preflight-all-groups");
        save_one(&dir, "mod-a", "a".into(), entry("Old A")).unwrap();
        save_one(&dir, "mod-b", "b".into(), entry("Old B")).unwrap();
        let path_a = state_path(&dir, "mod-a");
        let before_a = std::fs::read(&path_a).unwrap();
        let oversized = StoredString {
            target: "x".repeat(crate::input_limits::MAX_JSON_BYTES as usize),
            status: "translated".to_string(),
            source_hash: source_hash("Large source"),
        };

        let error = save_groups_with_previous(
            &dir,
            vec![
                ("mod-a".to_string(), vec![("a".to_string(), entry("New A"))]),
                ("mod-b".to_string(), vec![("b".to_string(), oversized)]),
            ],
        )
        .unwrap_err();
        assert!(error.contains("64 MiB"), "unexpected error: {error}");
        assert_eq!(std::fs::read(&path_a).unwrap(), before_a);
        assert_eq!(load(&dir, "mod-b").unwrap()["b"].target, "Old B");
        assert!(!sibling(&path_a, ".bak").exists());
        assert!(!sibling(&path_a, ".tmp").exists());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn later_temp_failure_cleans_staged_files_before_any_target_is_changed() {
        let dir = crate::test_support::temp_dir("translations-stage-all-groups");
        save_one(&dir, "mod-a", "a".into(), entry("Old A")).unwrap();
        save_one(&dir, "mod-b", "b".into(), entry("Old B")).unwrap();
        let path_a = state_path(&dir, "mod-a");
        let path_b = state_path(&dir, "mod-b");
        let before_a = std::fs::read(&path_a).unwrap();
        let before_b = std::fs::read(&path_b).unwrap();
        std::fs::create_dir(sibling(&path_b, ".tmp")).unwrap();

        assert!(save_groups_with_previous(
            &dir,
            vec![
                ("mod-a".to_string(), vec![("a".to_string(), entry("New A"))],),
                ("mod-b".to_string(), vec![("b".to_string(), entry("New B"))],),
            ],
        )
        .is_err());
        assert_eq!(std::fs::read(&path_a).unwrap(), before_a);
        assert_eq!(std::fs::read(&path_b).unwrap(), before_b);
        assert!(!sibling(&path_a, ".tmp").exists());
        assert!(!sibling(&path_a, ".bak").exists());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn reversible_groups_reject_duplicate_components_and_keys() {
        let dir = crate::test_support::temp_dir("translations-group-validation");
        let duplicate_mod = save_groups_with_previous(
            &dir,
            vec![
                ("Möd".to_string(), vec![("a".to_string(), entry("A"))]),
                ("MÖD".to_string(), vec![("b".to_string(), entry("B"))]),
            ],
        )
        .unwrap_err();
        assert!(duplicate_mod.contains("same mod"));

        let duplicate_key = save_groups_with_previous(
            &dir,
            vec![(
                "mod".to_string(),
                vec![
                    ("same".to_string(), entry("A")),
                    ("same".to_string(), entry("B")),
                ],
            )],
        )
        .unwrap_err();
        assert!(duplicate_key.contains("same string"));
        assert!(!dir.exists());
    }

    #[test]
    fn conditional_ai_save_preserves_a_newer_edit() {
        let dir = crate::test_support::temp_dir("translations-conditional-ai");
        let original = entry("Before");
        save_one(&dir, "mod", "key".into(), original.clone()).unwrap();
        let expected_revision = load_snapshot(&dir, "mod").unwrap().entry_revision("key");
        save_one(&dir, "mod", "key".into(), entry("Newer")).unwrap();

        assert_eq!(
            save_groups_if_unchanged(
                &dir,
                conditional_group("key", Some(original), expected_revision, "AI"),
            )
            .unwrap(),
            ConditionalSaveOutcome::Stale
        );
        assert_eq!(load(&dir, "mod").unwrap()["key"].target, "Newer");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn conditional_ai_save_stays_stale_after_edit_is_reverted() {
        let dir = crate::test_support::temp_dir("translations-conditional-ai-aba");
        let original = entry("Before");
        save_one(&dir, "mod", "key".into(), original.clone()).unwrap();
        let expected_revision = load_snapshot(&dir, "mod").unwrap().entry_revision("key");
        save_one(&dir, "mod", "key".into(), entry("Newer")).unwrap();
        save_one(&dir, "mod", "key".into(), original.clone()).unwrap();

        assert_eq!(
            save_groups_if_unchanged(
                &dir,
                conditional_group("key", Some(original), expected_revision, "AI"),
            )
            .unwrap(),
            ConditionalSaveOutcome::Stale
        );
        assert_eq!(load(&dir, "mod").unwrap()["key"].target, "Before");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn conditional_ai_save_allows_an_unrelated_string_edit() {
        let dir = crate::test_support::temp_dir("translations-conditional-ai-unrelated");
        let snapshot = load_snapshot(&dir, "mod").unwrap();
        save_one(&dir, "mod", "other".into(), entry("Manual")).unwrap();

        assert_eq!(
            save_groups_if_unchanged(
                &dir,
                conditional_group(
                    "requested",
                    None,
                    snapshot.entry_revision("requested"),
                    "AI",
                ),
            )
            .unwrap(),
            ConditionalSaveOutcome::Saved
        );
        let state = load(&dir, "mod").unwrap();
        assert_eq!(state["other"].target, "Manual");
        assert_eq!(state["requested"].target, "AI");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn conditional_ai_chunk_is_atomic_when_a_later_entry_is_stale() {
        let dir = crate::test_support::temp_dir("translations-conditional-ai-chunk");
        let snapshot = load_snapshot(&dir, "mod").unwrap();
        save_one(&dir, "mod", "second".into(), entry("Manual")).unwrap();

        let result = save_groups_if_unchanged(
            &dir,
            vec![(
                "mod".to_string(),
                vec![
                    ConditionalSaveEntry {
                        key: "first".to_string(),
                        expected: None,
                        expected_revision: snapshot.entry_revision("first"),
                        entry: entry("AI first"),
                    },
                    ConditionalSaveEntry {
                        key: "second".to_string(),
                        expected: None,
                        expected_revision: snapshot.entry_revision("second"),
                        entry: entry("AI second"),
                    },
                ],
            )],
        )
        .unwrap();

        assert_eq!(result, ConditionalSaveOutcome::Stale);
        let state = load(&dir, "mod").unwrap();
        assert!(!state.contains_key("first"));
        assert_eq!(state["second"].target, "Manual");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn conditional_ai_chunk_is_atomic_across_components() {
        let dir = crate::test_support::temp_dir("translations-conditional-ai-components");
        let first = load_snapshot(&dir, "first.mod").unwrap();
        let second = load_snapshot(&dir, "second.mod").unwrap();
        save_one(&dir, "second.mod", "second".into(), entry("Manual")).unwrap();

        let result = save_groups_if_unchanged(
            &dir,
            vec![
                (
                    "first.mod".to_string(),
                    vec![ConditionalSaveEntry {
                        key: "first".to_string(),
                        expected: None,
                        expected_revision: first.entry_revision("first"),
                        entry: entry("AI first"),
                    }],
                ),
                (
                    "second.mod".to_string(),
                    vec![ConditionalSaveEntry {
                        key: "second".to_string(),
                        expected: None,
                        expected_revision: second.entry_revision("second"),
                        entry: entry("AI second"),
                    }],
                ),
            ],
        )
        .unwrap();

        assert_eq!(result, ConditionalSaveOutcome::Stale);
        assert!(load(&dir, "first.mod").unwrap().is_empty());
        assert_eq!(load(&dir, "second.mod").unwrap()["second"].target, "Manual");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn conditional_ai_chunk_writes_nothing_when_a_later_state_cannot_load() {
        let dir = crate::test_support::temp_dir("translations-conditional-ai-load-error");
        let first = load_snapshot(&dir, "first.mod").unwrap();
        let broken_path = state_path(&dir, "broken.mod");
        std::fs::create_dir_all(broken_path.parent().unwrap()).unwrap();
        std::fs::write(&broken_path, "not json").unwrap();

        let error = save_groups_if_unchanged(
            &dir,
            vec![
                (
                    "first.mod".to_string(),
                    vec![ConditionalSaveEntry {
                        key: "first".to_string(),
                        expected: None,
                        expected_revision: first.entry_revision("first"),
                        entry: entry("AI first"),
                    }],
                ),
                (
                    "broken.mod".to_string(),
                    vec![ConditionalSaveEntry {
                        key: "second".to_string(),
                        expected: None,
                        expected_revision: 0,
                        entry: entry("AI second"),
                    }],
                ),
            ],
        )
        .unwrap_err();

        assert!(error.contains("is corrupted"), "{error}");
        assert!(load(&dir, "first.mod").unwrap().is_empty());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn unknown_mod_yields_empty_state() {
        let dir = crate::test_support::temp_dir("translations-empty");
        assert!(load(&dir, "Nope").unwrap().is_empty());
    }

    #[test]
    fn unsafe_id_uses_hash_and_migrates_one_valid_legacy_file_without_deleting_it() {
        let dir = crate::test_support::temp_dir("translations-hashed-migration");
        let id = "Author/Unsafe";
        let legacy = legacy_state_path(&dir, id);
        std::fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        let state = ModState::from([(entry_key("i18n", "k"), entry("Alt"))]);
        std::fs::write(&legacy, serde_json::to_string(&state).unwrap()).unwrap();

        let (blocked, warnings) = prepare_state_paths(&dir, &[id.to_string()]);
        assert!(blocked.is_empty(), "{warnings:?}");
        assert!(legacy.is_file(), "legacy state remains recoverable");
        let destination = state_path(&dir, id);
        assert!(destination
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("state-"));
        assert_eq!(load(&dir, id).unwrap(), state);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn colliding_legacy_paths_are_blocked_without_migration() {
        let dir = crate::test_support::temp_dir("translations-colliding-migration");
        let ids = vec!["Author/A".to_string(), "Author?A".to_string()];
        let legacy = legacy_state_path(&dir, &ids[0]);
        std::fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        std::fs::write(&legacy, "{}").unwrap();

        let (blocked, warnings) = prepare_state_paths(&dir, &ids);
        assert_eq!(blocked.len(), 2, "{warnings:?}");
        assert!(ids.iter().all(|id| !state_path(&dir, id).exists()));
        assert!(legacy.is_file());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn failed_backup_can_be_retried_successfully() {
        let dir = crate::test_support::temp_dir("translations-backup-retry");
        save_one(&dir, "Retry.Mod", entry_key("i18n", "a"), entry("A")).unwrap();
        let path = state_path(&dir, "Retry.Mod");
        let backup = sibling(&path, ".bak");
        std::fs::create_dir_all(&backup).unwrap();
        assert!(save_one(&dir, "Retry.Mod", entry_key("i18n", "b"), entry("B")).is_err());
        std::fs::remove_dir(&backup).unwrap();
        save_one(&dir, "Retry.Mod", entry_key("i18n", "b"), entry("B")).unwrap();
        assert!(backup.is_file());
        assert_eq!(load(&dir, "Retry.Mod").unwrap().len(), 2);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn save_many_persists_all_entries_in_one_write() {
        let dir = crate::test_support::temp_dir("translations-many");
        let entries: Vec<_> = (0..50)
            .map(|i| (entry_key("i18n", &format!("k{i}")), entry(&format!("v{i}"))))
            .collect();
        save_many(&dir, "Bulk.Mod", entries).unwrap();
        let state = load(&dir, "Bulk.Mod").unwrap();
        assert_eq!(state.len(), 50);
        assert_eq!(state.get(&entry_key("i18n", "k7")).unwrap().target, "v7");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn language_roots_isolate_state_and_migrate_legacy_once() {
        let dir = crate::test_support::temp_dir("translations-languages");
        save_one(&dir, "mod.id", entry_key("i18n", "k"), entry("Deutsch")).unwrap();

        let german = language_root(&dir, "de").unwrap();
        assert_eq!(
            load(&german, "mod.id").unwrap()[&entry_key("i18n", "k")].target,
            "Deutsch"
        );
        assert!(!dir.join("translations").exists());

        let japanese = language_root(&dir, "ja").unwrap();
        assert!(load(&japanese, "mod.id").unwrap().is_empty());
        save_one(&japanese, "mod.id", entry_key("i18n", "k"), entry("日本語")).unwrap();

        assert_eq!(
            load(&german, "mod.id").unwrap()[&entry_key("i18n", "k")].target,
            "Deutsch"
        );
        assert_eq!(
            load(&japanese, "mod.id").unwrap()[&entry_key("i18n", "k")].target,
            "日本語"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn concurrent_saves_lose_no_updates() {
        // 32 threads each upsert a distinct key into the SAME state file. Without
        // the process-wide write guard, racing load-modify-write cycles drop
        // entries; with it, every key must survive.
        let dir = crate::test_support::temp_dir("translations-concurrent");
        let handles: Vec<_> = (0..32)
            .map(|i| {
                let dir = dir.clone();
                std::thread::spawn(move || {
                    save_one(
                        &dir,
                        "Race.Mod",
                        entry_key("i18n", &format!("k{i}")),
                        entry(&format!("v{i}")),
                    )
                    .unwrap();
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }
        let state = load(&dir, "Race.Mod").unwrap();
        assert_eq!(state.len(), 32, "every concurrent save must persist");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn corrupt_state_errors_loudly_and_is_never_overwritten() {
        let dir = crate::test_support::temp_dir("translations-corrupt");
        let path = state_path(&dir, "Broken.Mod");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{ not json").unwrap();

        // Load is a loud error, not a silent empty state.
        let err = load(&dir, "Broken.Mod").unwrap_err();
        assert!(err.contains("corrupted"), "unexpected error: {err}");

        // A save must refuse to clobber the corrupted (recoverable) file.
        let result = save_one(&dir, "Broken.Mod", entry_key("i18n", "k"), entry("v"));
        assert!(result.is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ not json");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn oversized_state_errors_before_read_and_is_never_overwritten() {
        let dir = crate::test_support::temp_dir("translations-oversized");
        let path = state_path(&dir, "Large.Mod");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(crate::input_limits::MAX_JSON_BYTES + 1)
            .unwrap();

        let error = load(&dir, "Large.Mod").unwrap_err();
        assert!(error.contains("64 MiB"), "unexpected error: {error}");
        assert!(save_one(&dir, "Large.Mod", entry_key("i18n", "k"), entry("v")).is_err());
        assert_eq!(
            std::fs::metadata(&path).unwrap().len(),
            crate::input_limits::MAX_JSON_BYTES + 1
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn oversized_save_leaves_existing_state_untouched() {
        let dir = crate::test_support::temp_dir("translations-oversized-save");
        let unique_id = "Large.Save.Mod";
        let old_key = entry_key("i18n", "old");
        let old_entry = entry("Bestehend");
        save_one(&dir, unique_id, old_key.clone(), old_entry.clone()).unwrap();

        let path = state_path(&dir, unique_id);
        let before = std::fs::read(&path).unwrap();
        let oversized = StoredString {
            // One value is the lowest-overhead way to cross the real file
            // boundary while exercising serialization and the public save path.
            target: "x".repeat(crate::input_limits::MAX_JSON_BYTES as usize),
            status: "translated".to_string(),
            source_hash: source_hash("Large source"),
        };

        let error =
            save_one(&dir, unique_id, entry_key("i18n", "too-large"), oversized).unwrap_err();
        assert!(error.contains("64 MiB"), "unexpected error: {error}");
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(
            load(&dir, unique_id).unwrap().get(&old_key),
            Some(&old_entry)
        );
        assert!(!sibling(&path, ".bak").exists());
        assert!(!sibling(&path, ".tmp").exists());

        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn first_overwrite_of_a_session_creates_a_backup() {
        let dir = crate::test_support::temp_dir("translations-backup");
        let path = state_path(&dir, "Backup.Mod");
        let bak = sibling(&path, ".bak");

        // First save creates the file — nothing to back up yet.
        save_one(&dir, "Backup.Mod", entry_key("i18n", "k1"), entry("v1")).unwrap();
        assert!(!bak.exists());

        // Second save overwrites — the pre-overwrite content lands in .bak.
        save_one(&dir, "Backup.Mod", entry_key("i18n", "k2"), entry("v2")).unwrap();
        let backup: ModState =
            serde_json::from_str(&std::fs::read_to_string(&bak).unwrap()).unwrap();
        assert!(backup.contains_key(&entry_key("i18n", "k1")));
        assert!(!backup.contains_key(&entry_key("i18n", "k2")));
        std::fs::remove_dir_all(&dir).ok();
    }
}
