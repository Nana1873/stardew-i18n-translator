# Documentation and Release Automation

Mechanical documentation maintenance is checked locally and by CI on the exact
`main` commit. Product decisions and release highlights still require human
review.

## Local Checks

Run the complete documentation check with:

```powershell
corepack pnpm check:docs
```

It verifies:

- the application version matches in `package.json`, Tauri, Cargo, Cargo.lock,
  the project status, and the `CHANGELOG.md` Unreleased comparison link;
- every repository-local link in tracked Markdown files resolves;
- all supported files use the configured Prettier formatting.

Set all current version references together with:

```powershell
corepack pnpm version:set 1.2.2
```

The command updates Package, Tauri, Cargo, Cargo.lock, project status, and the
Changelog comparison base. Review the release text afterward; semantic release
decisions are intentionally not generated.

## Pull Request Labels

Every pull request must have exactly one release-note classification:

- `changelog:added`
- `changelog:changed`
- `changelog:fixed`
- `changelog:security`
- `changelog:skip`

PRs labeled `documentation`, `type:enhancement`, `type:release`, or
`docs:required` must change durable documentation. Use `docs:not-required` only
when the PR explains why no documentation change is useful. Dependency PRs are
automatically labeled `changelog:skip` and `docs:not-required`.

## CI Cost Model

GitHub Actions minutes are limited. Agents and maintainers run the relevant
checks locally before pushing. The complete remote CI suite runs once after a
commit reaches `main`, which also covers direct pushes. Pull requests retain
the lightweight label/documentation policy check without repeating the full
frontend and Windows Rust suites.

Dependency audits run weekly or on explicit manual dispatch. Concurrency groups
cancel obsolete CI, audit, and pull-request policy runs.

## Generated Release Notes

GitHub uses `.github/release.yml` to group merged pull requests by their
changelog label. After the complete local release checklist passes,
`scripts/create-draft-release.ps1`:

1. verifies clean `HEAD` equals current `origin/main`;
2. verifies synchronized versions, Markdown links, formatting, and ZIP layout;
3. asks GitHub to generate categorized notes from merged pull requests;
4. prepends `docs/release/v<version>.md` when a curated highlights file exists;
5. pushes the matching tag and uploads the already verified local ZIP to a
   draft release for final human review.

`CHANGELOG.md` remains the concise, curated permanent history. Generated notes
provide the complete PR-level record without requiring it to be written by
hand.
