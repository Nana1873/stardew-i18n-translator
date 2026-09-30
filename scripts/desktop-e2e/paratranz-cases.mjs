import assert from "node:assert/strict";
import {
  mkdir,
  writeFile,
  readFile,
  copyFile,
  readdir,
} from "node:fs/promises";
import { basename, join } from "node:path";
import { By, Key } from "selenium-webdriver";

// Opt-in live acceptance against a disposable English -> Vietnamese project.
// The caller supplies a session token in memory; never include it in evidence.
export async function paraTranzCases(h, { projectId, fileId, token }) {
  const {
    step,
    click,
    css,
    button,
    element,
    fill,
    absent,
    waitFor,
    screenshot,
    mods,
    data,
    artifacts,
    json,
    exists,
    saveEntry,
  } = h;
  const id = `E2E.ParaTranz.${basename(artifacts)}`;
  const root = join(mods, "ParaTranz Smoke", "i18n");
  const state = join(data, "language-state/vi/translations", `${id}.json`);
  const source = {
    greeting: "Hello {{PlayerName}}!$h#$b#Welcome to %farm, @.",
    shopping: "Bring {{Count}} Parsnips to {{PlayerName}}.",
    farewell: "Goodbye {{PlayerName}}!",
  };
  const local = "Bản dịch riêng {{PlayerName}}!$h#$b#%farm, @.";
  const select = async (locator, value) => {
    const control = await element(locator);
    const option = await control.findElement(
      By.css(`option[value="${value}"]`),
    );
    await control.sendKeys(
      Key.HOME,
      await option.getAttribute("textContent"),
      Key.ENTER,
    );
    assert.equal(await control.getAttribute("value"), String(value));
  };
  const settings = async () => {
    await click(css('[aria-label="Settings"]'));
    await click(css('[role="tab"][aria-controls="settings-panel-paratranz"]'));
  };
  const collaboration = async () => {
    await click(css('button[aria-label="ParaTranz collaboration"]'));
    await element(css('[role="dialog"][aria-label="ParaTranz collaboration"]'));
    await select(css('[aria-label="ParaTranz file for i18n"]'), fileId);
  };
  let remoteTargets;
  try {
    await step("paratranz-optional-setup-and-live-connection", async () => {
      await h.launch();
      await mkdir(root, { recursive: true });
      await writeFile(
        join(root, "../manifest.json"),
        JSON.stringify({
          Name: "ParaTranz Smoke",
          UniqueID: id,
          Author: "Synthetic fixture",
          Version: "1.0.0",
          ContentPackFor: { UniqueID: "Pathoschild.ContentPatcher" },
        }),
      );
      await writeFile(join(root, "default.json"), JSON.stringify(source));
      await click(css('[aria-label="Settings"]'));
      await click(css('[role="tab"][aria-controls="settings-panel-folders"]'));
      await select(css('[aria-label="Target language"]'), "vi");
      await click(button("Save changes"));
      await absent(css(".translator-settings-dialog"));
      await click(css('[aria-label="Scan mods"]'));
      await element(css('[aria-label="Latest scan result"]'));
      await click(css('[aria-label="Close scan"]'));
      await click(button("Workspace"));
      await click(css(`[data-tree-id="mod:${id}"]`));
      await fill(css('[aria-label="Search strings"]'), "");
      await click(button("All"));
      await click(css('button[aria-label="ParaTranz collaboration"]'));
      await element(button("Set up ParaTranz"));
      await click(button("Set up ParaTranz"));
      await fill(css('[aria-label="ParaTranz project ID"]'), String(projectId));
      await fill(
        css('[aria-label="ParaTranz API token"]'),
        "invalid-test-token",
      );
      await click(button("Connect ParaTranz"));
      await waitFor("invalid credential error", async () =>
        (
          await (
            await element(css('[role="tabpanel"][aria-label="ParaTranz"]'))
          ).getText()
        ).includes("HTTP"),
      );
      await fill(css('[aria-label="ParaTranz API token"]'), token);
      await click(button("Connect ParaTranz"));
      await waitFor(
        "private live connection",
        async () =>
          (
            await (
              await element(css('[role="tabpanel"][aria-label="ParaTranz"]'))
            ).getText()
          ).includes("Connected:") &&
          (
            await (
              await element(css('[role="tabpanel"][aria-label="ParaTranz"]'))
            ).getText()
          ).includes("Private"),
        60000,
      );
      assert.equal(
        await (
          await element(css('[aria-label="ParaTranz API token"]'))
        ).getAttribute("value"),
        "",
      );
      await screenshot("paratranz-native-settings");
      await click(button("Save changes"));
      await absent(css(".translator-settings-dialog"));
      assert.equal(
        (await json(join(data, "settings.json"))).paratranzProjectId,
        projectId,
      );
      await saveEntry("greeting", local);
    });
    await step("paratranz-live-source-upload-and-pull-preview", async () => {
      await collaboration();
      await click(button("Pull translations"));
      await waitFor(
        "live import preview",
        async () =>
          (
            await (
              await element(css('[aria-label="ParaTranz import preview"]'))
            ).getText()
          ).includes("Ready to import"),
        60000,
      );
      const preview = await (
        await element(css('[aria-label="ParaTranz import preview"]'))
      ).getText();
      assert.ok(preview.includes("Ready for Review: 2"));
      assert.ok(preview.includes("Local translations preserved: 1"));
      assert.equal(await exists(join(root, "vi.json")), false);
      const before = await readFile(state);
      await click(button("Upload English sources…"));
      await click(button("Cancel upload"));
      assert.deepEqual(await readFile(state), before);
      await click(button("Upload English sources…"));
      await click(button("Upload sources"));
      await waitFor(
        "native source upload result",
        async () =>
          (
            await (
              await element(
                css('[role="dialog"][aria-label="ParaTranz collaboration"]'),
              )
            ).getText()
          ).includes("Sources uploaded:"),
        60000,
      );
      assert.deepEqual(await readFile(state), before);
      await click(button("Pull translations"));
      await waitFor(
        "translation preserved after source upload",
        async () =>
          (
            await (
              await element(css('[aria-label="ParaTranz import preview"]'))
            ).getText()
          ).includes("Ready for Review: 2"),
        60000,
      );
      await screenshot("paratranz-native-preview");
    });
    await step("paratranz-rejects-source-change-after-preview", async () => {
      const before = await readFile(state);
      await writeFile(
        join(root, "default.json"),
        JSON.stringify({ ...source, farewell: "New source {{PlayerName}}!" }),
      );
      await click(button("Import into Review"));
      await waitFor("source-change rejection", async () =>
        (
          await (
            await element(
              css('[role="dialog"][aria-label="ParaTranz collaboration"]'),
            )
          ).getText()
        ).includes("English source text changed since this preview"),
      );
      assert.deepEqual(await readFile(state), before);
      assert.equal(await exists(join(root, "vi.json")), false);
      await click(button("Pull translations"));
      await waitFor(
        "remote original mismatch rejection",
        async () =>
          (
            await (
              await element(
                css('[role="dialog"][aria-label="ParaTranz collaboration"]'),
              )
            ).getText()
          ).includes("English sources differ"),
        60000,
      );
      assert.deepEqual(await readFile(state), before);
      await writeFile(join(root, "default.json"), JSON.stringify(source));
    });
    await step("paratranz-native-import-retains-local-and-review", async () => {
      await click(button("Pull translations"));
      await waitFor(
        "refreshed preview",
        async () =>
          (
            await (
              await element(css('[aria-label="ParaTranz import preview"]'))
            ).getText()
          ).includes("Ready to import"),
        60000,
      );
      await click(button("Import into Review"));
      await waitFor("native import result", async () =>
        (
          await (
            await element(
              css('[role="dialog"][aria-label="ParaTranz collaboration"]'),
            )
          ).getText()
        ).includes("Imported 2 into Review"),
      );
      const saved = await json(state);
      assert.equal(saved["i18n\0greeting"].target, local);
      remoteTargets = { greeting: local };
      for (const key of ["shopping", "farewell"]) {
        assert.equal(saved[`i18n\0${key}`].status, "review-needed");
        assert.ok(saved[`i18n\0${key}`].target.includes("{{PlayerName}}"));
        remoteTargets[key] = saved[`i18n\0${key}`].target;
      }
      assert.equal(await exists(join(root, "vi.json")), false);
      await click(button("Close ParaTranz"));
      await screenshot("paratranz-native-review");
    });
    await step("paratranz-native-create-source-file", async () => {
      const before = await readFile(state);
      await click(css('button[aria-label="ParaTranz collaboration"]'));
      await element(css('[aria-label="ParaTranz file for i18n"]'));
      await click(button("Upload English sources…"));
      await click(button("Upload sources"));
      await waitFor(
        "new remote source file",
        async () =>
          (
            await (
              await element(
                css('[role="dialog"][aria-label="ParaTranz collaboration"]'),
              )
            ).getText()
          ).includes("Sources uploaded:"),
        60000,
      );
      const createdId = Number(
        await (
          await element(css('[aria-label="ParaTranz file for i18n"]'))
        ).getAttribute("value"),
      );
      assert.ok(createdId > 0 && createdId !== fileId);
      await click(button("Pull translations"));
      await waitFor(
        "new remote file has no translated values",
        async () =>
          (
            await (
              await element(css('[aria-label="ParaTranz import preview"]'))
            ).getText()
          ).includes("Ready for Review: 0"),
        60000,
      );
      assert.deepEqual(await readFile(state), before);
      assert.equal(await exists(join(root, "vi.json")), false);
      h.evidence.paratranzCreatedFileId = createdId;
      await screenshot("paratranz-native-new-source");
      await click(button("Close ParaTranz"));
    });
    await step("paratranz-native-explicit-export", async () => {
      await click(button("Export …"));
      await click(button("Export current mod"));
      await click(button("Export"));
      await waitFor("Vietnamese export", () => exists(join(root, "vi.json")));
      assert.deepEqual(await json(join(root, "vi.json")), remoteTargets);
      assert.deepEqual(await json(join(root, "default.json")), source);
      await copyFile(
        join(root, "vi.json"),
        join(artifacts, "paratranz-native-exported-vi.json"),
      );
      await copyFile(state, join(artifacts, "paratranz-native-state.json"));
      await h.closeNormally();
    });
    await step("paratranz-restart-retains-work-and-forgets-token", async () => {
      await h.launch();
      await click(button("Workspace"));
      await click(css(`[data-tree-id="mod:${id}"]`));
      await element(h.row("farewell"));
      assert.equal(
        await (await element(h.row("farewell"))).getAttribute("data-status"),
        "review-needed",
      );
      await click(css('button[aria-label="ParaTranz collaboration"]'));
      await element(button("Set up ParaTranz"));
      await screenshot("paratranz-native-restart");
      await click(button("Close ParaTranz"));
      await settings();
      assert.equal(
        await (
          await element(css('[aria-label="ParaTranz project ID"]'))
        ).getAttribute("value"),
        String(projectId),
      );
      assert.equal(
        await (
          await element(css('[aria-label="ParaTranz API token"]'))
        ).getAttribute("value"),
        "",
      );
      await click(button("Cancel"));
      await h.closeNormally();
      const inspect = async (folder) => {
        for (const entry of await readdir(folder, { withFileTypes: true })) {
          const path = join(folder, entry.name);
          if (entry.isDirectory()) {
            if (!/webview|local|roaming/.test(entry.name)) await inspect(path);
          } else if (/\.(json|log|html|txt)$/.test(entry.name))
            assert.equal(
              (await readFile(path, "utf8")).includes(token),
              false,
              "Credential must not appear in portable state or evidence.",
            );
        }
      };
      await inspect(data);
      await inspect(artifacts);
      h.evidence.paratranz = {
        projectId,
        fileId,
        private: true,
        nativeApi: true,
        tokenPersisted: false,
      };
    });
  } finally {
    // Password fields must be empty before the harness captures failure HTML.
    try {
      for (const field of await h
        .driver()
        .findElements(css('input[type="password"]')))
        await field.clear();
    } catch {
      /* Closed session. */
    }
    token = "";
  }
}
