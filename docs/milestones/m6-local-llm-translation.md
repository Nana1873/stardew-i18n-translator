# Milestone M6: Local-LLM Translation (Ollama / LM Studio)

## Goal
Translate `untranslated`/`outdated` strings **in-app, fully offline**, against a
locally running model server (Ollama, LM Studio, or any OpenAI-compatible
endpoint). Unlike M4 (offline batch you copy-paste into a cloud LLM), this is a
one-click automated pass that talks to `localhost` — no API key, no external
network, no copy-paste. Results land as **`review-needed`** suggestions, never
auto-accepted.

This complements M4 rather than replacing it: same `review-needed` status, same
post-translation token validation. The only difference is the engine (local HTTP
vs. human copy-paste to a cloud model).

## Why OpenAI-compatible only
Both target servers already expose an OpenAI-compatible `POST /v1/chat/completions`
and `GET /v1/models`:
- **LM Studio** — `http://localhost:1234/v1`
- **Ollama** — `http://localhost:11434/v1` (alongside its native `/api/...`)

So a single client covers both, plus LocalAI / Jan / llama.cpp / text-generation-webui.
The old project used the same OpenAI-compatible-only approach. This is **not** a
provider plugin system (SPEC §19 #6) — just URL/port presets + a free-form custom
URL.

## Scope
* **Connection settings:** provider preset (LM Studio / Ollama / Custom), base URL,
  model name (populated from `GET /v1/models`), optional temperature. A "Test
  connection" action that pings `/v1/models` and reports reachability + the loaded
  model. Persisted in `AppSettings`.
* **Translate one string (MVP):** a Rust command that translates a single source
  string: build the prompt (system rules + injected glossary pairs relevant to
  that string + source text), `POST /v1/chat/completions` at low temperature, then
  run the result through the protected-token validator (`tokens.rs`). On dropped
  tokens, retry **once** with a stricter reminder; if it still fails, return the
  result flagged so the user sees it needs a fix. An editor button ("Translate with
  local AI") fills the target field with the suggestion (status → `review-needed`).
* **Glossary injection + validation:** for each source string, find the official
  game terms present (whole-word match, same logic as the editor's `matchGlossary`,
  capped) and inject them as "Use these official translations: en → target" lines.
  After translation, check the injected terms were respected; surface a soft
  warning if not. Degrades cleanly to no-injection when no glossary is built
  (SPEC §19 #8).
* **Status:** local-AI output is `review-needed` — an AI suggestion that needs a
  human pass, exactly like an M4 import.

## Out of Scope (this milestone / deferred to a follow-up)
* **Batch / whole-mod translation** with a progress dialog, cancellation, and
  resume. (Designed for, but the MVP ships single-string first; batch is the
  immediate follow-up PR once the pipeline is proven.)
* Cloud providers / API keys (that's M4's territory; SPEC §19 #7 — v1 needs no keys).
* A provider **plugin system** (SPEC §19 #6) — presets only.
* Model management (pulling/loading models) — the user manages that in Ollama/LM Studio.
* Streaming token-by-token display (a single non-streamed response is fine per string).

## Acceptance Criteria
1. Settings can store provider preset + base URL + model, and "Test connection"
   reports whether the server is reachable and which model answers.
2. A single source string can be translated via the local server and the result
   appears in the editor's target field with status `review-needed`.
3. Relevant glossary terms are injected into the prompt; when no glossary is built,
   translation still works (no-injection mode).
4. The result is run through the existing protected-token validator; dropped tokens
   trigger exactly one stricter retry, then a visible flag — never a silent corruption.
5. A clear, non-crashing error is shown when the server is down or no model is loaded.
6. The prompt-building, glossary-injection, and token-retry logic are covered by unit
   tests (with the HTTP layer mocked — no live model required in CI).

## Risks
* **Model quality varies wildly.** Small local models hallucinate and ignore token
  rules. *Mitigation:* token validation + one retry + `review-needed` default (output
  is always a suggestion, never auto-`translated`).
* **Throughput** on large mods (640+ strings). *Mitigation (batch follow-up):* only
  `untranslated`/`outdated`, serial or low concurrency (local GPU is the bottleneck),
  progress + cancel.
* **Server not running / model not loaded.** *Mitigation:* "Test connection" up front,
  clear errors, never a silent hang.
* **Context window** on small models. *Mitigation:* one small prompt per string with
  only the relevant glossary subset, not the whole 1700-term map.
* **Glossary inflection** (German cases/articles). *Mitigation:* inject as guidance
  (prompt) and validate softly, rather than hard-substituting placeholders — the model
  keeps the freedom to inflect.

## Suggested Issue Breakdown

### Issue 15: Local-LLM connection settings + "Test connection" (MVP part 1) ✅
* OpenAI-compatible client (`reqwest`, async command), provider presets, `GET /v1/models`
  discovery, settings persistence, and a **Local AI section in a new Settings dialog**
  with a test button. AI lives in Settings (not the first-launch wizard) because the
  tool is translation-first and AI is opt-in. This slice also split the toolbar
  **Settings** button away from re-opening the Setup Wizard: it now opens the Settings
  dialog (§7.7), and the wizard is re-reachable from there via "Re-run setup…".

### Issue 16: Translate-one-string command with glossary injection + token retry (MVP part 2)
* Prompt builder (system rules + glossary subset + source), `POST /v1/chat/completions`,
  token validation + one stricter retry, editor "Translate with local AI" button →
  `review-needed`. Unit tests with the HTTP layer mocked.

### Issue 17 (follow-up): Batch / whole-mod translation
* Progress dialog (X/Y, cancel), translate all `untranslated`/`outdated` in a mod or
  selection, results → `review-needed`, resume-friendly.

## Status (shipped vs. open)
**In progress.** Issue 15 shipped: the OpenAI-compatible connection (`llm` module,
`llm_models` command, `AppSettings.llm`) and a new **Settings dialog** (§7.7) with a
**Local AI** section + "Test connection". The toolbar Settings button now opens this
dialog instead of re-running the Setup Wizard. **Next:** Issue 16 (translate one
string via Ctrl+F5 → `review-needed`). Reprioritized ahead of M4/M5 at the user's
request (a working glossary makes local-AI pre-translation worthwhile now).

## Agent Handoff Notes
*OpenAI-compatible endpoint only — do not add a provider plugin system (SPEC §19 #6).
Local-AI output is `review-needed`, the same status M4 reintroduces (SPEC §19 #2, now
broadened to "AI workflows"). Reuse `tokens.rs` for post-translation validation and the
editor's existing glossary-matching logic for the injected term subset. The glossary is
always optional (SPEC §19 #8): no-glossary must still translate. No API keys, localhost
only (SPEC §19 #7).*
