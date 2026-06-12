# Stardew i18n Translator

A portable Windows desktop app for translating Stardew Valley and SMAPI mod
`i18n` files. Scan your Mods folder, review thousands of strings in a compact
editor, preserve Stardew-specific tokens, and export clean translation files.

![Stardew i18n Translator dashboard](docs/assets/screenshots/dashboard.png)

## Highlights

- Scans SMAPI mods recursively and groups multi-component mod packages.
- Imports `i18n/default.json` and existing target-language translations.
- Provides a fast table/editor workflow with search, status filters, bulk
  actions, review queues, section context, and automatic outdated detection.
- Protects Content Patcher, dialogue, mail, placeholder, quote, and separator
  tokens using exact occurrence counts.
- Exports clean UTF-8 JSON in source-key order with backups and atomic writes.
- Supports optional local AI through Ollama, LM Studio, or another
  OpenAI-compatible localhost endpoint.
- Supports file-based translation batches for ChatGPT, Claude, Gemini, and
  other file-capable LLMs.
- Keeps settings, glossary data, and translation work locally in the portable
  app folder.

![Translation workspace](docs/assets/screenshots/workspace.png)

## Download And Setup

1. Download the portable Windows ZIP from
   [GitHub Releases](https://github.com/Nana1873/stardew-i18n-translator/releases).
2. Extract the complete ZIP to a writable folder.
3. Run `stardew-i18n-translator.exe`.
4. Select your Stardew Valley folder, Mods folder, and target language.

The app creates a `Data/` folder beside the executable. Move or back up the
complete application folder to keep settings and translation work together.
Saved game and Mods paths are absolute and may need to be selected again on a
different computer.

The executable is currently unsigned, so Windows SmartScreen may show an
unknown-publisher warning.

## Translation Workflow

1. Scan the configured Mods folder.
2. Select a mod and filter or search its strings.
3. Edit manually, use optional local AI, or export an external LLM batch.
4. Review token and quality warnings.
5. Export the selected mod or all mods.

Any protected-token count mismatch blocks that mod's export before files or
backups are written. Untranslated entries remain valid and are omitted so SMAPI
can fall back to `default.json`.

## Glossary How-To

The optional glossary provides official Stardew Valley term suggestions in the
editor and AI prompts. It does not enforce literal word-for-word translations.

1. Download
   [StardewXnbHack](https://github.com/Pathoschild/StardewXnbHack).
2. Use it to unpack your own Stardew Valley `Content` folder.
3. Confirm that `Content (unpacked)/` exists inside the selected game folder.
4. Open **Settings > Glossary**.
5. Choose **Build glossary**.

The generated glossary is stored locally as `Data/glossary.json`. No game
content or generated glossary database is included in releases.

## Local AI

Local AI is optional. Start Ollama, LM Studio, or another OpenAI-compatible
server on your machine, then open **Settings > Local AI**, choose the endpoint,
test the connection, and select a model. AI results always enter the review
queue and are never treated as finished translations automatically.

## External LLM Batch

1. Select the missing strings for a mod.
2. Choose **Export LLM batch** from the context menu.
3. Upload the generated `*.llm-batch.json` to a file-capable LLM.
4. Ask it to follow the embedded `instructions` and return the result as a
   file.
5. Drop the returned JSON onto the app, or choose **Import batch...**, then
   review the imported suggestions.

The app supports this workflow without connecting to a cloud API or storing an
API key.

## Privacy

- Core scanning, editing, validation, glossary generation, and export are
  completely local.
- The app contains no analytics, telemetry, accounts, or cloud API keys.
- Local AI requests go only to the endpoint configured in Settings.
- External LLM batches leave the computer only when you manually upload them
  to a service of your choice. Review that provider's privacy policy first.
- Stardew Valley files, mods, generated glossaries, and user data are not
  committed to this repository or bundled with releases.

## Development

The project uses Tauri 2, Rust, React, TypeScript, Vite, and pnpm.

```powershell
corepack pnpm install
corepack pnpm test
corepack pnpm tauri dev
```

See the [project status](docs/development/project-status.md), [product
specification](SPEC.md), and [scope guardrails](SCOPE_GUARDRAILS.md) for
implementation details.

## License

Copyright (C) 2026 Nana.

This project is licensed under the
[GNU General Public License v3.0 or later](LICENSE).

Stardew Valley is a trademark of ConcernedApe. This community project is not
affiliated with or endorsed by ConcernedApe.
