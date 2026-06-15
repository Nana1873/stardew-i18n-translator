# Project Status

This document summarizes the shipped product. Active work is tracked in
[GitHub Issues](https://github.com/Nana1873/stardew-i18n-translator/issues),
grouped by
[GitHub Milestones](https://github.com/Nana1873/stardew-i18n-translator/milestones).
Those GitHub views are the source of truth for current status and priorities.
See [Planning and Status](planning.md) for the maintenance convention.

## Implemented

- Setup and scan: portable settings, Stardew auto-detection, recursive mod
  scanning, package grouping, and SMAPI i18n import.
- Editing and validation: virtualized string table, four-state workflow,
  protected-token validation, glossary hints, bulk actions, and Keep original.
- Export: selected-mod and Export All workflows, key-order preservation,
  backups, atomic writes, overwrite confirmation, and summaries.
- Local AI: optional localhost OpenAI-compatible connection, single-string and
  batch translation, glossary/context prompts, retry, and review-needed output.
- External LLM batches: self-contained JSON export and guarded result import.
- Translation release workflow: persistent results, installable
  package-preserving ZIPs, and short localized translation notes.
- Portable Windows packaging: executable and all user state in the adjacent
  `Data/` directory.

## Release State

- Latest release: 1.3.0.
- The completed translation release workflow is grouped under the
  [v1.3.0 milestone](https://github.com/Nana1873/stardew-i18n-translator/milestone/4).
- Nexus discovery is deferred indefinitely. The related issues remain in the
  unmilestoned backlog with the `status:deferred` label.
- Build and publication instructions are in
  [`docs/release/release-process.md`](../release/release-process.md).

## Engineering References

- [`SPEC.md`](../../SPEC.md)
- [`SCOPE_GUARDRAILS.md`](../../SCOPE_GUARDRAILS.md)
- [`docs/adr/0001-tech-stack-decision.md`](../adr/0001-tech-stack-decision.md)
- [`docs/agents/`](../agents/)
- [`docs/research/`](../research/)
- [`docs/development/planning.md`](planning.md)
