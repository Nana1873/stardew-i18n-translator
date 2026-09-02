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

  it("allows a well-formed gender switch added for the target language", () => {
    const source = "Dear @.";
    const target = "${Lieber^Liebe}$ @.";

    expect(extractProtectedTokens(target)).toEqual(["${^}$", "@"]);
    expect(validate(source, target, false)).toEqual([]);
  });

  it("does not let an added switch mask a changed source switch shape", () => {
    const issues = validate("${a^b}$", "${x^y^z}$ ${neu^neu}$", false);

    expect(issues.map((issue) => issue.ruleId)).toEqual(["token-added"]);
    expect(issues[0].message).toContain("gender switch (3 branches");
  });

  it("still blocks a malformed target-only gender switch", () => {
    const issues = validate("Dear @.", "${Lieber}$ @.", false);

    expect(issues.every((issue) => issue.severity === "error")).toBe(true);
    expect(issues.map((issue) => issue.ruleId)).toEqual([
      "token-added",
      "token-added",
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

  it("does not absorb prose after a dollar-terminated dialogue marker", () => {
    const source = "First.$0#$b$Second line.$3#$e#Last.$0";
    const target = "Erste.$0#$b$Zweite Zeile.$3#$e#Letzte.$0";

    expect(extractProtectedTokens(source)).toEqual([
      "$0",
      "#$b$",
      "$3",
      "#$e#",
      "$0",
    ]);
    expect(validate(source, target, false)).toEqual([]);
  });

  it("protects standalone # and repeated ^ markers (quotes are ignored)", () => {
    const issues = validate(
      "'Hello' # first^^second",
      "„Hallo“ first^second",
      false,
    );
    // `#` and `^` are runtime syntax -> blocking errors. The `'` -> „" change
    // is ordinary localized punctuation and produces no issue.
    const errors = issues
      .filter((issue) => issue.severity === "error")
      .map((issue) => issue.message)
      .sort();
    expect(errors).toEqual([
      "Token count mismatch for # (dialogue/mail separator) (expected 1, found 0)",
      "Token count mismatch for ^ (switch separator / line break) (expected 2, found 1)",
    ]);
    expect(issues.every((issue) => issue.severity === "error")).toBe(true);
    expect(
      issues.some(
        (issue) =>
          issue.ruleId === "token-missing" &&
          issue.message.includes("quote delimiter"),
      ),
    ).toBe(false);
  });

  it("ignores quote punctuation differences", () => {
    expect(
      validate(
        "Use `Default` to modify the settings.",
        "'Standard' verwenden, um die Einstellungen anzupassen.",
        false,
      ),
    ).toEqual([]);
    expect(validate("'test'", "test", false)).toEqual([]);
    expect(worstSeverity([])).toBeNull();
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

  it("accepts an intentionally unchanged translation", () => {
    expect(validate("Parsnip", "Parsnip", true)).toEqual([]);
  });

  it("accepts an intentionally unchanged bracketed UI label", () => {
    expect(validate("[LEFT]", "[LEFT]", true)).toEqual([]);
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
