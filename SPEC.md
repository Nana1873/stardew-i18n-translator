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
4. Review the real scan summary on Overview, then open Workspace.
5. Browse, search, filter, select, edit, and review strings.
6. Validate protected Stardew and SMAPI tokens.
7. Export target-language `i18n` files or a translation package ZIP.

Glossary and AI features are optional additions to this loop. They must never
be required for ordinary translation and export. Manual translation and all
local-only workflows remain available without contacting a cloud service.

## 4. Setup and Languages

Setup stores the Stardew Valley folder, Mods folder, target language, and
non-secret AI preferences in the portable `data/` folder.

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
- compares the decoded English source inventory with the preceding successful
  scan of the same Mods folder and reports changed, added, and removed strings;
- does not traverse links that escape the selected Mods folder;
- warns and skips only a malformed i18n component instead of inventing empty
  rows or stopping the complete scan.

A positive `Nexus:<id>` update key may be shown as an external link. Sentinel
values such as `Nexus:-1` are treated as no Nexus ID.

Source comparison uses component UniqueID, relative i18n directory, and exact
key as the stable identity. The first scan of a Mods folder creates the
baseline and therefore reports zero observed changes. The snapshot contains
hashes only; target-language changes do not affect it.

## 7. User Interface

The application opens on **Overview**, with **Workspace** immediately beside it
in the primary navigation.

Overview uses only real scanner, portable-settings, and current-session result
data. It shows scan totals and diagnostics, recently opened mods, useful all-mod
filter shortcuts, and the latest successful export path when those values
exist. Missing aggregate counts, timestamps, change deltas, or history are shown
as **Unavailable**; the production UI never fills them with demo data.

Workspace is the two-panel translation view:

- the resizable left pane lists scanned packages and every component mod;
- the right pane contains one virtualized table for **This mod** and **All
  mods** scopes;
- search, status filters, the independent Validation issues filter, sortable
  columns, multi-select, bulk actions, context menus, tooltips, and keyboard
  navigation support large translation sets;
- **Mod**, **File**, **Status**, **Key**, **English Source**, and **Target
  Translation** are individually resizable when present; validation and row
  actions remain in a fixed trailing lane;
- Settings contains folders, language, glossary, the direct Local AI and Codex
  CLI backends, shortcuts, logging, and app information;
- completed operations appear in a compact result tray that can be collapsed,
  closed, and reopened through **Latest result**. It exposes real paths and file
  names, **Copy details**, relevant follow-up actions, and the five newest
  backend history entries for the running session;
- one reversible batch edit has an in-memory undo snapshot until a newer
  completed operation replaces it, and stale undo must never overwrite later
  string edits.

The UI should remain a focused translation tool rather than a general workspace
or project-management suite.

## 8. Editing Workflow

Strings can be edited in the table workflow and the full string editor. The app
supports manual translation, review navigation, and a **Keep original** action
that intentionally stores the source text as the target text.

Rows can be selected with checkboxes, Ctrl+click, Shift+click, keyboard
selection, or Ctrl+A over the current filtered result. Batch actions can copy
source or target text, mark strings as Done, keep the English source, clear
translations, run AI translation, or export an external LLM batch. The batch
trigger and each row's right-click menu expose the same actions. Selection is
bound to exact mod/file/key identities and is pruned when scope or filters make
rows unavailable.

Live AI targets only exact selected Open or Changed strings. The backend resolves
those identities from a fresh scan before sending any source text. Done and
Review text is not silently replaced.

Saving work updates the portable translation state. Export remains an explicit
user action.

## 9. Translation Status

The app uses four string states:

- **Open** (`untranslated`): no accepted target text;
- **Done** (`translated`): manually saved or explicitly accepted;
- **Changed** (`outdated`): the source changed after the saved translation;
- **Review** (`review-needed`): imported or AI-generated output, including the
  result of AI review and terminology repair, that still needs human approval.

**Keep original** is an action, not a fifth status.

**Validation issues** is also not a status. It is an independent filter over
the current source and target values. Review answers “has a human accepted this
suggestion?” while validation answers “does the current text trigger a safety
rule or review warning?” A row can therefore be in Review without a validation
finding, or have a validation finding while in another status.

## 10. Validation

Validation protects runtime-sensitive SMAPI, Content Patcher, dialogue, mail,
placeholder, and formatting tokens.

Token errors identify missing or added protected values and block export by
default. When a translator explicitly chooses **Save anyway** for a string, the
accepted mismatch no longer blocks direct export or translation-package ZIPs.
The acceptance applies only to that saved source revision; editing the target
or a changed English source requires confirmation again. Review warnings, such
as punctuation or newline differences, do not block export.

