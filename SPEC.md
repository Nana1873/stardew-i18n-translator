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
`<mod>/i18n/<lang>.json` target files, plus split `i18n/default/*.json` and
`i18n/<lang>/*.json` locale folders with unambiguous source-key membership. The
source is normally English. The app supports built-in and curated
custom-language targets; custom targets require a matching language mod for use
in-game.

The app does not install, activate, update, or download mods; manage profiles
or Git repositories; use the Nexus API; or publish translations automatically.
It may open a browser link from a positive `Nexus:<id>` update key. It is not
a general editor for Content Patcher, `Data/*.json`, or XNB files. The narrowly
scoped glossary reads below are the only additional content sources.

Blank source/target pairs need no text and are derived as Done without
persisting an approval. Newly populated sources reopen them. Working coverage
counts these pairs separately from nonempty translated values and reserves 100%
for exact completion.

For a nonblank source, saving exactly one ASCII space as the target explicitly
suppresses visible text. It counts as Done and working coverage, survives
reloads, and is exported unchanged by JSON and both translation ZIP workflows.
Imported single-space targets behave the same way. A later source change marks
the saved entry Changed. A fully empty target remains Open; other whitespace
does not imply this intent. Protected-token validation still applies.

## Scanning and Source Changes

- Scan recursively, associate i18n components with manifests, and group related
  components into installed packages. Do not follow links outside the selected
  Mods folder. Match `manifest.json` case-insensitively and skip folders whose
  name starts with `.`, as SMAPI does; such folders are neither translation
  targets nor duplicate-UniqueID candidates.
- Accept relaxed mod JSON in UTF-8 or, with a byte order mark, UTF-16. Require
  source dictionaries to be flat string objects. In a target, read numbers and
  booleans as text and treat other non-string values as untranslated; a
  rewritten target drops them, and only its `.bak` keeps them. SMAPI itself
  skips a whole file that holds a list or object value, so exporting again
  makes such a file usable in the game. Preserve
  source key order for display and export.
- In a split `i18n/<lang>/` folder, an unreadable locale document blocks only
  the source document of the same name; other unreadable documents are
  ignored for export and reported once as a scan warning.
- An `i18n` folder with both top-level files and language folders loads like
  SMAPI: only the top-level files are used. The scan lists its language
  folders as information, not as a problem.
- Import existing targets using SMAPI-compatible case-insensitive, trimmed key
  matching. Extra target keys are informational: they do not count toward
  progress or block export, and a rewritten target omits them.
- Translate only `i18n` folders beside a `manifest.json`, the only ones SMAPI
  loads; components with their own manifest each count. A deeper `i18n` folder
  without one is listed as information, not offered as a target.
- Offer a component only if SMAPI reads its folder as a mod folder. SMAPI
  searches the Mods folder and goes into a subfolder only while that subfolder
  holds other folders and no relevant file; the first folder with a relevant
  file is read as one mod, and nothing inside it is searched. The Mods folder
  itself is never a mod, even with a `manifest.json` in it. Files SMAPI
  ignores are those starting with `.`, readmes and documents (`.md`, `.txt`,
  `.doc`, `.docx`, `.rtf`), the image formats `.bmp`, `.gif`, `.ico`, `.jpeg`,
  `.jpg`, `.png`, `.psd`, `.tif` and `.xcf`, the archives `.rar`, `.zip`, `.7z`
  and `.tar`, backups (`.bak`, `.old`,
  `.backup`), shortcuts (`.url`, `.lnk`), `desktop.ini`, `Thumbs.db`,
  `.DS_Store`, `._*`, and `__folder_managed_by_vortex`; it also skips folders
  named `__MACOSX` or `mcs`. So `Pkg/[CP] X` and `Pkg/[JA] X` both load when
  `Pkg` holds only those folders and a readme, but neither loads when `Pkg`
  also holds a `config.json`, and `Mod/optional` never loads when `Mod` has its
  own `manifest.json`. A `manifest.json` SMAPI never reaches is listed as
  information (path relative to the Mods folder) instead of a component, and
  `i18n` folders below it are not listed again. Community language packs follow
  the same rule. A folder reachable both directly and through a folder link is
  judged by its real path.
