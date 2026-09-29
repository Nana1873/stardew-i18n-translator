# Local ChatGPT login prototype

Run [start-chatgpt-login-prototype.cmd](../start-chatgpt-login-prototype.cmd)
on Windows, or run the server from the repository root with Node.js 22 or newer:

```powershell
node scripts/chatgpt-login-prototype/server.mjs --open
```

The launcher opens a local browser page. Choose **Continue with ChatGPT**, allow
ChatGPT plan usage in the OpenAI browser flow, load the model catalog, then
translate the short synthetic sample. Requests use the signed-in ChatGPT plan
or credits. **A completed translation**, rather than login or a model list
alone, demonstrates inference access. Preview eligibility and rollout can
prevent a request; the UI shows the HTTP status, safe error code and request ID
when available.

This standalone experiment does not modify the released app or read game,
Mods, translation-state or existing Codex credential folders. It uses Node's
built-in HTTP, fetch and cryptography APIs, without additional packages.

OAuth uses dynamic client registration, a persistent host identifier, PKCE,
state and nonce, and a `127.0.0.1` callback. The server validates the ID token's
RS256 signature against OpenAI's discovered JWKS, issuer, audience, expiration,
nonce and returning account identity before accepting the session. Only RS256
identity tokens are accepted by this prototype; another signing algorithm
produces an explicit failure rather than skipping validation. Local API calls
require the exact local Host/Origin and a page-specific anti-CSRF value.

Access, refresh and ID tokens are never written to disk or passed to the UI.
Access and refresh tokens stay in process memory; expired access is refreshed
serially. Non-secret registration metadata (host ID, issued client ID and
verified subject) is saved under the ignored `target/chatgpt-login-prototype/`
directory so a restart can reauthorize the same registration. A restart still
requires browser sign-in. This is not the production credential-storage design.

Choose **Sign out** or **Close local prototype** to attempt renewable-session
revocation and clear local tokens. Closing only the browser tab leaves the
local process running; restarting/killing the process discards tokens but does
not confirm remote revocation. Disconnect the app in ChatGPT settings when
needed. Closing the prototype through its UI also stops the listener.

Only the selected sample and translation instructions are sent to the fixed
Responses API endpoint. Requests require `store: false` and `stream: true`.
Cancellation, a failed stream or a missing completion event discards partial
output. The parser also recognizes completed Responses JSON objects, validates
completed assistant output, and detects SSE by its body when its Content-Type
header is absent or different. Unexpected responses expose only safe format
metadata under **Connection details**, never raw response bodies or credentials.
When the terminal response has an empty output array, completed output-item
events supply the text; a response completion event is still required.
The response parser reloads when edited during the running local experiment,
so parser-only fixes do not require another sign-in.
The placeholder check covers `{{...}}` sample placeholders only; full
SMAPI token validation, batches, quality review, export and integration into
the app remain outside this prototype.

Run the focused offline checks with:

```powershell
node --test scripts/chatgpt-login-prototype/core.test.mjs scripts/chatgpt-login-prototype/server.test.mjs scripts/chatgpt-login-prototype/lifecycle.test.mjs
```

Sources: [registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in),
[models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference),
[accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions),
[preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).
Tracked idea: [issue #238](https://github.com/Nana1873/stardew-i18n-translator/issues/238).
