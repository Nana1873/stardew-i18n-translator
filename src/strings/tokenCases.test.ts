/**
 * Drift guard against the Rust extractor: both suites run the same fixture
 * (tests/fixtures/token-cases.json — the Rust side is tokens.rs
 * `shared_fixture_cases_match`). The two implementations are hand-synced
 * ports — a divergence means the editor's live validation and the export
 * skip rule disagree. Add new cases to the fixture, never to one suite only.
 */
import fixture from "../../tests/fixtures/token-cases.json";
import { tokenDifferences, validate } from "./validation";
import { describeTokenIssue } from "./tokenIssueText";
import { extractProtectedTokens } from "./protectedTokens";

describe("shared token fixture (TS ↔ Rust parity)", () => {
  it("stays comprehensive", () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(10);
  });

  for (const testCase of fixture.cases) {
    it(`extracts ${JSON.stringify(testCase.value)}`, () => {
      expect(extractProtectedTokens(testCase.value)).toEqual(testCase.tokens);
    });
  }
});

for (const testCase of fixture.comparisons) {
  it(testCase.name, () => {
    const blocked = validate(testCase.source, testCase.target, true).some(
      (issue) =>
        (issue.ruleId === "token-missing" || issue.ruleId === "token-added") &&
        issue.severity === "error",
    );
    expect(blocked).toBe(testCase.blocked);
  });
}

for (const testCase of fixture.explanations) {
  it(`explains ${JSON.stringify(testCase.target)} like the export does`, () => {
    const messages = describeTokenIssue(
      tokenDifferences(testCase.source, testCase.target),
      testCase.target,
    ).map((item) => item.message);
    expect(messages.join(" ")).toBe(testCase.text);
  });
}