The **Validation issues** filter includes both blocking errors and non-blocking
warnings. The row indicator and editor explain the exact finding; the backend
revalidates the complete export or import scope before the first write.

Untranslated strings do not block export. They are omitted so SMAPI can fall
back to `default.json`.

## 11. External LLM Batch

The app can export a self-contained JSON batch for a file-capable external LLM
and import the completed result.

The desktop app does not contact that service. The user transfers the file
manually. Imported values enter `review-needed`, validation runs immediately,
and already accepted local translations are not silently overwritten.

The export action accepts any number of selected Open or Changed strings from
one mod. Import accepts one JSON file through the native picker or drag and drop
and shows a read-only preflight before it can write. The preflight reports the
batch and selected mod IDs, target language, source snapshot, supplied and
matched strings, preserved local values, empty values, identical values,
importable values, and structured protected-token issues. A wrong-mod batch may
switch to that currently scanned mod and rerun the complete preflight.

Batch format 2 contains only `format`, `version`, `metadata`, and `files`.
Metadata binds the selected mod ID and target language to one SHA-256 snapshot
over the sorted `[relative file path, key, English source]` list. It does not
carry per-string hashes. Import requires the same mod, language, file/key set,
and current English source snapshot, validates all protected tokens before the
first state write, skips empty values, and preserves every non-empty local
translation. Format 1 and unknown versions are rejected without changes.

## 12. Nexus and Translation Packages

The desktop app does not call the Nexus Mods API, store a Nexus API key, search
for translations, or download mods.

It may display a browser link derived from a mod's positive Nexus update key.

For sharing completed work, the app can build an installable translation ZIP
containing only generated target-language `i18n` files while preserving the
package's component folder structure. It can also generate short localized
publication notes from the same package data.

Direct export is available for the current mod or all scanned mods. Export and
ZIP results retain the real destination path and file name for result details
and **Show in folder**. Existing target files receive visible backups, and the
complete selected scope is validated before any multi-file transaction writes.

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
- `data/scan-source-snapshot.json`
- `data/glossary/glossary-<lang>.json`
- `data/language-state/<lang>/`
- `data/logs/`

Dashboard recency is part of the portable settings state; the app does not keep
workflow state in browser-local storage.

Workspace search values, This mod/All mods scope, status and Validation issues
filters, sort order, selected mod, mod-pane width, and table-column widths are
also stored in portable settings. Selection, open dialogs, result history, and
undo snapshots remain session-only.

Result-tray history is bounded to five completed backend operations for the
running app session. Its single batch-undo snapshot is also memory-only; it is
not a hidden project log and is never written to portable state. A later
completed operation replaces that snapshot. Any later successful edit to a
touched component also makes it permanently stale, even when the edited value
is changed back to the batch-written value.

Codex CLI authentication remains owned by the CLI; the app does not read, copy,
or persist its authentication files or tokens.

Translation state is separate from installed mods. The app does not modify mod
files until the user explicitly exports.

Windows-safe mod UniqueIDs retain their readable state filename. IDs that
cannot be represented without loss use `state-<sha256>.json`; a unique valid
legacy file is copied forward and retained, while ambiguous legacy collisions
and case-insensitive duplicate IDs are blocked from editing.

Exports validate and serialize the complete selected mod and prepare rollback
copies before the first write. Each file still uses a user-visible backup and
atomic replacement; if a later package write fails, every earlier target is
restored to its pre-export state. Portuguese imports prefer `pt-BR.json`, while
successful exports canonicalize to `pt.json` and back up/remove the fallback.
Release packages must not contain the user's `data/` folder.

## 15. Current Capabilities

The maintained product includes:

- setup and Stardew path detection;
- recursive mod scanning and package grouping;
- existing translation import;
- a virtualized string table and editor;
- Overview and a two-panel Workspace;
- search, status and validation filters, resizable sortable columns,
  multi-select, review queues, context menus, and bulk actions;
- protected-token validation;
- optional typed glossary hints;
- optional AI translation through a localhost endpoint or Codex CLI;
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
- persisted cloud AI credentials, an AI provider marketplace or registry, or
  configurable custom cloud base URLs;
- Nexus API operations;
- internal Git repositories or project files;
- a general Content Patcher interpreter;
- arbitrary JSON or XNB editing;
- automatic publishing of translation mods from inside the desktop app.

## 17. Optional AI Backends

