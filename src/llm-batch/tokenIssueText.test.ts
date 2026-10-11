import { describeTokenIssue } from "./tokenIssueText";

describe("describeTokenIssue", () => {
  it("reports an unclosed gender switch as one structural problem", () => {
    expect(
      describeTokenIssue(
        [
          { token: "${", sourceCount: 0, targetCount: 1 },
          { token: "${^}$", sourceCount: 1, targetCount: 0 },
          { token: "^", sourceCount: 0, targetCount: 1 },
        ],
        "Mein ${Ehemann^Ehefrau}?$4",
      ),
    ).toEqual([
      "A gender switch ${…^…}$ is missing its closing }$, so the game cannot read it.",
    ]);
  });

  it("reports a removed gender switch and other tokens in plain language", () => {
    expect(
      describeTokenIssue(
        [
          { token: "${^}$", sourceCount: 1, targetCount: 0 },
          { token: "$b", sourceCount: 2, targetCount: 1 },
        ],
        "Mein hübscher Pflanzenzauberer.$1",
      ),
    ).toEqual([
      "A gender switch ${…^…}$ from the English text was removed or rewritten.",
      "$b is missing (English 2, import 1).",
    ]);
  });

  it("points out full-width look-alikes of token syntax", () => {
    expect(
      describeTokenIssue(
        [{ token: "${^}$", sourceCount: 1, targetCount: 0 }],
        "我的＄｛老公＾老婆｝＄",
      ),
    ).toContain(
      "The text contains full-width characters such as ＄｛｝＾. Tokens must use the normal ASCII characters $ { } ^.",
    );
  });
});
