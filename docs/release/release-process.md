# Release Process

## Supported Package

The v1 release target is a 64-bit Windows NSIS installer:

`Stardew i18n Translator_<version>_x64-setup.exe`

NSIS installs for the current Windows user by default, so administrator
privileges are not required. MSI and portable ZIP distributions are not part of
the initial release surface.

## Version Source

Keep these versions synchronized:

- `package.json`
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`
- the root package entry in `src-tauri/Cargo.lock`

The first distributable version is `1.0.0`.

## Pre-Release Checklist

1. Confirm the working tree is clean and CI on `main` is green.
2. Run a real Mods-folder smoke test:
   - launch with existing settings;
   - verify the automatic scan;
   - open a large mod and edit/save one string;
   - export one mod and confirm its backup/output;
   - export and re-import a small external LLM batch;
   - verify local-AI connection behavior if an endpoint is available.
3. Run `npm run tauri -- build --bundles nsis`.
4. Install the generated setup executable on a test Windows account.
5. Verify first launch, setup completion, uninstall, and reinstall.
6. Create and push the matching version tag, for example `v1.0.0`.
7. Review the draft GitHub release and its installer before publishing it.

## Draft Release Automation

Pushing a `v*` tag runs `.github/workflows/release.yml`. The workflow repeats
the frontend and Rust checks, builds the NSIS installer, uploads it, and creates
a draft GitHub release. It fails before packaging when the tag does not exactly
match `v<application version>`. The release must be reviewed and published
manually.

The application version and tag must match. Do not create `v1.0.0` until the
real Mods-folder and installed-package smoke tests have passed.

## Code Signing

V1 installers are currently unsigned. They can still be installed, but Windows
SmartScreen may show an unknown-publisher warning. Code signing requires a
trusted certificate or a signing service and is intentionally deferred until a
certificate and budget are chosen.

No signing secrets, certificates, or passwords belong in the repository.
