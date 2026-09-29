import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  readFile,
  writeFile,
  copyFile,
  rm,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Only temporary copies receive a synthetic session. The real helper has no
// test-login bypass, injectable upstream URL or persisted credentials.
async function fixture(mode) {
  const dir = await mkdtemp(join(tmpdir(), "chatgpt-lifecycle-test-"));
  const here = dirname(fileURLToPath(import.meta.url));
  for (const name of ["core.mjs", "response.mjs", "translator.html"])
    await copyFile(join(here, name), join(dir, name));
  let source = await readFile(join(here, "server.mjs"), "utf8");
  assert.ok(source.includes("let session = null,"));
  assert.ok(source.includes("  models = [],"));
  source = source
    .replace(
      "let session = null,",
      `let session = { planEnabled: true, accessToken: "synthetic-access", refreshToken: "synthetic-refresh", clientId: "synthetic-client", subject: "synthetic-subject", scope: "chatgpt.tokens.use.direct", expiresAt: ${mode === "cancel-refresh" ? "Date.now() - 1" : "Date.now() + 3600000"} },`,
    )
    .replace("  models = [],", '  models = [{ id: "fixture-model" }],');
  await writeFile(join(dir, "server.mjs"), source);
  await writeFile(
    join(dir, "mock-upstream.mjs"),
    `
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
const dir = process.env.CHATGPT_PROTOTYPE_RUNTIME_DIR;
const mode = ${JSON.stringify(mode)};
function untilAborted(signal) {
  return new Promise((resolve, reject) => {
    const fail = () => reject(signal.reason);
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
}
globalThis.fetch = async (url, options = {}) => {
  const path = new URL(url).pathname;
  if (path === "/api/accounts/oauth/token") {
    await writeFile(join(dir, "refresh.started"), "true");
    await untilAborted(options.signal);
    throw new Error("Cancelled refresh must not continue.");
  }
  if (path === "/v1/responses") {
    await writeFile(join(dir, "inference.started"), "true");
    if (mode === "stop-inference" || mode === "logout-inference") await untilAborted(options.signal);
    if (mode === "network-error") throw new TypeError("fetch failed");
    return Response.json({ error: { code: "fixture_failure", message: "private-upstream-body" } }, { status: mode === "http-401" ? 401 : 503 });
  }
  if (path === "/.well-known/openid-configuration") return Response.json({ issuer: "https://auth.openai.com", jwks_uri: "https://auth.openai.com/keys", revocation_endpoint: "https://auth.openai.com/revoke" });
  if (path === "/revoke") { await writeFile(join(dir, "revoked"), "true"); return new Response("", { status: 200 }); }
  throw new Error("Unexpected mock upstream request.");
};
`,
  );
  const child = spawn(
    process.execPath,
    [
      "--import",
      pathToFileURL(join(dir, "mock-upstream.mjs")).href,
      join(dir, "server.mjs"),
      "--translator",
    ],
    {
      env: { ...process.env, CHATGPT_PROTOTYPE_RUNTIME_DIR: dir },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  const origin = await new Promise((resolveReady, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Fixture helper did not start.")),
      5000,
    );
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("Fixture helper exited early."));
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(
        /ChatGPT login prototype: (http:\/\/127\.0\.0\.1:[0-9]+)/,
      );
      if (match) {
        clearTimeout(timer);
        resolveReady(match[1]);
      }
    });
  });
  const html = await (await fetch(origin)).text();
  const csrf = html.match(/name="prototype-csrf" content="([^"]+)"/)[1];
  return {
    dir,
    child,
    exited,
    post: (route, body = {}) =>
      fetch(`${origin}/api/${route}`, {
        method: "POST",
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          "X-Prototype-CSRF": csrf,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      }),
    async mark(name) {
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          await access(join(dir, name));
          return;
        } catch {
          await new Promise((resolveWait) => setTimeout(resolveWait, 20));
        }
      }
      throw new Error(`Fixture did not reach ${name}.`);
    },
    async close() {
      if (child.exitCode === null) child.kill();
      await exited;
      assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
      assert.ok(basename(dir).startsWith("chatgpt-lifecycle-test-"));
      await rm(dir, { recursive: true, force: true });
    },
  };
}
const input = {
  model: "fixture-model",
  instructions: "Translate",
  input: "Hello",
  reasoning: "medium",
  schema: { type: "object" },
};

test("cancel during session refresh prevents any Responses request", async () => {
  const helper = await fixture("cancel-refresh");
  try {
    const request = helper.post("inference", input);
    await helper.mark("refresh.started");
    assert.equal((await helper.post("cancel")).status, 200);
    const response = await request;
    assert.equal(response.status, 400);
    assert.equal((await response.json()).failureCategory, "cancelled");
    await assert.rejects(access(join(helper.dir, "inference.started")));
    assert.equal((await (await helper.post("status")).json()).busy, false);
  } finally {
    await helper.close();
  }
});

for (const route of ["stop", "logout"])
  test(`${route} cancels active inference and clears the session`, async () => {
    const helper = await fixture(
      `${route === "stop" ? "stop" : "logout"}-inference`,
    );
    try {
      const request = helper.post("inference", input);
      await helper.mark("inference.started");
      const cleanup = await helper.post(route);
      assert.equal(cleanup.status, 200);
      assert.equal((await cleanup.json()).revoked, true);
      assert.equal((await (await request).json()).failureCategory, "cancelled");
      await helper.mark("revoked");
      if (route === "stop")
        await Promise.race([
          helper.exited,
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("Stopped helper stayed alive.")),
              2000,
            ),
          ),
        ]);
      else
        assert.equal(
          (await (await helper.post("status")).json()).signedIn,
          false,
        );
    } finally {
      await helper.close();
    }
  });

for (const [mode, category] of [
  ["http-503", "transient"],
  ["network-error", "transient"],
  ["http-401", "message"],
])
  test(`${mode} has a safe recovery category`, async () => {
    const helper = await fixture(mode);
    try {
      const response = await helper.post("inference", input);
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.failureCategory, category);
      assert.doesNotMatch(
        JSON.stringify(body),
        /private-upstream-body|synthetic-access|synthetic-refresh/,
      );
    } finally {
      await helper.close();
    }
  });
