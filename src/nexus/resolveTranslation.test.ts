import { describe, expect, it } from "vitest";
import type { NexusArchive, NexusFile, ScannedMod } from "../tauri/commands";
import {
  resolveArchiveTranslations,
  nexusSourceDiskCoverage,
  nexusSourceScanIncomplete,
  selectTranslationFile,
  translationFileOptions,
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
  it("keeps earlier current versions available while recommending the newest", () => {
    const earlier = file();
    const latest = file({
      fileId: 2,
      name: "German Translation 1.1",
      version: "1.1",
      uploadedAt: "2026-02-01",
    });
    const available = [
      earlier,
      latest,
      file({ fileId: 3, category: "ARCHIVED" }),
    ];
    expect(
      translationFileOptions(available, "de").map((item) => item.fileId),
    ).toEqual([2, 1]);
    expect(selectTranslationFile(available, "de")).toMatchObject({
      kind: "selected",
      file: { fileId: 2 },
    });
  });

  it("offers ZIP, RAR and 7z for direct imports without an older ZIP fallback", () => {
    const zip = file();
    const rar = file({ fileId: 2, fileName: "translation.rar" });
    expect(translationFileOptions([zip, rar], "de", "review")).toEqual([
      rar,
      zip,
    ]);
    expect(selectTranslationFile([zip, rar], "de", "review")).toMatchObject({
      file: rar,
    });
    expect(
      selectTranslationFile(
        [zip, file({ fileId: 3, fileName: "translation.7z" })],
        "de",
        "review",
      ),
    ).toMatchObject({ file: { fileId: 3 } });
    expect(translationFileOptions([zip, rar], "de", "vortex")).toHaveLength(2);
  });

  it("selects a sole suitable ZIP and ignores removed, incompatible language and unsupported formats", () => {
    const selected = file();
    expect(
      selectTranslationFile(
        [
          file({ fileId: 2, name: "Russian Translation" }),
          file({ fileId: 3, category: "OLD_VERSION" }),
          file({ fileId: 4, fileName: "translation.tar" }),
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
  it("defaults to the newest upload across Full/Lite and game compatibility variants", () => {
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
        ),
      ).toMatchObject({ kind: "selected", file: { fileId: 2 } });
    }
  });
  it("uses the highest file ID deterministically when dates are equal or invalid", () => {
    for (const uploadedAt of ["2026-01-01", "", "invalid"]) {
      const options = [file({ uploadedAt }), file({ fileId: 2, uploadedAt })];
      for (const ordered of [options, [...options].reverse()]) {
        expect(selectTranslationFile(ordered, "de")).toMatchObject({
          kind: "selected",
          file: { fileId: 2 },
        });
      }
    }
  });
  it("keeps language, category and archive eligibility ahead of upload recency", () => {
    const eligible = file();
    const newer = { fileId: 9, uploadedAt: "2026-03-01" };
    expect(
      selectTranslationFile(
        [
          eligible,
          file({ ...newer, name: "French Translation" }),
          file({ ...newer, category: "OLD_VERSION" }),
          file({ ...newer, category: "ARCHIVED" }),
          file({ ...newer, name: "German Mobile Translation" }),
          file({ ...newer, fileName: "translation.tar" }),
        ],
        "de",
        "review",
      ),
    ).toMatchObject({ kind: "selected", file: eligible });
    expect(
      selectTranslationFile(
        [eligible, file({ ...newer, fileName: "translation.rar" })],
        "de",
        "vortex",
      ),
    ).toMatchObject({ kind: "selected", file: { fileId: 9 } });
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
      selectTranslationFile([file({ fileName: "translation.tar" })], "de").kind,
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

it("separates blank sources from physically present disk text in Nexus coverage", () => {
  const coverage = nexusSourceDiskCoverage(
    [
      mod("blank.mod", {
        totalKeys: 2,
        translatedKeys: 2,
        noTranslationNeededKeys: 0,
        diskTranslatedKeys: 0,
        diskNoTranslationNeededKeys: 2,
      }),
    ],
    10,
    [],
    true,
  );
  expect(coverage).toMatchObject({
    total: 2,
    covered: 0,
    noTextNeeded: 2,
    missing: 0,
    complete: true,
  });
  expect(
    nexusSourceDiskCoverage(
      [
        mod("blank.mod", {
          totalKeys: 2,
          translatedKeys: 2,
          diskTranslatedKeys: 0,
          diskNoTranslationNeededKeys: 1,
        }),
      ],
      10,
      [],
      true,
    ),
  ).toMatchObject({ covered: 0, missing: 1, complete: false });
});

it.each([0, 69])(
  "does not present a surviving sibling as whole-source coverage after unrelated scan errors (%i translated)",
  (covered) => {
    const surviving = mod("FrontierFarm", {
      nexusId: 3753,
      packageId: "Frontier",
      totalKeys: 69,
      diskTranslatedKeys: covered,
    });
    const skipped = [
      {
        packageId: "MultiSave",
        componentUniqueId: "recon88.MultiSave",
        componentName: "MultiSave",
        relativeLocation: "MultiSave",
        reason: "Duplicate mod identity",
        requiresAttention: true,
        restOfPackageLoaded: false,
      },
    ];
    expect(
      nexusSourceDiskCoverage([surviving], 3753, skipped, true),
    ).toBeNull();
    expect(
      nexusSourceDiskCoverage(
        [surviving],
        3753,
        [{ ...skipped[0], requiresAttention: false }],
        true,
      ),
    ).toMatchObject({ total: 69, covered, complete: covered === 69 });
  },
);

it("scopes scan omissions by manifest ID and package identities while failing closed for unknown IDs", () => {
  const original = mod("SVE", {
    nexusId: 3753,
    packageId: "SVE",
    totalKeys: 10,
    diskTranslatedKeys: 5,
  });
  const frontier = mod("Frontier", {
    nexusId: 3753,
    packageId: "Frontier",
    totalKeys: 69,
    diskTranslatedKeys: 69,
  });
  const omitted = {
    nexusId: 22953,
    packageId: "MultiSave",
    componentUniqueId: "MultiSave",
    componentName: null,
    relativeLocation: "MultiSave",
    reason: "Duplicate",
    requiresAttention: true,
    restOfPackageLoaded: false,
  };
  expect(
    nexusSourceDiskCoverage([original, frontier], 3753, [omitted], true),
  ).toMatchObject({ total: 79, covered: 74 });
  expect(
    nexusSourceScanIncomplete(
      [original, frontier],
      3753,
      [{ ...omitted, nexusId: 3753 }],
      true,
    ),
  ).toBe(true);
  expect(
    nexusSourceScanIncomplete(
      [original, frontier],
      3753,
      [{ ...omitted, nexusId: null }],
      true,
    ),
  ).toBe(true);
  expect(
    nexusSourceScanIncomplete(
      [original, frontier],
      3753,
      [{ ...omitted, nexusId: null, packageId: "SVE" }],
      true,
    ),
  ).toBe(true);
  const other = mod("other", { nexusId: 5, packageId: "other" });
  expect(
    nexusSourceScanIncomplete(
      [original, frontier, other],
      5,
      [
        {
          ...omitted,
          nexusId: null,
          componentUniqueId: "sve",
          packageId: null,
        },
      ],
      true,
    ),
  ).toBe(false);
  expect(
    nexusSourceScanIncomplete([original, frontier], 3753, [omitted], false),
  ).toBe(true);
});

it("propagates affected Nexus IDs through mixed-source packages regardless of case", () => {
  const mods = [
    mod("a", { nexusId: 1, packageId: "A" }),
    mod("b", { nexusId: 1, packageId: "Bridge" }),
    mod("c", { nexusId: 2, packageId: "bridge" }),
    mod("d", { nexusId: 2, packageId: "Final" }),
    mod("e", { nexusId: 3, packageId: "FINAL" }),
    mod("other", { nexusId: 9, packageId: "Unrelated" }),
  ];
  const skipped = [
    {
      nexusId: null,
      packageId: "a",
      componentUniqueId: null,
      componentName: null,
      relativeLocation: "A",
      reason: "Duplicate",
      requiresAttention: true,
      restOfPackageLoaded: false,
    },
  ];
  expect(nexusSourceScanIncomplete(mods, 3, skipped, true)).toBe(true);
  expect(nexusSourceScanIncomplete(mods, 9, skipped, true)).toBe(false);
});

it("keeps source totals unknown when native identity-conflict recovery is incomplete", () => {
  const complete = mod("source", { totalKeys: 10, diskTranslatedKeys: 10 });
  expect(nexusSourceDiskCoverage([complete], 10, [], true, true)).toBeNull();
});
