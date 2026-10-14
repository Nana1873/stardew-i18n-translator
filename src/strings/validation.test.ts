import { extractProtectedTokens } from "./protectedTokens";
import { validate, worstSeverity } from "./validation";

describe("validate", () => {
  it("flags a missing game-breaking token as an error", () => {
    const issues = validate("Here.[128]", "Hier.");
    expect(issues).toEqual([
      {
        ruleId: "token-missing",
        severity: "error",
        message:
          "[128] is missing from the translation. The game would not give this item.",
        token: "[128]",
      },
    ]);
    expect(worstSeverity(issues)).toBe("error");
  });

  it("treats a dropped placeholder value as a warning", () => {
    const issues = validate("Hello {{name}}", "Hallo");
    expect(issues).toEqual([
      {
        ruleId: "token-missing",
        severity: "warning",
        message:
          "{{name}} is missing from the translation. The game shows nothing in its place. Fine if intended.",
        token: "{{name}}",
      },
    ]);
    expect(worstSeverity(issues)).toBe("warning");
  });

  it("flags an extra target token as an error", () => {
    const issues = validate("Hello", "Hallo {{x}}");
    expect(issues.map((i) => i.ruleId)).toEqual(["token-added"]);
    expect(worstSeverity(issues)).toBe("error");
  });

  it("passes when the token sets match (order-independent)", () => {
    expect(validate("{{a}} and {{b}}", "{{b}} und {{a}}")).toEqual([]);
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
    expect(validate(source, target)).toEqual([]);
  });

  it("warns but does not block a cleanly removed gender switch", () => {
    const source = "${Hello @.$7^Welcome @.$7^Goodbye @.}$";
    const target = "Hallo @.$7 Willkommen @.$7 Auf Wiedersehen @.";
    const issues = validate(source, target);

    expect(issues).toContainEqual({
      ruleId: "token-missing",
      severity: "warning",
      message:
        "A he/she variant ${…^…}$ was removed; everyone sees the same text. Fine if intended.",
      token: "${^^}$",
    });
  });

  it("blocks a gender switch whose closer is missing", () => {
    const issues = validate(
      "My brave ${husband^wife}$?$4",
      "Mein ${Ehemann^Ehefrau}?$4",
    );
    expect(worstSeverity(issues)).toBe("error");
  });

  it("allows a well-formed gender switch added for the target language", () => {
    const source = "Dear @.";
    const target = "${Lieber^Liebe}$ @.";

    expect(extractProtectedTokens(target)).toEqual(["${^}$", "@"]);
    expect(validate(source, target)).toEqual([]);
  });

  it("does not let an added switch mask a changed source switch shape", () => {
    const issues = validate("${a^b}$", "${x^y^z}$ ${neu^neu}$");

    expect(issues.map((issue) => issue.ruleId)).toEqual(["token-added"]);
    expect(issues[0].message).toContain("he/she switches differ");
  });

  it("still blocks a malformed target-only gender switch", () => {
    const issues = validate("Dear @.", "${Lieber}$ @.");

    expect(issues.every((issue) => issue.severity === "error")).toBe(true);
    // The orphan opener and closer are explained as one switch problem.
    expect(issues.map((issue) => issue.ruleId)).toEqual(["token-added"]);
  });

  it("does not let switch separators cancel out across separate blocks", () => {
    const issues = validate("${a^b}$ ${c^d}$", "${x^y^z}$ ${w}$");

    expect(issues.some((issue) => issue.severity === "error")).toBe(true);
    expect(issues.map((issue) => issue.message)).toContain(
      "A he/she switch needs two or three variants separated by ^, like ${he^she}$, and cannot contain another switch.",
    );
  });

  it("treats bracketed UI labels and status prose as translatable text", () => {
    expect(validate("[LEFT]", "[LINKS]")).toEqual([]);
    expect(validate("[Right]", "[Rechts]")).toEqual([]);
    expect(
      validate(
        "[Reached global max Power Grid speed]",
        "[Globale Höchstgeschwindigkeit des Stromnetzes erreicht]",
      ),
    ).toEqual([]);
  });

  it("keeps documented opaque bracket tokens protected", () => {
    expect(
      validate(
        "Welcome to [FarmName]. Take [128] and [(O)163].",
        "Willkommen auf [FarmName]. Nimm [128] und [(O)163].",
      ),
    ).toEqual([]);
    expect(
      validate("Welcome to [FarmName].", "Willkommen auf dem Hof.").map(
        (issue) => issue.ruleId,
      ),
    ).toEqual(["token-missing"]);
  });

  it("does not flag an empty (untranslated) target", () => {
    expect(validate("Hi", "")).toEqual([]);
  });

  it("flags a lone surrogate as json-invalid", () => {
    const issues = validate("Hi", "bad \ud800 char");
    expect(issues.some((i) => i.ruleId === "json-invalid")).toBe(true);
  });

  it("warns about a dropped @ player-name token (Stardew dialogue)", () => {
    const issues = validate("Thank you, @. Really!", "Thank you, . Really!");
    expect(issues).toEqual([
      {
        ruleId: "token-missing",
        severity: "warning",
        message:
          "The player name @ is missing from the translation. Fine if intended.",
        token: "@",
      },
    ]);
  });

  it("catches a dropped second $k via multiset comparison", () => {
    const issues = validate("a$k b$k c", "a$k b c");
    expect(issues.map((i) => i.ruleId)).toEqual(["token-missing"]);
    expect(issues[0].message).toBe(
      "$k appears 1 time in the translation instead of 2. The game would show it as text or change the dialogue flow.",
    );
  });

  it("treats a #$b# dialogue break and $s command as protected tokens", () => {
    expect(validate("Hi.$s#$b#Bye?$s", "Hallo.$s#$b#Tschüss?$s")).toEqual([]);
    // Distinct missing tokens ($s and #$b#) -> one issue each.
    const broken = validate("Hi.$s#$b#Bye?$s", "Hallo. Tschüss?");
    expect(broken.map((i) => i.ruleId)).toEqual([
      "token-missing",
      "token-missing",
    ]);
    expect(broken.map((i) => i.message).sort()).toEqual([
      "#$b# is missing from the translation. It starts a new dialogue box; without it the game still moves long text into extra boxes. Fine if intended.",
      "The portrait $s is missing from the translation: the character shows a different face. Fine if intended.",
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
    expect(validate(source, target)).toEqual([]);
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
    expect(validate(source, target)).toEqual([]);
  });

  it("ignores extra ASCII spaces in a dialogue response command", () => {
    const source = "Question.#$r -1 0 event_key#Answer.";
    const target = "Frage.#$r  -1  0 event_key #Antwort.";

    expect(extractProtectedTokens(target)).toEqual(["#$r -1 0 event_key#"]);
    expect(validate(source, target)).toEqual([]);
    expect(validate(source, "Frage.#$r\t-1 0 event_key#Antwort.")).not.toEqual(
      [],
    );
  });

  it("keeps response keys, item pools, and mail commands strict", () => {
    expect(
      validate("Question.#$r -1 -1 Yes#Yes.", "Frage.#$r -1 -1 Yes#Ja."),
    ).toEqual([]);
    expect(
      validate("Question.#$r -1 -1 Yes#Yes.", "Frage.#$r -1 -1 Ja#Ja.").map(
        (issue) => issue.ruleId,
      ),
      // Code-point order like the export: `…Ja#` sorts before `…Yes#`.
    ).toEqual(["token-added", "token-missing"]);
    expect(
      validate("Dinner [196 649].", "Abendessen [196 650].").map(
        (issue) => issue.ruleId,
      ),
    ).toEqual(["token-missing", "token-added"]);
    expect(
      validate(
        "Prize%item money 2500 2501 %%",
        "Preis%item Geld 2500 2501 %%",
      ).map((issue) => issue.ruleId),
    ).toEqual(["token-added", "token-missing"]);
    expect(
      validate(
        "Request%item quest 120 %%",
        "Anfrage%Gegenstandsquest 120%%",
      ).map((issue) => issue.ruleId),
    ).toEqual(["token-missing"]);
  });

  it("reports standalone # and repeated ^ markers as notes (quotes are ignored)", () => {
    const issues = validate("'Hello' # first^^second", "„Hallo“ first^second");
    // `#` and `^` split pages and genders in dialogue but are plain text in
    // letters and UI strings, so they are notes the translator decides on.
    // The `'` -> „" change is ordinary localized punctuation: no issue.
    const notes = issues
      .filter((issue) => issue.severity === "warning")
      .map((issue) => issue.message)
      .sort();
    expect(notes).toEqual([
      "# is missing from the translation. In dialogue, # ends the conversation there and the rest shows the next time the player talks to the character; elsewhere it is plain text. Fine if intended.",
      "^ appears 1 time in the translation instead of 2. In dialogue, ^ splits the text into male and female versions; in a letter it is a line break. Fine if intended.",
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
      ),
    ).toEqual([]);
    expect(validate("'test'", "test")).toEqual([]);
    expect(worstSeverity([])).toBeNull();
  });

  it("does not treat apostrophes inside words as protected tokens", () => {
    expect(
      validate("Don't touch the farmer's hat.", "Fass den Hut nicht an."),
    ).toEqual([]);
  });

  it("ignores physical newline count differences", () => {
    expect(
      validate(
        "Note: line one\nline two\nline three\nline four",
        "Hinweis: Zeile eins\nZeile zwei\nZeile drei",
      ),
    ).toEqual([]);
    expect(validate("one line", "eine\nZeile")).toEqual([]);
    expect(validate("a\nb", "x\ny")).toEqual([]);
  });

  it("accepts an intentionally unchanged translation", () => {
    expect(validate("Parsnip", "Parsnip")).toEqual([]);
  });

  it("accepts an intentionally unchanged bracketed UI label", () => {
    expect(validate("[LEFT]", "[LEFT]")).toEqual([]);
  });

  it("warns when literal escape sequences differ", () => {
    const issues = validate(
      String.raw`First\nSecond`,
      String.raw`Erste Zeile\\nZweite Zeile`,
    );
    expect(issues.map((issue) => issue.ruleId)).toContain("escape-suspicious");
    expect(
      validate(String.raw`First\nSecond`, String.raw`Erste\nZweite`).map(
        (issue) => issue.ruleId,
      ),
    ).not.toContain("escape-suspicious");
  });
});

it.each(["", " ", "\t\r\n", "\u00a0"])(
  "does not warn for blank source and target %j",
  (blank) => {
    expect(validate(blank, blank)).toEqual([]);
    expect(validate("New title", blank)).toEqual([]);
  },
);

it("keeps token errors for whitespace targets when the source contains text", () => {
  expect(validate("{{name}}", " ").map((issue) => issue.ruleId)).toEqual([
    "token-missing",
  ]);
});

it("accepts exactly one space as an intentional blank", () => {
  expect(validate("Tree", " ")).toEqual([]);
});

it("classifies NEL as blank and BOM as text like the native scanner", () => {
  expect(validate("\u0085", "\u0085")).toEqual([]);
});
