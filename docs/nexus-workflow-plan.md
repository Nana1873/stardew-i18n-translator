# Nexus and mod-manager workflow proposal

Status: implementation plan checked against `87003a4`, updated 2026-09-06.
[Milestone 6](https://github.com/Nana1873/stardew-i18n-translator/milestone/6)
groups the remaining work. This document is not a release announcement or a
claim that the planned private-output workflow is already implemented.

## Intended result

Keep the existing local-first Tauri/Rust/React editor and a short personal loop:
scan -> optionally find translations on Nexus -> optionally translate manually
or with AI -> export as **Stardew Translator Output** -> send to Vortex or save
its ZIP for manual Vortex import. Acquisition and editing are optional; users
with satisfactory installed translations can stop after checking their scan.

- In Vortex mode, the normal export creates one private, combined locale output.
- In folder mode, direct folder export remains the main action.
- **Build translation ZIP** remains available in both modes for the selected
  package, including its components. It is distinct from the combined output.
- Sending to Vortex and saving a ZIP use the same generated artifact. Creating
  or handing off that artifact does not prove installation or deployment.

The scope is the currently active/deployed Stardew Vortex profile. Do not switch
profiles or add a general profile browser. MO2 remains deferred in
[issue #226](https://github.com/Nana1873/stardew-i18n-translator/issues/226).
Collection publication/reproduction and an in-game test are not acceptance
requirements for this locale-only personal output.

## What changes for version 2.0.3 users

Preserve configured folders, language, AI preferences, glossary and saved work.
An upgrade must not force Setup, Nexus configuration or a network request.
Folder/Vortex selection remains editable in Settings. Ordinary local scans and
editing work offline without an API key or Premium.

Extend the existing local JSON persistence; no server database is needed.
Isolate work by a reliable installation/profile context and target language.
Retain values, statuses, source hashes and token exceptions, including work for
mods absent from the current scan. Migration needs a verified recoverable copy;
older versions are not promised to understand the new storage layout.

Mod updates and Nexus file IDs must not create new workspace identities. A
folder move should preserve the same context when verified. Reuse saved work
only within the same context and unchanged source; cross-context copying is
explicit. Do not introduce text-equality or glossary automatic prefill. Global
AI preferences and the existing glossary may remain shared.

## User flows and visible states

The current code already has optional Nexus discovery, folder ZIP import into
Review, original Nexus-file handoff to Vortex, installed-file rechecks and the
existing editor/export actions. The original handoff is current behavior, not
proof of the proposed controlled archive-to-component import path.

Keep discovery and version choices in the existing results surface. Ask only
for unresolved file/language/component choices. Rechecks must not restart
searches, overwrite conflicting drafts or turn unknown inventory into absence.
Optional acquisition failures must leave local editing and export usable.

Distinguish candidate found, handoff sent, installed files verified, local work
saved, output created, deployed output matches, and output outdated/unknown.
Only retain intermediate states that explain a real user decision or result.
Hashes establish deployment evidence, not translation quality or Nexus credit.

## Editing, updates and private output

Keep four facts separate: current English source, original/community locale
content excluding our output, personal work, and effective deployed files.
Record the previous base value and source revision for new personal edits,
including whether the base key was absent. Identify our own output so a rescan
cannot silently adopt it as a new community baseline.

Legacy state has target/status/source-hash data but no reliable old community
snapshot. Preserve it as saved work; do not invent personal ownership or a
three-way merge history. An unresolved base must prevent automatic merging.

Build each affected language file from the current base plus personal changes.
For example, 970 base translations plus 30 completed gaps produce one complete
1,000-key locale file. Vortex overlays whole files; separate partial JSON files
do not merge by key. Preserve deployment-relative component paths and nested
i18n directories. Reuse existing token checks, Review/Changed handling and
explicit accepted-token exceptions.

Untouched entries can adopt a verified new base. If base and personal text both
changed differently, compare old base, new base and personal text explicitly.
Source changes require fresh validation. Removing an override inherits the
base; deliberately clearing a translation is distinct and permits fallback.
Omit removed source keys from output while keeping old work recoverable.

Generate selected locale files where acquired translations or personal edits
need to override the underlying installed files, outside game/staging folders.
A newly imported community translation must be exportable even without manual
edits; already identical underlying files need no override. Use exact
Mods-relative archive paths, without an extra `Mods/` or `Output/` wrapper.
Include no fake manifests, DLLs or original assets. Use one stable
output identity, replace its entire generated contents and remove stale entries.
Failed generation preserves the last valid artifact. Relevant input changes
mark it outdated. Disable/remove must recover the underlying translations.

## Implementation steps and exit criteria

1. **#225: context, base and legacy data.** Establish the reliable active context
   and base excluding our output; extend JSON state and migration. Preserve
   drafts and reject stale asynchronous results after context changes.
2. **#223: optional acquisition and verified mapping.** Preserve working original
   handoff while implementing the chosen safe archive-to-component route.
   Retain original Nexus mod/file IDs, version and author/source links. Obtain
   originals through normal Nexus paths; do not substitute unattributed mirrors.
   Qualify Free/Premium behavior and never infer download counts from metadata.
3. **#224: complete combined output.** Reuse validation and safe ZIP construction
   across packages. Offer the same artifact through send/save, with direct
   folder export and per-package ZIP still available in their defined roles.
   Verify the supported local-archive handoff separately from NXM downloads;
   the live manual installation test does not establish an automated handler.
4. **Replacement, rescan and updates.** Connect stable output replacement,
   removed overrides, deployed-hash checks and base/personal update handling.
   Do not treat a successful process launch as a verified installed output.
5. **Final Draft cleanup and acceptance.** Audit obsolete intermediate states,
   actions, duplicate derivations and probes. Remove superseded code only after
   checking its remaining callers and coverage. Preserve identity, draft and
   token protections. Keep minimal meaningful regression fixtures and align
   documentation/PR text with final behavior and actual validation results.

These are bounded changes in existing modules, not a new provider framework.
`release_zip` already prepares validated locale archives; `scanner` resolves
saved/disk values. Reuse those seams without confusing current effective-disk
resolution with the new ownership-aware base model.

### mod-manager-lib decision

Two technical decisions remain open before claiming full support:

- **Active profile and base source:** neither evaluated reader is accepted.
  The [Python library probe](../scripts/mod-manager-probe/README.md) found writes
  during reads and packaging costs; do not silently add Python/Qt. The
  [Rust probe](../scripts/vortex-state-probe/README.md) is narrower but still
  needs reliable partial/corrupt-state handling and consistent live snapshots.
  Prove context, enabled sources and file winners with our output excluded;
  do not guess from staging folders or write directly to the Vortex database.
- **Archive-to-component mapping:** define safe handling for ZIP, RAR/7z,
  split locales, multiple components and translations bundled with originals.
  Existing folder ZIP preflight is useful, but does not settle every format or
  ambiguous archive. Key overlap alone is not mod identity. Unsupported or
  ambiguous inputs need explicit resolution rather than an invented mapping.

## Acceptance scenarios

- Copied legacy data retains exact work/status/token exceptions through migration;
  switching contexts cannot mix drafts, pending requests or base snapshots.
- Offline folder scan/edit/export and per-package ZIP remain usable. Optional
  Nexus cancellation/failure and unknown snapshots report honest states.
- Verified archive mappings preserve language/component identity; malformed,
  ambiguous and bundled inputs cannot silently overwrite unrelated work.
- Base plus personal work produces complete locale files with shared validation.
  Both delivery choices produce the same artifact, with correct relative paths.
- Same-output replacement leaves no duplicates or stale overrides; disabling or
  removing it restores the base. Rescan never promotes our output to community
  provenance. Upstream changes expose conflicts without discarding personal work.
- Relevant frontend/Rust checks and focused user-flow acceptance pass after
  cleanup. No mandatory Collection reproduction or in-game proof is added.

## Benefits, costs and boundaries

The Vortex 2.6.3 [live lifecycle evidence](https://github.com/Nana1873/stardew-i18n-translator/issues/224#issuecomment-5562201987)
proved a two-mod locale-only output, same-output replacement with an omitted
file, and disable/remove restoration. Deployed hashes matched, originals stayed
unchanged, and all 14,287 final path/source mappings matched the baseline after
the user's conflict fixes. This proves the manager route, not an implemented
app lifecycle or complete serialized equality of every profile rule/flag.
The [installer probe](../scripts/vortex-output-probe/README.md) remains supporting
static evidence; audit obsolete probes without discarding useful regressions.

Game/Mods folders remain read-only test inputs. Use fixtures or temporary copies
for writes; the explicitly authorized bounded live test above is complete and
does not grant blanket permission for future live mutations.

Only official Nexus APIs with locally held keys are allowed. No scraping,
Cloudflare bypass or new OAuth/SSO implementation. Preserve the publication hold:
local test builds, including maintainer submission for Nexus registration review,
are allowed; no public uploads, releases/pre-releases or release tags until
explicit Nexus approval after review. Completing this plan does not authorize
publication. No email or Collection publication is authorized here.

## Evidence and existing work

- [Contribution guide](../CONTRIBUTING.md): existing architecture and checks.
- [#225](https://github.com/Nana1873/stardew-i18n-translator/issues/225): context/base/persistence.
- [#223](https://github.com/Nana1873/stardew-i18n-translator/issues/223): optional acquisition/mapping.
- [#224](https://github.com/Nana1873/stardew-i18n-translator/issues/224): private output lifecycle.
- [SMAPI TranslationHelper](https://github.com/Pathoschild/SMAPI/blob/develop/src/SMAPI/Framework/ModHelpers/TranslationHelper.cs): locale semantics.
- [Nexus API acceptable-use policy](https://help.nexusmods.com/article/114-api-acceptable-use-policy).
