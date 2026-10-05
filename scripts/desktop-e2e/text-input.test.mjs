import assert from "node:assert/strict";
import test from "node:test";
import { Key } from "selenium-webdriver";
import { replaceText } from "./text-input.mjs";

// Simulate the controlled WebView input that loses a character from bulk text.
function controlledInput(initial = "", loseSingleCharacter = false) {
  let value = initial;
  let pending = false;
  const driver = {
    async wait(check) {
      for (let attempt = 0; attempt < 3; attempt++) if (await check()) return;
      const error = new Error("Input did not reach its expected value.");
      error.name = "TimeoutError";
      throw error;
    },
  };
  return {
    getDriver: () => driver,
    getAttribute: async () => value,
    async sendKeys(...keys) {
      assert.equal(
        pending,
        false,
        "Overlapping keyboard commands lose updates.",
      );
      pending = true;
      await Promise.resolve();
      if (keys[0] === Key.chord(Key.CONTROL, "a")) {
        assert.equal(keys[1], Key.BACK_SPACE);
        value = "";
        keys = keys.slice(2);
      }
      const text = keys.join("");
      value +=
        loseSingleCharacter || [...text].length > 1
          ? [...text].slice(1).join("")
          : text;
      pending = false;
    },
  };
}

const longKey =
  "quest.long.description.with.a.very.long.identifier.to.check.table.truncation.and.editor.layout";

test("replaces a long key without the bulk-input character loss", async () => {
  const input = controlledInput("Previous search");
  await input.sendKeys(Key.chord(Key.CONTROL, "a"), Key.BACK_SPACE, longKey);
  assert.notEqual(await input.getAttribute("value"), longKey);
  await replaceText(input, longKey);
  assert.equal(await input.getAttribute("value"), longKey);
  await replaceText(input, "greeting");
  assert.equal(await input.getAttribute("value"), "greeting");
  await replaceText(input, "");
  assert.equal(await input.getAttribute("value"), "");
});

test("preserves multiline text, punctuation and Unicode code points", async () => {
  const input = controlledInput();
  const value =
    "Grüße, {{PlayerName}}!\n日本語 · e\u0301 · 🌾 $h #$b# %farm, @.";
  await replaceText(input, value);
  assert.equal(await input.getAttribute("value"), value);
});

test("fails with exact readback when individual keyboard events still lose text", async () => {
  const input = controlledInput("", true);
  await assert.rejects(
    replaceText(input, "abc"),
    /WebDriver input mismatch: expected "abc", received ""/,
  );
});
