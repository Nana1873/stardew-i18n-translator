import { describe, expect, it } from "vitest";
import type { NexusCandidate, NexusFile, ScannedMod } from "../tauri/commands";
import { deriveNexusResult, type NexusResultInput } from "./resultState";
const candidate = (modId: number): NexusCandidate => ({
  modId,
  name: `Translation ${modId}`,
  summary: "",
  version: "1",
  updatedAt: "2026-01-01",
  relationshipTier: "possible-original-translation",
});
const file = (fileId: number, uploadedAt: string): NexusFile => ({
  fileId,
  uploadedAt,
  name: "German",
  fileName: "de.zip",
  category: "MAIN",
  version: "1",
  description: "",
});
function input(overrides: Partial<NexusResultInput> = {}): NexusResultInput {
  return {
    entry: {
      modId: 1,
      localNames: ["Original"],
      result: {
        modId: 1,
        originalName: "Original",
        candidates: [candidate(10), candidate(20)],
        limited: false,
        notice: "",
      },
    },
    mods: [
      {
        uniqueId: "original",
        nexusId: 1,
        totalKeys: 10,
        diskTranslatedKeys: 0,
      },
    ] as ScannedMod[],
    skippedComponents: [],
    traversalComplete: true,
    nexusIdentityIncomplete: false,
    isVortex: true,
    installedNexusTranslations: [],
    vortexInstalledFiles: [],
    fileMetadata: {
      10: { files: [file(100, "2026-01-01"), file(101, "2026-02-01")] },
      20: { files: [file(200, "2026-03-01")] },
    },
    targetLang: "de",
    allowArchives: true,
    ...overrides,
  };
}
describe("Nexus result selection", () => {
  it("recommends the latest suitable file when nothing is installed", () => {
    expect(deriveNexusResult(input()).value).toBe("20:200");
  });
  it.each([0, 5])(
    "excludes the installed latest file with %i covered keys without downgrading or changing page",
    (covered) => {
      const result = deriveNexusResult(
        input({
          mods: [
            {
              uniqueId: "original",
              nexusId: 1,
              totalKeys: 10,
              diskTranslatedKeys: covered,
            },
          ] as ScannedMod[],
          vortexInstalledFiles: [{ modId: 10, fileId: 101 }],
        }),
      );
      expect(result.value).toBe("");
      expect(result.options.map((option) => option.value)).not.toContain(
        "10:101",
      );
      expect(result.coverage?.covered).toBe(covered);
      expect(result.deployedEvidence).toEqual([]);
    },
  );
  it("prefers an update on the installed page over a newer unrelated page", () => {
    expect(
      deriveNexusResult(
        input({ vortexInstalledFiles: [{ modId: 10, fileId: 100 }] }),
      ).value,
    ).toBe("10:101");
  });
  it("retains explicit alternatives and explicit empty selection", () => {
    const base = input({ vortexInstalledFiles: [{ modId: 10, fileId: 101 }] });
    expect(
      deriveNexusResult({ ...base, explicitSelection: "20:200" }).value,
    ).toBe("20:200");
    expect(
      deriveNexusResult({ ...base, explicitSelection: "10:100" }).value,
    ).toBe("10:100");
    expect(deriveNexusResult({ ...base, explicitSelection: "" }).value).toBe(
      "",
    );
    expect(
      deriveNexusResult({ ...base, explicitSelection: "10:101" }).value,
    ).toBe("");
  });
  it("never defaults unknown coverage to downloading, while preserving exact inventory", () => {
    const result = deriveNexusResult(
      input({
        traversalComplete: false,
        vortexInstalledFiles: [{ modId: 10, fileId: 101 }],
      }),
    );
    expect(result.coverage).toBeNull();
    expect(result.value).toBe("");
    expect(result.recordedOptions.map((option) => option.value)).toEqual([
      "10:101",
    ]);
    expect(
      deriveNexusResult(
        input({ traversalComplete: false, explicitSelection: "20:200" }),
      ).value,
    ).toBe("20:200");
  });
  it("does not let a warning for an unrelated source invalidate this group", () => {
    const result = deriveNexusResult(
      input({
        skippedComponents: [
          { requiresAttention: true, nexusId: 999, reason: "Unreadable" },
        ] as NexusResultInput["skippedComponents"],
      }),
    );
    expect(result.sourceUnknown).toBe(false);
    expect(result.value).toBe("20:200");
  });
  it("keeps deployment proof distinct from coverage and missing dictionaries", () => {
    const result = deriveNexusResult(
      input({
        installedNexusTranslations: [
          {
            sourceNexusId: 1,
            modId: 10,
            fileId: 101,
            state: "missing_dictionary",
          },
        ],
      }),
    );
    expect(result.problem).toBe(true);
    expect(result.deployedEvidence).toEqual([]);
    expect(result.value).toBe("");
    expect(result.covered).toBe(false);
  });
  it("updates an archived installed version on its page using known metadata", () => {
    const base = input({ vortexInstalledFiles: [{ modId: 10, fileId: 100 }] });
    base.fileMetadata[10].files![0].category = "ARCHIVED";
    expect(deriveNexusResult(base).value).toBe("10:101");
    base.fileMetadata[10].files![0].uploadedAt = "2026-04-01";
    expect(deriveNexusResult(base).value).toBe("");
  });
  it("does not infer upgrades when the installed file is absent from metadata", () => {
    expect(
      deriveNexusResult(
        input({ vortexInstalledFiles: [{ modId: 10, fileId: 999 }] }),
      ).value,
    ).toBe("");
  });
});
