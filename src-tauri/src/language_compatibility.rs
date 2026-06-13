//! V1.1 supported-language compatibility gate.
//!
//! Synthetic fixtures only: no game data or third-party mod content.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;

use serde_json::Value;

use crate::batch::{self, BatchExportItem};
use crate::export::{self, ExportFileInput};
use crate::llm;
use crate::scanner::{self, StringRow};
use crate::settings::{self, AppSettings};
use crate::tokens;
use crate::translations::{self, StoredString};

struct LanguageCase {
    code: &'static str,
    label: &'static str,
    imported: &'static str,
    edited: &'static str,
}

const LANGUAGES: &[LanguageCase] = &[
    LanguageCase {
        code: "de",
        label: "German",
        imported: "Hallo {{PlayerName}}, schönen Tag!",
        edited: "Willkommen, {{PlayerName}}!",
    },
    LanguageCase {
        code: "es",
        label: "Spanish",
        imported: "¡Hola, {{PlayerName}}! Qué alegría.",
        edited: "Bienvenido, {{PlayerName}}.",
    },
    LanguageCase {
        code: "fr",
        label: "French",
        imported: "Bonjour, {{PlayerName}}. L’été arrive.",
        edited: "Bienvenue, {{PlayerName}}.",
    },
    LanguageCase {
        code: "hu",
        label: "Hungarian",
        imported: "Szia, {{PlayerName}}! Őrizd a tűzet.",
        edited: "Üdvözöllek, {{PlayerName}}!",
    },
    LanguageCase {
        code: "it",
        label: "Italian",
        imported: "Ciao, {{PlayerName}}. Com’è bello.",
        edited: "Benvenuto, {{PlayerName}}.",
    },
    LanguageCase {
        code: "ja",
        label: "Japanese",
        imported: "こんにちは、{{PlayerName}}。今日はいい日です。",
        edited: "ようこそ、{{PlayerName}}。",
    },
    LanguageCase {
        code: "ko",
        label: "Korean",
        imported: "안녕하세요, {{PlayerName}}. 좋은 하루예요.",
        edited: "환영합니다, {{PlayerName}}.",
    },
    LanguageCase {
        code: "pt",
        label: "Portuguese",
        imported: "Olá, {{PlayerName}}. Que ótimo!",
        edited: "Boas-vindas, {{PlayerName}}.",
    },
    LanguageCase {
        code: "ru",
        label: "Russian",
        imported: "Привет, {{PlayerName}}. Хорошего дня!",
        edited: "Добро пожаловать, {{PlayerName}}.",
    },
    LanguageCase {
        code: "tr",
        label: "Turkish",
        imported: "Merhaba, {{PlayerName}}. Ilık ışık güzel.",
        edited: "Hoş geldin, {{PlayerName}}.",
    },
    LanguageCase {
        code: "zh",
        label: "Chinese",
        imported: "你好，{{PlayerName}}。今天真好。",
        edited: "欢迎你，{{PlayerName}}。",
    },
];

fn write(path: &Path, body: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, body.as_bytes()).unwrap();
}

fn source_body() -> String {
    format!(
        "{{\n  // NPC dialogue\n  \"zeta\": \"Hello {{{{PlayerName}}}}!\",\n  \"alpha\": {}\n}}\n",
        serde_json::to_string("Café weather").unwrap()
    )
}

fn target_body(text: &str) -> String {
    serde_json::to_string_pretty(&serde_json::json!({
        "zeta": text,
        "alpha": "Café"
    }))
    .unwrap()
}

