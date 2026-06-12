# Release Process

## Supported Package

The v1 release target is a 64-bit portable Windows ZIP:

`Stardew-i18n-Translator_<version>_windows-x64-portable.zip`

Its structure is:

```text
Stardew i18n Translator/
|-- stardew-i18n-translator.exe
`-- Data/
    `-- README.txt
```

The application stores `settings.json`, `glossary.json`, and the
`translations/` working-state folder inside `Data/`. Copying the complete
application folder therefore moves the application and its local work together.
Saved Stardew Valley and Mods paths are absolute and may need to be selected
again on another computer.

The application must be extracted to a writable folder. It refuses to start
when its adjacent `Data/` folder cannot be created or written. No installer,
registry entry, Start Menu shortcut, or uninstaller is provided.

The application does not read or migrate state from AppData. A freshly
extracted portable folder starts without user settings, glossary data, or
translation state. To move an existing workspace, copy the complete application
folder including its `Data/` directory.

## Version Source

Keep these versions synchronized:

- `package.json`
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`
- the root package entry in `src-tauri/Cargo.lock`

The first distributable version is `1.0.0`.

## Pre-Release Checklist

1. Confirm the working tree is clean and CI on `main` is green.
2. Run a real Mods-folder smoke test from the unpacked portable folder:
   - launch with an empty `Data/` folder and complete setup;
   - close and reopen the app, then verify settings and the automatic scan;
   - open a large mod and edit/save one string;
   - confirm the saved state appears under `Data/translations/`;
   - build or load a glossary and confirm `Data/glossary.json`;
   - export one mod and confirm its backup/output;
   - export and re-import a small external LLM batch;
   - verify local-AI connection behavior if an endpoint is available.
3. Run `npm run tauri -- build --no-bundle`.
4. Run `powershell -File scripts/package-portable.ps1`.
5. Extract the generated ZIP to a different writable folder.
6. Verify first launch, persistence, and copying the complete folder.
7. Confirm CI is green for the current `main` commit.
8. Create and push the matching version tag on that exact commit, for example
   `v1.0.0`.
9. Review the draft GitHub release and its ZIP before publishing it.

## Draft Release Automation

Pushing a `v*` tag runs `.github/workflows/release.yml`. The workflow accepts
only a tag that points to the current `origin/main` commit, whose regular CI
checks must already be green. It then performs the production Tauri build once,
runs the same portable packaging script used locally, uploads the ZIP, and
creates a draft GitHub release. It fails before building when the tag does not
exactly match `v<application version>` or does not point to current `main`. The
release must be reviewed and published manually.

The regular PR and `main` Rust checks use Cargo's custom `ci` profile. It keeps
the complete format, Clippy, and test coverage but disables dependency
optimization and debug symbols to reduce compile time. Local development and
release profiles are unchanged.

Do not create `v1.0.0` until the real Mods-folder and extracted-ZIP smoke tests
have passed.

## Code Signing

The portable executable is currently unsigned. Windows SmartScreen may show an
unknown-publisher warning. Code signing requires a trusted certificate or
signing service and is intentionally deferred until a certificate and budget
are chosen.

No signing secrets, certificates, or passwords belong in the repository.
