# V1 Release Audit Plan

## Scope

Audit the completed v1 implementation before selecting v1.1 work:

1. Run the full frontend and Rust verification stack.
2. Produce a release-mode Tauri executable without installers.
3. Review release configuration, permissions, version metadata, and documented
   completion status.
4. Fix only release blockers or stale v1 documentation.
5. Consolidate the explicitly deferred v1.1 candidates without implementing
   them.

## Verification

- Prettier check, TypeScript, Vitest, and Vite production build.
- `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, and
  `cargo test --locked`.
- `tauri build --no-bundle` for the Windows release executable.
- Diff review and GitHub CI.
