use std::fs::File;
use std::io::Write;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use zip::write::SimpleFileOptions;

use crate::export::ExportFileInput;
use crate::{scanner, tokens, translations};

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ZipComponentInput {
    pub unique_id: String,
    pub name: String,
    pub version: String,
    pub folder_path: String,
    pub files: Vec<ExportFileInput>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ZipProblem {
    pub mod_unique_id: String,
    pub mod_name: String,
    pub relative_dir: String,
    pub key: String,
    pub reason: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ZipEntryPreview {
    pub mod_name: String,
    pub mod_version: String,
    pub archive_path: String,
    pub strings: usize,
    pub total_source_strings: usize,
    pub outdated: usize,
    pub review_needed: usize,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VersionConflict {
    pub mod_name: String,
    pub version: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ZipPreview {
    pub package_name: String,
    pub selected_version: String,
    pub version_source: String,
    pub version_conflicts: Vec<VersionConflict>,
    pub default_file_name: String,
    pub target_lang: String,
    pub target_language: String,
    pub entries: Vec<ZipEntryPreview>,
    pub omitted_components: Vec<String>,
    pub warnings: Vec<String>,
    pub problems: Vec<ZipProblem>,
    pub total_strings: usize,
    pub total_source_strings: usize,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ZipBuildOutcome {
    pub path: String,
    pub folder: String,
    pub file_name: String,
    pub entries: usize,
    pub strings: usize,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ZipBuildRequest {
    pub mods_path: String,
    pub package_name: String,
    pub target_lang: String,
    pub target_language: String,
    pub components: Vec<ZipComponentInput>,
    pub destination: String,
    pub overwrite: bool,
}

struct PreparedEntry {
    preview: ZipEntryPreview,
    body: Vec<u8>,
}

struct PreparedPackage {
    preview: ZipPreview,
    entries: Vec<PreparedEntry>,
}

pub fn preview(
    config_dir: &Path,
    mods_path: &Path,
    package_name: &str,
    target_lang: &str,
    target_language: &str,
    components: &[ZipComponentInput],
) -> Result<ZipPreview, String> {
    Ok(prepare(
        config_dir,
        mods_path,
        package_name,
        target_lang,
        target_language,
        components,
    )?
    .preview)
}

pub fn build(config_dir: &Path, request: &ZipBuildRequest) -> Result<ZipBuildOutcome, String> {
    let destination = Path::new(&request.destination);
    if destination.extension().and_then(|value| value.to_str()) != Some("zip") {
        return Err("The destination must use the .zip extension.".to_string());
    }
    if destination.exists() && !request.overwrite {
        return Err("OVERWRITE_REQUIRED".to_string());
    }

    let prepared = prepare(
        config_dir,
        Path::new(&request.mods_path),
        &request.package_name,
        &request.target_lang,
        &request.target_language,
        &request.components,
    )?;
    if !prepared.preview.problems.is_empty() {
        return Err("Fix every blocking validation problem before building the ZIP.".to_string());
    }
    if prepared.entries.is_empty() {
        return Err("This package has no translated strings to include.".to_string());
    }

    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
    }
    let temp = sibling(destination, ".tmp");
    if temp.exists() {
        std::fs::remove_file(&temp)
            .map_err(|error| format!("Could not clear stale temp ZIP: {error}"))?;
    }

    let write_result = (|| -> Result<(), String> {
        let file = File::create(&temp)
            .map_err(|error| format!("Could not create temporary ZIP: {error}"))?;
        let mut writer = zip::ZipWriter::new(file);
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for entry in &prepared.entries {
            validate_archive_path(&entry.preview.archive_path)?;
            writer
                .start_file(&entry.preview.archive_path, options)
                .map_err(|error| format!("Could not add ZIP entry: {error}"))?;
            writer
                .write_all(&entry.body)
                .map_err(|error| format!("Could not write ZIP entry: {error}"))?;
        }
        writer
            .finish()
            .map_err(|error| format!("Could not finalize ZIP: {error}"))?;
        replace_file(&temp, destination, request.overwrite)
    })();
    if write_result.is_err() {
        std::fs::remove_file(&temp).ok();
    }
    write_result?;

    let file_name = destination
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_string();
    let folder = destination
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .display()
        .to_string();
    Ok(ZipBuildOutcome {
        path: destination.display().to_string(),
        folder,
        file_name,
        entries: prepared.entries.len(),
        strings: prepared.preview.total_strings,
    })
}

fn prepare(
    config_dir: &Path,
    mods_path: &Path,
    package_name: &str,
    target_lang: &str,
    target_language: &str,
    components: &[ZipComponentInput],
) -> Result<PreparedPackage, String> {
    validate_segment(package_name, "package folder")?;
    validate_segment(target_lang, "language code")?;
    if components.is_empty() {
        return Err("The selected package has no translatable components.".to_string());
    }
    let package_root = mods_path.join(package_name);
    let (selected_version, version_source) = select_version(&package_root, components)?;
    let version_conflicts = components
        .iter()
        .filter(|component| component.version != selected_version)
        .map(|component| VersionConflict {
            mod_name: component.name.clone(),
            version: component.version.clone(),
        })
        .collect::<Vec<_>>();
    let mut entries = Vec::new();
    let mut omitted_components = Vec::new();
    let mut warnings = Vec::new();
    let mut problems = Vec::new();
    let mut total_strings = 0;
    let mut total_source_strings = 0;

    for component in components {
        let component_root = Path::new(&component.folder_path);
        let relative_component = component_root.strip_prefix(&package_root).map_err(|_| {
            format!(
                "Component '{}' is outside the selected package root.",
                component.name
            )
        })?;
        validate_relative_path(relative_component)?;
        let state = translations::load(config_dir, &component.unique_id)?;
        let mut component_entries = 0;
        for file in &component.files {
            let relative_i18n = Path::new(&file.relative_dir);
            validate_relative_path(relative_i18n)?;
            let rows = scanner::load_strings(
                Path::new(&file.default_path),
                Path::new(&file.target_path),
                &state,
                &file.relative_dir,
            );
            let source_strings = rows.len();
            total_source_strings += source_strings;
            let mut output = Map::new();
            let mut outdated = 0;
            let mut review_needed = 0;
            for row in rows {
                if row.target.trim().is_empty() {
                    continue;
                }
                let differences = tokens::token_differences(&row.source, &row.target);
                if !differences.is_empty() {
                    let detail = differences
                        .iter()
                        .map(|difference| {
                            format!(
                                "{}: expected {}, found {}",
                                difference.token, difference.source_count, difference.target_count
                            )
                        })
                        .collect::<Vec<_>>()
                        .join("; ");
                    problems.push(ZipProblem {
                        mod_unique_id: component.unique_id.clone(),
                        mod_name: component.name.clone(),
                        relative_dir: file.relative_dir.clone(),
                        key: row.key,
                        reason: format!("token count mismatch ({detail})"),
                    });
                    continue;
                }
                if row.status == "outdated" {
                    outdated += 1;
                }
                if row.status == "review-needed" {
                    review_needed += 1;
                }
                output.insert(row.key, Value::String(row.target));
            }
            if output.is_empty() {
                continue;
            }
            let body = serialize_json(&output)?;
            let archive_path =
                archive_path(package_name, relative_component, relative_i18n, target_lang)?;
            let strings = output.len();
            total_strings += strings;
            component_entries += 1;
            let entry_preview = ZipEntryPreview {
                mod_name: component.name.clone(),
                mod_version: component.version.clone(),
                archive_path,
                strings,
                total_source_strings: source_strings,
                outdated,
                review_needed,
            };
            if outdated > 0 {
                warnings.push(format!(
                    "{} contains {outdated} outdated translation(s).",
                    component.name
                ));
            }
            if review_needed > 0 {
                warnings.push(format!(
                    "{} contains {review_needed} unreviewed AI suggestion(s).",
                    component.name
                ));
            }
            entries.push(PreparedEntry {
                preview: entry_preview,
                body,
            });
        }
        if component_entries == 0 {
            omitted_components.push(component.name.clone());
        }
    }

    entries.sort_by(|left, right| left.preview.archive_path.cmp(&right.preview.archive_path));
    let default_file_name = default_file_name(
        package_name,
        &selected_version,
        target_language,
        target_lang,
    );
    let preview = ZipPreview {
        package_name: package_name.to_string(),
        selected_version,
        version_source,
        version_conflicts,
        default_file_name,
        target_lang: target_lang.to_string(),
        target_language: target_language.to_string(),
        entries: entries.iter().map(|entry| entry.preview.clone()).collect(),
        omitted_components,
        warnings,
        problems,
        total_strings,
        total_source_strings,
    };
    Ok(PreparedPackage { preview, entries })
}

fn select_version(
    package_root: &Path,
    components: &[ZipComponentInput],
) -> Result<(String, String), String> {
    let mut candidates = components
        .iter()
        .map(|component| {
            let path = Path::new(&component.folder_path);
            let relative = path
                .strip_prefix(package_root)
                .map_err(|_| format!("Component '{}' is outside the package.", component.name))?;
            Ok((
                !relative.as_os_str().is_empty(),
                relative.to_string_lossy().replace('\\', "/"),
                component.unique_id.clone(),
                component,
            ))
        })
        .collect::<Result<Vec<_>, String>>()?;
    candidates.sort_by(|left, right| {
        left.0
            .cmp(&right.0)
            .then_with(|| left.1.cmp(&right.1))
            .then_with(|| left.2.cmp(&right.2))
    });
    let selected = candidates
        .first()
        .map(|candidate| candidate.3)
        .ok_or_else(|| "The package has no components.".to_string())?;
    Ok((selected.version.clone(), selected.name.clone()))
}

pub fn default_file_name(
    package_name: &str,
    version: &str,
    target_language: &str,
    target_lang: &str,
) -> String {
    sanitize_file_name(&format!(
        "{package_name} - {version} - {target_language} ({target_lang}).zip"
    ))
}

pub fn sanitize_file_name(value: &str) -> String {
    let mut sanitized = value
        .chars()
        .map(|character| {
            if character.is_control() || "<>:\"/\\|?*".contains(character) {
                '_'
            } else {
                character
            }
        })
        .collect::<String>();
    while sanitized.ends_with([' ', '.']) {
        sanitized.pop();
    }
    if sanitized.trim().is_empty() {
        "translation.zip".to_string()
    } else if sanitized.to_ascii_lowercase().ends_with(".zip") {
        sanitized
    } else {
        format!("{sanitized}.zip")
    }
}

fn archive_path(
    package_name: &str,
    component: &Path,
    relative_i18n: &Path,
    target_lang: &str,
) -> Result<String, String> {
    let mut parts = vec![package_name.to_string()];
    append_parts(&mut parts, component)?;
    append_parts(&mut parts, relative_i18n)?;
    parts.push(format!("{target_lang}.json"));
    let path = parts.join("/");
    validate_archive_path(&path)?;
    Ok(path)
}

fn append_parts(parts: &mut Vec<String>, path: &Path) -> Result<(), String> {
    for component in path.components() {
        match component {
            Component::Normal(value) => {
                let value = value
                    .to_str()
                    .ok_or_else(|| "Archive paths must be valid UTF-8.".to_string())?;
                validate_segment(value, "archive path")?;
                parts.push(value.to_string());
            }
            Component::CurDir if path.as_os_str().is_empty() => {}
            _ => return Err("Archive paths must be relative and cannot contain '..'.".to_string()),
        }
    }
    Ok(())
}

fn validate_relative_path(path: &Path) -> Result<(), String> {
    if path.is_absolute() {
        return Err("Archive source paths must be relative.".to_string());
    }
    for component in path.components() {
        if !matches!(component, Component::Normal(_)) {
            return Err("Archive paths cannot contain '.' or '..'.".to_string());
        }
    }
    Ok(())
}

fn validate_archive_path(path: &str) -> Result<(), String> {
    if path.starts_with('/') || path.starts_with('\\') || path.contains('\\') {
        return Err("ZIP entries must use relative '/' paths.".to_string());
    }
    for segment in path.split('/') {
        validate_segment(segment, "ZIP entry")?;
    }
    Ok(())
}

fn validate_segment(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty() || value == "." || value == ".." || value.contains(['/', '\\']) {
        return Err(format!("Invalid {label}: '{value}'."));
    }
    Ok(())
}

fn serialize_json(map: &Map<String, Value>) -> Result<Vec<u8>, String> {
    let mut body = serde_json::to_string_pretty(map)
        .map_err(|error| format!("Could not serialize translation JSON: {error}"))?;
    body.push('\n');
    serde_json::from_str::<Value>(&body)
        .map_err(|error| format!("Generated invalid JSON: {error}"))?;
    Ok(body.into_bytes())
}

fn replace_file(temp: &Path, destination: &Path, overwrite: bool) -> Result<(), String> {
    if !destination.exists() {
        return std::fs::rename(temp, destination)
            .map_err(|error| format!("Could not finalize {}: {error}", destination.display()));
    }
    if !overwrite {
        return Err("OVERWRITE_REQUIRED".to_string());
    }
    let backup = sibling(destination, ".replace-backup");
    std::fs::remove_file(&backup).ok();
    std::fs::rename(destination, &backup)
        .map_err(|error| format!("Could not prepare existing ZIP for replacement: {error}"))?;
    if let Err(error) = std::fs::rename(temp, destination) {
        let _ = std::fs::rename(&backup, destination);
        return Err(format!(
            "Could not replace {}: {error}",
            destination.display()
        ));
    }
    std::fs::remove_file(backup).ok();
    Ok(())
}

fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path
        .file_name()
        .map(|value| value.to_os_string())
        .unwrap_or_default();
    name.push(suffix);
    path.with_file_name(name)
}

#[cfg(test)]
mod tests {
    use std::io::Read;

    use super::*;

    fn write(path: &Path, body: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    fn component(
        package: &Path,
        folder: &str,
        unique_id: &str,
        version: &str,
    ) -> ZipComponentInput {
        let root = package.join(folder);
        let i18n = root.join("i18n");
        write(&i18n.join("default.json"), r#"{"hello":"Hello {{name}}"}"#);
        ZipComponentInput {
            unique_id: unique_id.to_string(),
            name: folder.to_string(),
            version: version.to_string(),
            folder_path: root.display().to_string(),
            files: vec![ExportFileInput {
                relative_dir: "i18n".to_string(),
                default_path: i18n.join("default.json").display().to_string(),
                target_path: i18n.join("de.json").display().to_string(),
            }],
        }
    }

    fn save_translation(config: &Path, unique_id: &str, target: &str) {
        translations::save_one(
            config,
            unique_id,
            translations::entry_key("i18n", "hello"),
            translations::StoredString {
                target: target.to_string(),
                status: "translated".to_string(),
                source_hash: translations::source_hash("Hello {{name}}"),
            },
        )
        .unwrap();
    }

    fn request(
        mods: &Path,
        package_name: &str,
        components: Vec<ZipComponentInput>,
        destination: &Path,
        overwrite: bool,
    ) -> ZipBuildRequest {
        ZipBuildRequest {
            mods_path: mods.display().to_string(),
            package_name: package_name.to_string(),
            target_lang: "de".to_string(),
            target_language: "German".to_string(),
            components,
            destination: destination.display().to_string(),
            overwrite,
        }
    }

    #[test]
    fn builds_multi_component_overlay_with_only_generated_i18n_files() {
        let root = crate::test_support::temp_dir("release-zip-multi");
        let mods = root.join("Mods");
        let package = mods.join("Sample Pack");
        let config = root.join("Data");
        let components = vec![
            component(&package, "[CP] Sample", "sample.cp", "2.0"),
            component(&package, "[JA] Sample", "sample.ja", "1.5"),
        ];
        save_translation(&config, "sample.cp", "Hallo {{name}}");
        save_translation(&config, "sample.ja", "Guten Tag {{name}}");
        write(&package.join("[CP] Sample/manifest.json"), "{}");
        write(
            &package.join("[CP] Sample/assets/map.png"),
            "not really an image",
        );

        let destination = root.join("translation.zip");
        let outcome = build(
            &config,
            &request(
                &mods,
                "Sample Pack",
                components.clone(),
                &destination,
                false,
            ),
        )
        .unwrap();
        assert_eq!(outcome.entries, 2);

        let file = File::open(&destination).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let mut names = (0..archive.len())
            .map(|index| archive.by_index(index).unwrap().name().to_string())
            .collect::<Vec<_>>();
        names.sort();
        assert_eq!(
            names,
            vec![
                "Sample Pack/[CP] Sample/i18n/de.json",
                "Sample Pack/[JA] Sample/i18n/de.json"
            ]
        );
        let mut body = String::new();
        archive
            .by_name("Sample Pack/[CP] Sample/i18n/de.json")
            .unwrap()
            .read_to_string(&mut body)
            .unwrap();
        assert!(body.contains("Hallo {{name}}"));
        assert!(!names.iter().any(|name| name.contains("manifest")));
        assert!(!names.iter().any(|name| name.contains("assets")));
        assert!(!package.join("[CP] Sample/i18n/de.json").exists());
        let preview = preview(&config, &mods, "Sample Pack", "de", "German", &components).unwrap();
        assert_eq!(preview.total_strings, 2);
        assert_eq!(preview.total_source_strings, 2);
        assert_eq!(preview.entries[0].mod_version, "2.0");
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn blocks_token_mismatches_and_leaves_no_partial_zip() {
        let root = crate::test_support::temp_dir("release-zip-blocked");
        let mods = root.join("Mods");
        let package = mods.join("Pack");
        let config = root.join("Data");
        let components = vec![component(&package, "", "sample.root", "1.0")];
        save_translation(&config, "sample.root", "Hallo");
        let destination = root.join("blocked.zip");
        let error = build(
            &config,
            &request(&mods, "Pack", components, &destination, false),
        )
        .unwrap_err();
        assert!(error.contains("blocking"));
        assert!(!destination.exists());
        assert!(!sibling(&destination, ".tmp").exists());
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn filename_is_windows_safe_and_version_rule_is_deterministic() {
        assert_eq!(
            default_file_name("Pack: Name", "1.0/2", "German", "de"),
            "Pack_ Name - 1.0_2 - German (de).zip"
        );
        let root = crate::test_support::temp_dir("release-zip-version");
        let mods = root.join("Mods");
        let package = mods.join("Pack");
        let config = root.join("Data");
        let components = vec![
            component(&package, "Z Child", "z.child", "9.0"),
            component(&package, "A Child", "a.child", "2.0"),
        ];
        let preview = preview(&config, &mods, "Pack", "de", "German", &components).unwrap();
        assert_eq!(preview.selected_version, "2.0");
        assert_eq!(preview.version_source, "A Child");
        assert_eq!(preview.version_conflicts.len(), 1);
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn rejects_traversal_and_requires_explicit_overwrite() {
        assert!(validate_archive_path("../escape.json").is_err());
        assert!(validate_archive_path("Pack\\i18n\\de.json").is_err());
        let root = crate::test_support::temp_dir("release-zip-overwrite");
        let mods = root.join("Mods");
        let package = mods.join("Pack");
        let config = root.join("Data");
        let components = vec![component(&package, "", "sample.root", "1.0")];
        save_translation(&config, "sample.root", "Hallo {{name}}");
        let destination = root.join("translation.zip");
        write(&destination, "existing");
        let error = build(
            &config,
            &request(&mods, "Pack", components, &destination, false),
        )
        .unwrap_err();
        assert_eq!(error, "OVERWRITE_REQUIRED");
        assert_eq!(std::fs::read_to_string(&destination).unwrap(), "existing");
        std::fs::remove_dir_all(root).ok();
    }
}
