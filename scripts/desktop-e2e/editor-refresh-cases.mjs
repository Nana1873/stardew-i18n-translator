import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { By, Key } from "selenium-webdriver";

// The provider reply and transport timing are controlled; scans, load_strings,
// save_string, source files and translation state use the native application.
export async function editorRefreshCases(h) {
  assert.equal(h.mods, join(h.artifacts, "runtime", "synthetic Mods"));
  const folder = join(h.mods, "EditorRefreshSmoke");
  const defaultPath = join(folder, "i18n", "default.json");
  const statePath = join(
    h.data,
    "language-state",
    "de",
    "translations",
    "E2E.EditorRefreshSmoke.json",
  );
  const settingsPath = join(h.data, "settings.json");
  const backupPath = settingsPath + ".bak";
  const originalSettings = await readFile(settingsPath);
  const originalBackup = (await h.exists(backupPath))
    ? await readFile(backupPath)
    : null;
  const source = {
    draft: "Hello.",
    background: "Background.",
    next: "Next background.",
  };
  await mkdir(join(folder, "i18n"), { recursive: true });
  await writeFile(
    join(folder, "manifest.json"),
    JSON.stringify({
      Name: "Editor refresh smoke",
      Author: "Desktop E2E",
      Version: "1.0.0",
      Description: "Synthetic editor race fixture",
      UniqueID: "E2E.EditorRefreshSmoke",
      ContentPackFor: { UniqueID: "E2E.SyntheticLoader" },
    }),
  );
  await writeFile(defaultPath, JSON.stringify(source));
  const settings = JSON.parse(originalSettings);
  settings.targetLang = "de";
  settings.ai = {
    ...settings.ai,
    defaultEngine: "chatgpt",
    cloudModel: "gpt-6.1-sol",
    cloudReasoning: "medium",
  };
  await writeFile(settingsPath, JSON.stringify(settings));
  await h.launch();
  await h.element(h.css('[aria-label="Search strings"]'));
  await h.driver().executeScript(() => {
    const original = window.fetch;
    const state = {
      request: null,
      resolveRun: null,
      hold: false,
      loads: 0,
      snapshot: null,
      releaseLoad: null,
      releaseScan: null,
      saves: [],
    };
    const reply = (value) =>
      new Response(JSON.stringify(value), {
        headers: { "Content-Type": "application/json", "Tauri-Response": "ok" },
      });
    window.fetch = (url, ...args) => {
      const endpoint = new URL(url);
      if (endpoint.hostname !== "ipc.localhost") return original(url, ...args);
      const command = decodeURIComponent(endpoint.pathname.slice(1));
      if (command === "cloud_ai_status")
        return Promise.resolve(reply({ authenticated: true }));
      if (command === "cloud_ai_models")
        return Promise.resolve(
          reply([
            {
              model: "gpt-6.1-sol",
              displayName: "Controlled model",
              isDefault: true,
              defaultReasoningEffort: "medium",
              supportedReasoningEfforts: ["medium"],
            },
          ]),
        );
      if (command === "translate_with_cloud_ai") {
        const body = args[0].body;
        state.request = JSON.parse(
          typeof body === "string" ? body : new TextDecoder().decode(body),
        ).request;
        return new Promise((resolve) => {
          state.resolveRun = resolve;
        });
      }
      if (command === "save_string") {
        const body = args[0].body;
        state.saves.push(
          JSON.parse(
            typeof body === "string" ? body : new TextDecoder().decode(body),
          ),
        );
      }
      if (state.hold && command === "scan_mods") {
        return original(url, ...args).then(
          (response) =>
            new Promise((resolve) => {
              state.releaseScan = () => resolve(response);
            }),
        );
      }
      if (state.hold && command === "load_strings") {
        state.loads += 1;
        if (state.loads === 1) {
          return original(url, ...args).then(async (response) => {
            // Capture actual native bytes before the manual save, not at release.
            state.snapshot = await response.json();
            return new Promise((resolve) => {
              state.releaseLoad = () => resolve(reply(state.snapshot));
            });
          });
        }
      }
      return original(url, ...args);
    };
    state.complete = async (text, source) => {
      const identity = state.request.identities[0];
      await window.__TAURI_INTERNALS__.invoke("save_string", {
        ...identity,
        target: text,
        status: "review-needed",
        source,
      });
      state.resolveRun(
        reply({
          runId: state.request.runId,
          engine: "chatgpt",
          model: "gpt-6.1-sol",
          reasoning: "medium",
          scope: "selected",
          requested: 1,
          completed: 1,
          outcome: "complete",
          suggestions: [
            {
              identity,
              text,
              status: "review-needed",
              tokenDifferences: [],
              glossaryMisses: [],
            },
          ],
        }),
      );
    };
    state.restore = () => {
      window.fetch = original;
      delete window.editorRefreshTest;
      delete window.editorRefreshTextarea;
    };
    window.editorRefreshTest = state;
  });
  const startRun = async (key) => {
    await h.click(h.css(`[aria-label="Select ${key}"]`));
    await h.click(h.css(".translator-bulk-button"));
    await h.click(
      By.xpath("//button[.//span[contains(.,'Translate selected with AI')]]"),
    );
    await h.waitFor("controlled background run started", () =>
      h
        .driver()
        .executeScript(
          (key) => window.editorRefreshTest.request?.identities[0].key === key,
          key,
        ),
    );
  };
  const complete = async (text, source) => {
    const error = await h.driver().executeAsyncScript(
      (text, source, done) => {
        window.editorRefreshTest.complete(text, source).then(
          () => done(null),
          (error) => done(String(error)),
        );
      },
      text,
      source,
    );
    assert.equal(error, null);
  };
  try {
    await h.click(h.css('[aria-label="Settings"]'));
    await h.click(h.button("Translation engines"));
    await h.click(
      By.xpath(
        "//button[contains(@class,'translator-engine-card')][.//strong[normalize-space(.)='ChatGPT']]",
      ),
    );
    await h.element(h.button("Sign out"));
    await h.click(h.button("Save changes"));
    await h.absent(h.css('[aria-label="Close settings"]'));
    await h.click(h.css('[data-tree-id="mod:E2E.EditorRefreshSmoke"]'));
    await h.click(h.button("All"));
    await h.step("editor-source-refresh-conflict", async () => {
      await startRun("background");
      await h.openEntry("draft");
      await h.fill(
        h.css("#translator-editor-translation"),
        "Manueller Entwurf.",
      );
      await h.driver().executeScript(() => {
        window.editorRefreshTextarea = document.querySelector(
          "#translator-editor-translation",
        );
      });
      source.draft = "Hello {{PlayerName}}.";
      await writeFile(defaultPath, JSON.stringify(source));
      await complete("Hintergrund aktualisiert.", source.background);
      await h.waitFor(
        "source conflict visible after native refresh",
        async () =>
          (
            await (
              await h.element(h.css('.translator-editor [role="alert"]'))
            ).getText()
          ).includes("English source changed"),
      );
      assert.equal(
        await h
          .driver()
          .executeScript(
            () =>
              document.activeElement === window.editorRefreshTextarea &&
              document.querySelector("#translator-editor-translation") ===
                window.editorRefreshTextarea &&
              window.editorRefreshTextarea.value === "Manueller Entwurf.",
          ),
        true,
      );
      assert.equal(
        await (await h.element(h.button("Save"))).isEnabled(),
        false,
      );
      await (
        await h.element(h.css("#translator-editor-translation"))
      ).sendKeys(Key.chord(Key.CONTROL, Key.ENTER));
      assert.equal((await h.json(statePath))["i18n\0draft"], undefined);
      await h.screenshot("editor-source-conflict");
      await h.click(h.button("Use updated source"));
      await h.click(h.button("Save"));
      await h.element(
        h.css('[aria-labelledby="translator-save-anyway-title"]'),
      );
      await h.click(h.button("Save anyway"));
      await h.absent(h.css("#translator-editor-translation"));
      const saved = (await h.json(statePath))["i18n\0draft"];
      assert.equal(saved.target, "Manueller Entwurf.");
      assert.equal(saved.sourceHash, h.hash(source.draft));
      assert.equal(saved.status, "translated-token-mismatch-accepted");
      h.evidence.editorSourceRefresh = {
        passed: true,
        controlledProvider: true,
        nativeLoadAndSave: true,
        draftAndFocusPreserved: true,
        sourceDecisionRequired: true,
        tokenDecisionRequired: true,
        saved,
      };
    });
    await h.step("editor-save-during-refresh", async () => {
      await startRun("next");
      await h.openEntry("draft");
      const target = "Gespeichert beim Refresh {{PlayerName}}.";
      await h.fill(h.css("#translator-editor-translation"), target);
      await h.driver().executeScript(() => {
        window.editorRefreshTest.hold = true;
      });
      await complete("Zweite Hintergrundaktualisierung.", source.next);
      await h.waitFor("native snapshot captured before save", () =>
        h
          .driver()
          .executeScript(() =>
            Boolean(
              window.editorRefreshTest.releaseLoad &&
              window.editorRefreshTest.releaseScan,
            ),
          ),
      );
      const snapshot = await h
        .driver()
        .executeScript(() => window.editorRefreshTest.snapshot);
      assert.equal(
        snapshot.find((row) => row.key === "draft").target,
        "Manueller Entwurf.",
      );
      assert.equal(
        await h.driver().executeScript(() => window.editorRefreshTest.loads),
        1,
      );
      await h.click(h.button("Save"));
      await h.absent(h.css("#translator-editor-translation"));
      const saved = (await h.json(statePath))["i18n\0draft"];
      assert.equal(saved.target, target);
      assert.equal(saved.status, "translated");
      assert.equal(saved.sourceHash, h.hash(source.draft));
      assert.equal(
        await h.driver().executeScript(() => window.editorRefreshTest.loads),
        1,
        "No second load may start between the captured snapshot and the successful save.",
      );
      await h
        .driver()
        .executeScript(() => window.editorRefreshTest.releaseLoad());
      await h.waitFor("fresh native load after stale response", () =>
        h.driver().executeScript(() => window.editorRefreshTest.loads === 2),
      );
      await h.waitFor(
        "saved draft and other row update remain visible",
        async () =>
          (await (await h.element(h.row("draft"))).getText()).includes(
            target,
          ) &&
          (await (await h.element(h.row("next"))).getText()).includes(
            "Zweite Hintergrundaktualisierung.",
          ),
      );
      assert.equal(
        await (await h.element(h.row("draft"))).getAttribute("data-status"),
        "translated",
      );
      await h
        .driver()
        .executeScript(() => window.editorRefreshTest.releaseScan());
      await h.waitFor("automatic scan refresh completed", () =>
        h.driver().executeScript(() => window.editorRefreshTest.loads === 3),
      );
      await h.openEntry("draft");
      assert.equal(
        await (
          await h.element(h.css("#translator-editor-translation"))
        ).getAttribute("value"),
        target,
      );
      await h.screenshot("editor-save-after-stale-refresh");
      await h.click(h.css('[aria-label="Close editor"]'));
      h.evidence.editorSaveRefresh = {
        passed: true,
        controlledTransportTiming: true,
        nativeSnapshotBeforeSave: snapshot,
        loadCountBeforeSave: 1,
        loadCountAfterStaleResponse: 2,
        loadCountAfterScan: 3,
        nativeSave: saved,
        otherRowUpdateRetained: true,
        liveProviderCalls: 0,
      };
      assert.deepEqual(await h.json(defaultPath), source);
    });
  } finally {
    await h.driver().executeScript(() => window.editorRefreshTest.restore());
    await h.closeNormally();
    await writeFile(settingsPath, originalSettings);
    if (originalBackup) await writeFile(backupPath, originalBackup);
    else await rm(backupPath, { force: true });
    assert.equal(
      folder,
      join(h.artifacts, "runtime", "synthetic Mods", "EditorRefreshSmoke"),
    );
    await rm(folder, { recursive: true, force: true });
  }
}
