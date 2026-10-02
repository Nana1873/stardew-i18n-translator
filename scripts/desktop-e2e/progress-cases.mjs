import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { By } from "selenium-webdriver";

export async function progressCases(h) {
  await h.step("parallel-ai-progress-rows", async () => {
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
    await h.driver().executeScript(() => {
      const original = window.__TAURI_INTERNALS__.invoke;
      let resolveRun;
      let request;
      window.__TAURI_INTERNALS__.invoke = (command, args, options) => {
        if (command === "cloud_ai_status")
          return Promise.resolve({ authenticated: true });
        if (command === "cloud_ai_models")
          return Promise.resolve([
            {
              model: "gpt-6.1-sol",
              displayName: "GPT-6.1-Sol",
              isDefault: true,
              defaultReasoningEffort: "medium",
              supportedReasoningEfforts: ["low", "medium", "high"],
            },
          ]);
        if (command === "translate_with_cloud_ai") {
          request = args.request;
          return new Promise((resolve) => {
            resolveRun = resolve;
          });
        }
        if (command === "cancel_ai_run") {
          resolveRun({
            runId: request.runId,
            engine: "chatgpt",
            model: "gpt-6.1-sol",
            reasoning: "medium",
            scope: "selected",
            requested: 1109,
            completed: 0,
            outcome: "cancelled",
            suggestions: [],
          });
          return Promise.resolve(true);
        }
        if (command === "translate_with_local_ai")
          throw new Error("No live engine is allowed in this UI test.");
        return original(command, args, options);
      };
      window.progressTestSnapshot = (payload) =>
        original("plugin:event|emit", {
          event: "ai-run-progress",
          payload: { ...payload, runId: request.runId },
        });
      window.restoreProgressTest = () => {
        window.__TAURI_INTERNALS__.invoke = original;
        delete window.progressTestSnapshot;
        delete window.restoreProgressTest;
      };
    });
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
      await emit(snapshot);
      await h.waitFor("simultaneous draft and quality rows", async () => {
        const text = await (
          await h.element(h.css('[aria-label="AI translation progress"]'))
        ).getText();
        return (
          text.includes("Batches 2, 4 · 197 strings") &&
          text.includes("Batches 1, 3 · 177 strings")
        );
      });
      await h.screenshot("parallel-progress-mixed");
      const dialog = await h.element(
        h.css('[aria-label="AI translation progress"]'),
      );
      await writeFile(
        join(h.artifacts, "parallel-progress-dialog.png"),
        await dialog.takeScreenshot(),
        "base64",
      );
      await emit({
        ...snapshot,
        phase: "tokenRepair",
        completed: 107,
        translated: 277,
        batchActivity: [
          { batchIndex: 2, phase: "reviewing", batchSize: 100 },
          { batchIndex: 3, phase: "tokenRepair", batchSize: 1 },
          { batchIndex: 4, phase: "translating", batchSize: 97 },
        ],
      });
      await h.waitFor("finished batch removed and repair visible", async () => {
        const text = await dialog.getText();
        return (
          text.includes("3 batches active") &&
          text.includes("Batch 3 · 1 string") &&
          !text.includes("Batches 1, 3")
        );
      });
      await h.driver().manage().window().setRect({ width: 1040, height: 740 });
      await emit({
        ...snapshot,
        phase: "translating",
        parallelLimit: 8,
        batchActivity: Array.from({ length: 8 }, (_, index) => ({
          batchIndex: index + 1,
          phase: "translating",
          batchSize: 100,
        })),
      });
      await h.waitFor("eight batches visible", async () =>
        (await dialog.getText()).includes("Batches 1, 2, 3, 4, 5, 6, 7, 8"),
      );
      const fits = await h.driver().executeScript(() => {
        const dialog = document.querySelector(
          '[aria-label="AI translation progress"]',
        );
        const box = dialog.getBoundingClientRect();
        return (
          box.left >= 0 &&
          box.right <= innerWidth &&
          box.top >= 0 &&
          box.bottom <= innerHeight &&
          [...dialog.querySelectorAll(".translator-ai-phase")].every(
            (row) => row.scrollWidth <= row.clientWidth,
          )
        );
      });
      assert.equal(
        fits,
        true,
        "Parallel phase rows must fit at the minimum desktop size.",
      );
      await h.screenshot("parallel-progress-eight-batches");
      await h.click(h.button("Cancel"));
      await h.absent(h.css('[aria-label="AI translation progress"]'));
      h.evidence.aiProgress = {
        passed: true,
        controlledIpc: true,
        nativeEvents: true,
        liveProviderCalls: 0,
        mixedPhases: true,
        finishedBatchRemoved: true,
        repairVisible: true,
        eightBatchesFit: true,
        cancellation: true,
      };
    } finally {
      await h.driver().executeScript(() => window.restoreProgressTest());
      await h.closeNormally();
    }
  });
}
