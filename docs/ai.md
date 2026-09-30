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
3. Return to the app, choose an available model and Low/Medium/High reasoning, and save.

The app connects directly to OpenAI using its own browser-authorized session.
No CLI installation or API key is required. The model catalog comes from your
signed-in account; advertised reasoning capabilities limit the picker when provided.
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

Select Open or Changed strings in Workspace and choose **Translate selected
with AI**, or translate the current eligible string from its editor. The saved
default engine is used. Settings keeps that choice while Local AI is configured
or ChatGPT is ready, otherwise it selects an available configured/ready engine.

Done and Review strings are not sent for live translation. Empty source values,
NUL-containing values, and sources larger than 64 KiB are excluded from the
AI-ready count. The [external file workflow](#external-llm-batches) can still
export selected source values outside these live-engine limits.

The progress dialog counts translated drafts separately from suggestions saved
to Review. A batch's drafts can be translated while its quality checks are still
running; they are not yet saved. The saved counter and progress bar count
persisted suggestions only. Cancelling keeps suggestions already saved and can
also save valid drafts when a token repair is interrupted.

The dialog also shows elapsed time, the current phase,
and available provider activity/token usage. An estimated remaining time appears
after suggestions have been saved. A quiet interval can mean the engine is
still processing; progress cannot describe every moment inside a provider call.

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

Live requests send selected English source text, section context, and matching
glossary terms. They may include up to two preceding and two following English
strings from the same component, i18n file, section, and related key group.
These neighbors provide read-only context; only selected strings can be saved.

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
  before any save it is a failure. Token mismatch has one targeted retry.
- ChatGPT chunks contain at most 100 strings; each complete serialized prompt is
  bounded to 96 KiB. Repeated neighboring context is pooled without losing its
  order or boundaries. Oversized single-item prompts trim the farthest context
  first, never the selected source.
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
  identities, paths, or errors. The estimate uses saved-string checkpoints and
  changes when more results are persisted; no token-by-token heartbeat is assumed.
