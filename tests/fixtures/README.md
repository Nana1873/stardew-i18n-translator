# Test Fixtures

[token-cases.json](token-cases.json) contains the shared protected-token cases
used by both [the TypeScript suite](../../src/strings/tokenCases.test.ts) and
[the Rust suite](../../src-tauri/src/tokens.rs) (`shared_fixture_cases_match`).
Add new token-extractor cases here so both implementations are checked against
the same expectations.

Other tests keep synthetic fixtures inline, including temporary directories
with `manifest.json` and `i18n/*.json` files. Shared static data belongs here
when more than one suite needs it.

> [!CAUTION]
> Do NOT store real game data, real mod code, or user credentials here. Keep
> fixtures minimal and generic.
