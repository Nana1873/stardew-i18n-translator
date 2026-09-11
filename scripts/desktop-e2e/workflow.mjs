import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import {
  mkdir,
  copyFile,
  readFile,
  writeFile,
  access,
  cp,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createServer } from "node:net";
import { release } from "node:os";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { Builder, By, Key, until } from "selenium-webdriver";
import { xnbDictionary } from "./fixtures.mjs";
import { releaseCases } from "./release-cases.mjs";
import { advancedCases } from "./advanced-cases.mjs";
import { installCases } from "./install-cases.mjs";

// The supervisor assigns this process to a kill-on-close Windows Job before
// releasing the handshake. Direct invocation must not start an unowned app.
const input = createInterface({ input: process.stdin });
const permission = await Promise.race([
  new Promise((done) => input.once("line", done)),
  delay(10000).then(() => "timeout"),
]);
input.close();
assert.equal(
  permission.replace(/^\uFEFF/, ""), // Windows PowerShell can prepend a UTF-8 BOM.
  "go",
  "Use pnpm test:desktop (the process supervisor).",
);
const repo = resolve(import.meta.dirname, "../..");
const artifacts = process.env.SIT_E2E_RUN_DIR;
assert.ok(
  artifacts?.startsWith(join(repo, "target", "desktop-e2e", "runs") + "\\"),
);
const runtime = join(artifacts, "runtime");
const appDir = join(runtime, "app");
const exe = join(appDir, "stardew-i18n-translator.exe");
let activeExe = exe;
const data = join(appDir, "data");
const game = join(runtime, "game");
// Deliberately differs from game/Mods: the test must actually choose this folder.
const mods = join(runtime, "synthetic Mods");
const i18n = join(mods, "DesktopSmoke", "i18n");
const importFile = join(runtime, "imports", "prepared.llm-result.json");
const exported = join(i18n, "de.json");
const source = {
  greeting: "Hello {{PlayerName}}!$h#$b#Welcome to %farm, @.",
  shopping: "Bring {{Count}} Parsnips to {{PlayerName}}.",
  farewell: "Goodbye {{PlayerName}}!",
  empty: "",
};
const edited = "Hallo {{PlayerName}}!$h#$b#Willkommen auf %farm, @.";
const resumed = "Guten Tag {{PlayerName}}!$h#$b#Willkommen auf %farm, @.";
const imported = {
  greeting: "Import {{PlayerName}}!$h#$b#%farm, @.",
  shopping: "Bringe {{Count}} Pastinaken zu {{PlayerName}}.",
  farewell: "Auf Wiedersehen {{PlayerName}}!",
};
const expectedExport = { ...imported, greeting: edited };
const events = createWriteStream(join(artifacts, "steps.log"));
const options = JSON.parse(process.env.SIT_E2E_OPTIONS || "{}");
let driver;
let driverProcess;
let appPid;
let nativeSequence = 0;
let stage = "preflight";
const evidence = {
  passed: false,
  steps: [],
  startedAt: new Date().toISOString(),
  requested: options,
  host: {
    platform: process.platform,
    architecture: process.arch,
    windowsBuild: release(),
    node: process.version,
  },
};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const initialBatch = {
  format: "stardew-translator-llm-batch",
  version: 2,
  metadata: {
    modUniqueId: "E2E.DesktopSmoke",
    targetLang: "de",
    sourceSnapshot: hash(
      JSON.stringify(
        Object.keys(imported)
          .sort()
          .map((key) => ["i18n", key, source[key]]),
      ),
    ),
  },
  files: { i18n: imported },
};
const json = async (path) =>
  JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
const exists = async (path) =>
  access(path).then(
    () => true,
    () => false,
  );