#[test]
fn every_advertised_language_passes_the_complete_technical_workflow() {
    for language in LANGUAGES {
        let root = crate::test_support::temp_dir(&format!("language-{}", language.code));
        let config = root.join("Data");
        let mods = root.join("Mods");
        let mod_dir = mods.join("Synthetic Mod");
        let i18n = mod_dir.join("i18n");
        write(
            &mod_dir.join("manifest.json"),
            r#"{ "UniqueID": "test.language", "Name": "Synthetic Language Test" }"#,
        );
        write(&i18n.join("default.json"), &source_body());

        let imported_filename = if language.code == "pt" {
            "pt-BR.json".to_string()
        } else {
            format!("{}.json", language.code)
        };
        write(
            &i18n.join(&imported_filename),
            &target_body(language.imported),
        );

        let settings_value = AppSettings {
            stardew_path: Some(root.display().to_string()),
            mods_path: Some(mods.display().to_string()),
            source_lang: "default".to_string(),
            target_lang: Some(language.code.to_string()),
            diagnostic_logging: true,
            llm: None,
            shortcuts: BTreeMap::new(),
        };
        settings::save(&config, &settings_value).unwrap();
        assert_eq!(
            settings::load(&config).target_lang.as_deref(),
            Some(language.code),
            "{} settings persistence",
            language.code
        );

        let scan = scanner::scan_mods(&mods, language.code, &config);
        assert_eq!(scan.mod_count, 1, "{} scan", language.code);
        let scanned_file = &scan.mods[0].i18n_files[0];
        assert_eq!(
            scanned_file.target_exists,
            language.code != "pt",
            "{} canonical target detection",
            language.code
        );
        assert!(
            scanned_file
                .target_path
                .ends_with(&format!("{}.json", language.code)),
            "{} canonical target path: {}",
            language.code,
            scanned_file.target_path
        );

        let rows = scanner::load_strings(
            Path::new(&scanned_file.default_path),
            Path::new(&scanned_file.target_path),
            &translations::ModState::new(),
            &scanned_file.relative_dir,
        );
        assert_eq!(
            rows[0].target, language.imported,
            "{} Unicode import",
            language.code
        );
        assert_eq!(
            rows[0].section.as_deref(),
            Some("NPC dialogue"),
            "{} section context",
            language.code
        );
        assert!(
            tokens::token_differences(&rows[0].source, &rows[0].target).is_empty(),
            "{} protected tokens",
            language.code
        );

        let language_state = translations::language_root(&config, language.code).unwrap();
        translations::save_one(
            &language_state,
            "test.language",
            translations::entry_key("i18n", "zeta"),
            StoredString {
                target: language.edited.to_string(),
                status: "translated".to_string(),
                source_hash: translations::source_hash(&rows[0].source),
            },
        )
        .unwrap();
        let reloaded = scanner::load_strings(
            Path::new(&scanned_file.default_path),
            Path::new(&scanned_file.target_path),
            &translations::load(&language_state, "test.language").unwrap(),
            "i18n",
        );
        assert_eq!(
            reloaded[0].target, language.edited,
            "{} edit/reload",
            language.code
        );
        assert_eq!(
            scanner::scan_mods(&mods, language.code, &config).mods[0].translated_keys,
            2,
            "{} rescan",
            language.code
        );

        let export_result = export::export_mod(
            &language_state,
            "test.language",
            &[ExportFileInput {
                relative_dir: "i18n".to_string(),
                default_path: scanned_file.default_path.clone(),
                target_path: scanned_file.target_path.clone(),
            }],
        )
        .unwrap();
        assert!(!export_result.blocked, "{} export", language.code);
        let exported_body = std::fs::read_to_string(&scanned_file.target_path).unwrap();
        let exported: Value = serde_json::from_str(&exported_body).unwrap();
        assert_eq!(
            exported["zeta"], language.edited,
            "{} exported Unicode",
            language.code
        );
        assert!(
            exported_body.find("\"zeta\"").unwrap() < exported_body.find("\"alpha\"").unwrap(),
            "{} key order",
            language.code
        );
        if language.code == "pt" {
            assert!(i18n.join("pt-BR.json").is_file());
            assert!(i18n.join("pt.json").is_file());
            let canonical_rows = scanner::load_strings(
                Path::new(&scanned_file.default_path),
                Path::new(&scanned_file.target_path),
                &translations::ModState::new(),
                "i18n",
            );
            assert_eq!(
                canonical_rows[0].target, language.edited,
                "pt.json takes precedence over the pt-BR.json import fallback"
            );
        }

        let batch_value = batch::build_batch(
            "Synthetic Language Test",
            "test.language",
            language.code,
            language.label,
            &[BatchExportItem {
                relative_dir: "i18n".to_string(),
                key: "zeta".to_string(),
                source: "Café {{PlayerName}}".to_string(),
                section: Some("NPC dialogue".to_string()),
            }],
            None,
        );
        assert_eq!(
            batch_value["metadata"]["targetLang"], language.code,
            "{} batch code",
            language.code
        );
        assert!(
            batch_value["instructions"]
                .as_str()
                .unwrap()
                .contains(language.label),
            "{} batch label",
            language.code
        );
        assert_eq!(
            batch_value["files"]["i18n"]["zeta"], "Café {{PlayerName}}",
            "{} batch Unicode",
            language.code
        );
        assert_eq!(
            batch_value["sections"]["i18n"]["zeta"], "NPC dialogue",
            "{} batch section",
            language.code
        );

        let result_value = serde_json::json!({
            "format": batch::RESULT_FORMAT,
            "version": 1,
            "files": { "i18n": { "zeta": language.edited } }
        });
        let mut rows_by_dir = HashMap::new();
        rows_by_dir.insert(
            "i18n".to_string(),
            vec![StringRow {
                key: "zeta".to_string(),
                source: "Hello {{PlayerName}}!".to_string(),
                target: String::new(),
                target_present: false,
                status: "untranslated".to_string(),
                section: Some("NPC dialogue".to_string()),
            }],
        );
        let prepared = batch::apply_batch(&result_value, &rows_by_dir).unwrap();
        assert_eq!(
            prepared.entries[0].1.target, language.edited,
            "{} batch result Unicode",
            language.code
        );
        assert_eq!(prepared.entries[0].1.status, "review-needed");

        let messages = llm::build_messages(
            "Café {{PlayerName}}",
            language.label,
            Some("NPC dialogue"),
            &[],
            None,
        );
        assert!(
            messages[0].content.contains(language.label),
            "{} local-AI language",
            language.code
        );
        assert!(messages[0].content.contains("NPC dialogue"));
        assert_eq!(messages[1].content, "Café {{PlayerName}}");
        assert!(messages[0]
            .content
            .contains("Preserve every placeholder/token"));
        assert_eq!(
            messages[0].content.contains("Do not introduce em dashes"),
            language.code == "de",
            "{} language-specific prompt rules",
            language.code
        );

        std::fs::remove_dir_all(&root).ok();
    }
}

