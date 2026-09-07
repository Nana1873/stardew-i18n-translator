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
    source_checks: Vec<(PathBuf, String)>,
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
    write_prepared(prepared, destination, request.overwrite)
}

fn write_prepared(
    prepared: PreparedPackage,
    destination: &Path,
    overwrite: bool,
) -> Result<ZipBuildOutcome, String> {
    if destination.extension().and_then(|value| value.to_str()) != Some("zip") {
        return Err("The destination must use the .zip extension.".to_string());
    }
    if destination.exists() && !overwrite {
        return Err("OVERWRITE_REQUIRED".to_string());
    }
    let mut paths = std::collections::HashSet::new();
    for entry in &prepared.entries {
        if !paths.insert(entry.preview.archive_path.to_lowercase()) {
            return Err("Duplicate translation ZIP output path.".into());
        }
    }
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
        for (path, expected) in &prepared.source_checks {
            let current = crate::input_limits::read_json_text(path)?;
            if translations::source_hash(&current) != *expected {
                return Err(
                    "A source file changed while preparing the output. Scan again and retry."
                        .into(),
                );
            }
        }
        replace_file(&temp, destination, overwrite)
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
    let target_lang = crate::language::normalize_target_code(target_lang)?;
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
            let output_unit = if let Some((root, _)) = file.relative_dir.split_once("/@split/") {
                let target =
                    scanner::split_target_path(Path::new(&file.default_path), &target_lang)?;
                format!(
                    "{root}/@split/{}",
                    target
                        .file_name()
                        .and_then(|name| name.to_str())
                        .ok_or("Invalid split target filename.")?
                )
            } else {
                file.relative_dir.clone()
            };
            let relative_i18n = Path::new(&output_unit);
            validate_relative_path(relative_i18n)?;
            let rows = scanner::load_strings_checked(
                Path::new(&file.default_path),
                Path::new(&file.target_path),
                &state,
                &file.relative_dir,
            )?;
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
                if !differences.is_empty() && !row.token_mismatch_accepted {
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
            let archive_path = archive_path(
                package_name,
                relative_component,
                relative_i18n,
                &target_lang,
            )?;
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
        &target_lang,
    );
    let preview = ZipPreview {
        package_name: package_name.to_string(),
        selected_version,
        version_source,
        version_conflicts,
        default_file_name,
        target_lang,
        target_language: target_language.to_string(),
        entries: entries.iter().map(|entry| entry.preview.clone()).collect(),
        omitted_components,
        warnings,
        problems,
        total_strings,
        total_source_strings,
    };
    Ok(PreparedPackage {
        preview,
        entries,
        source_checks: Vec::new(),
    })
}

pub(crate) fn preview_output(config: &Path) -> Result<ZipPreview, String> {
    Ok(prepare_output(config)?.preview)
}

pub(crate) fn build_output(
    config: &Path,
    destination: &Path,
    overwrite: bool,
) -> Result<ZipBuildOutcome, String> {
    let settings = crate::settings::load_checked(config)?;
    let (mods, _) = output_context(&settings)?;
    let mut existing_parent = destination
        .parent()
        .ok_or("Choose an output destination folder.")?;
    while !existing_parent.exists() {
        existing_parent = existing_parent
            .parent()
            .ok_or("Choose an existing output destination folder.")?;
    }
    let parent = std::fs::canonicalize(existing_parent)
        .map_err(|e| format!("Could not inspect output folder: {e}"))?;
    for protected in std::iter::once(mods).chain(settings.stardew_path.map(PathBuf::from)) {
        let protected = std::fs::canonicalize(protected)
            .map_err(|e| format!("Could not inspect game folder: {e}"))?;
        if parent.starts_with(protected) {
            return Err("Save Stardew Translator Output outside the game and Mods folders.".into());
        }
    }
    if std::fs::symlink_metadata(destination)
        .is_ok_and(|metadata| !metadata.is_file() || metadata.file_type().is_symlink())
    {
        return Err("The output destination must be a regular ZIP file.".into());
    }
    write_prepared(prepare_output(config)?, destination, overwrite)
}

