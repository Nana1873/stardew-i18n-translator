# Documentation and Release Automation

Mechanical documentation maintenance is enforced by CI. Product decisions and
release highlights still require human review.

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

## Generated Release Notes

GitHub uses `.github/release.yml` to group merged pull requests by their
changelog label. When a matching `v*` tag is pushed, the release workflow:

1. verifies the tag, synchronized versions, Markdown links, and formatting;
2. builds and packages the portable application;
3. asks GitHub to generate categorized notes from merged pull requests;
4. prepends `docs/release/v<version>.md` when a curated highlights file exists;
5. creates a draft release for final human review.

`CHANGELOG.md` remains the concise, curated permanent history. Generated notes
provide the complete PR-level record without requiring it to be written by
hand.
