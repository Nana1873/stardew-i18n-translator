# Release Process

This is the maintainer workflow for publishing the Windows application. For
development setup and ordinary contributions, see
[CONTRIBUTING.md](../../CONTRIBUTING.md).

## Prerequisites

Use the Windows build tools and dependencies described in
[CONTRIBUTING.md](../../CONTRIBUTING.md), plus:

- GitHub CLI (`gh`), authenticated with permission to create tags and releases
  in `Nana1873/stardew-i18n-translator`;
- `cargo-audit`, installed with `cargo install cargo-audit --locked`;
- a clean checkout of the current `main` branch with release changes already
  integrated before the final build.

Commands below run from the repository root in PowerShell.

## Package

The supported release artifact is a 64-bit portable Windows ZIP:

`Stardew-i18n-Translator_<version>_windows-x64-portable.zip`

It contains exactly:

```text
Stardew i18n Translator/
|-- stardew-i18n-translator.exe
`-- README.txt
```

User settings and translation work are created later in the adjacent `data/`
folder and are never included in the release archive.

## Release Text

`CHANGELOG.md` is the permanent history. The GitHub release body should be a
short summary, not a second changelog.

A curated file at `docs/release/v<version>.md` is preferred. Keep it to:

- one opening sentence;
- roughly three to six user-facing bullets;
- an **Upgrade** section only when the user must do something.

Do not repeat unchanged installation steps, privacy/local-first statements,
verification boilerplate, internal CI work, or a list of merged pull requests.

When a curated file exists, the release script uses only that file. Otherwise it
falls back to GitHub-generated notes. It never combines both.

## Prepare a Release

1. Update the version:

   ```powershell
   corepack pnpm version:set <version>
   ```

   Update `CHANGELOG.md` and, when useful, add the concise curated release file
   described above.

2. Check the changes, commit them, and integrate them into `main` using the
   normal contribution workflow. Update the local `main` checkout to the latest
   `origin/main` and ensure it is clean. The following checks and final build
   must use that checkout; if release code changes afterward, repeat them.

3. Run the complete frontend, documentation, dependency, and Rust checks:

   ```powershell
   corepack pnpm typecheck
   corepack pnpm test
   corepack pnpm check:docs
   corepack pnpm audit --prod

   Push-Location src-tauri
   cargo fmt --check
   cargo clippy --locked --all-targets --profile ci -- -D warnings
   cargo test --locked --profile ci
   cargo audit
   Pop-Location
   ```

4. Build and package the portable app freshly from that verified checkout:

   ```powershell
   corepack pnpm tauri build --no-bundle
   powershell -File scripts/package-portable.ps1
   ```

   Packaging rejects an executable whose embedded product version is missing
   or differs from `package.json`, before replacing existing package files.
   A matching version does not establish which commit built an executable, so
   do not reuse an earlier build just because it has the same version.

5. Test the actual ZIP when the release changes startup, persistence, scanning,
   editing, glossary handling, or export. The
   [automated Windows desktop workflow](../testing/desktop-e2e.md) validates and
   extracts it, runs the real app/backend with synthetic inputs, and retains its
   ZIP/EXE hashes:

   ```powershell
   corepack pnpm test:desktop:setup # Once; repeat after WebView2 updates.
   corepack pnpm test:desktop -ReleaseZip src-tauri/target/release/portable/Stardew-i18n-Translator_<version>_windows-x64-portable.zip
   ```

   A passing run supplies functional evidence only for the guide's listed
   workflows. Review changed UI visually and exercise changed capabilities
   outside that coverage, using synthetic fixtures or temporary copies for
   writes. Computer Use is one option for those checks, not a mandatory tool.
   Screenshots alone are not visual approval, and any explicitly requested
   user-test step remains required. Publish the same ZIP whose hash was tested;
   a pass for a different executable or archive cannot approve this artifact.

   For live-engine, split/multi-mod output, load and scaling coverage, use the
   [extended acceptance profile](../testing/release-acceptance.md). It requires
   real Local AI and Codex CLI, and distinguishes WebView rendering checks from
   measured native Windows DPI configurations. The native DPI matrix is optional,
   not a release requirement. Missing explicitly requested capabilities remain
   incomplete acceptance; a green subset does not replace them.

6. Run the release preflight from the same clean, current `main` checkout:

   ```powershell
   powershell -File scripts/create-release.ps1 `
     -ZipPath src-tauri/target/release/portable/Stardew-i18n-Translator_<version>_windows-x64-portable.zip `
     -Preflight
   ```

7. Create the release using that same tested ZIP:

   ```powershell
   powershell -File scripts/create-release.ps1 `
     -ZipPath src-tauri/target/release/portable/Stardew-i18n-Translator_<version>_windows-x64-portable.zip
   ```

The normal command publishes immediately. Pass `-Draft` only when a draft is
intentionally useful:

```powershell
powershell -File scripts/create-release.ps1 `
  -ZipPath src-tauri/target/release/portable/Stardew-i18n-Translator_<version>_windows-x64-portable.zip `
  -Draft
```

## What the Release Script Checks

`scripts/create-release.ps1`:

- requires a clean checkout whose `HEAD` matches current `origin/main`;
- runs the documentation and synchronized-version checks;
- rejects production JavaScript dependencies with known vulnerabilities;
- rejects Rust dependencies with known security vulnerabilities;
- verifies the ZIP name, exact two-file layout, and the archived executable's
  product version before contacting GitHub;
- refuses conflicting local or remote tags and existing releases;
- uses concise curated notes when present, otherwise GitHub-generated notes;
- prints the portable ZIP SHA-256;
- creates and pushes the version tag only after read-only checks pass;
- removes tags created by the current run if release creation fails.

The script uploads the locally built ZIP; it does not rebuild the application.

## Nexus Mods Publication

Publishing a normal, non-prerelease GitHub release starts
`.github/workflows/publish-nexus.yml`. That workflow uploads the existing GitHub
release asset and does not rebuild the app.

Required GitHub configuration:

- secret: `NEXUSMODS_API_KEY`
- variable: `NEXUSMODS_FILE_GROUP_ID`

The upload job uses the `nexusmods` GitHub environment. Make the secret and
variable available to that environment and account for any configured approval
rules when checking publication status.

If the Nexus upload fails after the GitHub release is live, rerun the workflow
manually with the release tag. Drafts and prereleases are not uploaded.

## Code Signing

The portable executable is currently unsigned, so Windows SmartScreen may show
an unknown-publisher warning. Do not commit signing certificates, passwords, or
other signing secrets to the repository.
