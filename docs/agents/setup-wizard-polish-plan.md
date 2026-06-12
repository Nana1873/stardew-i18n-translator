# Setup Wizard Polish Plan

## Scope

Polish the existing four-step first-run setup for the v1.0 release without
changing its functional scope:

1. Stardew Valley folder
2. Mods folder
3. Source and target language
4. Optional glossary

## Implementation

- Add a clear welcome header and visible overall progress.
- Introduce a persistent step rail with current and completed states.
- Improve path, language, glossary, loading, and error presentation.
- Establish consistent primary and secondary actions.
- Preserve all existing setup behavior and validation.

## Verification

- Extend the Setup Wizard component tests for navigation and progress states.
- Run formatting, frontend tests, production build, and the existing Rust checks.
- Build and smoke-test the Tauri release executable.
