# Stardew i18n Translator

A portable Windows x64 app for translating Stardew Valley SMAPI mods. Find the
strings you need, edit translations side by side, and check protected tokens
without working through large JSON files by hand.

[Download the latest release](https://github.com/Nana1873/stardew-i18n-translator/releases/latest) ·
[User guide](docs/user-guide.md) ·
[Report a bug](https://github.com/Nana1873/stardew-i18n-translator/issues/new?template=bug_report.yml)

![String editor with English source, German translation, and protected-token hints](docs/assets/screenshots/editor.png)

_The current interface with synthetic example strings. Manual editing works
without an AI service._

## What you can do

- Scan your Mods folder, group multi-part mods, and use existing translations.
- In local test builds, find Nexus translations and send them to Review or Vortex.
- Search across mods, filter unfinished work, and spot changed English strings.
- Translate manually or use optional Local AI, Codex CLI, or external LLM batches.
- Review suggestions with protected-token checks and optional glossary hints.
- Export translation files or a translation ZIP to share with other players.

The app works with standard `i18n/default.json` and `i18n/<language>.json`
files. It does not translate arbitrary `content.json` or XNB assets, manage
mods, or download updates. Custom-language targets need a matching language mod
installed before the game can use them.

## Get started

1. Download the Windows portable ZIP from
   [GitHub Releases](https://github.com/Nana1873/stardew-i18n-translator/releases/latest).
2. Extract the entire ZIP to a writable folder and run
   `stardew-i18n-translator.exe`. There is no installer.
3. Select your Stardew Valley folder, Mods folder, and target language. Let the
   app scan your mods.
4. Open **Workspace**, choose a mod, and double-click a string to edit it.
   Save your translation or use **Save & next** to keep working.
5. Check **Review**, **Changed**, and **Validation issues**, then choose an action
   from **Export…** to write the translation files.

Saving keeps your work in the app. Export is the separate step that writes into
the selected mods' `i18n` folders. Export can include text still in Review or
Changed after a warning, so check those queues before sharing a translation.

The app creates `data/` beside the executable. **Keep this folder when updating
or moving the app**: it contains your settings and translation work. See
[updates and backups](docs/troubleshooting.md#updating-and-moving-the-app).

Windows may show a SmartScreen warning because the executable is unsigned.
[Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)
is required. If it is missing, the app offers to open Microsoft's download
page. Nothing is installed automatically.

## Optional online features and privacy

Scanning, manual editing, glossary generation, validation, and export happen
locally. The app has no accounts, analytics, or telemetry.

The Nexus workflow is currently for local testing. It finds likely translations,
offers Review import or handoff to your configured Vortex, and checks language
files after you deploy them. Vortex uses its own account; a handoff does not
confirm installation or Collection membership. Personal ZIP import into
**Review** is the default without Vortex and requires Nexus Premium for downloads. The Nexus
API key stays in your Windows user environment. See
[Nexus translations](docs/user-guide.md#find-translations-on-nexus) for limits
and the public-distribution boundary.
Local AI sends translation text and context to your configured loopback service.
Codex CLI sends them through its configured service using the CLI's own login;
the app never reads or copies its authentication files. External batches leave
your computer only when you upload them yourself. AI results enter **Review**
and are never automatically marked Done.

See the [AI guide](docs/ai.md) for setup, quality options, and exactly what is sent.

## Help and contribute

- [User guide](docs/user-guide.md): editing, status, glossary, export, and sharing.
- [Troubleshooting](docs/troubleshooting.md): setup problems, backups, and recovery.
- [Contributing](CONTRIBUTING.md): build the app, test changes, and submit a PR.
- [Changelog](CHANGELOG.md): release history.

[Bug reports](https://github.com/Nana1873/stardew-i18n-translator/issues/new?template=bug_report.yml)
and [feature ideas](https://github.com/Nana1873/stardew-i18n-translator/issues/new?template=feature_request.yml)
are welcome; a short description is enough.

This project was built with substantial help from AI coding agents. I guide the
project, review and test the results, and decide what ships.

## License

Copyright (C) 2026 Nana. Licensed under the
[GNU General Public License v3.0 or later](LICENSE).
