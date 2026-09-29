import {
  createHash,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify,
} from "node:crypto";

export const AUTH_ORIGIN = "https://auth.openai.com";
export const RESOURCE = "https://api.openai.com/v1";
export const PLAN_SCOPE = "chatgpt.tokens.use.direct";
export const APP_NAME = "Stardew i18n Translator";
export const SCOPES = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;

export function equalSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function beginAuthorization(hostId, redirectUri, registration) {
  const attempt = {
    state: randomBytes(32).toString("base64url"),
    nonce: randomBytes(32).toString("base64url"),
    verifier: randomBytes(32).toString("base64url"),
    redirectUri,
    registration,
    createdAt: Date.now(),
  };
  const url = new URL(`${AUTH_ORIGIN}/api/accounts/authorize`);
  const params = {
    client_id: registration?.clientId ?? "dynamic_agent_client",
    ext_agent_host_id: hostId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: SCOPES,
    resource: RESOURCE,
    state: attempt.state,
    nonce: attempt.nonce,
    code_challenge_method: "S256",
    code_challenge: createHash("sha256")
      .update(attempt.verifier)
      .digest("base64url"),
  };
  if (!registration) params.agent_name_hint = APP_NAME;
  url.search = new URLSearchParams(params).toString();
  return { attempt, url: url.href };
}

export function validateCallback(params, attempt, now = Date.now()) {
  if (
    !attempt ||
    now - attempt.createdAt > 10 * 60_000 ||
    !equalSecret(params.get("state"), attempt.state)
  ) {
    throw new Error("This sign-in attempt is invalid or expired. Start again.");
  }
  for (const key of ["state", "code", "client_id", "error", "iss"]) {
    if (params.getAll(key).length > 1)
      throw new Error("The sign-in callback contains duplicate parameters.");
  }
  if (params.has("iss") && params.get("iss") !== AUTH_ORIGIN)
    throw new Error("The sign-in issuer does not match OpenAI.");
  if (params.has("error"))
    throw new Error(
      "Sign-in was declined or could not be completed. Start again when ready.",
    );
  const code = params.get("code");
  const clientId = params.get("client_id") ?? attempt.registration?.clientId;
  if (
    !code ||
    code.length > 8192 ||
    !clientId ||
    clientId === "dynamic_agent_client" ||
    clientId.length > 512
  ) {
    throw new Error("OpenAI did not return a complete client registration.");
  }
  if (attempt.registration && clientId !== attempt.registration.clientId)
    throw new Error("The returning client registration changed unexpectedly.");
  return { code, clientId };
}

export async function readBounded(response, limit = 512 * 1024) {
  if (!response.body) throw new Error("The service returned no response body.");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit)
        throw new Error("The service response exceeded the size limit.");
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function apiError(status, body, requestId) {
  const rawCode = body?.error?.code;
  const code =
    typeof rawCode === "string" && /^[a-zA-Z0-9_.-]{1,100}$/.test(rawCode)
      ? rawCode
      : "request_failed";
  const guidance = {
    subscription_sharing_user_not_eligible:
      "ChatGPT plan use is not available for this account or workspace yet.",
    subscription_sharing_usage_limit_exceeded:
      "An app or ChatGPT plan usage limit was reached. Check ChatGPT usage settings.",
    subscription_sharing_usage_unavailable:
      "ChatGPT plan usage is temporarily unavailable. Try later.",
    subscription_sharing_unsupported_capability:
      "This preview does not support the requested capability.",
    invalid_grant: "The sign-in or renewable session expired. Sign in again.",
    invalid_client: "OpenAI did not accept this client registration.",
  };
  const message =
    guidance[code] ??
    (status === 503
      ? "The direct route is unavailable or not enabled yet. Try later."
      : status === 403
        ? "OpenAI refused this request under the current account, region or workspace policy."
        : status === 401
          ? "OpenAI did not accept the session or required plan permission."
          : "OpenAI could not complete this request.");
  const id =
    typeof requestId === "string" && /^[a-zA-Z0-9_-]{1,120}$/.test(requestId)
      ? ` Request ID: ${requestId}.`
      : "";
  const error = new Error(`${message} HTTP ${status}; ${code}.${id}`);
  error.failureCategory =
    status >= 500 && status <= 599 ? "transient" : "message";
  return error;
}

