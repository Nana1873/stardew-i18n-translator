# Stardew i18n Translator

A portable Windows x64 app for translating Stardew Valley SMAPI `i18n` files in
a searchable editor instead of editing large JSON files by hand.

[Download the latest release](https://github.com/Nana1873/stardew-i18n-translator/releases/latest) ·
[Report a bug](https://github.com/Nana1873/stardew-i18n-translator/issues/new?template=bug_report.yml) ·
[Suggest a feature](https://github.com/Nana1873/stardew-i18n-translator/issues/new?template=feature_request.yml)

> [!IMPORTANT]
> This project was built with substantial help from AI coding agents. I guide the
> project direction, review and test the results, and decide what ships.

![Stardew i18n Translator Overview](docs/assets/screenshots/dashboard.png)

## What It Does

- Scans a SMAPI Mods folder and finds standard `i18n` translation files.
- Shows English strings changed, added, and removed since the previous complete
  scan.
- Groups multi-part mods and imports existing translations.
- Opens on a real-data Overview and keeps detailed translation work in a
  two-panel Workspace.
- Provides search, filters, progress tracking, multi-select, bulk actions,
  resizable columns, and review queues.
- Warns about missing or changed Stardew, dialogue, mail, Content Patcher, and
  placeholder tokens before export.
- Supports manual translation, optional local AI, Codex CLI, and external LLM
  batches.
- Supports Stardew's built-in languages and curated custom-language targets.
- Builds optional glossary hints from local Stardew strings or an installed
  community language pack.
- Exports clean translation files, installable translation ZIPs, and short
  publication notes.

![Translation workspace](docs/assets/screenshots/workspace.png)

## Quick Start

1. Download the latest portable ZIP from
   [GitHub Releases](https://github.com/Nana1873/stardew-i18n-translator/releases/latest).
2. Extract it to a writable folder. There is no installer.
3. Run `stardew-i18n-translator.exe`.
4. Select your Stardew Valley folder, Mods folder, and target language.

The app creates a `data/` folder beside the executable. Keep this folder when
updating or moving the app so your settings and translation work come with you.

Custom-language targets can be translated and exported, but Stardew can only use
them in-game when a matching custom-language mod is installed.

Windows may show a SmartScreen warning because the executable is not signed. The
app also requires
[Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/),
which is already included with Windows 11 and most Windows 10 installations.

## Supported Scope

The app is intentionally focused on the normal SMAPI translation workflow:

- Source files: `<mod>/i18n/default.json`
- Translation files: `<mod>/i18n/<language>.json`
- Existing translations, relaxed JSON used by real mods, multi-part packages,
  protected tokens, and per-language working state
- Optional read-only glossary sources from Stardew `Content/Strings/*.xnb`, an
  unpacked `Strings` folder, or compatible community language packs

It is **not** a mod manager or a general Stardew file editor. It does not
translate arbitrary `content.json`, game data files, dialogue databases, or XNB
assets, and it does not download or update mods.

Detected community language packs are reported as expected exclusions rather
than skipped translation targets. A target-language entry without a matching
English source is informational: SMAPI ignores it, it does not count toward
progress or block export, and the next export omits it from the rewritten file
while retaining the previous target file in its backup.

If a scan skips a component that needs attention, source-change counts are
unavailable and the last complete comparison baseline is preserved. Expected
community-language-pack exclusions do not make a scan incomplete.

## Overview and Workspace

The app opens on **Overview**. It summarizes the latest real scan, lets you
resume recently opened mods, links into useful all-mod filters, and shows the
latest successful export path from the current app session. Current string
status totals come from the scan, and each mod's last-opened time is kept in
portable settings across sessions. Values that genuinely do not exist, such as
a current-session export before the first export, are not invented.

**Workspace** places the scanned mod and component list on the left and the
virtualized string table beside it. You can work on one mod or search across all
mods, then filter by **Open**, **Changed**, **Review**, or **Done**:

- **Open:** no accepted target-language text exists.
- **Changed:** the English source changed after the translation was saved.
- **Review:** imported or AI-generated text still needs human approval.
- **Done:** the translation was explicitly saved or accepted for the current
  English source.

**Validation issues** is a separate content-check filter, not another status or
a combined review queue. It includes blocking protected-token or text
serialization errors as well as non-blocking warnings such as changed line
breaks or literal escape sequences.

The mod-list divider and the sortable **Mod**, **File**, **Status**, **Key**,
**English Source**, and **Target Translation** columns can be resized. Search,
scope, filters, sort order, pane width, and column widths are saved with the
portable workspace settings.

## Translation Workflows

You can translate in four ways:

- **Manual:** edit strings directly in the string editor.
- **Local AI:** connect to a local OpenAI-compatible endpoint such as Ollama or
  LM Studio.
- **Codex CLI:** use an installed Codex CLI through its own existing login. The
  app never reads Codex authentication files or tokens. Settings lists the
  models reported by the installed CLI and stores only the selected model id;
  if that list is unavailable, translation remains available with the CLI's
  own default model.
- **External LLM batch:** export a self-contained JSON batch, translate it with a
  file-capable LLM, and import the result. Format 2 uses one compact source
  snapshot to ensure the result still belongs to the selected mod, language,
  files, keys, and current English text before anything is saved.

Settings keeps the saved default engine when Local AI is configured or Codex CLI
is ready; otherwise it selects a configured or ready engine. Local AI is shown
as **Configured** after a Base URL and model are saved, and as **Ready** only
after a successful connection test in the current Settings session. Codex CLI
is ready only when it is installed and authenticated. Local AI models come from
the configured local service and its Base URL can be reset to the selected
provider's default. Codex CLI models come from the installed CLI; a valid saved
choice is retained, otherwise the CLI-reported default is selected. If model
discovery is unavailable, runs still use the CLI's own default model. The app
also configures the reasoning effort for Codex translation runs.

For Local AI, start LM Studio or Ollama with a model loaded, open
**Settings > Translation engines**, choose the matching provider, and use its
default loopback URL or reset the URL to that default. Select the detected model,
test the connection, then save the settings.

Hybrid Qwen3 models in LM Studio automatically use their non-thinking response
mode so the translation is returned as ordinary response text instead of being
consumed by the model's reasoning pass. Qwen3 Instruct models already use the
plain response path; thinking-only variants are rejected with setup guidance.

For ChatGPT-backed Codex sign-in, Settings also shows the remaining percentage
and local reset time for each usage window reported by the installed CLI. The
existing **Check status** action refreshes those values. Codex CLI versions that
otherwise support translation but do not expose rate-limit data, and API-key
billing, remain usable and show that ChatGPT limits were not reported. The app
never estimates a quota or reads account or authentication files.

If Codex CLI is unavailable, **Settings > Translation engines > Codex CLI**
shows a short setup guide. It links to the
[official Codex CLI instructions](https://learn.chatgpt.com/docs/codex/cli),
then asks you to run `codex` in PowerShell and check the status again. Choose
**Sign in with ChatGPT** for subscription access; Codex CLI also supports API-key
sign-in for separately billed usage-based access. Availability and usage limits
depend on the current ChatGPT plan. See the
[official authentication guide](https://learn.chatgpt.com/docs/auth) and
[current pricing page](https://learn.chatgpt.com/docs/pricing) for the latest
availability and billing details.

Use row checkboxes, Ctrl+click, Shift+click, or Ctrl+A to select the current
filtered result. Batch actions can copy text, mark strings as Done, keep the
English source, clear translations, start AI translation, or export an external
LLM batch; the same actions are available from the right-click menu. The default
AI engine is selected in Settings. **Translate selected with AI** immediately
includes every selected **Open** or **Changed** string and sends no Done or
Review text. Source values that the live backend cannot accept (empty, NUL, or
larger than 64 KiB as UTF-8) remain selected but are clearly excluded from the
AI-ready count. External LLM export keeps its existing file workflow and may
still include those selected values. An external batch may contain many selected
Open or Changed strings but is bound to exactly one mod.

Each live AI run uses the currently selected target language; built-in and
curated custom-language targets follow the same workflow. To preserve local
context, the request includes up to two preceding and two following English
source strings from the same component, relative i18n file, and section. These
neighbors are read-only context: only exact selected Open or Changed IDs may be
returned and saved.

External batch import uses a native file picker or drag and drop. Before the
Import button is enabled, a read-only preflight checks the mod, target language,
source snapshot, files, keys, protected tokens, empty results, and existing
local translations. A batch for another currently scanned mod can switch the
Workspace to that mod for a fresh preflight. Valid values enter Review, while
non-empty local translations remain untouched.

Manual translation and local-only workflows remain offline. Live AI requests
send the selected English source text, its section context, matching glossary
terms, and the bounded neighboring context described above to the selected
backend.

Local AI processes selected strings one at a time. An invalid response or other
item-specific failure is reported without preventing later selected strings
from being attempted, and each successful suggestion is saved immediately in
Review. A connection, HTTP-status, or local client-setup failure stops the
remaining work, as do cancellation and stale-source or save failures.
Suggestions already saved in Review are retained. If an error occurs after at
least one save, the result is shown as completed with issues; a run with no
saved suggestions is shown as failed.

Large Codex CLI selections are divided into adaptive batches of at most 100
selected strings, with every complete serialized prompt bounded to 96 KiB; one
live run accepts up to 4,096 strings or 8 MiB of selected source text. Recovery
is limited to the affected batch: each CLI attempt may run for up to five
minutes, a transient failure is retried once, and a persistently invalid
response is split until a failing string is isolated so unrelated work can
continue. Repeated neighboring context is pooled inside each prompt without
losing retained context. If one complete item prompt is still oversized, only
its farthest neighboring context is trimmed first; the selected source is never
trimmed.

Codex translation uses a staged quality pass by default. Codex first creates an
initial draft, then every draft receives a full AI review that corrects issues in
meaning, natural phrasing in the target language, terminology, grammar,
register, speaker voice, and dialogue continuity. This review is not limited to
token warnings or glossary matches. The review still inspects every draft but
returns only changed translations; omitted IDs retain their existing draft,
which avoids writing every unchanged translation a second time. Only after that
full review, reviewed results with a conservatively detected glossary or
terminology candidate receive exactly one focused repair pass; correct
inflections and compounds may remain unchanged. A failed full review does not
mark its chunk complete, so it can be retried. If the optional focused repair
fails, the fully reviewed text is kept.

**Settings > Translation engines > Codex CLI** can disable these additional AI
review and repair calls for a faster, lower-token first-draft workflow. The app
shows a quality warning while this option is off: wording, terminology,
grammar, register, speaker voice, dialogue continuity, and protected tokens may
need more manual correction. Validation still runs and every draft still enters
Review.

With the quality option enabled, a protected-token mismatch after the
language-quality stages gets one targeted repair attempt and stays a blocking
Review issue if it still differs. An individually oversized repair input is
kept for Review without another provider call.

AI suggestions always enter the existing human Review queue. Suggestions from
completed adaptive chunks are saved immediately as validation reaches them.
Cancelling or a later error keeps already persisted suggestions in Review, and
any selected items still in Open or Changed are naturally available for a later
retry. Even a draft that passed AI review and terminology repair remains
`review-needed`; suggestions are never treated as finished translations
automatically.

The compact progress dialog reports suggestions already saved to Review, the
current quality phase and adaptive batch, elapsed time, bounded retries or
splits, and token usage when Codex CLI reports it while retaining its Cancel
action. Safe CLI activity events such as starting, reasoning, and response
completion appear as they arrive, together with the age of the latest event.
After the first suggestions have actually been saved, an estimated remaining
time is calculated from saved-string checkpoints and updated only when more
work reaches Review. Codex does not provide token-by-token heartbeats, so the
app does not invent progress inside a provider call. A later run
naturally leaves only the remaining Open or Changed strings to process; there
is no separate persistent AI job queue or checkpoint history. **Open review
queue** returns to the affected component when it is known and to **All mods**
for a multi-component run, so cross-mod results are not hidden.

When exporting, untranslated entries are omitted so SMAPI can fall back to the
English source. Blocking token mismatches are caught before files are written;
an intentional per-string mismatch can be explicitly accepted with **Save
anyway** during review. The direct-export confirmation uses a read-only backend
preflight over the exact selected scope, so a real blocking key can be opened
before confirmation. Export repeats the same validation before writing, so the
preview never acts as an authorization token.

![A protected-token mismatch requires explicit Save anyway confirmation](docs/assets/screenshots/token-check.png)

## Exporting and Sharing

The **Export...** menu can export the current mod, export all scanned mods,
build a translation ZIP, or prepare translation notes. Direct exports validate
the complete selected scope before the first write, create visible backups for
existing target files, and roll back an incomplete multi-file write.

**Export … > Build translation ZIP** creates an installable translation archive
for the selected mod package. It preserves multi-component folder paths and
includes only generated target-language `i18n` files, not the original mod's
DLLs, assets, manifests, or backups.

**Translation notes** creates short copy-ready publication text using the current
package, language, coverage, installation guidance, and review state.

The result tray shows real output paths and file names returned by export,
import, external LLM batch, and ZIP operations. It can be collapsed or closed;
**Latest result** always reopens the newest operation result, even after an older
history entry was viewed, and **Copy details** copies the available summary,
paths, warnings, and workflow information.

The five latest completed backend operations, including exports, imports, LLM
batches, AI runs, release ZIPs, and batch edits, remain available in the result
tray for the current app session. One reversible batch edit can be undone until
a newer completed operation replaces its undo snapshot. Undo also refuses to
overwrite a touched string that was edited afterward, even if it was later
changed back to the batch value.

## Local Data and Privacy

The desktop app has no accounts, analytics, telemetry, or Nexus API access.
Scanning, editing, validation, glossary generation, and export happen locally.

Local AI requests go only to the local endpoint you configure. External LLM
batches leave your computer only when you upload them yourself.

Codex CLI authentication remains entirely owned by the CLI; the app does not
read or copy its authentication files or tokens. Its optional usage display is
limited to sanitized rate-limit percentages, window lengths, and reset times
reported by the CLI. The app does not offer a provider marketplace or a custom
cloud base URL. Codex CLI translation sends the selected English source,
matching glossary terms, and the bounded read-only context described below
through the CLI to its configured service.

Live AI may send up to two preceding and two following neighboring English source
strings from the same component, i18n file, section, and related key group as
read-only context. Context-only strings cannot be returned as translations or
saved by the run.

Portable data is stored under:

- `data/settings.json`
- `data/scan-source-snapshot.json`
- `data/language-state/<language>/`
- `data/glossary/`
- `data/logs/`

Diagnostic logging can be disabled in **Settings > About**.
AI diagnostics record only run, batch, phase, duration, retry/split, cancellation,
fixed outcome categories, and reported token totals. Prompts, source and target
text, glossary/context content, mod/string/file identities, CLI output, auth
data, and temporary paths are never written to the AI diagnostic events.

## Help and Feedback

Use the short forms for a
[bug report](https://github.com/Nana1873/stardew-i18n-translator/issues/new?template=bug_report.yml)
or a
[feature request](https://github.com/Nana1873/stardew-i18n-translator/issues/new?template=feature_request.yml).
A rough report is fine.

For bugs, the app version, the affected mod, the on-screen error, and a few
reproduction steps are usually enough. Logs can be opened from the About page in
Settings. General scanner and file-operation entries may contain local paths,
so remove private information before attaching them; the AI diagnostic events
described above intentionally exclude them.

Release history is in the [changelog](CHANGELOG.md).

## Development

The app uses Tauri 2, Rust, React, TypeScript, and Vite.

```powershell
corepack pnpm install
corepack pnpm test
corepack pnpm tauri dev
```

Keep changes focused and verify the area you changed. Repository guidance is in
[AGENTS.md](AGENTS.md), the current product contract is in [SPEC.md](SPEC.md), and
release instructions are in
[docs/release/release-process.md](docs/release/release-process.md).

## License

Copyright (C) 2026 Nana.

Licensed under the [GNU General Public License v3.0 or later](LICENSE).
