# Stardew i18n Translator

**Stardew i18n Translator** (`stardew-i18n-translator`) is a local desktop tool for translating Stardew Valley / SMAPI mod `i18n` files.

> [!IMPORTANT]
> **Status:** Private early development.  
> **Current Phase:** `M3 merged` — the v1 core loop **Setup → Scan → Edit → Export** works end-to-end. See the honest done/open list below.  
> **Stack:** [ADR 0001](docs/adr/0001-tech-stack-decision.md) is **Accepted** (Tauri / Rust + TypeScript). The code freeze is lifted for this stack; do not introduce other frameworks.

### Implemented so far
* **Setup & scan (M1):** wizard, settings persistence, Stardew auto-detection (Steam/GOG), recursive `manifest.json` scanner (lenient JSON), Nexus-ID extraction (rejecting `Nexus:-1`), package→component mod **tree**, `i18n/default.json` + `<lang>.json` import.
* **Edit & validate (M2):** virtualized string table with full-row status tint, double-click editor (live validation, token chips, keyboard shortcuts), the full **protected-token taxonomy** compared as **multisets**, persisted **4-status model** (`untranslated` · `translated` · `outdated` · `not-translatable`) with surgical `outdated` detection, multi-select + right-click bulk actions.
* **Export (M3):** per-mod export to `i18n/<lang>.json` in `default.json` key order (UTF-8 no BOM, 2-space), `.bak` backup + atomic write, token-safe per-key skip, summary dialog.

### Still open for v1 (tracked in the milestone docs)
* **M2:** modal scan-progress dialog. *(text search, status filter, `Ctrl+A`, and column sorting are now done.)*
* **M3:** optional overwrite-confirmation (currently silent `.bak`). *(Export-all is now done.)*
* **M1:** modal scan-progress dialog. *(Glossary extraction is now built — reads a StardewXnbHack-unpacked `Content (unpacked)/`; editor glossary hints are a small M2 follow-up.)*
* **M4 (not started):** Claude-Code batch export/import (`review-needed` status returns here).
* **M5 (deferred):** [Nexus translation discovery + auto-download](docs/milestones/m5-nexus-translation-download.md) (SSE-AT-style; pulls SPEC §12 v1.1→v3 forward). The "Search on Nexus" action is folded into this.

## Documentation
* [Product & Architecture Specification](SPEC.md) - The source of truth for features and behavior.
* [Scope Guardrails](SCOPE_GUARDRAILS.md) - Strict rules for keeping the scope bounded.
* [Agent Workflow Guidance](AGENTS.md) - Rules and expectations for AI agent contributions.
* [ADR 0001 — Tech Stack Decision](docs/adr/0001-tech-stack-decision.md) - The `M0` deliverable. **Accepted: Tauri (Rust + TypeScript/WebView2)** — chosen for performance and memory on very large mods (e.g. Ridgeside Village ≈ 17.5k strings in one file).
* **Milestones:** [M0 Tech Stack](docs/milestones/m0-tech-stack-decision.md) · [M1 Setup/Scan/Import](docs/milestones/m1-setup-mod-scan-import.md) · [M2 Table/Editor/Validation](docs/milestones/m2-string-table-editor-validation.md) · [M3 Export](docs/milestones/m3-export.md) · [M4 Claude-Code Batch](docs/milestones/m4-claude-code-batch.md) · [M5 Nexus Download (deferred)](docs/milestones/m5-nexus-translation-download.md)
* **Research:** [SMAPI i18n](docs/research/stardew-smapi-i18n.md) · [Nexus & translation-mod automation feasibility](docs/research/nexus-mods-strategy.md) · [Reusable old-project assets](docs/research/reusable-from-old-project.md)
* **Agent workflows:** [Overview](docs/agents/README.md) · [Antigravity](docs/agents/antigravity-workflow.md) · [Codex](docs/agents/codex-workflow.md) · [Claude Code](docs/agents/claude-code-workflow.md) · [Handoff template](docs/agents/handoff-template.md)

## Core v1 Scope Summary
* **Path Configuration:** Find Stardew Valley game directory and choose Mod folder.
* **Languages:** Select source and target languages for translation.
* **Glossary:** Optionally build official Stardew game glossary from game assets (non-blocking).
* **Mod Discovery:** Scan Mods folder, detect mods using `manifest.json`, and extract Nexus ID from `UpdateKeys`.
* **Translation Files:** Find `i18n/default.json` and import existing `i18n/<lang>.json` files.
* **User Interface:** Show mod list, display string table, edit strings, perform basic token validation, and export clean target `i18n/<lang>.json`.

## Non-Goals (Explicitly NOT in v1)
* In-app AI API calls (e.g., automatic translating using API keys).
* Nexus API calls (validating key, automated translation search/matching).
* Automatic Nexus translation downloads/discovery.
* Internal Git integration within the app.
* Full mod manager features (disabling/enabling mods, profiles).
* Vortex/MO2 integration.
* Non-i18n JSON translation or parsing `Content Patcher` `content.json`.
* Complex dashboard, workspace studios, plugin systems, or provider abstractions.
* Complex glossary editors.