function log(message) {
  const line = `${new Date().toISOString()} ${message}`;
  console.log(line);
  events.write(line + "\n");
}
async function waitFor(description, check, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let last;
  do {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      last = error;
    }
    await delay(100); // Poll a condition; never assume that elapsed time is success.
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${description}`, { cause: last });
}
async function run(command, args, name, options = {}) {
  const output = createWriteStream(join(artifacts, `${name}.log`));
  const child = spawn(command, args, {
    cwd: repo,
    windowsHide: true,
    ...options,
  });
  let text = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      output.write(chunk);
      text += chunk;
    });
  }
  try {
    await new Promise((done, fail) => {
      const timer = setTimeout(() => {
        child.kill();
        fail(new Error(`${name} timed out`));
      }, options.timeout ?? 600000);
      child.once("error", (error) => {
        clearTimeout(timer);
        fail(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        code === 0
          ? done()
          : fail(new Error(`${name} exited ${code}; see ${name}.log`));
      });
    });
    return text.trim();
  } finally {
    output.end();
  }
}
async function native(action, title, path) {
  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    join(repo, "scripts/desktop-e2e/native.ps1"),
    "-AppProcessId",
    String(appPid),
    "-Executable",
    activeExe,
    "-Action",
    action,
  ];
  if (title) args.push("-Title", title);
  if (path) args.push("-Path", path);
  return run(
    "powershell.exe",
    args,
    `${String(++nativeSequence).padStart(2, "0")}-${stage}-native-${action}`,
    { timeout: 45000 },
  );
}
async function archive(action, zip, extra = []) {
  return JSON.parse(
    await run(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(repo, "scripts/desktop-e2e/archive.ps1"),
        "-Action",
        action,
        "-Zip",
        zip,
        ...extra,
      ],
      `${stage}-archive`,
    ),
  );
}
const css = (selector) => By.css(selector);
const button = (name) =>
  By.xpath(
    `//button[normalize-space(.)=${JSON.stringify(name)} or normalize-space(text())=${JSON.stringify(name)}]`,
  );
const browseFolder = (label) =>
  By.xpath(
    `//section[@aria-label=${JSON.stringify(label)}]//button[normalize-space(.)="Browse..."]`,
  );
async function element(locator) {
  return driver.wait(
    async () => {
      try {
        for (const found of await driver.findElements(locator)) {
          if (await found.isDisplayed()) return found;
        }
      } catch (error) {
        if (error.name !== "StaleElementReferenceError") throw error;
      }
      return false;
    },
    30000,
    `Visible element: ${locator}`,
  );
}
async function click(locator) {
  await driver.wait(
    async () => {
      try {
        const found = await element(locator);
        if (!(await found.isEnabled())) return false;
        await found.click();
        return true;
      } catch (error) {
        // A replaced node has not received the click. Re-find it by its selector.
        if (error.name !== "StaleElementReferenceError") throw error;
        return false;
      }
    },
    30000,
    `Enabled control: ${locator}`,
  );
}
async function fill(locator, value) {
  const found = await element(locator);
  await found.sendKeys(Key.chord(Key.CONTROL, "a"), Key.BACK_SPACE, value);
  await waitFor(
    "input value",
    async () => (await found.getAttribute("value")) === value,
  );
}
async function absent(locator) {
  await waitFor(
    "element gone",
    async () => (await driver.findElements(locator)).length === 0,
  );
}
const row = (key) =>
  By.xpath(`//*[@role="row"][.//input[@aria-label="Select ${key}"]]`);
