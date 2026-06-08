# Nexus Mods & Translation-Mod Automation — Feasibility Research

> **Status:** Research complete (Milestone 0).
> **Purpose:** Determine whether SSE Auto Translator-style translation-mod discovery/download/import is feasible for Stardew Valley, and ensure the v1 design does **not** block future automation. This research does **not** expand v1 scope.
> **Related:** [SPEC.md §12 — Nexus Mods Strategy](../../SPEC.md), [stardew-smapi-i18n.md](stardew-smapi-i18n.md)

---

## 1. What SSE Auto Translator (SSE-AT) actually does

SSE-AT ([Cutleast/SSE-Auto-Translator](https://github.com/Cutleast/SSE-Auto-Translator)) automates translation of an entire Skyrim Special Edition modlist. Confirmed mechanics:

| Mechanism | Detail |
|-----------|--------|
| **Mod-page translation listing** | For each installed mod, SSE-AT finds translations that are uploaded as **separate Nexus mod pages** and **linked on the original mod page**. Nexus has no API field for this relationship, so tools must **parse/scrape the mod page** to read its "Translations" listing. |
| **Community masterlist** | Translations that are *not* linked on the original page cannot be found automatically. SSE-AT relies on volunteer-maintained **masterlists** — curated JSON files mapping an original mod to its translation mod(s). This is the fallback for unlinked translations. |
| **String database** | A combined database of vanilla + already-installed translated strings. For mods whose strings are fully covered by this corpus, SSE-AT can auto-generate a translation with no standalone translation mod at all. |
| **Nexus API key** | Required for all API access (mod metadata, file lists, download links). |
| **Premium for direct download** | The Nexus `download_link` endpoint returns a direct URL **only for Premium users**. Non-Premium users get a `403` ("…this is for premium users only") and must initiate the download from the website via an `nxm://` handoff. |
| **User confirmation** | The user reviews and selects translations; the process is semi-automatic, not silent. |
| **Output format** | Converts everything into **DSD (Dynamic String Distributor)** format and bundles a single "Output Mod" at the end of the load order. |

**Workflow:** Scan modlist → look up translations (mod-page listing + masterlist + string DB) → user confirms → download (API/Premium or `nxm://` handoff) → convert to DSD → install output mod.

Sources: [SSE-AT GitHub](https://github.com/Cutleast/SSE-Auto-Translator), [Nexus API docs](https://api-docs.nexusmods.com/), Nexus forum feature requests for translation/localization metadata ([1](https://forums.nexusmods.com/topic/13524619-add-translations-to-the-nexus-mods-api-v2-graphql-endpoint/), [2](https://forums.nexusmods.com/topic/13533111-feature-request-add-localizations-field-to-mod-api-response)).

---

## 2. What can be reused conceptually for Stardew

- **Overall pipeline shape:** Scan → discover candidate translations → user confirms → download → import. This is generic and maps cleanly onto Stardew.
- **Separate-mod-page pattern:** Stardew translations also exist as **independent Nexus mod pages** uploaded by community translators (same social pattern as Skyrim). Confirmed.
- **Confirmed-mapping store:** `originalModNexusId → translationModNexusId`. This is the single most reusable idea — it sidesteps the unreliable "auto-find" problem by persisting a user-confirmed mapping once, then reusing it.
- **Masterlist concept:** A shareable, community-curated mapping file is the realistic substitute for the missing API relationship. Optional, additive.
- **User-confirmation-first principle:** Never download silently; always let the user pick the correct translation mod.

---

## 3. What cannot (and should not) be reused

These are Skyrim/SSE-specific and have no Stardew analog — do not copy:

- **DSD / Dynamic String Distributor** output format. Stardew uses plain `i18n/<lang>.json`; no equivalent injection layer is needed.
- **ESP/ESM plugin string tables, BSA/BA2 archives, load order, "Output Mod at end of list."** Stardew has no plugin string tables and no load-order-based string injection.
- **MO2/Vortex modlist integration.** Out of scope for this project by hard requirement — Stardew uses a flat `Mods/` folder.
- **Vanilla string-coverage auto-translation at SSE scale.** Skyrim shares a massive vanilla string corpus across mods; Stardew mod `i18n` keys are mostly mod-specific, so the "fully covered by vanilla" trick yields little. (A weak analog — cross-mod *translation memory* — is a possible far-future feature, not v1–v3 core.)

---

## 4. What is technically possible for Stardew

| Capability | Feasible? | How |
|-----------|-----------|-----|
| Detect a mod's Nexus ID | ✅ Reliable, offline | Parse `manifest.json` → `UpdateKeys` → `Nexus:<id>`. No API. |
| Open the mod / a search on Nexus in a browser | ✅ Reliable, offline | Construct a URL and hand off to the OS browser. |
| Validate a Nexus API key | ✅ With key | `GET /v1/users/validate.json`. |
| Enrich mod info (name, endorsements, etc.) | ✅ With key | `GET /v1/games/stardewvalley/mods/<id>.json`. |
| **Auto-discover "the German translation of mod X" purely via API** | ❌ Not reliable | The Nexus API (v1 REST and v2 GraphQL) exposes **no** translation relationship and **no** language/locale metadata on mods or files. Confirmed by current feature requests asking Nexus to add it. The only API-based discovery is **keyword search** over titles/descriptions (e.g. `<modname> + "Deutsch"/"German"/"DE"`), which is heuristic and noisy. |
| Discover via mod-page "Translations" listing | ⚠️ Possible but scraping | Nexus mod pages can list translations, but reading them requires HTML scraping. This project's principle is **no scraping by default**. |
| Persist a user-confirmed `original → translation` mapping | ✅ Reliable | Store locally after the user confirms once. |
| List files of a confirmed translation mod | ✅ With key | `GET /v1/games/stardewvalley/mods/<id>/files.json`. |
| Direct one-click download of a translation file | ⚠️ Conditional | `download_link` endpoint requires **Nexus Premium**. Non-Premium must use the `nxm://` / website handoff. |
| Import `i18n/<lang>.json` from a downloaded translation mod | ✅ Reliable | Stardew translation mods typically ship `i18n/<lang>.json` directly; these fit the existing data model. |

**Key finding:** Pure-API automatic discovery is **not reliable** for Stardew (no relationship/language metadata). Reliable automation requires a **user-confirmed mapping** (and optionally a community masterlist). The SPEC's existing v2 wording that implies "category filtering" finds translations is over-optimistic — Stardew's Nexus section has no "Translation" mod/file category and no language filter. Discovery realistically = heuristic search + human confirmation.

---

## 5. Stardew-specific translation-mod patterns

- **Existence:** Popular Stardew mods (e.g. large content packs) commonly have separate community translation pages on Nexus. Confirmed pattern; prevalence varies by mod popularity (long tail has none).
- **Naming:** Highly inconsistent — `"<Mod> German Translation"`, `"<Mod> - Deutsch"`, `"<Mod> DE"`, `"<Mod> 简体中文"`, or just the language name. No enforced convention → keyword search is fuzzy.
- **Original reference:** Translation pages usually reference the original mod in the **title and/or description**, and sometimes in **Nexus "Requirements"**. None of these are exposed as a clean machine-readable original-ID field in the API.
- **File contents:** Downloaded Stardew translation mods generally contain `i18n/<lang>.json` (sometimes a full mod folder with `manifest.json` + `i18n/`). These import cleanly into the proposed `TranslationFile`/`TranslationString` model. Imported strings should be marked `imported` (review-needed semantics), and any source keys missing from the imported file remain `untranslated`.

---

## 6. What is reliable enough for v1

Only fully-offline, no-API capabilities:

- Nexus ID detection from `UpdateKeys`.
- Nexus ID shown as a clickable mod-page link.
- "Search Translation on Nexus" → browser handoff to a pre-filled search URL.

No API key, no scraping, no downloads. **This matches the current SPEC §12 v1 scope and should not change.**

---

## 7. Staged automation roadmap (does not change v1)

| Stage | Capability | Dependency / Risk |
|-------|-----------|-------------------|
| **v1** | Nexus ID detection · clickable link · browser-assisted search | None. Offline. |
| **v1.1** | Optional Nexus API key · key validation · optional mod-info enrichment | Needs user-supplied key. Rate limit ~2,500/day. |
| **v2** | Assisted discovery: heuristic keyword search → show candidates → **user confirms** → store `originalModNexusId → translationModNexusId` mapping | Discovery is heuristic, not exhaustive. Optional masterlist import can supplement. |
| **v3** | After confirmed mapping: one-click file listing → download → import `i18n/<lang>.json`; mark imported strings `imported`/review-needed; missing new keys stay `untranslated` | Direct download needs **Premium**; otherwise `nxm://`/website handoff. |

---

## 8. What to explicitly avoid

- **Default web scraping** of Nexus mod pages. (Allowed only as an explicit, user-initiated, clearly-disclosed option in a far-future version — never silent, never default.)
- **Silent/background downloads.** Every download follows a prior user-confirmed mapping.
- **Claiming "automatic translation discovery" as a reliable feature.** It is heuristic + human-confirmed, not deterministic.
- **Assuming Premium.** Always provide the non-Premium browser/`nxm://` fallback.
- **Copying SSE/Skyrim concepts** (DSD, plugin strings, BSA, load order, MO2/Vortex).

---

## 9. Recommended architecture so v1 does not block future automation

The v1 data model already supports this; only **two lightweight, forward-compatible** habits are needed (no extra v1 features, no new UI):

1. **Keep `nexusId` on the mod model** (already in SPEC §14). This is the anchor for any future mapping.
2. **Reserve a place for an optional mapping store later** — i.e. do not hard-couple the mod model such that an `original → translation` mapping table (and an optional `source: "imported-from-nexus"` provenance on a string) cannot be added in v2/v3 without rework. No such table is built in v1; the model simply must not preclude it.

Concretely: the existing `imported` string status + per-string source snapshot already cover "import a downloaded translation and flag for review." A future Nexus import path is just another producer of `imported` strings. No v1 abstraction, provider system, or API client is required or permitted.

**Conclusion:** The current SPEC §12 strategy is sound and appropriately conservative. The only refinement this research suggests is wording: future discovery is **heuristic search + user-confirmed mapping (optionally masterlist-backed)**, *not* reliable category/API-driven auto-discovery — because Nexus exposes no translation/language metadata.
