import { Key } from "selenium-webdriver";

/** Replace text through keyboard events, allowing controlled inputs to settle. */
export async function replaceText(input, value) {
  const driver = input.getDriver();
  await input.sendKeys(Key.chord(Key.CONTROL, "a"), Key.BACK_SPACE);
  await driver.wait(
    async () => (await input.getAttribute("value")) === "",
    5000,
    "WebDriver input did not clear before typing.",
  );
  // A bulk sendKeys(value) can outrun React's controlled updates in WebView2.
  // Await each Unicode code point; never set the DOM value or retry lost text.
  for (const character of value) await input.sendKeys(character);
  let actual;
  try {
    await driver.wait(async () => {
      actual = await input.getAttribute("value");
      return actual === value;
    }, 5000);
  } catch (error) {
    if (error.name !== "TimeoutError") throw error;
    throw new Error(
      `WebDriver input mismatch: expected ${JSON.stringify(value)}, received ${JSON.stringify(actual)}.`,
      { cause: error },
    );
  }
}
