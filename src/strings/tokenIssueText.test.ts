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
          { token: "^", sourceCount: 1, targetCount: 0, severity: "error" },
        ],
        "Hallo a ${x^y",
      ).map((item) => item.message),
    ).toContain(
      "^ is missing (English 1, translation 0). In dialogue, ^ splits the text into male and female versions.",
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
      },
      {
        severity: "warning",
        kind: "missing",
        message:
          "The portrait $8 is missing (English 1, translation 0): the character shows a different face. Fine if intended.",
      },
    ]);
  });

  it("points out full-width look-alikes only next to an error", () => {
    const fullWidth = "我的＄｛老公＾老婆｝＄";
    expect(
      describeTokenIssue(
        [{ token: "#", sourceCount: 1, targetCount: 0, severity: "error" }],
        fullWidth,
      ).map((item) => item.message),
    ).toContain(
      "The text contains full-width characters such as ＄｛｝＾. Tokens must use the normal characters $ { } ^.",
    );
    expect(
      describeTokenIssue(
        [
          {
            token: "${^}$",
            sourceCount: 1,
            targetCount: 0,
            severity: "warning",
          },
        ],
        fullWidth,
      ),
    ).toHaveLength(1);
  });
});
