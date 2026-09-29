import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { get } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

for (const translatorMode of [false, true]) {
  test(`OAuth navigation and request guards (${translatorMode ? "Translator" : "sample"})`, async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), "chatgpt-prototype-test-"));
    const serverScript = fileURLToPath(
      new URL("./server.mjs", import.meta.url),
    );
    const child = spawn(
      process.execPath,
      [serverScript, ...(translatorMode ? ["--translator"] : [])],
      {
        env: { ...process.env, CHATGPT_PROTOTYPE_RUNTIME_DIR: runtimeDir },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const exited = new Promise((resolveExit) =>
      child.once("exit", resolveExit),
    );
    try {
      const origin = await new Promise((resolveReady, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Test server did not start.")),
          10_000,
        );
        child.once("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        child.once("exit", () => {
          clearTimeout(timeout);
          reject(new Error("Test server exited before listening."));
        });
        let output = "";
        child.stdout.on("data", (chunk) => {
          output += chunk.toString();
          const match = output.match(
            /ChatGPT login prototype: (http:\/\/127\.0\.0\.1:[0-9]+)/,
          );
          if (match) {
            clearTimeout(timeout);
            resolveReady(match[1]);
          }
        });
      });
      const navigation = await fetch(origin, {
        headers: { "Sec-Fetch-Site": "cross-site" },
      });
      assert.equal(navigation.status, 200);
      const html = await navigation.text();
      assert.match(
        html,
        translatorMode ? /Translator/ : /Continue with ChatGPT/,
      );
      assert.equal(navigation.headers.get("access-control-allow-origin"), null);
      assert.match(
        navigation.headers.get("content-security-policy"),
        /frame-ancestors 'none'/,
      );
      const csrf = html.match(/name="prototype-csrf" content="([^"]+)"/)[1];
      const post = (originHeader, value) =>
        fetch(`${origin}/api/status`, {
          method: "POST",
          headers: {
            Origin: originHeader,
            "Content-Type": "application/json",
            "X-Prototype-CSRF": value,
          },
          body: "{}",
        });
      assert.equal((await post("https://example.invalid", csrf)).status, 403);
      assert.equal((await post(origin, "wrong-secret")).status, 403);
      const valid = await post(origin, csrf);
      assert.equal(valid.status, 200);
      assert.equal((await valid.json()).signedIn, false);
      for (const route of ["models", "inference"]) {
        const blocked = await fetch(`${origin}/api/${route}`, {
          method: "POST",
          headers: {
            Origin: origin,
            "Content-Type": "application/json",
            "X-Prototype-CSRF": csrf,
          },
          body: "{}",
        });
        const payload = await blocked.json();
        if (route === "models" || translatorMode) {
          assert.equal(blocked.status, 400);
          assert.match(payload.error, /Sign in and allow ChatGPT plan usage/);
        } else {
          assert.equal(blocked.status, 404);
        }
      }
      const wrongHostStatus = await new Promise((resolveStatus, reject) => {
        get(origin, { headers: { Host: "evil.invalid" } }, (response) => {
          response.resume();
          resolveStatus(response.statusCode);
        }).on("error", reject);
      });
      assert.equal(wrongHostStatus, 403);
      const callback = await fetch(
        `${origin}/auth/callback?code=test-code&state=wrong&client_id=test-client`,
      );
      assert.equal(callback.status, 400);
      const registration = JSON.parse(
        await readFile(join(runtimeDir, "registration.json"), "utf8"),
      );
      assert.deepEqual(Object.keys(registration), ["hostId"]);
    } finally {
      child.kill();
      await exited;
      const resolvedDir = resolve(runtimeDir);
      assert.equal(dirname(resolvedDir), resolve(tmpdir()));
      assert.ok(basename(resolvedDir).startsWith("chatgpt-prototype-test-"));
      await rm(resolvedDir, { recursive: true, force: true });
    }
  });
}
