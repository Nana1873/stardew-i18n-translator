import { describe, expect, it } from "vitest";
import type { NexusArchive, NexusFile, ScannedMod } from "../tauri/commands";
import {
  resolveArchiveTranslations,
  selectTranslationFile,
} from "./resolveTranslation";
const file = (overrides: Partial<NexusFile> = {}): NexusFile => ({
  fileId: 1,
  name: "German Translation 1.0",
  fileName: "translation.zip",
  version: "1.0",
  uploadedAt: "2026-01-01",
  category: "MAIN",
  description: "",
  ...overrides,
});
const mod = (
  uniqueId = "example.mod",
  overrides: Partial<ScannedMod> = {},
): ScannedMod =>
  ({
    uniqueId,
    name: uniqueId,
    nexusId: 10,
    packageId: "Example",
    folderPath: `C:/Mods/Example/${uniqueId}`,
    i18nFiles: [{ relativeDir: "i18n" }],
    ...overrides,
  }) as ScannedMod;
const archive = (...files: NexusArchive["files"]): NexusArchive => ({
  archiveId: "archive",
  notice: "",
  files,
});
const entry = (path: string, manifestUniqueId: string | null = null) => ({
  path,
  manifestUniqueId,
  isDefault: path.endsWith("default.json"),
});

describe("ZIP selection", () => {
  it("selects a sole suitable ZIP and ignores removed, incompatible language and non-ZIP files", () => {
    const selected = file();
    expect(
      selectTranslationFile(
        [
          file({ fileId: 2, name: "Russian Translation" }),
          file({ fileId: 3, category: "OLD_VERSION" }),
          file({ fileId: 4, fileName: "translation.7z" }),
          selected,
        ],
        "de",
      ),
    ).toMatchObject({ kind: "selected", file: selected });
  });
  it("prefers explicit target-language optional file over generic main", () => {
    const target = file({ fileId: 2, category: "OPTIONAL" });
    expect(
      selectTranslationFile([file({ name: "Main file" }), target], "de"),
    ).toMatchObject({ kind: "selected", file: target });
  });
  it("selects newest revision of the same named release series", () => {
    expect(
      selectTranslationFile(
        [
          file(),
          file({
            fileId: 2,
            name: "German Translation 1.1",
            version: "1.1",
            uploadedAt: "2026-02-01",
          }),
        ],
        "de",
      ),
    ).toMatchObject({ kind: "selected", file: { fileId: 2 } });
  });
  it("keeps Full/Lite and numeric game compatibility variants ambiguous", () => {
    for (const names of [
      ["German Full", "German Lite"],
      ["German for Stardew 1.5", "German for Stardew 1.6"],
    ]) {
      expect(
        selectTranslationFile(
          names.map((name, i) =>
            file({ fileId: i + 1, name, uploadedAt: `2026-0${i + 1}-01` }),
          ),
          "de",
        ).kind,
      ).toBe("choice");
    }
  });
  it("does not guess chronology when dates are missing or equal", () => {
    expect(
      selectTranslationFile([file(), file({ fileId: 2 })], "de").kind,
    ).toBe("choice");
    expect(
      selectTranslationFile(
        [file({ uploadedAt: "" }), file({ fileId: 2, uploadedAt: "" })],
        "de",
      ).kind,
    ).toBe("choice");
  });
  it("does not reject a German file merely because description mentions the English source", () => {
    expect(
      selectTranslationFile(
        [file({ description: "German translation of the English source" })],
        "de",
      ).kind,
    ).toBe("selected");
  });
  it("returns unavailable for wrong language or unsupported format", () => {
    expect(
      selectTranslationFile([file({ name: "French Translation" })], "de").kind,
    ).toBe("unavailable");
    expect(
      selectTranslationFile([file({ fileName: "translation.rar" })], "de").kind,
    ).toBe("unavailable");
  });
});

