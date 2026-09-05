# Agent Guidance

Stardew i18n Translator is a small, local-first Windows desktop app. Keep work
proportional to that goal.

- Follow the current user request or GitHub issue. Issues, milestones, and
  formal plans are optional; do not create roadmap, walkthrough, handoff, or
  task-status files unless requested.
- Continue authorized steps without asking again. If new scope or a new target
  needs approval, or a tool or policy blocks progress, explain the concrete
  reason and respect that boundary.
- Retain concrete user ideas deferred from the current task in GitHub Issues.
  Check for duplicates, update a matching issue when possible, include brief
  context and a source reference, and link it in the reply. Do not automatically
  implement the deferred idea or create another roadmap.
- Read the relevant code before editing. Use [README.md](README.md) and the
  [user guide](docs/user-guide.md) for workflow, [SPEC.md](SPEC.md) for product
  behavior, and [CONTRIBUTING.md](CONTRIBUTING.md) for setup, architecture, test
  data, verification, and contribution conventions.
- Prefer direct changes in the existing architecture. Add an abstraction only
  when the current problem needs it; avoid generalized provider or plugin layers.
- Treat real game and Mods folders as read-only test inputs. Run writes and
  destructive tests only on synthetic fixtures or temporary copies; never
  commit user data, game assets, translations, personal paths, or credentials.
- Report changes, relevant checks, and remaining limitations in German. Keep
  code, CLI text, commits, PRs, issues, and repository documentation in English.
- For releases, follow the [release process](docs/release/release-process.md).
  Preserve an explicitly requested draft or user-test step. Labels and curated
  release notes are useful when they add value, not mandatory ceremony.
