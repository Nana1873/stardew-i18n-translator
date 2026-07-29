# Release Process

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

2. Run the complete frontend, documentation, and Rust checks:

   ```powershell
   corepack pnpm exec tsc --noEmit
   corepack pnpm test
   corepack pnpm check:docs

   Push-Location src-tauri
   cargo fmt --check
   cargo clippy --locked --all-targets --profile ci -- -D warnings
   cargo test --locked --profile ci
   cargo audit
   Pop-Location
   ```

3. Build and package the portable app:

   ```powershell
   corepack pnpm tauri build --no-bundle
   powershell -File scripts/package-portable.ps1
   ```

4. Extract the ZIP and do a practical smoke test when the release changes
   startup, persistence, scanning, editing, glossary handling, or export.

5. Run the release preflight from a clean, current `main` checkout:

   ```powershell
   powershell -File scripts/create-release.ps1 `
     -ZipPath src-tauri/target/release/portable/Stardew-i18n-Translator_<version>_windows-x64-portable.zip `
     -Preflight
   ```

6. Create the release:

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
- rejects Rust dependencies with known security vulnerabilities;
- verifies the ZIP name and exact two-file layout;
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

If the Nexus upload fails after the GitHub release is live, rerun the workflow
manually with the release tag. Drafts and prereleases are not uploaded.

## Code Signing

The portable executable is currently unsigned, so Windows SmartScreen may show
an unknown-publisher warning. Do not commit signing certificates, passwords, or
other signing secrets to the repository.