- Ignore Content Patcher `assets/i18n` data. Exclude detected community language
  packs from translation targets as expected information, not a warning.
- Report malformed components and skip them without inventing empty rows or
  stopping the entire scan.

Source-change comparison uses component UniqueID, relative i18n directory, and
exact key. It compares hashes of the decoded source inventory against the last
complete scan of the same Mods folder. The first scan creates a baseline with
zero observed changes; target edits do not affect it. A component the scan had
to skip is left out of the comparison and keeps its previous baseline until it
scans again, so the other components are still compared. Traversal failures,
traversal limits, or a skip without a component identity (such as an unreadable
manifest) make change counts unavailable and leave the last complete baseline
intact. Intentional exclusions do not.

## Editing and Status

| Display | Internal status | Meaning                                                               |
| ------- | --------------- | --------------------------------------------------------------------- |
| Open    | `untranslated`  | The source needs text, but no target translation is available.        |
| Done    | `translated`    | Saved or accepted text, an imported existing target, or a blank pair. |
| Changed | `outdated`      | The source changed after the stored translation baseline.             |
| Review  | `review-needed` | An AI suggestion or external LLM batch import awaiting human review.  |

Existing translations gain a source baseline when first opened, so later source
changes can mark them Changed. AI suggestions also become Changed when their
source changes. **Keep original** stores the source as an intentional target;
it is an action, not another status.

Selection is bound to exact mod/file/key identities and pruned when scope or
filters make rows unavailable. Manual and batch edits save portable translation
state; they do not write into installed mods. Live AI only targets selected
Open or Changed rows after resolving their identities from a fresh scan.
Done and Review text is not silently replaced.

**Validation issues** is a separate table view, not a status. Selecting Issues
shows validation findings, including accepted token mismatches, across all
statuses in the current scope and search; selecting a status leaves Issues.
A Review row can have no validation finding; a Done row can still have one. Review is a request
for human assessment, not an export lock: non-empty Review and Changed values
can be exported, with their counts shown in the export confirmation.

## Validation and Export

Validation protects runtime-sensitive SMAPI, Content Patcher, dialogue, mail,
placeholder, and formatting tokens. Each count difference is an **error** or a
**warning**, verified against the Stardew 1.6 dialogue, mail, and token parsers:

