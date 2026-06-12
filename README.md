# Stardew i18n Translator

**Stardew i18n Translator** (`stardew-i18n-translator`) is a local desktop tool for translating Stardew Valley / SMAPI mod `i18n` files.

> [!IMPORTANT]
>
> **Status:** Private early development.
>
> **Current Phase:** `M4 + M6 complete` — the v1 core loop **Setup → Scan → Edit → Export** works end-to-end, plus both AI workflows (local LLM + external LLM batch). See the honest done/open list below.
>
> **Stack:** [ADR 0001](docs/adr/0001-tech-stack-decision.md) is **Accepted** (Tauri / Rust + TypeScript). The code freeze is lifted for this stack; do not introduce other frameworks.

### Implemented so far

- **Setup & scan (M1):** wizard, settings persistence, Stardew auto-detection (Steam/GOG), recursive `manifest.json` scanner (lenient JSON), Nexus-ID extraction (rejecting `Nexus:-1`), package→component mod **tree**, `i18n/default.json` + `<lang>.json` import.
- **Edit & validate (M2):** virtualized string table with full-row status tint, double-click editor (live validation, token chips, keyboard shortcuts), the full **protected-token taxonomy** compared as **multisets**, persisted **4-status model** (`untranslated` · `translated` · `outdated` · `review-needed`) with surgical `outdated` detection, multi-select + right-click bulk actions (single atomic bulk save), and a **Keep original** action for strings that intentionally stay English.
- **Export (M3):** per-mod export + **Export All** to `i18n/<lang>.json` in `default.json` key order (UTF-8 no BOM, 2-space), `.bak` backup + atomic write, token-safe per-key skip, summary dialog.
- **Local AI (M6):** local-LLM connection settings (Ollama / LM Studio / any OpenAI-compatible `localhost` endpoint, no API key) with "Test connection" + optional temperature, single-string translation in the editor (**Translate** / Ctrl+F5), and **batch translation** of all missing strings in a selection (context menu, progress + cancel, resume-friendly) — with glossary injection, protected-token retry, and a glossary-respect soft check. Results always land as `review-needed`.
- **External LLM batch (M4):** export the missing strings in a selection as a self-contained JSON batch (instructions + glossary excerpt embedded; context menu → "Export LLM batch"), upload it to ChatGPT, Claude, Gemini, or another file-capable LLM, then re-import the translated result (toolbar → "Import batch…"). Imported values land as `review-needed`, and locally translated strings are never overwritten by a stale batch.

### V1 status

- **M1–M4 + M6 are functionally complete.** The v1 release audit and the
  remaining M3 overwrite confirmation are complete.
- **M5 (deferred):** [Nexus translation discovery + auto-download](docs/milestones/m5-nexus-translation-download.md) (SSE-AT-style; pulls SPEC §12 v1.1→v3 forward). The "Search on Nexus" action is folded into this.
- **Next-version candidates:** see
  [the audited v1.1 backlog](docs/roadmap/v1.1-candidates.md).
- **Release packaging:** v1.0.0 ships as a Windows NSIS installer. The build and
  publication checklist lives in
  [the release process](docs/release/release-process.md).

## Documentation

- [Product & Architecture Specification](SPEC.md) - The source of truth for features and behavior.
- [Scope Guardrails](SCOPE_GUARDRAILS.md) - Strict rules for keeping the scope bounded.
- [Agent Workflow Guidance](AGENTS.md) - Rules and expectations for AI agent contributions.
- [ADR 0001 — Tech Stack Decision](docs/adr/0001-tech-stack-decision.md) - The `M0` deliverable. **Accepted: Tauri (Rust + TypeScript/WebView2)** — chosen for performance and memory on very large mods (e.g. Ridgeside Village ≈ 17.5k strings in one file).
- **Milestones:** [M0 Tech Stack](docs/milestones/m0-tech-stack-decision.md) · [M1 Setup/Scan/Import](docs/milestones/m1-setup-mod-scan-import.md) · [M2 Table/Editor/Validation](docs/milestones/m2-string-table-editor-validation.md) · [M3 Export](docs/milestones/m3-export.md) · [M4 External LLM Batch](docs/milestones/m4-llm-batch.md) · [M5 Nexus Download (deferred)](docs/milestones/m5-nexus-translation-download.md) · [M6 Local-LLM Translation](docs/milestones/m6-local-llm-translation.md)
- **Research:** [SMAPI i18n](docs/research/stardew-smapi-i18n.md) · [Nexus & translation-mod automation feasibility](docs/research/nexus-mods-strategy.md) · [Reusable old-project assets](docs/research/reusable-from-old-project.md)
- **Agent workflows:** [Overview](docs/agents/README.md) · [Antigravity](docs/agents/antigravity-workflow.md) · [Codex](docs/agents/codex-workflow.md) · [Claude Code](docs/agents/claude-code-workflow.md) · [Handoff template](docs/agents/handoff-template.md)

## Core v1 Scope Summary

- **Path Configuration:** Find Stardew Valley game directory and choose Mod folder.
- **Languages:** Select source and target languages for translation.
- **Glossary:** Optionally build official Stardew game glossary from game assets (non-blocking).
- **Mod Discovery:** Scan Mods folder, detect mods using `manifest.json`, and extract Nexus ID from `UpdateKeys`.
- **Translation Files:** Find `i18n/default.json` and import existing `i18n/<lang>.json` files.
- **User Interface:** Show mod list, display string table, edit strings, perform basic token validation, and export clean target `i18n/<lang>.json`.

## Non-Goals (Explicitly NOT in v1)

- Cloud AI APIs or API keys of any kind (the M6 local-LLM translation talks only to a local OpenAI-compatible server, e.g. Ollama / LM Studio — no key, no external network).
- Nexus API calls (validating key, automated translation search/matching).
- Automatic Nexus translation downloads/discovery.
- Internal Git integration within the app.
- Full mod manager features (disabling/enabling mods, profiles).
- Vortex/MO2 integration.
- Non-i18n JSON translation or parsing `Content Patcher` `content.json`.
- Complex dashboard, workspace studios, plugin systems, or provider abstractions.
- Complex glossary editors.
