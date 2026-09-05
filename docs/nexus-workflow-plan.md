# Nexus and mod-manager workflow proposal

Status: scope tracked in the [Nexus translations and Vortex workflow milestone](https://github.com/Nana1873/stardew-i18n-translator/milestone/6),
2026-09-05. This is a design and implementation plan, not a release announcement.
The baseline was checked against the local `v2.0.3` tag. Library selection and
technical details remain subject to the validation gates below. No version
number or delivery date is assigned.

## Intended result

The user-facing loop stays short: scan -> choose found translations ->
download/install through the configured manager -> rescan -> optionally edit
-> optionally export/apply. The setup choice remains editable. Users who are
satisfied after installation are finished; the editing/output steps are optional.
The technical checks below are development work, not extra menus in this loop.

Extend the existing Tauri/Rust/React app. Retain the translation editor,
validation, AI, glossary, direct export and per-package translation ZIP.
Deliver two complete ways to use the same editor:

- **Folder workflow:** the existing scan, edit, review and explicit export loop,
  with optional Nexus discovery and personal import into Review.
- **Vortex workflow:** find likely translations, send original Nexus files to
  Vortex, install/deploy there, rescan, edit missing or changed strings, and
  install a separately generated private translation output through Vortex.

The first Vortex scope is the currently active/deployed Stardew profile. The
translator will not activate or deploy another profile. Reading an inactive
profile and a general profile browser are outside this delivery. MO2 is deferred
until a concrete user request; no MO2 implementation or probe is scheduled.
ParaTranz remains a separate follow-up.
Manager/profile identity must be reliable before claiming profile isolation.

The full Vortex result includes editing and applying those edits again. A
working download handoff alone is an intermediate result, not completion.

## What changes for version 2.0.3 users

| Area                            | Proposed behavior                                                                                                                                                                      |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First start after upgrade       | Reuse the configured folders, language and existing work. Open the usual screen without forcing Setup or Nexus configuration.                                                          |
| Existing folder workflow        | Keep manual editing, AI, review, direct export with backups and per-package ZIP export. Do not infer manager ownership from existing paths.                                            |
| Network access                  | Nexus remains optional. Existing users start with automatic Nexus discovery disabled. Ordinary local scans do not require a key or Premium.                                            |
| Settings                        | Add an Installation section. Folder/Vortex choice can be changed later. Setup remains the first-run convenience, not the only way to change installation settings.                     |
| Choosing Vortex                 | Explicitly switch workflow; normal apply action creates a private output instead of writing into managed deployment files. Vortex performs installation and deployment.                |
| Multiple installations/profiles | Isolate new work by installation/profile and language. Copying existing drafts into another context is explicit. This replaces accidental sharing by mod ID across those new contexts. |
| Existing saved work             | Preserve all values, statuses, source hashes and token exceptions, including work for mods currently absent from the scan. Never guess which old entries were personal edits.          |
| Returning to 2.0.3              | Preserve a verified pre-migration backup. The old version can use that backup; it is not promised to understand new contexts or edits made after migration.                            |

Global AI preferences and glossary data can remain shared. Translation work,
source-change baselines and outstanding operations belong to one installation
context. A game-folder move should be handled as a move of the same context;
mod updates and Nexus file IDs must not create a new workspace identity.

## User flows and visible states

**New folder user:** select game, Mods folder and language; optionally configure
Nexus; scan; edit; review; explicitly export. Declining Nexus leaves this fully
usable offline.

**Existing folder user with Nexus:** scan; open Find translations; select
candidates in one table; import selected ZIPs into Review; edit; export. Personal
API downloads retain their account requirements. Import does not mean installed.

**Vortex user:** select Vortex and its current Stardew installation; optionally
enable Nexus discovery after local scans; select translations in the same table;
send selected files to Vortex; install and deploy in Vortex; use Check installed
files; open the existing editor to fill gaps; create/update private output;
install or replace it in Vortex; deploy; check installed files again.

The normal table shows selection, original mod/version, translation/file
version/date, and action status. Alternatives use inline selectors; unique
choices use readable text. One batch button follows the configured workflow.
Personal Review import remains reachable as a secondary action in Vortex mode.
Ambiguous language/component mapping remains an explicit choice. Routine
success appears in the table or existing result tray, not another required modal.

Use separate, evidence-based labels:

- Candidate found / no candidate found / search incomplete.
- Sent to Vortex / handoff failed; never infer download or installation.
- Language files detected on recheck, with disk coverage separate from drafts.
- Local edits not applied / output created / deployed output matches / output
  outdated or deployment unknown. File hashes can verify output application;
  they do not prove in-game quality or Collection membership.

Cache Nexus metadata by original mod ID and language; display freshness and
allow refresh. Proposed expiry: 24 hours, retaining the prototype's bounded
cache. Re-evaluate matches against each current scan. Skip fully covered groups
by default, with an Include fully translated option. Incomplete scans are not
100% coverage. Version relevance comes before date where evidence is available;
heuristic matches never become a promise to find every translation.

## Editing, updates and private output

Keep four facts distinct: current source `default.json`; installed community
translation excluding our own output; personal edits; actually deployed files.
For future edits record the source revision and the previous base translation,
including whether a key was absent. Own output is identified and never imported
again as the community baseline. An unresolved baseline blocks automatic merging.

Example: the base translates 970 of 1,000 source keys. The user fills 30 gaps.
The generated `de.json` contains the combined 1,000 translations, not just the
30 edits. File overlays replace whole files; there is no cross-mod JSON-key merge.
Only files requiring personal overrides need output. Preserve component paths,
including nested i18n directories, and reuse existing token/export validation.

On a new base translation, untouched entries adopt its new values. Personal
changes remain. If both base and personal value changed differently, show the
old base, new base and personal text for resolution. Source changes still enter
Changed and require fresh validation. Removing a personal override inherits the
base; deliberately removing a translation is a distinct operation and allows
source-language fallback. Removed source keys are omitted from output while
their old work remains recoverable.

Legacy 2.0.3 data has no old community-value snapshot. Preserve it as saved work;
do not invent a three-way merge history. Existing Review/Changed export rules
remain; a newly unresolved base-merge decision is handled before rebuilding the
affected managed output.

The private output contains selected packages' target-language files under
their original deployment-relative paths. It lives outside the game and is
packaged for a verified Vortex installation route. Creating it does not activate
it. Vortex installs it as one clearly named local output, with the intended
conflict priority. Rebuilding replaces that output, removes stale generated
entries and preserves the last valid artifact on failure. It must not introduce
fake SMAPI manifests, copy mod assets or modify the original translation mod.

After edits or input updates, show that output needs rebuilding. The user must
be able to disable it in Vortex and recover the base translation. Original
Nexus packages retain their own source association; a private output is not
automatically included in a Collection or authorized for redistribution.

## Implementation steps and exit criteria

| Step                            | Concrete deliverable                                                                                  | Required evidence before proceeding                                                                                                                                                           |
| ------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Verify the manager boundary  | A standalone read-only mod-manager-lib probe using synthetic Vortex fixtures; no app integration.     | Correct active profile/mods, Nexus IDs and file winners; explicit unresolved cases; input hashes unchanged; no live-profile access, network, UAC or manager writes.                           |
| 2. Settle the user flow         | A small local clickable prototype of Setup/Installation, the compact results table and output status. | Walk through folder import, Vortex handoff/recheck and edit/rebuild without stacked submenus. Only real unresolved choices interrupt the normal flow.                                         |
| 3. Add installation context     | Settings, scan, state, baselines and operations consistently use one installation context.            | Copied 2.0.3 data retains exact work/status/settings; migration is recoverable and repeatable; switching contexts rejects old asynchronous results and does not mix drafts.                   |
| 4. Finish discovery and handoff | Refine the existing local prototype for both folder and Vortex users.                                 | Optional network behavior, cache invalidation, skipped coverage, exact file selection, cancellation and accurate handoff/recheck states. Actual original Nexus association checked in Vortex. |
| 5. Complete edit/apply/update   | Current base plus personal edits produce a complete private output with controlled replacement.       | Multi-package install/deploy, second edit, upstream update, conflict review and disable/remove all work in a disposable Vortex/game test setup. Original staging files remain unchanged.      |
| 6. Local acceptance             | A local test build for the complete chosen scope and focused user documentation.                      | All acceptance scenarios below, relevant existing frontend/Rust checks and practical user UX acceptance. Publication remains a separate step.                                                 |

Steps 1 and 2 can run independently. Steps 3-5 are bounded changes in the existing
modules, not a provider/plugin framework. Existing local prototype work is
reviewed and reused selectively. A failed manager gate leaves the Vortex work
experimental; it must not be described as complete support.

### mod-manager-lib decision

Pin the evaluated source revision. Give the probe a fixture root, game definition,
manager and profile ID. Return active mods, source IDs, physical/relative file
paths, resolved winners and explicit unresolved paths. Fixtures include two
profiles, a base mod, a community translation, our output, a disabled competitor,
Vortex overrides and an unsupported conflict rule.
Test the native database reader as well as library mocks. Resolve the base with
our output excluded and compare it separately with the effective deployment.

The library is MIT-licensed, configurable by game and implemented in Python.
Its current dependencies include Qt and native LevelDB. It is not a complete
Stardew deployment engine or an official Vortex automation API.

- Use a separate Python helper only if all read tests pass and a packaged probe
  demonstrates acceptable startup, memory and distribution size. Users should
  not have to install Python/Qt manually. Measure the costs against the current
  packaged app and present them before choosing this route.
- Prefer a narrow Rust reader if the required subset is demonstrably smaller
  and passes the same fixtures. Do not port the whole library.
- Defer profile-aware support if neither route reliably identifies the active
  context, base translation and file winners. Do not guess based on a staging
  folder or use direct Vortex database writes as a shortcut.

DB locking, snapshots and operation while Vortex is open need a practical test.
A probe that works only with mocks or requires unexpectedly closing Vortex on
every scan is not enough to accept the intended user flow.

## Acceptance scenarios

1. Upgrade copied 2.0.3 data with multiple languages, Review/Changed text, token
   exceptions and AI settings. No forced Setup, Nexus request or lost work;
   existing direct export and per-package ZIP remain correct.
2. A new offline folder user completes scan, edit, review and export without a
   manager, key or Premium. Optional Nexus failure never blocks this loop.
3. Change installation settings, cancel the picker, switch contexts during a
   scan/import and return. Correct drafts and baselines reappear; stale results
   do not alter another context. Explicitly copying old work shows differences.
4. An unambiguous Nexus match needs one selection/batch action. Alternative
   versions and ambiguous files remain understandable inline. Reopening the
   dialog retains relevant results; rechecking files does not repeat discovery.
5. Handoff original ZIP/7z/RAR references to Vortex; test failures/cancellation
   and account requirements. Verify original game/mod/file association without
   claiming it from successful process launch. Free and Premium paths must be
   separately qualified; untested behavior is stated as such.
6. After deployment, recheck multi-component coverage without overwriting a
   conflicting draft. A malformed component prevents a false complete result.
7. Base 970 plus 30 edits produces the intended full language file. Install the
   output, deploy it and verify source/community/personal/fallback strings in
   game. Rebuild and replace it; disable/remove it and recover the base.
8. Update both original mod and community translation. Verify new, changed and
   removed keys, personal conflicts and outdated-output status. A different
   profile retains its work and the output is not adopted as its own base.
9. Check original translation eligibility/source references in a local,
   unpublished Collection workflow. The app neither publishes a Collection nor
   silently adds its private output to one.

Automated writes use fixtures only. Practical manager/game tests use a
disposable setup or the user's explicit manual actions. No writes to the user's
real Mods folders by test agents.

## Benefits, costs and boundaries

Benefits: existing users keep their offline editor; downloaded originals remain
manager-owned; personal work can survive base updates through explicit comparison;
output can be disabled; progress distinguishes saved work from applied files.

Costs: Vortex installation/deployment remains a user step; the output needs
rebuilding after relevant changes; context separation adds data migration and
testing; old drafts may need manual comparison; a helper could add substantial
packaging dependencies; manager internal formats require maintenance. The API
still cannot justify a claim that every translation will be found.

MO2 is retained only for a concrete future user request, with no implementation
or fixture work scheduled now. If requested, it needs its own active-profile and
in-game virtual-filesystem acceptance before appearing in Setup. ParaTranz,
automatic Collection creation, arbitrary game support, automatic publishing and
a complete app rewrite are outside this proposal.

Only official Nexus APIs with locally held keys are allowed. No HTML scraping,
browser automation, Cloudflare bypass, OAuth or SSO implementation. Keep the
current personal-key flow limited to local/testing use; public distribution
requires the appropriate Nexus registration and application-key process.
Local test builds are allowed, including the build the maintainer sends to
Nexus for registration review. No releases or pre-releases, including test builds
published as releases, until Nexus Mods gives explicit approval after that review.
No public build uploads or release tags during this hold. Finishing the milestone
does not authorize publication. No email is sent by this plan.

## Evidence and existing work

- Released baseline: [v2.0.3 source and behavior](https://github.com/Nana1873/stardew-i18n-translator/tree/v2.0.3).
- Current module boundaries: [contribution guide](../CONTRIBUTING.md).
- Delivery scope: [milestone 6](https://github.com/Nana1873/stardew-i18n-translator/milestone/6).
- Installation context and library evaluation: [issue #225](https://github.com/Nana1873/stardew-i18n-translator/issues/225).
- Existing Nexus work: [issue #223](https://github.com/Nana1873/stardew-i18n-translator/issues/223).
- Private multi-package output: [issue #224](https://github.com/Nana1873/stardew-i18n-translator/issues/224).
- Deferred MO2 workflow: [issue #226](https://github.com/Nana1873/stardew-i18n-translator/issues/226).
- Evaluated library: [mod-manager-lib at a40880d](https://github.com/Cutleast/mod-manager-lib/tree/a40880d22e0658f717d301a0a5047ed6a6cffbe8).
- Game translation semantics: [SMAPI TranslationHelper](https://github.com/Pathoschild/SMAPI/blob/develop/src/SMAPI/Framework/ModHelpers/TranslationHelper.cs).
- [Nexus API acceptable-use policy](https://help.nexusmods.com/article/114-api-acceptable-use-policy).
- [Collections guidelines](https://help.nexusmods.com/article/115-guidelines-for-collections).

The milestone groups #225 (installation/context), #223 (discovery and original
downloads) and #224 (optional edit/output lifecycle). Their issue descriptions
reflect the simplified user flow and publication hold. MO2 remains a separate
follow-up in #226. The current product contract changes only with implementation
and verification; no runtime changes are implied by this planning update.
