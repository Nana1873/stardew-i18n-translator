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

  it("protects quote delimiters, standalone #, and repeated ^ markers", () => {
    const issues = validate(
      "'Hello' # first^^second",
      "„Hallo“ first^second",
      false,
    );
    expect(issues.map((issue) => issue.message).sort()).toEqual([
      "Token count mismatch for # (dialogue/mail separator) (expected 1, found 0)",
      "Token count mismatch for ' (quote delimiter) (expected 2, found 0)",
      "Token count mismatch for ^ (line break) (expected 2, found 1)",
    ]);
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