export async function requestJson(url, options = {}, fetcher = fetch) {
  let response;
  try {
    response = await fetcher(url, {
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      ...options,
    });
  } catch (cause) {
    if (cause.name === "AbortError" || cause.name === "TimeoutError")
      throw cause;
    const error = new Error(
      "Could not reach OpenAI. Check the network and try again.",
    );
    error.failureCategory = "transient";
    throw error;
  }
  let data;
  try {
    data = JSON.parse(await readBounded(response, 2 * 1024 * 1024));
  } catch (cause) {
    if (cause.name === "AbortError" || cause.name === "TimeoutError")
      throw cause;
    if (cause instanceof TypeError) {
      const error = new Error(
        "The OpenAI response was interrupted. Try again.",
      );
      error.failureCategory = "transient";
      throw error;
    }
    throw new Error(
      `OpenAI returned an unreadable or oversized response (HTTP ${response.status}).`,
    );
  }
  if (!response.ok)
    throw apiError(response.status, data, response.headers.get("x-request-id"));
  return data;
}

export function trustedAuthEndpoint(value) {
  const url = new URL(value);
  if (url.origin !== AUTH_ORIGIN || url.username || url.password || url.hash)
    throw new Error("OpenAI discovery returned an unexpected endpoint.");
  return url.href;
}

export async function discovery(fetcher = fetch) {
  const data = await requestJson(
    `${AUTH_ORIGIN}/.well-known/openid-configuration`,
    {},
    fetcher,
  );
  if (data.issuer !== AUTH_ORIGIN)
    throw new Error("OpenAI discovery returned an unexpected issuer.");
  trustedAuthEndpoint(data.jwks_uri);
  if (data.revocation_endpoint) trustedAuthEndpoint(data.revocation_endpoint);
  return data;
}

export function validateIdToken(
  token,
  keys,
  clientId,
  nonce,
  expectedSubject,
  now = Date.now() / 1000,
) {
  if (typeof token !== "string" || token.length > 64 * 1024)
    throw new Error("OpenAI did not return a valid identity token.");
  const parts = token.split(".");
  if (
    parts.length !== 3 ||
    parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))
  )
    throw new Error("The identity token is malformed.");
  const header = JSON.parse(Buffer.from(parts[0], "base64url"));
  const claims = JSON.parse(Buffer.from(parts[1], "base64url"));
  if (header.alg !== "RS256" || header.crit || typeof header.kid !== "string")
    throw new Error(
      "The identity token uses an unsupported signing algorithm.",
    );
  const candidates = keys.filter(
    (key) =>
      key.kid === header.kid &&
      key.kty === "RSA" &&
      (!key.use || key.use === "sig") &&
      (!key.alg || key.alg === "RS256"),
  );
  if (candidates.length !== 1)
    throw new Error("OpenAI's signing key was not found uniquely.");
  const publicKey = createPublicKey({ key: candidates[0], format: "jwk" });
  if (
    publicKey.asymmetricKeyDetails?.modulusLength < 2048 ||
    !verify(
      "RSA-SHA256",
      Buffer.from(`${parts[0]}.${parts[1]}`),
      publicKey,
      Buffer.from(parts[2], "base64url"),
    )
  )
    throw new Error("The identity token signature was not accepted.");
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (
    claims.iss !== AUTH_ORIGIN ||
    !audiences.includes(clientId) ||
    (audiences.length > 1 && claims.azp !== clientId) ||
    (claims.azp && claims.azp !== clientId)
  )
    throw new Error(
      "The identity token issuer or audience does not match this registration.",
    );
  if (
    !Number.isFinite(claims.exp) ||
    claims.exp <= now ||
    !Number.isFinite(claims.iat) ||
    claims.iat > now + 60 ||
    (claims.nbf !== undefined &&
      (!Number.isFinite(claims.nbf) || claims.nbf > now + 60))
  )
    throw new Error("The identity token is expired or not valid yet.");
  if (
    !equalSecret(claims.nonce, nonce) ||
    typeof claims.sub !== "string" ||
    !claims.sub ||
    claims.sub.length > 512 ||
    (expectedSubject && claims.sub !== expectedSubject)
  )
    throw new Error(
      "The identity token does not match this sign-in attempt or account.",
    );
  return {
    subject: claims.sub,
    email: typeof claims.email === "string" ? claims.email.slice(0, 254) : null,
  };
}

