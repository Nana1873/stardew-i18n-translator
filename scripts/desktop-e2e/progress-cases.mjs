import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { By } from "selenium-webdriver";

export async function progressCases(h) {
  await h.step("ai-progress-activity-log", async () => {
    const folder = join(h.mods, "ProgressSmoke");
    await mkdir(join(folder, "i18n"), { recursive: true });
    await writeFile(
      join(folder, "manifest.json"),
      JSON.stringify({
        Name: "Parallel progress smoke",
        Author: "Desktop E2E",
        Version: "1.0.0",
        Description: "Synthetic UI progress fixture",
        UniqueID: "E2E.ProgressSmoke",
        ContentPackFor: { UniqueID: "E2E.SyntheticLoader" },
      }),
    );
    await writeFile(
      join(folder, "i18n/default.json"),
      JSON.stringify(
        Object.fromEntries(
          Array.from({ length: 1109 }, (_, i) => [
            `row.${i}`,
            `Hello {{PlayerName}} ${i}.`,
          ]),
        ),
      ),
    );
    await h.launch();
    // Controlled replies keep this UI acceptance independent of account access,
    // real model calls and translation quality. Events use the native event bridge.
    const intercepted = await h.driver().executeScript(() => {
      const original = window.fetch;
      let resolveRun;
      let request;
      let engine;
      const reply = (value) =>
        Promise.resolve(
          new Response(JSON.stringify(value), {
            headers: {
              "Content-Type": "application/json",
              "Tauri-Response": "ok",
            },
          }),
        );
      const fetch = (url, ...args) => {
        const endpoint = new URL(url);
        if (endpoint.hostname !== "ipc.localhost")
          return original(url, ...args);
        const command = decodeURIComponent(endpoint.pathname.slice(1));
        if (command === "cloud_ai_status")
          return reply({ authenticated: true });
        if (command === "cloud_ai_models")
          return reply([
            {
              model: "gpt-6.1-sol",
              displayName: "GPT-6.1-Sol",
              isDefault: true,
              defaultReasoningEffort: "medium",
              supportedReasoningEfforts: ["low", "medium", "high"],
            },
          ]);
        if (command === "llm_models") return reply(["e2e-local-model"]);
        if (
          command === "translate_with_cloud_ai" ||
          command === "translate_with_local_ai"
        ) {
          engine = command === "translate_with_cloud_ai" ? "chatgpt" : "local";
          const body = args[0].body;
          request = JSON.parse(
            typeof body === "string" ? body : new TextDecoder().decode(body),
          ).request;
          return new Promise((resolve) => {
            resolveRun = resolve;
          });
        }
        if (command === "cancel_ai_run") {
          reply({
            runId: request.runId,
            engine,
            model: engine === "chatgpt" ? "gpt-6.1-sol" : "e2e-local-model",
            reasoning: engine === "chatgpt" ? "medium" : "default",
            scope: "selected",
            requested: 1109,
            completed: 0,
            outcome: "cancelled",
            suggestions: [],
          }).then(resolveRun);
          return reply(true);
        }
        return original(url, ...args);
      };
      window.fetch = fetch;
      window.progressTestReady = (expected) =>
        Boolean(request) && engine === expected;
      window.progressTestSnapshot = (payload) =>
        window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
          event: "ai-run-progress",
          payload: { ...payload, runId: request.runId },
        });
      window.restoreProgressTest = () => {
        window.fetch = original;
        delete window.progressTestReady;
        delete window.progressTestSnapshot;
        delete window.restoreProgressTest;
      };
      return window.fetch === fetch;
    });
    assert.equal(
      intercepted,
      true,
      "The controlled IPC transport must be installed.",
    );
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
      await h.click(h.button("Workspace"));
      await h.click(h.css('[data-tree-id="mod:E2E.ProgressSmoke"]'));
      await h.click(h.button("All"));
      await h.click(h.css('[aria-label="Select all visible strings"]'));
      await h.click(h.css(".translator-bulk-button"));
      await h.click(
        By.xpath("//button[.//span[contains(.,'Translate selected with AI')]]"),
      );
      await h.element(h.css('[aria-label="AI translation progress"]'));
      await h.waitFor("controlled translation command started", () =>
        h.driver().executeScript(() => window.progressTestReady("chatgpt")),
      );
      const snapshot = {
        phase: "reviewing",
        completed: 24,
        translated: 177,
        total: 1109,
        batchIndex: 3,
        batchTotal: 13,
        batchSize: 94,
        activeBatches: 4,
        parallelLimit: 4,
        retries: 0,
        splits: 0,
        batchActivity: [
          { batchIndex: 1, phase: "reviewing", batchSize: 83 },
          { batchIndex: 2, phase: "translating", batchSize: 100 },
          { batchIndex: 3, phase: "reviewing", batchSize: 94 },
          { batchIndex: 4, phase: "translating", batchSize: 97 },
        ],
      };
      const emit = (payload) =>
        h
          .driver()
          .executeAsyncScript((value, done) => {
            window.progressTestSnapshot(value).then(
              () => done(null),
              (error) => done(String(error)),
            );
          }, payload)
          .then((error) => assert.equal(error, null));
      const dialog = await h.element(
        h.css('[aria-label="AI translation progress"]'),
      );
      const bar = () =>
        h.element(
          h.css('[role="progressbar"][aria-label="AI translation progress"]'),
        );
      const log = () =>
        h.element(h.css('[role="log"][aria-label="Batch activity"]'));
      const logSize = () =>
        h
          .driver()
          .executeScript(
            () => document.querySelectorAll('[role="log"] li').length,
          );
      const waitText = (description, text) =>
        h.waitFor(description, async () =>
          (await dialog.getText()).includes(text),
        );
      await emit(snapshot);
      await waitText(
        "concurrent batch history",
        "Batch 3 · Checking translation quality · 94 strings",
      );
      assert.ok(
        (await log().then((el) => el.getText())).includes(
          "Batch 2 · Translating draft · 100 strings",
        ),
      );
      assert.equal(await (await bar()).getAttribute("aria-valuenow"), "24");
      const initialLogSize = await logSize();
      const withProvider = {
        ...snapshot,
        providerStage: "reasoning",
        providerActivitySequence: 1,
        usage: {
          inputTokens: 18200,
          outputTokens: 3300,
          reasoningOutputTokens: 640,
          cachedInputTokens: 0,
        },
      };
      await emit(withProvider);
      await waitText("provider usage displayed", "18.2k input");
      assert.equal(
        await logSize(),
        initialLogSize,
        "Streaming updates must not duplicate batch history.",
      );
      const inlineLayout = await h.driver().executeScript(() => {
        const dialog = document.querySelector(
          '[aria-label="AI translation progress"]',
        );
        return (
          dialog.querySelectorAll('[role="progressbar"]').length === 1 &&
          !dialog.querySelector("details") &&
          !dialog.querySelector(".translator-flow-head svg") &&
          dialog.querySelector(".translator-kicker").textContent ===
            "ChatGPT · GPT 6.1 Sol · Medium" &&
          dialog.querySelector(".translator-ai-facts").getBoundingClientRect()
            .bottom <=
            dialog.querySelector('[role="log"]').getBoundingClientRect().top
        );
      });
      assert.equal(
        inlineLayout,
        true,
        "One progress bar and inline run facts must precede the activity log.",
      );
      await h.screenshot("activity-log-cloud");
      await writeFile(
        join(h.artifacts, "activity-log-cloud-dialog.png"),
        await dialog.takeScreenshot(),
        "base64",
      );
      const remaining = withProvider.batchActivity.slice(1);
      await emit({
        ...withProvider,
        activeBatches: 3,
        batchActivity: remaining,
      });
      await waitText("current concurrency updated", "3 batches active");
      assert.equal(
        await (await bar()).getAttribute("aria-valuenow"),
        "24",
        "Removal alone must not advance saved progress.",
      );
      assert.equal(
        await logSize(),
        initialLogSize,
        "Removal alone must not invent a save event.",
      );
      await emit({
        ...withProvider,
        phase: "tokenRepair",
        completed: 107,
        translated: 277,
        activeBatches: 3,
        batchActivity: [
          { batchIndex: 2, phase: "reviewing", batchSize: 100 },
          { batchIndex: 3, phase: "tokenRepair", batchSize: 1 },
          { batchIndex: 4, phase: "translating", batchSize: 97 },
        ],
      });
      await waitText(
        "repair and persisted save recorded",
        "83 suggestions saved to Review · 107 / 1109",
      );
      const history = await (await log()).getText();
      assert.ok(
        history.includes("Batch 3 · Repairing protected tokens · 1 string"),
      );
      assert.ok(
        history.includes("Batch 1 · Checking translation quality · 83 strings"),
        "Completed phases remain in chronological history.",
      );
      assert.equal(await (await bar()).getAttribute("aria-valuenow"), "107");
      await h.driver().manage().window().setRect({ width: 1040, height: 740 });
      await emit({
        ...withProvider,
        phase: "translating",
        completed: 107,
        translated: 277,
        activeBatches: 8,
        parallelLimit: 8,
        batchActivity: Array.from({ length: 8 }, (_, index) => ({
          batchIndex: index + 4,
          phase: "translating",
          batchSize: 100,
        })),
      });
      await waitText(
        "eight batch identities logged",
        "Batch 11 · Translating draft · 100 strings",
      );
      await waitText(
        "eight batches currently active",
        "8 batches active · up to 8",
      );
      const fits = await h.driver().executeScript(() => {
        const dialog = document.querySelector(
          '[aria-label="AI translation progress"]',
        );
        const box = dialog.getBoundingClientRect();
        const log = dialog.querySelector('[role="log"]');
        return (
          box.left >= 0 &&
          box.right <= innerWidth &&
          box.top >= 0 &&
          box.bottom <= innerHeight &&
          log.scrollWidth <= log.clientWidth &&
          log.clientHeight <= 190
        );
      });
      assert.equal(
        fits,
        true,
        "Eight concurrent batches must fit at the minimum desktop size.",
      );
      await h.screenshot("activity-log-eight-batches");
      await h.click(h.button("Cancel"));
      await h.absent(h.css('[aria-label="AI translation progress"]'));

      // The Local AI command is intercepted as well: this proves the shared UI
      // without contacting a server or loading a model on the user's GPU.
      await h.click(h.css('[aria-label="Settings"]'));
      await h.click(h.button("Translation engines"));
      await h.click(
        By.xpath(
          "//button[contains(@class,'translator-engine-card')][.//strong[normalize-space(.)='Local AI']]",
        ),
      );
      await h.fill(
        h.css('[aria-label="AI base URL"]'),
        "http://localhost:1234/v1",
      );
      await h.click(h.button("Test connection"));
      await h.waitFor(
        "controlled local model selected",
        async () =>
          (await (
            await h.element(h.css('[aria-label="AI model"]'))
          ).getAttribute("value")) === "e2e-local-model",
      );
      await h.click(h.button("Save changes"));
      await h.absent(h.css('[aria-label="Close settings"]'));
      await h.click(h.css(".translator-bulk-button"));
      await h.click(
        By.xpath("//button[.//span[contains(.,'Translate selected with AI')]]"),
      );
      await h.element(h.css('[aria-label="AI translation progress"]'));
      await h.waitFor("controlled local command started", () =>
        h.driver().executeScript(() => window.progressTestReady("local")),
      );
      const serial = {
        phase: "translating",
        completed: 0,
        translated: 0,
        total: 1109,
        batchIndex: 1,
        batchTotal: 1109,
        batchSize: 1,
        retries: 0,
        splits: 0,
      };
      await emit(serial);
      const localDialog = await h.element(
        h.css('[aria-label="AI translation progress"]'),
      );
      await h.waitFor("local serial log", async () =>
        (await localDialog.getText()).includes(
          "Batch 1 · Translating draft · 1 string",
        ),
      );
      const localText = await localDialog.getText();
      assert.ok(localText.includes("Local AI · e2e-local-model · Default"));
      assert.ok(localText.includes("Drafts received"));
      assert.equal(localText.includes("ChatGPT activity"), false);
      assert.equal(localText.includes("Quality check"), false);
      assert.equal(localText.includes("Tokens reported"), false);
      await emit({ ...serial, phase: "saving", completed: 1, translated: 1 });
      await h.waitFor("local saved progress", async () =>
        (await localDialog.getText()).includes(
          "1 suggestion saved to Review · 1 / 1109",
        ),
      );
      assert.equal(await (await bar()).getAttribute("aria-valuenow"), "1");
      await h.screenshot("activity-log-local");
      await writeFile(
        join(h.artifacts, "activity-log-local-dialog.png"),
        await localDialog.takeScreenshot(),
        "base64",
      );
      await h.click(h.button("Cancel"));
      await h.absent(h.css('[aria-label="AI translation progress"]'));
      h.evidence.aiProgress = {
        passed: true,
        controlledIpc: true,
        nativeEvents: true,
        liveProviderCalls: 0,
        oneProgressBar: true,
        saveOnlyProgress: true,
        phaseHistory: true,
        providerUpdateDedup: true,
        repairVisible: true,
        inlineFacts: true,
        eightBatchesFit: true,
        localSerialLayout: true,
        cancellation: true,
      };
    } finally {
      await h.driver().executeScript(() => window.restoreProgressTest());
      await h.closeNormally();
    }
  });
}
