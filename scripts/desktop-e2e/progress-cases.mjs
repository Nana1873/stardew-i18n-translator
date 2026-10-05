import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { By, Key } from "selenium-webdriver";

export async function progressCases(h) {
  await h.step("ai-progress-activity-log", async () => {
    assert.equal(
      h.mods,
      join(h.artifacts, "runtime", "synthetic Mods"),
      "Progress fixtures must use the isolated runtime's Mods folder.",
    );
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
    const settingsPath = join(h.data, "settings.json");
    const backupPath = settingsPath + ".bak";
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    settings.ai = { ...settings.ai, cloudModel: null };
    await writeFile(settingsPath, JSON.stringify(settings));
    await h.launch();
    // Controlled replies keep this UI acceptance independent of account access,
    // real model calls and translation quality. Events use the native event bridge.
    const intercepted = await h.driver().executeScript(() => {
      const original = window.fetch;
      let resolveRun;
      let request;
      let engine;
      let completedHistory;
      const scans = [];
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
        if (command === "list_operation_history" && completedHistory)
          return original(url, ...args).then(async (response) =>
            reply([completedHistory, ...(await response.json())].slice(0, 5)),
          );
        if (command === "scan_mods") {
          const body = args[0].body;
          scans.push(
            JSON.parse(
              typeof body === "string" ? body : new TextDecoder().decode(body),
            ),
          );
        }
        if (command === "cloud_ai_status")
          return reply({ authenticated: true });
        if (command === "cloud_ai_models")
          return reply([
            {
              model: "e2e-catalog-model",
              displayName: "E2E catalog model",
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
      window.progressTestRunId = () => request?.runId;
      window.progressTestScans = () => scans;
      window.progressTestComplete = () => {
        completedHistory = {
          id: `progress-completion-${request.runId}`,
          kind: "ai",
          outcome: "success",
          title: `${engine === "chatgpt" ? "ChatGPT" : "Local AI"} translation run`,
          summary: "1 suggestion staged for review.",
          itemCount: 1,
          canUndo: false,
          warnings: [],
          details: [{ label: "Scope", value: "Selected strings" }],
          completedAtEpochMs: Date.now(),
        };
        return reply({
          runId: request.runId,
          engine,
          model: "e2e-local-model",
          reasoning: "default",
          scope: "selected",
          requested: request.identities.length,
          completed: 1,
          outcome: "complete",
          suggestions: [
            {
              identity: request.identities[0],
              text: "Hallo {{PlayerName}} 0.",
              status: "review-needed",
              tokenDifferences: [],
              glossaryMisses: [],
            },
          ],
        }).then(resolveRun);
      };
      window.progressTestSnapshot = (payload) =>
        window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
          event: "ai-run-progress",
          payload: { ...payload, runId: request.runId },
        });
      window.restoreProgressTest = () => {
        window.fetch = original;
        delete window.progressTestReady;
        delete window.progressTestSnapshot;
        delete window.progressTestScans;
        delete window.progressTestComplete;
        delete window.progressTestRunId;
        delete window.restoreProgressTest;
      };
      return window.fetch === fetch;
    });
    assert.equal(
      intercepted,
      true,
      "The controlled IPC transport must be installed.",
    );
    let cloudProfile;
    let cloudBackup;
    try {
      await h.click(h.css('[aria-label="Settings"]'));
      await h.click(h.button("Translation engines"));
      await h.click(
        By.xpath(
          "//button[contains(@class,'translator-engine-card')][.//strong[normalize-space(.)='ChatGPT']]",
        ),
      );
      await h.element(h.button("Sign out"));
      await h.waitFor(
        "app default survives an unrelated model catalog",
        async () =>
          (await (
            await h.element(h.css('[aria-label="ChatGPT model ID"]'))
          ).getAttribute("value")) === "gpt-6.1-sol",
      );
      await h.screenshot("chatgpt-default-model");
      await h.click(h.button("Save changes"));
      await h.absent(h.css('[aria-label="Close settings"]'));
      assert.equal(
        JSON.parse(await readFile(settingsPath, "utf8")).ai.cloudModel,
        "gpt-6.1-sol",
      );
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
      // A zero-percent fill has no visible width, but its persisted count is
      // still available on the semantic progress element.
      const bar = () =>
        h
          .driver()
          .findElement(h.css('progress[aria-label="Strings saved to Review"]'));
      const log = () => h.element(h.css('#activity-log-entries[role="log"]'));
      const logSize = () =>
        h
          .driver()
          .executeScript(
            () => document.querySelectorAll("#activity-log-entries > p").length,
          );
      const waitText = (description, text) =>
        h.waitFor(description, async () =>
          (await dialog.getText()).includes(text),
        );
      const waitLogText = (description, text) =>
        h.waitFor(description, async () =>
          (await (await log()).getText()).includes(text),
        );
      await emit(snapshot);
      await waitLogText(
        "concurrent batch history",
        "Batch 3 · Checking translation quality · 94 strings",
      );
      assert.ok(
        (await log().then((el) => el.getText())).includes(
          "Batch 2 · Translating draft · 100 strings",
        ),
      );
      assert.equal(await (await bar()).getAttribute("value"), "24");
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
      await waitText("parallel progress remains active", "4 batches active");
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
          dialog.querySelectorAll("progress").length === 1 &&
          !dialog.querySelector("details") &&
          !dialog.querySelector('[role="log"]') &&
          !dialog.hasAttribute("aria-modal") &&
          dialog
            .querySelector(".desktop-ai-progress-head")
            .textContent.includes("ChatGPT") &&
          dialog.getBoundingClientRect().bottom <=
            document.querySelector(".desktop-log-panel").getBoundingClientRect()
              .top
        );
      });
      assert.equal(
        inlineLayout,
        true,
        "A nonmodal notice with one progress bar must sit above the shared activity log.",
      );
      const groups = await h.driver().executeScript(() => {
        const rows = Array.from(
          document.querySelectorAll("#activity-log-entries > p"),
        );
        const starts = rows.filter((row) => row.dataset.groupStart === "true");
        return {
          separatedAi: starts.some((row) =>
            row.textContent.includes("AI translation started"),
          ),
          separatedBatch: starts.some((row) =>
            row.textContent.includes("Batch "),
          ),
          thinDividers: starts.every((row) => {
            const style = getComputedStyle(row);
            return (
              style.borderTopStyle === "solid" &&
              parseFloat(style.borderTopWidth) === 1 &&
              parseFloat(style.marginTop) < 12
            );
          }),
        };
      });
      assert.deepEqual(
        groups,
        {
          separatedAi: true,
          separatedBatch: false,
          thinDividers: true,
        },
        "A thin divider must separate a new AI run while its parallel batch steps remain together.",
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
        await (await bar()).getAttribute("value"),
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
      await waitLogText(
        "repair and persisted save recorded",
        "83 strings saved to Review",
      );
      const history = await (await log()).getText();
      assert.ok(
        history.includes("Batch 3 · Repairing protected tokens · 1 string"),
      );
      assert.ok(
        history.includes("Batch 1 · Checking translation quality · 83 strings"),
        "Completed phases remain in chronological history.",
      );
      assert.equal(await (await bar()).getAttribute("value"), "107");
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
      await waitLogText(
        "eight batch identities logged",
        "Batch 11 · Translating draft · 100 strings",
      );
      await waitText("eight batches currently active", "8 batches active");
      const fits = await h.driver().executeScript(() => {
        const dialog = document.querySelector(
          '[aria-label="AI translation progress"]',
        );
        const box = dialog.getBoundingClientRect();
        const log = document.querySelector("#activity-log-entries");
        const logPanel = document.querySelector(".desktop-log-panel");
        return (
          box.left >= 0 &&
          box.right <= innerWidth &&
          box.top >= 0 &&
          box.bottom <= innerHeight &&
          log.scrollWidth <= log.clientWidth &&
          box.bottom <= logPanel.getBoundingClientRect().top
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
      // Restore these bytes after closing the app so later cases retain the
      // same cloud-only configuration, not just its default-engine selection.
      cloudProfile = await readFile(settingsPath);
      cloudBackup = (await h.exists(backupPath))
        ? await readFile(backupPath)
        : null;

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
      assert.ok(localText.includes("Local AI"));
      assert.equal(localText.includes("ChatGPT activity"), false);
      assert.equal(localText.includes("Quality check"), false);
      assert.equal(localText.includes("Tokens reported"), false);
      await emit({ ...serial, phase: "saving", completed: 1, translated: 1 });
      await waitLogText(
        "local saved progress",
        "Batch 1 · 1 string saved to Review",
      );
      assert.equal(await (await bar()).getAttribute("value"), "1");
      await h.screenshot("activity-log-local");
      await writeFile(
        join(h.artifacts, "activity-log-local-dialog.png"),
        await localDialog.takeScreenshot(),
        "base64",
      );
      await h.driver().executeAsyncScript((done) => {
        window.progressTestComplete().then(
          () => done(null),
          (error) => done(String(error)),
        );
      });
      await h.absent(h.css('[aria-label="AI translation progress"]'));
      await h.waitFor("one AI completion before its automatic scan", () =>
        h.driver().executeScript(() => {
          const rows = Array.from(
            document.querySelectorAll("#activity-log-entries > p"),
          );
          const completions = rows.filter((row) =>
            row.textContent.includes("Local AI translation run"),
          );
          const finished = rows.indexOf(completions[0]);
          const scan = rows.findIndex(
            (row, index) =>
              index > finished && row.textContent.includes("Scanning mods"),
          );
          return (
            completions.length === 1 &&
            finished >= 0 &&
            scan > finished &&
            !completions[0].dataset.groupStart &&
            Boolean(completions[0].querySelector("button")) &&
            rows[scan].dataset.groupStart === "true" &&
            !rows.some((row) =>
              row.textContent.includes("1 AI suggestion saved to Review"),
            )
          );
        }),
      );
      await h.click(h.css('[aria-label="Expand Activity log"]'));
      await h.screenshot("activity-log-ai-completion-before-scan");
      await h.click(h.css('[aria-label="Collapse Activity log"]'));
      // Finish a delayed German run after a real native settings/scan switch.
      // Same string identities exist in both languages, so identity alone must
      // not allow German suggestions or a stale German scan into French state.
      await writeFile(
        join(folder, "i18n/fr.json"),
        JSON.stringify({
          "row.0": "Bonjour {{PlayerName}} 0.",
        }),
      );
      const previousRunId = await h
        .driver()
        .executeScript(() => window.progressTestRunId());
      // A successful run clears the selection; select fresh input for the next.
      await h.click(h.css('[aria-label="Select all visible strings"]'));
      await h.click(h.css(".translator-bulk-button"));
      await h.click(
        By.xpath("//button[.//span[contains(.,'Translate selected with AI')]]"),
      );
      await h.element(h.css('[aria-label="AI translation progress"]'));
      await h.waitFor("new German AI run started", () =>
        h
          .driver()
          .executeScript(
            (previous) => window.progressTestRunId() !== previous,
            previousRunId,
          ),
      );
      await h.click(h.css('[aria-label="Settings"]'));
      await h.click(h.button("Folders & language"));
      await (
        await h.element(h.css('[aria-label="Target language"]'))
      ).sendKeys("French", Key.ENTER);
      await h.click(h.button("Save changes"));
      await h.absent(h.css('[aria-label="Close settings"]'));
      await h.waitFor("French strings loaded during German AI run", async () =>
        (await h.element(h.row("row.0")))
          .getText()
          .then((text) => text.includes("Bonjour")),
      );
      const scansBeforeFinish = await h
        .driver()
        .executeScript(() => window.progressTestScans());
      assert.equal(scansBeforeFinish.at(-1).targetLang, "fr");
      const frenchStatePath = join(
        h.data,
        "language-state",
        "fr",
        "translations",
        "E2E.ProgressSmoke.json",
      );
      const frenchStateBefore = await readFile(frenchStatePath);
      await h.driver().executeAsyncScript((done) => {
        window.progressTestComplete().then(
          () => done(null),
          (error) => done(String(error)),
        );
      });
      await h.absent(h.css('[aria-label="AI translation progress"]'));
      await h.element(h.css('[aria-label="Operation result"]'));
      const completedNotice = await h.element(
        h.css('[aria-label="Operation result"]'),
      );
      assert.ok((await completedNotice.getText()).includes("German (de)"));
      assert.equal(
        (await completedNotice.findElements(h.button("Open Review"))).length,
        0,
      );
      assert.deepEqual(
        await h.driver().executeScript(() => window.progressTestScans()),
        scansBeforeFinish,
      );
      assert.ok(
        (await (await h.element(h.row("row.0"))).getText()).includes("Bonjour"),
      );
      assert.deepEqual(await readFile(frenchStatePath), frenchStateBefore);
      assert.equal((await h.json(settingsPath)).targetLang, "fr");
      await h.screenshot("activity-log-ai-workspace-switch");

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
        nonmodalNotice: true,
        sharedActivityLog: true,
        noticeAboveLog: true,
        eightBatchesFit: true,
        localSerialLayout: true,
        cancellation: true,
        workspaceSwitchSafe: true,
      };
    } finally {
      await h.driver().executeScript(() => window.restoreProgressTest());
      await h.closeNormally();
      if (cloudProfile) {
        await writeFile(settingsPath, cloudProfile);
        if (cloudBackup) await writeFile(backupPath, cloudBackup);
        else await rm(backupPath, { force: true });
      }
      await rm(folder, { recursive: true, force: true });
    }
  });
}
