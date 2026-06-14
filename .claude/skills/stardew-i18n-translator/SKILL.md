---
name: stardew-i18n-translator
description: Develop, review, test, package, or release the Stardew i18n Translator repository. Use for implementation, bug fixes, UI work, Rust/Tauri changes, pull requests, roadmap updates, release preparation, and repository cleanup in this project.
---

# Stardew i18n Translator

Work as a scoped maintainer of the Tauri, Rust, TypeScript, and React application.

## Establish context

1. Confirm the repository root and inspect `git status` before acting.
2. Read `AGENTS.md`, `SPEC.md`, and `SCOPE_GUARDRAILS.md`.
3. Identify the active GitHub issue or requested task. Read its release
   milestone, acceptance criteria, dependencies, and any linked ADR or research
   document.
4. Read the surrounding implementation and tests before proposing or editing.
5. For a non-trivial task, state a short implementation plan before edits.

Treat `SPEC.md` as the feature authority. Do not silently expand the active
issue or release milestone. In particular, do not add themes, arbitrary
language codes, cloud credentials, mod-manager behavior, or future Nexus
functionality before its approved GitHub milestone.

## Protect user work and data

- Never discard, overwrite, stage, or include unrelated working-tree changes.
- If local experiments overlap the requested branch, use a clean Git worktree
  from the intended base commit.
- Never inspect, modify, package, or commit real game files, Mods folders,
  archives, application data, credentials, personal email addresses, or local
  absolute paths.
- Use only sanitized fixtures under `tests/fixtures/`.
- Keep the app portable: application state belongs beside the executable in
  `Data/`, and release archives must contain no user data.

## Implement conservatively

- Follow existing architecture and naming before adding abstractions.
- Keep changes limited to the active issue and update documentation when
  behavior changes.
- Preserve the fixed Tauri/Rust plus TypeScript/React stack.
- Add focused tests for changed behavior. Explain only when automation is
  genuinely impractical.
- Keep SMAPI protected tokens and JSON key order intact where applicable.
- Treat the glossary as optional and external/local AI output as review-needed.

## Verify

Choose checks based on the changed surface, then broaden for shared behavior:

```powershell
corepack pnpm exec tsc --noEmit
corepack pnpm test
corepack pnpm check:docs
Push-Location src-tauri
cargo fmt --check
cargo clippy --locked --all-targets --profile ci -- -D warnings
cargo test --locked --profile ci
Pop-Location
```

For frontend behavior, run the relevant preview or app and verify the changed
workflow visually. For packaging or release work, read
`docs/release/release-process.md` and follow it exactly.

## GitHub and releases

- Review diffs, CI, dependencies, and unresolved comments before merging.
- Keep commits and pull requests small and issue-focused.
- Give every pull request exactly one `changelog:*` label. Add
  `docs:not-required` only when the PR explains why durable docs are unchanged.
- Build releases only from the clean, current `main` commit.
- Use `corepack pnpm version:set <version>` instead of editing version sources
  separately.
- Ensure all version sources and release notes agree before tagging.
- Let GitHub generate categorized PR notes; keep `CHANGELOG.md` concise and
  curated.
- Verify the portable ZIP structure and absence of user data.
- Create a draft release through the documented workflow. Do not publish it
  without explicit human approval.

## Finish

Recheck `git status`, report tests and any residual risk, and use the eight-part
handoff format from `docs/agents/handoff-template.md`.
