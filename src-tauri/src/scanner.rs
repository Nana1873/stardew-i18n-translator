//! Recursive mod scanner — M1 / Issue 4 (SPEC §6).
//!
//! Walks the Mods folder, finds every `manifest.json`, reads its metadata, and
//! discovers the translatable `i18n/` units beneath each mod. String contents
//! are parsed in Issue 5 — this stage only discovers files and groups mods by
//! package (top-level Mods subfolder, SPEC §7.3).
//!
//! Edge cases handled (SPEC §6): nested/multi-component mods (each manifest is
//! its own mod; `i18n/` is associated with the nearest ancestor manifest),
//! multiple `i18n/` folders per mod, malformed manifests (skipped with a
//! warning), `Nexus:-1` sentinel IDs, BOM / `//` + `/* */` comments / trailing
//! commas, missing `UniqueID` (folder-name fallback), and symlink cycles.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

const MAX_DEPTH: usize = 12;
const MAX_DIRS: usize = 200_000;

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScannedI18nFile {
    /// `i18n/` directory relative to the mod folder, e.g. `i18n` or `sub/i18n`.
    pub relative_dir: String,
    pub default_path: String,
    pub target_path: String,
    pub target_exists: bool,
    /// Number of keys in `default.json`.
    pub total_keys: usize,
    /// Source keys with a non-empty value in the target `<lang>.json`.
    pub translated_keys: usize,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScannedMod {
    pub unique_id: String,
    pub name: String,
    pub version: String,
    pub nexus_id: Option<u64>,
    /// Top-level Mods subfolder this mod belongs to (the downloaded package).
    pub package_id: String,
    pub folder_path: String,
    pub i18n_files: Vec<ScannedI18nFile>,
    /// Aggregates across all i18n files.
    pub total_keys: usize,
    pub translated_keys: usize,
    pub progress: f64,
    /// "none" (no keys) | "untranslated" (some missing) | "imported" (all present).
    pub status: String,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub mods: Vec<ScannedMod>,
    pub warnings: Vec<String>,
    pub mod_count: usize,
    pub file_count: usize,
}

/// Strip a UTF-8 BOM, `//` and `/* */` comments, and trailing commas, then
/// parse as JSON. Mirrors the lenient parsing real SMAPI mods require.
pub fn parse_json_lenient(text: &str) -> Result<Value, String> {
    let text = text.strip_prefix('\u{FEFF}').unwrap_or(text);
    let cleaned = strip_json_comments_and_trailing_commas(text);
    serde_json::from_str(&cleaned).map_err(|error| error.to_string())
}

/// Extract a positive Nexus mod id from SMAPI `UpdateKeys`.
///
/// Accepts `Nexus:1234` (whitespace tolerated, optional `@subkey` ignored).
/// Rejects the `Nexus:-1` sentinel and any non-positive value (SPEC §6).
pub fn extract_nexus_id(update_keys: &[String]) -> Option<u64> {
    for key in update_keys {
        let mut parts = key.splitn(2, ':');
        let site = parts.next().unwrap_or_default().trim();
        if !site.eq_ignore_ascii_case("nexus") {
            continue;
        }
        let Some(rest) = parts.next() else { continue };
        let digits: String = rest
            .trim()
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect();
        if let Ok(id) = digits.parse::<u64>() {
            if id > 0 {
                return Some(id);
            }
        }
    }
    None
}

/// Scan `mods_path` for translatable mods, importing for `target_lang`.
pub fn scan_mods(mods_path: &Path, target_lang: &str) -> ScanResult {
    let mut warnings = Vec::new();
    let mut manifest_files = Vec::new();
    let mut i18n_dirs = Vec::new();
    collect(mods_path, &mut manifest_files, &mut i18n_dirs);

    // Build a mod per manifest, keyed by its folder.
    let mut mods: HashMap<PathBuf, ScannedMod> = HashMap::new();
    let mut order: Vec<PathBuf> = Vec::new();
    let manifest_dirs: HashSet<PathBuf> = manifest_files
        .iter()
        .filter_map(|file| file.parent().map(Path::to_path_buf))
        .collect();

    for manifest in &manifest_files {
        let Some(dir) = manifest.parent() else {
            continue;
        };
        match read_manifest(manifest, dir, mods_path) {
            Ok(scanned) => {
                order.push(dir.to_path_buf());
                mods.insert(dir.to_path_buf(), scanned);
            }
            Err(reason) => warnings.push(format!("Skipped {}: {reason}", manifest.display())),
        }
    }

    // Associate each i18n/ folder with the nearest ancestor manifest.
    for i18n_dir in &i18n_dirs {
        let Some(owner) = nearest_manifest_owner(i18n_dir, &manifest_dirs) else {
            continue;
        };
        if let Some(scanned) = mods.get_mut(&owner) {
            if let Some(file) = build_i18n_file(&owner, i18n_dir, target_lang) {
                scanned.i18n_files.push(file);
            }
        }
    }

    // Keep only mods with translatable content; stable order by discovery.
    let mut result_mods: Vec<ScannedMod> = order
        .into_iter()
        .filter_map(|dir| mods.remove(&dir))
        .filter(|m| !m.i18n_files.is_empty())
        .collect();
    for scanned in &mut result_mods {
        scanned
            .i18n_files
            .sort_by(|a, b| a.relative_dir.cmp(&b.relative_dir));
        scanned.total_keys = scanned.i18n_files.iter().map(|f| f.total_keys).sum();
        scanned.translated_keys = scanned.i18n_files.iter().map(|f| f.translated_keys).sum();
        scanned.progress = progress_of(scanned.total_keys, scanned.translated_keys);
        scanned.status = derive_status(scanned.total_keys, scanned.translated_keys).to_string();
    }

    let file_count = result_mods.iter().map(|m| m.i18n_files.len()).sum();
    ScanResult {
        mod_count: result_mods.len(),
        file_count,
        mods: result_mods,
        warnings,
    }
}

fn read_manifest(manifest: &Path, dir: &Path, mods_path: &Path) -> Result<ScannedMod, String> {
    let body = std::fs::read_to_string(manifest).map_err(|e| format!("unreadable manifest: {e}"))?;
    let value = parse_json_lenient(&body).map_err(|e| format!("invalid manifest JSON: {e}"))?;
    let object = value.as_object().ok_or("manifest is not an object")?;

    let folder_name = dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown")
        .to_string();

    let unique_id = string_field(object, "UniqueID").unwrap_or_else(|| folder_name.clone());
    let name = string_field(object, "Name").unwrap_or_else(|| folder_name.clone());
    let version = string_field(object, "Version").unwrap_or_default();
    let nexus_id = extract_nexus_id(&update_keys(object));
    let package_id = package_id_for(dir, mods_path).unwrap_or_else(|| folder_name.clone());

    Ok(ScannedMod {
        unique_id,
        name,
        version,
        nexus_id,
        package_id,
        folder_path: dir.display().to_string(),
        i18n_files: Vec::new(),
        total_keys: 0,
        translated_keys: 0,
        progress: 0.0,
        status: String::new(),
    })
}

fn progress_of(total: usize, translated: usize) -> f64 {
    if total == 0 {
        0.0
    } else {
        translated as f64 / total as f64
    }
}

fn derive_status(total: usize, translated: usize) -> &'static str {
    if total == 0 {
        "none"
    } else if translated >= total {
        "imported"
    } else {
        "untranslated"
    }
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StringRow {
    pub key: String,
    pub source: String,
    pub target: String,
}

/// Load the paired source/target strings of one i18n file, preserving the key
/// order of `default.json` (serde_json `preserve_order`).
pub fn load_strings(default_path: &Path, target_path: &Path) -> Vec<StringRow> {
    let Some(source) = read_object(default_path) else {
        return Vec::new();
    };
    let target = read_object(target_path).unwrap_or_default();
    source
        .iter()
        .map(|(key, value)| StringRow {
            key: key.clone(),
            source: value_to_text(value),
            target: target.get(key).map(value_to_text).unwrap_or_default(),
        })
        .collect()
}

fn value_to_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// Parse a flat i18n JSON object (lenient), returning its string entries.
fn read_object(path: &Path) -> Option<serde_json::Map<String, Value>> {
    let body = std::fs::read_to_string(path).ok()?;
    parse_json_lenient(&body).ok()?.as_object().cloned()
}

/// (total source keys, source keys with a non-empty target value).
fn count_keys(default_path: &Path, target_path: &Path) -> (usize, usize) {
    let Some(source) = read_object(default_path) else {
        return (0, 0);
    };
    let total = source.len();
    let translated = match read_object(target_path) {
        Some(target) => source
            .keys()
            .filter(|key| {
                target
                    .get(*key)
                    .and_then(Value::as_str)
                    .is_some_and(|value| !value.trim().is_empty())
            })
            .count(),
        None => 0,
    };
    (total, translated)
}

fn string_field(object: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
    match object.get(key) {
        Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
        Some(Value::Number(n)) => Some(n.to_string()),
        _ => None,
    }
}

fn update_keys(object: &serde_json::Map<String, Value>) -> Vec<String> {
    match object.get("UpdateKeys") {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|v| v.as_str().map(String::from))
            .collect(),
        Some(Value::String(s)) => vec![s.clone()],
        _ => Vec::new(),
    }
}