export function sessionFromTokens(data, identity, clientId, previous) {
  if (
    typeof data.access_token !== "string" ||
    !data.access_token ||
    data.access_token.length > 64 * 1024 ||
    String(data.token_type).toLowerCase() !== "bearer" ||
    !Number.isFinite(data.expires_in) ||
    data.expires_in <= 0
  )
    throw new Error("OpenAI returned an incomplete access token.");
  const scope = data.scope ?? previous?.scope;
  if (typeof scope !== "string")
    throw new Error("OpenAI did not return granted permissions.");
  return {
    ...identity,
    clientId,
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? previous?.refreshToken,
    scope,
    planEnabled: scope.split(/\s+/).includes(PLAN_SCOPE),
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

export async function exchangeCode(code, clientId, attempt, fetcher = fetch) {
  const data = await requestJson(
    `${AUTH_ORIGIN}/api/accounts/oauth/token`,
    {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        code_verifier: attempt.verifier,
        redirect_uri: attempt.redirectUri,
        resource: RESOURCE,
      }),
    },
    fetcher,
  );
  const config = await discovery(fetcher);
  const jwks = await requestJson(
    trustedAuthEndpoint(config.jwks_uri),
    {},
    fetcher,
  );
  if (!Array.isArray(jwks.keys))
    throw new Error("OpenAI did not return its signing keys.");
  const identity = validateIdToken(
    data.id_token,
    jwks.keys,
    clientId,
    attempt.nonce,
    attempt.registration?.subject,
  );
  return sessionFromTokens(data, identity, clientId);
}

export function visibleModels(data, includeReasoning = false) {
  if (!Array.isArray(data.models))
    throw new Error(
      "OpenAI did not return the documented ChatGPT model catalog.",
    );
  return data.models
    .filter(
      (model) =>
        model.visibility === "list" &&
        typeof model.slug === "string" &&
        /^[a-zA-Z0-9_.:-]{1,160}$/.test(model.slug),
    )
    .map((model) => ({
      id: model.slug,
      name:
        typeof model.display_name === "string"
          ? model.display_name.slice(0, 200)
          : model.slug,
      ...(includeReasoning
        ? {
            supportedReasoningEfforts: [
              ...new Set(
                (Array.isArray(model.supported_reasoning_levels)
                  ? model.supported_reasoning_levels.map(
                      (level) =>
                        level?.effort ?? level?.reasoning_effort ?? level,
                    )
                  : Array.isArray(model.supported_reasoning_efforts)
                    ? model.supported_reasoning_efforts.map(
                        (level) => level?.reasoning_effort ?? level,
                      )
                    : [
                          "gpt-6-astra",
                          "gpt-5.6-sol",
                          "gpt-5.6-terra",
                          "gpt-5.6-luna",
                          "gpt-5.5",
                        ].includes(model.slug)
                      ? ["low", "medium", "high"]
                      : []
                ).filter((effort) =>
                  ["low", "medium", "high"].includes(effort),
                ),
              ),
            ],
          }
        : {}),
    }));
}

export { consumeResponseStream } from "./response.mjs";

export function sampleTokenCheck(source, translation) {
  const tokens = (value) =>
    [...value.matchAll(/\{\{[^{}\r\n]+\}\}/g)].map((match) => match[0]).sort();
  return JSON.stringify(tokens(source)) === JSON.stringify(tokens(translation));
}
