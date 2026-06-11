# LLM Batch Rename Plan

## Goal

Rename the M4 external translation workflow from Claude-Code-specific wording
to provider-neutral LLM batch wording, and explain the complete handoff flow in
the app.

## Scope

1. Rename visible UI labels, dialogs, TypeScript types, and Tauri commands to
   use `LLM batch`.
2. Export new files as `*.llm-batch.json` with neutral format markers.
3. Keep imports compatible with existing `stardew-translator-claude-*` files.
4. Add a four-step workflow and a ready-to-use prompt to the export result
   dialog.
5. Update M4 documentation, SPEC, guardrails, and tests.

## Non-Goals

- No direct cloud-LLM API integration.
- No provider abstraction or provider-specific presets.
- No automatic upload, download, or browser control.

## Verification

- Frontend unit tests and TypeScript check.
- Rust unit tests, including legacy marker compatibility.
- Formatting and diff checks.
- Visual verification of the updated dialog.
