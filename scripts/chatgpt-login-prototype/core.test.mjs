import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  beginAuthorization,
  validateCallback,
  validateIdToken,
  sessionFromTokens,
  consumeResponseStream,
  visibleModels,
  sampleTokenCheck,
  apiError,
  readBounded,
  AUTH_ORIGIN,
  PLAN_SCOPE,
} from "./core.mjs";

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const jwk = {
  ...publicKey.export({ format: "jwk" }),
  kid: "test-signing-key",
  use: "sig",
  alg: "RS256",
};
const now = Math.floor(Date.now() / 1000);
function jwt(changes = {}, headerChanges = {}) {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: jwk.kid, ...headerChanges }),
  ).toString("base64url");
  const body = Buffer.from(
    JSON.stringify({
      iss: AUTH_ORIGIN,
      aud: "oaiapp_test",
      sub: "test-user",
      nonce: "expected-nonce",
      iat: now,
      exp: now + 60,
      ...changes,
    }),
  ).toString("base64url");
  const input = `${header}.${body}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`;
}
function stream(events, chunkSize = 7) {
  const encoded = Buffer.from(
    events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(""),
  );
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < encoded.length; i += chunkSize)
          controller.enqueue(encoded.subarray(i, i + chunkSize));
        controller.close();
      },
    }),
    {
      headers: {
        "content-type": "text/event-stream",
        "x-request-id": "req_test",
      },
    },
  );
}

