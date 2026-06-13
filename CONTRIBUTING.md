# Contributing

Thanks for your interest in **Stardew i18n Translator**! This is a small,
focused project with deliberately strict scope. Please read this before opening
a pull request.

## Ground rules

1. **Scope is strict.** [SPEC.md](SPEC.md) is the source of truth and
   [SCOPE_GUARDRAILS.md](SCOPE_GUARDRAILS.md) defines hard boundaries. The app
   is a local, offline `i18n` editor — not a mod manager, cloud-AI client, or
   Nexus downloader. Out-of-scope changes are closed or deferred.
2. **One issue per PR.** Keep changes small and single-purpose. Don't bundle
   unrelated fixes or refactors.
3. **Open an issue first** for anything non-trivial, so scope can be confirmed
   before you spend time on it.

## Development setup

Prerequisites: [Rust](https://rustup.rs/) (stable), Node.js 22+, and
[pnpm](https://pnpm.io/) via Corepack. The app targets **Windows** (Tauri 2).

```powershell
corepack pnpm install
corepack pnpm test         # frontend tests (vitest)
corepack pnpm tauri dev    # run the app
```

Backend (Rust) tests and lints:

```powershell
cd src-tauri
cargo test --locked
cargo clippy --all-targets -- -D warnings
cargo fmt --check
```

## Before you push

CI runs exactly these checks — run them locally first:

- `corepack pnpm exec tsc --noEmit`
- `corepack pnpm test`
- `corepack pnpm format:check` (run `corepack pnpm format` to fix)
- `cargo fmt --check`, `cargo clippy ... -D warnings`, `cargo test` (if you
  touched `src-tauri/`)

Every code change should include tests, or a clear note on why automated
testing isn't possible for that piece.

## Commit & PR conventions

- Small, logical commits with clear messages.
- Update docs / README / [CHANGELOG.md](CHANGELOG.md) when behavior changes.
- Fill in the pull request template.

## Working with AI coding agents

This repo is set up to be worked by AI coding agents as well as humans. If you
use one, point it at [AGENTS.md](AGENTS.md) first — it defines the rules of
engagement, hygiene, and the required handoff format. For fixing a reported bug,
see [docs/agents/issue-triage-workflow.md](docs/agents/issue-triage-workflow.md).

## Never commit

- API keys, tokens, or credentials.
- Stardew Valley game files, executables, or unpacked assets.
- Third-party mod archives or directories (except minimal fixtures under
  `tests/fixtures/`).
- Generated glossary databases or local user data.

## License

By contributing, you agree that your contributions are licensed under the
project's [GPL-3.0-or-later](LICENSE) license.
