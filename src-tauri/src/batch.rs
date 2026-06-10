//! Claude-Code batch export/import — M4 (SPEC §11).
//!
//! Export writes a self-contained JSON batch (instructions for the external
//! LLM, a glossary excerpt, and the selected source strings grouped by i18n
//! directory). The user runs Claude Code / any LLM on it offline — the app
//! makes **no** network calls here. Import reads the result file back, matches
//! keys against the current `default.json`, and stages every accepted value as
//! **`review-needed`** (machine output always needs a human pass, SPEC §19 #2).
//!
//! Safety rules on import:
//!  - Strings that are now `translated` / `not-translatable` are **never**
//!    overwritten (a stale batch must not clobber newer manual work) — they
//!    are skipped and counted.
//!  - Dropped protected tokens and identical-to-source values are imported
//!    anyway (flagged, never auto-rejected, per the M4 acceptance criteria) —
//!    the counts surface in the summary and the rows show validation errors.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::glossary::{self, Glossary};
use crate::scanner::StringRow;
use crate::tokens;
use crate::translations::{self, StoredString};

pub const BATCH_FORMAT: &str = "stardew-translator-claude-batch";
pub const RESULT_FORMAT: &str = "stardew-translator-claude-result";

/// Cap for the glossary excerpt embedded in a batch file.
const MAX_GLOSSARY_TERMS: usize = 60;

/// One string selected for batch export (mirrors the frontend payload).
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BatchExportItem {
    pub relative_dir: String,
    pub key: String,
    pub source: String,
}

/// The instruction block embedded at the top of every batch file. Written so
/// the user can hand the whole file to Claude Code (or any LLM) verbatim.
fn instructions(target_language: &str) -> String {
    format!(
        "Translate the Stardew Valley mod strings in `files` from English into \
         {target_language}. Translate ONLY the string values; never change keys, \
         structure, or anything outside `files`. Preserve every placeholder/token \
         EXACTLY as written and untranslated: {{{{Token}}}}, {{0}}, $b, #$b#, \
         ${{male^female}}$, [anything in brackets], %item ... %%, @, ^, and line \
         breaks. Use the `glossary` translations for official game terms. Reply by \
         writing ONE JSON file with this exact shape: {{ \"format\": \
         \"{RESULT_FORMAT}\", \"version\": 1, \"files\": {{ <same structure as the \
         input, with every value translated> }} }}."
    )
}

/// Build the export batch JSON. Pure (no I/O) so it is unit-tested. The
/// glossary excerpt contains only official terms that actually occur in the
/// exported strings (whole-word matched), capped at [`MAX_GLOSSARY_TERMS`].
pub fn build_batch(
    mod_name: &str,
    mod_unique_id: &str,
    target_lang: &str,
    target_language: &str,
    items: &[BatchExportItem],
    glossary: Option<&Glossary>,
) -> Value {
    // Group by i18n directory, preserving the item order within each group.
    let mut files: Map<String, Value> = Map::new();
    for item in items {
        let entry = files
            .entry(item.relative_dir.clone())
            .or_insert_with(|| Value::Object(Map::new()));
        if let Some(group) = entry.as_object_mut() {
            group.insert(item.key.clone(), Value::String(item.source.clone()));
        }
    }

    // Glossary excerpt: every official term matched by any exported string.
    let mut excerpt: Map<String, Value> = Map::new();
    if let Some(glossary) = glossary {
        let mut pairs: Vec<(String, String)> = Vec::new();
        for item in items {
            pairs.extend(glossary::match_terms(&item.source, glossary));
        }
        pairs.sort();
        pairs.dedup();
        for (en, target) in pairs.into_iter().take(MAX_GLOSSARY_TERMS) {
            excerpt.insert(en, Value::String(target));
        }
    }

    let mut metadata = Map::new();
    metadata.insert("mod".into(), Value::String(mod_name.to_string()));
    metadata.insert(
        "modUniqueId".into(),
        Value::String(mod_unique_id.to_string()),
    );
    metadata.insert("sourceLang".into(), Value::String("en".to_string()));
    metadata.insert("targetLang".into(), Value::String(target_lang.to_string()));
    metadata.insert(
        "exportedAt".into(),
        Value::String(now_iso8601()),
    );

    let mut root = Map::new();
    root.insert("format".into(), Value::String(BATCH_FORMAT.to_string()));
    root.insert("version".into(), Value::from(1));
    root.insert("metadata".into(), Value::Object(metadata));
    root.insert(
        "instructions".into(),
        Value::String(instructions(target_language)),
    );
    root.insert("glossary".into(), Value::Object(excerpt));
    root.insert("files".into(), Value::Object(files));
    Value::Object(root)
}

