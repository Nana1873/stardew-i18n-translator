# Vortex locale-only output probe

This issue #224 feasibility probe creates entirely synthetic two-package output
ZIPs and executes isolated official Vortex installer functions. It does not start
Vortex, inspect profiles, install mods, or change the translator application.

## Run

Use Node 24 or later from the repository root:

```powershell
node --experimental-vm-modules scripts/vortex-output-probe/probe.mjs --fetch
```

The first run fetches the exact source files and license pinned in
`source-lock.json`, verifies SHA-256, and stores them only under ignored
`target/vortex-output-probe/upstream`. Omit `--fetch` for subsequent offline
runs. Node's VM/type-stripping experimental warnings are expected. No package
installation is needed. This executes pinned upstream code with only the
documented dependency stubs; the VM is not a general security sandbox.

The evaluated revision was the official Vortex `master` head on 2026-09-05:
[5bf1ae71a9b62ace7f43b12bd844d2fd83bb6489](https://github.com/Nexus-Mods/Vortex/tree/5bf1ae71a9b62ace7f43b12bd844d2fd83bb6489).
It is a source feasibility reference, not proof of behavior in the user's
installed Vortex release. Downloaded upstream code and its GPL license remain
outside the tracked patch. No upstream implementation is vendored here.

## What passed

- The original archive classifier, Stardew manifest matcher and root matcher
  reject the locale-only fixture. There is no manifest, Content directory or
  SMAPI installer DLL.
- The original general fallback installer accepts it and emits copy instructions
  with unchanged source/destination paths. Windows path semantics are supplied
  even on other hosts. The unused manifest parser throws if accidentally called.
- Static source assertions check fallback registration at priority 1000,
  Stardew's default `Mods` deployment root and `mergeMods: true`.
- A negative control confirms that the fallback does **not** strip an `Output/`
  wrapper. Do not add a wrapper or a redundant `Mods/` prefix to this archive.

The resulting path contract is:

```text
archive: Synthetic Valley/[CP] Valley/i18n/de.json
default deployment: <game>/Mods/Synthetic Valley/[CP] Valley/i18n/de.json

archive: Synthetic Farm/Companion/nested/i18n/de.json
default deployment: <game>/Mods/Synthetic Farm/Companion/nested/i18n/de.json
```

The first part is executable upstream evidence. The deployment prefix is a
source-based inference for the default mod type; no deployment engine runs.
The original installed package/component directory names must match exactly.
Other installed extensions or a different Vortex version may affect selection.

`target/vortex-output-probe/fixtures` contains the community base, separate v1/v2
output trees and deterministic ZIPs. Each output JSON contains the whole combined
language file, preserving untouched base values. V2 changes one personal value
and removes the second file override. No fake manifests, loader, game assets or
third-party translations are included.

An explicitly labelled in-memory overlay model verifies that an output winning
whole-file conflicts changes text, replacement drops the removed override, and
disabling/removing it restores the base. This is **not** a Vortex priority,
replacement, hardlink, purge or removal test. `evidence.json` separates executable,
static and simulated evidence and records ZIP hashes.

## Remaining practical gate

Use a disposable Stardew/Vortex setup, or user-performed actions with explicit
scope. Do not run this against the current live profile merely to complete QA.

1. Record installed Vortex/Stardew extension versions. Import v1 using Vortex's
   local archive installation. Confirm the selected installer and default mod
   deployment type preserve both nested paths; inspect staging before deploying.
   If normal detection differs, investigate the supported **Unpack (as-is)**
   route rather than inventing a SMAPI manifest.
2. Keep original packages/translation mods separate. Enable the local output and
   make it win conflicts against those language files. Deploy; verify actual
   paths, hashes and displayed in-game strings. Check no extra `Mods` or wrapper
   level was inserted. Merely importing the archive is insufficient.
3. Install v2 as a **replacement**, not a merge with old output contents. Confirm
   the deleted second override disappears from output staging and deployment,
   allowing its community base to win. Verify the changed first file.
4. Disable/remove output and redeploy. Verify the original community files return
   unchanged. Compare original staging hashes across all steps.
5. Keep Nexus source IDs on the original downloads. A generated local output is
   not automatically a Collection source, a republishable archive, or a proof of
   translation ownership. Check any intended Collection inclusion separately.

No isolated Vortex launch command is proposed: CLI data-directory flags and
single-instance routing have not been established by this probe. A separate
folder alone is not evidence that a launch avoids the user's active profile.

Official source anchors:

- [Manifest matcher](https://github.com/Nexus-Mods/Vortex/blob/5bf1ae71a9b62ace7f43b12bd844d2fd83bb6489/extensions/games/game-stardewvalley/src/installers/stardewValleyInstaller.ts)
- [Fallback installer](https://github.com/Nexus-Mods/Vortex/blob/5bf1ae71a9b62ace7f43b12bd844d2fd83bb6489/src/renderer/src/extensions/mod_management/util/basicInstaller.ts)
- [Stardew deployment root](https://github.com/Nexus-Mods/Vortex/blob/5bf1ae71a9b62ace7f43b12bd844d2fd83bb6489/extensions/games/game-stardewvalley/src/game/StardewValleyGame.ts)

This folder is a feasibility probe, not the production output builder or a
complete Vortex integration. Root coordinates integration and publication.
