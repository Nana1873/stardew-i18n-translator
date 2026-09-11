# Windows Desktop E2E

## Run locally

Use the Windows x64 [development prerequisites](../../CONTRIBUTING.md#development-setup),
Node.js 22 or newer, and an unlocked, logged-in desktop. Run from the repository
root in PowerShell, without elevation. No game installation, AI account, or
other online service is required.

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm test:desktop:setup
corepack pnpm test:desktop
```

Setup installs pinned `tauri-driver` 2.0.5 through Cargo and downloads Microsoft's
x64 Edge WebDriver matching the installed WebView2 runtime into ignored
`target/desktop-e2e/tools/`. It verifies the driver version and Microsoft
signature. Setup requires internet access; rerun it after WebView2 updates or
after deleting the tools directory. The normal test does not download drivers.
Do not interact with the test app while it runs. A locked desktop, service
session, missing runtime/driver, or unsupported native dialog fails the run.

The default command builds the release executable with the embedded frontend and
locked Rust dependencies, runs the existing portable packaging script, validates
the archive's exact two-file layout and embedded product version, and launches
the extracted EXE. To test the actual ZIP intended for publication instead:

```powershell
corepack pnpm test:desktop -ReleaseZip "path/to/Stardew-i18n-Translator_<version>_windows-x64-portable.zip"
```

This mode skips rebuilding and packaging. Use the checkout matching the archive's
version; the documented filename is required. The original ZIP is only read. A
stable copy is extracted into the isolated runtime, and ZIP/EXE SHA-256 values
are retained. The ZIP must remain unchanged throughout the run. Extra files
(especially `data/`), duplicate/traversal entries, and incorrect versions fail
before app launch. Small negative archive probes also exercise the extraction
boundary on every run; these helper checks are separate from desktop evidence.

There is no Vite server,
mocked `invoke`, app test endpoint, or added production plugin. Existing Vitest
and Rust suites remain separate and required for their respective changes.

## What passes prove

[The workflow](../../scripts/desktop-e2e/workflow.mjs) drives the actual WebView2
surface with Selenium and checks files produced by the actual Rust backend:

1. A new portable app opens first-time setup with no existing settings.
2. Cancel the real game-folder picker, reopen it, choose a synthetic game folder,
   and use the real Mods picker to choose a different synthetic directory.
   Finish setup in German, trigger **Scan mods**, and inspect its result. The scan
   finds one mod and four source keys.
3. Open a row through the keyboard and save a translation. Check its portable
   state, status, and source hash; the mod still has no `de.json`.
4. Use **Import …** and the real Windows file picker to load a prepared format-2
   LLM result JSON. Imported text enters Review, while a conflicting value
   preserves the saved personal edit. Approve both imported suggestions through
   the editor and check Done. Import does not write an installed locale file.
5. Use **Export … → Export current mod** and confirm its preview. Check the
   complete output dictionary, omitted empty source, Unicode text, and preserved
   `{{PlayerName}}`, `{{Count}}`, `$h`, `#$b#`, `%farm`, and `@` tokens. Source and
   import inputs remain unchanged.
6. Save a different value after export, persist a string search and Done filter,
   then leave an unsaved editor draft open. Close through the normal Windows
   window-close request and wait for process exit. Restart the same portable
   copy: Overview opens without setup; Workspace restores its mod, search,
   filter, saved edit, and imported text. Row selection and the open editor are
   session-only; the unsaved draft is absent. The exported file remains at its
   earlier value, proving the saved work was restored from portable state.
7. Try saving a value with missing protected tokens. Check the real warning and
   unchanged backend state, return to the editor, repair the value, and save.
   Cancel replacement export: neither locale nor backup changes. Confirm the
   second attempt: the new locale is exact and `.json.bak` preserves every byte
   of the previous export.
8. Use **Build translation ZIP · current mod**. Cancel the real Save dialog,
   reopen it, and save to a new synthetic path. Inspect the generated archive:
   exactly `DesktopSmoke/i18n/de.json`, expected translations and tokens, no
   source strings, manifest, portable state, or backup. Installed locale and
   backup remain unchanged.
9. Clear a translation through the editor, select that Open row together with
   a Done row, and export an LLM batch through the actual Save dialog. Choosing
   the destination does not write yet; **Save JSON batch** does. Verify format 2,
   mod/language/source binding and exclusion of Done entries. Prepare synthetic
   returned files locally; no LLM is contacted. Real file-picker imports with a
   wrong language, changed snapshot hash, or missing token are blocked without
   state writes. A valid return goes to Review; **Approve suggestion** persists
   Done. No batch action implicitly writes the installed locale.
10. Build a German glossary in Settings from two generated, uncompressed XNB
    dictionaries. Verify the typed cache, filtering of unchanged English values,
    and the matching editor hint. Save settings and restart; the cached hint
    returns. Both XNB inputs remain byte-identical. No actual game assets or
    prebuilt glossary cache are used.

A successful command needs both `result.json` with `passed: true` and
`cleanup.json` with exit code 0 and `runtimeRemoved: true`. An interrupted or
failed run is not a pass. No workflow step is silently skipped.

## Isolation and evidence

Each run prints its unique directory under ignored `target/desktop-e2e/runs/`.
Its temporary `runtime/` contains the copied EXE, portable `data/`, synthetic
game/Mods/import folders, WebView profile, and redirected temporary/AppData
paths. No existing app settings or translation state are copied in. The test
never selects real game/Mods data, auto-detects an installation, or starts an
online translation. Windows' own common-dialog history is an OS/user facility,
not isolated portable app state.

Retained evidence includes:

- `result.json`: completed stages, failure details, driver/runtime versions,
  build mode, package layout/product version, and the ZIP/EXE SHA-256 values;
- `steps.log`, build/driver/native-helper logs, and the app's own rotating logs;
- WebView screenshots at milestones, plus `failure.png` and `failure.html`
  when the driver still responds; a native accessibility-tree dump is attempted
  on failure (screenshots do not capture the native picker);
- initial/replacement locale JSON and previous-export backup, the translation
  ZIP, exported batch, Review/approved state snapshots, glossary cache, and a
  synthetic portable-state snapshot before the first restart;
- `cleanup.json`: cleanup result and exit checks for remaining owned processes.

The supervisor places the runner and its descendants in a Windows Job before
allowing it to launch children. Closing that job terminates remaining owned app,
driver, WebView, and helper processes, including after a runner crash or timeout.
Cleanup deletes only that run's generated `runtime/`, with bounded retries for
Windows file locks. Evidence and downloaded tools remain for inspection; cleanup
failure returns a failure and retains `cleanup-error.log`. Hard power loss or
forced termination of the supervisor still requires removing any leftover
runtime directory on the next maintenance pass.

To verify failure diagnostics or orphan cleanup deliberately (both commands must
return nonzero):

```powershell
corepack pnpm test:desktop -FailureProbe assertion
corepack pnpm test:desktop -FailureProbe exit
```

The second exits the runner immediately with the app open, before its own
`finally`; the supervisor must still remove the runtime and end all job processes.

## Driver decision and native boundary

The initial prototype launched the repository's Tauri 2.11.5 / Wry 0.55.1 release
app, read its WebView2 surface, and completed its actual folder picker. This
established the external `tauri-driver` + Edge WebDriver path before building
the workflow. Selenium is the only added JavaScript test dependency.

This follows [Tauri's external WebDriver setup](https://v2.tauri.app/develop/tests/webdriver/manual-setup/)
and [Microsoft's WebView2 launch approach](https://learn.microsoft.com/en-us/microsoft-edge/webview2/how-to/webdriver).
The [current Tauri overview](https://v2.tauri.app/develop/tests/webdriver/) also
offers an embedded server; this suite uses external drivers to test the normal
release binary without adding server/mocking plugins. Driver endpoints bind to
loopback and exist only for the test process tree. Automation variables and
WebView debugging are confined to that tree, not persisted in the app or user
environment.

WebDriver does not drive Windows file dialogs. The small
[native helper](../../scripts/desktop-e2e/native.ps1) scopes them by the test
process, verified executable path, dialog title, and native control IDs. On the
tested Windows system, UI Automation exposed those IDs but did not provide
Value/Invoke patterns for the path and action controls. The helper therefore
sets the actual path control and activates its actual button using bounded
Win32 messages (folder edit 1152, file edit 1148, OK 1, Cancel 2). Modern Save
dialogs expose filename Edit 1001; the helper uses its HWND when present or its
accessibility ValuePattern for a DirectUI control without an HWND. Save paths
must be new files with an existing parent inside the generated runtime. It never uses
screen coordinates, global keystrokes, clipboard replacement, or mocked picker
results. Completion waits on dialog disappearance and the resulting app state.
Unsupported dialog layouts fail with diagnostics and need investigation.

## Acceptance limits and CI

The opt-in [release acceptance profile](release-acceptance.md) adds real Local AI
and Codex CLI calls, multi-mod/split output, bounded load and layout checks. It
also records actual Windows DPI. A separate optional matrix command rejects
incomplete native DPI evidence; that matrix is not a release requirement.
The release profile also includes [portable installation and upgrade tests](installation-e2e.md),
available separately through `test:desktop:install`.
The ordinary command's coverage below remains unchanged.

This suite can satisfy the functional acceptance slice listed above for its
recorded executable. It is not a visual approval, an accessibility audit, a
performance benchmark, or proof of every persistence/validation branch. Use a
visual desktop check or Computer Use for layout, clipping, DPI/window sizes,
focus presentation, native dialog appearance, or changed interactions outside
this slice. Review screenshots when appearance changes; their existence alone
does not establish visual correctness.

Additional capability checks remain necessary for live AI providers/authentication,
combined output packages, multiple mods/languages, split locales,
accepted token-mismatch overrides, replacing an
existing ZIP, corruption recovery, or other changed behavior. The synthetic
uncompressed XNB test does not establish compatibility with every real or
compressed game/community-pack asset. The offline batch return does not prove
provider availability or translation quality. These uncovered properties are
not claimed as tested. Plain locale-JSON or downloaded archive imports and
Nexus/Vortex integration are not supported workflows on the current main branch;
this suite does not add or claim them. Exact release-ZIP and explicit user-test gates follow the
[release process](../release/release-process.md).

The suite is local-only. Tauri documents Windows WebDriver CI, but this complete
suite also requires native common dialogs on an interactive desktop. The
repository's Windows CI currently proves Rust checks; this native suite has not
been qualified there. Do not count CI as desktop coverage or add an unsupported
headless fallback. A future CI integration must pass the same native workflow
and failure-cleanup probes on its actual runner.