#[test]
fn switching_languages_in_one_portable_data_folder_never_leaks_saved_work() {
    let root = crate::test_support::temp_dir("language-switch");
    let config = root.join("Data");
    let mods = root.join("Mods");
    let mod_dir = mods.join("Synthetic Mod");
    let i18n = mod_dir.join("i18n");
    write(
        &mod_dir.join("manifest.json"),
        r#"{ "UniqueID": "test.switch", "Name": "Synthetic Switch Test" }"#,
    );
    write(
        &i18n.join("default.json"),
        r#"{ "greeting": "Hello {{PlayerName}}!" }"#,
    );
    write(
        &i18n.join("de.json"),
        r#"{ "greeting": "Hallo {{PlayerName}}!" }"#,
    );
    write(
        &i18n.join("ja.json"),
        r#"{ "greeting": "こんにちは、{{PlayerName}}。" }"#,
    );

    let german_scan = scanner::scan_mods(&mods, "de", &config);
    let german_file = &german_scan.mods[0].i18n_files[0];
    let german_state = translations::language_root(&config, "de").unwrap();
    translations::save_one(
        &german_state,
        "test.switch",
        translations::entry_key("i18n", "greeting"),
        StoredString {
            target: "Gespeichert {{PlayerName}}".to_string(),
            status: "translated".to_string(),
            source_hash: translations::source_hash("Hello {{PlayerName}}!"),
        },
    )
    .unwrap();

    let japanese_scan = scanner::scan_mods(&mods, "ja", &config);
    let japanese_file = &japanese_scan.mods[0].i18n_files[0];
    let japanese_state = translations::language_root(&config, "ja").unwrap();
    let japanese_rows = scanner::load_strings(
        Path::new(&japanese_file.default_path),
        Path::new(&japanese_file.target_path),
        &translations::load(&japanese_state, "test.switch").unwrap(),
        "i18n",
    );
    assert_eq!(japanese_rows[0].target, "こんにちは、{{PlayerName}}。");

    let german_rows = scanner::load_strings(
        Path::new(&german_file.default_path),
        Path::new(&german_file.target_path),
        &translations::load(&german_state, "test.switch").unwrap(),
        "i18n",
    );
    assert_eq!(german_rows[0].target, "Gespeichert {{PlayerName}}");

    std::fs::remove_dir_all(&root).ok();
}
