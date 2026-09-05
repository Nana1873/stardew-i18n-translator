# Standalone Rust Vortex snapshot probe

Last bounded library-feasibility experiment for #225. No app integration, live
Vortex access, profile switching, deployment, Collection mutation, or MO2 support.

## Reproduce

Windows PowerShell 7 and a Rust MSVC toolchain are required. Tested with Rust
1.96.0. Run from the repository root:

```powershell
& scripts/vortex-state-probe/build.ps1
& scripts/vortex-state-probe/verify.ps1
```

The default synthetic fixture is the prior Python experiment's retained input:
`target/mod-manager-probe/run-340cbe86bed94153aeaff6cb5b6bfb42/input`.
It contains a native `plyvel-next` LevelDB log database and sibling native SST
database under that run's `scratch/appdata/Vortex/state.v2`. Neither is opened
by a database library or modified in place. A different prior synthetic run can
be selected with `verify.ps1 -Fixture <repository-relative-input-directory>`.
The fixture must have both native databases and the same synthetic cases.
The Python fixture generator is a test-data prerequisite only; Python is not
used by this executable or the verification script.

`CARGO_HOME`, build outputs, snapshots, intentional fault injection and reports
stay under ignored `target/vortex-state-probe/`. This independent Cargo package
and its lockfile do not modify the application Cargo dependencies. The current
checkout location is compiled into the fixture allowlist; this is a local
experiment, not a relocatable production helper accepting arbitrary user paths.

The release executable is
`target/vortex-state-probe/build/release/vortex-state-probe.exe`.
Direct invocation:

```powershell
target/vortex-state-probe/build/release/vortex-state-probe.exe target/mod-manager-probe/run-340cbe86bed94153aeaff6cb5b6bfb42/input
```

It emits a small JSON result pointer and metrics. Full **allowlisted** output is
in a fresh `target/vortex-state-probe/run-<id>/result.json`. Failures emit a
sanitized JSON error on stderr and exit 1; post-read failures also retain
`failure.json` with input-integrity evidence. No complete database dump is emitted.
`verify.ps1` records all cases in `target/vortex-state-probe/verification.json`.

## Reader choice and contract

[rusty-leveldb 4.0.1](https://docs.rs/rusty-leveldb/4.0.1/rusty_leveldb/)
is MIT-licensed and implemented in Rust. Official crate source was checked before
selection. It supports the exercised native log/SST data and Snappy compression.
The executable has no Python, Qt or native LevelDB runtime dependency. Its PE
imports are Windows system APIs and the Microsoft C runtime.

Only these key families are retained:

- Active profile and last-active Stardew profile IDs.
- Profile game identifiers and modState enabled flags; only Stardew profiles
  reach output. Profile names are read but not emitted.
- Stardew mod installationPath/type, Nexus modId/fileId/fileName/version/
  downloadGame, rules and fileOverrides.
- Stardew game path and staging path.

Unknown database fields are skipped before JSON parsing. Rule output is projected
to type, reference ID and fileExpression, never arbitrary nested attributes.
The sentinel test confirms an unknown privateToken attribute is not emitted.
Paths from the DB are metadata; actual file reads use our copied fixture staging
directory. Absolute/rooted or parent-traversing installation paths and reparse
points are rejected. Synthetic inputs are limited to 64 MiB, metadata values to
1 MiB and iteration to 50,000 keys. These are fixture bounds, not a production
database safety specification.

For each profile the result includes active IDs/Nexus metadata and a candidate
winner and community base for each file. The explicit fixture ID `own-output`
is excluded from the base, and disabled candidates are filtered before resolving.
Exact-ID/exact-fileExpression before/after rules and fileOverrides are supported
only within the exercised subset. Ambiguous expressions, unsupported rules,
cycles and unordered multiple candidates remain `unresolved`. A nonempty mod
type (including Collection/root types) currently rejects the probe; no game-
specific installation or Collection semantics are inferred.

**Candidates are not proof of what is deployed.** Production output identity,
SMAPI UniqueID/physical-archive mapping, arbitrary Vortex reference matching,
and consistency between selected, active and deployed profiles remain unproved.
An active/last-active disagreement fails visibly; the probe never selects or
switches the manager's profile.

## Verified results and limits

On September 5, 2026, Windows 11 x64:

| Case                                | Result                                                                |
| ----------------------------------- | --------------------------------------------------------------------- |
| Native log snapshot                 | Expected two profiles, IDs, current/base winners and unresolved cases |
| Native SST snapshot                 | Same expected results                                                 |
| Unknown metadata field              | Ignored; sentinel absent from output                                  |
| Invalid CURRENT                     | Visible database-open failure                                         |
| Truncated native SST                | Visible iteration failure                                             |
| Invalid JSON                        | Visible metadata-parse failure                                        |
| Invalid enabled value               | Visible unsupported-state failure                                     |
| Parent-traversing installation path | Visible path failure before access                                    |

All eight cases preserve hashes of the original fixture, immutable copied input,
and original database source. Database opens and intentional fault writes target
only the second working copy. Working database files change even during successful
reads; a zero-write promise for live database access would be incorrect.

Observed release executable size is **1,110,016 bytes (1.06 MiB)**. In the final
verification, successful child processes took **0.10–0.19 seconds including
snapshot copying and hashing**, with **0.009–0.011 seconds** in DB reading and
projection. Earlier development runs took 2–3 seconds total and 0.2–0.4 seconds
in the reader; the substantial variation prevents a cold-start performance claim.
The final sampled peak working set was **5.8–6.7 MiB**. Verification samples
process memory every 20 ms; timings are machine-specific observations, not a
controlled cold-start benchmark. Exact latest values are in `verification.json`.
An independent coordinator rerun passed all eight cases; its successful runs
took 0.48–0.83 seconds with about 6.7 MiB sampled peak working set.
Release build, `cargo fmt`, `cargo clippy --locked --release -- -D warnings` and
the executable verification cases were run. This is an executable feasibility
result, not a production build or a published artifact.

**Crate approval remains open.** Upstream `Options` documents a compressor-mismatch
hazard; this probe explicitly selects Snappy for its known fixture. The iterator
API does not expose a complete error status, and `table_reader.rs` skips some
block errors. Fallible `get_at`, schema checks and these corruption cases help,
but do not prove that every corrupt or incomplete snapshot fails closed. Fixture
expectations can detect missing fixture records; a real reader cannot rely on
knowing all expected records in advance. Production use needs a reader/error
propagation solution that detects partial reads rather than silently omitting mods.

## Recommendation

The narrow Rust approach is feasible and substantially smaller than the tested
Python/Qt package. Reuse the field contract and fixture expectations for a
bounded application change; do not port mod-manager-lib or add a provider layer.
Do not adopt this crate unchanged as a trusted production snapshot reader until
its partial-read/compression limitations are resolved.

The next integration prerequisite is a consistent, disposable snapshot acquired
without touching a live manager DB. The current Vortex CLI is not assumed to be
live IPC. A deployment manifest can cross-check deployed source files, but cannot
replace profile identity or recover losing community bases. Real installation,
Collection provenance, private-output install/deploy/rebuild/remove and profile
isolation still require a disposable practical Vortex test. None ran here.

No releases, tags, commits, uploads or application dependencies are changed by
these scripts. Existing publication restrictions remain in force.
