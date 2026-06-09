# Milestone M5: Nexus Translation Discovery & Download (DEFERRED)

> **Status:** Deferred / planned. Not part of v1. Captured here so the intended
> workflow is not lost. Pulls forward the staged v1.1→v3 Nexus work from
> [SPEC.md §12](../../SPEC.md) into one user-facing feature.
> **Decision (2026-06-09):** postponed by the product owner after finishing the
> v1 core loop. Owner has **Nexus Premium** (direct API download is available).

## Intended workflow (SSE-AT parity, owner's description)
1. **Scan** the Mods folder (existing).
2. **Check Nexus** for each mod whether a translation **for the configured
   target language** is available.
3. **Auto-download** the matching translation mod(s) — direct via the Nexus API
   (`download_link`) since the owner has **Premium**.
4. Downloaded translations are **imported and shown as installed** (status
   `imported` / review-needed); a **re-scan** then shows how much is still
   untranslated — and flags **outdated** strings (e.g. the mod updated and its
   English source changed since the translation was made). The existing 4-status
   model + per-string `sourceHash` outdated detection already supports step 4.

## Hard constraints (from research — must shape the design)
See [docs/research/nexus-mods-strategy.md](../research/nexus-mods-strategy.md).

- **API key required.** Every API call needs a personal Nexus key (Settings).
- **No translation/language metadata in the Nexus API.** There is no "German
  translation of mod X" endpoint. Discovery (step 2) is **heuristic keyword
  search** (`<mod name>` + language terms like `Deutsch`/`German`/`DE`) over
  titles/descriptions → **candidate list the user confirms**. Many mods (the long
  tail) simply have no translation. So step 2 is *assistive*, not exhaustive.
- **Confirmed-mapping store.** Persist `originalModNexusId → translationModNexusId`
  once the user confirms, so re-runs are reliable. Optionally support a shared
  community "masterlist" file later.
- **Direct download needs Premium.** Owner has Premium → use `download_link`. Keep
  a non-Premium `nxm://`/browser-handoff fallback if the tool is ever shared.
- **No silent downloads, no default scraping** (research §8).

## Scope (when built)
- Settings: optional Nexus API key + `GET /v1/users/validate.json`.
- Discovery: heuristic search → candidate list → user confirms → store mapping.
- Download: list files → download (Premium API) → extract → import
  `i18n/<target>.json` as `imported`; missing source keys stay `untranslated`.
- Re-scan surfaces remaining untranslated + `outdated` after mod/translation
  updates (reuses existing model — no new status).

## Out of scope (even here)
- Becoming a mod manager (enable/disable mods, profiles, load order).
- DSD/plugin-string/BSA concepts from Skyrim (no Stardew analog).
- Silent/background downloads; default Nexus page scraping.

## Note
The v1 "Search Translation on Nexus" browser-handoff (SPEC §7.6) is **folded into
this milestone** rather than shipped as a standalone stopgap, per the owner's
preference for the full assisted-download flow.