describe("archive mapping", () => {
  it("automaps exact manifest identity without asking", () => {
    const result = resolveArchiveTranslations(
      archive(entry("Wrapped/Example/i18n/de.json", "EXAMPLE.MOD")),
      10,
      [mod()],
      "de",
    );
    expect(result.mappings).toEqual([
      {
        archiveId: "archive",
        archivePath: "Wrapped/Example/i18n/de.json",
        modUniqueId: "example.mod",
        relativeDir: "i18n",
      },
    ]);
    expect(result.choices).toEqual([]);
  });
  it("rejects mismatched manifest even when an unrelated installed mod matches", () => {
    const result = resolveArchiveTranslations(
      archive(entry("i18n/de.json", "addon")),
      10,
      [mod(), mod("addon", { nexusId: 99, packageId: "Other" })],
      "de",
    );
    expect(result.mappings).toEqual([]);
    expect(result.choices).toEqual([]);
    expect(result.rejected).toBe(1);
  });
  it("does not assign a sibling with a different positive Nexus ID", () => {
    expect(
      resolveArchiveTranslations(
        archive(entry("i18n/de.json", "other")),
        10,
        [mod(), mod("other", { nexusId: 99 })],
        "de",
      ).mappings,
    ).toEqual([]);
  });
  it("resolves real-shaped RSV no-manifest code, CC and CP through exact sibling folder suffixes", () => {
    const components = [
      mod("rsv.cp", { folderPath: "C:/Mods/RSV/[CP] Ridgeside Village" }),
      mod("rsv.cc", {
        nexusId: null,
        folderPath: "C:/Mods/RSV/[CC] Ridgeside Village",
      }),
      mod("rsv.code", {
        nexusId: null,
        folderPath: "C:/Mods/RSV/RidgesideVillage",
      }),
    ];
    const files = [
      "[CP] Ridgeside Village",
      "[CC] Ridgeside Village",
      "RidgesideVillage",
    ].map((folder) =>
      entry(
        `Ridgeside Village Vietnamese/Ridgeside Village/${folder}/i18n/vi.json`,
      ),
    );
    const result = resolveArchiveTranslations(
      archive(...files),
      10,
      components,
      "vi",
    );
    expect(result.choices).toEqual([]);
    expect(result.mappings.map((m) => m.modUniqueId).sort()).toEqual([
      "rsv.cc",
      "rsv.code",
      "rsv.cp",
    ]);
  });
  it("requires a choice when component basenames collide or no-manifest paths are not distinct", () => {
    const components = [
      mod("a", { folderPath: "C:/Mods/Example/a/Same" }),
      mod("b", { folderPath: "C:/Mods/Example/b/Same" }),
    ];
    for (const path of ["Wrapped/Same/i18n/de.json", "i18n/de.json"]) {
      const result = resolveArchiveTranslations(
        archive(entry(path)),
        10,
        components,
        "de",
      );
      expect(result.mappings).toEqual([]);
      expect(result.choices[0].options).toHaveLength(2);
    }
  });
  it("chooses longest exact i18n relative suffix within a manifest", () => {
    const component = mod("example.mod", {
      i18nFiles: [{ relativeDir: "i18n" }, { relativeDir: "sub/i18n" }],
    } as Partial<ScannedMod>);
    expect(
      resolveArchiveTranslations(
        archive(entry("Wrapper/sub/i18n/de.json", "example.mod")),
        10,
        [component],
        "de",
      ).mappings[0].relativeDir,
    ).toBe("sub/i18n");
  });
  it("never autoimports competing locale files into the same destination", () => {
    const result = resolveArchiveTranslations(
      archive(entry("A/i18n/de.json"), entry("B/i18n/de.json")),
      10,
      [mod()],
      "de",
    );
    expect(result.mappings).toEqual([]);
    expect(result.choices).toHaveLength(1);
    expect(result.choices[0].options).toHaveLength(2);
  });
  it("supports Portuguese fallback without silently choosing between duplicate destinations", () => {
    expect(
      resolveArchiveTranslations(
        archive(entry("i18n/pt-BR.json")),
        10,
        [mod()],
        "pt",
      ).mappings,
    ).toHaveLength(1);
    const both = resolveArchiveTranslations(
      archive(entry("i18n/pt-BR.json"), entry("i18n/pt.json")),
      10,
      [mod()],
      "pt",
    );
    expect(both.mappings).toEqual([]);
    expect(both.choices[0].options).toHaveLength(2);
  });
  it("asks explicitly for translated default and ignores source default when target is present", () => {
    const defaults = resolveArchiveTranslations(
      archive(entry("i18n/default.json")),
      10,
      [mod()],
      "de",
    );
    expect(defaults.mappings).toEqual([]);
    expect(defaults.choices[0].requiresDefaultConfirmation).toBe(true);
    const target = resolveArchiveTranslations(
      archive(entry("i18n/default.json"), entry("i18n/de.json")),
      10,
      [mod()],
      "de",
    );
    expect(target.mappings).toHaveLength(1);
    expect(target.choices).toEqual([]);
  });
  it("rejects unsafe paths/assets and does not use other-language JSON", () => {
    const result = resolveArchiveTranslations(
      archive(
        entry("../i18n/de.json"),
        entry("assets/i18n/de.json"),
        entry("i18n/fr.json"),
      ),
      10,
      [mod()],
      "de",
    );
    expect(result.mappings).toEqual([]);
    expect(result.choices).toEqual([]);
  });
});
