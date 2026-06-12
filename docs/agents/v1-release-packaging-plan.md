# V1 Release Packaging Plan

## Scope

Prepare the completed Windows application for its first v1 distributable
without publishing a public release or adding updater functionality.

## Implementation

1. Synchronize the application version to `1.0.0`.
2. Build a portable ZIP containing the executable and its adjacent `Data/`
   folder.
3. Add a tag-triggered GitHub workflow that builds the ZIP and creates a draft
   release.
4. Document the release checklist, unsigned-build limitation, and rollback
   points.

## Verification

- Run formatting, frontend tests, TypeScript production build, Rustfmt, Clippy,
  and Rust tests.
- Build the portable ZIP locally.
- Verify the generated archive structure, executable metadata, and data path.
- Do not create the public `v1.0.0` tag until the real Mods-folder smoke test is
  complete.
