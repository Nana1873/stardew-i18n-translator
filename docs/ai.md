# AI translation

[User guide](user-guide.md) · [Troubleshooting](troubleshooting.md) ·
[Technical behavior](#technical-behavior)

AI is optional. You can scan, edit, validate, and export without configuring an
engine. Every AI suggestion enters **Review**; check its wording before marking
it Done. Review status itself does not prevent export, as explained in the
[export guide](user-guide.md#export-translation-files).

## Choose a workflow

| Workflow           | What you need                                         | Where translation runs                 |
| ------------------ | ----------------------------------------------------- | -------------------------------------- |
| Local AI           | A local OpenAI-compatible service with a model loaded | Your configured loopback endpoint      |
| ChatGPT            | Browser sign-in with ChatGPT plan permission          | Directly to OpenAI                     |
| External LLM batch | An LLM that accepts and returns files                 | Wherever you upload the exported batch |

## Set up Local AI

1. Start LM Studio or Ollama and load a model in its local service.
2. Open **Settings > Translation engines** and select the matching Local AI
   provider. Use the default Base URL, or reset it to that provider's default.
   The app talks to both through their OpenAI-compatible API (`/models` and
   `/chat/completions`); for Ollama that is the `/v1` endpoint, not its native
   API. A custom Ollama URL must therefore end in `/v1`.
3. Select a model reported by the service and test the connection.
4. Save settings and select the default translation engine.

Only loopback endpoints are accepted. A remote server, API key, or custom cloud
URL cannot be configured here. **Configured** means the URL and model have been
saved; **Ready** follows a successful test in the current Settings session.

Hybrid Qwen3 models in LM Studio use non-thinking mode automatically. Qwen3
Instruct uses ordinary response text already. Thinking-only variants are
rejected with setup guidance; choose a compatible model if shown that message.

## Sign in with ChatGPT

1. Open **Settings > Translation engines > ChatGPT** and select **Sign in with ChatGPT**.
2. Complete sign-in in your browser and allow this app to use your ChatGPT plan.
3. Return to the app, keep the suggested model or choose a listed model or
   **Enter model ID…**, select
   Low/Medium/High reasoning, and save.

The app connects directly to OpenAI using its own browser-authorized session.
No CLI installation or API key is required. The model catalog comes from your
signed-in account; advertised reasoning capabilities limit the picker when provided.
The catalog can omit usable models. **Enter model ID…** lets you specify an exact
ID such as `gpt-6.1-sol`. If no model selection is saved, the model field starts
with `gpt-6.1-sol`. Catalog refreshes and sign-out preserve your selection even
when it is not listed.
OpenAI checks availability and account/workspace permissions on each request.
The account row shows your sign-in and offers **Manage usage** and **Sign out**.
Status is checked automatically; **Retry models** appears if model discovery fails.
Account eligibility
and preview availability may vary; see the [official sign-in documentation](https://developers.openai.com/siwc/token-sharing-open-source/sign-in).

The renewable session is encrypted with Windows DPAPI in
`data/chatgpt-session.bin`, bound to your Windows user and this portable profile.
Registration metadata in `data/chatgpt-registration.json` keeps the host identity
stable. One running app owns a profile's ChatGPT session. Moving the app to another
Windows account or computer requires signing in again. **Sign out** stops requests,
attempts remote session revocation, and removes the locally saved tokens. If remote
revocation cannot be confirmed, the app tells you to disconnect it in ChatGPT settings.

## Translate and review

For every target language, AI instructions preserve the original tone, humor,
emotional intent, and character voice. Natural, concise Stardew-style wording
should retain warmth where it exists in the source, without softening sarcastic,
sad, blunt, or formal dialogue. The same source-based rule applies during AI
quality review. These instructions guide the model; review the result.

Select Open or Changed strings in Workspace and choose **Translate selected
with AI**, or translate the current eligible string from its editor. The saved
default engine is used. Settings keeps that choice while Local AI is configured
or ChatGPT is ready, otherwise it selects an available configured/ready engine.

Done and Review strings are not sent for live translation. Empty source values,
NUL-containing values, and sources larger than 64 KiB are excluded from the
AI-ready count. The [external file workflow](#external-llm-batches) can still
export selected source values outside these live-engine limits.

ChatGPT runs up to four batches in parallel by default. In **Settings >
Translation engines > ChatGPT > Parallel batches**, choose 1, 2, 4, 6, or 8.
A higher setting can shorten large runs when your account accepts overlapping
requests. Each batch still completes the selected quality checks. After repeated
temporary failures, the app lowers parallelism for the rest of that run.

The progress notice above the Activity log shows the active engine, mod scope,
and current phase. Its
single **Saved to Review** counter and progress bar count persisted suggestions
only. Drafts can be received while quality checks are still running; they do not
advance the saved counter.
Cancelling keeps suggestions already saved and can also save valid drafts when
a token repair is interrupted.

A running batch remains tied to its original language and Mods folder when you
change workspace settings. Its completion does not replace the new workspace's
strings. The result identifies its language; **Open Review** is available when
you return to the workspace that owns those suggestions.

The **Activity log** records batch phase changes, repairs, retries, parallel
limit changes, and saved suggestions with elapsed timestamps. It retains the
latest 500 entries, retaining up to 100 warnings/errors when pruning older
routine entries. Older entries describe earlier work. Provider streaming updates do
not add log entries. The log follows new entries unless you scroll up to read
earlier ones.

Open the completed result's details for engine, model, reasoning, reported token
usage, and recovery information when available. Local AI uses the same progress
notice with serial work. A quiet interval can mean the engine is still processing;
progress cannot describe every moment inside a provider call.

**Cancel** stops further work while retaining suggestions already saved to
Review. The same applies to a later error. Use **Open review queue** to inspect
those results, then select the remaining Open or Changed strings for a later
run. Unsaved drafts are not a resumable background job.

## ChatGPT quality option

The quality option is on by default. ChatGPT drafts the translation, reviews every
draft for meaning, natural phrasing, grammar, terminology, and speaker voice,
then attempts focused terminology or token repairs where needed.

Turn the option off in **Settings > Translation engines > ChatGPT** for fewer
provider calls and lower time/token use. First drafts may need more correction.
Validation still runs, and the result still enters Review. AI review is a useful
editing pass, not proof of correctness or human acceptance.

## External LLM batches

1. Select Open or Changed strings belonging to one mod and export an external
   LLM batch from the selection actions.
2. Use **Copy prompt** in the result tray. Give that prompt and the exported
   JSON file to a file-capable LLM. Ask it to return the requested result file
   without changing identities, keys, or source metadata.
3. Use **Import…** to select the result file, or drag it into the app.
4. Check the read-only preflight. A batch for another scanned mod can switch
   Workspace to that mod for a fresh check. Import when the preview is ready.
5. Review the imported translations and save any corrections.

Preflight checks the mod, language, source snapshot, file/key identities,
protected tokens, empty results, and existing translations. Nonempty local
translations, including Changed rows, are preserved. A stale batch must be
regenerated against the current sources; changing its metadata manually will not make outdated
translations trustworthy.

## Data and privacy

Live requests send selected English source text and its key, section context, and matching
glossary terms. They may include up to two preceding and two following English
strings from the same component, i18n file, section, and related key group.
These neighbors provide read-only context; only selected strings can be saved.
Every batch receives the same saved language settings and matching glossary
entries. Concurrent batches do not exchange drafts. Runtime concatenation or
speaker relationships cannot be inferred reliably from keys alone; a mod's
source comments can supply explicit context, and composed labels still need
manual checking in the mod.

The shared instructions preserve enclosing quotation marks and runtime tokens.
Apostrophes in English possessives or contractions may change when the target
language's grammar requires it. This applies to every target language.

Local AI requests go to the configured loopback service. ChatGPT requests go
directly to OpenAI using your ChatGPT plan. External batches leave your computer
only when you upload them yourself. Cloud credentials remain in the native backend
and are encrypted on disk; they never enter browser storage or diagnostics.
The app has no telemetry or provider marketplace.

Optional AI diagnostics contain run/batch/phase timings, retries, cancellation,
fixed outcome categories, and reported token totals. They exclude prompts,
translations, glossary/context text, mod/string/file identities, target language,
URLs, credentials, raw service output, and executable/temporary paths. General
scanner and file-operation logs can contain paths; review them before sharing.
Logging can be disabled in **Settings > About**.

## Technical behavior

This section records the engine details used by contributors. User-facing
workflow and privacy are described above; implementation lives in
[ai.rs](../src-tauri/src/ai.rs), [chatgpt.rs](../src-tauri/src/chatgpt.rs),
and [llm.rs](../src-tauri/src/llm.rs).

- Live runs accept at most 4,096 strings and 8 MiB of selected source text, with
  at most 64 KiB per source. Runs use exactly one target language and exact
  selected Open/Changed identities; source/state changes invalidate stale work.
- Local AI processes one selected string at a time, saves each successful
  suggestion to Review, and continues past item-specific failures. Connection,
  HTTP-status, client-setup, cancellation, stale-state, and save failures stop
  remaining work. An error after a save is reported as completed with issues;
  before any save it is a failure. Missing, unexpected, or duplicated protected
  tokens trigger one targeted retry with the source's exact token counts. The
  retry replaces the first draft only when it reduces count errors without
  worsening another token. Unresolved mismatches remain visible in Review.
- If a Local AI response is a valid JSON-encoded string, the client decodes one
  layer only when it preserves the source's quotation layout, double-quote,
  line-break, and backslash counts without worsening protected-token validation.
  Genuine quotation marks stay in the translation. Ambiguous or malformed
  responses remain unchanged for Review; decoding does not check wording or
  meaning and does not require structured-output support from the service.
- ChatGPT chunks contain at most 100 strings; each complete serialized prompt is
  bounded to 96 KiB. Repeated neighboring context is pooled without losing its
  order or boundaries. Oversized single-item prompts trim the farthest context
  first, never the selected source.
- One AI run owns the portable profile. ChatGPT has a bounded queue of complete
  batch pipelines, with a saved limit of 1–8 and a default of four. Every second
  temporary retry halves the dispatch limit to a minimum of one; active requests
  may finish above the newly reduced limit. HTTP quota/status errors retain their
  existing stop behavior. Completed batches are validated and saved serially,
  even when they finish out of source order. Returned suggestions follow source
  order. Cancellation stops dispatch and signals every active pipeline.
- Each ChatGPT attempt has a five-minute ceiling. A transient failure can be retried
  once; invalid structured output gets one corrected attempt. Persistent invalid
  output splits only the affected batch until the failing string is isolated.
- With quality enabled, every draft receives full language review. Its response
  contains corrections only; omitted IDs retain their draft. Only then do
  conservatively detected terminology candidates receive one focused repair.
  Correct inflections and compounds may stay unchanged.
- A failed full review preserves structurally valid drafts after bounded recovery;
  oversized review leaves its chunk incomplete. Failed focused
  terminology repair retains the fully reviewed text. Remaining protected-token
  mismatches receive one targeted ChatGPT repair when the prompt fits; oversized
  repair inputs skip the extra call. Unresolved mismatches remain visible in
  Review with blocking validation. Disabling quality skips these extra ChatGPT
  review/repair calls, never validation or Review status.
- Completed chunks persist as validation reaches them. Cancellation and later
  failure retain saved suggestions; unfinished Open/Changed work can be retried.
  There is no persistent AI job queue or separate checkpoint history.
- Progress forwards safe provider activity stages, not raw reasoning, commands,
  identities, paths, or errors. The compact progress notice shows the current
  step; the Activity log records batch preparation, translation, quality checks,
  recovery, drafts received, and suggestions saved to Review. Repeated snapshots do not
  add log entries. Received drafts can still change during review and do not
  advance the saved-string progress bar. Local AI reports each completed response,
  without streaming intermediate provider stages. No token-by-token heartbeat is
  assumed.

## Experimental parallel provider probe

The `compare_parallel_chatgpt_batches` Rust test is an opt-in experiment,
excluded from ordinary tests. It sends the same four synthetic batches of 12
strings with concurrency 1, 2, then 4, using `gpt-6.1-sol`, Medium reasoning,
and quality review enabled. It calls the existing native ChatGPT translation,
review, token repair, and suggestion validation functions. It does not change
the desktop queue or exercise its persistence/UI flow.

To test real mod text, set `SIT_PARALLEL_PROBE_SOURCE` to `default.json` in an
ignored temporary copy. The probe preserves the original keys, source order,
sections, and native neighboring context. It translates every eligible source
from scratch in fixed batches of 75, without loading existing translations. An optional comparison glossary can be
provided as a UTF-8 JSON array of `[source, target]` pairs. This mode sends the copied mod text to OpenAI; the original mod stays
read-only. Keep the copied sources and generated results out of Git.

Use an already signed-in, isolated test profile after closing the app that
owns it. Never point this probe at your normal portable data folder or copy
credentials between profiles. Authentication retains exclusive profile ownership
and the normal serialized refresh behavior. The probe sends the selected fixture
or copied mod text and consumes ChatGPT plan allowance.

From `src-tauri`, set the profile and an ignored output directory, then run:

```powershell
$env:SIT_PARALLEL_PROBE_PROFILE = '<isolated test profile>/data'
$env:SIT_PARALLEL_PROBE_OUTPUT = '../target/parallel-probe/<unique run>'
# Optional: omit this variable to retain the small synthetic fixture.
$env:SIT_PARALLEL_PROBE_SOURCE = '<ignored temporary mod copy>/default.json'
# Optional comparison controls for copied input (defaults: 75, 1/2/4, one round):
$env:SIT_PARALLEL_PROBE_BATCH_SIZE = '25'
$env:SIT_PARALLEL_PROBE_LEVELS = '4,6,8'
$env:SIT_PARALLEL_PROBE_ROUNDS = '2' # Even rounds reverse concurrency order.
$env:SIT_PARALLEL_PROBE_LANGUAGE = 'German' # Also French, Spanish, Japanese.
# $env:SIT_PARALLEL_PROBE_GLOSSARY = '<ignored comparison glossary>.json'
cargo test --locked --profile ci --lib chatgpt::cloud_translation::parallel_probe::compare_parallel_chatgpt_batches -- --ignored --exact --nocapture
```

The account's model catalog is recorded as an availability hint; only the
explicitly requested model is sent, and completed inference determines access.
Each complete batch pipeline has a four-minute timeout for the small synthetic
fixture or a ten-minute timeout for copied mod input; existing five-minute
provider attempt limits remain unchanged. The probe stops at the first
invalid/failed batch and does not start a higher concurrency
level after a failure. Existing bounded provider recovery remains active.

`comparison.json` contains the selected sources and suggestions, source-copy
hash, token/context coverage, prompt sizes, batch/request timings, maximum
overlapping client requests, token usage, retries, repair counts, skipped
reviews, and validation outcomes. Every result must retain its exact batch/row
identity, Review status, protected tokens, and any supplied glossary terms.
Credentials, account identity, and raw provider responses are excluded. Do not commit generated
outputs. These timings establish feasibility in the recorded
environment; cache warming, variable service latency, and request order can affect
speed comparisons. They do not prove fourfold speedup or translation quality for
large real mods.
