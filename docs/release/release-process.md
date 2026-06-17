# Release Process

## Supported Package

The v1 release target is a 64-bit portable Windows ZIP:

`Stardew-i18n-Translator_<version>_windows-x64-portable.zip`

Its structure is:

```text
Stardew i18n Translator/
|-- stardew-i18n-translator.exe
`-- README.txt
```

On first launch, the application creates its adjacent `data/` folder. It stores
`settings.json`, the `glossary/glossary-<lang>.json` per-language caches, and the
`language-state/<lang>/translations/` working-state folders inside `data/`.
Copying the complete application folder therefore moves the application and
its language-specific local work together. Saved Stardew Valley and Mods paths
are absolute and may need to be selected again on another computer.

The application must be extracted to a writable folder. It refuses to start
when its adjacent `data/` folder cannot be created or written. No installer,
registry entry, Start Menu shortcut, or uninstaller is provided.

All state lives in the adjacent `data/` folder. A freshly extracted portable
folder starts without user settings, glossary data, or translation state. To
move an existing workspace, copy the complete application folder including its
`data/` directory.

## Version Source

Keep these versions synchronized:

- `package.json`
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`
- the root package entry in `src-tauri/Cargo.lock`

The first distributable version is `1.0.0`.

Use `corepack pnpm version:set <version>` to update all synchronized references,
then run `corepack pnpm check:docs`. The local check and CI on `main` verify all
four application sources, the project-status release number, the `CHANGELOG.md`
Unreleased comparison link, local Markdown links, and formatting.

## Pre-Release Checklist

1. Confirm the working tree is clean and `HEAD` equals current `origin/main`.
2. Run a real Mods-folder smoke test from the unpacked portable folder:
   - launch without a `data/` folder, confirm it is created, and complete setup;
   - close and reopen the app, then verify settings and the automatic scan;
   - open a large mod and edit/save one string;
   - confirm the saved state appears under
     `data/language-state/<lang>/translations/`;
   - build or load a glossary and confirm `data/glossary/glossary-<lang>.json`;
   - export one mod and confirm its backup/output;
   - export and re-import a small external LLM batch;
   - verify local-AI connection behavior if an endpoint is available.
3. Run `npm run tauri -- build --no-bundle`.
4. Run `powershell -File scripts/package-portable.ps1`.
5. Extract the generated ZIP to a different writable folder.
6. Verify first launch, persistence, and copying the complete folder.
7. Confirm the complete local frontend, Rust, and documentation checks passed
   on the current `main` commit. CI on that exact `main` commit is an additional
   safety net when Actions minutes are available.
8. Confirm merged pull requests have the correct `changelog:*` labels.
9. Create the tag and draft release from the already verified ZIP:

   ```powershell
   powershell -File scripts/create-draft-release.ps1 `
     -ZipPath src-tauri/target/release/portable/Stardew-i18n-Translator_<version>_windows-x64-portable.zip `
     -Preflight

   powershell -File scripts/create-draft-release.ps1 `
     -ZipPath src-tauri/target/release/portable/Stardew-i18n-Translator_<version>_windows-x64-portable.zip
   ```

10. Verify the reported SHA-256 against the uploaded asset, then review the
    generated draft notes and ZIP before publishing the release.

## Local Draft Release Automation

The release script refuses dirty or stale commits, verifies documentation and
version checks, validates the exact two-file ZIP structure, checks local and
remote tag state, generates categorized notes, and creates a draft GitHub
release. When `docs/release/v<version>.md` exists, those curated highlights are
prepended.

Run it with `-Preflight` first. Preflight performs every read-only validation
and note-generation step without creating or pushing a tag and without creating
a release. The normal run delays tag creation until all read-only checks pass.
If draft creation then fails, it removes only the local or remote tags created
by that same run. Pre-existing tags are never removed automatically.

The transaction behavior can be verified without GitHub writes or Actions
minutes:

```powershell
powershell -File scripts/test-create-draft-release.ps1
```

The script does not rebuild the application. This is intentional: the locally
smoke-tested production ZIP is the exact artifact uploaded to GitHub, avoiding
another paid Windows Actions build. The draft must still be reviewed and
published manually.

The `main` Rust checks use Cargo's custom `ci` profile. It keeps complete
format, Clippy, and test coverage but disables dependency optimization and
debug symbols to reduce compile time. Local development and release profiles
are unchanged.

Do not create a release tag until the real Mods-folder and extracted-ZIP smoke
tests have passed.

## Code Signing

The portable executable is currently unsigned. Windows SmartScreen may show an
unknown-publisher warning. Code signing requires a trusted certificate or
signing service and is intentionally deferred until a certificate and budget
are chosen.

No signing secrets, certificates, or passwords belong in the repository.
