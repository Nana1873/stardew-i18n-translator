import { validate, worstSeverity } from "./validation";

describe("validate", () => {
  it("flags a missing source token as an error", () => {
    const issues = validate("Hello {{name}}", "Hallo", false);
    expect(issues).toEqual([
      {
        ruleId: "token-missing",
        severity: "error",
        message: "Missing token {{name}}",
      },
    ]);
    expect(worstSeverity(issues)).toBe("error");
  });

  it("flags an extra target token as a warning", () => {
    const issues = validate("Hello", "Hallo {{x}}", false);
    expect(issues.map((i) => i.ruleId)).toEqual(["token-added"]);
    expect(worstSeverity(issues)).toBe("warning");
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
        message: "Missing token @ (player name)",
      },
    ]);
  });

  it("catches a dropped second $b via multiset comparison", () => {
    const issues = validate("a$b b$b c", "a$b b c", false);
    expect(issues.map((i) => i.ruleId)).toEqual(["token-missing"]);
    expect(issues[0].message).toBe("Missing token $b");
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
      "Missing token #$b#",
      "Missing token $s",
    ]);
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
});
