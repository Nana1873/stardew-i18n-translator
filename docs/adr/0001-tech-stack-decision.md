# ADR 0001: Tech Stack Decision

* **Status:** Draft
* **Date:** 2026-06-07
* **Author(s):** AI Agent Architecture Group

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

* **Description:** A lightweight desktop framework using a Rust core and native WebViews (WebView2 on Windows) for the frontend (HTML/JS/CSS).
* **Pros:**
  * Extremely small binary sizes (< 10MB) and very low memory usage.
  * Strong security model (explicit permissions for file system access).
  * Web frontend allows utilizing modern, reactive table packages (e.g., TanStack Table) and styling tools.
  * Rust provides native file scanning speed and type safety.
* **Cons:**
  * Requires developers/agents to work across two languages (Rust and JavaScript/TypeScript).
  * Higher learning curve for agents unfamiliar with Rust ownership rules and borrow checker.
  * Compilation times are significantly slower than interpreted stacks.

### Option 2: Electron (Node.js + Chromium)

* **Description:** The industry-standard desktop framework combining Chromium and Node.js.
* **Pros:**
  * Full access to Node.js APIs directly or via IPC.
  * Massive npm ecosystem with ready-made UI components, grids, and dialogs.
  * High agent familiarity; JavaScript/TypeScript is universally supported and understood by coding models.
  * Rapid development velocity and excellent debugging tools.
* **Cons:**
  * Very large binary sizes (> 80MB) and high RAM consumption.
  * Security concerns (requires careful configuration of context isolation and preload scripts).
  * Performance can degrade with very large datasets if the DOM is not virtualized.

### Option 3: Python + PySide6 (Qt)

* **Description:** Native desktop binding for Qt 6 using Python.
* **Pros:**
  * Python has excellent readability and agent developer velocity.
  * Native Qt widgets (QTableView, QDialog) are highly performant and handle thousands of rows natively with model-view architecture.
  * Single-language codebase.
  * Easy packaging with PyInstaller.
* **Cons:**
  * Qt styling can feel outdated or require significant CSS/QSS styling effort to look premium.
  * PyInstaller executables can trigger antivirus false positives.
  * Python packaging and virtual environment management can be brittle for agents across different platforms.

---

## Decision

*Pending review and approval.* No stack has been selected yet. 

Once approved by the user, this ADR will be updated with the chosen option, its justification, and the status changed to `Accepted`.

## Consequences

*To be completed after decision.*

## Open Questions

1. Which stack is preferred by the user for local setup and dev execution?
2. Are there pre-existing local tooling dependencies (such as Node.js, Python, or Rust) that we should favor or avoid?
