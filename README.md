# Stardew i18n Translator

A portable Windows x64 app for translating Stardew Valley SMAPI `i18n` files in
a searchable editor instead of editing large JSON files by hand.

[Download the latest release](https://github.com/Nana1873/stardew-i18n-translator/releases/latest) ·
[Report a bug](https://github.com/Nana1873/stardew-i18n-translator/issues/new?template=bug_report.yml) ·
[Suggest a feature](https://github.com/Nana1873/stardew-i18n-translator/issues/new?template=feature_request.yml)

> [!IMPORTANT]
> This project was built with substantial help from AI coding agents. I guide the
> project direction, review and test the results, and decide what ships.

![Stardew i18n Translator dashboard](docs/assets/screenshots/dashboard.png)

## What It Does

- Scans a SMAPI Mods folder and finds standard `i18n` translation files.
- Groups multi-part mods and imports existing translations.
- Provides search, filters, progress tracking, bulk actions, and review queues.
- Warns about missing or changed Stardew, dialogue, mail, Content Patcher, and
  placeholder tokens before export.
- Supports manual translation, optional local AI, and external LLM batches.
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

## Translation Workflows

You can translate in three ways:

- **Manual:** edit strings directly in the string editor.
- **Local AI:** connect to a local OpenAI-compatible endpoint such as Ollama or
  LM Studio.
- **External LLM batch:** export a self-contained JSON batch, translate it with a
  file-capable LLM, and import the result.

AI suggestions always enter the review queue. They are never treated as finished
translations automatically.

When exporting, untranslated entries are omitted so SMAPI can fall back to the
English source. Blocking token mismatches are caught before files are written.

![Token validation catches a missing placeholder before export](docs/assets/screenshots/token-check.png)

## Exporting and Sharing

**Export... > Build Release ZIP** creates an installable translation archive for
the selected mod package. It preserves multi-component folder paths and includes
only generated target-language `i18n` files, not the original mod's DLLs, assets,
manifests, or backups.

**Translation Notes** creates short copy-ready publication text using the current
package, language, coverage, installation guidance, and review state.

Completed exports, imports, LLM batches, and release ZIPs remain available in the
result tray without blocking the translation workspace.

## Local Data and Privacy

The desktop app has no accounts, analytics, telemetry, cloud API keys, or Nexus
API access. Scanning, editing, validation, glossary generation, and export happen
locally.

Local AI requests go only to the local endpoint you configure. External LLM
batches leave your computer only when you upload them yourself.

Portable data is stored under:

- `data/settings.json`
- `data/language-state/<language>/`
- `data/glossary/`
- `data/logs/`

Diagnostic logging can be disabled in **Settings > About**.

## Help and Feedback

Use the short forms for a
[bug report](https://github.com/Nana1873/stardew-i18n-translator/issues/new?template=bug_report.yml)
or a
[feature request](https://github.com/Nana1873/stardew-i18n-translator/issues/new?template=feature_request.yml).
A rough report is fine.

For bugs, the app version, the affected mod, the on-screen error, and a few
reproduction steps are usually enough. Logs can be opened from the About page in
Settings. They may contain local paths, so remove private information before
attaching them.

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
