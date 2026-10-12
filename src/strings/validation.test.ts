import { extractProtectedTokens } from "./protectedTokens";
import { validate, worstSeverity } from "./validation";

describe("validate", () => {
  it("flags a missing game-breaking token as an error", () => {
    const issues = validate("Hello#$b#Bye", "Hallo Tschuess", false);
    expect(issues).toEqual([
      {
        ruleId: "token-missing",
        severity: "error",
        message:
          "#$b# is missing (English 1, translation 0). It starts a new dialogue box, so the page structure changes.",
      },
    ]);
    expect(worstSeverity(issues)).toBe("error");
  });

  it("treats a dropped placeholder value as a warning", () => {
    const issues = validate("Hello {{name}}", "Hallo", false);
    expect(issues).toEqual([
      {
        ruleId: "token-missing",
        severity: "warning",
        message:
          "{{name}} is missing (English 1, translation 0). The value is left out. Fine if intended.",
      },
    ]);
    expect(worstSeverity(issues)).toBe("warning");
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

  it("warns but does not block a cleanly removed gender switch", () => {
    const source = "${Hello @.$7^Welcome @.$7^Goodbye @.}$";
    const target = "Hallo @.$7 Willkommen @.$7 Auf Wiedersehen @.";
    const issues = validate(source, target, false);

    expect(issues).toContainEqual({
      ruleId: "token-missing",
      severity: "warning",
      message:
        "A he/she variant ${…^…}$ was removed; everyone sees the same text. Fine if intended.",
    });
  });

  it("blocks a gender switch whose closer is missing", () => {
    const issues = validate(
      "My brave ${husband^wife}$?$4",
      "Mein ${Ehemann^Ehefrau}?$4",
      false,
    );
    expect(worstSeverity(issues)).toBe("error");
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
    expect(issues[0].message).toContain("he/she switches changed");
  });

  it("still blocks a malformed target-only gender switch", () => {
    const issues = validate("Dear @.", "${Lieber}$ @.", false);

    expect(issues.every((issue) => issue.severity === "error")).toBe(true);
    // The orphan opener and closer are explained as one switch problem.
    expect(issues.map((issue) => issue.ruleId)).toEqual(["token-added"]);
  });

  it("does not let switch separators cancel out across separate blocks", () => {
    const issues = validate("${a^b}$ ${c^d}$", "${x^y^z}$ ${w}$", false);

    expect(issues.some((issue) => issue.severity === "error")).toBe(true);
    expect(issues.map((issue) => issue.message)).toContain(
      "A he/she switch needs two or three variants separated by ^, like ${he^she}$, and cannot contain another switch.",
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

  it("warns about a dropped @ player-name token (Stardew dialogue)", () => {
    const issues = validate(
      "Thank you, @. Really!",
      "Thank you, . Really!",
      false,
    );
    expect(issues).toEqual([
      {
        ruleId: "token-missing",
        severity: "warning",
        message:
          "The player name @ is missing (English 1, translation 0). Fine if intended.",
      },
    ]);
  });

  it("catches a dropped second $b via multiset comparison", () => {
    const issues = validate("a$b b$b c", "a$b b c", false);
    expect(issues.map((i) => i.ruleId)).toEqual(["token-missing"]);
    expect(issues[0].message).toBe(
      "$b is missing (English 2, translation 1). The game would show it as text or change the dialogue flow.",
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
      "#$b# is missing (English 1, translation 0). It starts a new dialogue box, so the page structure changes.",
      "The portrait $s is missing (English 2, translation 0): the character shows a different face. Fine if intended.",
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

  it("does not absorb prose after an asterisk-prefixed malformed break", () => {
    const source = "First.#$b*Visible prose.$7#$b#Last.$2";
    const target = "Erste.#$b*Sichtbarer Text.$7#$b#Letzte.$2";

    expect(extractProtectedTokens(source)).toEqual([
      "#$b*",
      "$7",
      "#$b#",
      "$2",
    ]);
    expect(validate(source, target, false)).toEqual([]);
  });

  it("ignores extra ASCII spaces in a dialogue response command", () => {
    const source = "Question.#$r -1 0 event_key#Answer.";
    const target = "Frage.#$r  -1  0 event_key #Antwort.";

    expect(extractProtectedTokens(target)).toEqual(["#$r -1 0 event_key#"]);
    expect(validate(source, target, false)).toEqual([]);
    expect(
      validate(source, "Frage.#$r\t-1 0 event_key#Antwort.", false),
    ).not.toEqual([]);
  });

  it("keeps response keys, item pools, and mail commands strict", () => {
    expect(
      validate("Question.#$r -1 -1 Yes#Yes.", "Frage.#$r -1 -1 Yes#Ja.", false),
    ).toEqual([]);
    expect(
      validate(
        "Question.#$r -1 -1 Yes#Yes.",
        "Frage.#$r -1 -1 Ja#Ja.",
        false,
      ).map((issue) => issue.ruleId),
    ).toEqual(["token-missing", "token-added"]);
    expect(
      validate("Dinner [196 649].", "Abendessen [196 650].", false).map(
        (issue) => issue.ruleId,
      ),
    ).toEqual(["token-missing", "token-added"]);
    expect(
      validate(
        "Prize%item money 2500 2501 %%",
        "Preis%item Geld 2500 2501 %%",
        false,
      ).map((issue) => issue.ruleId),
    ).toEqual(["token-missing", "token-added"]);
    expect(
      validate(
        "Request%item quest 120 %%",
        "Anfrage%Gegenstandsquest 120%%",
        false,
      ).map((issue) => issue.ruleId),
    ).toEqual(["token-missing"]);
  });

  it("reports standalone # and repeated ^ markers as notes (quotes are ignored)", () => {
    const issues = validate(
      "'Hello' # first^^second",
      "„Hallo“ first^second",
      false,
    );
    // `#` and `^` split pages and genders in dialogue but are plain text in
    // letters and UI strings, so they are notes the translator decides on.
    // The `'` -> „" change is ordinary localized punctuation: no issue.
    const notes = issues
      .filter((issue) => issue.severity === "warning")
      .map((issue) => issue.message)
      .sort();
    expect(notes).toEqual([
      "# is missing (English 1, translation 0). In dialogue, # separates dialogue boxes; elsewhere it is plain text. Fine if intended.",
      "^ is missing (English 2, translation 1). In dialogue, ^ splits the text into male and female versions; in a letter it is a line break. Fine if intended.",
    ]);
    expect(issues.every((issue) => issue.severity === "warning")).toBe(true);
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

  it("ignores physical newline count differences", () => {
    expect(
      validate(
        "Note: line one\nline two\nline three\nline four",
        "Hinweis: Zeile eins\nZeile zwei\nZeile drei",
        false,
      ),
    ).toEqual([]);
    expect(validate("one line", "eine\nZeile", false)).toEqual([]);
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

it.each(["", " ", "\t\r\n", "\u00a0"])(
  "does not warn for blank source and target %j, present or absent",
  (blank) => {
    expect(validate(blank, blank, true)).toEqual([]);
    expect(validate(blank, blank, false)).toEqual([]);
    expect(
      validate("New title", blank, true).map((issue) => issue.ruleId),
    ).toEqual(blank === " " ? [] : ["empty-target"]);
    expect(validate("New title", blank, false)).toEqual([]);
  },
);

it("keeps token errors for whitespace targets when the source contains text", () => {
  expect(validate("{{name}}", " ", true).map((issue) => issue.ruleId)).toEqual([
    "token-missing",
  ]);
  expect(validate("{{name}}", " ", false).map((issue) => issue.ruleId)).toEqual(
    ["token-missing"],
  );
});

it("accepts exactly one space without treating a fully empty target as complete", () => {
  expect(validate("Tree", " ", true)).toEqual([]);
  expect(validate("Tree", "", true).map((issue) => issue.ruleId)).toEqual([
    "empty-target",
  ]);
});

it("classifies NEL as blank and BOM as text like the native scanner", () => {
  expect(validate("\u0085", "\u0085", true)).toEqual([]);
  expect(validate("\uFEFF", "", true).map((issue) => issue.ruleId)).toEqual([
    "empty-target",
  ]);
});
