# Project Status

This document preserves the implementation-oriented status information that
previously lived in the public README.

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
- Portable Windows packaging: executable and all user state in the adjacent
  `Data/` directory.

## Release State

- Application version: 1.1.0.
- v1 milestones M1-M4 and M6 are complete.
- M5 Nexus translation discovery remains deferred.
- The active next-version plan is in
  [`docs/roadmap/v1.1-candidates.md`](../roadmap/v1.1-candidates.md).
- Build and publication instructions are in
  [`docs/release/release-process.md`](../release/release-process.md).

## Engineering References

- [`SPEC.md`](../../SPEC.md)
- [`SCOPE_GUARDRAILS.md`](../../SCOPE_GUARDRAILS.md)
- [`docs/adr/0001-tech-stack-decision.md`](../adr/0001-tech-stack-decision.md)
- [`docs/milestones/`](../milestones/)
- [`docs/agents/`](../agents/)
