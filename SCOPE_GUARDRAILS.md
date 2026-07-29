# Scope Guardrails

This is a short safety checklist, not an approval process. The current user
request and the existing product behavior decide what work is appropriate.

## Keep the Product Focused

- The app translates standard SMAPI `i18n/default.json` and
  `i18n/<lang>.json` files.
- It may read narrowly scoped Stardew or community language-pack `Strings`
  dictionaries to build an optional glossary.
- It is not a mod manager, download manager, Nexus client, Git client, or general
  Stardew content editor.
- It does not store cloud credentials or call cloud AI services. Local AI is
  limited to a user-configured localhost OpenAI-compatible endpoint.
- The glossary is optional. Missing glossary data must never block scanning,
  editing, validation, or export.
- AI-generated translations always require review.

## Keep the Implementation Simple

- Prefer the smallest change that solves the current problem.
- Extend existing modules before creating frameworks, provider layers, plugin
  systems, service containers, or generic abstractions.
- Do not add future-facing infrastructure without a concrete current use.
- Keep the current Tauri/Rust and React/TypeScript stack unless the user
  explicitly approves a stack change.
- Documentation should describe current behavior, not mirror issue status,
  milestones, or speculative roadmaps.

## Protect User Data

- Treat real game and mod folders as read-only test inputs.
- Use synthetic fixtures or temporary copies for writes.
- Never commit or publish game assets, third-party mod content, generated
  translations, personal paths, local application data, or credentials.
- Keep portable state in `data/` beside the executable.
- Release archives contain no user state.

See [SPEC.md](SPEC.md) for the concise product behavior reference and
[AGENTS.md](AGENTS.md) for repository working guidance.
