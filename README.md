# Stardew i18n Translator

A portable Windows app for translating **Stardew Valley** SMAPI mods by hand:
edit the English text and your language side by side, catch broken dialogue
tokens like `$1` or `{{PlayerName}}` as you type, and export translation files
or a ready-to-install ZIP. Free and open source.

Why I made this: I wanted a way to translate mods without having to worry about
mistyping or misreading a token somewhere. And for really big mods, say 3,000
strings, you can let AI do a first pass and then check everything yourself in
Review, so some of the work is taken off your hands.

[Download the latest release](https://github.com/Nana1873/stardew-i18n-translator/releases/latest) ·
[Nexus Mods](https://www.nexusmods.com/stardewvalley/mods/47653) ·
[User guide](docs/user-guide.md) ·
[Report a bug](https://github.com/Nana1873/stardew-i18n-translator/issues/new?template=bug_report.yml)

![String editor with English source, German translation, and protected-token hints](docs/assets/screenshots/editor.png)

_The current interface with synthetic example strings. Manual editing works
without an AI service._

## How it works

1. **Pick your folders and language once.** The app scans your mods and opens
   the translation workspace.
2. **Choose a mod and double-click a string.** Translate it, then use
   **Save & next** to keep going.
3. **Check the queues.** **Open**, **Changed**, **Review**, and **Issues** show
   what still needs you.
4. **Export.** Write translation files into your mods, or build a translation
   ZIP for Mod Organizer 2, Vortex, or sharing.

## Features

- All your mods in one workspace. Multi-part mods are grouped, existing
  translations are picked up, and every mod shows how much is done. Scanning
  only reads your files.
- Search across all mods by key, English text, or translation, together with
  the status filters Open, Changed, Review, and Done.
- After a mod update, the next complete scan reports English strings that were
  added, changed, or removed. Translated strings whose English text changed
  move to Changed.
- **Token-safe editing**: Stardew, SMAPI, Content Patcher, dialogue, mail,
  placeholder, and formatting tokens are listed for every string and checked as
  you type. Click a missing token to insert it. Harmless differences are only
  notes; a token error that would break the game keeps just that string out of
  the export, so it stays English until you fix it or accept that exact
  difference.
- **Issues view**: all token errors and warnings in the current mod scope in
  one list, explained in plain language.
- Glossary hints come from your local Stardew game strings or a supported
  community language pack, so item, place, and character names match the game.
  You don't need them to translate or export.
- Batch work: select rows with the checkboxes, Ctrl+click, or Shift+click, then
  mark them done, keep the original, clear them, or hand them to AI or an LLM
  batch. The last batch edit can be undone during the session.
- Keyboard shortcuts: Ctrl+F searches, Ctrl+Enter saves, and Ctrl+Shift+Enter
  saves and opens the next string. You can change them in
  **Settings > Shortcuts**.
- An activity log lists the scans, saves, imports, exports, and AI runs of the
  session, with details for each result.
- **Safe export**: existing target files receive a `.bak` backup, and an
  ordinary failure during a multi-file export rolls back the affected files.
- Translation ZIPs hold one mod or all scanned mods, with only the translation
  files inside. You can adjust the install folders in the preview to match the
  original mod.

The token checks follow the game itself: the rules were checked against
Stardew Valley's own dialogue and mail code, Content Patcher, and Mail
Framework Mod. A string is only held back when it would really break something
in the game.

Saving keeps your work in the app. Your mods change only when you export.
Export can include text still in Review or Changed after a warning, so check
those queues before sharing a translation.

## Get started

1. Download the Windows portable ZIP from
   [GitHub Releases](https://github.com/Nana1873/stardew-i18n-translator/releases/latest)
   or [Nexus Mods](https://www.nexusmods.com/stardewvalley/mods/47653).
2. Extract the **entire ZIP** to a writable folder and run
   `stardew-i18n-translator.exe`. There is no installer.
3. Select your Stardew Valley folder, Mods folder, and target language. Let the
   app scan your mods.
4. Choose a mod in the workspace and double-click a string to edit it.
5. Check **Review**, **Changed**, and **Issues**, then choose **Files… >
   Export…** to write JSON files into your Mods folder or save a translation
   ZIP.

**Requirements:** 64-bit Windows and the
[Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/).
If WebView2 is missing, the app offers to open Microsoft's download page;
nothing is installed automatically. The executable is unsigned, so Windows may
show a SmartScreen warning.

**Updating:** the app creates `data/` beside the executable. It holds your
settings, translation work, and glossary. **Keep this folder when updating or
moving the app.** See [updates and backups](docs/troubleshooting.md#updating-and-moving-the-app).

## Optional AI

AI is optional and stays off until you set it up: a local model (LM Studio or
Ollama), your ChatGPT plan, or an LLM batch file you hand to any other tool.
Every AI result lands in **Review** and is never marked Done on its own. Export
still includes Review text, so look it over first. The [AI guide](docs/ai.md)
covers setup, quality options, and exactly what is sent.

## Languages and files

- **Built-in game languages:** German, Spanish, French, Hungarian, Italian,
  Japanese, Korean, Portuguese, Russian, Turkish, and Chinese.
- **Custom languages:** Vietnamese, Indonesian, Ukrainian, Polish, Finnish,
  Dutch, Czech, and Thai. The game needs a matching language mod to use them.
- **Supported files:** standard SMAPI i18n files, either flat
  `i18n/default.json` and `i18n/<language>.json` files, or split
  `i18n/default/*.json` and `i18n/<language>/*.json` folders.
- **Out of scope:** the app does not translate arbitrary `content.json` or XNB
  assets, manage mods, or download updates.

## Privacy

Scanning, manual editing, glossary generation, validation, and export happen
locally. The app has no accounts, analytics, or telemetry.

The optional AI features only send the strings you select (with a little
context) to the service you chose; the [AI guide](docs/ai.md#data-and-privacy) has the
details.

## Help and contribute

- [User guide](docs/user-guide.md): editing, status, glossary, export, and sharing.
- [Troubleshooting](docs/troubleshooting.md): setup problems, backups, and recovery.
- [Contributing](CONTRIBUTING.md): build the app, test changes, and submit a PR.
- [Changelog](CHANGELOG.md): release history.

[Bug reports](https://github.com/Nana1873/stardew-i18n-translator/issues/new?template=bug_report.yml)
and [feature ideas](https://github.com/Nana1873/stardew-i18n-translator/issues/new?template=feature_request.yml)
are welcome; a short description is enough.

Built with substantial help from AI coding agents. I use the app for my own
German translations, decide what gets built and what ships, and spot-check each
release on real mods on top of the automated tests.

## License

Copyright (C) 2026 Nana. Licensed under the
[GNU General Public License v3.0 or later](LICENSE).