- Errors break the game: a damaged gender switch (an extra `${` or `}$`, or a
  switch inside a switch, which the game does not nest), a `#$b#` replaced by
  a bare `#` (the conversation ends there), any page change (`#`, `#$b#`,
  `#$e#`, `#$k#`) in a string with `$1` or `$c`, or with `$d` when its
  versions are split by `#`, because these count pages, a changed `|` in a
  `$d` dialogue, a dialogue command that starts a page (such as `$q`, `$r`,
  `$y`, `$p`, `$d`, `$c`, `$action`) and an inline `$k`, a new `$command`
  inside a line (shown as text), event commands `%fork` and `%revealtaste`,
  the arguments of a command that opens the string (such as
  `$q 305/306 null#` or the one-time flag `$1 metHarvey#`), the `_`
  separators inside a `$y '…'` quick response, a single `}`, an added single
  `{` when the English text has `{0}`-style placeholders, mail
  `%item`/`%action ... %%` (spacing and the item type's case are ignored),
  item brackets such as `[128]` that give an item in dialogue, an added empty
  `[]`, a new broken `#$b$`, a letter command the game does not recognize
  (`[TextColor …]`, `[letterbg zwei]`), a bracket token whose name and first
  argument (a text key, character name, or item ID) are not in the English
  text (such as a `[LocalizedText …]` or `[CharacterName …]` whose key or
  name was translated, which the game shows as raw text; translated text
  arguments of tokens such as `[GenderedText …]` or an `[ItemName …]`
  fallback are fine), renamed or new `{{placeholders}}`, a `{n}` above the
  highest index in the English text, and an added portrait or a removed `#`
  or `^` that puts a second, different portrait on one dialogue page for
  either player gender (the game removes every copy of the one it applies, so
  a repeated portrait is harmless). `$neutral` is not a portrait command in
  dialogue text.
- Warnings are cosmetic or legitimate translation choices: portrait changes
  (a missing index falls back to portrait 0), a cleanly removed or reshaped
  gender switch, a missing `${` or `}$` (already broken in the English text),
  `@`, the dialogue placeholders `%adj`, `%noun`, `%place`, `%spouse`,
  `%name`, `%firstnameletter`, `%time`, `%band`, `%book`, `%pet`, `%farm`,
  `%favorite`, `%year`, `%kid1`, `%kid2`, `%season`, and `%noturn` (missing,
  added, or renamed; the game replaces only the exact lowercase name, so
  `%Spouse` stays text, and a percent sign such as `50%` is never one), a
  missing `$command` inside a line (the game shows it as text in the English
  line too), a dropped placeholder, an extra copy of a `{{placeholder}}` or a
  repeated `{n}`, a missing value token such as `[FarmName]` or
  `[ItemName …]`, an extra copy of one in the English text, an added built-in
  value without arguments such as `[FarmName]` or `[Season]`, an added
  `[ArticleFor …]`, a changed letter background or text color
  (`[letterbg …]`, `[textcolor …]`), a dropped or added `#$b#` (the game
  moves long text into extra boxes itself), a `*` in a `$y` reply, `#$e#` and
  a `#$k#` page (they show nothing but end the conversation like a bare `#`),
  a changed `||` weekly split, a dropped single `{`, an added one when the
  English text has no `{0}`-style placeholders, a dropped empty `[]` or broken
  `#$b$`, and a changed bare `^` or `#` that does not put two different
  portraits on one page or detach a `$y` quick response. In dialogue a bare
  `#` ends the conversation and `^` splits male and female text, but both are
  plain text in letters (`^` is a line break) and UI strings, and the app
  cannot tell these apart reliably, so the translator decides.
- Letters (an English text with one `[#]`) are compared as the game shows
  them: only the text before the first `[#]`, per player gender. A missing or
  extra `[#]` is a warning. Dialogue commands, `%` placeholders, and bracket
  tokens are plain text there: a missing one is a warning, a new one shows as
  text and is an error. `%item`, `%action`, letter commands, gender switches,
  and placeholders keep their rules.

Warnings never block. An unaccepted error leaves only that string out of direct
export and ZIP creation, so SMAPI shows its English source; every other value is
still written. **Save anyway** accepts a particular source/target mismatch;
editing the target or changing the source invalidates that acceptance.
Accepted token mismatches remain visible in Issues with a yellow warning icon
and a tooltip identifying the acceptance. Ordinary warnings also use yellow;
unresolved errors use red. Acceptance does not change a Done row's workflow
status or waive other errors.

Literal-escape differences are non-blocking warnings. Ordinary quote punctuation
and physical newline-count differences are ignored. Identical non-empty source
and target text is valid. Target-language gender switches may be added when the
source has none, while protected tokens inside their branches remain checked.
When only one side has a switch, tokens are counted as one player sees them: a
token repeated in every branch counts once. A page may start with a switch or a
portrait (`#${he^she}$ ...`, `#$hSo ...`).
Parser-insignificant `$r` header spaces are ignored and malformed `#$b*` prefix
recovery is bounded. The [shared token fixtures](tests/fixtures/README.md)
exercise the same extraction rules in TypeScript and Rust.

Export is explicit and applies to the current mod or all scanned mods. One
**Files… > Export…** dialog asks for the scope (**This mod** or **All mods**)
and the output (**ZIP** or **JSON** into the Mods folder), then shows the
matching preview. It opens on This mod + ZIP (All mods without a selected
mod) and keeps the last choice for the session. All mods JSON export works per
component: it writes every component the scan loaded, even when the scan skipped
another component of the same package, while the all-mods ZIP leaves a package
with a skipped component out. JSON export:

- Omit empty targets and strings with unaccepted token errors so SMAPI falls
  back to `default.json`. Non-empty Done, Review, and Changed values are
  included otherwise. A target file left with no non-empty values is backed up
  and removed.
- Before direct-export confirmation, run a read-only preflight across the
  complete selected scope. Report strings that will stay English and accepted
  mismatches without creating files, backups, or operation-history entries.
- Resolve current components and file paths again, authorize paths, and validate
  the complete scope before writing. UI paths and preflight results are not
  authorization tokens.
- Prepare rollback copies before the first write. Existing targets receive
  visible `.json.bak` backups and atomic replacement. If a later write fails,
  restore earlier targets to their pre-export state.

SMAPI looks up translations by the game's regional locale first (`de-DE`,
`es-ES`, `pt-BR`, `zh-CN`, ...), then the language code. Flat imports for every
game language read `i18n/<lang>-<REGION>.json` together with `i18n/<lang>.json`;
file names match case-insensitively and the regional value wins per key. Split
layouts do the same per document: `i18n/<lang>-<REGION>/X.json` is read
together with `i18n/<lang>/X.json`, also when only the regional document
exists. Like SMAPI, which skips a file it cannot read, a broken canonical or
regional file of such a pair is skipped while the other one still applies; the
scan names the skipped file. JSON export does not stop on it, since it replaces
or removes that file with a `.bak` backup. Only the target language's
own regional code counts, so `en-GB.json` is untouched. Successful JSON exports
canonicalize to `i18n/<lang>.json` (or `i18n/<lang>/X.json`), back up and
remove the regional file, and name it in the result tray and Activity log
relative to the Mods folder.
Translation ZIPs never contain a regional file and do not change or remove
files in the Mods folder. When the original mod still has one, the ZIP preview
shows one plain, non-blocking line per mod naming it relative to the Mods
folder. It addresses the translator building the ZIP, since players who install
it never see the app: tell players to delete that file after installing, for
example on the mod page. Document names inside a language folder are literal
and do not trigger this language-filename migration (`i18n/de/pt.json` stays
as is). Existing targets, including omitted orphan keys, remain recoverable
from their export backup.

