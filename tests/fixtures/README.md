# Test Fixtures

> [!NOTE]
> **Current reality:** there are no static fixtures yet. All existing tests
> (Rust unit/integration tests in `src-tauri/src/*` and the vitest suites in
> `src/**/*.test.tsx?`) generate their fixtures **inline** — temp directories
> with synthetic `manifest.json` / `i18n/*.json` files, created and removed
> per test. That keeps fixtures next to the assertions that use them.

This directory is reserved for static fixtures once a test genuinely needs
shared, on-disk data (e.g. a cross-language token-extractor case file consumed
by both the Rust and TypeScript suites, or M4 batch import/export samples).

> [!CAUTION]
> Do NOT store real game data, real mod code, or user credentials here. Keep
> fixtures minimal and generic.
