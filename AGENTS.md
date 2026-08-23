# Repository Guidance

Stardew i18n Translator is a small, local-first Windows desktop app. Keep changes
proportional to that goal.

## Working Style

- The user's request or the current GitHub issue defines the task. An issue,
  milestone, or formal implementation plan is optional.
- Read the relevant code before editing. Use [README.md](README.md) for the user
  workflow and [SPEC.md](SPEC.md) for durable product behavior.
- Prefer a direct change over a new abstraction. Do not add provider systems,
  plugin layers, dependency-injection frameworks, or generalized infrastructure
  unless the current feature genuinely needs them.
- Reuse the existing Tauri, Rust, React, and TypeScript architecture.
- Do not create roadmap, walkthrough, handoff, or task-status files unless the
  user specifically asks for one.
- Pull-request labels and documentation changes are helpful when they add value,
  but they are not mandatory ceremony.

## Data Safety

- Treat the user's real Stardew Valley and Mods folders as read-only.
- Run write, import, export, and destructive tests only on synthetic fixtures or
  temporary copies.
- Never commit game assets, third-party mod content, generated translations,
  local paths, user data, credentials, or API keys.
- Keep application state beside the executable in `data/`.
- Portable release archives contain only the executable and `README.txt`.

## Product Boundaries

- Translation and export target standard SMAPI `i18n/default.json` and
  `i18n/<lang>.json` files.
- Glossary extraction may read the narrow, read-only Stardew and community-pack
  `Strings` sources described in [SPEC.md](SPEC.md).
- The desktop app does not contain cloud API keys, automatic downloads, Nexus
  API operations, mod-manager features, or Git integration.
- AI output always enters the review workflow rather than becoming final
  automatically.

## Verification

Run checks that match the changed surface instead of the full suite by default.

```powershell
# Documentation-only changes
corepack pnpm check:docs

# Frontend or shared TypeScript changes
corepack pnpm typecheck
corepack pnpm test

# Rust changes
Push-Location src-tauri
cargo fmt --check
cargo clippy --locked --all-targets --profile ci -- -D warnings
cargo test --locked --profile ci
Pop-Location
```

Broaden verification for shared behavior, packaging, or release changes. Report
what was run and any remaining risk in the final response; no fixed handoff
template is required.

## Releases

- Update synchronized versions with `corepack pnpm version:set <version>`.
- Build and package the verified Windows executable locally.
- Use `scripts/create-release.ps1`. It publishes a normal GitHub release by
  default; pass `-Draft` only when a draft is intentionally wanted.
- Keep `CHANGELOG.md` concise. A curated `docs/release/v<version>.md` file is
  optional.
