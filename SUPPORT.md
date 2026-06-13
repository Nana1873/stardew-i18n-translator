# Support

This is a free, community, hobby project maintained in spare time. There is no
SLA — but well-described reports get looked at.

## Getting help

1. **Read the [README](README.md)** — it covers download, setup, the
   translation workflow, glossary, local AI, external LLM batches, and privacy.
2. **Search [existing issues](https://github.com/Nana1873/stardew-i18n-translator/issues)**
   before opening a new one.
3. **Found a bug?** Open a
   [Bug report](https://github.com/Nana1873/stardew-i18n-translator/issues/new?template=bug_report.yml).
4. **Have an idea?** Open a
   [Feature request](https://github.com/Nana1873/stardew-i18n-translator/issues/new?template=feature_request.yml)
   — but check [SCOPE_GUARDRAILS.md](SCOPE_GUARDRAILS.md) first; the scope is
   intentionally narrow.
5. **Security issue?** Do **not** open a public issue. Follow
   [SECURITY.md](SECURITY.md).

## What to include

- App version (**Settings → About**).
- Your Windows version.
- The exact error message shown in the app, if any.
- Step-by-step reproduction.
- **A log file.** The app writes a local log next to the executable. Open
  **Settings → About → Open logs folder**, take the newest
  `stardew-i18n-translator*.log`, remove anything private, and attach it. Logs
  stay on your computer and are never sent anywhere automatically.

The bug report form asks for all of this.

## Common things to check first

- **"Unknown publisher" / SmartScreen warning** — expected; the executable is
  unsigned. Choose _More info → Run anyway_.
- **The app won't save / start** — it needs a **writable** folder. Don't run it
  from inside a ZIP or a read-only/Program Files location; extract the full ZIP
  somewhere like your user folder.
- **Local AI can't connect** — start your server (Ollama / LM Studio) first,
  then test the connection in **Settings → Local AI**.
- **Glossary options are greyed out** — the glossary is optional and needs an
  unpacked `Content` folder; see the README "Glossary How-To".

## Scope reminder

This tool edits SMAPI `i18n/default.json` and `i18n/<lang>.json` files. It does
**not** manage, enable, download, or update mods, and it does **not** use cloud
AI or store API keys.
