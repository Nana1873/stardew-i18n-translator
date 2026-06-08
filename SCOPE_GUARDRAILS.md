# Scope Guardrails

This document defines strict boundaries for the **Stardew i18n Translator** project. All developers, coding agents (Antigravity, Codex, Claude Code), and pull request reviewers must enforce these guardrails to prevent scope creep and maintain architecture simplicity.

## Core Rules

1. **Source of Truth:** [SPEC.md](SPEC.md) is the absolute authority for features and requirements.
2. **Code Freeze:** No application code is allowed to be written or scaffolded before [ADR 0001: Tech Stack Decision](docs/adr/0001-tech-stack-decision.md) is accepted and approved.
3. **Strict Validation:** If a feature or requirement is not explicitly defined in [SPEC.md](SPEC.md), **do not implement it**. 
4. **Ambiguity Resolution:** If a feature is ambiguous or unclear, move it to the deferred features milestone (`v1.1` or `v2`) or open an issue/discussion. Do not guess.

## Core v1 Technical Guardrails

* **File Format Limit:** v1 ONLY supports standard SMAPI localization files: `i18n/default.json` and target language files like `i18n/<lang>.json` (where `<lang>` is a code like `es`, `zh`, `de`, etc.). Do NOT support general mod JSON configurations or `content.json` parsing.
* **No In-App AI:** Absolutely no AI APIs, keys, or direct calls inside the desktop application in v1. (The only AI-related feature is the M4 offline Claude Code translation batch export/import JSON workflow).
* **No Nexus API Operations:** v1 does not validate Nexus keys or make active API requests to Nexus Mods. It only parses Nexus IDs from manifest `UpdateKeys` and shows external clickable links.
* **No Automatic Downloads:** No automatic or background translation discovery/downloading.
* **No Internal Git Integration:** The app must not initialize, read, commit, or push git repositories. Git operations are strictly outside the scope of the app.
* **No Mod Manager Features:** No mod activation, deactivation, profile managers (like Vortex or Mod Organizer 2), or mod updating features.
* **UI Layout Limits:** The main workspace layout must remain simple: a toolbar + a 2-panel layout (Mod List panel and String Table/Editor panel). No multi-window dashboards or complex workspace studio environments.
* **Glossary is Optional:** Building the official Stardew game glossary from game content is optional during setup. The app must run perfectly if the user skips this step or if glossary extraction fails (graceful degradation, features relying on the glossary must simply disable themselves or show placeholder tooltips).
* **No Plugin/Provider Abstractions:** Avoid building complex provider structures, dependency injection systems, or plugin frameworks. Keep the architecture straightforward and monolithic for v1.

## Scope Deflection Process

When an agent or developer suggests a new feature, improvement, or refactoring that lies outside the current milestone's scope:
1. Stop implementation of that specific change.
2. Create a new issue labeled `type:deferred` and tag it with `milestone:v1.1` or `milestone:v2`.
3. Proceed only with the minimal work required to satisfy the active issue's acceptance criteria.