fn output_context(settings: &crate::settings::AppSettings) -> Result<(PathBuf, String), String> {
    let mods = settings
        .mods_path
        .as_ref()
        .map(PathBuf::from)
        .or_else(|| {
            settings
                .stardew_path
                .as_ref()
                .map(|path| crate::detection::mods_path_for(Path::new(path)))
        })
        .ok_or("Configure the Mods folder before exporting Stardew Translator Output.")?;
    let language = crate::language::normalize_target_code(
        settings
            .target_lang
            .as_deref()
            .ok_or("Choose a target language before exporting.")?,
    )?;
    Ok((mods, language))
}

fn prepare_output(config: &Path) -> Result<PreparedPackage, String> {
    let (mods, language) = output_context(&crate::settings::load_checked(config)?)?;
    let scan = scanner::scan_mods(&mods, &language, config);
    if !scan.traversal_complete
        || scan
            .skipped_components
            .iter()
            .any(|item| item.requires_attention)
    {
        return Err("Resolve scan errors before exporting Stardew Translator Output.".into());
    }
    let working = translations::language_root(config, &language)?;
    let mut prepared = PreparedPackage {
        preview: ZipPreview {
            package_name: "Stardew Translator Output".into(),
            selected_version: String::new(), version_source: String::new(), version_conflicts: Vec::new(),
            default_file_name: format!("Stardew Translator Output - {language}.zip"),
            target_lang: language.clone(), target_language: language.clone(),
            entries: Vec::new(), omitted_components: Vec::new(),
            warnings: vec!["Includes current local translations across the scanned mods, with saved working translations taking priority. Untranslated and obsolete keys are omitted.".into()],
            problems: Vec::new(), total_strings: 0, total_source_strings: 0,
        },
        entries: Vec::new(), source_checks: Vec::new(),
    };
    let mut identities = std::collections::HashSet::new();
    let mut paths = std::collections::HashSet::new();
    for component in scan.mods {
        if !identities.insert(component.unique_id.to_lowercase()) {
            return Err("Ambiguous component identity in the current scan.".into());
        }
        let state = translations::load(&working, &component.unique_id)?;
        let mut component_entries = 0;
        for file in component.i18n_files {
            let input = ExportFileInput {
                relative_dir: file.relative_dir.clone(),
                default_path: file.default_path.clone(),
                target_path: file.target_path.clone(),
            };
            crate::export::validate_paths(&mods, &language, std::slice::from_ref(&input))?;
            let relative_target = Path::new(&file.target_path)
                .strip_prefix(&mods)
                .map_err(|_| "Output path is outside the Mods folder.")?;
            let mut parts = Vec::new();
            append_parts(&mut parts, relative_target)?;
            let archive_path = parts.join("/");
            validate_archive_path(&archive_path)?;
            if !paths.insert(archive_path.to_lowercase()) {
                return Err("Duplicate translation ZIP output path.".into());
            }
            let source_path = Path::new(&file.default_path);
            let source_text = crate::input_limits::read_json_text(source_path)?;
            let rows = scanner::load_strings_checked(
                source_path,
                Path::new(&file.target_path),
                &state,
                &file.relative_dir,
            )?;
            prepared.source_checks.push((
                source_path.to_path_buf(),
                translations::source_hash(&source_text),
            ));
            let mut output = Map::new();
            let mut review_needed = 0;
            let mut outdated = 0;
            let mut source_count = 0;
            for row in rows {
                if row.source.trim().is_empty() {
                    continue;
                }
                source_count += 1;
                if row.target.trim().is_empty() {
                    continue;
                }
                let reason = if !row.token_mismatch_accepted
                    && !tokens::token_differences(&row.source, &row.target).is_empty()
                {
                    Some(
                        "Protected-token mismatch. Review the translation before exporting."
                            .to_owned(),
                    )
                } else {
                    None
                };
                if let Some(reason) = reason {
                    prepared.preview.problems.push(ZipProblem {
                        mod_unique_id: component.unique_id.clone(),
                        mod_name: component.name.clone(),
                        relative_dir: file.relative_dir.clone(),
                        key: row.key,
                        reason,
                    });
                    continue;
                }
                if row.status == "review-needed" {
                    review_needed += 1;
                }
                if row.status == "outdated" {
                    outdated += 1;
                }
                output.insert(row.key, Value::String(row.target));
            }
            if output.is_empty() {
                continue;
            }
            prepared.preview.total_source_strings += source_count;
            prepared.preview.total_strings += output.len();
            if outdated > 0 {
                prepared.preview.warnings.push(format!(
                    "{} contains {outdated} outdated translation(s).",
                    component.name
                ));
            }
            if review_needed > 0 {
                prepared.preview.warnings.push(format!(
                    "{} contains {review_needed} unreviewed AI suggestion(s).",
                    component.name
                ));
            }
            let preview = ZipEntryPreview {
                mod_name: component.name.clone(),
                mod_version: component.version.clone(),
                archive_path,
                strings: output.len(),
                total_source_strings: source_count,
                outdated,
                review_needed,
            };
            prepared.entries.push(PreparedEntry {
                preview,
                body: serialize_json(&output)?,
            });
            component_entries += 1;
        }
        if component_entries == 0 {
            prepared.preview.omitted_components.push(component.name);
        }
    }
    prepared
        .entries
        .sort_by(|a, b| a.preview.archive_path.cmp(&b.preview.archive_path));
    prepared.preview.entries = prepared
        .entries
        .iter()
        .map(|entry| entry.preview.clone())
        .collect();
    Ok(prepared)
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
    let unit = relative_i18n.to_string_lossy().replace('\\', "/");
    if let Some((root, name)) = unit.split_once("/@split/") {
        append_parts(&mut parts, Path::new(root))?;
        if name.contains('/') {
            return Err("Invalid split translation filename.".into());
        }
        parts.push(target_lang.to_owned());
        parts.push(name.to_owned());
    } else {
        append_parts(&mut parts, relative_i18n)?;
        parts.push(format!("{target_lang}.json"));
    }
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
    crate::input_limits::ensure_json_output_size(body.len() as u64, "Release ZIP entry JSON")?;
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

    fn output_fixture(label: &str) -> (PathBuf, PathBuf, PathBuf) {
        let root = crate::test_support::temp_dir(label);
        let config = root.join("data");
        let mods = root.join("Mods");
        std::fs::create_dir_all(&mods).unwrap();
        crate::settings::save(
            &config,
            &crate::settings::AppSettings {
                mods_path: Some(mods.display().to_string()),
                target_lang: Some("de".into()),
                ..Default::default()
            },
        )
        .unwrap();
        (root, config, mods)
    }

    fn output_component(mods: &Path, folder: &str, id: &str, source: &str) -> PathBuf {
        let path = mods.join(folder);
        write(&path.join("manifest.json"), &serde_json::json!({"Name": id, "Author": "Fixture", "Version": "1.0.0", "Description": "Fixture", "UniqueID": id, "ContentPackFor": {"UniqueID": "Pathoschild.ContentPatcher"}}).to_string());
        write(&path.join("i18n/default.json"), source);
        path
    }

    fn output_state(
        config: &Path,
        id: &str,
        unit: &str,
        key: &str,
        source: &str,
        target: &str,
        status: &str,
    ) {
        let working = translations::language_root(config, "de").unwrap();
        translations::save_one(
            &working,
            id,
            translations::entry_key(unit, key),
            translations::StoredString {
                source_hash: translations::source_hash(source),
                target: target.into(),
                status: status.into(),
            },
        )
        .unwrap();
    }

    fn zip_documents(path: &Path) -> std::collections::BTreeMap<String, Value> {
        let mut zip = zip::ZipArchive::new(File::open(path).unwrap()).unwrap();
        let mut result = std::collections::BTreeMap::new();
        for i in 0..zip.len() {
            let mut entry = zip.by_index(i).unwrap();
            let mut body = String::new();
            entry.read_to_string(&mut body).unwrap();
            result.insert(
                entry.name().to_owned(),
                serde_json::from_str(&body).unwrap(),
            );
        }
        result
    }

    #[test]
    fn output_preserves_local_values_and_saved_overrides_at_actual_mod_paths() {
        let (root, config, mods) = output_fixture("output-saved-only");
        let first = output_component(
            &mods,
            "Pack/[CP] First",
            "Fixture.First",
            r#"{"manual":"Hello @","ai":"Goodbye","import":"Thanks","blank":"","deployed":"On disk only"}"#,
        );
        write(
            &first.join("i18n/de.json"),
            r#"{"manual":"Old @","deployed":"Keep local translation","obsolete":"Omit orphan"}"#,
        );
        write(&first.join("mod.dll"), "not an assembly");
        write(&first.join("assets/map.png"), "not an asset");
        output_state(
            &config,
            "Fixture.First",
            "i18n",
            "manual",
            "Hello @",
            "Hallo @",
            "translated",
        );
        output_state(
            &config,
            "Fixture.First",
            "i18n",
            "ai",
            "Goodbye",
            "Tschüss",
            "review-needed",
        );
        output_state(
            &config,
            "Fixture.First",
            "i18n",
            "import",
            "Thanks",
            "Danke",
            "translated",
        );
        output_state(
            &config,
            "Fixture.First",
            "i18n",
            "blank",
            "",
            "Old invalid saved value",
            "translated",
        );
        let second = output_component(&mods, "Second", "Fixture.Second", r#"{"keep":"Same"}"#);
        output_state(
            &config,
            "Fixture.Second",
            "i18n",
            "keep",
            "Same",
            "Same",
            "translated",
        );
        let disk = output_component(&mods, "DiskOnly", "Fixture.Disk", r#"{"hello":"Hello"}"#);
        write(&disk.join("i18n/de.json"), r#"{"hello":"Hallo"}"#);
        output_component(
            &mods,
            "Untranslated",
            "Fixture.Empty",
            r#"{"missing":"Never copy source"}"#,
        );
        let destination = root.join("output.zip");
        let preview = preview_output(&config).unwrap();
        assert_eq!(preview.total_strings, 6);
        assert_eq!(
            preview
                .entries
                .iter()
                .map(|entry| entry.review_needed)
                .sum::<usize>(),
            1
        );
        assert!(preview.problems.is_empty());
        build_output(&config, &destination, false).unwrap();
        let documents = zip_documents(&destination);
        assert_eq!(documents.len(), 3);
        assert_eq!(
            documents["Pack/[CP] First/i18n/de.json"],
            serde_json::json!({"manual":"Hallo @","ai":"Tschüss","import":"Danke","deployed":"Keep local translation"})
        );
        assert_eq!(
            documents["Second/i18n/de.json"],
            serde_json::json!({"keep":"Same"})
        );
        assert!(!second.join("i18n/de.json").exists());
        assert_eq!(
            documents["DiskOnly/i18n/de.json"],
            serde_json::json!({"hello":"Hallo"})
        );
        assert!(!documents
            .keys()
            .any(|path| path.starts_with("Untranslated/")));
        assert!(std::fs::read_to_string(first.join("i18n/de.json"))
            .unwrap()
            .contains("Omit orphan"));
    }

    #[test]
    fn output_preserves_resolved_split_locale_filename() {
        let (root, config, mods) = output_fixture("output-split");
        let path = output_component(&mods, "Split", "Fixture.Split", "{}");
        std::fs::remove_file(path.join("i18n/default.json")).unwrap();
        write(
            &path.join("i18n/default/Dialogue.json"),
            r#"{"hello":"Hello"}"#,
        );
        write(
            &path.join("i18n/de/GermanDialogue.json"),
            r#"{"hello":"Old"}"#,
        );
        output_state(
            &config,
            "Fixture.Split",
            "i18n/@split/Dialogue.json",
            "hello",
            "Hello",
            "Hallo",
            "translated",
        );
        let destination = root.join("output.zip");
        build_output(&config, &destination, false).unwrap();
        assert_eq!(
            zip_documents(&destination),
            std::collections::BTreeMap::from([(
                "Split/i18n/de/GermanDialogue.json".into(),
                serde_json::json!({"hello":"Hallo"})
            )])
        );
        let single = root.join("single.zip");
        build(
            &translations::language_root(&config, "de").unwrap(),
            &ZipBuildRequest {
                mods_path: mods.display().to_string(),
                package_name: "Split".into(),
                target_lang: "de".into(),
                target_language: "German".into(),
                components: vec![ZipComponentInput {
                    unique_id: "Fixture.Split".into(),
                    name: "Split".into(),
                    version: "1.0.0".into(),
                    folder_path: path.display().to_string(),
                    files: vec![ExportFileInput {
                        relative_dir: "i18n/@split/Dialogue.json".into(),
                        default_path: path
                            .join("i18n/default/Dialogue.json")
                            .display()
                            .to_string(),
                        target_path: path
                            .join("i18n/de/GermanDialogue.json")
                            .display()
                            .to_string(),
                    }],
                }],
                destination: single.display().to_string(),
                overwrite: false,
            },
        )
        .unwrap();
        assert_eq!(zip_documents(&single), zip_documents(&destination));
    }

    #[test]
    fn output_rejects_case_insensitive_collisions_before_replacing_artifact() {
        let (root, config, mods) = output_fixture("output-collision");
        for name in ["First", "Second"] {
            let path = output_component(&mods, name, name, r#"{"hello":"Hello"}"#);
            write(&path.join("i18n/de.json"), r#"{"hello":"Hallo"}"#);
        }
        let mut prepared = prepare_output(&config).unwrap();
        prepared.entries[1].preview.archive_path =
            prepared.entries[0].preview.archive_path.to_uppercase();
        let destination = root.join("output.zip");
        write(&destination, "prior artifact");
        assert!(write_prepared(prepared, &destination, true).is_err());
        assert_eq!(std::fs::read(destination).unwrap(), b"prior artifact");
    }

    #[test]
    fn output_blocks_token_errors_without_replacing_prior_artifact() {
        let (root, config, mods) = output_fixture("output-blocked");
        output_component(
            &mods,
            "Example",
            "Fixture.Example",
            r#"{"hello":"Hello @","changed":"New"}"#,
        );
        output_state(
            &config,
            "Fixture.Example",
            "i18n",
            "hello",
            "Hello @",
            "Hallo",
            "translated",
        );
        output_state(
            &config,
            "Fixture.Example",
            "i18n",
            "changed",
            "Old",
            "Alt",
            "translated",
        );
        let destination = root.join("output.zip");
        write(&destination, "prior artifact");
        let preview = preview_output(&config).unwrap();
        assert_eq!(preview.problems.len(), 1);
        assert_eq!(preview.problems[0].key, "hello");
        assert_eq!(preview.entries[0].outdated, 1);
        assert!(build_output(&config, &destination, true).is_err());
        assert_eq!(std::fs::read(&destination).unwrap(), b"prior artifact");
        assert!(!sibling(&destination, ".tmp").exists());
    }

    #[test]
    fn output_includes_changed_and_review_values_with_warnings_without_approving_them() {
        let (root, config, mods) = output_fixture("output-changed-warning");
        output_component(
            &mods,
            "Example",
            "Fixture.Example",
            r#"{"changed":"Hello again @","review":"Goodbye"}"#,
        );
        output_state(
            &config,
            "Fixture.Example",
            "i18n",
            "changed",
            "Hello @",
            "Hallo @",
            "translated",
        );
        output_state(
            &config,
            "Fixture.Example",
            "i18n",
            "review",
            "Goodbye",
            "Tschüss",
            "review-needed",
        );
        let working = translations::language_root(&config, "de").unwrap();
        let before = translations::load(&working, "Fixture.Example").unwrap();
        let preview = preview_output(&config).unwrap();
        assert!(preview.problems.is_empty());
        assert_eq!(preview.entries[0].outdated, 1);
        assert_eq!(preview.entries[0].review_needed, 1);
        assert!(preview
            .warnings
            .iter()
            .any(|warning| warning.contains("1 outdated")));
        assert!(preview
            .warnings
            .iter()
            .any(|warning| warning.contains("1 unreviewed")));
        let destination = root.join("output.zip");
        build_output(&config, &destination, false).unwrap();
        assert_eq!(
            zip_documents(&destination)["Example/i18n/de.json"],
            serde_json::json!({"changed":"Hallo @", "review":"Tschüss"})
        );
        assert_eq!(
            translations::load(&working, "Fixture.Example").unwrap(),
            before
        );
    }

    #[test]
    fn output_respects_current_explicit_token_acceptance_and_rechecks_sources() {
        let (root, config, mods) = output_fixture("output-accepted-current");
        let component = output_component(
            &mods,
            "Example",
            "Fixture.Example",
            r#"{"hello":"Hello @"}"#,
        );
        output_state(
            &config,
            "Fixture.Example",
            "i18n",
            "hello",
            "Hello @",
            "Hallo",
            translations::TOKEN_MISMATCH_ACCEPTED_STATUS,
        );
        let destination = root.join("output.zip");
        build_output(&config, &destination, false).unwrap();
        let prior = std::fs::read(&destination).unwrap();
        let prepared = prepare_output(&config).unwrap();
        write(
            &component.join("i18n/default.json"),
            r#"{"hello":"Changed @"}"#,
        );
        assert!(write_prepared(prepared, &destination, true)
            .unwrap_err()
            .contains("changed"));
        assert_eq!(std::fs::read(&destination).unwrap(), prior);
        assert!(!sibling(&destination, ".tmp").exists());
        assert_eq!(preview_output(&config).unwrap().problems.len(), 1);
    }

    #[test]
    fn output_refuses_game_destination_and_ambiguous_components() {
        let (root, config, mods) = output_fixture("output-paths");
        output_component(&mods, "Example", "Fixture.Example", r#"{"hello":"Hello"}"#);
        output_state(
            &config,
            "Fixture.Example",
            "i18n",
            "hello",
            "Hello",
            "Hallo",
            "translated",
        );
        assert!(build_output(&config, &mods.join("output.zip"), false)
            .unwrap_err()
            .contains("outside"));
        assert!(!mods.join("output.zip").exists());
        output_component(
            &mods,
            "Duplicate",
            "Fixture.Example",
            r#"{"hello":"Hello"}"#,
        );
        assert!(build_output(&config, &root.join("output.zip"), false).is_err());
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
        let config = root.join("data");
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
        let config = root.join("data");
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
    fn accepted_token_mismatch_can_be_built_into_a_zip() {
        let root = crate::test_support::temp_dir("release-zip-accepted-token");
        let mods = root.join("Mods");
        let package = mods.join("Pack");
        let config = root.join("data");
        let components = vec![component(&package, "", "sample.root", "1.0")];
        translations::save_one(
            &config,
            "sample.root",
            translations::entry_key("i18n", "hello"),
            translations::StoredString {
                target: "Hallo".into(),
                status: translations::TOKEN_MISMATCH_ACCEPTED_STATUS.into(),
                source_hash: translations::source_hash("Hello {{name}}"),
            },
        )
        .unwrap();

        let destination = root.join("accepted.zip");
        let outcome = build(
            &config,
            &request(&mods, "Pack", components, &destination, false),
        )
        .unwrap();
        assert_eq!(outcome.strings, 1);
        assert!(destination.exists());

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
        let config = root.join("data");
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
        let config = root.join("data");
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