Translation ZIPs contain only generated target-language i18n files for separate
installation with Vortex or MO2. Each component's manifest folder name is its
default installation folder under the game's Mods folder; local package/staging wrappers are omitted. The preview allows folder
overrides for renamed mods or retained package layouts. Invalid paths and
case-insensitive component-folder or output-path collisions block the build
before replacing any archive. No original manifests or assets are included.
Coverage and open reviews remain visible in the workspace and export preview.
Package preview and build resolve current component/file bindings again. A
changed component inventory, version, or file list requires a new displayed
scan and preview before writing.
Results retain the actual destination and filename for **Show file** and
**Open folder**.
ZIP replacement is confirmed by the native Windows Save dialog, without a
second app confirmation. Canceling the picker leaves the existing archive
unchanged; a confirmed build replaces it only after the new archive is complete.
**Export…** with **All mods** and **ZIP** previews and writes one translation ZIP,
with the package name **Stardew Translator Output**, for all
scanned components with effective target-language values in the configured Mods
folder. A package the scan had to skip in whole or in part is left out and named
in the preview; only an incomplete folder traversal blocks the build. Each
included locale combines existing target values for current source keys with
saved overrides. It uses the same installation-folder mapping as package ZIPs.
Like package ZIPs, it includes token-valid Changed and Review values with
warnings without approving them. It reuses export validation, existing
destination/overwrite behavior and the result tray. No Nexus, community-library,
mod-manager or deployment state is required.

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
state write. Accepted values enter Review. Token differences never block an
import: the preflight lists each affected string with plain-language errors and
warnings and the imported text, and export leaves out strings with errors until
they are fixed or accepted.

## Command-Line Tool

`stardew-i18n-cli` exposes the same translation state to scripts and
automation: `list`, `pull`, `check`, `push`, `done`, `undo`, and `export`. It
uses the same portable data folder (`--data`, default `data/` beside the
program), Mods folder, and target language as the app, overridable with
`--mods` and `--lang`. It owns the portable data folder like the app does, so
it refuses to run while the app or another command uses that folder. Every
command prints one JSON document; exit code 0 is success, 1 failure, 2 invalid
usage, and 3 a completed command that rejected some strings (the valid ones
were saved). A pre-v1.1 profile's state still migrates into the settings
language, whatever `--lang` names.

`pull` writes a strings file (`stardew-translator-strings`, version 1) for one
mod with each string's file, key, English source, current target, status,
section, protected tokens, and matching glossary terms. It selects Open and
Changed strings by default. It changes no translation state and writes nothing
to the Mods folder.

