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
}
