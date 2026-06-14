# Planning and Status

GitHub is the source of truth for active work:

- [Issues](https://github.com/Nana1873/stardew-i18n-translator/issues) define
  one actionable task, its acceptance criteria, dependencies, and discussion.
- [Milestones](https://github.com/Nana1873/stardew-i18n-translator/milestones)
  group approved work by target release.
- Pull requests close issues and provide the implementation and verification
  record.

Repository documentation has a different purpose:

- `SPEC.md` defines product behavior and durable scope.
- `SCOPE_GUARDRAILS.md` defines boundaries and non-goals.
- `docs/adr/` records architecture decisions.
- `docs/research/` preserves technical findings.
- `docs/release/` and `CHANGELOG.md` preserve release history.
- `docs/agents/` contains reusable workflows, not task status.

Mechanical documentation and release checks are described in
[`documentation-automation.md`](documentation-automation.md).

Do not create repository-local milestone, roadmap, checklist, or implementation
plan files to mirror GitHub issue status. A substantial design decision may
still require an ADR or research note, linked from the owning issue.

## Issue Lifecycle

1. Triage the issue against the SPEC and guardrails.
2. Assign a release milestone only when the work is approved for that release.
3. Keep implementation discussion and dependency links on the issue.
4. Reference the issue from the pull request with `Closes #<number>`.
5. Let the merged pull request close the issue; close the release milestone
   after all included issues and release checks are complete.

Unscheduled ideas remain open without a milestone. A milestone is a release
commitment, not a general theme or permanent backlog category.
