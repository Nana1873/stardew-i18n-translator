# Stardew i18n Translator — Product & Architecture Specification

> **Version:** 1.0 — 2026-06-07
> **Status:** Draft — Awaiting Approval
> **Workflow Reference:** [SSE Auto Translator](https://github.com/Cutleast/SSE-Auto-Translator)
> **Old Project Reference:** `E:\DevProjects\Stardew Translator` (lessons learned only)

---

## 1. Product Goal

Stardew i18n Translator is a **local desktop tool** for translating Stardew Valley / SMAPI mod content.

It provides a compact, power-user workflow — inspired by SSE Auto Translator — to:

1. Auto-detect a Stardew Valley installation and optionally build an **official game glossary**.
2. Scan the `Mods` folder, detect mods via `manifest.json`, and find translatable `i18n` files.
3. Import existing target-language translations and show **progress/status per mod**.
4. Let the user **edit strings** in a compact table + dialog workflow with validation.
5. **Export** clean `i18n/<lang>.json` files ready for use.

The tool is deliberately **small in scope**. It focuses exclusively on SMAPI `i18n` files and does not attempt to be a full mod manager, publishing platform, or project-management system.

---

## 2. Target User

| User                  | Description                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------- |
| **Mod translators**   | Community members translating popular SMAPI mods into their language. May handle 10–200 mods. |
| **Mod authors**       | Developers preparing or reviewing translations for their own mods.                            |
| **Bilingual players** | Players who want to quickly translate a few mods for personal use.                            |

**Assumed skill level:** Comfortable with file systems and JSON. Not necessarily developers. Should not need to know Git, CLI tools, or API concepts to use the core workflow.

---

## 3. Core Workflow

```
┌─────────────┐     ┌───────────┐     ┌────────────────┐     ┌──────────────┐
│ Setup Wizard │────▶│ Mod Scan  │────▶│ Main Overview   │────▶│ String Edit  │
│              │     │           │     │ (Mod List +     │     │ (Table +     │
│ • Game path  │     │ • Detect  │     │  String Table)  │     │  Dialog)     │
│ • Mods path  │     │ • Import  │     │                 │     │              │
│ • Languages  │     │ • Status  │     │ • Filter/Search │     │ • Validate   │
│ • Glossary   │     │           │     │ • Bulk Actions  │     │ • Save       │
│   (optional) │     │           │     │ • Context Menu  │     │              │
└─────────────┘     └───────────┘     └────────────────┘     └──────┬───────┘
                                                                     │
                                                               ┌─────▼───────┐
                                                               │   Export     │
                                                               │ i18n/<l>.json│
                                                               └─────────────┘
```

v1 core loop: **Setup → Scan → Browse → Edit → Export.**

AI translation (Claude-Code batch) is available as the last milestone of v1 but is not required for the core loop to work.

---

## 4. Setup Workflow

The setup wizard runs on first launch and can be re-triggered from settings.

### Steps

| Step | Required | Description                     | Details                                                                                                                                                                                                                                                                                     |
| ---- | -------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | ✅       | **Stardew Valley folder**       | Auto-detect via Steam library folders (`libraryfolders.vdf`), GOG registry keys, or common paths. User can browse manually. Validate by checking for `Stardew Valley.dll` or `Content/` folder.                                                                                             |
| 2    | ✅       | **Mods folder**                 | Default: `<Stardew Valley>/Mods`. A **generic** manual folder override is offered only if the default is wrong (any folder containing mod subfolders with `manifest.json`). This is a plain folder picker — **not** Vortex/MO2 support, and no mod-manager workflow is detected or implied. |
| 3    | ✅       | **Source & target language**    | Source: `default` (English) — fixed for v1. Target: dropdown of Stardew-supported languages (de, es, fr, hu, it, ja, ko, pt, ru, tr, zh).                                                                                                                                                   |
| 4    | ❌       | **Build glossary** _(optional)_ | Extract official game term pairs from the Stardew `Content` folder (see §5). Show progress. Cache result. **Skippable** — tool must function fully without glossary.                                                                                                                        |

### Auto-detection Paths (Windows)

```
Steam:  <SteamPath>\steamapps\common\Stardew Valley
GOG:    C:\Program Files (x86)\GOG Galaxy\Games\Stardew Valley
Manual: User browses to folder
```

Steam path is read from the Windows registry (`HKCU\Software\Valve\Steam\SteamPath`) and `libraryfolders.vdf`.

### What is NOT in setup for v1

| Item                | Reason                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| Nexus API key       | v1 uses only Nexus ID detection from `manifest.json`. No API calls needed. Deferred to v1.1+.     |
| AI provider API key | In-app AI translation is not in v1. Claude-Code batch (Milestone 4) needs no API key in the tool. |

---

## 5. Official Game Glossary Concept

### Purpose

The glossary is a **multilingual dictionary of official Stardew Valley game terms** — item names, NPC names, location names, seasons, UI strings. It serves three purposes:

1. **Manual translation hints** — Shown in the string editor when glossary terms appear in source text.
2. **AI prompt hints** — Included in Claude-Code batch exports so AI uses official terms.
3. **Validation** _(v1.1+)_ — Flag deviations from official terminology.

### Non-Blocking Principle

> [!IMPORTANT]
> The glossary must **never block** the core workflow. If glossary extraction fails, is skipped, or the game content is unavailable, the tool must work fully: scan, import, edit, validate, export. Glossary features degrade gracefully to "no hints available."

### Extraction

The glossary is extracted **locally** from the user's own Stardew Valley installation. No game text is bundled or redistributed.

**Data sources (Stardew 1.6+):**

| Asset                        | Content                                     | Priority |
| ---------------------------- | ------------------------------------------- | -------- |
| `Data/Objects`               | Item names (objects, crops, fish, minerals) | High     |
| `Data/BigCraftables`         | Craftable item names                        | High     |
| `Data/Characters`            | NPC display names                           | High     |
| `Strings/StringsFromCSFiles` | Seasons, days, UI terms, location names     | High     |
| `Strings/Objects`            | Resolved object display strings             | High     |
| `Data/Weapons`               | Weapon names                                | Medium   |
| `Data/Tools`                 | Tool names                                  | Medium   |
| `Strings/Characters`         | Resolved character strings                  | Medium   |
| `Strings/UI`                 | Menu/UI strings                             | Medium   |
| `Data/Boots`                 | Boot names                                  | Low      |
| `Data/Hats`                  | Hat names                                   | Low      |
| `Data/Furniture`             | Furniture names                             | Low      |

**1.6 indirection:** Many display names in data files use `[LocalizedText Strings\<file>:<key>]` tokens. The extractor must resolve these by reading the corresponding `Strings/` file.

**Locale mapping (game → SMAPI i18n):**

| Game locale suffix  | SMAPI i18n code     |
| ------------------- | ------------------- |
| _(base, no suffix)_ | `default` (English) |
| `.de-DE`            | `de`                |
| `.es-ES`            | `es`                |
| `.fr-FR`            | `fr`                |
| `.hu-HU`            | `hu`                |
| `.it-IT`            | `it`                |
| `.ja-JP`            | `ja`                |
| `.ko-KR`            | `ko`                |
| `.pt-BR`            | `pt`                |
| `.ru-RU`            | `ru`                |
| `.tr-TR`            | `tr`                |
| `.zh-CN`            | `zh`                |

### Extraction Strategy (v1)

1. **Primary:** Read from `Content (unpacked)/` if present (SMAPI creates this on first run).
2. **Fallback:** If unpacked content is not available, show guidance asking the user to run the game with SMAPI once, or provide a path to unpacked content.
3. **Skip:** User can skip glossary entirely. Tool continues without hints.
4. **Future:** In-app XNB reader for fully automatic extraction without SMAPI dependency.

### Storage

- Cached as a single JSON file per language pair in the app data directory.
- Structure: `{ "en_term": "target_term", ... }` with metadata.
- Rebuildable on demand (e.g., after game update).
- v1 stores only the active `default → <target>` language pair.

### Glossary Scope

| Include           | Exclude                |
| ----------------- | ---------------------- |
| Item names        | Dialogue prose         |
| NPC display names | Event scripts          |
| Location names    | Description paragraphs |
| Season/day names  | Quest text             |
| Common UI terms   | Mail content           |

Dialogue and narrative prose would pollute matching. The glossary is strictly **named entities and identifiers**.

---

## 6. Mod Scan Concept

### Discovery

1. Recursively walk the configured Mods folder.
2. Find all `manifest.json` files.
3. Each `manifest.json` defines one mod root.
4. From each manifest, read: `Name`, `Version`, `UniqueID`, `UpdateKeys`.
5. Extract Nexus ID from `UpdateKeys` entries matching `Nexus:<id>` (trim whitespace, e.g. `Nexus: 7286`). **Only a positive integer is a real ID** — sentinel/placeholder values such as `Nexus:-1` (used by multi-component mods to suppress update checks on sub-mods) must be treated as **no Nexus ID** (display `—`, no link). In a multi-component download, the real ID typically lives on only one component (e.g. the `[CP]` pack).
6. Search for `i18n/` folders relative to the manifest's parent directory.
7. Within each `i18n/` folder, find `default.json` and any existing `<target_lang>.json`.
8. **Assign a package:** record each mod's _package_ = the top-level folder under the Mods root that contains it (e.g. `Ridgeside Village`). Mods sharing a package group under one tree node in the UI (see §7.3). A package with one component is shown flat; with several, as an expandable parent.

### Import

- Parse `default.json` as the **source key inventory** (flat key-value JSON).
- Parse `<target_lang>.json` as **existing translations**.
- Pair keys by name. Mark imported translations with status `imported`.
- Keys in target that don't exist in source → silently ignored in v1.
- Keys in source with no target → `untranslated`.
- Keys in source with empty target value → `untranslated`.

### Edge Cases

| Case                                                                                                    | Handling                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Nested mods** (sub-mods with own `manifest.json`)                                                     | Each manifest = separate mod. Associate `i18n/` with nearest parent manifest.                                                                                       |
| **Multiple `i18n/` folders** per mod (Content Patcher sub-packs)                                        | Each `i18n/` folder is a separate translation file unit under the same mod.                                                                                         |
| **Empty `default.json`** (`{}`)                                                                         | Mark mod as "no translatable strings" (gray).                                                                                                                       |
| **Missing `i18n/` folder**                                                                              | Skip mod — no translatable content.                                                                                                                                 |
| **Malformed `manifest.json`**                                                                           | Skip mod, log warning. Do not crash scanner.                                                                                                                        |
| **BOM in JSON**                                                                                         | Strip UTF-8 BOM before parsing.                                                                                                                                     |
| **Comments in JSON**                                                                                    | Use lenient parser or strip `//` comments. Log if comments detected.                                                                                                |
| **Missing `UniqueID`**                                                                                  | Use folder name as fallback identity. Log warning.                                                                                                                  |
| **Multi-component mod** (one download = several manifests, e.g. `[CP]`/`[CC]`/`[FTM]`/SMAPI components) | Each manifest = a separate mod row. Components without `i18n/` are skipped. Real-world example: Ridgeside Village = 4 manifests, 3 with i18n (`[CP]` ≈ 17.5k keys). |
| **`Nexus:-1` (or non-positive) UpdateKey**                                                              | Sentinel, not a real ID → treat as no Nexus ID (`—`, no link). Common on the non-`[CP]` components of multi-part mods.                                              |
| **Symlinks / junctions**                                                                                | Follow, but detect cycles.                                                                                                                                          |

### Progress Calculation

```
progress = (strings with non-empty target text) / (total strings in default.json)
```

Calculated per file, aggregated per mod (across all `i18n/` folders), and rolled up per package (across all component mods) for the parent tree node.

---

## 7. Main Overview / UI Screens

The v1.5 UI has **8 screen elements** (the Setup Wizard, Scan Dialog, Dashboard Home, Main Window/Work View, String Table, String Edit Dialog, Context Menu, and Settings Dialog — all modal dialogs except the Dashboard and the Main Window/String Table). The toolbar is the only navigation chrome: brand = Home (§7.8), everything else happens in the work view.

> **v1.5 redesign (2026-06).** After real-world use, the UI was redesigned with
> Claude Design ("dashboard home + two-panel work view" concept; reference HTML
> in `docs/design/`). §7.0 records the design system; §7.3–§7.5, §7.7 and §7.8
> are updated to match. Rollout (all delivered): ① design tokens + restyle of
> all existing screens, ② status model 5→4 (replace `not-translatable` with a
> "Keep original" action, §9), ③ `//` comments in `default.json` as section
> dividers, ④ dashboard home (§7.8) + cross-mod review queue. Still open:
> settings left-nav restyle (§7.7), section context in AI prompts (§7.4).

### 7.0 Visual design system (v1.5)

Warm dark theme ("subtle Stardew warmth"). Drop-in `:root` tokens — every
value below is used by the mockups in `docs/design/`:

| Token group | Values                                                                                                                                                                                          |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Surfaces    | `--bg #1a1713` (app) · `--surface #221e18` (panels/cards) · `--surface-2 #2a251d` (toolbar, row heads) · `--surface-3 #15120e` (inputs, wells) · `--border #3d362b` · `--border-strong #4e463a` |
| Text        | `--text #ece6da` · `--text-muted #a89e8d` · `--text-dim #7a7060`                                                                                                                                |
| Brand       | `--gold #e3a94e` · `--gold-hi #e8bd6f` · `--gold-tint rgba(227,169,78,.16)` · `--on-gold #231d12` · `--key #d9c389` (keys/code) · `--token #82bbff` (token chips)                               |
| Status      | untranslated `#9aa0a6` ○ · translated `#5ec488` ✓ · review-needed `#ec8b3f` ⚑ · outdated `#b98cdb` ↻                                                                                            |
| Semantic    | error `#e06c6c` · warning `#e3a94e` · link `#6ab0ff`                                                                                                                                            |
| Type        | Segoe UI (system); monospace for keys/tokens/shortcuts; `tabular-nums` for all counts                                                                                                           |
| Metrics     | table rows 30px · section dividers 26px · radii 4/7/11/20                                                                                                                                       |

Hard rules (these resolve the readability complaints that triggered the redesign):

1. **Status = hue + glyph + 3px left row edge.** Any one signal alone is
   sufficient (colorblind-safe). Status never tints the full row background.
2. **Only hover and selection tint a row** (selection = gold). Statuses can
   therefore never smear together over hundreds of rows.
3. **Gold is exclusively the brand/selection color** — never a status — so
   selection and "needs review" (orange `#ec8b3f`) cannot be confused.
4. **No GPU-blurred shadows in the virtualized table** (17k+ rows must stay
   smooth); depth comes from the three surface steps.
5. **Zero layout shift in the editor** across Save & next (§7.5): token,
   glossary, and validation rows are reserved slots, present on every string.

### 7.1 Setup Wizard

See §4. Modal wizard. Shown on first launch. Re-accessible via the Settings dialog ("Re-run setup…").

### 7.2 Scan Dialog

Modal dialog during mod scanning.

| Element      | Content                                   |
| ------------ | ----------------------------------------- |
| Progress bar | Overall scan progress                     |
| Current mod  | Name of mod being scanned                 |
| Current file | File path being parsed                    |
| Scan results | Summary: X mods found, Y files, Z strings |
| Errors       | List of skipped/malformed mods            |

### 7.3 Main Window

**Two-panel layout:**

**Left panel — Mod List Tree** _(grouped by package, SSE-AT style)_

A two-level tree, mirroring SSE-AT's Mod → Plugin tree:

- **Level 1 — Package:** the top-level folder under the Mods root (e.g. `Mods/Ridgeside Village/`). This is the unit the user downloaded.
- **Level 2 — Component:** each `manifest.json` inside that package (e.g. `[CP]`, `[CC]`, SMAPI components). Components without an `i18n/` folder are omitted.

A package containing a **single** component renders as one flat row (no expand arrow). A package with **multiple** components renders as an expandable parent node with one child row per component.

| Column          | Package (parent) row                                                                                                | Component (child / single) row         |
| --------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| **Status**      | Worst-case roll-up across components (see §9)                                                                       | Color-coded icon (see §9)              |
| **Mod**         | Package folder name (e.g. `Ridgeside Village`)                                                                      | Component name from manifest           |
| **Version**     | _(blank, or the `[CP]` component's version)_                                                                        | Version string from manifest           |
| **Nexus**       | Real Nexus ID rolled up from a component (typically the `[CP]` one; ignores `Nexus:-1`) as a clickable link, or `—` | Component's own valid Nexus ID, or `—` |
| **Dateien**     | Sum of translatable `i18n/` files across components                                                                 | Number of translatable `i18n/` files   |
| **Fortschritt** | Aggregated progress across components                                                                               | Progress bar + percentage              |

No other columns. No priority column. Selecting a component (or a single-component package) loads its strings into the right panel; selecting a multi-component parent shows the aggregate and does not itself load a string table.

**Right panel — String Table** (for selected mod/file)

See §7.4.

**Toolbar:**

- Brand button toggles dashboard ⇄ work view (§7.8); highlighted while the
  dashboard is shown
- Scan / Re-scan (gold-tinted primary)
- Export (selected mod / all), Import batch…
- Settings
- Global "⚑ N to review" pill (hidden at 0) — opens the dashboard review queue
- Search bar (right-aligned; active in the work view)
- _(v1.5)_ The status filter moved out of the toolbar into the string panel's
  filter-chip row (§7.4).

### 7.4 String Table

Shown in the right panel when a mod (or specific file within a mod) is selected.

| Column          | Content                                                         |
| --------------- | --------------------------------------------------------------- |
| **Status**      | 16px glyph chip + short label (○ ✓ ⚑ ↻), plus 3px left row edge |
| **Key**         | i18n string key (monospace font)                                |
| **Original**    | Source text from `default.json`                                 |
| **Target Text** | Translated text (editable cell or via dialog)                   |
| **Validation**  | Validation status icon(s). Hover for details.                   |

Features:

- Sortable by any column.
- **Filter-chip row** above the table (v1.5): one pill per status with glyph +
  live count, plus "All N"; replaces the old toolbar dropdown. The active chip
  is highlighted; chips with count 0 stay visible but muted.
- **Footer status bar** (v1.5): per-status counts + keyboard hints
  (Enter/double-click to edit).
- **Section dividers** (v1.5): standalone `// comment` lines in `default.json`
  act as section headers — a non-selectable 26px divider row (`// title` +
  live row count) appears above each run of keys that follow the comment.
  String-aware extraction: `//` inside a value (URLs) or trailing same-line
  comments never start a section. Dividers hide while a column sort is active
  (sections only make sense in file order) and stay under search/status
  filters with counts of the still-visible rows. _Planned follow-up: pass the
  section title as context into the AI prompt (M6) and the Claude batch (M4)._
- Text search across key, original, and target.
- Multi-select with **Ctrl+Click** (toggle) and **Shift+Click** (range).
- **Ctrl+A** to select all visible.
- Double-click opens String Editor (§7.5).
- Right-click opens Context Menu (§7.6).

### 7.5 String Edit Dialog

Opened by **double-clicking** a string row.

```
┌─────────────────────────────────────────────────────────┐
│  Mod: My Mod Name  |  File: i18n/default.json           │
│  Key: greeting     |  Status: ● review-needed            │
│  Tokens: {{PlayerName}}, {{FarmName}}                    │
├──────────────────────────┬──────────────────────────────┤
│  Original (English)      │  Translation (Target)        │
│                          │                              │
│  Hello {{PlayerName}}!   │  Hallo {{PlayerName}}!       │
│  Welcome to              │  Willkommen auf              │
│  {{FarmName}}.           │  {{FarmName}}.               │
│                          │                              │
├──────────────────────────┴──────────────────────────────┤
│  Glossary: FarmName → Farm (keep token)                  │
│  Validation: ✅ All checks passed                        │
├─────────────────────────────────────────────────────────┤
│  [◀ Prev]  [Next ▶]  [Reset]  [Save]  [Cancel]         │
└─────────────────────────────────────────────────────────┘
```

| Element             | Description                                                                                                                                        |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Metadata bar**    | Key (monospace) + status pill (glyph + label); mod/file/position crumbs                                                                            |
| **Tokens slot**     | _Reserved_ row: clickable token chips, or "— none —"                                                                                               |
| **Glossary slot**   | _Reserved_ row: matched glossary terms, or "— no hints —"                                                                                          |
| **Left pane**       | Source text (read-only)                                                                                                                            |
| **Right pane**      | Target text (editable text area, gold focus ring)                                                                                                  |
| **Validation slot** | _Reserved_ line (fixed min-height): live validation results, or "✓ No issues"                                                                      |
| **Translate**       | Translate the source with the configured local AI (M6); fills the target as `review-needed`. Shown always; hints to configure AI if none is set up |
| **Save & next**     | Gold primary: confirm this string, jump to the next (closes on the last)                                                                           |
| **Save**            | Save changes, close dialog                                                                                                                         |
| **Navigation**      | Previous / Next to move through strings without closing (auto-saves changes)                                                                       |
| **Reset**           | Clear target text back to empty (or to last imported value)                                                                                        |
| **Cancel**          | Discard changes (Esc)                                                                                                                              |

**Zero-layout-shift contract (v1.5):** the token, glossary, and validation
rows are always rendered (empty-state text when N/A) and the action bar sits
below a fixed-height body — so during a Save & next run the buttons never move
under the cursor, whatever the next string contains.

**Keyboard shortcuts:**

| Shortcut     | Action                                               |
| ------------ | ---------------------------------------------------- |
| `Ctrl+Enter` | Save and close                                       |
| `Esc`        | Cancel and close                                     |
| `Alt+Left`   | Previous string                                      |
| `Alt+Right`  | Next string                                          |
| `F2`         | Keep original (copies the source as the translation) |
| `F3`         | Alias of `F2` (legacy "copy original")               |
| `F4`         | Reset target                                         |
| `Ctrl+F5`    | Translate with the local AI (M6)                     |

### 7.6 Context Menu (Right-Click)

Available on one or multiple selected strings in the String Table.

**v1 context menu:**

| Action                          | Description                                                                                  |
| ------------------------------- | -------------------------------------------------------------------------------------------- |
| **Edit String**                 | Open in String Editor (single selection only)                                                |
| **Copy Original**               | Copy source text to clipboard                                                                |
| **Copy Translation**            | Copy target text to clipboard                                                                |
| **Mark as Translated**          | Set status to `translated` for all selected                                                  |
| **Keep Original Text**          | Copy the source as the translation for all selected (`translated`, see §9 v1.5)              |
| **Clear Translation**           | Clear target text and set status to `untranslated` (explicitly destructive)                  |
| **Search Translation on Nexus** | Opens browser to Nexus search for this mod + target language _(mod-level context menu only)_ |

**Added in Milestone 4 (Claude-Code):**

| Action                     | Description                                                                  |
| -------------------------- | ---------------------------------------------------------------------------- |
| **Export for Claude-Code** | Export selected strings as a batch file for external Claude-Code translation |

### 7.7 Settings Dialog

Modal dialog opened from the toolbar **Settings** button — the single "settings
section accessible from toolbar" (§19 #5). A flat list of editable settings, **not**
the step-by-step Setup Wizard:

- **Folders** — current Stardew/Mods paths, with a **Re-run setup…** button that
  re-opens the Setup Wizard to change them (§4).
- **Language** — target language (source is fixed to English).
- **Glossary (optional)** — build status + Build button, or StardewXnbHack guidance.
- **Local AI (optional)** — local-LLM connection (M6): provider preset, base URL,
  Test connection, model. Lives here, not in the wizard, because the tool is
  translation-first and AI is opt-in. The Test-connection result is an explicit
  state: green confirmed line on success, red diagnostic + Retry on failure.
- _(v1.5, planned)_ The flat list becomes a left-nav settings window
  (Folders & language · Local AI · Glossary) per `docs/design/`; content and
  semantics stay as above.

### 7.8 Dashboard Home (v1.5)

The landing screen — answers "where do I stand?" before any table loads.
The toolbar brand button toggles between dashboard and work view; opening any
mod also switches to the work view (§7.3).

| Block              | Content                                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Greeting           | Time-of-day greeting · target language · mods-scanned count · Scan CTA                                                                |
| Stat cards (4)     | Overall translated % (with bar) · Needs review (orange) · In progress (mods 1–99%) · Untouched (mods at 0%)                           |
| Review queue       | Only when unreviewed AI suggestions exist: per-mod backlog bars sorted by size; clicking opens that mod **filtered to review-needed** |
| Continue cards (3) | Most recently opened mods with progress bars (`localStorage` recency cache) · Resume →                                                |
| Browse all mods →  | Enters the work view without picking a mod                                                                                            |

The per-mod review counts come from the scan (`ScannedMod.reviewNeeded`,
counted from saved state) and stay live after edits via the existing
`onCountsChange` pipeline. The dashboard holds **no state of its own** — it is
a pure projection of the scan, so it never goes stale.

---

## 8. String Editor Workflow

### Editing Flow

1. User double-clicks a string → String Editor opens.
2. Source text displayed read-only on the left.
3. User types/edits target text on the right.
4. **Live validation** runs as the user types (debounced, ~300ms).
5. Glossary matches are highlighted in the source text (if glossary available).
6. User can navigate to previous/next string without closing.
7. **Save** writes the change and sets status to `translated`.
8. **Cancel** discards all unsaved changes.

---

## 9. Status Model

### String-Level Status

v1.5 uses **4 statuses** (glyphs per §7.0). Two describe a hand-edited string's state; `outdated` is derived automatically; `review-needed` is the AI-workflow status.

| Status          | Presentation | Meaning                                                                            | How it's set                                                                                                              |
| --------------- | ------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `untranslated`  | ○ Gray       | No target text yet                                                                 | Initial; or editor "Reset" (F4); or context-menu "Clear translation"                                                      |
| `translated`    | ✓ Green      | Has a translation (your edit, an imported `<lang>.json` value, or a kept-original) | Saving in the editor; "Mark as translated"; **"Keep original"** (F2 / context menu) copies the source as the translation  |
| `outdated`      | ↻ Purple     | The English source changed since this string was translated                        | **Automatic** on re-scan (see below) — never set manually                                                                 |
| `review-needed` | ⚑ Orange     | An unreviewed machine suggestion (AI) awaiting a human pass                        | Set by an AI translation (M6 local LLM / M4 batch import); **confirmed → `translated`** by an explicit Save in the editor |

> **Scope note:** An earlier draft had 6 statuses (`imported`, `review-needed`, `done`, …). `imported`/`done` collapsed to **`translated`**. **v1.5 removed `not-translatable`:** strings that should stay English (proper nouns, commands) are handled by the **"Keep original"** action, which stores the source text as an explicit identical translation. That is strictly better — the string is covered by `outdated` detection (a changed source re-surfaces it) and exports as an explicit key instead of a silent omission. Legacy stored `not-translatable` values are migrated on load: an empty stored target resolves to the current source as `translated`; a non-empty one keeps its text and the regular staleness check applies.

### `outdated` Detection (automatic, surgical)

When a string is saved, its `sourceHash` (SHA-256 of the **English source text of that key**) is stored alongside the target. On re-scan, a `translated` or `review-needed` string whose stored `sourceHash` no longer matches the current `default.json` value for that key becomes `outdated`.

This is **per-string**, not per-mod: a mod update flags **only** the handful of strings whose English text actually changed. New keys arrive as `untranslated`; unchanged translations stay `translated`.

### Mod-Level Status (Aggregate)

Coarse health indicator derived from the working translation counts:

| Aggregate | Condition                                    |
| --------- | -------------------------------------------- |
| ⚪ Gray   | Not started (0%), or no translatable strings |
| 🟡 Gold   | In progress (some keys still untranslated)   |
| 🟢 Green  | All keys have a working translation          |

The **package** (parent tree node, §7.3) uses the same roll-up across its component mods. (Per-string `outdated` is shown in the string table's status bar, not the coarse mod dot.)

---

## 10. Validation Rules

Validation runs per string. Results are shown in the String Table and String Editor.

### v1 Rule Set (Minimal)

v1 validation focuses on **preventing broken mods** — not on translation quality.

| Rule ID            | Severity | Check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `token-missing`    | Error    | A **protected token** present in the source is missing (or under-represented) in the target. This will break the mod at runtime. **Exemption:** `\n` is layout, not syntax — newline differences are covered by `newline-mismatch` below, never by this error.                                                                                                                                                                                                                                   |
| `token-added`      | Warning  | The target contains a **protected token** not present in the source. Likely a typo. (`\n` exempt, as above.)                                                                                                                                                                                                                                                                                                                                                                                     |
| `newline-mismatch` | Warning  | The line-break count differs between source and target. Purely informational: a translation rewraps freely (German runs ~25% longer than English), and a changed `\n` count never breaks the mod. Pulled forward from v1.1 — see the scope note below.                                                                                                                                                                                                                                           |
| `empty-target`     | Warning  | Key exists in target file but value is empty string.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `json-invalid`     | Error    | **Export-serialization safety.** The value cannot be safely serialized to valid JSON — e.g. an invalid/unpaired Unicode surrogate or stray control character (typically from an imported file). A correct serializer escapes normal characters (quotes, backslashes, newlines) automatically, so well-formed input never trips this; the rule exists only to _guarantee the exported `<lang>.json` is always valid JSON_. Affected strings are skipped on export (per the severity table below). |

**5 rules total for v1.** Quality and style checks are deferred to v1.1+.

> **Scope note (2026-06-10):** v1 originally treated `\n` as a protected token inside `token-missing` — which made the first real batch import flag a perfectly valid German translation as an **error** (and export would have skipped it) just because it rewrapped 4 English lines into 3 German ones. That contradicted this section's own philosophy (errors = "will break the mod") and the original plan (`newline-mismatch` was always specced as a warning). Fixed by exempting `\n` from the token error rules and pulling the `newline-mismatch` **warning** forward from v1.1.

### Deferred Validation Rules (v1.1+)

| Rule ID                 | Severity | Target Version           |
| ----------------------- | -------- | ------------------------ |
| `token-case-changed`    | Warning  | v1.1                     |
| `bracket-token-missing` | Warning  | v1.1                     |
| `glossary-deviation`    | Info     | v1.1 (requires glossary) |
| `extra-key`             | Info     | v1.1                     |
| `identical-to-source`   | Info     | v1.1                     |
| `escape-suspicious`     | Warning  | v1.1                     |

### Severity Levels and Export Behavior

| Level       | Meaning                                             | Export behavior                                                                                        |
| ----------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Error**   | Will break the mod at runtime                       | **Blocks export** for affected strings. Tool exports all other strings and reports which were skipped. |
| **Warning** | Should be reviewed but is not technically dangerous | **Does not block export.** Shown in export summary.                                                    |

> [!IMPORTANT]
> **Missing translations (`untranslated` strings) do NOT block export.** The tool exports all strings that have target text. Untranslated keys are simply omitted from the export file (SMAPI falls back to `default.json` for missing keys). The export summary shows how many strings were skipped.

### Protected Tokens

`token-missing` / `token-added` operate on **protected tokens** — anything a translation must preserve or the mod breaks at runtime. This extends beyond SMAPI i18n `{{...}}` to the Stardew dialogue/Content Patcher tokens that dominate real content mods (e.g. Ridgeside). Recognized kinds (ported from the previous project's token extractor):

| Kind                    | Examples                                        |
| ----------------------- | ----------------------------------------------- |
| Content Patcher / i18n  | `{{PlayerName}}`, `{{i18n:key}}` (nested-aware) |
| Gender switch           | `${male^female}$`                               |
| Mail commands           | `[#]`, `%item … %%`, `%action … %%`             |
| Dialogue page break     | `#$b#`, `#$…#`                                  |
| Bracket tokens          | `[ … ]`                                         |
| Positional placeholders | `{0}`                                           |
| Dialogue commands       | `$b`, `$s`, `$e`, `$1` …                        |
| Single-character        | `@` (player name), `^` / `\n` (line break)      |

Tokens are compared as **multisets** (counts matter, order does not): every token in the source must appear in the target the same number of times. This catches a dropped second `$b`, not just a missing distinct token.

> **Scope note (2026-06-08):** Protecting the full Stardew token taxonomy (not only `{{...}}`) was pulled forward from v1.1 into v1 — without it, validation is effectively useless for the dialogue-heavy content mods that are the common case. The 4-rule cap (§19) is unchanged; only the definition of "token" broadened.

---

## 11. Claude-Code Batch Workflow

> [!NOTE]
> This is one of **two AI workflows in v1** — the other is the M6 local-LLM translation (§17 M6), which talks to a local OpenAI-compatible server (Ollama / LM Studio) on `localhost`. Neither requires an API key, and both land results as `review-needed`. **Cloud** AI APIs (keys, external network) remain deferred to v1.1+. The Claude-Code batch workflow needs no keys in the tool — the user runs Claude Code externally.

### Concept

The tool exports a structured batch file that the user processes externally with Claude Code. The user then imports the results back into the tool.

### Export

1. User selects strings in the String Table → right-click → **"Export for Claude Code (N)"** (same eligibility as the local-AI batch: only `untranslated`/`outdated` strings; Ctrl+A = whole mod). A save dialog picks the destination.
2. Tool writes a JSON batch file containing:
   - Instructions for Claude Code (translation rules, token preservation, expected reply format).
   - Glossary excerpt (only official terms that occur in the exported strings, capped; empty when no glossary is built).
   - Source strings, **grouped by i18n directory** (`files`) — multi-component mods can have several `i18n/` folders, so a flat key map is ambiguous.
3. User opens the batch file with Claude Code and runs the translation.

### Import

1. User imports the Claude Code result file via the toolbar button **"Import batch…"** (file picker; lenient JSON parsing tolerates LLM artifacts like trailing commas).
2. Tool matches keys per i18n directory against the current `default.json`.
3. Every accepted value is staged as **`review-needed`** in one atomic state write; the table reloads.
4. Strings that are now `translated` locally (including kept-originals) are **never overwritten** (stale-batch protection) — they are skipped and counted.
5. Validation runs on all imported strings; values that drop a protected token or are identical to the English source are imported anyway but flagged in the summary (never auto-rejected).
6. A file translated **in place** (still carrying the `…-claude-batch` format marker) is accepted like a result file.

### Export File Format

```json
{
  "format": "stardew-translator-claude-batch",
  "version": 1,
  "metadata": {
    "mod": "My Mod Name",
    "modUniqueId": "author.mymod",
    "sourceLang": "en",
    "targetLang": "de",
    "exportedAt": "2026-06-07T22:00:00Z"
  },
  "instructions": "Translate the Stardew Valley mod strings in `files` from English into German. ...",
  "glossary": {
    "Stardrop": "Sterntautropfen",
    "Junimo": "Junimo"
  },
  "files": {
    "i18n": {
      "greeting": "Hello {{PlayerName}}!",
      "item-desc": "A rare {{ItemName}} worth {{Price}}g."
    }
  }
}
```

### Import File Format

```json
{
  "format": "stardew-translator-claude-result",
  "version": 1,
  "files": {
    "i18n": {
      "greeting": "Hallo {{PlayerName}}!",
      "item-desc": "Ein seltenes {{ItemName}} im Wert von {{Price}}g."
    }
  }
}
```

---

## 12. Nexus Mods Strategy

### Situation

Stardew Valley mod translations **do exist on Nexus Mods** as separate mod pages — the same pattern used in the Skyrim modding community. A main mod (e.g., "Stardew Valley Expanded") may have independent translation mod pages (e.g., "SVE — German Translation") uploaded by community translators.

**What is confirmed:**

| Fact                                                                                | Status       |
| ----------------------------------------------------------------------------------- | ------------ |
| Translation mod pages exist as separate Nexus entries for Stardew mods              | ✅ Confirmed |
| The Nexus REST API v1 provides mod details by ID, file listings, and download links | ✅ Confirmed |
| API key validation works via `GET /v1/users/validate.json`                          | ✅ Confirmed |
| API daily rate limit is ~2,500 requests/day                                         | ✅ Confirmed |

**What is uncertain:**

| Question                                                                                       | Status                                                                  |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Does the Nexus API expose a machine-readable relationship from original mod → translation mod? | ❓ Not confirmed — likely no direct link field                          |
| Does the API expose language/locale metadata on mods or files?                                 | ❓ Not confirmed — no language field found in API docs                  |
| Does Stardew Valley's Nexus section have a dedicated "Translations" category?                  | ❓ Needs verification via `GET /v1/games/stardewvalley/categories.json` |
| Can the Nexus v2 GraphQL API provide better translation metadata?                              | ❓ Sparse public documentation, unknown                                 |

**What is known to NOT work:**

| Limitation                                          | Detail                                                                             |
| --------------------------------------------------- | ---------------------------------------------------------------------------------- |
| No direct "find translations of mod X" API endpoint | The API does not link translation mods to their parent mods                        |
| No "Translation" file category                      | File categories are: Main, Update, Optional, Old, Miscellaneous, Deleted, Archived |
| No language filter in search/listing endpoints      | Cannot filter mods by language via API                                             |

### v1 Scope — No API Calls

| Feature                                  | Detail                                                                                                                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Nexus ID detection**                   | Extract from `manifest.json` → `UpdateKeys` matching `Nexus:<id>`.                                                                                                                          |
| **Nexus ID display**                     | Show in mod list as clickable link: `https://www.nexusmods.com/stardewvalley/mods/<id>`                                                                                                     |
| **"Search Translation on Nexus" action** | Right-click a mod → opens the user's browser to `nexusmods.com/stardewvalley/mods/?search=<modname>+<target_language>`. No in-app results, no scraping — just a convenient browser handoff. |

v1 does **not** store or validate a Nexus API key. No Nexus API calls are made.

### v1.1 — API Key + Mod Enrichment

- Nexus API key storage and validation in settings.
- Mod info enrichment (name, endorsement count from API). Cached.

### v2 — Assisted Translation Discovery

Semi-automatic discovery using Nexus search heuristics and user confirmation:

1. **Candidate search:** Tool queries the Nexus API showing candidate translation mods found via title/description heuristics (language names, "translation", "Übersetzung", etc.) and category filtering.
2. **User confirmation:** User selects the correct translation mod. Tool stores the confirmed mapping (original Nexus ID → translation Nexus ID).
3. **File listing + import:** Tool lists files via API, user picks a file, tool downloads and imports with status `imported`.

### v3 — Streamlined Download & Import

Once a confirmed original→translation mapping exists:

1. **One-click update check:** Tool checks the mapped translation mod for new files.
2. **Automatic download + import:** If mapping is confirmed, one-click download and import.
3. **Mapping sharing:** Confirmed mappings exportable/importable for community use.

### Principles

- **No web scraping.** All Nexus interaction uses the official API or browser handoff.
- **User always confirms.** No automatic download without prior user-confirmed mapping.
- **Graceful degradation.** If the Nexus API lacks features, fall back to browser-assisted workflows.

---

## 13. Supported Files for v1

### In Scope

| File           | Location                  | Format                       |
| -------------- | ------------------------- | ---------------------------- |
| `default.json` | `<mod>/i18n/default.json` | Flat JSON key-value (source) |
| `<lang>.json`  | `<mod>/i18n/<lang>.json`  | Flat JSON key-value (target) |

This covers the standard SMAPI i18n system used by the vast majority of translatable mods, including Content Patcher content packs.

### Out of Scope (v1)

| File                             | Reason                                       |
| -------------------------------- | -------------------------------------------- |
| `content.json` (Content Patcher) | Complex token system, not a translation file |
| `Data/*.json` (mod data files)   | Arbitrary structure, no standard format      |
| `Dialogue/*.json`                | Game-specific format with control codes      |
| `*.xnb` files                    | Binary format, requires special tooling      |
| Non-`i18n/` JSON                 | Unbounded scope, no reliable detection       |

### Future Expansion Path

1. **v1:** `i18n/default.json` + `i18n/<lang>.json` only.
2. **v2:** Consider `content.json` string extraction for Content Patcher mods.
3. **v3:** Consider data file translation support with per-format parsers.

---

## 14. High-Level Data Model

```
AppState
├── settings
│   ├── stardewPath: string
│   ├── modsPath: string
│   ├── sourceLang: "default"              // fixed to English for v1
│   └── targetLang: string                 // e.g. "de", "fr", "es"
│
├── glossary (optional, may be null)
│   ├── languagePair: { source: "en", target: string }
│   ├── gameVersion: string                // game version at extraction time
│   ├── extractedAt: timestamp
│   └── terms: Map<string, string>         // "Stardrop" → "Sterntautropfen"
│
└── mods: List<Mod>
      ├── name: string
      ├── version: string
      ├── uniqueId: string
      ├── nexusId?: number                 // extracted from UpdateKeys; null for Nexus:-1 / non-positive
      ├── packageId: string                // top-level Mods subfolder; mods sharing it group under one tree node (§7.3)
      ├── folderPath: string
      ├── status: ModStatus               // aggregate, derived
      ├── progress: number                // 0.0–1.0, derived
      │
      └── files: List<TranslationFile>
            ├── relativePath: string       // e.g. "i18n/default.json"
            ├── targetPath: string         // e.g. "i18n/de.json"
            ├── status: FileStatus         // aggregate, derived
            ├── progress: number           // derived
            │
            └── strings: List<TranslationString>
                  ├── key: string
                  ├── sourceText: string
                  ├── targetText: string
                  ├── status: StringStatus
                  ├── sourceTextAtTranslation?: string   // snapshot for outdated detection
                  ├── sourceHash?: string                // SHA-256 of sourceTextAtTranslation
                  ├── tokens: string[]                   // extracted {{...}} tokens
                  └── validationIssues: List<ValidationIssue>
                        ├── ruleId: string
                        ├── severity: "error" | "warning"
                        └── message: string
```

### Persistence

| Data              | Storage              | Format                            |
| ----------------- | -------------------- | --------------------------------- |
| Settings          | App data directory   | JSON config file                  |
| Glossary cache    | App data directory   | JSON per language pair (nullable) |
| Translation state | App data directory   | JSON per mod (keyed by UniqueID)  |
| Export output     | Mod's `i18n/` folder | Standard `<lang>.json`            |

Translation state is stored **separately** from the mod's actual files. The export step writes the final `i18n/<lang>.json` to the mod folder. This means:

- The tool never modifies `default.json`.
- Work-in-progress translations are safe even if the mod updates.
- Export is an explicit user action.

---

## 15. v1 Features

### v1 Scope (Milestones 1–3)

Core workflow — no AI, no Nexus API:

- [ ] Auto-detect Stardew Valley installation
- [ ] Manual path override for game and Mods folder
- [ ] Source/target language selection
- [ ] Optional game glossary extraction from `Content (unpacked)/`
- [ ] Glossary caching and rebuild
- [ ] Recursive mod scanning via `manifest.json`
- [ ] Nexus ID extraction from `UpdateKeys`
- [ ] `i18n/default.json` parsing (flat key-value JSON)
- [ ] Existing translation import (`i18n/<lang>.json`)
- [ ] Mod list **tree** grouped by package/download folder (multi-component mods expand to components; single-component mods render flat) with Status | Mod | Version | Nexus | Dateien | Fortschritt
- [ ] String table with Key | Original | Target Text | Validation
- [ ] String editor dialog (double-click)
- [ ] Status model: 4 statuses with color coding (`untranslated`, `translated`, `outdated`, `review-needed`)
- [ ] `outdated` detection via `sourceHash` / `sourceTextAtTranslation`
- [ ] Token validation (`token-missing`, `token-added`)
- [ ] Empty target validation (`empty-target`)
- [ ] JSON safety validation (`json-invalid`)
- [ ] Right-click context menu with bulk actions
- [ ] Multi-select (Ctrl+Click, Shift+Click)
- [ ] Export clean `i18n/<lang>.json` files
- [ ] Export warns on missing translations, blocks only on token errors
- [ ] Backup existing target file before overwrite
- [ ] Search and filter (by text, by status)
- [ ] Keyboard shortcuts in string editor
- [ ] Nexus ID displayed as clickable link
- [ ] "Search Translation on Nexus" browser action
- [ ] Progress bar per mod

### v1 Milestone 4 (Claude-Code Batch)

First AI step — requires core workflow to be complete:

- [ ] Claude-Code batch export (JSON file with instructions + glossary)
- [ ] Claude-Code batch import (result JSON → target text)
- [ ] Imported results get status `review-needed`
- [ ] Post-import validation runs

### Deferred to v1.1+

| Feature                                     | Target |
| ------------------------------------------- | ------ |
| In-app AI translation (API calls from tool) | v1.1   |
| AI Translate button in String Editor        | v1.1   |
| Batch in-app AI from context menu / toolbar | v1.1   |
| Nexus API key storage and validation        | v1.1   |
| Nexus mod info enrichment                   | v1.1   |
| `glossary-deviation` validation             | v1.1   |
| `token-case-changed` validation             | v1.1   |
| `newline-mismatch` validation               | v1.1   |
| `bracket-token-missing` validation          | v1.1   |
| `identical-to-source` validation            | v1.1   |
| `escape-suspicious` validation              | v1.1   |
| `extra-key` validation                      | v1.1   |
| Inline cell editing in string table         | v1.1   |
| Drag-and-drop import                        | v1.1   |
| Finalize-and-propagate identical strings    | v2     |
| Assisted Nexus translation discovery        | v2     |
| Nexus translation download + import         | v2     |
| Dark mode / light mode toggle               | v1.1   |

---

## 16. Non-Goals for v1

The following are **explicitly excluded** from v1:

| Feature                                        | Reason                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------ |
| In-app AI translation (API calls)              | Deferred to v1.1 — v1 uses Claude-Code batch only                        |
| Nexus API key / API calls                      | v1 uses only Nexus ID from manifest + clickable links                    |
| Automatic Nexus translation discovery/download | Deferred to v2 (see §12)                                                 |
| Git integration                                | Adds complexity without core workflow value                              |
| Full mod manager                               | Out of scope — tool manages translations only                            |
| Vortex/MO2 profile detection                   | User can point to any folder manually                                    |
| Publishing/uploading translations              | Out of scope                                                             |
| Complex glossary editor                        | v1 auto-generates glossary; no manual editing UI                         |
| Cloud sync                                     | Local-first tool                                                         |
| Translation memory (cross-mod)                 | v2+                                                                      |
| Multiple simultaneous target languages         | v1 works with one target language at a time                              |
| Dashboard / studio UI                          | Compact tables only                                                      |
| Card-based mod manager                         | SSE-AT style tables only                                                 |
| Kanban board                                   | Not a project management tool                                            |
| Analytics screen                               | Progress bar is sufficient                                               |
| Plugin/provider abstraction                    | v1 hardcodes; abstract later                                             |
| Complex navigation system                      | Two-panel layout + dialogs only                                          |
| `content.json` parsing                         | i18n files only in v1                                                    |
| `Data/*.json` mod file translation             | i18n files only in v1                                                    |
| In-app XNB decoder                             | Deferred to future version                                               |
| Multiple settings screens                      | One settings section accessible from toolbar                             |
| More than 4 status values                      | Intentionally capped (v1)                                                |
| Project save/load system                       | State persisted automatically, no project files                          |
| Quality/style validation rules                 | v1 validates only safety (tokens, JSON). Quality rules deferred to v1.1. |

---

## 17. Milestones

### Milestone 0 — Tech Stack Decision

> [!IMPORTANT]
> **No code is written before the tech stack is decided.** Milestone 0 produces a decision document, not a running application.

**Deliverable:** A short ADR (Architecture Decision Record) selecting the tech stack.

**Candidates:**

| Option               | Backend | Frontend                   | Pros                                                                                                       | Cons                                                            |
| -------------------- | ------- | -------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| **Tauri**            | Rust    | HTML/CSS/JS (or framework) | Small binary, fast, native file access, strong Rust ecosystem for JSON/XNB parsing. Old project used this. | Rust learning curve, smaller ecosystem for desktop UI patterns. |
| **Electron**         | Node.js | HTML/CSS/JS (or framework) | Large ecosystem, many examples, fast prototyping.                                                          | Large binary, higher memory usage.                              |
| **Python + PySide6** | Python  | Qt6                        | SSE-AT uses this. Proven for similar tools.                                                                | Python distribution complexity, slower for large datasets.      |

**Evaluation criteria:**

1. Developer familiarity and velocity.
2. Desktop distribution (single binary? installer?).
3. File system access performance (scanning 200+ mod folders).
4. Table rendering performance (5000+ rows).
5. Ecosystem maturity for the required UI patterns (tables, dialogs, context menus).

**Gate:** Milestones 1–4 structure may adjust slightly based on the chosen stack (e.g., Rust vs. TypeScript build steps), but the feature scope remains fixed.

---

### Milestone 1 — Setup + Mod Scan + Import

**Goal:** User can configure paths, scan mods, and see the mod list with imported translations.

**Scope:**

- Project initialization with chosen tech stack
- App window with toolbar and two-panel layout (string table empty)
- Setup wizard (Steps 1–4: game path, mods path, languages, optional glossary)
- Settings persistence (JSON config)
- Stardew Valley auto-detection (Steam/GOG paths)
- Manual folder override
- Language selection
- Glossary extraction from `Content (unpacked)/` (skippable, non-blocking)
- Glossary caching
- `manifest.json` parser (Name, Version, UniqueID, UpdateKeys)
- Nexus ID extraction from UpdateKeys
- Recursive mod folder scanner
- `i18n/default.json` parser (flat JSON, BOM handling, comment tolerance)
- Existing `i18n/<lang>.json` import
- Mod list table (Status | Mod | Version | Nexus | Dateien | Fortschritt)
- Scan dialog with progress
- Progress calculation per mod/file
- Initial status assignment (untranslated, imported, gray)
- Edge case handling (empty mods, malformed JSON, nested mods)
- Nexus ID as clickable link

**Acceptance Criteria:**

- [ ] App launches and shows main window with toolbar and two-panel layout.
- [ ] Setup wizard opens on first launch with 4 steps (game path, mods path, language, glossary).
- [ ] Glossary step can be skipped; tool continues without glossary.
- [ ] Auto-detection finds Stardew Valley on Steam installations.
- [ ] User can browse to game folder and mods folder manually.
- [ ] Mod scanner finds all mods with `manifest.json` in a standard Mods folder.
- [ ] Scanner correctly handles nested mods, multiple `i18n/` folders, empty mods.
- [ ] Malformed manifests or JSON files do not crash the scanner.
- [ ] Existing target-language files are imported with status `imported`.
- [ ] Mod list shows correct columns with progress bars.
- [ ] Nexus IDs are displayed as clickable links.
- [ ] All settings persist across restarts.
- [ ] Scan completes in <30s for 200 mods.

---

### Milestone 2 — String Table + Editor + Validation

**Goal:** User can browse, edit, and validate strings.

**Scope:**

- String table (Key | Original | Target Text | Validation)
- String editor dialog (full layout per §7.5)
- Token extraction (`{{...}}`)
- v1 validation engine (4 rules: `token-missing`, `token-added`, `empty-target`, `json-invalid`)
- Live validation in editor (debounced ~300ms)
- Glossary hint display in editor (if glossary available, otherwise hidden)
- Status transitions (§9)
- `outdated` detection via `sourceHash` comparison on re-scan
- `sourceTextAtTranslation` snapshot on save
- Save/cancel workflow
- Previous/next navigation in editor
- Keyboard shortcuts
- Multi-select (Ctrl+Click, Shift+Click, Ctrl+A)
- Right-click context menu (v1 actions from §7.6)
- Search bar and status filter
- Sorting by column
- "Search Translation on Nexus" browser action (context menu)

**Acceptance Criteria:**

- [ ] Selecting a mod shows its strings in the string table.
- [ ] String table displays Key | Original | Target Text | Validation.
- [ ] Double-clicking opens the String Editor with correct data.
- [ ] Source text is read-only; target text is editable.
- [ ] Validation runs live as user types.
- [ ] `token-missing` error is raised when `{{...}}` token is removed from target.
- [ ] `json-invalid` error is raised for values that cannot be serialized to valid JSON (e.g. an invalid Unicode surrogate); normal quotes/backslashes are escaped by the serializer and do not trip it.
- [ ] `empty-target` warning is raised for empty target values.
- [ ] Status transitions work correctly.
- [ ] Saving a string sets `sourceTextAtTranslation` and `sourceHash`.
- [ ] Re-scanning after a mod update sets changed strings to `outdated`.
- [ ] Multi-select works with Ctrl+Click and Shift+Click.
- [ ] Right-click context menu shows all v1 actions.
- [ ] Search filters strings by text.
- [ ] Status filter shows only strings of selected status.
- [ ] All keyboard shortcuts work.
- [ ] Previous/Next navigation works.

---

### Milestone 3 — Export

**Goal:** User can export clean translation files.

**Scope:**

- Export `i18n/<lang>.json` per mod
- Preserve key order from `default.json`
- UTF-8 without BOM
- 2-space indentation
- Backup existing file before overwrite (`.bak`)
- Export selected mod / all mods
- Export validation gate:
  - **Error-level issues** (`token-missing`, `json-invalid`): affected strings are **skipped** from export. All other strings export normally.
  - **Warning-level issues** (`empty-target`, `token-added`): export continues, shown in summary.
  - **Untranslated strings**: omitted from export (SMAPI falls back to `default.json`). Shown in summary.
- Export summary dialog showing: exported count, skipped count (with reasons), warnings.
- Overwrite confirmation dialog.

**Acceptance Criteria:**

- [ ] Export produces valid `i18n/<lang>.json` files.
- [ ] Exported JSON uses 2-space indentation and UTF-8 without BOM.
- [ ] Key order in exported file matches `default.json`.
- [ ] Backup `.bak` file is created before overwriting.
- [ ] Strings with `token-missing` errors are skipped; all other strings export.
- [ ] Untranslated strings are omitted, not blocking.
- [ ] Export summary shows what was exported, skipped, and warned.
- [ ] Export selected mod works.
- [ ] Export all mods works.
- [ ] Exported file is loadable by SMAPI without errors.

---

### Milestone 4 — Claude-Code Batch

**Goal:** User can export strings for Claude-Code translation and import results.

**Prerequisite:** Milestones 1–3 complete. Core workflow works end-to-end.

**Scope:**

- Claude-Code batch export (JSON format per §11)
- "Export for Claude-Code" added to context menu
- Claude-Code batch import (toolbar button)
- Imported results → status `review-needed`
- Post-import validation
- Glossary excerpt included in export (if glossary available)

**Acceptance Criteria:**

- [ ] Claude-Code batch export produces a valid JSON file with instructions.
- [ ] Export includes glossary terms (if available) and token lists.
- [ ] Claude-Code batch import reads result JSON and fills target text.
- [ ] All imported strings get status `review-needed`.
- [ ] Validation runs on all imported strings.
- [ ] Strings with validation errors are flagged but not rejected.
- [ ] Import does not overwrite strings with status `done` unless user confirms.

---

### Milestone 6 — Local-LLM Translation (Ollama / LM Studio)

**Goal:** User can translate strings in-app, fully offline, against a locally running model server.

**Prerequisite:** Milestones 1–3 complete (a working glossary makes local-AI pre-translation worthwhile). Reprioritized ahead of M4/M5 at the user's request. See [docs/milestones/m6-local-llm-translation.md](docs/milestones/m6-local-llm-translation.md) for the full breakdown.

**Scope:**

- One OpenAI-compatible HTTP client (`POST /v1/chat/completions`, `GET /v1/models`) covering Ollama, LM Studio, and any compatible endpoint. **No provider plugin system** (§19 #6) — URL/port presets + a custom URL only.
- Connection settings: provider preset, base URL, model (discovered from `/v1/models`), "Test connection", optional temperature (empty = 0.2 default).
- Translate-one-string command (MVP): prompt = system rules + injected glossary subset + source; low temperature; result validated through `tokens.rs`, one stricter retry on dropped tokens, then flagged.
- Glossary injection (prompt-level) + soft validation: an inflection-tolerant check whether injected terms were used, surfaced as a hint (editor message / batch summary count), never an error. Degrades to no-injection when no glossary is built (§19 #8).
- Local-AI output → status `review-needed` (same as M4 imports; §19 #2).
- Batch translation of the selection (Ctrl+A = whole mod) via the context menu: only `untranslated`/`outdated` strings, serial requests, progress dialog with cancel (finishes the in-flight string), each result saved immediately — resume-friendly by construction.

**Acceptance Criteria:**

- [ ] Settings store provider preset + base URL + model; "Test connection" reports reachability and the answering model.
- [ ] A single string can be translated via the local server and lands in the editor as `review-needed`.
- [ ] Relevant glossary terms are injected; translation still works with no glossary built.
- [ ] Results run through the protected-token validator; dropped tokens trigger one retry, then a visible flag (never silent corruption).
- [ ] Server-down / no-model-loaded produces a clear, non-crashing error.
- [ ] Prompt-building, glossary-injection, and token-retry logic are unit-tested with the HTTP layer mocked (no live model in CI).
- [ ] Fully offline: localhost only, no API key (§19 #7).

---

## 18. Technical Risks

| Risk                                    | Impact                                                               | Mitigation                                                                                                                                              |
| --------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`Content (unpacked)/` not available** | Glossary cannot be built.                                            | Glossary is optional. Tool works fully without it. Show guidance if user wants glossary.                                                                |
| **Game content format changes**         | 1.6 changed data file structure. Future updates may break extractor. | Isolate extraction logic. Version-check game files. Fail gracefully to no glossary.                                                                     |
| **Large mod collections**               | 200+ mods with 10,000+ strings may cause UI lag.                     | Virtualized/paginated table rendering. Lazy loading of string data.                                                                                     |
| **Non-standard mod JSON**               | Comments, BOM, trailing commas.                                      | Lenient JSON parser. BOM stripping. Log warnings for non-standard files. Skip truly broken files.                                                       |
| **Technology stack lock-in**            | Wrong framework choice could limit future development.               | Milestone 0 is a dedicated decision gate. Evaluate before coding.                                                                                       |
| **Token false positives**               | `{{...}}` regex may match non-token content.                         | Token validation compares source vs target sets. False positives on both sides cancel out. Manual override via "Keep original" (identical translation). |
| **Export key order**                    | JSON libraries may not preserve insertion order.                     | Use ordered map / manual serialization. Test with real mod files.                                                                                       |
| **Local-LLM quality (M6)**              | Small local models hallucinate and drop protected tokens.            | Token validation + one stricter retry; output is always `review-needed`, never auto-`translated`. Glossary injected as guidance, not hard substitution. |

---

## 19. Recommendations to Prevent Feature Bloat

1. **The SSE-AT test.** Before adding a UI element, ask: "Would SSE Auto Translator have this?" If no, it probably doesn't belong in v1.

2. **The status rule.** v1.5 has exactly 4 statuses (`untranslated`, `translated`, `outdated`, `review-needed`). Do not add more. v1's fifth status (`not-translatable`) was **removed**, not just renamed — "keep it English" became the "Keep original" _action_ that stores an identical translation — one fewer status to scan for, and full `outdated` coverage. `review-needed` exists only for the **AI translation workflows** — the M6 local-LLM engine and the M4 Claude-Code batch — where machine output genuinely needs a review pass. It is never set by hand and never reached by normal editing (an explicit Save confirms it to `translated`).

3. **The 5-validation-rule rule.** v1 has exactly 5 validation rules (§10; `newline-mismatch` was pulled forward because treating `\n` as a hard token error blocked valid translations). Adding a rule requires justifying why it prevents broken mods, not just improves quality.

4. **File scope lock.** v1 handles `i18n/default.json` and `i18n/<lang>.json`. Period. Supporting additional file types requires a scope change approval.

5. **UI complexity ceiling.** The main window has exactly 2 panels + toolbar. No tabs, no sidebar, no bottom panel, no floating windows (except the String Editor dialog and modal dialogs).

6. **No premature abstraction.** Do not build a provider plugin system, parser plugin system, or exporter plugin system. Hardcode for v1.

7. **No API keys in v1.** Neither Nexus nor AI API keys are required. The tool must work fully offline (except for the optional browser-open action).

8. **Glossary is always optional.** No feature may require the glossary to function. Glossary-dependent features degrade to "no hints" mode.

9. **Core before convenience.** Milestones 1–3 must be complete and stable before Milestone 4 (Claude-Code) begins.

10. **The "later" list is permission to say no.** When a good idea comes up that doesn't fit v1, add it to §15 "Deferred to v1.1+" with a target version.

---

## 20. Confirmed Facts vs Assumptions vs Open Research Questions

### ✅ Confirmed Facts

| Fact                                                                                                                          | Source                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| SMAPI mods use `i18n/default.json` as the English source and `i18n/<lang>.json` for translations.                             | [SMAPI Wiki — Translation API](https://stardewvalleywiki.com/Modding:Modder_Guide/APIs/Translation)             |
| i18n files are flat JSON key-value objects. No nesting.                                                                       | SMAPI Wiki                                                                                                      |
| SMAPI supports 12 languages: de, es, fr, hu, it, ja, ko, pt, ru, tr, zh + default (English).                                  | SMAPI Wiki                                                                                                      |
| `default.json` is always the English fallback.                                                                                | SMAPI Wiki                                                                                                      |
| SMAPI fallback order: `pt-BR.json` → `pt.json` → `default.json`.                                                              | SMAPI Wiki                                                                                                      |
| `manifest.json` requires: Name, Author, Version, Description, UniqueID.                                                       | [SMAPI Wiki — Manifest](https://stardewvalleywiki.com/Modding:Modder_Guide/APIs/Manifest)                       |
| `UpdateKeys` format is `Site:ID`, e.g., `Nexus:1234`, `GitHub:Owner/Repo`.                                                    | SMAPI Wiki — Manifest                                                                                           |
| SMAPI tokens use `{{tokenName}}` syntax (double curly braces).                                                                | SMAPI Wiki — Translation API                                                                                    |
| Content Patcher mods use the same `i18n/` system and reference strings via `{{i18n:key}}`.                                    | [Content Patcher docs](https://stardewvalleywiki.com/Modding:Content_Patcher)                                   |
| Game content locale suffixes use `xx-XX` format (e.g., `.de-DE`), different from SMAPI's short codes.                         | SMAPI Wiki                                                                                                      |
| Stardew 1.6 uses `[LocalizedText Strings\<file>:<key>]` token indirection for display names.                                  | Community documentation, old project research                                                                   |
| `Content (unpacked)/` is created by SMAPI on first run and contains JSON versions of game data.                               | Community documentation                                                                                         |
| Stardew mod translations exist on Nexus as separate mod pages (same pattern as Skyrim translations).                          | Nexus Mods website, community practice                                                                          |
| Nexus Mods REST API v1 has no endpoint to query "translations of mod X" or expose language metadata.                          | [Nexus API Swagger](https://app.swaggerhub.com/apis-docs/NexusMods/nexus-mods_public_api_params_in_headers/1.0) |
| Nexus API file categories are: Main, Update, Optional, Old, Miscellaneous, Deleted, Archived. No "Translation" file category. | Nexus API documentation                                                                                         |
| Nexus API validates keys via `GET /v1/users/validate.json`.                                                                   | Nexus API documentation                                                                                         |
| Nexus API daily limit is ~2,500 requests/day.                                                                                 | Nexus API documentation                                                                                         |
| SSE Auto Translator uses a Scan → Import → Translate → Review → Export workflow.                                              | [SSE-AT GitHub](https://github.com/Cutleast/SSE-Auto-Translator)                                                |
| SSE-AT uses PySide6 (Qt) with dark theme, compact tables, and a string editor dialog.                                         | SSE-AT source code                                                                                              |
| SSE-AT uses color-coded status: Red (needs translation), Yellow (partial), Green (complete), Blue (imported).                 | SSE-AT source code                                                                                              |

### ⚠️ Assumptions (Reasonable, Low Risk)

| Assumption                                                                | Basis                                                                                              | Risk                                                |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `default.json` is always English.                                         | Universal convention. SMAPI docs say "default" is the fallback but don't strictly require English. | Very low. No known mod uses a non-English default.  |
| `Content (unpacked)/` will exist for most users.                          | SMAPI creates it on first game run. Most modded Stardew players use SMAPI.                         | Low. Tool works without it (glossary optional).     |
| Unpacked content files are valid JSON readable without special libraries. | Community reports.                                                                                 | Low. Test with actual game files in Milestone 1.    |
| Game data file format is stable within Stardew 1.6.x minor versions.      | ConcernedApe's update patterns.                                                                    | Medium. Major updates (1.7?) could change format.   |
| `pt-BR.json` and `pt.json` are both used in the wild.                     | SMAPI supports both with fallback.                                                                 | Low. Tool should handle both.                       |
| All i18n files use UTF-8 encoding.                                        | SMAPI requirement.                                                                                 | Very low. Defensive encoding detection as fallback. |
| Nexus Mods game domain for Stardew Valley is `stardewvalley`.             | Standard domain format.                                                                            | Very low.                                           |

### ❓ Open Research Questions

| Question                                                                                                   | Impact on v1                                          | Proposed Resolution                                                                          |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **Does Stardew Valley's Nexus section have a "Translations" mod category?**                                | Affects v2 assisted translation discovery heuristics. | Check `GET /v1/games/stardewvalley/categories.json` during Milestone 1. Not blocking for v1. |
| **How prevalent are `{{Gender:male\|female}}` switch tokens in mods?**                                     | May need special validation in v1.1.                  | Survey 10–20 popular mods during Milestone 1. If rare, treat as regular `{{...}}` token.     |
| **Are there mods using language-subfolder mode (`i18n/de/dialogue.json`) instead of flat `i18n/de.json`?** | Affects scanner scope.                                | Survey mods during Milestone 1. If very rare, defer support.                                 |
| **What is the exact format of unpacked `Data/Objects.json` in Stardew 1.6?**                               | Affects glossary extraction parsing.                  | Read actual file from test installation during Milestone 1.                                  |
| **Does the Nexus v2 GraphQL API expose translation metadata?**                                             | Affects long-term Nexus strategy.                     | Monitor. Not blocking for v1.                                                                |
| **How does `Data/AdditionalLanguages` work for custom game languages?**                                    | May need to support non-standard language codes.      | Out of scope for v1. Standard 12 languages only.                                             |

---

## Appendix A — Stardew Language Code Reference

| SMAPI i18n | Game Locale | Language               | i18n Filename            |
| ---------- | ----------- | ---------------------- | ------------------------ |
| `default`  | _(base)_    | English                | `default.json`           |
| `de`       | `de-DE`     | German (Deutsch)       | `de.json`                |
| `es`       | `es-ES`     | Spanish (Español)      | `es.json`                |
| `fr`       | `fr-FR`     | French (Français)      | `fr.json`                |
| `hu`       | `hu-HU`     | Hungarian (Magyar)     | `hu.json`                |
| `it`       | `it-IT`     | Italian (Italiano)     | `it.json`                |
| `ja`       | `ja-JP`     | Japanese (日本語)      | `ja.json`                |
| `ko`       | `ko-KR`     | Korean (한국어)        | `ko.json`                |
| `pt`       | `pt-BR`     | Portuguese (Português) | `pt.json` / `pt-BR.json` |
| `ru`       | `ru-RU`     | Russian (Русский)      | `ru.json`                |
| `tr`       | `tr-TR`     | Turkish (Türkçe)       | `tr.json`                |
| `zh`       | `zh-CN`     | Chinese (中文)         | `zh.json`                |

---

## Appendix B — Glossary Term-Bearing Assets (Stardew 1.6)

| Asset Path                   | Content                                                  | Priority |
| ---------------------------- | -------------------------------------------------------- | -------- |
| `Data/Objects`               | All items (objects, crops, fish, minerals, cooked items) | High     |
| `Data/BigCraftables`         | Craftable machines and decorations                       | High     |
| `Data/Characters`            | NPC display names                                        | High     |
| `Strings/StringsFromCSFiles` | Seasons, days, common UI, location names                 | High     |
| `Strings/Objects`            | Resolved item display names                              | High     |
| `Data/Weapons`               | Swords, daggers, clubs                                   | Medium   |
| `Data/Tools`                 | Axe, Pickaxe, Hoe, etc.                                  | Medium   |
| `Strings/Characters`         | Resolved character strings                               | Medium   |
| `Strings/UI`                 | Menu/UI strings                                          | Medium   |
| `Data/Boots`                 | Footwear items                                           | Low      |
| `Data/Hats`                  | Hat items                                                | Low      |
| `Data/Furniture`             | Furniture items                                          | Low      |

---

## Appendix C — Lessons Learned from Old Project

The old Stardew Translator project (`E:\DevProjects\Stardew Translator`) provided the following lessons:

1. **Scope creep was the #1 problem.** Features accumulated faster than they were implemented. The roadmap grew to 6 phases with 6+ milestones before a working product existed.

2. **Start with i18n only.** Attempting to handle `content.json`, dialogue files, event scripts, and other JSON formats exploded the parser and validator complexity.

3. **Flat JSON only for v1.** Nested JSON parsing added significant complexity with no user-facing benefit for standard SMAPI i18n files.

4. **The old project's validation rules and token regex are reusable.** `\{\{([^}]+)\}\}` for SMAPI tokens. Compare token sets between source and target.

5. **The glossary seeding research is well-documented and directly applicable.** Key insight: use `Content (unpacked)/` with `[LocalizedText]` resolution for 1.6. Avoid XNB parsing in v1.

6. **The old project's edge case documentation is valuable.** BOM handling, comments in JSON, empty `default.json`, nested mods, multiple `i18n/` folders — all documented and should be handled.

7. **The old project's architecture was over-abstracted for the actual feature set.** v1 should be simpler: no plugin system, no provider abstraction, no complex storage engine.

8. **Test fixtures from the old project can be reused.** Located at `E:\DevProjects\Stardew Translator\tests\fixtures\parser\`.

9. **Key order matters for export.** Exported JSON should match `default.json` key order for readability and diff-friendliness.

10. **AI translation quality is "good enough for first pass" but always needs review.** The `review-needed` workflow is validated.

---

## Appendix D — Version Roadmap Summary

| Version        | Scope                                                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **v1 (M1–M3)** | Setup, Mod Scan, i18n Import, String Table, String Editor, Basic Validation (4 rules), Export                              |
| **v1 (M4)**    | Claude-Code Batch Export/Import                                                                                            |
| **v1.1**       | In-app AI translation, Nexus API key + mod enrichment, extended validation rules (11 rules), inline editing, drag-and-drop |
| **v2**         | Assisted Nexus translation discovery, Content Patcher `content.json` support, translation memory, finalize-and-propagate   |
| **v3**         | Streamlined Nexus download/import, data file translation, in-app XNB reader                                                |
