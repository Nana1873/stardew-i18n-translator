# AI Agent Instruction Manual

Welcome! You are an autonomous coding agent participating in the development of **Stardew i18n Translator**.

To ensure consistency, code quality, and strict scope control, you MUST follow these guidelines on every invocation.

---

## 1. Rules of Engagement

- **Read First:** Before modifying any files or proposing designs, you must read:
  1. [SPEC.md](SPEC.md) (The feature source of truth)
  2. [SCOPE_GUARDRAILS.md](SCOPE_GUARDRAILS.md) (Strict boundaries)
  3. The assigned GitHub issue, including its milestone, labels, dependencies,
     and acceptance criteria.
- **Single-Issue Focus:** Work only on the assigned GitHub issue. Do not attempt to fix unrelated bugs, implement unrelated features, or execute general refactoring unless it is explicitly requested in the active issue.
- **No Scope Creep:** Do not implement work assigned to a different issue or
  future release milestone. If you find yourself building something not in
  [SPEC.md](SPEC.md), stop immediately.
- **Stack is Fixed:** The tech stack is decided and accepted — Tauri (Rust backend + TypeScript/React frontend), see [ADR 0001](docs/adr/0001-tech-stack-decision.md). Do not introduce other frameworks (Electron, PySide, etc.) or swap core dependencies without a new ADR.
- **Propose Plans:** For any task that isn't trivially simple, outline the proposed changes before editing. Keep active task status in the GitHub issue rather than creating repository-local plan files.

## 2. Commit and Code Hygiene

- **Small, Scoped Commits:** Prefer small, logical commits (e.g., one commit per subtask/issue). Do not lump multiple issues or refactors into a single massive commit.
- **Test-Driven / Test-Verified:** Every implementation task must include unit/integration tests or a clear, documented explanation of why automated testing is impossible for that component.
- **Document Changes:** Update corresponding markdown files, ADRs, or README files when your implementation changes documented behavior.
- **Scope Changes Require Approval:** If you believe an issue or GitHub milestone is blocking progress or has technical flaws, do not change it on your own. Present the issue to the user and request updated parameters.

## 3. Data and Security Guardrails

To prevent leaks and copyright issues, **do not check in or commit** the following:

- API keys, tokens, or credentials of any kind.
- Local Stardew Valley game files, executables, or unpacked game assets.
- Third-party mod archives (.zip, etc.) or unpacked mod directories (except minimal test fixtures under `tests/fixtures/`).
- Generated glossary JSON/CSV databases or local user application data folders.

## 4. Handoff Procedure

At the end of every completed task or session, you **MUST** write a brief handoff summary at the bottom of your final response, using the format in [handoff-template.md](docs/agents/handoff-template.md):

1. **Task / Issue:** The name/number of the issue you worked on.
2. **Summary:** Brief description of what was done.
3. **Files Changed:** A bulleted list of file paths.
4. **Tests Run:** How you verified the changes (commands, results).
5. **Decisions Made:** Key design or implementation choices.
6. **Deviations from SPEC:** Any necessary deviations or workarounds.
7. **Blockers:** Any current blockers or open questions.
8. **Recommended Next Step:** The logical next issue/task for the next agent.
