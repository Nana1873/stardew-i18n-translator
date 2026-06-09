# Milestone M1: Setup + Mod Scan + Import

## Goal
Implement the core project setup flow, recursively scan the Stardew Valley Mods directory, parse SMAPI manifests and i18n JSON structures, and display a list of discovered mods in a panel.

## Scope
* **Setup Screen:** UI inputs to set/detect Stardew Valley directory, Mods directory, and select source/target languages.
* **Optional Glossary Builder:** Extract Stardew game strings to construct an official translation dictionary (non-blocking; skips gracefully if game folder cannot be read).
* **Mod Directory Scanner:** Recursive scanner searching for folders containing `manifest.json`.
* **Manifest & UpdateKeys Parser:** Extract mod metadata (name, author, version, Nexus Mod ID from `UpdateKeys`).
* **i18n Loader:** Read `i18n/default.json` and import existing target language translations (`i18n/<lang>.json`).
* **Mod List UI:** A **tree** view (SSE-AT style) grouping detected mods by package (top-level Mods subfolder); multi-component downloads expand to per-component rows with a derived, aggregated parent row; single-component mods render flat. Shows translation status, file counts, progress.

## Out of Scope
* The main String Table/Editor UI grid.
* String validation or token parsing.
* Any export, file-saving, or backup mechanisms.
* In-app AI or Nexus API calls.

## Acceptance Criteria
1. User can choose directories, and paths are validated (must contain `manifest.json` under Mod subfolders).
2. Missing or target language files are correctly recognized (e.g. "default.json exists, de.json missing").
3. Mod list **tree** renders correctly with the columns from [SPEC.md §7.3](../../SPEC.md): Status | Mod | Version | Nexus (clickable link) | Dateien (file count) | Fortschritt (progress %). Multi-component downloads (e.g. Ridgeside Village → `[CP]`/`[CC]`/SMAPI) group under an expandable parent that aggregates status/progress and surfaces the real Nexus ID from its `[CP]` component (ignoring `Nexus:-1`); single-component mods render flat.
4. If glossary extraction fails or is skipped, the scanner still functions completely.
5. All file parsing and scanner logic has unit tests with mock fixtures.

## Risks
* **Varying Manifest Structures:** Mods may have incomplete manifests, multi-component layouts (one download = several `manifest.json`, e.g. Ridgeside Village's `[CP]`/`[CC]`/`[FTM]`/SMAPI parts), or sentinel `Nexus:-1` UpdateKeys. (Mitigation: each manifest = one mod; skip components without `i18n/`; treat non-positive Nexus IDs as "no ID"; safe fallbacks + warnings, no crash. See [SPEC.md §6 Edge Cases](../../SPEC.md).)
* **Massive Mod Folders:** Some users have 300+ mods, causing scanning bottlenecks. (Mitigation: Use asynchronous scanning, and do not block the UI thread).

## Status (shipped vs. open) — 2026-06-09

**Shipped:** setup wizard (Stardew folder → Mods folder → languages → glossary step), settings persistence, Stardew auto-detection (Steam/GOG, registry + `libraryfolders.vdf`), manual folder override, recursive `manifest.json` scanner with lenient JSON (BOM/comments/trailing commas), Nexus-ID extraction (rejecting the `Nexus:-1` sentinel), `i18n/default.json` + `i18n/<lang>.json` import, the package→component mod **tree** with Status | Mod | Version | Nexus | Dateien | Fortschritt, progress/status roll-up, and clickable Nexus links.

**Glossary (shipped, post-audit):** the glossary extractor is built (SPEC §5). It
reads a **StardewXnbHack**-unpacked `Content (unpacked)/Strings/*.json` dump
(base English ↔ target locale), pairs short term-like values by key, and caches
the result. We do **not** decode XNB ourselves — a spike showed off-the-shelf LZX
crates aren't byte-perfect for XNA, so we integrate with StardewXnbHack (which
uses the game's own deserializers). The setup wizard's glossary step detects the
unpacked folder and either builds the glossary or links to StardewXnbHack with
guidance. Still **optional and non-blocking**.

**Still open / simplified for v1 (tracked):**
- **Scan progress** is shown as an inline "Scanning…" label rather than the modal scan dialog with per-file progress described in SPEC §7.2.
- **Glossary hints in the editor** (SPEC §7.5) — showing matched terms while translating — are not wired yet (the data + cache exist; surfacing them is a small M2 follow-up).

## Suggested Issue Breakdown

### Issue 3: Implement setup wizard for Stardew and Mods paths
* **Goal:** Create settings UI, detect paths, select source/target languages, and implement optional glossary extraction.
* **Suggested Agent:** Claude Code (for UI framework setup).

### Issue 4: Implement recursive manifest.json mod scanner
* **Goal:** Scan Mods directory, parse `manifest.json`, extract Nexus ID, and build database model of mods.
* **Suggested Agent:** Codex (for isolated, highly testable scanner code).

### Issue 5: Parse SMAPI i18n/default.json and target language files
* **Goal:** Read base English/default key-values and import existing target translations, handling missing files gracefully.
* **Suggested Agent:** Codex.

### Issue 6: Display mod list tree (grouped by package)
* **Goal:** Bind scan results to the left-panel Mod List tree: group mods by `packageId`, render multi-component packages as expandable parents with derived aggregate rows, single-component mods flat, with progress bars and metadata.
* **Suggested Agent:** Claude Code.

## Agent Handoff Notes
*Ensure mock fixtures are placed in `tests/fixtures/` and contain valid/invalid manifests for testing.*