AI translation is optional. Manual translation and every local-only workflow
remain offline and usable when an AI backend is unavailable.

Local AI connects only to a user-configured localhost OpenAI-compatible
endpoint, such as Ollama or LM Studio. Settings can restore the selected local
service's default Base URL, test the connection, and choose a reported model.

The Codex CLI backend invokes an installed CLI and relies exclusively on that
CLI's own authentication. The app does not inspect, import, copy, or persist
Codex authentication files or tokens. Settings discovers the models currently
reported by the installed CLI and persists only the selected model id. The app
does not maintain its own Codex model catalogue. If discovery is unavailable or
no model has been selected, runs use the CLI's own default model.

An AI request sends the source text, its section context, and matching glossary
terms to the selected backend. Each run is bound to exactly one currently
selected target language; built-in and curated custom-language targets use the
same workflow. Batch AI receives exact selected string identities and includes
selected Open and Changed strings only.

The backend preserves source order and may include up to two preceding and two
following English source strings from the same component, relative i18n file,
section, and meaningful contiguous key-prefix group. These boundaries keep
related dialogue or menu-like entries together without inventing topic or
reference metadata that SMAPI i18n files do not contain. Neighboring
strings are read-only context. The output contract permits only selected IDs,
so context-only strings cannot be returned as translations or written to state.

Live runs accept at most 4,096 selected strings and 8 MiB of selected source
text. Codex CLI selections are divided into adaptive batches of at most 100
selected strings, with every complete serialized prompt bounded to 96 KiB.
Oversized neighboring context is removed farthest-first; the selected source is
never trimmed.

Codex CLI recovery is limited: one transient failure may be retried, while an
invalid structured response gets one corrected attempt. If it remains invalid,
only that Codex CLI batch is halved until the failing string is isolated, so
unrelated strings can continue.

A Codex translation run first produces an initial draft. Every draft then
receives a full AI review that corrects issues
in source meaning, natural phrasing in the target language, terminology,
grammar, register, speaker voice, and dialogue continuity; review is not
restricted to strings with token or glossary warnings. Only after that full
review, reviewed results with a conservatively detected glossary or terminology
candidate receive exactly one focused repair pass. The focused pass may retain
contextually correct inflections or compounds unchanged. No terminology repair
pass runs without such a candidate.

Codex groups contiguous selected strings into adaptive chunks of at most 100
items and additionally bounds the complete serialized prompt. Read-only
neighboring sources are pooled once per prompt and referenced in source order;
this representation must preserve the same section, glossary, and before/after
context as the unpooled request. A single long source may occupy its own chunk.

Each stage accepts only structurally valid output. A failed or oversized full
review leaves the affected chunk incomplete so it can be retried. If the
optional focused repair fails or returns unusable output, the fully reviewed
text is retained. Suggestions from completed adaptive chunks are saved
immediately as `review-needed` when validation reaches them, including results
that passed both AI quality stages. Cancellation or a later provider error
retains already persisted suggestions; selected items still in Open or Changed
remain available for a later retry.

After the language-quality stages, a protected-token mismatch gets one targeted
Codex CLI repair attempt with the exact required and returned token counts when
that complete prompt fits the same 96 KiB bound. An individually oversized
repair input skips the extra call. If repair fails or is skipped, the best
structurally valid suggestion enters Review with the existing blocking
validation issue. Local AI keeps its direct single-string request and existing
one-time protected-token retry.

The compact progress dialog receives persisted progress such as `320 / 1000`
and retains its existing Cancel action. It also reports the current quality
phase, adaptive outer batch, elapsed time, bounded retry/split activity, and
Codex-reported token usage when available, without fabricating within-call
completion percentages. A later run over the same scope naturally processes
the remaining Open or Changed strings instead of maintaining a separate
persistent AI job history, queue, or checkpoint store. Token validation and
human review remain the final safety gates.

These are direct integrations. The product does not provide a provider
marketplace, provider registry, or configurable custom cloud base URL.

## 18. Technical Constraints

- Supported distribution: unsigned 64-bit portable Windows ZIP.
- Desktop stack: Tauri 2, Rust, React, TypeScript, and Vite.
- Runtime dependency: Microsoft Edge WebView2.
- Large mods require virtualized rendering and efficient scanning.
- Unicode, JSON key order, protected tokens, and package-relative paths must be
  preserved.
- Full-buffer JSON and state inputs must be size-bounded before parsing.
- File-system failures must be reported without leaving partial exports.
- Optional systems such as glossary, AI backends, logging, and Nexus publication
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
