# User guide

[Download and first launch](../README.md#get-started) · [AI guide](ai.md) ·
[Troubleshooting](troubleshooting.md)

## Scan and choose a mod

Choose the game folder, Mods folder, and target language during setup. You can
change them later in **Settings**. Translation work is stored separately for
each language. Custom-language targets also need a matching language mod for
in-game use; selecting a language here does not install one.

The scan reads standard `i18n/default.json` sources and existing target-language
files. Multi-part packages are grouped in the mod list. Mods that do not use
standard SMAPI i18n files cannot be translated here.

**Overview** shows scan totals and recently opened mods. Open **Workspace** and
select a mod or component to work on its strings. Use **Scan** after installing
or updating mods. After two complete scans, the app can report English strings
that were added, changed, or removed. A scan with an attention-requiring skipped
component keeps the last complete baseline; comparison counts are unavailable
until a complete scan succeeds. Expected community-language-pack exclusions
do not make a scan incomplete.

## Find translations on Nexus

This workflow is currently for local testing. Nexus is optional: configure an
API key in Setup or Settings. Choose **Manual / no mod manager** or **Vortex**
in the installation section of Setup; this remains editable in Settings.
Select Vortex.exe there when using Vortex. The validated key is
saved as `NEXUS_API_KEY` in your Windows user environment, outside portable
`data/`; it does not move with the app. Opening Setup only checks local key
readiness. **Test existing key** and **Validate and save key** contact Nexus.

Use **Find translations on Nexus Mods**, or enable discovery after scans. Searches use Nexus
update IDs and the selected language, never your local translation text. Shared
IDs are searched once. Groups with complete language-file coverage on disk are
skipped by default. Review drafts alone do not count as installed coverage.
Coverage is not a quality or compatibility guarantee.

The list shows available likely translations for the scanned mods. All shown
downloads are included automatically: there are no mod-selection checkboxes.
File metadata loads before the download action. When more than one current
version or variant is available, choose it directly in the row's dropdown.
Single-file results need no choice. The file IDs shown by this list are the
ones used by the batch action; nothing downloads merely by opening the list.
The newest suitable file is a selection hint, not proof that it matches your
installed mod. Search metadata is cached locally for 24 hours.
**Refresh search**, under **Options & search details**, requests fresh results.
Cancellation and API failures preserve your local workspace; bounded searches
may miss translations.

One download button processes the list using the installation method saved in
Setup/Settings. There is no Vortex/Review switch in the results dialog. Manual
mode imports into the translator's Review; Vortex mode requests download and
installation through Vortex. The app passes the chosen numeric
Nexus mod/file references to the configured Vortex executable without passing
its API key. Vortex uses its own account and handles download requirements,
installation, conflicts, and deployment. A successful handoff means only that
the launch request succeeded, not that a file was downloaded or installed.
Stopping a batch prevents subsequent handoffs; it does not undo requests already
sent to Vortex.

After installing and deploying in Vortex, use **Check installed files**. This
local rescan reads actual target-language files separately from saved app work.
It reports disk coverage and differences from saved translations while retaining
your drafts. Inspect differences before replacing or exporting text; a recheck
does not automatically adopt conflicting disk values. Neither handoff nor disk
coverage verifies Nexus source association or membership in a Collection. Check
those in Vortex; practical Vortex acceptance remains a user-led test.

### Personal import into Review

With the **Manual / no mod manager** installation method, the download action
imports eligible translations into Review. Rows are processed one at a time;
stopping keeps completed imports and prevents further rows from starting.
This action downloads
a selected ZIP through the official Nexus API and requires Nexus Premium.
Unambiguous language files are checked and imported; ambiguous files or component
mappings require a choice. A translated `default.json` requires confirmation
that it contains the target language. Nonempty local text is preserved, token
errors are skipped, and eligible values enter Review. The archive stays in
memory and no mod assets are installed. **Open Review** lets you inspect the
result; explicit **Export…** is the separate action that writes language files.

### Sharing and public distribution

API access does not grant permission to republish downloaded translations.
The existing translation ZIP can include imported or pre-existing text; verify
its permissions before sharing. A combined private output-folder feature is not
implemented. Collections reference original mods; they do not grant rights to
rebundle their files. See the [Collections guidelines](https://help.nexusmods.com/article/115-guidelines-for-collections).

Personal API keys are for private/testing use. Public distribution requires
Nexus application registration and an appropriate application-key flow; SSO is
optional and is not implemented here. Hosting this network-enabled utility on
Nexus also requires discussing its network functionality with staff. No Nexus
approval is claimed. See the [API acceptable-use policy](https://help.nexusmods.com/article/114-api-acceptable-use-policy)
and [File Submission Guidelines](https://help.nexusmods.com/article/28-file-submission-guidelines).

Releases and prereleases of this integration are on hold until Nexus Mods
approves it after reviewing the local test build. Test builds remain local
during this stage; the milestone does not authorize publication.

## Edit and save

Double-click a string, or select it and press Enter. The English source stays
read-only; enter your translation on the other side. Section headings, protected
tokens, and matching glossary terms help retain the meaning and formatting.

- **Save** accepts the current translation and closes the editor.
- **Save & next** accepts it and opens the next string.
- **Keep original** copies the English source as an intentional translation.
- **Clear** empties the field; save it to return the string to Open.

For Review entries, the save actions are called **Approve suggestion** and
**Approve & next**. Changed entries use **Keep translation** or **Save update**
depending on whether you edited the text.

Saving stores work in the app's portable `data/` folder. It does not change the
mod's translation files until you export.

![Editor showing a synthetic translation and its protected tokens](assets/screenshots/editor.png)

The example uses synthetic text. Preserve placeholders such as `{{PlayerName}}`
and dialogue commands when translating the surrounding words.

## Understand status and validation

| Workspace filter | Meaning                                                                                                                                |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Open**         | No nonempty translation is available.                                                                                                  |
| **Changed**      | The English source changed since the saved translation.                                                                                |
| **Review**       | An AI suggestion, external LLM result, or Nexus import has not been accepted.                                                          |
| **Done**         | A translation was saved/accepted for this source, or a nonempty existing translation file was loaded without an overriding saved edit. |

Existing `<language>.json` files are taken as translated when scanned; this is
different from importing an external LLM batch, which creates Review entries.
Done does not guarantee that the wording is correct or that validation passes.

**Validation issues** is an independent filter. Missing or changed protected
tokens and invalid text can block export. Suspicious literal escape changes
can produce warnings without blocking. Open an affected string to inspect the
source and target. If a token difference is intentional, **Save anyway** accepts
that exact source/target mismatch; editing it again can require a new decision.

## Search, select, and work in batches

Use **This mod** or **All mods** to set your search scope. Search matches keys,
English source text, and translations. Combine it with status and validation
filters to find the work you need. Sorting, filters, pane width, and resizable
column widths are remembered across sessions.

Select rows with checkboxes, Ctrl+click, Shift+click, or Ctrl+A in the string
table. The batch toolbar and right-click menu offer copy, mark Done, keep
original, clear translation, and AI/batch actions. Mark Done only after checking
the selected translations. Empty rows cannot be marked Done.

One completed batch edit can be undone while its snapshot is still current.
A newer completed operation replaces that snapshot. Undo refuses to overwrite
strings edited since the batch, even if they were changed back afterward.
History and undo are available only for the current app session.

Useful defaults are Ctrl+F for search, Ctrl+Enter for Save, Ctrl+Shift+Enter for
Save & next, and Alt+Left/Right for editor navigation. Navigation saves dirty
edits when possible; resolve any validation confirmation before continuing.
See **Settings > Shortcuts** for all bindings and customization.

## Build a glossary

Open **Settings > Glossary** and choose **Build glossary** when sources are
available, or **Rebuild glossary** when the cache needs refreshing.

Built-in languages use local Stardew `Content/Strings` XNB files, with unpacked
Strings JSON as a fallback. Supported community language packs can supply local
Strings dictionaries for custom targets. Missing sources simply leave the
glossary unavailable; editing and export still work.

The glossary supplies hints for recognized names and terms. It does not
translate game assets, replace your chosen language pack, or guarantee that an
AI model will use the right wording. Matching terms also accompany AI requests;
see [data sent to AI](ai.md#data-and-privacy).

## Export translation files

Choose **Export…** for the current mod or all scanned mods. The confirmation
shows the scope, replacement information, and strings needing attention.

**Nonempty Review and Changed translations are included in export after a
warning.** They do not become Done as a result. Empty entries are omitted so
SMAPI can fall back to English. Unresolved blocking validation issues must be
fixed or an intentional token mismatch explicitly accepted before export.

Export writes `i18n/<language>.json` files inside the selected mods. Existing
targets receive a `.bak` backup, for example `de.json.bak`. Export replaces these
targets rather than appending to them: target-only keys without an English
source are omitted. A file with no nonempty translations is removed after
backup. Ordinary failures partway through a multi-file export roll back the
affected targets and backups. See [backup recovery](troubleshooting.md#recovering-a-backup)
if you need to restore an earlier file.

Portuguese export uses `pt.json`; an existing `pt-BR.json` is accepted on import
and backed up when normalized during export.

## Share a translation

Select a mod package and use **Export… > Build translation ZIP**. Check its
preview and choose a destination. The ZIP preserves component folder paths and
contains only generated target-language i18n files. Recipients still need the
original mod; the ZIP does not include its assets, DLLs, or manifest.

Use **Translation notes** for copy-ready package, language, coverage, review,
and installation information. Check that text before publishing it alongside
the ZIP. Uploading and publication happen outside the desktop app.

## Find operation results

The result tray shows output paths, file names, summaries, and warnings.
**Latest result** reopens the most recent operation and **Copy details** copies
its available information. The five latest completed operations remain
accessible for the current session. This history is separate from saved
translations, which remain in `data/` after closing the app.
