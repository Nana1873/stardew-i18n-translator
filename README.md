# Stardew i18n Translator

Early-stage planning repository for **Stardew i18n Translator** (`stardew-i18n-translator`), a local desktop tool for Stardew Valley / SMAPI mod translations.

> [!IMPORTANT]
> **Status:** Private early-stage planning.  
> **Current Phase:** `M0 - Tech Stack Decision`  
> **Warning:** Do NOT implement application code before [ADR 0001: Tech Stack Decision](file:///docs/adr/0001-tech-stack-decision.md) is accepted and approved.

## Documentation
* [Product & Architecture Specification](file:///SPEC.md) - The source of truth for features and behavior.
* [Scope Guardrails](file:///SCOPE_GUARDRAILS.md) - Strict rules for keeping the scope bounded.
* [Agent Workflow Guidance](file:///AGENTS.md) - Rules and expectations for AI agent contributions.

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
