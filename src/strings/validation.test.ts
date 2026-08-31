import { extractProtectedTokens } from "./protectedTokens";
import { validate, worstSeverity } from "./validation";

describe("validate", () => {
  it("flags a missing source token as an error", () => {
    const issues = validate("Hello {{name}}", "Hallo", false);
    expect(issues).toEqual([
      {
        ruleId: "token-missing",
        severity: "error",
        message: "Token count mismatch for {{name}} (expected 1, found 0)",
      },
    ]);
    expect(worstSeverity(issues)).toBe("error");
  });

  it("flags an extra target token as an error", () => {
    const issues = validate("Hello", "Hallo {{x}}", false);
    expect(issues.map((i) => i.ruleId)).toEqual(["token-added"]);
    expect(worstSeverity(issues)).toBe("error");
  });

  it("passes when the token sets match (order-independent)", () => {
    expect(validate("{{a}} and {{b}}", "{{b}} und {{a}}", false)).toEqual([]);
    expect(worstSeverity([])).toBeNull();
  });

  it("allows gender-switch branch prose to be translated", () => {
    const source =
      "Y'know ${@ with you, I stopped wandering.#$b#You've got this warmth.$7^your love makes new paths.#$b#I didn't know love like this.$7^Your love feels like home.}$";
    const target =
      "Weißt du, ${mit dir, @, hörte ich auf umherzuirren.#$b#Du strahlst Wärme aus.$7^deine Liebe schafft neue Wege.#$b#So eine Liebe kannte ich nicht.$7^Deine Liebe fühlt sich wie ein Zuhause an.}$";

    expect(extractProtectedTokens(source)).toEqual([
      "${^^}$",
      "@",
      "#$b#",
      "$7",
      "#$b#",
      "$7",
    ]);
    expect(
      extractProtectedTokens(source).some((token) =>
        token.includes("stopped wandering"),
      ),
    ).toBe(false);
    expect(validate(source, target, false)).toEqual([]);
  });

  it("still blocks a translation that drops gender-switch structure", () => {
    const source = "${Hello @.$7^Welcome @.$7^Goodbye @.}$";
    const target = "Hallo @.$7 Willkommen @.$7 Auf Wiedersehen @.";
    const issues = validate(source, target, false);

    expect(issues.filter((issue) => issue.severity === "error")).toEqual([
      {
        ruleId: "token-missing",
        severity: "error",
        message:
          "Token count mismatch for gender switch (3 branches, ^ separator) (expected 1, found 0)",
      },
    ]);
  });

  it("does not let switch separators cancel out across separate blocks", () => {
    const issues = validate("${a^b}$ ${c^d}$", "${x^y^z}$ ${w}$", false);

    expect(issues.some((issue) => issue.severity === "error")).toBe(true);
    expect(issues.map((issue) => issue.message)).toContain(
      "Token count mismatch for gender switch (2 branches, ^ separator) (expected 2, found 0)",
    );
  });

  it("treats bracketed UI labels and status prose as translatable text", () => {
    expect(validate("[LEFT]", "[LINKS]", true)).toEqual([]);
    expect(validate("[Right]", "[Rechts]", true)).toEqual([]);
    expect(
      validate(
        "[Reached global max Power Grid speed]",
        "[Globale Höchstgeschwindigkeit des Stromnetzes erreicht]",
        true,
      ),
    ).toEqual([]);
  });

  it("keeps documented opaque bracket tokens protected", () => {
    expect(
      validate(
        "Welcome to [FarmName]. Take [128] and [(O)163].",
        "Willkommen auf [FarmName]. Nimm [128] und [(O)163].",
        false,
      ),
    ).toEqual([]);
    expect(
      validate("Welcome to [FarmName].", "Willkommen auf dem Hof.", false).map(
        (issue) => issue.ruleId,
      ),
    ).toEqual(["token-missing"]);
  });

  it("flags an empty but present target as a warning", () => {
    expect(validate("Hi", "", true).map((i) => i.ruleId)).toEqual([
      "empty-target",
    ]);
  });

  it("does not flag an untranslated (absent) target", () => {
    expect(validate("Hi", "", false)).toEqual([]);
  });

  it("flags a lone surrogate as json-invalid", () => {
    const issues = validate("Hi", "bad \ud800 char", false);
    expect(issues.some((i) => i.ruleId === "json-invalid")).toBe(true);
  });

  it("flags a dropped @ player-name token (Stardew dialogue)", () => {
    const issues = validate(
      "Thank you, @. Really!",
      "Thank you, . Really!",
      false,
    );
    expect(issues).toEqual([
      {
        ruleId: "token-missing",
        severity: "error",
        message:
          "Token count mismatch for @ (player name) (expected 1, found 0)",
      },
    ]);
  });

  it("catches a dropped second $b via multiset comparison", () => {
    const issues = validate("a$b b$b c", "a$b b c", false);
    expect(issues.map((i) => i.ruleId)).toEqual(["token-missing"]);
    expect(issues[0].message).toBe(
      "Token count mismatch for $b (expected 2, found 1)",
    );
  });

  it("treats a #$b# dialogue break and $s command as protected tokens", () => {
    expect(
      validate("Hi.$s#$b#Bye?$s", "Hallo.$s#$b#Tschüss?$s", false),
    ).toEqual([]);
    // Distinct missing tokens ($s and #$b#) -> one issue each.
    const broken = validate("Hi.$s#$b#Bye?$s", "Hallo. Tschüss?", false);
    expect(broken.map((i) => i.ruleId)).toEqual([
      "token-missing",
      "token-missing",
    ]);
    expect(broken.map((i) => i.message).sort()).toEqual([
      "Token count mismatch for #$b# (expected 1, found 0)",
      "Token count mismatch for $s (expected 2, found 0)",
    ]);
  });

  it("protects standalone # and repeated ^ markers (quotes are soft)", () => {
    const issues = validate(
      "'Hello' # first^^second",
      "„Hallo“ first^second",
      false,
    );
    // `#` and `^` are runtime syntax -> blocking errors. The `'` -> „" change
    // is punctuation -> a soft quote-mismatch warning, never token-missing.
    const errors = issues
      .filter((issue) => issue.severity === "error")
      .map((issue) => issue.message)
      .sort();
    expect(errors).toEqual([
      "Token count mismatch for # (dialogue/mail separator) (expected 1, found 0)",
      "Token count mismatch for ^ (switch separator / line break) (expected 2, found 1)",
    ]);
    expect(issues.map((issue) => issue.ruleId)).toContain("quote-mismatch");
    expect(
      issues.some(
        (issue) =>
          issue.ruleId === "token-missing" &&
          issue.message.includes("quote delimiter"),
      ),
    ).toBe(false);
  });

  it("a different quote-delimiter count is a warning, never a blocking error", () => {
    // Source uses backticks (no `'`); the translation adds a paired `'…'`.
    const added = validate(
      "Use `Default` to modify the settings.",
      "'Standard' verwenden, um die Einstellungen anzupassen.",
      false,
    );
    expect(added.map((i) => i.ruleId)).toEqual(["quote-mismatch"]);
    expect(worstSeverity(added)).toBe("warning");
    expect(added[0].message).toContain("Quote delimiters differ");
    // A dropped quote pair is the same soft warning (not token-missing).
    const dropped = validate("'test'", "test", false);
    expect(dropped.map((i) => i.ruleId)).toEqual(["quote-mismatch"]);
  });

  it("does not treat apostrophes inside words as protected tokens", () => {
    expect(
      validate(
        "Don't touch the farmer's hat.",
        "Fass den Hut nicht an.",
        false,
      ),
    ).toEqual([]);
  });

  it("a different newline count is a warning, never a blocking error", () => {
    // German rewraps: 3 source line breaks, 2 in the translation — layout only.
    const issues = validate(
      "Note: line one\nline two\nline three\nline four",
      "Hinweis: Zeile eins\nZeile zwei\nZeile drei",
      false,
    );
    expect(issues.map((i) => i.ruleId)).toEqual(["newline-mismatch"]);
    expect(worstSeverity(issues)).toBe("warning");
    // Extra newlines in the target are the same soft warning (not token-added).
    const extra = validate("one line", "eine\nZeile", false);
    expect(extra.map((i) => i.ruleId)).toEqual(["newline-mismatch"]);
  });

  it("matching newline counts produce no issue", () => {
    expect(validate("a\nb", "x\ny", false)).toEqual([]);
  });

  it("always warns when the translation is identical to the source", () => {
    expect(validate("Parsnip", "Parsnip", true)).toContainEqual({
      ruleId: "identical-to-source",
      severity: "warning",
      message: "Translation is identical to the original",
    });
  });

  it("still warns when a bracketed UI label is left untranslated", () => {
    expect(
      validate("[LEFT]", "[LEFT]", true).map((issue) => issue.ruleId),
    ).toEqual(["identical-to-source"]);
  });

  it("warns when literal escape sequences differ", () => {
    const issues = validate(
      String.raw`First\nSecond`,
      String.raw`Erste Zeile\\nZweite Zeile`,
      true,
    );
    expect(issues.map((issue) => issue.ruleId)).toContain("escape-suspicious");
    expect(
      validate(String.raw`First\nSecond`, String.raw`Erste\nZweite`, true).map(
        (issue) => issue.ruleId,
      ),
    ).not.toContain("escape-suspicious");
  });
});
