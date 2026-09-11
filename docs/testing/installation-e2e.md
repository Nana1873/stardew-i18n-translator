# Portable installation and upgrade E2E

Use the [desktop test prerequisites](desktop-e2e.md) and run:

```powershell
corepack pnpm test:desktop:install -ReleaseZip "path/to/Stardew-i18n-Translator_<version>_windows-x64-portable.zip"
```

Without `-ReleaseZip`, the suite builds and packages the current checkout first.
The command runs the ordinary desktop suite and the installation cases below;
it needs no AI service or login. `test:desktop:release` includes these cases too,
alongside its real Local AI/Codex CLI, load and layout checks.

The previous release is downloaded from the exact URL and checked against the
SHA-256 in [upgrade-baseline.json](../../scripts/desktop-e2e/upgrade-baseline.json).
Currently the baseline is 2.0.3. To work offline, supply `-UpgradeFromZip` with
that same archive; a different hash fails. Update the baseline deliberately when
the supported upgrade path changes. One tested baseline does not certify every
historical version or downgrade.

## What runs automatically

1. Extract and version/hash-check the actual release ZIP. Launch its EXE directly,
   with only Windows directories in `PATH`, no WebDriver/debug arguments, empty
   portable data and an isolated WebView profile. Wait for accessible first-time
   setup and close normally. Rust, Node and Codex are not on the app's search path.
2. Exercise the real native missing-WebView2 message and its **No** button. Verify
   the guidance includes the official download URL, creates no portable state,
   and exits normally. This uses Microsoft's
   [per-process runtime-folder override](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/webview2-idl#getavailablecorewebview2browserversionstring)
   pointing to an empty fixture directory. It does not uninstall or modify the
   host runtime and is not a mock of the app's runtime detection.
3. Start the real previous EXE with empty data. Use native setup pickers, scan a
   synthetic mod, save a manual translation and import a real batch into Review.
   Change a source fixture while the app is closed and reopen to obtain Changed;
   retain a blank pair (Open in 2.0.3, corrected to Done in 2.1.0). Save workspace
   selection/filter/search and close with an unsaved draft.
4. Follow the documented update procedure: back up the closed old installation,
   extract the new release separately and copy the complete `data/` beside it.
   Verify every copied and backed-up file byte-for-byte before starting the new
   EXE. This uses real old-backend state, not a hand-written migration snapshot.
5. Verify the new app resumes without setup or the unsaved draft, with the same
   folders, language, workspace preferences, saved texts, Review and Changed
   states. Blank Done must not become a fabricated saved approval. Startup must
   not export into the synthetic Mods folder.
6. Edit again, export and verify exact text/placeholders and the previous-file
   backup. Restart and check persistence. The old installation and its backup
   must remain byte-for-byte unchanged; Review must remain unapproved.

## Isolation and diagnostics

All installations, backups, inputs and exports are generated beneath the run's
`runtime/`, inside ignored `target/desktop-e2e/runs/`. Only those runtime files and
owned processes are cleaned up. Real installations, Mods and user settings are
never copied or modified.

The printed run directory retains screenshots (including the native startup
dialog), accessible startup text, `installation.json`, `upgrade-transfer.json`,
before/after portable-state copies, exported JSON and old/new app logs. The main
`result.json` records executable/ZIP hashes and stages; `cleanup.json` must also
report success. The pinned previous ZIP is temporary and removed with the run.

To verify cleanup after an abrupt exit with the upgraded app still running:

```powershell
corepack pnpm test:desktop:install -ReleaseZip "path/to/release.zip" -FailureProbe upgrade-exit
```

The supervisor records exit code 23 in `cleanup.json` (pnpm returns nonzero),
with no remaining owned processes and `runtimeRemoved: true`. This intentional
failure does not count as acceptance.

## Acceptance boundary

This profile can replace a manual **portable first-run and upgrade** check for
the tested versions and listed behavior. No maintainer mouse interaction or
Computer Use is required for those checks. A previously requested personal check
can be replaced with this evidence when the maintainer chooses that scope.

It is still a test on the current Windows host, not a fresh Windows installation.
Windows components, policies, security software and installed WebView2 remain
host prerequisites. The browser-download/SmartScreen experience, **Yes** opening
the external download page and installing WebView2 are not covered. General
appearance, accessibility and translation quality also need separate judgment
when relevant to a change.

A clean-Windows run requires a configured disposable VM or
[Windows Sandbox](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-install).
Sandbox requires administrator setup and may require a restart. This repository
does not currently provision or claim a tested guest environment. Do not count
the restricted-`PATH` launch or runtime override as that missing proof.
