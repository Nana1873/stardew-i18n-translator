# Synthetic Vortex library probe

Bounded evidence for issue #225. This is not a manager integration, deployment
tool, supported Vortex reader, or distributable user build. No MO2 work is included.

## Run on Windows

Prerequisites: PowerShell and `uv`. From the repository root:

```powershell
& scripts/mod-manager-probe/bootstrap.ps1
target/mod-manager-probe/.venv/Scripts/python.exe -B scripts/mod-manager-probe/probe.py
```

The bootstrap downloads official upstream sources and Python dependencies into
ignored `target/mod-manager-probe/`. It pins Python 3.14.2,
[mod-manager-lib a40880d](https://github.com/Cutleast/mod-manager-lib/tree/a40880d22e0658f717d301a0a5047ed6a6cffbe8),
and cutleast-core-lib e56ec58. Registry dependencies are constrained by the
pinned library's lockfile; `--no-sources` avoids its unbound workspace dependency.
The script uses `--no-bin --no-registry` for the private Python installation.
`installed.txt` records the installed environment, including packaging tools if
those were installed subsequently. This is not a bit-reproducible binary build.

Each run creates a fresh `run-<id>/` containing synthetic inputs, a disposable
database copy, `input-hashes.json`, `worker.stderr.txt`, and `result.json`.
No user-supplied profile or game paths are accepted. Runs are retained for review.
The worker requires generated fixture paths; it is not a general-purpose service.

Optional **local-only** standalone measurement:

```powershell
& scripts/mod-manager-probe/package.ps1
target/mod-manager-probe/.venv/Scripts/python.exe -B scripts/mod-manager-probe/probe.py --packaged
```

This builds an unpacked PyInstaller directory under `target/mod-manager-probe/packaged`.
It does not create a release, upload, tag, or edit application dependencies.
The Python runner still creates fixtures; the measured child process is the
standalone executable. Keep the generated directory layout for this experiment.
**The build command succeeded, but the packaged probe did not pass on the
evaluation host.** See the concrete failure below; these commands do not imply
that standalone packaging is already working.

## Contract and checks

Two profiles contain an original mod, community translation, private output,
disabled competitor, and deliberate ambiguous/unsupported/cyclic/unordered
conflicts. Inputs also include an explicit per-file override. The original has
a synthetic SMAPI manifest; private output metadata has no borrowed Nexus IDs.

The JSON result reports the active profile, active manager IDs, Nexus metadata,
paths, raw library conflict relationships, and per-file candidates for:

- effective content based on configured rules;
- community/base content with the explicitly identified private output excluded.

**These are metadata candidates, not proof of actual deployed files.** Missing
rule support or a non-unique winner produces `unresolved`. The resolver that
requires a unique ordered candidate is small probe-owned code: it is not an API
provided by mod-manager-lib and does not implement all Vortex rule semantics.
Own-output identity is supplied by the synthetic request, not inferred from a
display name. Source UniqueID association across arbitrary archive layouts,
live active/deployed-profile agreement, and discovery of a real output mod
remain unimplemented.

Assertions verify both profiles, original/community IDs, disabled-mod exclusion,
own-output/base separation, file overrides, and all four unresolved cases.
Every immutable input file is hashed before and after the worker; logical native
DB entries are also hashed before and after library reads.

The child sets synthetic APPDATA/LOCALAPPDATA/USERPROFILE/TEMP before third-party
imports. A Python audit hook restricts file reads/writes and denies sockets,
subprocesses, registry access, symlinks and hardlinks. Explicit guards deny UAC,
manager mutation methods, and any native DB opening except the scratch copy.
Eight negative checks prove the registered barriers reject the tested operations.
The normal operation counters are captured separately from those negative checks.

**This is not an OS sandbox.** The audit hook cannot prove that arbitrary native
DLL code performs no system reads or network operations. The native DB open is
restricted at its Python entry point. No production profile was used, and these
controls must not be advertised as safe isolation for an untrusted plugin.

## Findings

- Native LevelDB works with Python 3.14.2 and `plyvel-next` 2.1.2 on this Windows host.
- The library returns disabled mods and can reference them in conflict lists of
  enabled mods. Callers must not treat its raw graph as the active file view.
- The library logs and skips ambiguous `fileExpression` and unsupported rules.
  The probe's additional resolver preserves those as unresolved outcomes.
- **Even read-only API calls change LevelDB physical files:** LOG, CURRENT,
  manifests and table/log files changed in scratch. Logical entries and all
  original fixture files remained identical. A live database must not be opened
  under a promise of zero writes. Consistent acquisition of a real snapshot is
  still an unsolved integration requirement; copying an open live DB is not endorsed.
- The dependency environment before packaging tools occupied 679,390,306 logical
  bytes in site-packages, plus 63,516,848 bytes for Python. Logical byte counts
  are not allocated disk usage; uv may hardlink cache files. Later runs include
  packaging tools and bytecode in those environment totals.

Verified on September 5, 2026, Windows 11 x64:

| Measurement                    | Observed result                                                                    |
| ------------------------------ | ---------------------------------------------------------------------------------- |
| Python probe, final source     | Passed; 24 unchanged input files, identical logical DB entries, eight guard checks |
| Python child process wall time | 1.80–3.65 seconds across development runs; includes imports and fixture work       |
| Python peak working set        | Approximately 64–66 MiB                                                            |
| Standalone directory size      | 178,735,371 logical bytes (170.46 MiB)                                             |
| Standalone full probe          | **Failed at QtCore import**; successful startup/RAM measurement unavailable        |

The package failure is `ImportError: DLL load failed while importing QtCore:
The specified procedure could not be found` (Windows displayed the German
equivalent). `Analysis-00.toc` identifies a Poppler `icuuc.dll` from the host PATH
and `icudt78.dll` in the package. A PE import/export comparison showed that this
ICU lacks the unversioned `ucnv_*` symbols imported by Qt6Core. The bundled
QtCore.pyd, Qt6Core.dll and python3.dll match the working environment's files.
Thus the observed failure is a concrete packaging-environment mismatch, not
proof that a Python helper cannot be packaged. A sanitized packaging environment
would be the next packaging investigation; it was deliberately not pursued.

The final source result is retained at
`target/mod-manager-probe/run-340cbe86bed94153aeaff6cb5b6bfb42/result.json`.
Packaging diagnostics remain in `target/mod-manager-probe/package.log` and
`target/mod-manager-probe/package-work/mod-manager-probe/Analysis-00.toc`.
Some timing runs overlapped the package build; these are observations, not a
controlled performance benchmark.
The coordinator's independent rerun also passed all input and guard checks,
with 13.45 seconds process time and 63.55 MiB peak working set under concurrent
development load. The earlier timings are not a startup guarantee.

Bootstrap incident: the first exploratory `uv python install` invocation, before
`--no-bin --no-registry` was added, created a user-bin Python 3.14 trampoline
pointing into this experiment's private runtime. The coordinator verified its
exact hash and removed that task-created launcher. This external side effect
occurred during dependency setup, not during the guarded probe. The final
bootstrap was rerun successfully with the corrected flags.

Measured startup, peak working set and package size appear in each result's
`metrics`. They describe this machine and workload, not general performance bounds.
Process wall time includes boot/import and all fixture reads and guard checks;
it excludes parent fixture construction. No warm/cold cache claim is made.

## Decision boundary

Prefer evaluating a **narrow Rust Vortex reader** against these fixtures before
adding Python/Qt to the application. The library supplies useful metadata parsing,
but still needs our own active filtering, conservative winner resolution, private
output identification and a consistent database snapshot strategy. A full port
or a generic manager layer is not justified by this experiment.

A Python helper remains technically possible if its measured runtime and package
cost is accepted. Neither choice is production-ready: a disposable real Vortex
test must compare metadata candidates to actual deployment and verify original
archive provenance, Collection behavior, private-output installation, regeneration,
profile isolation and removal. No manager install/finalize/deploy method ran here.

The next bounded Rust experiment should consume **already acquired disposable
Vortex DB copies**, never a live profile and never the CLI as a presumed IPC API.
Allowlist active/last-active profile ID, selected Stardew profile modState,
Stardew mod installation paths/Nexus attributes/rules/fileOverrides, game path and
staging path. Do not dump whole DB values or unknown attributes. Reuse the fixture
expectations, retain `unresolved`, and keep input DB files unchanged by opening a
second disposable working copy if the native reader requires it. A deployment
manifest can cross-check deployed sources; it cannot independently establish
profile identity or recover losing community bases. No Rust reader is implemented
by this probe.

The upstream library has an MIT license; copied substantial portions require its
copyright/license notice. Its dependencies have separate licensing obligations.
Local packaging here is measurement only, not a redistribution compliance check.
