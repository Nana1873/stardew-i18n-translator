# Diagnostic Logging — v1.1.1 Hotfix Plan

> **Status: Shipped in v1.1.1.** Implemented via `tauri-plugin-log` writing a
> rotating file to `Data/logs/`, a `log_frontend_error` bridge command, global
> `window` error/rejection handlers, error logging at the heavy command paths,
> and a **Settings → About → Open logs folder** button.
>
> **Deviation from the plan:** the opt-out _toggle_ was deferred. Logging is
> always on but fully local and bounded (`RotationStrategy::KeepSome(5)`,
> ~2 MB/file), so the privacy/footprint risk a toggle would mitigate is already
> covered. A disable toggle can still be added later if requested.

## Motivation

The app currently has **no log file**. The only diagnostics are scattered
`eprintln!` calls (e.g. [`detection.rs`](../../src-tauri/src/detection.rs),
[`scanner.rs`](../../src-tauri/src/scanner.rs)) that write to stderr — invisible
to users in a windowed Tauri build — and frontend `catch` blocks that show a
one-line error and discard the detail.

Once the repository is public and accepting bug reports, this is the biggest
gap: reporters can only paste the on-screen message, and maintainers / AI agents
have nothing to reconstruct what actually happened. This plan adds **local,
opt-outable, privacy-preserving diagnostic logging** so a bug report can include
a real log excerpt.

## Versioning note

Adding a log file plus a dependency and a Settings button is, strictly, a
**minor** change (`1.2.0`) under SemVer rather than a patch. It is framed here as
a `1.1.1` _diagnostics hotfix_ because it ships no user-facing feature change —
only support tooling. Confirm the version label with the maintainer before
tagging.

## Non-negotiable constraints (privacy)

The README and [SPEC.md](../../SPEC.md) promise **no analytics, no telemetry,
no cloud**. Logging must not break that:

- **Local only.** Logs are written to a file beside the portable data folder.
  Nothing is ever sent over the network.
- **No new network surface.** Do not add any remote sink, crash reporter, or
  "upload diagnostics" feature.
- **No secrets.** Never log the contents of translations wholesale, glossary
  data, or full file bodies. Log _what happened_ (operation, error, counts,
  relative keys), not the user's data.
- **Bounded size.** Rotate / cap so logs cannot grow unbounded inside the
  portable folder.
- **Opt-outable.** A Settings toggle can disable file logging entirely.

## Design

### Location

`Data/logs/` next to the executable, consistent with `portable_data_dir()` in
[`lib.rs`](../../src-tauri/src/lib.rs). Add `Data/logs/` to the portable-folder
setup. (`.gitignore` already excludes `/app_data/` and friends; confirm logs
can never be committed.)

### Implementation: `tauri-plugin-log`

Use the official [`tauri-plugin-log`](https://github.com/tauri-apps/plugins-workspace)
rather than a hand-rolled logger. It is in the same family as the already-used
`tauri-plugin-dialog` / `tauri-plugin-opener`, so it does not violate the
"no plugin/provider abstractions" guardrail (that rule targets in-app provider
frameworks, not official Tauri plugins).

- Targets: a rotating **file** in `Data/logs/` and (debug builds only) stdout.
- Rotation: `RotationStrategy::KeepN` with a small file-size cap.
- Default level: `info`; `debug` behind the Settings toggle.
- Convert existing `eprintln!` diagnostics to `log::info!/warn!/error!`.

### Frontend errors

The webview should forward caught errors into the same log. Either:

- enable the plugin's JS API (`@tauri-apps/plugin-log`) and call it from the
  `catch` blocks in [`src/App.tsx`](../../src/App.tsx) and the dialogs, or
- add one thin `logError(context, error)` helper that invokes a backend
  `log_frontend_error` command.

Keep messages structured: `context` + sanitized error string. Do **not** log raw
string-table values.

### User access — "Open logs folder"

Add a button in **Settings → About** that opens `Data/logs/` via the existing
`opener` plugin (a folder open, not a URL). This lets a reporter grab the log
file to attach to the bug-report form. Document it in
[SUPPORT.md](../../SUPPORT.md) and the bug-report template once shipped.

## Acceptance criteria

- A `Data/logs/<file>.log` is created on launch and captures errors from both
  the Rust backend and the frontend `catch` paths.
- Logs rotate and stay under a bounded total size.
- A **Settings → About** action opens the logs folder.
- A Settings toggle disables file logging.
- No network request is added; existing privacy tests/claims still hold.
- New unit tests cover log-directory resolution and the rotation/size cap;
  manual smoke notes cover an induced error landing in the file.
- README/SUPPORT updated to mention attaching a log file to bug reports, and the
  bug-report form gains an optional "log excerpt" field.

## Out of scope

- Any remote/cloud log sink, crash reporting, or auto-upload.
- A full in-app log viewer (opening the folder is enough for v1.1.1).
- Structured/JSON log shipping or metrics.

## Touch list (estimate)

- `src-tauri/Cargo.toml` — add `tauri-plugin-log`.
- `src-tauri/src/lib.rs` — init plugin, ensure `Data/logs/`, register a
  `log_frontend_error` command and an "open logs folder" command.
- `src-tauri/src/detection.rs`, `scanner.rs` — `eprintln!` → `log::*`.
- `src/tauri/commands.ts` + `src/App.tsx` + dialogs — forward caught errors.
- `src/settings/SettingsDialog.tsx` — "Open logs folder" + logging toggle.
- `SUPPORT.md`, `README.md`, `.github/ISSUE_TEMPLATE/bug_report.yml`,
  `CHANGELOG.md` — document and add the optional log field.
