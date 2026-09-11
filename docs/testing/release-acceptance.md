# Automated release acceptance

The [ordinary desktop suite](desktop-e2e.md) remains offline and small. The
explicit release profile extends it using the same unchanged release EXE, real
Tauri backend, native pickers, isolated portable data and process supervisor.
It adds no app endpoints, mock providers or permanent debug interfaces.

## Prerequisites and command

Use the ordinary Windows desktop prerequisites and matching WebView2/driver.
Also prepare both supported live engines:

- Local AI: LM Studio, Ollama or another supported loopback service with a real
  compatible model already loaded. Supply its exact model identifier using
  `-LocalModel`; `-LocalUrl` defaults to `http://127.0.0.1:1234/v1`. The suite
  configures and tests the connection through Settings. It does not download
  models or start/stop a shared model server.
- Codex CLI: installed, discoverable, authenticated, and able to report a usable
  model. The suite uses the reported selection, or `-CodexModel` when specified.
  Quality review stays enabled. It uses the CLI's own sign-in without reading or
  copying authentication files. Calls consume that account's quota or API billing.

For example, an already installed LM Studio model can be prepared with its
[documented CLI](https://lmstudio.ai/docs/cli/local-models/load):

```powershell
lms server start --bind 127.0.0.1
lms load <installed-model-key> --identifier translator-e2e --context-length 4096 --ttl 1800
corepack pnpm test:desktop:release -ReleaseZip "path/to/Stardew-i18n-Translator_<version>_windows-x64-portable.zip" -LocalModel translator-e2e
lms unload translator-e2e
```

Unload only the model you loaded for testing. Do not stop a server used by other
work. Missing servers/models, failed authentication, quota exhaustion, invalid
model output, or unsupported native controls fail the requested run. They are
not skips or successful acceptance. Never use a fake response server as evidence
for the live-engine profile. The default `test:desktop` still needs neither engine.

To isolate a failing capability, use `test:desktop` with `-ReleaseCases`,
`-Layout`, `-Stress`, `-Install`, or `-LiveAi local|codex|both` plus the relevant parameters.
A diagnostic subset does not approve the full release profile.

The release profile also includes the [portable installation and upgrade tests](installation-e2e.md).
They download a hash-pinned previous release, or accept the matching local ZIP
with `-UpgradeFromZip`, and run both real executables against generated work.

## Additional functional evidence

- Three mods, flat and split locale files, missing target folders, saved/imported
  Review states, literal `pt.json`/`pt-BR.json` sibling preservation, backup and
  removal, changed/blank source status, translatable dialogue prose and protected
  lookup keys. A combined ZIP contains five exact paths/dictionaries and leaves
  the installed mod tree and saved Review state unchanged.
- **Each real engine separately:** Settings discovery/configuration, two small
  synthetic English-to-German requests, nonempty changed output with exactly the
  expected placeholders, persisted Review before export, explicit approval of
  one suggestion, exact exported text and normal restart. The other suggestion
  remains Review. Model names and timing are recorded. Codex uses its normal
  quality review path; conditional repair branches are not guaranteed to occur.
- **Bounded load:** 20 generated mods with 1,000 strings each; scan plus 20
  search/edit/save cycles, repeated rescans, exact export and restart persistence.
  Scan must finish within 30 seconds and each search/edit/save within 5 seconds.
  Backend private-memory growth must stay below 256 MiB and handle growth below
  200 over the repetition. These generous regression thresholds are fixed test
  limits, not a universal performance promise or a long-duration leak benchmark.
  Memory/handle measurements concern the native app process, not the entire GPU,
  WebView or model-server tree. Timings and before/after measurements are retained.
- **Layout:** actual WebView rendering at 1, 1.25, 1.5 and 2; measured pixel ratio,
  no horizontal page overflow, and selected essential controls inside the viewport
  and unobstructed in Workspace, Editor and Settings. The measured logical
  viewport stays at 1100 x 780 at every rendering scale. Screenshots allow separate
  review of typography, focus, wrapping and other appearance properties.

All writes use generated fixtures. The model sees only synthetic text, including
synthetic neighboring context and glossary terms. Local-server state and the
CLI's authentication/cache remain external prerequisites, not copied portable
settings. App/driver/helper descendants are owned by the supervisor; pre-existing
model services are not killed. Normal logs, screenshots, exports, model provenance,
timing, `layout.json`, `stress.json`, `result.json` and `cleanup.json` stay in the
printed ignored `target/desktop-e2e/runs/` directory after runtime cleanup.

## Optional native Windows DPI diagnostics

The native DPI matrix is not a release requirement. The default release profile
runs on the current desktop and retains the inexpensive WebView layout checks.
Unexercised native configurations remain untested, not passed. Use the optional
matrix below only when investigating a DPI issue or explicitly accepting that
capability; no additional Windows environments are required for ordinary releases.

Windows DPI affects native window frames/dialogs and monitor transitions as well
as WebView content. Microsoft documents [per-monitor DPI behavior](https://learn.microsoft.com/en-us/windows/win32/hidpi/high-dpi-desktop-application-development-on-windows)
and [GetDpiForWindow](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getdpiforwindow).
The native helper reads the real window's DPI and awareness; `-ExpectedDpi`
rejects a mismatch before desktop interaction. Supported matrix values are
96/120/144/192 DPI (100/125/150/200%).

The four additional WebView scales use Microsoft's
[browser argument capability](https://learn.microsoft.com/en-us/microsoft-edge/webdriver/capabilities-edge-options#webviewoptions-object).
They test rendering/layout, **not a Windows DPI change**. The test never changes
the user's display settings, logs them out, or installs a virtual display driver.
For this optional matrix, run the profile on configured interactive test desktops
with `-ExpectedDpi` set to each actual value. A dedicated VM/test machine can
provide those environments; this repository does not provision one.

Validate an explicitly requested matrix against the exact same ZIP:

```powershell
corepack pnpm test:desktop:matrix <release.zip> <run-at-96-dpi> <run-at-120-dpi> <run-at-144-dpi> <run-at-192-dpi>
```

This command fails unless each run passed its release, installation/upgrade,
layout, stress and both live-engine stages, cleaned up successfully, used the same ZIP/EXE hashes, and
the required native DPI values were explicitly requested and measured without
rendering emulation. Duplicate runs or missing configurations cannot satisfy it.
Evidence is a test record, not a cryptographically signed attestation.
Run `corepack pnpm test:desktop:guards` after changing this evidence check.

## What still needs judgment

A passing release profile can replace the **listed functional checks**. It cannot
establish general translation quality, every model/service/authentication failure,
live cancellation/retry/partial-result behavior, long-duration stability, every
monitor transition, native dialog appearance, or full accessibility. Review changed
UI screenshots and exercise a changed uncovered property as needed; Computer Use
is optional. Screenshots are evidence for review, not automatic visual approval.

Portable first launch, native missing-runtime guidance and the documented upgrade
procedure are automated; see the installation guide for exact coverage. They can
replace the corresponding manual portable-installation check. They do not test a
fresh Windows guest, browser-download/security prompts or installing WebView2.

Any explicitly requested personal test remains a separate gate unless the
maintainer replaces it with the covered automated checks. A personal test is not
intrinsically required for every release. Omitting the optional native DPI matrix
does not block the listed functional acceptance.
The [release process](../release/release-process.md) still governs the exact tested
artifact and publication. No native desktop CI coverage is claimed here.
