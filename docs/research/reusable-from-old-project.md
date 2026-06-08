# Reusable Assets from the Old Project

> **Old project:** `E:\DevProjects\Stardew Translator` (Tauri + TypeScript/Vite). Reference only.
> **Rule:** Reuse the *logic, fixtures, and research* — **not** the architecture/design. The old project was over-abstracted (plugin/provider layers, broad multi-format parser). See [SPEC.md Appendix C](../../SPEC.md). Port narrowly to v1 scope; do not import its abstractions.

> **Stack chosen:** [ADR 0001](../adr/0001-tech-stack-decision.md) = **Tauri (Rust + TypeScript)**. This is the broadest-reuse option: the old project was *also* Tauri 2, so both its **Rust** data layer and its **TypeScript** UI logic and its **fixtures** are reusable. Put the hot path (scan/parse/validate) in Rust; reuse TS for UI-side logic.

## Reusable Rust (hot path — old `src-tauri/src/`)

| Asset | Old path | v1 use | Caveat |
|-------|----------|--------|--------|
| Mod/i18n parser | `src-tauri/src/parser.rs` | Recursive scan + relaxed-JSON (comment/BOM-tolerant) parsing of large `default.json` (Ridgeside `[CP]` ≈ 2.4 MB / 17.5k keys) | Trim to flat `i18n` only; drop any multi-format ambition. |
| Validator | `src-tauri/src/validator.rs` | Source↔target `{{token}}` set comparison | Reduce to the 4 v1 rules. |
| Models | `src-tauri/src/models.rs` | Rust structs for mod/file/string/status | Map to SPEC §9/§14; drop unused fields. |
| Perf harness | `src-tauri/src/perf.rs` | Reference for benchmarking large-mod scans | Optional. |

Cargo deps already proven on Tauri 2: `serde`, `serde_json`, `tauri-plugin-dialog`, `chrono`, `sysinfo`, `zip`. (`reqwest` was present for networking — **not** needed in v1; v1 makes no API calls.)

## Directly reusable (TypeScript — UI-side logic)

| Asset | Old path | v1 use | Caveat |
|-------|----------|--------|--------|
| Token regex | `src/parser/protectedTokens.ts` | `{{...}}` extraction (`\{\{([^}]+)\}\}`) | Old extractor covers **many** token kinds (Content Patcher, gender switch, mail, dialogue, brackets, positional, newline). v1 needs **only** the `{{...}}` SMAPI i18n case — extract that one path; do **not** port the full multi-kind tokenizer (out of v1 scope). |
| i18n parser | `src/parser/i18nParser.ts` | Flat-JSON parse, BOM strip, lenient/comment tolerance | Trim to flat `i18n` only. |
| Validator | `src/validator/projectValidator.ts` | Source↔target token-set comparison logic | Reduce to v1's 4 rules (`token-missing`, `token-added`, `empty-target`, `json-invalid`). |
| Exporter | `src/exporter/jsonExporter.ts` | Ordered key serialization, UTF-8 no-BOM, 2-space indent | Verify it **preserves `default.json` key order** (not alphabetical). |
| Domain models | `src/domain/*` (`status.ts`, `translationUnit.ts`, `diagnostic.ts`) | Shape reference for `TranslationString` / status / validation issue | Map onto SPEC §9/§14; drop unused fields. |
| Parser fixtures | `tests/fixtures/parser/*` | Test inputs | Only **in-scope** fixtures: `valid-top-level-i18n`, `relaxed-json-i18n`, `malformed-json`, `missing-extra-keys`, `placeholder-heavy`. The `dialogue/`, `mail/`, `content-patcher-token-heavy/` fixtures are **out of v1 scope** — keep only if useful as negative/skip cases. |

## Reusable research / documentation

| Topic | Old path |
|-------|----------|
| Glossary seeding from base game (`Content (unpacked)/`, `[LocalizedText]` resolution) | `docs/research/glossary-seeding-from-base-game.md` |
| Stardew localization rules | `docs/research/stardew-localization.md`, `docs/parsers/stardew-localization-rules.md` |
| Token/preservation rules | `docs/localization/PRESERVATION_RULES.md`, `docs/validators/translation-validation-rules.md` |
| Content Patcher & tokens (background only — out of v1 scope) | `docs/research/content-patcher-and-tokens.md` |

## Do **not** reuse

- The old plugin/provider abstractions, AI provider layer (`src/ai/*`), storage engine, and project-file format.
- The multi-format parser ambition (dialogue, mail, events, `content.json`).
- The old roadmap/phase structure (cause of scope creep).

## Note on tech stack

The reusable logic spans **both Rust and TypeScript**, and the old project was Tauri 2. This is why [ADR 0001](../adr/0001-tech-stack-decision.md) chose **Tauri**: it reuses the Rust hot path *and* the TS UI logic *and* the fixtures, while giving the best performance/memory on very large mods. Electron would reuse only the TS; Python+PySide6 would discard all of it.
