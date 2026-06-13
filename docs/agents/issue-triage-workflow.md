# Issue Triage & Fix Workflow (for AI Agents)

This describes how an AI coding agent should pick up a reported bug and fix it.
It assumes you have already read [AGENTS.md](../../AGENTS.md) — its rules of
engagement, hygiene, and handoff format are mandatory.

Bug reports are filed through the structured form
([`.github/ISSUE_TEMPLATE/bug_report.yml`](../../.github/ISSUE_TEMPLATE/bug_report.yml)),
so every issue should already contain: app version, Windows version, affected
area, what happened, reproduction steps, expected behavior, the exact on-screen
error message, and optionally a minimal sample input.

> **Use the local diagnostic log when available.** Ask the reporter to open
> **Settings -> About -> Open logs folder**, sanitize the newest log, and attach
> it with the on-screen error text, reproduction steps, and any minimal sample
> `i18n` / LLM-batch JSON.

## 1. Understand and confirm scope

1. Read the issue's structured fields end to end.
2. Map the **Affected area** to the owning module:
   - Mod scanning → [`src-tauri/src/scanner.rs`](../../src-tauri/src/scanner.rs)
   - Token / quality validation → [`src-tauri/src/tokens.rs`](../../src-tauri/src/tokens.rs),
     [`src/strings/validation.ts`](../../src/strings/validation.ts),
     [`src/strings/protectedTokens.ts`](../../src/strings/protectedTokens.ts)
   - Export → [`src-tauri/src/export.rs`](../../src-tauri/src/export.rs)
   - Local AI → [`src-tauri/src/llm.rs`](../../src-tauri/src/llm.rs)
   - External LLM batch → [`src-tauri/src/batch.rs`](../../src-tauri/src/batch.rs),
     [`src/llm-batch/`](../../src/llm-batch/)
   - Glossary → [`src-tauri/src/glossary.rs`](../../src-tauri/src/glossary.rs)
   - Settings / shortcuts → [`src-tauri/src/settings.rs`](../../src-tauri/src/settings.rs),
     [`src/settings/`](../../src/settings/), [`src/shortcuts.ts`](../../src/shortcuts.ts)
   - Setup wizard / detection → [`src/setup/`](../../src/setup/),
     [`src-tauri/src/detection.rs`](../../src-tauri/src/detection.rs)
3. Confirm the fix is in scope per [SPEC.md](../../SPEC.md) and
   [SCOPE_GUARDRAILS.md](../../SCOPE_GUARDRAILS.md). If it is really a feature
   request or out of scope, say so on the issue instead of implementing it.

## 2. Reproduce with a failing test

1. Turn the reported reproduction into a **failing automated test** before
   touching production code:
   - Backend logic → a `#[test]` next to the relevant Rust module.
   - Frontend logic → a vitest test under `src/`.
   - Parser/token cases → consider a fixture under
     [`tests/fixtures/`](../../tests/fixtures/).
2. Use the reporter's sample input (sanitized) as the test input where possible.
3. If you genuinely cannot reproduce, do not guess a fix — post on the issue
   what you tried and what additional detail you need.

## 3. Fix, minimally

1. Make the smallest change that turns the failing test green.
2. Stay inside the owning module; do not refactor unrelated code.
3. Preserve invariants the codebase already guards, e.g. exact protected-token
   counts, atomic writes with backups, `http(s)`-only URL/endpoint validation,
   and AI output always landing as `review-needed`.

## 4. Verify

Run the same checks CI enforces:

```powershell
corepack pnpm exec tsc --noEmit
corepack pnpm test
corepack pnpm format:check
# if src-tauri changed:
cd src-tauri; cargo fmt --check; cargo clippy --all-targets -- -D warnings; cargo test --locked
```

## 5. Document and hand off

1. Update the README / relevant docs / [CHANGELOG.md](../../CHANGELOG.md) if
   behavior changed.
2. Reference the issue in the PR (`Closes #<n>`) and fill in the PR template.
3. End your session with the handoff summary from
   [handoff-template.md](handoff-template.md).
