# Stardew i18n Translator — Product Reference

This document describes the durable behavior of the current application. It is
not a roadmap, release checklist, or issue tracker. Planned work belongs in
GitHub Issues.

## 1. Product Goal

Stardew i18n Translator is a portable Windows desktop app for translating
Stardew Valley and SMAPI mod localization files.

The app helps a translator scan installed mods, import existing work, edit and
review strings safely, and export valid target-language files without manually
working through large JSON documents.

## 2. Target Users

The primary users are mod translators, mod authors reviewing translations, and
players translating mods for personal use. The normal workflow must not require
Git, command-line tools, or knowledge of the app's internal data model.

## 3. Core Workflow

The durable product loop is:

1. Select or auto-detect the Stardew Valley and Mods folders.
2. Select a target language.
3. Scan mods and import available target-language files.
4. Browse, search, filter, edit, and review strings.
5. Validate protected Stardew and SMAPI tokens.
6. Export target-language `i18n` files or a translation package ZIP.

Glossary and AI features are optional additions to this loop. They must never
be required for ordinary translation and export.

## 4. Setup and Languages

Setup stores the Stardew Valley folder, Mods folder, target language, and local
AI settings in the portable `data/` folder.

The source language is the mod's `i18n/default.json`, normally English.

Built-in Stardew target languages:

- German (`de`)
- Spanish (`es`)
- French (`fr`)
- Hungarian (`hu`)
- Italian (`it`)
- Japanese (`ja`)
- Korean (`ko`)
- Portuguese (`pt`)
- Russian (`ru`)
- Turkish (`tr`)
- Chinese (`zh`)

Curated custom-language targets:

- Vietnamese (`vi`)
- Indonesian (`id`)
- Ukrainian (`uk`)
- Polish (`pl`)
- Finnish (`fi`)
- Dutch (`nl`)
- Czech (`cs`)
- Thai (`th`)

Custom-language targets can be translated and exported normally, but Stardew
requires a matching custom-language mod before those files can be used in-game.

## 5. Glossary

The glossary provides high-confidence Stardew terms such as items, tools,
weapons, clothing, NPCs, locations, and seasons. It does not translate normal
prose.

For built-in game languages, the app reads glossary-relevant local
`Content/Strings/*.xnb` dictionaries. A compatible
`Content (unpacked)/Strings/*.json` folder remains a fallback.

For custom-language targets, an installed Content Patcher language pack may
supply glossary terms from its local `Strings` JSON or XNB dictionaries. Pack
inspection is read-only and narrowly limited to language registration and
string assets.

Glossaries are optional, stored per language in
`data/glossary/glossary-<lang>.json`, and never bundled with the app.

## 6. Mod Scan and Import

The scanner recursively finds mod manifests and nearby `i18n` folders. It:

- reads `manifest.json` metadata;
- groups components that belong to the same installed package;
- uses `default.json` as the source key inventory;
- imports the selected target-language file when present;
- accepts the relaxed JSON commonly found in real mods;
- requires source and existing target files to be flat string objects;
- preserves source key order for later export;
- warns and skips only a malformed i18n component instead of inventing empty
  rows or stopping the complete scan.

A positive `Nexus:<id>` update key may be shown as an external link. Sentinel
values such as `Nexus:-1` are treated as no Nexus ID.

## 7. User Interface

The application has a dashboard home and a two-panel work view:

- the left side lists scanned packages and component mods;
- the right side shows the selected mod's strings;
- search, status filters, review queues, bulk actions, and keyboard navigation
  support large translation sets;
- Settings contains folders, language, glossary, local AI, shortcuts, logging,
  and app information;
- completed exports, imports, batches, and ZIP builds remain available in a
  compact result tray.

The UI should remain a focused translation tool rather than a general workspace
or project-management suite.

## 8. Editing Workflow

Strings can be edited in the table workflow and the full string editor. The app
supports manual translation, bulk actions, review navigation, and a
**Keep original** action that intentionally stores the source text as the target
text.

Saving work updates the portable translation state. Export remains an explicit
user action.

## 9. Translation Status

The app uses four string states:

- `untranslated`: no accepted target text;
- `translated`: manually saved or explicitly accepted;
- `outdated`: the source changed after the saved translation;
- `review-needed`: imported AI output that still needs human review.

**Keep original** is an action, not a fifth status.

## 10. Validation

