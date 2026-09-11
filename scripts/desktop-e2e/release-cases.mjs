import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, copyFile, cp } from "node:fs/promises";
import { join } from "node:path";
export async function releaseCases(h) {
  const {
    closeNormally,
    native,
    step,
    waitFor,
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
    json,
    exists,
    hash,
    archive,
    runtime,
    artifacts,
    data,
    mods,
    expectedExport,
    resumed,
    batchTranslation,
    chooseBatch,
  } = h;
  let driver;
  const launch = async () => {
    await h.launch();
    driver = h.driver();
  };
  // Release behavior through the actual UI, native pickers and shipped EXE.
  await launch();
  await click(button("Workspace"));
  const flatRoot = join(mods, "Release Flat/i18n");
  const splitRoot = join(mods, "Release Split/i18n");
  const flatSource = {
    local: "Local {{PlayerName}}.",
    keep: "Stay @.",
    blank: "",
  };
  const flatTarget = {
    local: "Vorhanden {{PlayerName}}.",
    keep: "Bleib @.",
    obsolete: "Old unused text",
  };
  const splitSource = {
    "split.dialogue":
      '#$action Spiderbuttons.BETAS_DialogueBox Haley "Remember: bring your tools."#',
    "split.lookup":
      'Goodbye!#$action Spiderbuttons.BETAS_DialogueBox Haley "Characters/Dialogue/Haley:Resort_Leaving"#See you!',
    "split.review": "Review {{PlayerName}}.",
  };
  const splitTarget = {
    "split.dialogue":
      '#$action Spiderbuttons.BETAS_DialogueBox Haley "Denk daran: bring deine Werkzeuge mit."#',
    "split.lookup":
      'Tschuess!#$action Spiderbuttons.BETAS_DialogueBox Haley "Characters/Dialogue/Haley:Resort_Leaving"#Bis bald!',
    "split.review": "Pruefe {{PlayerName}}.",
  };
  const splitStatePath = join(
    data,
    "language-state/de/translations/E2E.ReleaseSplit.json",
  );
  const flatStatePath = join(
    data,
    "language-state/de/translations/E2E.ReleaseFlat.json",
  );
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
  const diskInventory = async () => {
    const { readdir } = await import("node:fs/promises");
    const files = {};
    async function walk(dir, relative = "") {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(join(dir, entry.name), name);
        else files[name] = hash(await readFile(join(dir, entry.name)));
      }
    }
    await walk(mods);
    return files;
  };
  await step("release-multi-mod-scan-and-blank-pairs", async () => {
    await mkdir(flatRoot, { recursive: true });
    await mkdir(join(splitRoot, "default"), { recursive: true });
    for (const [folder, id] of [
      ["Release Flat", "E2E.ReleaseFlat"],
      ["Release Split", "E2E.ReleaseSplit"],
    ]) {
      await writeFile(
        join(mods, folder, "manifest.json"),
        JSON.stringify({
          Name: folder,
          UniqueID: id,
          Author: "Synthetic release acceptance",
          Version: "1.0.0",
          Description: "Synthetic fixture only",
          ContentPackFor: { UniqueID: "Pathoschild.ContentPatcher" },
        }),
      );
    }
    await writeFile(join(flatRoot, "default.json"), JSON.stringify(flatSource));
    await writeFile(join(flatRoot, "de.json"), JSON.stringify(flatTarget));
    await writeFile(
      join(splitRoot, "default/Dialogue.json"),
      JSON.stringify(splitSource),
    );
    await writeFile(
      join(splitRoot, "default/pt.json"),
      JSON.stringify({ "literal.pt": "First document" }),
    );
    await writeFile(
      join(splitRoot, "default/pt-BR.json"),
      JSON.stringify({ "literal.brazil": "Second document" }),
    );
    await rescan();
    await selectMod("E2E.ReleaseFlat");
    await element(row("local"));
    assert.equal(
      await (await element(row("blank"))).getAttribute("data-status"),
      "translated",
    );
    await waitFor("existing targets gain a source baseline", () =>
      exists(flatStatePath),
    );
    assert.equal(
      (await json(flatStatePath))["i18n\0blank"],
      undefined,
      "Blank pairs must not persist a fake approval.",
    );
    assert.equal((await driver.findElements(row("obsolete"))).length, 0);
    assert.equal(
      (
        await driver.findElements(
          css('[role="treeitem"][data-tree-id^="mod:"]'),
        )
      ).length,
      3,
    );
    await screenshot("release-three-mods-blank-done");
  });
  await step("release-split-edit-dialogue-validation-and-review", async () => {
    await selectMod("E2E.ReleaseSplit");
    await element(row("split.dialogue"));
    assert.equal(await exists(join(splitRoot, "de")), false);
    await saveEntry("split.dialogue", splitTarget["split.dialogue"]);
    await openEntry("split.lookup");
    await fill(
      css("#translator-editor-translation"),
      splitTarget["split.lookup"].replace(
        "Resort_Leaving",
        "Resort_Verlassend",
      ),
    );
    await click(button("Save"));
    await element(css("#translator-save-anyway-title"));
    assert.equal(
      (await json(splitStatePath))["i18n/@split/Dialogue.json\0split.lookup"],
      undefined,
    );
    await screenshot("release-lookup-key-blocked");
    await click(css('[aria-label="Return to editor"]'));
    await fill(
      css("#translator-editor-translation"),
      splitTarget["split.lookup"],
    );
    await click(button("Save"));
    await absent(css("#translator-editor-translation"));
    await saveEntry("literal.pt", "Erstes Dokument");
    await saveEntry("literal.brazil", "Zweites Dokument");
    const reviewFile = join(runtime, "imports/split-review.llm-result.json");
    await writeFile(
      reviewFile,
      JSON.stringify({
        format: "stardew-translator-llm-batch",
        version: 2,
        metadata: {
          modUniqueId: "E2E.ReleaseSplit",
          targetLang: "de",
          sourceSnapshot: hash(
            JSON.stringify([
              [
                "i18n/@split/Dialogue.json",
                "split.review",
                splitSource["split.review"],
              ],
            ]),
          ),
        },
        files: {
          "i18n/@split/Dialogue.json": {
            "split.review": splitTarget["split.review"],
          },
        },
      }),
    );
    await chooseBatch(reviewFile);
    await click(button("Import file"));
    await absent(css('[aria-label="LLM import preflight"]'));
    await waitFor(
      "split import enters Review",
      async () =>
        (await (
          await element(row("split.review"))
        ).getAttribute("data-status")) === "review-needed",
    );
    assert.equal(
      await exists(join(splitRoot, "de")),
      false,
      "All edits and imports remain in portable state until export.",
    );
    await screenshot("release-split-review");
  });
  await step("release-split-export-and-literal-filename-removal", async () => {
    await click(button("Export …"));
    await click(button("Export current mod"));
    await screenshot("release-split-export-preview");
    await click(button("Export"));
    await waitFor("new split language directory exported", () =>
      exists(join(splitRoot, "de/pt-BR.json")),
    );
    assert.deepEqual(
      await json(join(splitRoot, "de/Dialogue.json")),
      splitTarget,
    );
    assert.deepEqual(await json(join(splitRoot, "de/pt.json")), {
      "literal.pt": "Erstes Dokument",
    });
    assert.deepEqual(await json(join(splitRoot, "de/pt-BR.json")), {
      "literal.brazil": "Zweites Dokument",
    });
    assert.equal(
      (await json(splitStatePath))["i18n/@split/Dialogue.json\0split.review"]
        .status,
      "review-needed",
      "Export must not approve Review.",
    );
    const secondBefore = await readFile(join(splitRoot, "de/pt-BR.json"));
    const firstBefore = await readFile(join(splitRoot, "de/pt.json"));
    await saveEntry("literal.pt", "");
    await click(button("Export …"));
    await click(button("Export current mod"));
    await click(button("Export and replace"));
    await waitFor(
      "cleared literal pt document removed",
      async () => !(await exists(join(splitRoot, "de/pt.json"))),
    );
    assert.deepEqual(
      await readFile(join(splitRoot, "de/pt.json.bak")),
      firstBefore,
    );
    assert.deepEqual(
      await readFile(join(splitRoot, "de/pt-BR.json")),
      secondBefore,
      "Removing pt.json must preserve its literal pt-BR.json sibling.",
    );
    await saveEntry("literal.pt", "Erstes Dokument, neu gespeichert");
    assert.equal(
      await exists(join(splitRoot, "de/pt.json")),
      false,
      "Pending edit is still not exported.",
    );
    await screenshot("release-literal-files-preserved");
  });
  await step("release-source-change-reopens-blank", async () => {
    flatSource.local = "Local changed {{PlayerName}}.";
    flatSource.blank = "New source {{PlayerName}}.";
    await writeFile(join(flatRoot, "default.json"), JSON.stringify(flatSource));
    await rescan();
    await selectMod("E2E.ReleaseFlat");
    await waitFor(
      "blank pair reopened",
      async () =>
        (await (await element(row("blank"))).getAttribute("data-status")) ===
        "untranslated",
    );
    assert.equal(
      await (await element(row("local"))).getAttribute("data-status"),
      "outdated",
    );
    assert.equal((await json(flatStatePath))["i18n\0blank"], undefined);
    await screenshot("release-blank-open-local-changed");
    await saveEntry("blank", "Neuer Text {{PlayerName}}.");
  });
  await step(
    "release-combined-output-preserves-paths-and-statuses",
    async () => {
      const before = await diskInventory();
      const stateBefore = await readFile(splitStatePath);
      await click(button("Export …"));
      await click(button("Build Stardew Translator Output"));
      const preview = css(
        '[role="dialog"][aria-label="Build Stardew Translator Output"]',
      );
      await element(preview);
      await waitFor("combined preview includes pending work", async () => {
        const text = await (await element(preview)).getText();
        return (
          text.includes("Release Flat/i18n/de.json") &&
          text.includes("Release Split/i18n/de/pt.json") &&
          text.includes("changed") &&
          text.includes("to review")
        );
      });
      await screenshot("release-combined-preview");
      const destination = join(runtime, "combined-v2.1.zip");
      await click(button("Choose save location …"));
      await native("save", "Save translation ZIP", destination);
      await waitFor("combined ZIP written", () => exists(destination));
      await absent(preview);
      const files = await archive("read", destination);
      assert.deepEqual(
        Object.keys(files).sort(),
        [
          "DesktopSmoke/i18n/de.json",
          "Release Flat/i18n/de.json",
          "Release Split/i18n/de/Dialogue.json",
          "Release Split/i18n/de/pt-BR.json",
          "Release Split/i18n/de/pt.json",
        ].sort(),
      );
      assert.deepEqual(JSON.parse(files["DesktopSmoke/i18n/de.json"]), {
        ...expectedExport,
        greeting: resumed,
        farewell: batchTranslation,
      });
      assert.deepEqual(JSON.parse(files["Release Flat/i18n/de.json"]), {
        local: flatTarget.local,
        keep: flatTarget.keep,
        blank: "Neuer Text {{PlayerName}}.",
      });
      assert.deepEqual(
        JSON.parse(files["Release Split/i18n/de/Dialogue.json"]),
        splitTarget,
      );
      assert.deepEqual(JSON.parse(files["Release Split/i18n/de/pt.json"]), {
        "literal.pt": "Erstes Dokument, neu gespeichert",
      });
      assert.deepEqual(JSON.parse(files["Release Split/i18n/de/pt-BR.json"]), {
        "literal.brazil": "Zweites Dokument",
      });
      assert.deepEqual(
        await diskInventory(),
        before,
        "Combined ZIP must not rewrite installed targets, source files or backups.",
      );
      assert.deepEqual(
        await readFile(splitStatePath),
        stateBefore,
        "Combined ZIP must not approve or mutate saved states.",
      );
      assert.ok(
        (await driver.findElement(css("body")).getText()).includes(
          "combined-v2.1.zip",
        ),
        "The result must name the actual destination.",
      );
      await copyFile(destination, join(artifacts, "combined-v2.1.zip"));
      await writeFile(
        join(artifacts, "combined-members.json"),
        JSON.stringify(files, null, 2),
      );
      await cp(
        join(mods, "Release Split"),
        join(artifacts, "split-fixture-after-export"),
        { recursive: true },
      );
      await screenshot("release-combined-result");
    },
  );
  await step("release-visual-evidence-and-restart", async () => {
    await selectMod("E2E.ReleaseSplit");
    await driver.manage().window().setRect({ width: 1100, height: 760 });
    await openEntry("split.dialogue");
    await screenshot("release-editor-1100x760");
    await click(css('[aria-label="Close editor"]'));
    await driver.manage().window().setRect({ width: 1440, height: 900 });
    await screenshot("release-workspace-1440x900");
    await closeNormally();
    await launch();
    await click(button("Workspace"));
    await selectMod("E2E.ReleaseSplit");
    await openEntry("literal.pt");
    assert.equal(
      await (
        await element(css("#translator-editor-translation"))
      ).getAttribute("value"),
      "Erstes Dokument, neu gespeichert",
    );
    await click(css('[aria-label="Close editor"]'));
    assert.equal(
      await (await element(row("split.review"))).getAttribute("data-status"),
      "review-needed",
    );
    await selectMod("E2E.ReleaseFlat");
    assert.equal(
      await (await element(row("local"))).getAttribute("data-status"),
      "outdated",
    );
    assert.equal(
      await (await element(row("blank"))).getAttribute("data-status"),
      "translated",
    );
    assert.deepEqual(await json(join(flatRoot, "default.json")), flatSource);
    assert.deepEqual(
      await json(join(splitRoot, "default/Dialogue.json")),
      splitSource,
    );
    await screenshot("release-resumed");
    await closeNormally();
  });
}