`push` reads that file and saves non-empty targets as Done (`translated`) or,
with `--status review-needed`, as Review. Empty and whitespace-only targets
are skipped; a single space is the deliberate blank, as in the app. A Changed
string sent back with its old text stays Changed. Per string, it rejects an
unknown key, a source that changed since the pull, and a game-breaking token
error, unless that exact mismatch was accepted in the app; every other string
is saved. Token warnings and glossary terms missing from the target are
reported but never block. `check` runs the same validation without saving.
`done` marks Review or Changed strings with a translation as Done, by key or
all Review strings, with the same token rule.

Each `push` and `done` keeps an undo record in
`language-state/<lang>/cli-history/` (the 20 latest). `undo` restores the
previous values of strings that are still exactly as that operation left them
and keeps later edits. `export` writes `i18n/<lang>.json` for one mod or all
mods through the app's export, with `--dry-run` for its preview. No other
command writes to the Mods folder.

## Optional Glossary and AI

The glossary supplies high-confidence names for items, tools, weapons, clothing
(including boots and hats), NPCs, places, festivals, farm buildings, farm
animals, monsters, movies, and seasons, not prose. Built-in languages read the
game's `Content/Strings/*.xnb` dictionaries and the string dictionaries
`Data/Boots`, `Data/hats`, `Data/Monsters`, and `Data/Festivals/FestivalDates`
directly; no unpacking tool is needed. Custom-language packs may supply local
`Strings` JSON or XNB files, paired with the English names from the same game
files. A glossary built by an older app version keeps working and is marked for
a rebuild when a rebuild is possible; a term category the app does not know does not disable the glossary.
Pack inspection is read-only and limited to language registration and string
assets. Missing glossary data never blocks the core workflow; glossaries are
stored per language and never bundled with the app.

AI integrations are direct: a localhost OpenAI-compatible endpoint or OpenAI's
Responses API through browser Sign in with ChatGPT. The native app owns OAuth,
model discovery, and requests; no CLI or external helper is required. There is
no provider registry, marketplace, custom cloud base URL, or API-key fallback.
Renewable cloud credentials stay in the native backend and are encrypted with
Windows DPAPI in the portable data folder. They never enter the WebView or logs.

Requests send selected source text, section context, and matching glossary
terms to the selected backend for exactly one target language. ChatGPT requests
also send string keys; Local AI requests do not. Nearby source
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
- `language-state/<lang>/`: translation progress, and command-line undo
  records in `cli-history/`;
- `logs/`: optional rotating local logs.

One running process owns a portable data folder. A second instance using that
folder stops before loading or changing profile state. Ownership is released
when the process exits, including crashes. Independent portable folders may
run together.

If settings and their backup cannot be read, show the error with a retry action;
do not treat that failure as first-run setup or reset the profile.

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

After setup, the app opens directly in the translation workspace with real scan
data. Missing data remains unavailable; production screens never substitute
demo data. The workspace combines
a resizable package/mod pane with one virtualized table for This mod and All
mods, supporting search, filters, selection, keyboard use, and batch actions.

Operations show compact notifications with actionable causes and progress.
Details expose the actual operation data and the five newest completed backend
operations in the session. **Latest result** reopens the newest result. AI progress
remains nonmodal, with batch events in the shared Activity log. The resizable,
copyable session log also records successful manual saves and explicit token
mismatch acceptances, coalesces consecutive manual saves by mod, and links
results to their exact details. Routine clipboard/selection successes are
toast-only. It retains up to 500 entries, protecting the latest 100 warnings
and errors from routine progress, and reports omissions. Earlier scan details
and expired Undo actions are not restored through log links. One reversible
batch edit has a memory-only undo snapshot until another
completed operation replaces it. A later successful edit to any touched
component permanently invalidates that snapshot, even if the value is changed
back. Undo must never overwrite newer edits.

The supported distribution is an unsigned Windows x64 portable ZIP using
Tauri 2, Rust, React, TypeScript, and Vite, with Microsoft Edge WebView2 at runtime.
There is no telemetry. Optional glossary, AI, and logging features must remain
independent of manual translation and export.