Validation protects runtime-sensitive SMAPI, Content Patcher, dialogue, mail,
placeholder, and formatting tokens.

Token errors identify missing or added protected values and block only the
affected strings from export. Review warnings, such as punctuation or newline
differences, do not block export.

Untranslated strings do not block export. They are omitted so SMAPI can fall
back to `default.json`.

## 11. External LLM Batch

The app can export a self-contained JSON batch for a file-capable external LLM
and import the completed result.

The desktop app does not contact that service. The user transfers the file
manually. Imported values enter `review-needed`, validation runs immediately,
and already accepted local translations are not silently overwritten.

## 12. Nexus and Translation Packages

The desktop app does not call the Nexus Mods API, store a Nexus API key, search
for translations, or download mods.

It may display a browser link derived from a mod's positive Nexus update key.

For sharing completed work, the app can build an installable translation ZIP
containing only generated target-language `i18n` files while preserving the
package's component folder structure. It can also generate short localized
publication notes from the same package data.

## 13. Supported Files

Translation, editing, import, and export support:

- `<mod>/i18n/default.json`
- `<mod>/i18n/<lang>.json`

The app is not a general parser or editor for `content.json`, arbitrary
`Data/*.json`, dialogue files outside SMAPI i18n, or arbitrary XNB files.

The glossary sources in section 5 are the only narrow read-only exception.

## 14. Data and Persistence

All application state is portable and stored beside the executable:

- `data/settings.json`
- `data/glossary/glossary-<lang>.json`
- `data/language-state/<lang>/`
- `data/logs/`

Translation state is separate from installed mods. The app does not modify mod
files until the user explicitly exports.

Windows-safe mod UniqueIDs retain their readable state filename. IDs that
cannot be represented without loss use `state-<sha256>.json`; a unique valid
legacy file is copied forward and retained, while ambiguous legacy collisions
and case-insensitive duplicate IDs are blocked from editing.

Exports validate and serialize the complete selected mod before the first
write, then use per-file backups and atomic replacement. Portuguese imports
prefer `pt-BR.json`, while successful exports canonicalize to `pt.json` and
back up/remove the fallback. Release packages must not contain the user's
`data/` folder.

## 15. Current Capabilities

The maintained product includes:

- setup and Stardew path detection;
- recursive mod scanning and package grouping;
- existing translation import;
- a virtualized string table and editor;
- search, filters, review queues, and bulk actions;
- protected-token validation;
- optional typed glossary hints;
- optional localhost AI translation;
- external LLM batch export and import;
- target-file export with backups;
- translation package ZIP creation;
- localized translation notes;
- portable settings, progress, and logs.

This section records product behavior only. Release status and future work are
tracked outside this document.

## 16. Non-Goals

Unless a current user request explicitly changes the product direction, the app
does not provide:

- mod installation, activation, updating, profiles, or load-order management;
- automatic translation discovery or downloads;
- cloud AI credentials or an AI provider marketplace;
- Nexus API operations;
- internal Git repositories or project files;
- a general Content Patcher interpreter;
- arbitrary JSON or XNB editing;
- automatic publishing of translation mods from inside the desktop app.

## 17. Local AI

Local AI is optional and connects only to a user-configured localhost
OpenAI-compatible endpoint, such as Ollama or LM Studio.

Single-string and batch suggestions may use source context and matching glossary
terms. Output always enters `review-needed`. Token validation remains the final
safety gate, and failure to reach a local model must not affect manual use.

## 18. Technical Constraints

- Supported distribution: unsigned 64-bit portable Windows ZIP.
- Desktop stack: Tauri 2, Rust, React, TypeScript, and Vite.
- Runtime dependency: Microsoft Edge WebView2.
- Large mods require virtualized rendering and efficient scanning.
- Unicode, JSON key order, protected tokens, and package-relative paths must be
  preserved.
- File-system failures must be reported without leaving partial exports.
- Optional systems such as glossary, local AI, logging, and Nexus publication
  automation must degrade without breaking the translation workflow.

## 19. Simplicity Principles

- Solve the current user problem before designing for hypothetical future use.
- Prefer existing modules and direct code over frameworks or provider layers.
- Add abstractions only after repeated concrete duplication makes them useful.
- Keep UI actions tied to the translation workflow.
- Keep documentation concise and current; do not mirror milestones or issue
  checklists in repository files.
- Use GitHub Issues for active planning and `CHANGELOG.md` plus release notes for
  release history.
