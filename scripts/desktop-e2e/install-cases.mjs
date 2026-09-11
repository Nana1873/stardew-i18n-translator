import assert from "node:assert/strict";
import {
  copyFile,
  cp,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { Key } from "selenium-webdriver";

export async function installCases(h) {
  const {
    runtime,
    artifacts,
    repo,
    evidence,
    options,
    step,
    archive,
    json,
    hash,
    exists,
    waitFor,
    element,
    click,
    css,
    button,
    row,
    fill,
    absent,
    screenshot,
    openEntry,
    saveEntry,
    chooseBatch,
    native,
    browseFolder,
    closeNormally,
  } = h;
  const baseline = await json(
    join(repo, "scripts/desktop-e2e/upgrade-baseline.json"),
  );
  // Both app roots satisfy the archive helper's generated runtime/app boundary.
  const oldApp = join(runtime, "previous version/runtime/app");
  const newApp = join(runtime, "updated version/runtime/app");
  const oldData = join(oldApp, "data");
  const newData = join(newApp, "data");
  const oldExe = join(oldApp, "stardew-i18n-translator.exe");
  const newExe = join(newApp, "stardew-i18n-translator.exe");
  const mods = join(runtime, "upgrade Mods");
  const locale = join(mods, "Upgrade Smoke/i18n");
  const sourcePath = join(locale, "default.json");
  const targetPath = join(locale, "de.json");
  const source = {
    manual: "Hello {{PlayerName}}!",
    review: "Bring {{Count}} Parsnips.",
    changed: "Old source @.",
    blank: "",
  };
  const manual = "Hallo {{PlayerName}}!";
  const changed = "Gepruefter Text @.";
  const imported = "Bringe {{Count}} Pastinaken.";
  const stateFile = "language-state/de/translations/E2E.UpgradeSmoke.json";
  let driver;
  const launch = async (application) => {
    await h.launch(undefined, application);
    driver = h.driver();
  };
  async function inventory(root) {
    const files = {};
    async function walk(directory, relative = "") {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        assert.equal(
          entry.isSymbolicLink(),
          false,
          "Synthetic installation must not contain links.",
        );
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(join(directory, entry.name), name);
        else files[name] = hash(await readFile(join(directory, entry.name)));
      }
    }
    await walk(root);
    return files;
  }
  const rescan = async () => {
    await click(css('[aria-label="Scan mods"]'));
    await element(css('[aria-label="Latest scan result"]'));
    await click(css('[aria-label="Close scan"]'));
    await absent(css('[role="dialog"][aria-label="Scan"]'));
  };
  let savedState, savedSettings, oldFiles, backupFiles;
  evidence.installation = { passed: false, cleanWindows: false, baseline };
  await step("install-native-startup-and-runtime-guidance", async () => {
    const startupApp = join(runtime, "startup/runtime/app");
    await archive("release", join(runtime, "release-input.zip"), [
      "-Destination",
      startupApp,
      "-ExpectedVersion",
      evidence.package.productVersion,
    ]);
    const application = join(startupApp, "stardew-i18n-translator.exe");
    assert.equal(hash(await readFile(application)), evidence.executableSha256);
    evidence.installation.startup = [];
    for (const mode of ["missing-runtime", "normal"]) {
      assert.equal(
        await exists(join(startupApp, "data")),
        false,
        "The native startup probe must begin without portable data.",
      );
      const result = JSON.parse(
        await h.run(
          "powershell.exe",
          [
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            join(repo, "scripts/desktop-e2e/startup.ps1"),
            "-Executable",
            application,
            "-Mode",
            mode,
          ],
          `startup-${mode}`,
          { timeout: 60000 },
        ),
      );
      assert.equal(result.passed, true);
      evidence.installation.startup.push(result);
    }
  });
  await step("install-prepare-pinned-previous-release", async () => {
    assert.notEqual(
      baseline.version,
      evidence.package.productVersion,
      "An upgrade requires different release versions.",
    );
    const previousZip = join(runtime, "previous-release.zip");
    if (options.upgradeFromZip)
      await copyFile(resolve(options.upgradeFromZip), previousZip);
    else {
      const response = await fetch(baseline.url, {
        signal: AbortSignal.timeout(60000),
      });
      assert.equal(
        response.ok,
        true,
        `Previous release download failed: ${response.status}`,
      );
      await writeFile(previousZip, Buffer.from(await response.arrayBuffer()));
    }
    assert.equal(
      hash(await readFile(previousZip)),
      baseline.sha256,
      "Previous release ZIP does not match the pinned baseline.",
    );
    evidence.installation.previousPackage = await archive(
      "release",
      previousZip,
      ["-Destination", oldApp, "-ExpectedVersion", baseline.version],
    );
    evidence.installation.previousExeSha256 = hash(await readFile(oldExe));
    await mkdir(locale, { recursive: true });
    await writeFile(
      join(mods, "Upgrade Smoke/manifest.json"),
      JSON.stringify({
        Name: "Upgrade Smoke",
        UniqueID: "E2E.UpgradeSmoke",
        Author: "Synthetic test",
        Version: "1.0.0",
        Description: "Disposable upgrade fixture",
        ContentPackFor: { UniqueID: "Pathoschild.ContentPatcher" },
      }),
    );
    await writeFile(sourcePath, JSON.stringify(source));
    await writeFile(targetPath, JSON.stringify({ changed: "Alter Text @." }));
  });
  await step("install-old-version-create-real-work", async () => {
    assert.equal(await exists(join(oldData, "settings.json")), false);
    await launch(oldExe);
    await click(browseFolder("Stardew Valley folder"));
    await native("pick", "Select your Stardew Valley folder", h.game);
    await click(button("Next"));
    await click(browseFolder("Mods folder"));
    await native("pick", "Select your Mods folder", mods);
    await click(button("Next"));
    await (
      await element(css('[aria-label="Target language"]'))
    ).sendKeys("German", Key.ENTER);
    await click(button("Next"));
    await click(button("Finish"));
    await absent(css('[aria-label="Setup"]'));
    await rescan();
    await click(button("Workspace"));
    await click(css('[data-tree-id="mod:E2E.UpgradeSmoke"]'));
    await saveEntry("manual", manual);
    await saveEntry("changed", changed);
    const batchFile = join(runtime, "upgrade.llm-result.json");
    await writeFile(
      batchFile,
      JSON.stringify({
        format: "stardew-translator-llm-batch",
        version: 2,
        metadata: {
          modUniqueId: "E2E.UpgradeSmoke",
          targetLang: "de",
          sourceSnapshot: hash(
            JSON.stringify(
              Object.keys(source)
                .filter((key) => source[key])
                .sort()
                .map((key) => ["i18n", key, source[key]]),
            ),
          ),
        },
        files: {
          i18n: {
            manual: "Do not replace {{PlayerName}}!",
            review: imported,
            changed: "Alter Text @.",
          },
        },
      }),
    );
    await chooseBatch(batchFile);
    await click(button("Import file"));
    await absent(css('[aria-label="LLM import preflight"]'));
    await waitFor(
      "old version persisted real import",
      async () =>
        (await json(join(oldData, stateFile)))["i18n\0review"]?.status ===
        "review-needed",
    );
    await closeNormally();
    source.changed = "Changed source @.";
    await writeFile(sourcePath, JSON.stringify(source));
    await launch(oldExe);
    await click(button("Workspace"));
    await click(css('[data-tree-id="mod:E2E.UpgradeSmoke"]'));
    await click(button("All"));
    await waitFor(
      "old version marks changed source",
      async () =>
        (await (await element(row("changed"))).getAttribute("data-status")) ===
        "outdated",
    );
    assert.equal(
      await (await element(row("blank"))).getAttribute("data-status"),
      "untranslated",
    );
    await click(button("Review"));
    await fill(css('[aria-label="Search strings"]'), "review");
    await waitFor(
      "old workspace preferences saved",
      async () =>
        (await json(join(oldData, "settings.json"))).workspace.stringSearch ===
        "review",
    );
    await openEntry("review");
    await fill(css("#translator-editor-translation"), "UNSAVED UPGRADE DRAFT");
    await screenshot("install-old-version-work");
    await closeNormally();
    savedState = await json(join(oldData, stateFile));
    savedSettings = await json(join(oldData, "settings.json"));
    assert.equal(savedState["i18n\0manual"].target, manual);
    assert.equal(savedState["i18n\0review"].target, imported);
    assert.equal(savedState["i18n\0review"].status, "review-needed");
    assert.equal(savedState["i18n\0changed"].sourceHash, hash("Old source @."));
    assert.equal(savedState["i18n\0blank"], undefined);
    await cp(oldData, join(artifacts, "upgrade-before"), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
  });
  await step("install-backup-and-transfer-portable-data", async () => {
    // Follow docs/troubleshooting.md: close, back up, extract separately, copy data.
    const backup = join(runtime, "upgrade-backup");
    oldFiles = await inventory(oldApp);
    await cp(oldApp, backup, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    backupFiles = await inventory(backup);
    assert.deepEqual(
      backupFiles,
      oldFiles,
      "The complete old installation must be backed up byte-for-byte.",
    );
    const inputZip = join(runtime, "release-input.zip");
    assert.equal(hash(await readFile(inputZip)), evidence.releaseZip.sha256);
    await archive("release", inputZip, [
      "-Destination",
      newApp,
      "-ExpectedVersion",
      evidence.package.productVersion,
    ]);
    assert.equal(await exists(newData), false);
    assert.equal(hash(await readFile(newExe)), evidence.executableSha256);
    await cp(oldData, newData, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    const dataFiles = await inventory(oldData);
    assert.deepEqual(
      await inventory(newData),
      dataFiles,
      "Every portable data file must be transferred before first launch.",
    );
    evidence.installation.transferredFiles = Object.keys(dataFiles);
    await writeFile(
      join(artifacts, "upgrade-transfer.json"),
      JSON.stringify({ oldFiles, backupFiles, dataFiles }, null, 2),
    );
  });
  await step("install-updated-version-resumes-work", async () => {
    await launch(newExe);
    await element(button("Workspace"));
    assert.equal(
      (await driver.findElements(css('[aria-label="Setup"]'))).length,
      0,
    );
    assert.equal(
      (await driver.findElements(css("#translator-editor-translation"))).length,
      0,
    );
    await click(button("Workspace"));
    await waitFor(
      "upgraded search preference restored",
      async () =>
        (await (
          await element(css('[aria-label="Search strings"]'))
        ).getAttribute("value")) === "review",
    );
    assert.equal(
      await (await element(button("Review"))).getAttribute("aria-pressed"),
      "true",
    );
    const settings = await json(join(newData, "settings.json"));
    for (const key of ["stardewPath", "modsPath", "targetLang"])
      assert.equal(settings[key], savedSettings[key]);
    assert.equal(settings.workspace.selectedModId, "E2E.UpgradeSmoke");
    await openEntry("review");
    assert.equal(
      await (
        await element(css("#translator-editor-translation"))
      ).getAttribute("value"),
      imported,
    );
    await click(css('[aria-label="Close editor"]'));
    await click(button("All"));
    await fill(css('[aria-label="Search strings"]'), "");
    for (const [key, status] of [
      ["manual", "translated"],
      ["review", "review-needed"],
      ["changed", "outdated"],
      ["blank", "translated"],
    ])
      assert.equal(
        await (await element(row(key))).getAttribute("data-status"),
        status,
      );
    assert.deepEqual(await json(join(newData, stateFile)), savedState);
    assert.deepEqual(
      await json(targetPath),
      { changed: "Alter Text @." },
      "Upgrade must not export saved work implicitly.",
    );
    await screenshot("install-updated-version-restored");
    if (process.env.SIT_E2E_FAILURE_PROBE === "upgrade-exit") process.exit(23);
  });
  await step("install-updated-edit-export-and-restart", async () => {
    const edited = "Nach dem Update: Hallo {{PlayerName}}!";
    await saveEntry("manual", edited);
    await click(button("Export …"));
    await click(button("Export current mod"));
    await click(button("Export and replace"));
    await waitFor(
      "upgraded version exported",
      async () => (await json(targetPath)).manual === edited,
    );
    const expected = {
      manual: edited,
      review: imported,
      changed,
    };
    assert.deepEqual(await json(targetPath), expected);
    assert.deepEqual(await json(`${targetPath}.bak`), {
      changed: "Alter Text @.",
    });
    assert.equal(
      (await json(join(newData, stateFile)))["i18n\0review"].status,
      "review-needed",
    );
    await closeNormally();
    await launch(newExe);
    await click(button("Workspace"));
    await openEntry("manual");
    assert.equal(
      await (
        await element(css("#translator-editor-translation"))
      ).getAttribute("value"),
      edited,
    );
    await screenshot("install-updated-restart");
    await click(css('[aria-label="Close editor"]'));
    assert.equal(
      await (await element(row("review"))).getAttribute("data-status"),
      "review-needed",
    );
    assert.equal(
      await (await element(row("changed"))).getAttribute("data-status"),
      "outdated",
    );
    await closeNormally();
    assert.deepEqual(
      await inventory(oldApp),
      oldFiles,
      "The old installation must remain unchanged.",
    );
    assert.deepEqual(
      await inventory(join(runtime, "upgrade-backup")),
      backupFiles,
    );
    assert.deepEqual(await json(sourcePath), source);
    assert.deepEqual(await json(targetPath), expected);
    await cp(newData, join(artifacts, "upgrade-after"), { recursive: true });
    await copyFile(targetPath, join(artifacts, "upgrade-export-de.json"));
    evidence.installation.passed = true;
    await writeFile(
      join(artifacts, "installation.json"),
      JSON.stringify(evidence.installation, null, 2),
    );
  });
}
