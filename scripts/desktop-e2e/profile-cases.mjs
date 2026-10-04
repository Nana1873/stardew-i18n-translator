import assert from "node:assert/strict";
import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { By } from "selenium-webdriver";

export async function profileCases(h) {
  await h.step("second-instance-cannot-own-the-profile", async () => {
    await h.launch();
    await h.element(h.css('[aria-label="Settings"]'));
    const registration = join(h.data, "chatgpt-registration.json");
    const before = await readFile(registration);
    const capabilities = await h.driver().getCapabilities();
    const result = JSON.parse(
      await h.run(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          join(h.repo, "scripts/desktop-e2e/profile-owner.ps1"),
          "-Executable",
          h.exe,
          "-OwnerProcessId",
          String(capabilities.get("goog:processID")),
        ],
        "profile-owner-probe",
      ),
    );
    assert.equal(result.passed, true);
    assert.deepEqual(await readFile(registration), before);
    await h.closeNormally();
  });

  await h.step("sign-out-warnings-remain-visible", async () => {
    const warnings = [
      "Signed out locally. Remote revocation was not confirmed; disconnect this app in ChatGPT settings.",
      "Signed out in memory, but the saved session could not be removed. Close the app and remove data/chatgpt-session.bin before restarting.",
    ];
    await h.launch();
    for (const [index, warning] of warnings.entries()) {
      // Exercise the real built UI's failure handling with controlled IPC
      // replies. No account is signed in or disconnected by this test.
      const intercepted = await h.driver().executeScript((message) => {
        const original = window.fetch;
        let signedOut = false;
        const reply = (value, outcome = "ok") =>
          Promise.resolve(
            new Response(JSON.stringify(value), {
              headers: {
                "Content-Type": "application/json",
                "Tauri-Response": outcome,
              },
            }),
          );
        const fetch = (url, ...args) => {
          const endpoint = new URL(url);
          if (endpoint.hostname !== "ipc.localhost")
            return original(url, ...args);
          const command = decodeURIComponent(endpoint.pathname.slice(1));
          if (command === "cloud_ai_status")
            return reply({ installed: true, authenticated: !signedOut });
          if (command === "cloud_ai_models") return reply([]);
          if (command === "chatgpt_sign_out") {
            signedOut = true;
            return reply(message, "error");
          }
          return original(url, ...args);
        };
        window.fetch = fetch;
        window.restoreProfileTestFetch = () => {
          window.fetch = original;
          delete window.restoreProfileTestFetch;
        };
        return window.fetch === fetch;
      }, warning);
      assert.equal(
        intercepted,
        true,
        "The test IPC reply interceptor must be installed.",
      );
      try {
        await h.click(h.css('[aria-label="Settings"]'));
        await h.click(h.button("Translation engines"));
        await h.click(
          By.xpath(
            "//button[contains(@class,'translator-engine-card')][.//strong[normalize-space(.)='ChatGPT']]",
          ),
        );
        await h.click(h.button("Sign out"));
        await h.element(h.button("Sign in with ChatGPT"));
        await h.waitFor("persistent sign-out warning", async () => {
          const warningElement = await h.element(
            By.xpath(
              `//*[self::p or self::span][text()=${JSON.stringify(warning)}]`,
            ),
          );
          return warningElement.isDisplayed();
        });
        await h.screenshot(`sign-out-warning-${index + 1}`);
        await h.click(h.css('[aria-label="Close settings"]'));
      } finally {
        await h.driver().executeScript(() => window.restoreProfileTestFetch());
      }
    }
    await h.closeNormally();
  });

  await h.step("corrupt-settings-show-error-and-recover-on-retry", async () => {
    const settingsPath = join(h.data, "settings.json");
    const backupPath = `${settingsPath}.bak`;
    const settings = await readFile(settingsPath);
    const backup = (await h.exists(backupPath))
      ? await readFile(backupPath)
      : null;
    const restore = async () => {
      await writeFile(settingsPath, settings);
      if (backup) await writeFile(backupPath, backup);
      else await rm(backupPath, { force: true });
    };
    await writeFile(settingsPath, "invalid synthetic settings");
    await writeFile(backupPath, "invalid synthetic backup");
    try {
      await h.launch();
      const error = await h.element(h.css(".translator-startup-error"));
      assert.match(await error.getText(), /Settings file .*corrupted/);
      await h.absent(h.css('[aria-label="Setup"]'));
      assert.equal(
        await readFile(settingsPath, "utf8"),
        "invalid synthetic settings",
      );
      assert.equal(
        await (await h.element(h.css('[aria-label="Settings"]'))).isEnabled(),
        false,
      );
      await h.screenshot("corrupt-settings");
      await restore();
      await h.click(h.button("Retry loading settings"));
      await h.absent(h.css(".translator-startup-error"));
      await h.waitFor("recovered settings controls", async () =>
        (await h.element(h.css('[aria-label="Settings"]'))).isEnabled(),
      );
      await h.closeNormally();
    } finally {
      await restore();
    }
  });
}
