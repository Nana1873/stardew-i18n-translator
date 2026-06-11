# AI Section Context Plan

## Scope

Complete the remaining SPEC §7.4 redesign follow-up:

- Pass the nearest `//` section heading to local-AI single and batch prompts.
- Include the same section context in external LLM batch exports.
- Keep section context optional so ordinary JSON files without section comments
  behave exactly as before.

## Implementation

1. Extend the typed translation call with an optional section and inject it as
   a concise content-type hint in the Rust system prompt.
2. Carry each row's section through the editor and local batch dialog.
3. Add a parallel `sections` map to LLM batches, matching the existing
   `files` directory/key structure without changing the translatable values.
4. Update embedded LLM instructions to treat `sections` as read-only
   context.
5. Cover prompt injection, no-section behavior, batch structure, and frontend
   payload forwarding with focused tests.

## Non-Goals

- Inferring sections when `default.json` has no standalone `//` headings.
- Changing the result/import structure.
- Sending neighboring strings or full files as model context.
- Any AI provider or settings changes.
