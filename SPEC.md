# Product Contract

Stardew i18n Translator is a small, portable Windows app for translating SMAPI
mod localization files. This reference records behavior that implementation
changes must preserve. See the [user guide](docs/user-guide.md) for operation,
[AI guide](docs/ai.md) for backend behavior, and
[contribution guide](CONTRIBUTING.md) for development. Future work belongs in
GitHub Issues.

## Product Boundaries

The core workflow is to select game and Mods folders and a target language,
scan, edit or import translations, review them, and explicitly export.
Manual translation, validation, and export work offline without a glossary or
AI backend.

Translation targets are standard `<mod>/i18n/default.json` source files and
`<mod>/i18n/<lang>.json` target files. The source is normally English. The app
supports built-in and curated custom-language targets; custom targets require
a matching language mod for use in-game.

The app does not install, activate, update, or download mods; manage profiles
or Git repositories; use the Nexus API; or publish translations automatically.
It may open a browser link from a positive `Nexus:<id>` update key. It is not
a general editor for Content Patcher, `Data/*.json`, or XNB files. The narrowly
scoped glossary reads below are the only additional content sources.

## Scanning and Source Changes

- Scan recursively, associate i18n components with manifests, and group related
  components into installed packages. Do not follow links outside the selected
  Mods folder.
- Accept relaxed mod JSON, but require source and target dictionaries to be
  flat string objects. Preserve source key order for display and export.
- Import existing targets using SMAPI-compatible case-insensitive, trimmed key
  matching. Extra target keys are informational: they do not count toward
  progress or block export, and a rewritten target omits them.
- Ignore Content Patcher `assets/i18n` data. Exclude detected community language
  packs from translation targets as expected information, not a warning.
- Report malformed components and skip them without inventing empty rows or
  stopping the entire scan.

Source-change comparison uses component UniqueID, relative i18n directory, and
exact key. It compares hashes of the decoded source inventory against the last
complete scan of the same Mods folder. The first scan creates a baseline with
zero observed changes; target edits do not affect it. Traversal failures,
traversal limits, or components needing attention make change counts unavailable
and leave the last complete baseline intact. Intentional exclusions do not.

## Editing and Status

| Display | Internal status | Meaning                                                                       |
| ------- | --------------- | ----------------------------------------------------------------------------- |
| Open    | `untranslated`  | No target translation is available.                                           |
| Done    | `translated`    | Manually saved or accepted text, or an existing target imported from the mod. |
| Changed | `outdated`      | The source changed after the stored translation baseline.                     |
| Review  | `review-needed` | An AI suggestion or external LLM batch import awaiting human review.          |

Existing translations gain a source baseline when first opened, so later source
changes can mark them Changed. AI suggestions also become Changed when their
source changes. **Keep original** stores the source as an intentional target;
it is an action, not another status.

Selection is bound to exact mod/file/key identities and pruned when scope or
filters make rows unavailable. Manual and batch edits save portable translation
state; they do not write into installed mods. Live AI only targets selected
Open or Changed rows after resolving their identities from a fresh scan.
Done and Review text is not silently replaced.

**Validation issues** is an independent filter, not a status. A Review row can
have no validation finding; a Done row can still have one. Review is a request
for human assessment, not an export lock: non-empty Review and Changed values
can be exported, with their counts shown in the export confirmation.

## Validation and Export

Validation protects runtime-sensitive SMAPI, Content Patcher, dialogue, mail,
placeholder, and formatting tokens. Missing or added protected values block
export by default. **Save anyway** accepts a particular source/target mismatch
for direct export and ZIP creation; editing the target or changing the source
invalidates that acceptance.

Literal-escape differences are non-blocking warnings. Ordinary quote punctuation
and physical newline-count differences are ignored. Identical non-empty source
and target text is valid. Target-language gender switches may be added when the
source has none, while protected tokens inside their branches remain checked.
Parser-insignificant `$r` header spaces are ignored and malformed `#$b*` prefix
recovery is bounded. The [shared token fixtures](tests/fixtures/README.md)
exercise the same extraction rules in TypeScript and Rust.

Export is explicit and applies to the current mod or all scanned mods:

- Omit empty targets so SMAPI falls back to `default.json`. Non-empty Done,
  Review, and Changed values are included when validation permits them.
- Before direct-export confirmation, run a read-only preflight across the
  complete selected scope. Report blocking keys and accepted mismatches without
  creating files, backups, or operation-history entries.
- Resolve current components and file paths again, authorize paths, and validate
  the complete scope before writing. UI paths and preflight results are not
  authorization tokens.