test("initial registration uses PKCE, nonce, real app name and loopback callback", () => {
  const { attempt, url } = beginAuthorization(
    "urn:uuid:test",
    "http://127.0.0.1:4567/auth/callback",
  );
  const params = new URL(url).searchParams;
  assert.equal(params.get("client_id"), "dynamic_agent_client");
  assert.equal(params.get("redirect_uri"), attempt.redirectUri);
  assert.equal(params.get("code_challenge_method"), "S256");
  assert.equal(params.get("agent_name_hint"), "Stardew i18n Translator");
  assert.ok(params.get("scope").includes(PLAN_SCOPE));
  assert.notEqual(attempt.verifier, params.get("code_challenge"));
});
test("callbacks reject wrong state, expiry, duplicate parameters and wrong issuer", () => {
  const { attempt } = beginAuthorization(
    "host",
    "http://127.0.0.1:4567/auth/callback",
  );
  const valid = new URLSearchParams({
    state: attempt.state,
    code: "one-use-code",
    client_id: "oaiapp_test",
  });
  assert.deepEqual(validateCallback(valid, attempt), {
    code: "one-use-code",
    clientId: "oaiapp_test",
  });
  for (const change of [
    (params) => params.set("state", "wrong"),
    (params) => params.append("code", "another"),
    (params) => params.set("iss", "https://example.invalid"),
  ]) {
    const changed = new URLSearchParams(valid);
    change(changed);
    assert.throws(() => validateCallback(changed, attempt));
  }
  assert.throws(() =>
    validateCallback(valid, attempt, attempt.createdAt + 11 * 60_000),
  );
  const missing = new URLSearchParams(valid);
  missing.delete("client_id");
  assert.throws(() => validateCallback(missing, attempt));
});
test("returning registration cannot be replaced by another callback client", () => {
  const { attempt, url } = beginAuthorization(
    "host",
    "http://127.0.0.1:4567/auth/callback",
    { clientId: "oaiapp_saved", subject: "test-user" },
  );
  assert.equal(new URL(url).searchParams.has("agent_name_hint"), false);
  assert.equal(
    validateCallback(
      new URLSearchParams({ state: attempt.state, code: "code" }),
      attempt,
    ).clientId,
    "oaiapp_saved",
  );
  assert.throws(() =>
    validateCallback(
      new URLSearchParams({
        state: attempt.state,
        code: "code",
        client_id: "oaiapp_other",
      }),
      attempt,
    ),
  );
});
test("signed ID token validates identity and rejects wrong claims and tampering", () => {
  assert.equal(
    validateIdToken(
      jwt(),
      [jwk],
      "oaiapp_test",
      "expected-nonce",
      "test-user",
      now,
    ).subject,
    "test-user",
  );
  for (const changes of [
    { iss: "https://example.invalid" },
    { aud: "other-client" },
    { exp: now - 1 },
    { nonce: "another" },
    { sub: "another-user" },
    { iat: now + 120 },
    { nbf: now + 120 },
    { aud: ["oaiapp_test", "other"], azp: "other" },
  ]) {
    assert.throws(() =>
      validateIdToken(
        jwt(changes),
        [jwk],
        "oaiapp_test",
        "expected-nonce",
        "test-user",
        now,
      ),
    );
  }
  const parts = jwt().split(".");
  parts[1] = Buffer.from(JSON.stringify({ sub: "tampered" })).toString(
    "base64url",
  );
  assert.throws(() =>
    validateIdToken(
      parts.join("."),
      [jwk],
      "oaiapp_test",
      "expected-nonce",
      null,
      now,
    ),
  );
  assert.throws(() =>
    validateIdToken(
      jwt({}, { alg: "none" }),
      [jwk],
      "oaiapp_test",
      "expected-nonce",
      null,
      now,
    ),
  );
});
test("an identity-only login does not authorize plan inference", () => {
  const data = {
    access_token: "test-only-access",
    token_type: "Bearer",
    expires_in: 3600,
    scope: "openid email",
  };
  assert.equal(
    sessionFromTokens(data, { subject: "test-user" }, "client").planEnabled,
    false,
  );
  const active = sessionFromTokens(
    { ...data, scope: PLAN_SCOPE, refresh_token: "old-refresh" },
    { subject: "test-user" },
    "client",
  );
  assert.equal(active.planEnabled, true);
  const renewed = sessionFromTokens(
    { ...data, scope: PLAN_SCOPE, refresh_token: "new-refresh" },
    { subject: "test-user" },
    "client",
    active,
  );
  assert.equal(renewed.refreshToken, "new-refresh");
});
test("SSE accepts completed output across UTF-8 and event boundaries", async () => {
  const result = await consumeResponseStream(
    stream(
      [
        {
          type: "response.output_text.delta",
          delta: "Hallo, {{player}}! Grüße.",
        },
        {
          type: "response.completed",
          response: {
            status: "completed",
            output: [
              {
                type: "message",
                role: "assistant",
                status: "completed",
                content: [
                  { type: "output_text", text: "Hallo, {{player}}! Grüße." },
                ],
              },
            ],
            usage: { input_tokens: 22, output_tokens: 11 },
          },
        },
      ],
      1,
    ),
  );
  assert.equal(result.text, "Hallo, {{player}}! Grüße.");
  assert.equal(result.usage.inputTokens, 22);
});
test("partial, failed and incomplete streams never become accepted results", async () => {
  const delta = {
    type: "response.output_text.delta",
    delta: "Partial translation",
  };
  for (const ending of [
    [],
    [
      {
        type: "response.failed",
        response: { error: { code: "request_failed" } },
      },
    ],
    [{ type: "response.incomplete" }],
    [{ type: "response.completed", response: { status: "failed" } }],
    [
      {
        type: "response.completed",
        response: { status: "completed", output: [] },
      },
    ],
  ]) {
    await assert.rejects(consumeResponseStream(stream([delta, ...ending])));
  }
});
test("completed item events supply text when the terminal response omits output", async () => {
  const item = {
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "Hallo, {{player}}!" }],
  };
  const completed = {
    type: "response.completed",
    response: {
      status: "completed",
      output: [],
      usage: {
        input_tokens: 12,
        output_tokens: 20,
        output_tokens_details: { reasoning_tokens: 8 },
      },
    },
  };
  const done = { type: "response.output_item.done", output_index: 0, item };
  const result = await consumeResponseStream(stream([done, completed]));
  assert.equal(result.text, "Hallo, {{player}}!");
  assert.equal(result.usage.reasoningOutputTokens, 8);
  assert.equal(result.diagnostic.outputSource, "completed-item-events");
  await assert.rejects(consumeResponseStream(stream([done])));
  await assert.rejects(consumeResponseStream(stream([done, done, completed])));
  await assert.rejects(
    consumeResponseStream(
      stream([
        { ...done, item: { ...item, status: "in_progress" } },
        completed,
      ]),
    ),
  );
});
test("output and service-body limits reject oversized content", async () => {
  await assert.rejects(
    consumeResponseStream(
      stream(
        [
          { type: "response.output_text.delta", delta: "x".repeat(33000) },
          { type: "response.completed", response: { status: "completed" } },
        ],
        1000,
      ),
    ),
  );
  await assert.rejects(readBounded(new Response("x".repeat(101)), 100));
});
test("a disconnected response stream is transient without exposing transport details", async () => {
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.error(new TypeError("private transport detail"));
      },
    }),
  );
  await assert.rejects(consumeResponseStream(response), (error) => {
    assert.equal(error.failureCategory, "transient");
    assert.doesNotMatch(error.message, /private transport detail/);
    return true;
  });
});
test("completed JSON Responses replies are accepted without trusting arbitrary JSON text", async () => {
  const completed = {
    object: "response",
    status: "completed",
    output: [
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "Hallo, {{player}}!" }],
      },
    ],
    usage: { input_tokens: 12, output_tokens: 8 },
  };
  const result = await consumeResponseStream(Response.json(completed));
  assert.equal(result.text, "Hallo, {{player}}!");
  assert.equal(result.diagnostic.format, "json");
  for (const invalid of [
    { text: "looks successful" },
    { ...completed, status: "in_progress" },
    { ...completed, status: "incomplete" },
    {
      ...completed,
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "refusal", refusal: "No" }],
        },
      ],
    },
    {
      ...completed,
      error: {
        code: "subscription_sharing_usage_limit_exceeded",
        message: "secret-token",
      },
    },
  ])
    await assert.rejects(consumeResponseStream(Response.json(invalid)));
});
test("SSE body is recognized even when the service omits its stream content type", async () => {
  const completed = {
    status: "completed",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Guten Morgen!" }],
      },
    ],
  };
  const body = `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: completed })}\n\n`;
  const result = await consumeResponseStream(new Response(body));
  assert.equal(result.text, "Guten Morgen!");
  assert.equal(result.diagnostic.contentType, "text/plain");
  assert.equal(result.diagnostic.lastEvent, "response.completed");
});
test("unexpected content produces safe response-format diagnostics", async () => {
  await assert.rejects(
    consumeResponseStream(
      Response.json({ detail: "secret access token", output: "secret text" }),
    ),
    (error) => {
      assert.equal(error.diagnostic.format, "json");
      assert.equal(error.diagnostic.httpStatus, 200);
      assert.doesNotMatch(
        JSON.stringify(error.diagnostic) + error.message,
        /secret/,
      );
      return true;
    },
  );
  await assert.rejects(
    consumeResponseStream(
      new Response("<html>Not a translation</html>", {
        headers: { "Content-Type": "text/html" },
      }),
    ),
  );
});
test("model picker uses only listed models and rejects a different API contract", () => {
  assert.deepEqual(
    visibleModels({
      models: [
        {
          slug: "available-model",
          display_name: "Available",
          visibility: "list",
        },
        { slug: "hidden-model", visibility: "hidden" },
      ],
    }),
    [{ id: "available-model", name: "Available" }],
  );
  assert.throws(() => visibleModels({ data: [{ id: "another-contract" }] }));
});
test("sample placeholder check preserves exact spelling and multiplicity", () => {
  assert.equal(
    sampleTokenCheck(
      "Hello {{player}} {{player}}",
      "Hallo {{player}} {{player}}",
    ),
    true,
  );
  assert.equal(
    sampleTokenCheck("Hello {{player}} {{player}}", "Hallo {{player}}"),
    false,
  );
  assert.equal(
    sampleTokenCheck("Hello {{player}}", "Hallo {{spieler}}"),
    false,
  );
});
test("diagnostics show bounded error codes without remote secret-bearing text", () => {
  const error = apiError(
    403,
    {
      error: {
        code: "subscription_sharing_user_not_eligible",
        message: "access_token=secret",
      },
    },
    "req_test",
  );
  assert.match(error.message, /not available/);
  assert.doesNotMatch(error.message, /secret/);
  assert.doesNotMatch(
    apiError(400, { error: { code: "token=secret" } }, "secret with spaces")
      .message,
    /secret/,
  );
});
