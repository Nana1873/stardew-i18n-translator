# ADR 0001: Tech Stack Decision

- **Status:** **Accepted** — **Tauri (Rust backend + TypeScript/WebView2 frontend)**. Code freeze lifted for the chosen stack.
- **Date:** 2026-06-07 (accepted 2026-06-08)
- **Author(s):** AI Agent Architecture Group
- **Decision driver:** User prioritized **maximum performance when loading very large mods** (concrete case: Ridgeside Village). Measured reality below.

## Context

We need to choose a desktop application tech stack for the **Stardew i18n Translator**. The application must run locally on Windows (user's OS), perform fast file-system scanning on potentially large mods directories, display an interactive 2-panel string table with instant search and inline/dialog editing, and be easily maintainable by autonomous coding agents.

### Evaluation Criteria

1. **Developer Velocity:** Quick setup, hot-reloading, rich UI ecosystem, and minimal boilerplate.
2. **Portable Windows Build:** Simple build process resulting in a single executable or installer, with minimal runtime dependencies.
3. **Table/Dialog UI Capability:** Performance and ease of building high-density tables (200+ mods, 5000+ strings) and popup dialogs.
4. **File System Access:** Simple, fast, and secure API to read and write folders and JSON files on local drives.
5. **Performance:** Low memory footprint and snappy UI thread, especially during deep directory scanning and validation.
6. **Agent Friendliness:** Ease with which Google Antigravity, OpenAI Codex, and Claude Code can modify the codebase, read source files, generate tests, and execute build/lint tools.

---

## Options Considered

### Option 1: Tauri (Rust backend + Frontend)

- **Description:** A lightweight desktop framework using a Rust core and native WebViews (WebView2 on Windows) for the frontend (HTML/JS/CSS).
- **Pros:**
  - Extremely small binary sizes (< 10MB) and very low memory usage.
  - Strong security model (explicit permissions for file system access).
  - Web frontend allows utilizing modern, reactive table packages (e.g., TanStack Table) and styling tools.
  - Rust provides native file scanning speed and type safety.
- **Cons:**
  - Requires developers/agents to work across two languages (Rust and JavaScript/TypeScript).
  - Higher learning curve for agents unfamiliar with Rust ownership rules and borrow checker.
  - Compilation times are significantly slower than interpreted stacks.

### Option 2: Electron (Node.js + Chromium)

- **Description:** The industry-standard desktop framework combining Chromium and Node.js.
- **Pros:**
  - Full access to Node.js APIs directly or via IPC.
  - Massive npm ecosystem with ready-made UI components, grids, and dialogs.
  - High agent familiarity; JavaScript/TypeScript is universally supported and understood by coding models.
  - Rapid development velocity and excellent debugging tools.
- **Cons:**
  - Very large binary sizes (> 80MB) and high RAM consumption.
  - Security concerns (requires careful configuration of context isolation and preload scripts).
  - Performance can degrade with very large datasets if the DOM is not virtualized.

### Option 3: Python + PySide6 (Qt)

- **Description:** Native desktop binding for Qt 6 using Python.
- **Pros:**
  - Python has excellent readability and agent developer velocity.
  - Native Qt widgets (QTableView, QDialog) are highly performant and handle thousands of rows natively with model-view architecture.
  - Single-language codebase.
  - Easy packaging with PyInstaller.
- **Cons:**
  - Qt styling can feel outdated or require significant CSS/QSS styling effort to look premium.
  - PyInstaller executables can trigger antivirus false positives.
  - Python packaging and virtual environment management can be brittle for agents across different platforms.

---

## Measured workload reality (why performance is the deciding factor)

The user's stated priority is performance on very large mods. Measured against a real install of **Ridgeside Village**:

| File                                       | Size       | Keys        | Notes                                                                       |
| ------------------------------------------ | ---------- | ----------- | --------------------------------------------------------------------------- |
| `[CP] Ridgeside Village/i18n/default.json` | **2.4 MB** | **~17,522** | **Relaxed JSON** with `/* … */` block comments (strict `JSON.parse` fails). |
| `RidgesideVillage/i18n/default.json`       | 23 KB      | ~212        |                                                                             |

So **one** mod ≈ 17.5k strings — ~3.5× the SPEC's "5000+" planning figure. A power user with several such content packs plus a 200-mod folder realistically holds **100k–500k** string objects (each carrying status, tokens, source hash, validation issues) in app state. At that scale the differentiators are **cold-scan/parse speed**, **filter/sort over tens of thousands of rows**, and **resident memory** — precisely where the stacks diverge.

## Decision

**Tauri (Rust backend + TypeScript/WebView2 frontend).** The performance-critical path — recursive mod scan, relaxed-JSON parsing of multi-MB files, token validation, and filter/sort over very large string sets — runs in **Rust**; a **React + TypeScript** WebView2 UI receives only the virtualized slice it renders, using **TanStack Table + TanStack Virtual** for both the dense string table and the package tree. `tauri-plugin-dialog` for folder pickers; Tauri bundler for the small portable Windows build.

### Decision Summary vs Criteria

| Criterion                                          | Tauri ✅                                                                                              | Electron                                                  | Python + PySide6                         |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------- |
| **Perf & memory @ 17.5k+ strings / 100k+ total**   | **Best** (Rust data layer, leanest RAM, only visible rows in UI)                                      | Weakest (Chromium per-object heap, all row objects in JS) | Strong (native Qt model/view)            |
| Cold scan + relaxed-JSON parse of multi-MB files   | **Best** (Rust + `serde`/`jsonc`)                                                                     | Good (Node)                                               | Good (Python)                            |
| Dense table/dialog UI                              | High (web grids, virtualized)                                                                         | High (web grids)                                          | High (native QTableView)                 |
| Context menus & shortcuts                          | High                                                                                                  | High                                                      | High                                     |
| Portable Windows build                             | **Best** (small binary)                                                                               | Medium (80–150 MB)                                        | Medium (PyInstaller, AV false positives) |
| File-system access                                 | High (Rust)                                                                                           | High (Node)                                               | High                                     |
| Long-term maintainability                          | Medium (Rust+TS split)                                                                                | High (one language)                                       | Medium                                   |
| Ease of testing                                    | High (cargo test + vitest)                                                                            | High (vitest)                                             | High (pytest)                            |
| Agent-friendliness (Antigravity/Codex/Claude Code) | Medium–High (Rust + TS; both well-supported)                                                          | Highest (TS only)                                         | Medium                                   |
| Risk of overengineering                            | Medium (FFI boundary)                                                                                 | Low                                                       | Low                                      |
| **Reuse of old-project assets**                    | **Broadest** (Rust `parser.rs`/`validator.rs`/`models.rs` **and** TS frontend logic **and** fixtures) | TS frontend logic + fixtures only                         | None (all discarded)                     |
| Already proven on this machine                     | **Yes** (old project = Tauri 2)                                                                       | No                                                        | No                                       |

### Why Tauri

1. **Best on the deciding axis.** Rust does the scan/parse/validate/filter; only rendered rows cross into WebView2. This gives the lowest resident memory and fastest cold scan for 17.5k-string mods and 100k+-string sessions — the user's explicit priority.
2. **Broadest reuse.** The private legacy Tauri 2 project already had Rust
   parsing/validation logic, TypeScript domain/export logic, and parser
   fixtures. Tauri allowed reuse on both sides; Electron would reuse only the
   TypeScript, and PySide6 none. (Keep the logic, not the old over-abstracted
   "studio" design.)
3. **Smallest portable build.** Tauri produces a small Windows binary with no Chromium bundle and no PyInstaller AV-false-positive risk — best on "portable Windows build."
4. **Already validated here.** The Rust/Node toolchain is installed and the old Tauri 2 project builds on this machine, removing environment risk.
5. **Relaxed-JSON handled natively.** Real mods use comments/trailing commas (confirmed in Ridgeside Village); Rust (`jsonc`/comment-stripping + `serde_json`) parses these fast on the worker side.

### Why not the others

- **Electron + TypeScript:** Best single-language velocity and TS reuse, but **weakest on the user's stated priority** — Chromium holds every row object on the JS heap, so a 100k+-string session carries far higher resident memory than Rust or native Qt. Strong runner-up if priorities were velocity over scale, but they are not.
- **Python + PySide6 (SSE-AT's stack):** Genuinely excellent native tables at scale and proven by SSE-AT, but it **discards all reusable old-project code** (both Rust and TS), has brittle distribution (PyInstaller AV/venv issues — hurts "portable Windows build"), and lower agent velocity. Its native-table edge is matched in practice by a virtualized web grid backed by a Rust data layer, so it does not outweigh the reuse/packaging losses.

## Consequences

- **Positive:** Best performance and lowest memory for very large mods; broadest reuse (Rust hot path + TS UI logic + fixtures); smallest portable binary; environment already proven; relaxed-JSON parsing handled in Rust.
- **Negative / trade-offs:** Two languages (Rust + TypeScript) with an IPC boundary — slightly higher agent friction than a TS-only stack and slower compile times than interpreted stacks. Mitigated by keeping the boundary thin: Rust owns data/IO, TS owns UI, with a small typed command surface.
- **Risks:** (1) FFI boundary tempting premature abstraction — mitigated by SPEC §19 (no provider/plugin systems) and a minimal Tauri command set. (2) Rust learning curve for some agents — mitigated by reusing the old project's Rust parser/validator as the starting point and isolating Rust to data/IO. (3) Keep the WebView string table **virtualized** (TanStack Virtual) and lazy-load per-mod string data on selection (SPEC §7.4 shows one mod/file at a time) so the UI never materializes all rows at once.

## Resolved Implementation Choices

The ADR's pre-scaffolding questions, resolved 2026-06-08 so M1 starts without re-litigation:

1. **Renderer → React + TypeScript** _(deliberate trade-off, confirmed 2026-06-08)_. Largest ecosystem, strongest agent (Antigravity/Codex/Claude Code) familiarity, first-class grid bindings. React is the _heaviest_ modern framework (VDOM/reconciliation); SolidJS and Svelte were evaluated as leaner, VDOM-free alternatives. React was chosen **knowing this**, because performance here is delivered by the **architecture, not the framework**: the Rust backend owns all heavy work, the grid is virtualized (~30–50 DOM rows at a time), and per-mod string data is lazy-loaded (§7.4). **Performance guardrails M1 must honor so React never touches the hot path:** (a) virtualize every large list/grid; (b) lazy-load string data per selected mod, never hold all mods' strings in the renderer; (c) memoize filter/derived state and keep bulk ops (Ctrl+A on 17k rows, mass status changes) and live validation off the render loop. If a renderer bottleneck ever appears despite these, SolidJS is the pre-vetted escape hatch (same TS+JSX, same TanStack adapters).
2. **Grid → TanStack Table + TanStack Virtual (MIT).** Must drive **both** a virtualized flat grid (string table, 17k+ rows) **and** a virtualized expandable tree (mod list grouped by package, §7.3). TanStack does both (expanding sub-rows + virtual rows) under MIT. **AG Grid is ruled out:** its Tree Data / Row Grouping are **Enterprise (paid)** features — unacceptable for a free local tool — even though AG Grid Community has row virtualization.
3. **Frontend package manager → pnpm.** Already the project convention (lockfile carried from the old repo), fast and disk-efficient; agents handle it fine.

## Open Questions

1. **Rust reuse depth:** decide in M1 how much of the old `parser.rs` / `validator.rs` to port directly vs. rewrite to the trimmed v1 scope (4 rules, flat i18n only).
