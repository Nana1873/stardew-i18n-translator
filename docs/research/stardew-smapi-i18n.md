# SMAPI i18n Research

> **Related:** [SPEC.md §6 — Mod Scan](../../SPEC.md), [SPEC.md §10 — Validation Rules](../../SPEC.md), [SPEC.md §20 — Confirmed Facts](../../SPEC.md)

## Confirmed (see SPEC §20 for sources)

* SMAPI mods use **flat** `i18n/default.json` (English source) and `i18n/<lang>.json` (target). No nesting.
* Translation tokens use **double curly braces**: `{{tokenName}}` (regex `\{\{([^}]+)\}\}`). This is the v1 token format. (Note: `{0}` / `{name}` single-brace styles are **not** the SMAPI i18n token format and must not be used as the v1 validation reference.)
* `manifest.json` provides `Name`, `Author`, `Version`, `Description`, `UniqueID`, `UpdateKeys`.
* `UpdateKeys` format is `Site:ID` (e.g. `Nexus:1234`). SMAPI tolerates whitespace (`Nexus: 1234`) — the parser must trim.
* SMAPI fallback order example: `pt-BR.json` → `pt.json` → `default.json`.

## Open verification items (resolve during M1 with real fixtures)

* [ ] Confirm scanner behavior when `i18n/default.json` is missing but `i18n/<lang>.json` exists (treat as no source inventory → skip or warn; see SPEC §6 import rules).
* [ ] Confirm handling of nested mods / multiple `i18n/` folders per mod (each manifest = one mod; associate `i18n/` with nearest parent manifest — SPEC §6 Edge Cases).
* [ ] Survey prevalence of `{{Gender:male|female}}` switch tokens and language-subfolder mode (`i18n/de/...`) — SPEC §20 open questions. If rare, defer.
* [ ] Confirm BOM / `//` comment / trailing-comma tolerance against real mod files (lenient parse, strip BOM — SPEC §6).

## Reusable from old project

The old repo's parser, token extractor, validator, exporter, and parser fixtures are reusable — see [reusable-from-old-project.md](reusable-from-old-project.md).