/// The top-level Mods subfolder containing `dir` (the downloaded package).
fn package_id_for(dir: &Path, mods_path: &Path) -> Option<String> {
    let relative = dir.strip_prefix(mods_path).ok()?;
    relative
        .components()
        .next()
        .and_then(|c| c.as_os_str().to_str())
        .map(String::from)
}

fn nearest_manifest_owner(i18n_dir: &Path, manifest_dirs: &HashSet<PathBuf>) -> Option<PathBuf> {
    let mut current = i18n_dir.parent();
    while let Some(dir) = current {
        if manifest_dirs.contains(dir) {
            return Some(dir.to_path_buf());
        }
        current = dir.parent();
    }
    None
}

fn build_i18n_file(mod_dir: &Path, i18n_dir: &Path, target_lang: &str) -> Option<ScannedI18nFile> {
    let relative_dir = i18n_dir
        .strip_prefix(mod_dir)
        .ok()?
        .to_str()?
        .replace('\\', "/");
    let default_path = i18n_dir.join("default.json");
    let target_path = i18n_dir.join(format!("{target_lang}.json"));
    let (total_keys, translated_keys) = count_keys(&default_path, &target_path);
    Some(ScannedI18nFile {
        target_exists: target_path.is_file(),
        default_path: default_path.display().to_string(),
        target_path: target_path.display().to_string(),
        relative_dir,
        total_keys,
        translated_keys,
    })
}

