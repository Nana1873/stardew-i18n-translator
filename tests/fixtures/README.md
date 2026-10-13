# Test Fixtures

[token-cases.json](token-cases.json) contains the shared protected-token cases
used by both [the TypeScript suite](../../src/strings/tokenCases.test.ts) and
[the Rust suite](../../src-tauri/src/tokens.rs) (`shared_fixture_cases_match`).
Add new token-extractor cases here so both implementations are checked against
the same expectations.
`comparisons` pin which differences block the export, and `explanations` pin
the exact plain-language sentence for single differences, so the editor and
the export or ZIP results word a finding the same way.

[target-languages.json](target-languages.json) lists the target languages and
their game locales. [The TypeScript suite](../../src/languages.test.ts) and
[the Rust suite](../../src-tauri/src/glossary.rs)
(`shared_target_language_fixture_matches`) both check their tables against it.

Other tests keep synthetic fixtures inline, including temporary directories
with `manifest.json` and `i18n/*.json` files. Shared static data belongs here
when more than one suite needs it.

> [!CAUTION]
> Do NOT store real game data, real mod code, or user credentials here. Keep
> fixtures minimal and generic.
