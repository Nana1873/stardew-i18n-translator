/**
 * Synthetic fixture data for the browser preview (`vite --mode preview`).
 *
 * Everything here is invented: no real mod, game, or user data. The strings
 * deliberately cover the cases the UI has to handle well — protected-token
 * errors and warnings, CJK, long text, long keys, sections, every status.
 */
import type {
  GlossaryEntry,
  ScanResult,
  SkippedComponent,
  StringStatus,
} from "./commands";

export const PREVIEW_GAME_PATH = "C:\\Preview\\Stardew Valley";
export const PREVIEW_MODS_PATH = "C:\\Preview\\Stardew Valley\\Mods";

export interface FixtureString {
  key: string;
  source: string;
  /** Initial translation; empty = Open. */
  target?: string;
  status?: StringStatus;
  section?: string;
  tokenMismatchAccepted?: boolean;
}

export interface FixtureMod {
  uniqueId: string;
  name: string;
  version: string;
  folder: string;
  nexusId: number | null;
  strings: FixtureString[];
}

const LONG_KEY =
  "Dialogue.Characters.Abigail.Festival.FlowerDance.AskToDance.Response." +
  "WhenPlayerHasAlreadyAskedSomeoneElseThisYear.FollowUp.Line02";

export const FIXTURE_MODS: FixtureMod[] = [
  {
    uniqueId: "Preview.EdgeCases",
    name: "Preview Edge Cases (tokens, CJK, long text)",
    version: "1.0.0",
    folder: "Preview Edge Cases\\PreviewEdgeCases",
    nexusId: null,
    strings: [
      {
        key: "greeting",
        section: "Greetings",
        source: "Hi {{PlayerName}}! Nice to meet you.$h#$b#Ready to work?",
        target:
          "Hallo {{PlayerName}}! Schön dich zu treffen.$h#$b#Bereit für die Arbeit?",
        status: "translated",
      },
      {
        key: "gender",
        section: "Greetings",
        source: "Oh, ${he^she}$ went to the beach today.",
        target: "Oh, ${er^sie ist heute zum Strand gegangen.",
        status: "translated",
      },
      {
        key: "portrait",
        section: "Greetings",
        source: "I love rainy days.$8#$e#Don't you?",
        target: "Ich liebe Regentage.$7#$e#Du nicht?",
        status: "translated",
      },
      {
        key: "mail",
        section: "Greetings",
        source:
          "Here is a gift for you.%item object 128 1 %%[#]A letter from Robin",
        target: "Hier ist ein Geschenk für dich.%item object 128 1 %%",
        status: "translated",
      },
      {
        key: "placeholder",
        section: "Greetings",
        source: "You caught {0} fish today, worth {1}g.",
        target: "Du hast heute {0} Fische gefangen.",
        status: "translated",
      },
      {
        key: "braces",
        section: "Greetings",
        source: "Price: {{Price}} gold",
        target: "Preis: {{Preis}} Gold",
        status: "translated",
      },
      {
        key: "question",
        section: "Greetings",
        source:
          "Will you help me?$q 1234 null#$r 1234 10 yes#Sure!#$r 1234 -10 no#No way.",
        target:
          "Hilfst du mir?$q 1234 null#$r 1234 10 yes#Klar!#$r 1234 -10 no#Niemals.",
        status: "translated",
      },
      {
        key: "@token",
        section: "Greetings",
        source: "Thanks @, you are the best!",
        target: "Danke, du bist die Beste!",
        status: "translated",
      },
      {
        key: "cjk",
        section: "Greetings",
        source: "A simple sentence for CJK testing.",
        target:
          "これは日本語のテスト文です。漢字とカナを含みます。한국어 문장도 포함합니다. 中文句子也包含在内。",
        status: "translated",
      },
      {
        key: "longtext",
        section: "Greetings",
        source:
          "This is a long paragraph used to test how the editor and table handle very long translations without truncation problems or overflow in the preview columns, including line wrapping behaviour, scrolling, and the token hint area below the text fields.",
        target:
          "Dies ist ein sehr langer Absatz, der testet, wie der Editor und die Tabelle mit sehr langen Übersetzungen umgehen, ohne dass Texte abgeschnitten werden oder in den Vorschauspalten überlaufen, einschließlich Zeilenumbruch, Scrollen und dem Bereich für Token-Hinweise unter den Textfeldern. Außerdem enthält er Umlaute wie Ä, Ö, Ü und ß sowie typografische Anführungszeichen „so“ und ‚so‘ und einen Gedankenstrich – hier – zur Prüfung der Darstellung.",
        status: "translated",
      },
      {
        key: LONG_KEY,
        section: "Greetings",
        source: "Of course I'll dance with you!",
      },
      {
        key: "review",
        section: "Greetings",
        source: "The AI wrote this one for you.",
        target: "Die KI hat diesen Text für dich geschrieben.",
        status: "review-needed",
      },
      {
        key: "changed",
        section: "Greetings",
        source: "The English text changed after you translated it.",
        target: "Der englische Text hat sich nach der Übersetzung geändert.",
        status: "outdated",
      },
      {
        key: "accepted",
        section: "Greetings",
        source: "Pick a color: {{Color}}",
        target: "Wähle eine Farbe:",
        status: "translated",
        tokenMismatchAccepted: true,
      },
      { key: "item.name", section: "Items", source: "Golden Pumpkin" },
      { key: "item.desc", section: "Items", source: "A very rare pumpkin." },
      {
        key: "blank",
        section: "Items",
        source: "",
        target: "",
        status: "translated",
      },
    ],
  },
  {
    uniqueId: "Preview.VeryLongModNameForTruncationTesting.Component.One",
    name: "A Very Long Mod Name That Goes On And On For Testing The Mod List Column Truncation Behaviour In The Workspace Pane",
    version: "1.0.0",
    folder: "Long Name Mod\\A Very Long Mod Name",
    nexusId: 12345,
    strings: [
      { key: "a", source: "Alpha" },
      { key: "b", source: "Beta" },
      { key: "c", source: "Gamma" },
    ],
  },
  {
    uniqueId: "Preview.Village",
    name: "Preview Village",
    version: "2.3.1",
    folder: "Preview Village\\[CP] Preview Village",
    nexusId: 67890,
    strings: buildVillageStrings(),
  },
];