/// Current UTC time as ISO-8601 (no external chrono dependency).
fn now_iso8601() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Civil-date conversion (days since 1970-01-01, proleptic Gregorian).
    let days = secs / 86_400;
    let (h, m, s) = ((secs / 3600) % 24, (secs / 60) % 60, secs % 60);
    let mut z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    z = z.rem_euclid(146_097);
    let yoe = (z - z / 1460 + z / 36_524 - z / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = z - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mo <= 2 { y + 1 } else { y };
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    /// Values staged as `review-needed`.
    pub imported: usize,
    /// Untouched: the string is now `translated`/`not-translatable` locally
    /// (a stale batch never overwrites newer manual work).
    pub skipped_translated: usize,
    /// Entries that matched nothing: unknown directory/key, non-string or
    /// empty value.
    pub unmatched: usize,
    /// Imported, but missing a protected token vs. the current source —
    /// the row shows a validation error and export would skip it until fixed.
    pub token_issues: usize,
    /// Imported, but byte-identical to the English source (probably
    /// untranslated; sometimes legitimate, e.g. "OK").
    pub identical_to_source: usize,
    /// Total leaf values found in the file.
    pub total_in_file: usize,
}

/// The staged outcome of an import: entries ready for `save_many`, plus the
/// user-facing summary.
#[derive(Debug)]
pub struct PreparedImport {
    pub entries: Vec<(String, StoredString)>,
    pub summary: ImportSummary,
}