async function openEntry(key) {
  const found = await element(row(key));
  await found.click();
  await found.sendKeys(Key.ENTER);
  await element(css("#translator-editor-translation"));
}
async function saveEntry(key, value) {
  await openEntry(key);
  await fill(css("#translator-editor-translation"), value);
  await click(button("Save"));
  await absent(css("#translator-editor-translation"));
  await waitFor(`${key} saved in table`, async () =>
    (await (await element(row(key))).getText()).includes(value),
  );
}
async function screenshot(name) {
  await writeFile(
    join(artifacts, `${name}.png`),
    await driver.takeScreenshot(),
    "base64",
  );
}
async function step(name, action) {
  stage = name;
  log(`START ${name}`);
  await action();
  evidence.steps.push(name);
  log(`PASS ${name}`);
}
async function freePort() {
  const server = createServer();
  await new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", done);
  });
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}
let endpoint;
async function launch(renderScale, application = exe) {
  assert.ok(resolve(application).startsWith(runtime + "\\"));
  activeExe = application;
  driver = await new Builder()
    .usingServer(endpoint)
    .withCapabilities({
      browserName: "wry",
      "tauri:options": {
        application,
        webviewOptions: {
          userDataFolder: join(runtime, "webview"),
          ...(renderScale
            ? {
                additionalBrowserArguments: [
                  `force-device-scale-factor=${renderScale}`,
                ],
              }
            : {}),
        },
      },
    })
    .build();
  await driver
    .manage()
    .setTimeouts({ implicit: 0, pageLoad: 30000, script: 10000 });
  const capabilities = await driver.getCapabilities();
  assert.equal(capabilities.get("browserName"), "webview2");
  appPid = capabilities.get("goog:processID");
  assert.ok(Number.isInteger(appPid));
  const display = JSON.parse(await native("metrics"));
  evidence.displays ??= [];
  evidence.displays.push({ ...display, renderScale: renderScale ?? null });
  if (options.expectedDpi)
    assert.equal(
      display.dpi,
      options.expectedDpi,
      "Native Windows DPI does not match the requested configuration.",
    );
  evidence.appPids ??= [];
  evidence.appPids.push(appPid);
  evidence.launches ??= [];
  evidence.launches.push({
    pid: appPid,
    application,
    sha256: hash(await readFile(application)),
  });
  evidence.webviewVersion = capabilities.get("browserVersion");
  assert.equal(
    evidence.webviewVersion,
    evidence.tools.version,
    "The app must use the selected WebView2 runtime.",
  );
  evidence.profileCreated = await exists(join(runtime, "webview"));
  assert.equal(
    evidence.profileCreated,
    true,
    "WebView2 must create its isolated profile.",
  );
  await writeFile(
    join(artifacts, "processes.json"),
    JSON.stringify(
      { driverPid: driverProcess.pid, appPids: evidence.appPids },
      null,
      2,
    ),
  );
}
async function closeNormally() {
  await native("close");
  await driver.quit();
  driver = undefined;
}
try {
  assert.equal(process.platform, "win32", "Desktop E2E requires Windows x64.");
  if (process.env.SIT_E2E_FAILURE_PROBE === "upgrade-exit")
    assert.ok(options.install, "The upgrade-exit probe requires -Install.");
  assert.ok(
    !options.upgradeFromZip || options.install,
    "-UpgradeFromZip requires -Install.",
  );
  const tools = await json(
    join(repo, "target/desktop-e2e/tools/installed.json"),
  );
  evidence.tools = tools;
  assert.ok(
    await exists(tools.edgeDriver),
    "Run pnpm test:desktop:setup first.",
  );
  const driverVersion = await run(
    tools.edgeDriver,
    ["--version"],
    "driver-version",
  );
  assert.ok(
    driverVersion.includes(tools.version),
    "Edge driver version changed; rerun test:desktop:setup.",
  );
  assert.ok(
    await exists(join(tools.runtime, "msedgewebview2.exe")),
    "WebView2 updated; rerun test:desktop:setup.",
  );
  await step("archive-isolation-guards", async () => {
    await run(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(repo, "scripts/desktop-e2e/archive-tests.ps1"),
        "-Runtime",
        runtime,
      ],
      "archive-guards",
    );
  });
  await step("prepare-release-zip", async () => {
    const version = (await json(join(repo, "package.json"))).version;
    let zip = process.env.SIT_E2E_RELEASE_ZIP;
    evidence.buildMode = zip
      ? "supplied-release-zip"
      : "fresh-build-and-package";
    if (!zip) {
      await run(
        process.execPath,
        [
          join(repo, "node_modules/@tauri-apps/cli/tauri.js"),
          "build",
          "--no-bundle",
          "--",
          "--locked",
        ],
        "build",
      );
      await run(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          join(repo, "scripts/package-portable.ps1"),
        ],
        "package",
      );
      zip = join(
        repo,
        `src-tauri/target/release/portable/Stardew-i18n-Translator_${version}_windows-x64-portable.zip`,
      );
    }
    assert.equal(
      basename(zip),
      `Stardew-i18n-Translator_${version}_windows-x64-portable.zip`,
      "Use the documented release archive name and matching checkout version.",
    );
    // Test a stable copy of the supplied archive. Never extract neighboring data.
    const inputZip = join(runtime, "release-input.zip");
    await copyFile(zip, inputZip);
    evidence.releaseZip = { path: zip, sha256: hash(await readFile(inputZip)) };
    assert.equal(
      evidence.releaseZip.sha256,
      hash(await readFile(zip)),
      "Release ZIP changed while copying.",
    );
    evidence.package = await archive("release", inputZip, [
      "-Destination",
      appDir,
      "-ExpectedVersion",
      version,
    ]);
    evidence.executableSha256 = hash(await readFile(exe));
    assert.ok((await readFile(join(appDir, "README.txt"), "utf8")).trim());
    if (!process.env.SIT_E2E_RELEASE_ZIP) {
      assert.equal(
        evidence.executableSha256,
        hash(
          await readFile(
            join(repo, "src-tauri/target/release/stardew-i18n-translator.exe"),
          ),
        ),
      );
    }
  });
  await step("isolate-and-start", async () => {
    for (const folder of [
      join(game, "Content"),
      i18n,
      join(runtime, "imports"),
      join(runtime, "temp"),
      join(runtime, "roaming"),
      join(runtime, "local"),
    ])
      await mkdir(folder, { recursive: true });
    await writeFile(
      join(mods, "DesktopSmoke/manifest.json"),
      JSON.stringify({
        Name: "Desktop Smoke",
        Author: "Test Fixture",
        Version: "1.0.0",
        Description: "Synthetic desktop test only",
        UniqueID: "E2E.DesktopSmoke",
        ContentPackFor: { UniqueID: "Pathoschild.ContentPatcher" },
      }),
    );
    await writeFile(
      join(i18n, "default.json"),
      JSON.stringify(source, null, 2),
    );
    await writeFile(importFile, JSON.stringify(initialBatch, null, 2));
    assert.equal(await exists(join(data, "settings.json")), false);
    const port = await freePort();
    let nativePort = await freePort();
    while (nativePort === port) nativePort = await freePort();
    endpoint = `http://127.0.0.1:${port}`;
    const env = { ...process.env };
    for (const key of Object.keys(env))
      if (/^(WEBVIEW2_|TAURI_|NEXUS_API_KEY$)/i.test(key)) delete env[key];
    Object.assign(env, {
      WEBVIEW2_BROWSER_EXECUTABLE_FOLDER: tools.runtime,
      WEBVIEW2_USER_DATA_FOLDER: join(runtime, "webview"),
      TEMP: join(runtime, "temp"),
      TMP: join(runtime, "temp"),
      APPDATA: join(runtime, "roaming"),
      LOCALAPPDATA: join(runtime, "local"),
    });
    const driverLog = createWriteStream(join(artifacts, "webdriver.log"));
    driverProcess = spawn(
      tools.tauriDriver,
      [
        "--port",
        String(port),
        "--native-port",
        String(nativePort),
        "--native-driver",
        tools.edgeDriver,
      ],
      { env, cwd: runtime, windowsHide: true },
    );
    driverProcess.stdout.pipe(driverLog, { end: false });
    driverProcess.stderr.pipe(driverLog, { end: false });
    driverProcess.once("close", () => driverLog.end());
    driverProcess.once("error", (error) =>
      log(`Driver launch failed: ${error.message}`),
    );
    await waitFor("WebDriver ready", async () => {
      assert.equal(driverProcess.exitCode, null);
      const response = await fetch(`${endpoint}/status`, {
        signal: AbortSignal.timeout(1000),
      });
      return response.ok && (await response.json()).value.ready;
    });
    await launch();
    await element(browseFolder("Stardew Valley folder"));
    await screenshot("first-run");
    if (process.env.SIT_E2E_FAILURE_PROBE === "exit") process.exit(23);
    assert.notEqual(
      process.env.SIT_E2E_FAILURE_PROBE,
      "assertion",
      "Intentional failure to verify diagnostics and cleanup.",
    );
  });
  await step("native-setup-and-scan", async () => {
    await click(browseFolder("Stardew Valley folder"));
    await native("cancel", "Select your Stardew Valley folder");
    assert.equal(await (await element(button("Next"))).isEnabled(), false);
    await click(browseFolder("Stardew Valley folder"));
    await native("pick", "Select your Stardew Valley folder", game);
    await click(button("Next"));
    await click(browseFolder("Mods folder"));
    await native("pick", "Select your Mods folder", mods);
    await click(button("Next"));
    await (
      await element(css('[aria-label="Target language"]'))
    ).sendKeys("German", Key.ENTER);
    assert.equal(
      await (
        await element(css('[aria-label="Target language"]'))
      ).getAttribute("value"),
      "de",
    );
    await click(button("Next"));
    await click(button("Finish"));
    await absent(css('[aria-label="Setup"]'));
    await click(css('[aria-label="Scan mods"]'));
    await waitFor("native scan snapshot", () =>
      exists(join(data, "scan-source-snapshot.json")),
    );
    await element(css('[aria-label="Latest scan result"]'));
    await click(css('[aria-label="Close scan"]'));
    await absent(css('[role="dialog"][aria-label="Scan"]'));
    const settings = await json(join(data, "settings.json"));
    assert.equal(settings.stardewPath, game);
    assert.equal(settings.modsPath, mods);
    assert.equal(settings.targetLang, "de");
    await click(button("Workspace"));
    await click(css('[role="treeitem"][data-tree-id="mod:E2E.DesktopSmoke"]'));
    await element(row("greeting"));
    assert.equal(
      (await driver.findElements(css("[data-string-row]"))).length,
      4,
    );
    assert.equal(await exists(exported), false);
    await screenshot("scanned");
  });
  const statePath = join(
    data,
    "language-state/de/translations/E2E.DesktopSmoke.json",
  );
  await step("edit-and-save", async () => {
    await saveEntry("greeting", edited);
    const state = await json(statePath);
    assert.deepEqual(state["i18n\0greeting"], {
      target: edited,
      status: "translated",
      sourceHash: hash(source.greeting),
    });
    assert.equal(
      await exists(exported),
      false,
      "Save must not export into Mods.",
    );
    await screenshot("saved");
  });
  await step("native-json-import", async () => {
    await chooseBatch(importFile);
    await click(button("Import file"));
    await absent(css('[aria-label="LLM import preflight"]'));
    await waitFor("imported shopping row", async () =>
      (await (await element(row("shopping"))).getText()).includes(
        imported.shopping,
      ),
    );
    assert.ok(
      (await (await element(row("greeting"))).getText()).includes(edited),
      "Import must preserve the saved personal edit.",
    );
    assert.equal(
      await exists(exported),
      false,
      "Import must not write to installed locale files.",
    );
    const state = await json(statePath);
    assert.equal(state["i18n\0greeting"].target, edited);
    for (const key of ["shopping", "farewell"]) {
      assert.equal(state[`i18n\0${key}`].target, imported[key]);
      assert.equal(state[`i18n\0${key}`].status, "review-needed");
      await openEntry(key);
      await click(button("Approve suggestion"));
      await absent(css("#translator-editor-translation"));
      assert.equal(
        (await json(statePath))[`i18n\0${key}`].status,
        "translated",
      );
      assert.equal(
        await (await element(row(key))).getAttribute("data-status"),
        "translated",
      );
    }
    await screenshot("imported");
  });
  await step("export-and-verify-files", async () => {
    await click(button("Export …"));
    await click(button("Export current mod"));
    await click(button("Export"));
    await waitFor("export file", () => exists(exported));
    assert.deepEqual(await json(exported), expectedExport);
    assert.deepEqual(await json(join(i18n, "default.json")), source);
    assert.deepEqual(await json(importFile), initialBatch);
    for (const token of ["{{PlayerName}}", "$h", "#$b#", "%farm", "@"])
      assert.ok((await json(exported)).greeting.includes(token));
    assert.ok((await json(exported)).shopping.includes("{{Count}}"));
    await copyFile(exported, join(artifacts, "exported-de.json"));
    await screenshot("exported");
  });
  await step("save-after-export-and-close", async () => {
    // Prove restored work comes from portable state, not the exported locale.
    await saveEntry("greeting", resumed);
    await fill(css('[aria-label="Search strings"]'), "greeting");
    await click(button("Done"));
    await waitFor("saved workspace preferences", async () => {
      const workspace = (await json(join(data, "settings.json"))).workspace;
      return (
        workspace.stringSearch === "greeting" &&
        workspace.statusFilter === "translated"
      );
    });
    await openEntry("greeting");
    await fill(css("#translator-editor-translation"), "UNSAVED DRAFT");
    await screenshot("before-close");
    assert.equal((await json(exported)).greeting, edited);
    await closeNormally();
    assert.equal((await json(statePath))["i18n\0greeting"].target, resumed);
    await cp(data, join(artifacts, "data-before-restart"), { recursive: true });
  });
  await step("restart-and-resume", async () => {
    await launch();
    await element(button("Workspace"));
    assert.equal(
      await (await element(button("Overview"))).getAttribute("aria-pressed"),
      "true",
    );
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
      "restored search",
      async () =>
        (await (
          await element(css('[aria-label="Search strings"]'))
        ).getAttribute("value")) === "greeting",
    );
    assert.equal(
      await (await element(button("Done"))).getAttribute("aria-pressed"),
      "true",
    );
    assert.equal(
      await (
        await element(css('input[aria-label="Select greeting"]'))
      ).isSelected(),
      false,
      "Row selection is session-only.",
    );
    assert.equal(
      await (
        await element(css('[data-tree-id="mod:E2E.DesktopSmoke"]'))
      ).getAttribute("aria-current"),
      "true",
    );
    assert.equal(
      (await json(join(data, "settings.json"))).workspace.selectedModId,
      "E2E.DesktopSmoke",
    );
    await openEntry("greeting");
    assert.equal(
      await (
        await element(css("#translator-editor-translation"))
      ).getAttribute("value"),
      resumed,
    );
    await screenshot("resumed");
    await click(button("Save"));
    await fill(css('[aria-label="Search strings"]'), "");
    for (const key of ["shopping", "farewell"])
      assert.ok(
        (await (await element(row(key))).getText()).includes(imported[key]),
      );
    assert.deepEqual(
      await json(exported),
      expectedExport,
      "Restart must not export implicitly.",
    );
    assert.deepEqual(await json(join(i18n, "default.json")), source);
  });
  await step("protected-token-warning-and-repair", async () => {
    const before = await readFile(statePath);
    await openEntry("greeting");
    await fill(
      css("#translator-editor-translation"),
      "Missing protected tokens",
    );
    await click(button("Save"));
    await element(
      By.xpath('//*[@role="dialog"][.//*[text()="Protected token mismatch"]]'),
    );
    assert.deepEqual(
      await readFile(statePath),
      before,
      "An unconfirmed token warning must not persist the draft.",
    );
    assert.deepEqual(await json(exported), expectedExport);
    await screenshot("token-warning");
    await click(css('[aria-label="Return to editor"]'));
    await fill(css("#translator-editor-translation"), resumed);
    await click(button("Save"));
    await absent(css("#translator-editor-translation"));
    assert.equal((await json(statePath))["i18n\0greeting"].target, resumed);
  });
  await step("export-cancel-overwrite-and-backup", async () => {
    const before = await readFile(exported);
    const backup = `${exported}.bak`;
    assert.equal(await exists(backup), false);
    await click(button("Export …"));
    await click(button("Export current mod"));
    await element(button("Export and replace"));
    await click(button("Cancel"));
    await absent(button("Export and replace"));
    assert.deepEqual(await readFile(exported), before);
    assert.equal(
      await exists(backup),
      false,
      "Cancel must not create a backup.",
    );
    await click(button("Export …"));
    await click(button("Export current mod"));
    await click(button("Export and replace"));
    await waitFor(
      "replacement exported",
      async () => (await json(exported)).greeting === resumed,
    );
    assert.deepEqual(await json(exported), {
      ...expectedExport,
      greeting: resumed,
    });
    assert.deepEqual(
      await readFile(backup),
      before,
      "Backup must preserve the exact previous bytes.",
    );
    await copyFile(exported, join(artifacts, "replaced-de.json"));
    await copyFile(backup, join(artifacts, "previous-de.json.bak"));
    await screenshot("export-replaced");
  });
  await step("translation-zip-save-cancel-and-content", async () => {
    const destination = join(runtime, "translation-release.zip");
    const diskBefore = await readFile(exported);
    const backupBefore = await readFile(`${exported}.bak`);
    await click(button("Export …"));
    await click(button("Build translation ZIP · current mod"));
    await element(css('[aria-label="Build translation ZIP"]'));
    await click(button("Choose save location …"));
    await native("cancel", "Save translation ZIP", destination);
    await driver.wait(
      until.elementIsEnabled(await element(button("Choose save location …"))),
      30000,
    );
    assert.equal(await exists(destination), false);
    await click(button("Choose save location …"));
    await native("save", "Save translation ZIP", destination);
    await waitFor("translation ZIP created", () => exists(destination));
    await absent(css('[aria-label="Build translation ZIP"]'));
    const files = await archive("read", destination);
    // A translation package must contain only the locale, never the manifest,
    // default strings, glossary, portable state, or the previous-export backup.
    assert.deepEqual(Object.keys(files), ["DesktopSmoke/i18n/de.json"]);
    assert.deepEqual(JSON.parse(files["DesktopSmoke/i18n/de.json"]), {
      ...expectedExport,
      greeting: resumed,
    });
    assert.deepEqual(
      await readFile(exported),
      diskBefore,
      "ZIP creation must not rewrite the installed locale.",
    );
    assert.deepEqual(await readFile(`${exported}.bak`), backupBefore);
    await copyFile(destination, join(artifacts, "translation-release.zip"));
    await screenshot("translation-zip");
  });
  const batchFile = join(runtime, "selection.llm-batch.json");
  const returnedBatch = join(runtime, "imports/returned.llm-result.json");
  const batchTranslation = "Bis bald {{PlayerName}}!";
  await step("llm-batch-native-export", async () => {
    await click(button("All"));
    // Clear through the editor so this becomes a genuinely Open row.
    await saveEntry("farewell", "");
    await waitFor(
      "farewell is Open",
      async () =>
        (await (await element(row("farewell"))).getAttribute("data-status")) ===
        "untranslated",
    );
    if (
      (await driver.findElements(css('[aria-label="Clear selected strings"]')))
        .length
    )
      await click(css('[aria-label="Clear selected strings"]'));
    for (const key of ["farewell", "greeting"])
      await click(css(`input[aria-label="Select ${key}"]`));
    await click(css('button[data-has-selection="true"]'));
    await click(
      By.xpath(
        '//button[.//span[normalize-space(.)="Export selection as LLM batch"]]',
      ),
    );
    await element(css('[aria-label="Save LLM batch"]'));
    await click(button("Change …"));
    await native("save", "Export LLM translation batch", batchFile);
    assert.equal(
      await exists(batchFile),
      false,
      "Choosing a destination must not write a batch yet.",
    );
    await click(button("Save JSON batch"));
    await waitFor("batch exported", () => exists(batchFile));
    await absent(css('[aria-label="Save LLM batch"]'));
    const batch = await json(batchFile);
    assert.equal(batch.format, "stardew-translator-llm-batch");
    assert.equal(batch.version, 2);
    assert.equal(batch.metadata.modUniqueId, "E2E.DesktopSmoke");
    assert.equal(batch.metadata.targetLang, "de");
    assert.equal(
      batch.metadata.sourceSnapshot,
      hash(JSON.stringify([["i18n", "farewell", source.farewell]])),
    );
    assert.deepEqual(
      batch.files,
      { i18n: { farewell: source.farewell } },
      "Done selection must be excluded.",
    );
    assert.deepEqual(await json(exported), {
      ...expectedExport,
      greeting: resumed,
    });
    await copyFile(batchFile, join(artifacts, "selection.llm-batch.json"));
    batch.files.i18n.farewell = batchTranslation;
    await writeFile(returnedBatch, JSON.stringify(batch));
    await screenshot("llm-batch-exported");
  });
  async function chooseBatch(file) {
    await click(css('[aria-label="Import LLM batch"]'));
    await click(button("Choose file …"));
    await native("pick", "Choose LLM translation result", file);
    await element(css('[aria-label="LLM import preflight"]'));
  }
  await step("llm-batch-preflight-rejections", async () => {
    const before = await readFile(statePath);
    for (const fault of ["wrong-language", "stale-source", "missing-token"]) {
      const invalid = await json(returnedBatch);
      if (fault === "wrong-language") invalid.metadata.targetLang = "fr";
      if (fault === "stale-source")
        invalid.metadata.sourceSnapshot = "0".repeat(64);
      if (fault === "missing-token")
        invalid.files.i18n.farewell = "Missing player token";
      const file = join(runtime, `imports/${fault}.llm-result.json`);
      await writeFile(file, JSON.stringify(invalid));
      await chooseBatch(file);
      await waitFor(`${fault} import blocked`, async () =>
        (
          await (
            await element(css('[aria-label="LLM import preflight"]'))
          ).getText()
        ).includes("Import blocked"),
      );
      assert.equal(
        await (await element(button("Import file"))).isEnabled(),
        false,
      );
      assert.deepEqual(
        await readFile(statePath),
        before,
        "Preflight rejection must make no state writes.",
      );
      await screenshot(`llm-${fault}-blocked`);
      await click(css('[aria-label="Cancel import"]'));
      await absent(css('[aria-label="LLM import preflight"]'));
    }
  });
  await step("llm-batch-review-and-approval", async () => {
    await chooseBatch(returnedBatch);
    await click(button("Import file"));
    await absent(css('[aria-label="LLM import preflight"]'));
    await waitFor(
      "imported batch in Review",
      async () =>
        (await (await element(row("farewell"))).getAttribute("data-status")) ===
        "review-needed",
    );
    assert.equal(
      (await json(statePath))["i18n\0farewell"].target,
      batchTranslation,
    );
    assert.equal(
      (await json(statePath))["i18n\0farewell"].status,
      "review-needed",
    );
    assert.equal((await json(statePath))["i18n\0greeting"].target, resumed);
    assert.deepEqual(
      await json(exported),
      { ...expectedExport, greeting: resumed },
      "Batch import must not export implicitly.",
    );
    await copyFile(statePath, join(artifacts, "batch-review-state.json"));
    await openEntry("farewell");
    await screenshot("llm-review");
    await click(button("Approve suggestion"));
    await absent(css("#translator-editor-translation"));
    await waitFor(
      "approved suggestion is Done",
      async () =>
        (await (await element(row("farewell"))).getAttribute("data-status")) ===
        "translated",
    );
    assert.equal(
      (await json(statePath))["i18n\0farewell"].status,
      "translated",
    );
    await copyFile(statePath, join(artifacts, "batch-approved-state.json"));
  });
  await step("build-synthetic-xnb-glossary", async () => {
    const strings = join(game, "Content/Strings");
    await mkdir(strings, { recursive: true });
    // Match a complete word already present in the synthetic source row.
    const english = xnbDictionary({ 24: "Parsnips", 25: "Unchanged" });
    const german = xnbDictionary({ 24: "Pastinaken", 25: "Unchanged" });
    await writeFile(join(strings, "Objects.xnb"), english);
    await writeFile(join(strings, "Objects.de-DE.xnb"), german);
    const cache = join(data, "glossary/glossary-de.json");
    assert.equal(await exists(cache), false);
    await click(css('[aria-label="Settings"]'));
    await click(css('[role="tab"][aria-controls="settings-panel-glossary"]'));
    await click(button("Build glossary"));
    await waitFor("glossary cache built", () => exists(cache));
    await element(button("Rebuild glossary"));
    const glossary = await json(cache);
    assert.equal(glossary.source, "official");
    assert.equal(glossary.targetLang, "de");
    assert.equal(
      glossary.termCount,
      1,
      "Unchanged English terms must be filtered.",
    );
    assert.equal(glossary.entries[0].source, "Parsnips");
    assert.equal(glossary.entries[0].target, "Pastinaken");
    assert.equal(glossary.entries[0].kind, "item");
    await screenshot("glossary-built");
    await click(button("Save changes"));
    await absent(css('[aria-label="Close settings"]'));
    await openEntry("shopping");
    await waitFor("glossary hint in editor", async () => {
      const hints = await driver.findElements(css(".translator-glossary-term"));
      return (
        hints.length === 1 && (await hints[0].getText()).includes("Pastinaken")
      );
    });
    await screenshot("glossary-hint");
    await click(css('[aria-label="Close editor"]'));
    assert.deepEqual(await readFile(join(strings, "Objects.xnb")), english);
    assert.deepEqual(
      await readFile(join(strings, "Objects.de-DE.xnb")),
      german,
    );
    await copyFile(cache, join(artifacts, "glossary-de.json"));
    await closeNormally();
    await launch();
    await click(button("Workspace"));
    await openEntry("shopping");
    await waitFor("glossary hint restored after restart", async () => {
      const hints = await driver.findElements(css(".translator-glossary-term"));
      return (
        hints.length === 1 && (await hints[0].getText()).includes("Pastinaken")
      );
    });
    await click(css('[aria-label="Close editor"]'));
    await closeNormally();
  });
  const helpers = {
    driver: () => driver,
    launch,
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
    game,
    repo,
    expectedExport,
    resumed,
    batchTranslation,
    chooseBatch,
    evidence,
    options,
    run,
    browseFolder,
    exe,
  };
  if (options.releaseCases) await releaseCases(helpers);
  if (
    options.layout ||
    options.stress ||
    (options.liveAi !== "none" && options.liveAi)
  )
    await advancedCases(helpers);
  if (options.install) await installCases(helpers);
  assert.deepEqual(await json(join(i18n, "default.json")), source);
  assert.equal(
    hash(await readFile(evidence.releaseZip.path)),
    evidence.releaseZip.sha256,
    "Original release ZIP must remain unchanged.",
  );
  evidence.passed = true;
} catch (error) {
  evidence.failure = { stage, message: error.message, stack: error.stack };
  log(`FAIL ${stage}: ${error.stack}`);
  if (driver) {
    for (const [name, action] of [
      ["screenshot", () => screenshot("failure")],
      [
        "page",
        async () =>
          writeFile(
            join(artifacts, "failure.html"),
            await driver.getPageSource(),
          ),
      ],
      ["native", () => native("inspect")],
    ]) {
      try {
        await Promise.race([
          action(),
          delay(5000).then(() => {
            throw new Error("diagnostic timed out");
          }),
        ]);
      } catch (diagnostic) {
        log(`Could not capture ${name}: ${diagnostic.message}`);
      }
    }
  }
  process.exitCode = 1;
} finally {
  if (driver) {
    try {
      await Promise.race([driver.quit(), delay(5000)]);
    } catch (error) {
      log(`WebDriver session cleanup: ${error.message}`);
    }
  }
  driverProcess?.kill(); // tauri-driver itself also owns a kill-on-close Job.
  if (await exists(join(data, "logs")))
    await cp(join(data, "logs"), join(artifacts, "app-logs"), {
      recursive: true,
    }).catch((error) => log(error.message));
  evidence.finishedAt = new Date().toISOString();
  await writeFile(
    join(artifacts, "result.json"),
    JSON.stringify(evidence, null, 2),
  );
  log(
    evidence.passed ? "Desktop workflow passed." : "Desktop workflow failed.",
  );
  await new Promise((done) => events.end(done));
  // WebDriver transports may retain handles after a failed command. The
  // supervisor now reaps the entire owned job, including any remaining helper.
  process.exit(process.exitCode ?? 0);
}
