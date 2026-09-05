# Contributing

Bug reports, small fixes, documentation improvements, and translation-workflow
ideas are welcome. Use the [issue templates](https://github.com/Nana1873/stardew-i18n-translator/issues/new/choose)
for reports and proposals; an issue is not required before a focused pull request.

## Development Setup

The desktop app is developed and released on Windows x64. Install:

- Git and a current Node.js 22 release, matching CI;
- Corepack, which uses the pnpm version pinned in [package.json](package.json);
- Rust stable with the `x86_64-pc-windows-msvc` toolchain;
- Microsoft C++ Build Tools with **Desktop development with C++** and the
  Windows SDK, plus the Microsoft Edge WebView2 runtime.

The [Tauri Windows prerequisites](https://v2.tauri.app/start/prerequisites/#windows)
cover the native dependencies. Then, in PowerShell:

```powershell
git clone https://github.com/Nana1873/stardew-i18n-translator.git
Set-Location stardew-i18n-translator
corepack pnpm install --frozen-lockfile
corepack pnpm dev
```

`corepack pnpm dev:web` starts the Vite frontend for browser work, but native
dialogs, scanning, and file operations require the Tauri desktop app. No real
game installation, AI service, or Codex login is needed for automated tests.

## Source Map

| Location                                       | Purpose                                                         |
| ---------------------------------------------- | --------------------------------------------------------------- |
| [src/App.tsx](src/App.tsx)                     | App navigation and operation coordination.                      |
| [src/](src/)                                   | React screens, dialogs, styles, and colocated Vitest tests.     |
| [src/tauri/commands.ts](src/tauri/commands.ts) | Typed frontend calls to Tauri commands.                         |
| [src-tauri/src/lib.rs](src-tauri/src/lib.rs)   | Native command boundaries and app setup.                        |
| [src-tauri/src/](src-tauri/src/)               | Rust scan, state, export, glossary, AI, and validation modules. |
| [tests/fixtures/](tests/fixtures/)             | Shared synthetic test data.                                     |
| [scripts/](scripts/)                           | Version checks, docs checks, fixtures, packaging, and releases. |
| [docs/design/](docs/design/)                   | Historical design references; current components define the UI. |

[SPEC.md](SPEC.md) records durable product behavior. Keep the direct Tauri/Rust
and React/TypeScript architecture; extend an existing module before adding a
framework or general abstraction.

## Verification

Run checks matching the changed surface from the repository root:

```powershell
# Documentation
corepack pnpm check:docs

# Frontend or shared TypeScript
corepack pnpm typecheck
corepack pnpm test

# Rust
Push-Location src-tauri
cargo fmt --check
cargo clippy --locked --all-targets --profile ci -- -D warnings
cargo test --locked --profile ci
Pop-Location
```

`check:docs` checks version consistency, local Markdown links and heading anchors,
the link checker's regression tests, and repository formatting. External link
availability is checked manually. Use targeted formatting for changed files. Broaden checks
when a change crosses frontend/backend boundaries or affects packaging; document
what you ran and any limitation. UI changes also need a practical desktop check.

Token extraction has hand-synced TypeScript and Rust implementations. Add shared
cases to [tests/fixtures/token-cases.json](tests/fixtures/token-cases.json) and run
both suites when changing those rules; see the [fixture guide](tests/fixtures/README.md).

## Safe Test Data

Treat real Stardew Valley and Mods folders as read-only test inputs. Use synthetic
fixtures or temporary copies for edits, imports, exports, and destructive tests.
Never commit game assets, third-party mod content, generated translations, user
state, personal paths, or credentials.

Generate a small multilingual scan/import/export fixture with:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/create-language-smoke-fixture.ps1
```

The script creates an ignored `target/language-smoke/` tree and prints the game,
Mods, and LLM-result paths to use in the app. It includes a Portuguese
`pt-BR.json` fallback; exporting should produce `pt.json`. It generates test
inputs, not an automated pass/fail result. Re-running it recreates those inputs,
so do not point `-OutputRoot` at real game or mod data.

## Submitting Changes

Keep code, CLI text, commits, PRs, issues, and repository documentation in English.
Keep changes focused on the current request and describe the problem, resulting
behavior, and relevant verification in the PR. Include a screenshot when a
visual change benefits from one; no fixed PR template or planning document is
required.

Update the guide for the affected audience when behavior changes, rather than
copying the same explanation into README, SPEC, and release notes. Use GitHub
Issues for planned work and [CHANGELOG.md](CHANGELOG.md) for release history.
For local builds, version changes, or publishing, follow the
[release process](docs/release/release-process.md).
