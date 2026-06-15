import { describe, expect, it } from "vitest";
import type { ZipPreview } from "../tauri/commands";
import { generateReleaseNotes, hasReleaseTemplate } from "./releaseNotes";

const PREVIEW: ZipPreview = {
  packageName: "Sample Pack",
  selectedVersion: "2.0",
  versionSource: "[CP] Sample",
  versionConflicts: [{ modName: "[JA] Sample", version: "1.5" }],
  defaultFileName: "Sample Pack - 2.0 - German (de).zip",
  targetLang: "de",
  targetLanguage: "German",
  entries: [
    {
      modName: "[CP] Sample",
      modVersion: "2.0",
      archivePath: "Sample Pack/[CP] Sample/i18n/de.json",
      strings: 75,
      totalSourceStrings: 100,
      outdated: 2,
      reviewNeeded: 3,
    },
  ],
  omittedComponents: [],
  warnings: [],
  problems: [],
  totalStrings: 75,
  totalSourceStrings: 100,
};

describe("generateReleaseNotes", () => {
  it("generates deterministic localized current-state notes", () => {
    const result = generateReleaseNotes(
      PREVIEW,
      "2.1",
      "Sample Pack release.zip",
      "de",
      new Date("2026-06-15T12:00:00Z"),
    );
    expect(result.fellBackToEnglish).toBe(false);
    expect(result.text).toContain("Deutsche Übersetzung für Sample Pack 2.1");
    expect(result.text).toContain("Abdeckung: 75 / 100 (75");
    expect(result.text).toContain(
      "[CP] Sample 2.0 (Sample Pack/[CP] Sample/i18n/de.json)",
    );
    expect(result.text).toContain("Sample Pack release.zip");
    expect(result.text).toContain("default.json");
    expect(result.text.split("\n").length).toBeLessThanOrEqual(14);
    expect(result.text).not.toContain("Aktualisiere die Original-Mod separat");
    expect(result.text).not.toMatch(/added|changed|removed/i);
  });

  it("switches to English without changing identifiers or metadata", () => {
    const result = generateReleaseNotes(
      PREVIEW,
      "2.0",
      PREVIEW.defaultFileName,
      "en",
      new Date("2026-06-15T12:00:00Z"),
    );
    expect(result.text).toContain("German translation for Sample Pack 2.0");
    expect(result.text).toContain("German (de)");
    expect(result.text).toContain("Sample Pack/[CP] Sample/i18n/de.json");
  });

  it("marks blocking validation as not release-ready", () => {
    const result = generateReleaseNotes(
      {
        ...PREVIEW,
        problems: [
          {
            modUniqueId: "sample.cp",
            modName: "[CP] Sample",
            relativeDir: "i18n",
            key: "hello",
            reason: "token count mismatch",
          },
        ],
      },
      "2.0",
      null,
      "en",
    );
    expect(result.text).toContain("Not release-ready: 1 blocking problem(s)");
  });

  it("falls back as one complete English template", () => {
    const result = generateReleaseNotes(PREVIEW, "2.0", null, "xx");
    expect(result.fellBackToEnglish).toBe(true);
    expect(result.actualLanguage).toBe("en");
    expect(result.text).toContain("Included components");
    expect(result.text).not.toContain("Enthaltene Komponenten");
  });

  it("maintains a template for every supported target language", () => {
    for (const language of [
      "de",
      "es",
      "fr",
      "hu",
      "it",
      "ja",
      "ko",
      "pt",
      "ru",
      "tr",
      "zh",
    ]) {
      expect(hasReleaseTemplate(language), language).toBe(true);
    }
  });
});
