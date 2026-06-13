# Supported-Language Compatibility Implementation Plan

## Scope

Close the v1.1 release gate for every advertised target language:

- `de`, `es`, `fr`, `hu`, `it`, `ja`, `ko`, `pt`, `ru`, `tr`, and `zh`.
- Verify settings persistence, scanning/import, editing state, rescan/reload,
  export, protected tokens, external LLM batches, and local-AI prompts.
- Accept SMAPI's existing Portuguese `pt-BR.json` file as an import fallback
  while keeping `pt.json` as the app's canonical export target.
- Use synthetic Unicode fixtures only.

## Implementation

1. Add a shared Rust test matrix with representative text and language labels.
2. Make scanner reads resolve `pt-BR.json` only when canonical `pt.json` is
   absent; never rename or modify files during scanning.
3. Keep scanned/export target paths canonical so export always writes
   `<language>.json`, including `pt.json`.
4. Isolate saved translation state by target language and migrate legacy state
   once into the active language.
5. Add parameterized backend workflow coverage across all 11 languages,
   including language switching in one portable data folder.
6. Add frontend catalog coverage proving every advertised code is selectable
   with the expected label.
7. Update the release-gate document with automated results and a manual smoke
   checklist for the release candidate.

## Non-Goals

- Certifying translation quality or native-speaker correctness.
- Adding languages beyond the SPEC matrix.
- Bundling game or third-party mod content.
- Calling a live local or cloud LLM during tests.
