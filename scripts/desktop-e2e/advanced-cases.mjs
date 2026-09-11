import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { By, Key } from "selenium-webdriver";

export async function advancedCases(h) {
  const {
    options,
    evidence,
    step,
    click,
    css,
    button,
    row,
    element,
    fill,
    absent,
    screenshot,
    openEntry,
    saveEntry,
    waitFor,
    json,
    exists,
    native,
    mods,
    data,
    artifacts,
  } = h;
  let driver;
  const launch = async (scale) => {
    await h.launch(scale);
    driver = h.driver();
    await click(button("Workspace"));
  };
  const selectMod = async (id) => {
    await click(css(`[data-tree-id="mod:${id}"]`));
    await click(button("All"));
    await fill(css('[aria-label="Search strings"]'), "");
  };
  const rescan = async () => {
    await click(css('[aria-label="Scan mods"]'));
    await element(css('[aria-label="Latest scan result"]'));
    await click(css('[aria-label="Close scan"]'));
    await absent(css('[role="dialog"][aria-label="Scan"]'));
  };
  const fixture = async (name, id, source) => {
    const folder = join(mods, name);
    await mkdir(join(folder, "i18n"), { recursive: true });
    await writeFile(
      join(folder, "manifest.json"),
      JSON.stringify({
        Name: name,
        UniqueID: id,
        Author: "Synthetic E2E fixture",
        Version: "1.0.0",
        Description: "Generated test data only",
        ContentPackFor: { UniqueID: "Pathoschild.ContentPatcher" },
      }),
    );
    await writeFile(join(folder, "i18n/default.json"), JSON.stringify(source));
    return folder;
  };
  const select = async (locator, value) => {
    const control = await element(locator);
    const option = await control.findElement(
      By.css(`option[value=${JSON.stringify(value)}]`),
    );
    await control.sendKeys(
      Key.HOME,
      await option.getAttribute("textContent"),
      Key.ENTER,
    );
    await waitFor(
      "selected option",
      async () => (await control.getAttribute("value")) === value,
    );
  };
  if (options.layout) {
    evidence.layout = [];
    for (const scale of [1, 1.25, 1.5, 2]) {
      await step(`layout-render-scale-${scale}`, async () => {
        await launch(scale);
        await driver.manage().window().setRect({
          width: 1100,
          height: 780,
        });
        await selectMod("E2E.DesktopSmoke");
        const measure = async (name, selectors) => {
          const result = await driver.executeScript((selectors) => {
            const controls = selectors.map((selector) => {
              const node = document.querySelector(selector);
              if (!node) return { selector, missing: true };
              const rect = node.getBoundingClientRect();
              const hit = document.elementFromPoint(
                rect.x + rect.width / 2,
                rect.y + rect.height / 2,
              );
              return {
                selector,
                width: rect.width,
                height: rect.height,
                inside:
                  rect.x >= -1 &&
                  rect.y >= -1 &&
                  rect.right <= innerWidth + 1 &&
                  rect.bottom <= innerHeight + 1,
                unobstructed: hit === node || node.contains(hit),
              };
            });
            return {
              width: innerWidth,
              height: innerHeight,
              ratio: devicePixelRatio,
              overflow: document.documentElement.scrollWidth > innerWidth + 1,
              controls,
            };
          }, selectors);
          evidence.layout.push({ scale, screen: name, ...result });
          assert.ok(
            Math.abs(result.ratio - scale) < 0.02,
            "WebView did not apply the requested rendering scale.",
          );
          assert.equal(
            result.width,
            1100,
            "Keep the logical viewport fixed across rendering scales.",
          );
          assert.equal(result.height, 780);
          assert.equal(
            result.overflow,
            false,
            `${name}: horizontal page overflow`,
          );
          for (const control of result.controls)
            assert.ok(
              !control.missing &&
                control.width > 0 &&
                control.height > 0 &&
                control.inside &&
                control.unobstructed,
              `${name}: inaccessible/clipped ${control.selector}`,
            );
          await screenshot(`layout-${scale}-${name}`);
        };
        await measure("workspace", [
          '[aria-label="Settings"]',
          '[aria-label="Search strings"]',
          '[aria-label="Scan mods"]',
        ]);
        await openEntry("greeting");
        await measure("editor", [
          "#translator-editor-translation",
          '[aria-label="Close editor"]',
          ".translator-editor-actions button",
        ]);
        await click(css('[aria-label="Close editor"]'));
        await click(css('[aria-label="Settings"]'));
        await measure("settings", [
          '[aria-label="Close settings"]',
          '[role="tab"][aria-controls="settings-panel-glossary"]',
        ]);
        await click(css('[aria-label="Close settings"]'));
        await h.closeNormally();
      });
    }
    await writeFile(
      join(artifacts, "layout.json"),
      JSON.stringify(evidence.layout, null, 2),
    );
  }
  if (options.stress) {
    await step("stress-20000-strings-edit-rescan-export-restart", async () => {
      await launch();
      const sources = Object.fromEntries(
        Array.from({ length: 1000 }, (_, i) => [
          `entry.${String(i).padStart(4, "0")}`,
          `Synthetic source ${i} for {{PlayerName}}.`,
        ]),
      );
      for (let i = 0; i < 20; i++)
        await fixture(
          `Stress ${String(i).padStart(2, "0")}`,
          `E2E.Stress${i}`,
          sources,
        );
      const started = performance.now();
      await rescan();
      const scanMs = performance.now() - started;
      assert.ok(scanMs < 30000, "20,000-string scan exceeded 30 seconds.");
      const discovered = await driver.findElements(
        css('[data-tree-id^="mod:E2E.Stress"]'),
      );
      assert.equal(
        discovered.length,
        20,
        "All 20 synthetic mods must be discovered.",
      );
      for (const mod of discovered)
        assert.equal(
          await mod.getAttribute("data-mod-progress"),
          "0 / 1000 · 0%",
          "Each stress mod must report all 1,000 source strings.",
        );
      await selectMod("E2E.Stress0");
      const before = JSON.parse(await native("metrics"));
      const edits = {};
      const samples = [];
      for (let i = 0; i < 20; i++) {
        const key = `entry.${String(i * 49).padStart(4, "0")}`;
        const value = `Gespeichert ${i} fuer {{PlayerName}}.`;
        const tick = performance.now();
        await fill(css('[aria-label="Search strings"]'), key);
        await saveEntry(key, value);
        const ms = performance.now() - tick;
        assert.ok(ms < 5000, `Search/edit cycle ${i} exceeded 5 seconds.`);
        edits[key] = value;
        samples.push(ms);
        if (i % 5 === 4) await rescan();
      }
      await click(button("Export …"));
      await click(button("Export current mod"));
      await click(button("Export"));
      const output = join(mods, "Stress 00/i18n/de.json");
      await waitFor("stress export", () => exists(output));
      assert.deepEqual(await json(output), edits);
      const state = join(
        data,
        "language-state/de/translations/E2E.Stress0.json",
      );
      const saved = await json(state);
      assert.equal(Object.keys(saved).length, 20);
      const after = JSON.parse(await native("metrics"));
      assert.ok(
        after.privateBytes - before.privateBytes < 256 * 1024 * 1024,
        "Backend private memory grew by more than 256 MiB during the bounded repetition.",
      );
      assert.ok(
        after.handles - before.handles < 200,
        "Backend handle count grew by 200 or more.",
      );
      evidence.stress = {
        mods: 20,
        strings: 20000,
        cycles: 20,
        scanMs,
        editMs: samples,
        before,
        after,
      };
      await screenshot("stress-exported");
      await copyFile(output, join(artifacts, "stress-exported.json"));
      await h.closeNormally();
      await launch();
      await selectMod("E2E.Stress0");
      await fill(css('[aria-label="Search strings"]'), "entry.0931");
      await openEntry("entry.0931");
      assert.equal(
        await (
          await element(css("#translator-editor-translation"))
        ).getAttribute("value"),
        edits["entry.0931"],
      );
      assert.deepEqual(await json(state), saved);
      assert.deepEqual(
        await json(join(mods, "Stress 00/i18n/default.json")),
        sources,
      );
      await click(css('[aria-label="Close editor"]'));
      await h.closeNormally();
      await writeFile(
        join(artifacts, "stress.json"),
        JSON.stringify(evidence.stress, null, 2),
      );
    });
  }
  const engines =
    options.liveAi === "both"
      ? ["local", "codex"]
      : ["local", "codex"].filter((engine) => engine === options.liveAi);
  evidence.liveAi = [];
  for (const engine of engines) {
    await step(`live-${engine}-translate-review-export-restart`, async () => {
      await launch();
      const id = `E2E.Live${engine}`;
      const source = {
        morning: "Good morning {{PlayerName}}!",
        task: "Please bring {{Count}} Parsnips.",
      };
      const folder = await fixture(`Live ${engine}`, id, source);
      await rescan();
      await selectMod(id);
      await click(css('[aria-label="Settings"]'));
      await click(css('[role="tab"][aria-controls="settings-panel-ai"]'));
      // Initial availability discovery can select the available default engine.
      // Choose the test engine after that state transition has completed.
      await waitFor(
        "initial engine discovery completed",
        async () =>
          (
            await driver.findElements(
              By.xpath(
                '//section[@aria-label="Codex CLI"]//button[normalize-space(.)="Check status"]',
              ),
            )
          ).length === 1,
        60000,
      );
      await click(
        By.xpath(
          `//button[.//strong[normalize-space(.)="${engine === "local" ? "Local AI" : "Codex CLI"}"]]`,
        ),
      );
      if (engine === "local") {
        assert.ok(
          options.localModel,
          "Live Local AI requires -LocalModel with an already loaded real model identifier.",
        );
        const url = new URL(options.localUrl);
        assert.ok(
          url.protocol === "http:" &&
            ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
            !url.username &&
            !url.password,
          "Local AI test endpoint must use loopback HTTP without credentials.",
        );
        await select(css('[aria-label="AI provider"]'), "custom");
        await fill(css('[aria-label="AI base URL"]'), options.localUrl);
        await click(button("Test connection"));
        await waitFor(
          "Local AI reports the real model",
          async () =>
            (
              await driver.findElements(
                css(
                  `[aria-label="AI model"] option[value=${JSON.stringify(options.localModel)}]`,
                ),
              )
            ).length === 1,
        );
        await select(css('[aria-label="AI model"]'), options.localModel);
      } else {
        await waitFor(
          "Codex is authenticated and model discovery completes",
          async () => {
            const section = await element(
              css('section[aria-label="Codex CLI"]'),
            );
            return (
              (await section.getText()).includes("Ready") &&
              (await (
                await element(css('[aria-label="Codex model"]'))
              ).isEnabled())
            );
          },
          60000,
        );
        if (options.codexModel)
          await select(css('[aria-label="Codex model"]'), options.codexModel);
        // Keep quality review enabled: the normal draft + review path is covered.
        assert.equal(
          await (
            await driver.findElement(
              css('[aria-label="AI quality review and repairs"]'),
            )
          ).isSelected(),
          true,
        );
      }
      const model = await (
        await element(
          css(
            `[aria-label="${engine === "local" ? "AI model" : "Codex model"}"]`,
          ),
        )
      ).getAttribute("value");
      await screenshot(`live-${engine}-ready`);
      await click(button("Save changes"));
      await absent(css('[aria-label="Close settings"]'));
      const statePath = join(data, `language-state/de/translations/${id}.json`);
      const translations = {};
      const started = performance.now();
      for (const [key, text] of Object.entries(source)) {
        await click(button("All"));
        await openEntry(key);
        await click(button("Translate with AI"));
        const outcome = await waitFor(
          `${engine} real suggestion saved to Review`,
          async () => {
            const errors = await driver.findElements(
              css('.translator-editor-ai-error[role="alert"]'),
            );
            if (errors.length) return { error: await errors[0].getText() };
            if (!(await exists(statePath))) return false;
            if (
              (await json(statePath))[`i18n\0${key}`]?.status !==
              "review-needed"
            )
              return false;
            const value = await (
              await element(css("#translator-editor-translation"))
            ).getAttribute("value");
            return value.trim() ? { saved: true } : false;
          },
          360000,
        );
        assert.ok(
          outcome.saved,
          `${engine} returned an error: ${outcome.error}`,
        );
        const saved = (await json(statePath))[`i18n\0${key}`];
        const value = await (
          await element(css("#translator-editor-translation"))
        ).getAttribute("value");
        assert.ok(
          value.trim() && value !== text,
          "The model must return a nonempty translated suggestion.",
        );
        assert.deepEqual(
          (value.match(/\{\{[^}]+\}\}/g) ?? []).sort(),
          (text.match(/\{\{[^}]+\}\}/g) ?? []).sort(),
          "Live output must preserve exactly the selected source tokens, without importing neighbor tokens.",
        );
        translations[key] = value;
        assert.equal(await exists(join(folder, "i18n/de.json")), false);
        await screenshot(`live-${engine}-${key}-review`);
        await click(css('[aria-label="Close editor"]'));
        assert.equal(
          await (await element(row(key))).getAttribute("data-status"),
          "review-needed",
        );
        assert.ok(saved, "Backend state must contain the real suggestion.");
      }
      await click(button("All"));
      await openEntry("morning");
      await click(button("Approve suggestion"));
      await absent(css("#translator-editor-translation"));
      assert.equal(
        (await json(statePath))["i18n\0morning"].status,
        "translated",
      );
      await click(button("Export …"));
      await click(button("Export current mod"));
      await click(button("Export"));
      const output = join(folder, "i18n/de.json");
      await waitFor("live export", () => exists(output));
      assert.deepEqual(await json(output), translations);
      assert.equal(
        (await json(statePath))["i18n\0task"].status,
        "review-needed",
      );
      await copyFile(output, join(artifacts, `live-${engine}-exported.json`));
      await copyFile(statePath, join(artifacts, `live-${engine}-state.json`));
      evidence.liveAi.push({
        engine,
        model,
        elapsedMs: performance.now() - started,
        items: 2,
        qualityReview: engine === "codex",
        passed: true,
      });
      await h.closeNormally();
      await launch();
      await selectMod(id);
      assert.equal(
        await (await element(row("morning"))).getAttribute("data-status"),
        "translated",
      );
      assert.equal(
        await (await element(row("task"))).getAttribute("data-status"),
        "review-needed",
      );
      await openEntry("task");
      assert.equal(
        await (
          await element(css("#translator-editor-translation"))
        ).getAttribute("value"),
        translations.task,
      );
      await click(css('[aria-label="Close editor"]'));
      assert.deepEqual(await json(join(folder, "i18n/default.json")), source);
      await h.closeNormally();
    });
  }
}