function buildVillageStrings(): FixtureString[] {
  const names = ["Abigail", "Harvey", "Leah", "Sebastian", "Robin", "Lewis"];
  const lines = [
    "Good morning, @! The weather is lovely today.$h",
    "I found a {{ItemName}} by the river. Want it?",
    "Did you hear about the festival? ${He^She}$ said it starts at noon.",
    "Only {0} days left until the harvest.#$b#We should prepare.",
    "Thanks for the gift! I love it.$l",
  ];
  const result: FixtureString[] = [];
  names.forEach((name, n) => {
    lines.forEach((line, i) => {
      const translated = (n + i) % 3 !== 0;
      result.push({
        key: `${name}.day${i + 1}`,
        section: name,
        source: line,
        target: translated ? `[de] ${line}` : undefined,
        status: translated
          ? i === 2 && n % 2 === 0
            ? "review-needed"
            : "translated"
          : undefined,
      });
    });
  });
  for (let i = 1; i <= 30; i += 1) {
    result.push({
      key: `Config.option${i}.name`,
      section: "Config",
      source: `Option ${i}`,
      target: i % 4 === 0 ? undefined : `Option ${i}`,
      status: i % 4 === 0 ? undefined : "translated",
    });
  }
  return result;
}

export const FIXTURE_SKIPPED: SkippedComponent[] = [
  {
    packageId: "Preview Broken JSON",
    componentUniqueId: "Preview.BrokenJson",
    componentName: "Preview Broken JSON",
    relativeLocation: "Preview Broken JSON/PreviewBroken/i18n/default.json",
    reason:
      "Invalid JSON in Mods/Preview Broken JSON/PreviewBroken/i18n/default.json: expected `,` or `}` at line 1 column 29",
    requiresAttention: true,
    restOfPackageLoaded: false,
  },
  {
    packageId: "Preview Duplicate",
    componentUniqueId: "Preview.DuplicateId",
    componentName: "Preview Duplicate",
    relativeLocation: "Preview Duplicate/i18n/default.json",
    reason:
      "Translation state is unavailable because this component's UniqueID is duplicated or could not be migrated safely.",
    requiresAttention: true,
    restOfPackageLoaded: false,
  },
  {
    packageId: "Preview Duplicate - Copy",
    componentUniqueId: "Preview.DuplicateId",
    componentName: "Preview Duplicate",
    relativeLocation: "Preview Duplicate - Copy/i18n/default.json",
    reason:
      "Translation state is unavailable because this component's UniqueID is duplicated or could not be migrated safely.",
    requiresAttention: true,
    restOfPackageLoaded: false,
  },
  {
    packageId: "Preview Language Pack",
    componentUniqueId: "Preview.LanguagePack",
    componentName: "Preview Language Pack (de)",
    relativeLocation: "Preview Language Pack/[CP] Preview Language Pack",
    reason:
      "Community language pack: supplies game strings, not a translation target.",
    requiresAttention: false,
    restOfPackageLoaded: true,
  },
];

export const FIXTURE_WARNINGS: string[] = [
  "Two installed mods use the same UniqueID (Preview.DuplicateId), so their translations were left out. Remove the extra copy.",
];

export const FIXTURE_GLOSSARY: GlossaryEntry[] = [
  {
    source: "Golden Pumpkin",
    target: "Goldener Kürbis",
    kind: "item",
    asset: "Strings/Objects",
    key: "GoldenPumpkin_Name",
  },
  {
    source: "Parsnip",
    target: "Pastinake",
    kind: "item",
    asset: "Strings/Objects",
    key: "Parsnip_Name",
  },
  {
    source: "Abigail",
    target: "Abigail",
    kind: "npc",
    asset: "Strings/NPCNames",
    key: "Abigail",
  },
  {
    source: "Robin",
    target: "Robin",
    kind: "npc",
    asset: "Strings/NPCNames",
    key: "Robin",
  },
];

/** Shape helper so the bridge can report scan metadata without a scan. */
export function fixtureScanShape(): Pick<ScanResult, "modCount" | "fileCount"> {
  return { modCount: FIXTURE_MODS.length, fileCount: FIXTURE_MODS.length };
}
