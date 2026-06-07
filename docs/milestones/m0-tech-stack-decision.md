# Milestone M0: Tech Stack Decision

## Goal
Establish a firm, approved tech stack and set up repository-wide governance rules for AI coding agents before any application code is written.

## Scope
* Technical evaluation of desktop frameworks (Tauri, Electron, PySide6).
* Consensus on package manager, linting, testing, and formatting standards.
* Writing contribution guidelines, folder layouts, and security policies.
* Merging and accepting ADR 0001.

## Out of Scope
* Any application code implementation.
* Scaffolding directories or packages for the chosen framework.
* Writing unit tests for application code.

## Acceptance Criteria
1. ADR 0001 is updated with the selected option and marked as `Accepted`.
2. Contribution rules for AI agents (`AGENTS.md`) are agreed upon and pushed to `main`.
3. Workspace is clean of any stray scaffolded directories.

## Risks
* **Analysis Paralysis:** Spending too much time debating stack choices. (Mitigation: Bound stack choices to Tauri, Electron, or PySide6).
* **Agent Environment Mismatch:** Choosing a stack that cannot run or build in the sandbox. (Mitigation: Run diagnostic tests on build tools first).

## Suggested Issue Breakdown

### Issue 1: Decide tech stack via ADR 0001
* **Goal:** Research, evaluate, and choose Tauri, Electron, or Python+PySide6. Update ADR 0001.
* **Suggested Agent:** Antigravity (planning-heavy, comparison work).

### Issue 2: Define contribution and scope rules for AI agents
* **Goal:** Finalize `AGENTS.md` and `SCOPE_GUARDRAILS.md` to ensure all subsequent runs adhere to the strict scope.
* **Suggested Agent:** Codex or Claude Code.

## Agent Handoff Notes
*Ensure ADR 0001 is fully accepted and signed off by the user before transitioning to Milestone M1.*