/// Match a parsed result (or re-imported batch) file against the mod's current
/// rows and stage every accepted value as `review-needed`. Pure (no I/O).
pub fn apply_batch(
    result: &Value,
    rows_by_dir: &HashMap<String, Vec<StringRow>>,
) -> Result<PreparedImport, String> {
    let object = result
        .as_object()
        .ok_or("The file is not a JSON object.")?;
    let format = object.get("format").and_then(Value::as_str).unwrap_or("");
    if format != RESULT_FORMAT && format != BATCH_FORMAT {
        return Err(format!(
            "Not a Claude-Code batch/result file (expected a \"format\" of \
             \"{RESULT_FORMAT}\", found \"{format}\")."
        ));
    }
    let files = object
        .get("files")
        .and_then(Value::as_object)
        .ok_or("The file has no \"files\" object with translations.")?;

    let mut prepared = PreparedImport {
        entries: Vec::new(),
        summary: ImportSummary::default(),
    };
    let summary = &mut prepared.summary;

    for (dir, group) in files {
        let Some(group) = group.as_object() else {
            continue;
        };
        let rows = rows_by_dir.get(dir);
        for (key, value) in group {
            summary.total_in_file += 1;
            let row = rows.and_then(|rows| rows.iter().find(|row| &row.key == key));
            let Some(row) = row else {
                summary.unmatched += 1;
                continue;
            };
            let Some(text) = value.as_str().filter(|text| !text.trim().is_empty()) else {
                summary.unmatched += 1;
                continue;
            };
            // Never overwrite confirmed local work with machine output.
            if row.status == "translated" || row.status == "not-translatable" {
                summary.skipped_translated += 1;
                continue;
            }
            if tokens::missing_tokens(&row.source, text) {
                summary.token_issues += 1;
            }
            if text.trim() == row.source.trim() {
                summary.identical_to_source += 1;
            }
            summary.imported += 1;
            prepared.entries.push((
                translations::entry_key(dir, key),
                StoredString {
                    target: text.to_string(),
                    status: "review-needed".to_string(),
                    source_hash: translations::source_hash(&row.source),
                },
            ));
        }
    }

    Ok(prepared)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(dir: &str, key: &str, source: &str) -> BatchExportItem {
        BatchExportItem {
            relative_dir: dir.into(),
            key: key.into(),
            source: source.into(),
        }
    }

    fn row(key: &str, source: &str, status: &str) -> StringRow {
        StringRow {
            key: key.into(),
            source: source.into(),
            target: String::new(),
            target_present: false,
            status: status.into(),
        }
    }

    #[test]
    fn batch_has_format_metadata_instructions_and_grouped_files() {
        let items = vec![
            item("i18n", "greeting", "Hello {{PlayerName}}!"),
            item("i18n", "bye", "Bye"),
            item("sub/i18n", "other", "Other"),
        ];
        let batch = build_batch("My Mod", "my.mod", "de", "German", &items, None);

        assert_eq!(batch["format"], BATCH_FORMAT);
        assert_eq!(batch["version"], 1);
        assert_eq!(batch["metadata"]["mod"], "My Mod");
        assert_eq!(batch["metadata"]["modUniqueId"], "my.mod");
        assert_eq!(batch["metadata"]["targetLang"], "de");
        let instructions = batch["instructions"].as_str().unwrap();
        assert!(instructions.contains("German"));
        assert!(instructions.contains("{{Token}}"));
        assert!(instructions.contains(RESULT_FORMAT));
        assert_eq!(batch["files"]["i18n"]["greeting"], "Hello {{PlayerName}}!");
        assert_eq!(batch["files"]["sub/i18n"]["other"], "Other");
        // Timestamp is ISO-8601-shaped.
        let exported_at = batch["metadata"]["exportedAt"].as_str().unwrap();
        assert!(exported_at.ends_with('Z') && exported_at.contains('T'));
    }

    #[test]
    fn glossary_excerpt_contains_only_matching_terms() {
        let mut terms = std::collections::HashMap::new();
        terms.insert("Parsnip".to_string(), "Pastinake".to_string());
        terms.insert("Junimo".to_string(), "Junimo-X".to_string());
        let glossary = Glossary {
            terms,
            ..Default::default()
        };
        let items = vec![item("i18n", "k", "A fresh parsnip.")];
        let batch = build_batch("M", "m", "de", "German", &items, Some(&glossary));

        assert_eq!(batch["glossary"]["Parsnip"], "Pastinake");
        assert!(batch["glossary"].get("Junimo").is_none(), "unmatched term excluded");
    }

    #[test]
    fn import_stages_review_needed_and_protects_local_work() {
        let mut rows = HashMap::new();
        rows.insert(
            "i18n".to_string(),
            vec![
                row("open", "Hello {{name}}", "untranslated"),
                row("stale", "Changed", "outdated"),
                row("done", "Done", "translated"),
                row("fixed", "Fixed", "not-translatable"),
            ],
        );
        let result = serde_json::json!({
            "format": RESULT_FORMAT,
            "version": 1,
            "files": {
                "i18n": {
                    "open": "Hallo {{name}}",
                    "stale": "Geändert",
                    "done": "Übergangen",
                    "fixed": "Übergangen",
                    "ghost": "Unbekannt"
                }
            }
        });

        let prepared = apply_batch(&result, &rows).unwrap();
        let summary = &prepared.summary;
        assert_eq!(summary.total_in_file, 5);
        assert_eq!(summary.imported, 2, "untranslated + outdated accepted");
        assert_eq!(summary.skipped_translated, 2, "manual work untouched");
        assert_eq!(summary.unmatched, 1, "unknown key counted");
        assert_eq!(summary.token_issues, 0);

        let keys: Vec<&str> = prepared
            .entries
            .iter()
            .map(|(key, _)| key.as_str())
            .collect();
        assert_eq!(
            keys,
            vec![
                translations::entry_key("i18n", "open"),
                translations::entry_key("i18n", "stale"),
            ]
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>()
        );
        for (_, stored) in &prepared.entries {
            assert_eq!(stored.status, "review-needed");
        }
        // Source hash is the CURRENT source (outdated detection keeps working).
        assert_eq!(
            prepared.entries[0].1.source_hash,
            translations::source_hash("Hello {{name}}")
        );
    }

    #[test]
    fn import_flags_token_loss_and_identical_values_but_accepts_them() {
        let mut rows = HashMap::new();
        rows.insert(
            "i18n".to_string(),
            vec![
                row("tok", "Hi {{name}}", "untranslated"),
                row("same", "OK", "untranslated"),
            ],
        );
        let result = serde_json::json!({
            "format": RESULT_FORMAT,
            "version": 1,
            "files": { "i18n": { "tok": "Hallo ohne Token", "same": "OK" } }
        });

        let prepared = apply_batch(&result, &rows).unwrap();
        assert_eq!(prepared.summary.imported, 2, "flagged, not rejected");
        assert_eq!(prepared.summary.token_issues, 1);
        assert_eq!(prepared.summary.identical_to_source, 1);
    }

    #[test]
    fn import_rejects_files_without_the_format_marker() {
        let rows = HashMap::new();
        let err = apply_batch(&serde_json::json!({ "files": {} }), &rows).unwrap_err();
        assert!(err.contains("format"));
        let err = apply_batch(&serde_json::json!("just a string"), &rows).unwrap_err();
        assert!(err.contains("object"));
    }

    #[test]
    fn import_accepts_a_translated_in_place_batch_file() {
        // The LLM may translate the values inside the original batch file
        // instead of producing a separate result file — accept that too.
        let mut rows = HashMap::new();
        rows.insert(
            "i18n".to_string(),
            vec![row("k", "Hello", "untranslated")],
        );
        let result = serde_json::json!({
            "format": BATCH_FORMAT,
            "version": 1,
            "instructions": "…",
            "files": { "i18n": { "k": "Hallo" } }
        });
        let prepared = apply_batch(&result, &rows).unwrap();
        assert_eq!(prepared.summary.imported, 1);
    }

    #[test]
    fn import_ignores_empty_and_non_string_values() {
        let mut rows = HashMap::new();
        rows.insert(
            "i18n".to_string(),
            vec![row("a", "A", "untranslated"), row("b", "B", "untranslated")],
        );
        let result = serde_json::json!({
            "format": RESULT_FORMAT,
            "files": { "i18n": { "a": "   ", "b": 42 } }
        });
        let prepared = apply_batch(&result, &rows).unwrap();
        assert_eq!(prepared.summary.imported, 0);
        assert_eq!(prepared.summary.unmatched, 2);
    }
}
