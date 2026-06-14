# Scope Guardrails

This document defines strict boundaries for the **Stardew i18n Translator** project. All developers, coding agents (Antigravity, Codex, Claude Code), and pull request reviewers must enforce these guardrails to prevent scope creep and maintain architecture simplicity.

## Core Rules

1. **Source of Truth:** [SPEC.md](SPEC.md) is the absolute authority for features and requirements.
2. **Code Freeze:** No application code is allowed to be written or scaffolded before [ADR 0001: Tech Stack Decision](docs/adr/0001-tech-stack-decision.md) is accepted and approved.
3. **Strict Validation:** If a feature or requirement is not explicitly defined in [SPEC.md](SPEC.md), **do not implement it**.
4. **Ambiguity Resolution:** If a feature is ambiguous or unclear, open or update
   a GitHub issue and assign the appropriate release milestone. Do not guess.

## Core v1 Technical Guardrails

- **File Format Limit:** v1 ONLY supports standard SMAPI localization files: `i18n/default.json` and target language files like `i18n/<lang>.json` (where `<lang>` is a code like `es`, `zh`, `de`, etc.). Do NOT support general mod JSON configurations or `content.json` parsing.
- **No Cloud AI / No API Keys:** No cloud AI APIs and no API keys of any kind inside the desktop application in v1 — the tool must work fully offline. Allowed AI workflows are exactly two: the M4 external LLM batch export/import (the app only writes and reads files; the user handles any external LLM separately), and the M6 **local-LLM** translation against an OpenAI-compatible `localhost` endpoint (Ollama / LM Studio / compatible; no key, no external network, output always lands as `review-needed`). No provider plugin system — presets + a custom URL only (SPEC §19 #6/#7).
- **No Nexus API Operations:** v1 does not validate Nexus keys or make active API requests to Nexus Mods. It only parses Nexus IDs from manifest `UpdateKeys` and shows external clickable links.
- **No Automatic Downloads:** No automatic or background translation discovery/downloading.
- **No Internal Git Integration:** The app must not initialize, read, commit, or push git repositories. Git operations are strictly outside the scope of the app.
- **No Mod Manager Features:** No mod activation, deactivation, profile managers (like Vortex or Mod Organizer 2), or mod updating features.
- **UI Layout Limits:** The main workspace layout must remain simple: a toolbar + a 2-panel layout (Mod List panel and String Table/Editor panel). No multi-window dashboards or complex workspace studio environments.
- **Glossary is Optional:** Building the official Stardew game glossary from game content is optional during setup. The app must run perfectly if the user skips this step or if glossary extraction fails (graceful degradation, features relying on the glossary must simply disable themselves or show placeholder tooltips).
- **No Plugin/Provider Abstractions:** Avoid building complex provider structures, dependency injection systems, or plugin frameworks. Keep the architecture straightforward and monolithic for v1.

## Local Data for Development and Verification

Locally installed third-party mods may be used as read-only test inputs for
development, debugging, performance testing, and visual verification. This
permission does not allow redistribution or inclusion of real mod content in
the repository.

- Treat the user's original Mods directory as read-only.
- Run any write, edit, import, or export verification against a temporary copy.
- Do not commit, upload, redistribute, or convert real mod content into test
  fixtures.
- Do not expose mod text, generated translations, personal paths, or local user
  data in logs, screenshots, issues, pull requests, or handoff summaries.
- Remove temporary working copies after verification when practical.
- Access local Stardew Valley game files only when the assigned task explicitly
  covers game-path detection or glossary extraction. Never commit, upload, or
  redistribute game assets.

## Scope Deflection Process

When an agent or developer suggests a new feature, improvement, or refactoring that lies outside the assigned issue's scope:

1. Stop implementation of that specific change.
2. Create a separate GitHub issue and assign an appropriate release milestone
   or leave it in the unmilestoned backlog when no release is approved.
3. Proceed only with the minimal work required to satisfy the active issue's acceptance criteria.
