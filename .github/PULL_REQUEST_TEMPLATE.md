<!--
Keep PRs small and single-purpose (see AGENTS.md). Fill in every section.
-->

## Summary

<!-- What does this change and why? Link the issue: "Closes #123". -->

Closes #

## Changes

<!-- Bulleted list of the meaningful changes. -->

-

## Testing

<!-- How did you verify this? Paste the commands you ran. -->

- [ ] `corepack pnpm test`
- [ ] `corepack pnpm exec tsc --noEmit`
- [ ] `corepack pnpm format:check`
- [ ] `cargo test --locked` (in `src-tauri`, if backend changed)
- [ ] `cargo clippy --all-targets -- -D warnings` (in `src-tauri`, if backend changed)

## Checklist

- [ ] Change is in scope per [SPEC.md](SPEC.md) / [SCOPE_GUARDRAILS.md](SCOPE_GUARDRAILS.md).
- [ ] Updated docs / README / CHANGELOG where behavior changed.
- [ ] No secrets, game files, mods, or user data committed.