/// Walk `root`, collecting `manifest.json` files and `i18n/` dirs that contain a
/// `default.json`. Bounded by depth and a visited-canonical-path set (cycles).
fn collect(root: &Path, manifests: &mut Vec<PathBuf>, i18n_dirs: &mut Vec<PathBuf>) {
    let mut visited: HashSet<PathBuf> = HashSet::new();
    let mut stack: Vec<(PathBuf, usize)> = vec![(root.to_path_buf(), 0)];
    let mut dirs_seen = 0usize;

    while let Some((dir, depth)) = stack.pop() {
        if depth > MAX_DEPTH || dirs_seen >= MAX_DIRS {
            continue;
        }
        let canonical = std::fs::canonicalize(&dir).unwrap_or_else(|_| dir.clone());
        if !visited.insert(canonical) {
            continue; // cycle / already visited
        }
        dirs_seen += 1;

        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };

            if file_type.is_file() {
                if path.file_name().is_some_and(|n| n == "manifest.json") {
                    manifests.push(path);
                }
                continue;
            }

            if file_type.is_dir() || file_type.is_symlink() {
                let is_i18n = path.file_name().is_some_and(|n| n.eq_ignore_ascii_case("i18n"));
                if is_i18n {
                    if path.join("default.json").is_file() {
                        i18n_dirs.push(path);
                    }
                    continue; // no mods nested inside an i18n folder
                }
                stack.push((path, depth + 1));
            }
        }
    }
}

