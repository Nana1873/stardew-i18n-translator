//! Canonical target-language validation shared by every backend boundary.

pub const TARGET_LANGUAGE_CODES: [&str; 19] = [
    "de", "es", "fr", "hu", "it", "ja", "ko", "pt", "ru", "tr", "zh", "vi", "id", "uk", "pl", "fi",
    "nl", "cs", "th",
];

pub fn normalize_target_code(value: &str) -> Result<String, String> {
    let normalized = value.trim().to_ascii_lowercase();
    TARGET_LANGUAGE_CODES
        .contains(&normalized.as_str())
        .then_some(normalized)
        .ok_or_else(|| format!("Unsupported target language: {value}"))
}

/// English provider label for one canonical target code. Live AI callers use
/// this mapping instead of trusting a human-readable label from the webview.
pub fn target_language_name(value: &str) -> Result<&'static str, String> {
    let normalized = normalize_target_code(value)?;
    match normalized.as_str() {
        "de" => Ok("German"),
        "es" => Ok("Spanish"),
        "fr" => Ok("French"),
        "hu" => Ok("Hungarian"),
        "it" => Ok("Italian"),
        "ja" => Ok("Japanese"),
        "ko" => Ok("Korean"),
        "pt" => Ok("Portuguese"),
        "ru" => Ok("Russian"),
        "tr" => Ok("Turkish"),
        "zh" => Ok("Chinese"),
        "vi" => Ok("Vietnamese"),
        "id" => Ok("Indonesian"),
        "uk" => Ok("Ukrainian"),
        "pl" => Ok("Polish"),
        "fi" => Ok("Finnish"),
        "nl" => Ok("Dutch"),
        "cs" => Ok("Czech"),
        "th" => Ok("Thai"),
        _ => unreachable!("normalize_target_code accepted an unmapped language"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_supported_codes_and_normalizes_case_and_whitespace() {
        for code in TARGET_LANGUAGE_CODES {
            assert_eq!(normalize_target_code(code).unwrap(), code);
        }
        assert_eq!(normalize_target_code(" PT ").unwrap(), "pt");
    }

    #[test]
    fn rejects_aliases_paths_and_unsupported_codes() {
        for value in [
            "", "default", "en", "pt-BR", "../de", r"..\de", "de.json", ".", "xx",
        ] {
            assert!(normalize_target_code(value).is_err(), "accepted {value:?}");
        }
    }

    #[test]
    fn every_supported_code_has_a_stable_english_provider_name() {
        let expected = [
            ("de", "German"),
            ("es", "Spanish"),
            ("fr", "French"),
            ("hu", "Hungarian"),
            ("it", "Italian"),
            ("ja", "Japanese"),
            ("ko", "Korean"),
            ("pt", "Portuguese"),
            ("ru", "Russian"),
            ("tr", "Turkish"),
            ("zh", "Chinese"),
            ("vi", "Vietnamese"),
            ("id", "Indonesian"),
            ("uk", "Ukrainian"),
            ("pl", "Polish"),
            ("fi", "Finnish"),
            ("nl", "Dutch"),
            ("cs", "Czech"),
            ("th", "Thai"),
        ];
        assert_eq!(expected.len(), TARGET_LANGUAGE_CODES.len());
        for (code, name) in expected {
            assert_eq!(target_language_name(code).unwrap(), name);
        }
        assert!(target_language_name("en").is_err());
    }
}
