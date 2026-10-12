import { describeTokenIssue } from "./tokenIssueText";

describe("describeTokenIssue", () => {
  it("reports an unclosed gender switch as one structural error", () => {
    expect(
      describeTokenIssue(
        [
          { token: "${", sourceCount: 0, targetCount: 1, severity: "error" },
          {
            token: "${^}$",
            sourceCount: 1,
            targetCount: 0,
            severity: "warning",
          },
          { token: "^", sourceCount: 0, targetCount: 1, severity: "error" },
        ],
        "Mein ${Ehemann^Ehefrau}?$4",
      ),
    ).toEqual([
      {
        severity: "error",
        kind: "missing",
        message:
          "A he/she switch ${…^…}$ is missing its closing }$, so the game would show broken text.",
      },
    ]);
  });

  it("still reports a missing caret next to a damaged switch", () => {
    expect(
      describeTokenIssue(
        [
          { token: "${", sourceCount: 0, targetCount: 1, severity: "error" },
          {
            token: "${^}$",
            sourceCount: 1,
            targetCount: 0,
            severity: "warning",
          },
          { token: "^", sourceCount: 1, targetCount: 0, severity: "warning" },
        ],
        "Hallo a ${x^y",
      ).map((item) => item.message),
    ).toContain(
      "^ is missing from the translation. In dialogue, ^ splits the text into male and female versions; in a letter it is a line break. Fine if intended.",
    );
  });

  it("explains a removed switch and a portrait change as harmless", () => {
    expect(
      describeTokenIssue(
        [
          {
            token: "${^}$",
            sourceCount: 1,
            targetCount: 0,
            severity: "warning",
          },
          { token: "$8", sourceCount: 1, targetCount: 0, severity: "warning" },
        ],
        "Mein Pflanzenzauberer.$7",
      ),
    ).toEqual([
      {
        severity: "warning",
        kind: "missing",
        message:
          "A he/she variant ${…^…}$ was removed; everyone sees the same text. Fine if intended.",
        token: "${^}$",
      },
      {
        severity: "warning",
        kind: "missing",
        message:
          "The portrait $8 is missing from the translation: the character shows a different face. Fine if intended.",
        token: "$8",
      },
    ]);
  });

  it("points out full-width look-alikes of missing token characters", () => {
    const hint = (wide: string, ascii: string) =>
      `The text contains full-width ${wide} where the English text has ${ascii}. The game shows them as they are; use the normal characters.`;
    expect(
      describeTokenIssue(
        [{ token: "#$b#", sourceCount: 1, targetCount: 0, severity: "error" }],
        "我的＄｛老公＾老婆｝＄＃",
      ).at(-1),
    ).toEqual({
      severity: "error",
      kind: "added",
      message: hint("＄＃", "$ #"),
    });
    // Next to a warning the hint is a warning too; it never adds an error.
    expect(
      describeTokenIssue(
        [{ token: "@", sourceCount: 1, targetCount: 0, severity: "warning" }],
        "你好＠",
      ).at(-1),
    ).toEqual({ severity: "warning", kind: "added", message: hint("＠", "@") });
    // ％［］ are ordinary CJK punctuation unless a missing token needs them.
    expect(
      describeTokenIssue(
        [{ token: "@", sourceCount: 1, targetCount: 0, severity: "warning" }],
        "嗨！50％［注］",
      ),
    ).toHaveLength(1);
    // An added token is not written as a look-alike, so it gets no hint.
    expect(
      describeTokenIssue(
        [{ token: "@", sourceCount: 0, targetCount: 1, severity: "warning" }],
        "＠你好@",
      ),
    ).toHaveLength(1);
    // Without a token difference there is nothing to explain.
    expect(describeTokenIssue([], "＄｛＾｝＄")).toEqual([]);
  });
});