/// Strip `//` and `/* */` comments and trailing commas from JSON-ish text,
/// respecting string literals. Ported from the previous project's parser.
pub fn strip_json_comments_and_trailing_commas(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let len = chars.len();

    // Pass 1: remove comments (keep newlines so error offsets stay sane).
    let mut chunks = Vec::new();
    let mut segment_start = 0;
    let mut in_string = false;
    let mut escaped = false;
    let mut in_line_comment = false;
    let mut in_block_comment = false;
    let mut index = 0;

    while index < len {
        let ch = chars[index];
        let next = if index + 1 < len { chars[index + 1] } else { '\0' };

        if in_line_comment {
            if ch == '\n' || ch == '\r' {
                in_line_comment = false;
                chunks.push(ch.to_string());
                segment_start = index + 1;
            }
            index += 1;
            continue;
        }
        if in_block_comment {
            if ch == '*' && next == '/' {
                in_block_comment = false;
                index += 2;
                segment_start = index;
                continue;
            }
            if ch == '\n' || ch == '\r' {
                chunks.push(ch.to_string());
            }
            index += 1;
            continue;
        }
        if in_string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            index += 1;
            continue;
        }
        if ch == '"' {
            in_string = true;
            index += 1;
            continue;
        }
        if ch == '/' && next == '/' {
            chunks.push(chars[segment_start..index].iter().collect::<String>());
            in_line_comment = true;
            index += 2;
            continue;
        }
        if ch == '/' && next == '*' {
            chunks.push(chars[segment_start..index].iter().collect::<String>());
            in_block_comment = true;
            index += 2;
            continue;
        }
        index += 1;
    }
    chunks.push(chars[segment_start..].iter().collect::<String>());
    let without_comments: Vec<char> = chunks.join("").chars().collect();

    // Pass 2: drop commas immediately before `}` or `]`.
    let len = without_comments.len();
    let mut out = Vec::new();
    let mut segment_start = 0;
    let mut in_string = false;
    let mut escaped = false;
    let mut index = 0;

    while index < len {
        let ch = without_comments[index];
        if in_string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            index += 1;
            continue;
        }
        if ch == '"' {
            in_string = true;
            index += 1;
            continue;
        }
        if ch == ',' {
            let next_non_ws = without_comments[index + 1..]
                .iter()
                .find(|c| !c.is_whitespace())
                .copied()
                .unwrap_or('\0');
            if next_non_ws == '}' || next_non_ws == ']' {
                out.push(without_comments[segment_start..index].iter().collect::<String>());
                segment_start = index + 1;
            }
        }
        index += 1;
    }
    out.push(without_comments[segment_start..].iter().collect::<String>());
    out.join("")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_comments_and_trailing_commas() {
        let input = "{\n  // line\n  \"a\": \"1\", /* block */\n  \"b\": \"2\",\n}";
        let value = parse_json_lenient(input).unwrap();
        assert_eq!(value["a"], "1");
        assert_eq!(value["b"], "2");
    }

    #[test]
    fn keeps_comment_markers_inside_strings() {
        let value = parse_json_lenient("{ \"url\": \"http://x/* y */\" }").unwrap();
        assert_eq!(value["url"], "http://x/* y */");
    }

    #[test]
    fn nexus_id_parsing() {
        assert_eq!(extract_nexus_id(&["Nexus:7286".into()]), Some(7286));
        assert_eq!(extract_nexus_id(&["Nexus: 7286".into()]), Some(7286));
        assert_eq!(extract_nexus_id(&["Nexus:7286@1.0".into()]), Some(7286));
        assert_eq!(extract_nexus_id(&["Nexus:-1".into()]), None);
        assert_eq!(extract_nexus_id(&["Nexus:0".into()]), None);
        assert_eq!(extract_nexus_id(&["GitHub:Owner/Repo".into()]), None);
        assert_eq!(
            extract_nexus_id(&["GitHub:o/r".into(), "Nexus:42".into()]),
            Some(42)
        );
    }

    fn write(path: &Path, body: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    #[test]
    fn scans_multi_component_package_and_skips_components_without_i18n() {
        let root = crate::test_support::temp_dir("scan-multi");
        // A "Ridgeside-like" package: 3 components with i18n, 1 without.
        let pkg = root.join("Ridgeside Village");
        for (name, nexus) in [
            ("[CP] RSV", "Nexus:7286"),
            ("[CC] RSV", "Nexus:-1"),
            ("RSV", "Nexus:-1"),
        ] {
            write(
                &pkg.join(name).join("manifest.json"),
                &format!("{{ \"Name\": \"{name}\", \"Version\": \"1.0\", \"UniqueID\": \"id.{name}\", \"UpdateKeys\": [ \"{nexus}\" ] }}"),
            );
            write(&pkg.join(name).join("i18n").join("default.json"), "{ \"k\": \"v\" }");
        }
        // [FTM] component: manifest but no i18n -> excluded.
        write(
            &pkg.join("[FTM] RSV").join("manifest.json"),
            "{ \"Name\": \"[FTM] RSV\", \"UniqueID\": \"id.ftm\" }",
        );
        // A malformed manifest -> skipped with a warning.
        write(&root.join("Broken").join("manifest.json"), "{ not json");

        let result = scan_mods(&root, "de");

        assert_eq!(result.mod_count, 3, "only components with i18n are listed");
        assert!(result.warnings.iter().any(|w| w.contains("Broken")));
        assert!(result.mods.iter().all(|m| m.package_id == "Ridgeside Village"));
        let cp = result.mods.iter().find(|m| m.name == "[CP] RSV").unwrap();
        assert_eq!(cp.nexus_id, Some(7286));
        assert_eq!(cp.i18n_files.len(), 1);
        assert_eq!(cp.i18n_files[0].relative_dir, "i18n");
        // Sentinel Nexus:-1 -> no id.
        let cc = result.mods.iter().find(|m| m.name == "[CC] RSV").unwrap();
        assert_eq!(cc.nexus_id, None);

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn detects_existing_target_translation() {
        let root = crate::test_support::temp_dir("scan-target");
        let mod_dir = root.join("Mod");
        write(
            &mod_dir.join("manifest.json"),
            "{ \"UniqueID\": \"a.b\", \"Name\": \"Mod\" }",
        );
        write(&mod_dir.join("i18n").join("default.json"), "{ \"k\": \"v\" }");
        write(&mod_dir.join("i18n").join("de.json"), "{ \"k\": \"w\" }");

        let result = scan_mods(&root, "de");
        let file = &result.mods[0].i18n_files[0];
        assert!(file.target_exists);
        assert!(file.target_path.ends_with("de.json"));

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn counts_keys_and_derives_progress_status() {
        let root = crate::test_support::temp_dir("scan-progress");
        let mod_dir = root.join("Mod");
        write(
            &mod_dir.join("manifest.json"),
            "{ \"UniqueID\": \"a.b\", \"Name\": \"Mod\" }",
        );
        write(
            &mod_dir.join("i18n").join("default.json"),
            "{ \"a\": \"1\", \"b\": \"2\", \"c\": \"3\" }",
        );
        // Only `a` is translated; `b` is empty, `c` missing.
        write(
            &mod_dir.join("i18n").join("de.json"),
            "{ \"a\": \"eins\", \"b\": \"  \" }",
        );

        let scanned = &scan_mods(&root, "de").mods[0];
        assert_eq!(scanned.total_keys, 3);
        assert_eq!(scanned.translated_keys, 1);
        assert!((scanned.progress - 1.0 / 3.0).abs() < 1e-9);
        assert_eq!(scanned.status, "untranslated");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn load_strings_preserves_order_and_pairs_target() {
        let root = crate::test_support::temp_dir("load-strings");
        let i18n = root.join("i18n");
        // Intentionally non-alphabetical to prove order is preserved.
        write(&i18n.join("default.json"), "{ \"zeta\": \"Z\", \"alpha\": \"A\" }");
        write(&i18n.join("de.json"), "{ \"alpha\": \"Ä\" }");

        let rows = load_strings(&i18n.join("default.json"), &i18n.join("de.json"));
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].key, "zeta");
        assert_eq!(rows[0].source, "Z");
        assert_eq!(rows[0].target, "");
        assert_eq!(rows[1].key, "alpha");
        assert_eq!(rows[1].target, "Ä");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn fully_translated_mod_is_imported() {
        let root = crate::test_support::temp_dir("scan-imported");
        let mod_dir = root.join("Mod");
        write(&mod_dir.join("manifest.json"), "{ \"UniqueID\": \"a.b\" }");
        write(&mod_dir.join("i18n").join("default.json"), "{ \"a\": \"1\" }");
        write(&mod_dir.join("i18n").join("de.json"), "{ \"a\": \"eins\" }");

        let scanned = &scan_mods(&root, "de").mods[0];
        assert_eq!(scanned.status, "imported");
        assert!((scanned.progress - 1.0).abs() < 1e-9);

        std::fs::remove_dir_all(&root).ok();
    }

    /// Real-machine smoke check against the user's Mods folder, if present.
    #[test]
    fn reports_scan_on_real_mods() {
        let mods = Path::new(r"E:\SteamLibrary\steamapps\common\Stardew Valley\Mods");
        if !mods.is_dir() {
            eprintln!("scan: real Mods folder absent — skipped");
            return;
        }
        let started = std::time::Instant::now();
        let result = scan_mods(mods, "de");
        let elapsed = started.elapsed();
        let total_keys: usize = result.mods.iter().map(|m| m.total_keys).sum();
        eprintln!(
            "scan: {} mods, {} i18n files, {} total keys, {} warnings in {:?}",
            result.mod_count,
            result.file_count,
            total_keys,
            result.warnings.len(),
            elapsed
        );
        if let Some(cp) = result
            .mods
            .iter()
            .find(|m| m.name.contains("Ridgeside") && m.name.contains("Content"))
        {
            eprintln!(
                "  Ridgeside [CP]: {} keys, {} translated, status {}",
                cp.total_keys, cp.translated_keys, cp.status
            );
        }
    }
}