- Prepare rollback copies before the first write. Existing targets receive
  visible `.json.bak` backups and atomic replacement. If a later write fails,
  restore earlier targets to their pre-export state.

Portuguese imports prefer `pt-BR.json`; successful exports canonicalize to
`pt.json`, backing up and removing the fallback. Existing targets, including
omitted orphan keys, remain recoverable from their export backup.

Translation ZIPs contain only generated target-language i18n files and preserve
the package's component folders. Publication notes use the same package data.
Results retain the actual destination and filename for **Show in folder**.

## External LLM Batches

The user manually transfers a self-contained JSON batch to an external LLM; the
app does not contact that service. Export accepts selected Open or Changed rows
from one mod. Import accepts one file through the picker or drag and drop and
shows a read-only preflight before writing. A wrong-mod batch can switch to that
currently scanned mod and rerun preflight.

Format 2 has `format`, `version`, `metadata`, and `files`. Metadata binds the mod
ID and target language to one SHA-256 snapshot of the sorted
`[relative file path, key, English source]` list. Import requires matching mod,
language, file/key set, and current source snapshot. Older or unknown versions
are rejected without changes.

Import skips empty values and preserves every non-empty local target, including
Changed text. It validates all values eligible for import before the first
state write. Accepted values enter Review; token errors block the import.

## Optional Glossary and AI

The glossary supplies high-confidence names for items, tools, weapons, clothing,
NPCs, locations, and seasons, not prose. Built-in languages use local
`Content/Strings/*.xnb` dictionaries, with `Content (unpacked)/Strings/*.json` as
a fallback. Custom-language packs may supply local `Strings` JSON or XNB files.
Pack inspection is read-only and limited to language registration and string
assets. Missing glossary data never blocks the core workflow; glossaries are
stored per language and never bundled with the app.

AI integrations are direct: a localhost OpenAI-compatible endpoint or the
installed Codex CLI. There is no provider registry, marketplace, custom cloud
base URL, or persisted cloud credential. Codex authentication remains entirely
owned by the CLI; the app never reads, copies, or stores its authentication
files or tokens.

Requests send selected source text, section context, and matching glossary
terms to the selected backend for exactly one target language. Nearby source
strings may be read-only context; only selected identities may be returned or
saved. Every saved suggestion enters Review, including output that passed AI
quality review. Disabling that optional quality review does not disable token
validation or change the suggestion's status.

Runs have bounded selections, prompts, and recovery. Completed suggestions are
saved as work progresses and survive cancellation or later provider failures.
Retry uses the remaining Open/Changed rows, without a persistent AI job queue.
The [AI guide](docs/ai.md) defines limits, context boundaries, quality stages,
failure behavior, and diagnostic privacy in one place.

## Portable Data

All persistent application state lives in `data/` beside the executable:

- `settings.json`: folders, language, non-secret AI preferences, last-opened
  timestamps, and Workspace view settings;
- `scan-source-snapshot.json`: source-change baseline;
- `glossary/glossary-<lang>.json`: optional glossary cache;
- `language-state/<lang>/`: translation progress;
- `logs/`: optional rotating local logs.

Workspace scope, selected mod, search, filters, sort order, pane width, and
column widths persist in settings, not browser-local storage. Selection, open
dialogs, operation history, and undo remain session-only.

Windows-safe mod IDs keep readable state filenames. Other IDs use
`state-<sha256>.json`. A unique valid legacy file can be copied forward and
retained; ambiguous legacy collisions or case-insensitive duplicate IDs block
editing. JSON inputs and outputs are size-bounded before parsing or writing.
Translation state stays separate from installed mods until explicit export.

Portable release ZIPs contain only the executable and `README.txt`, with no
user state, glossary, game assets, or credentials. Release and Nexus publication
automation belong to the [release process](docs/release/release-process.md).

## Interface and Runtime

After setup, the app opens on Overview with real scan totals, diagnostics,
recent mods, and available current-session results. Missing data remains
unavailable; production screens never substitute demo data. Workspace combines
a resizable package/mod pane with one virtualized table for This mod and All
mods, supporting search, filters, selection, keyboard use, and batch actions.

The result tray shows actual operation details and the five newest completed
backend operations in the session. **Latest result** always reopens the newest
result. One reversible batch edit has a memory-only undo snapshot until another
completed operation replaces it. A later successful edit to any touched
component permanently invalidates that snapshot, even if the value is changed
back. Undo must never overwrite newer edits.

The supported distribution is an unsigned Windows x64 portable ZIP using
Tauri 2, Rust, React, TypeScript, and Vite, with Microsoft Edge WebView2 at runtime.
There is no telemetry. Optional glossary, AI, and logging features must remain
independent of manual translation and export.
