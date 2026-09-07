import type {
  InstalledNexusTranslation,
  VortexInstalledFile,
  ScannedMod,
  SkippedComponent,
} from "../tauri/commands";
import {
  nexusSourceDiskCoverage,
  nexusSourceScanIncomplete,
  translationFileOptions,
} from "./resolveTranslation";
import type { NexusFiles } from "./useNexusFiles";
import type { NexusSearchEntry } from "./useNexusSearch";

export function nexusCandidates(entry: NexusSearchEntry) {
  return [...(entry.result?.candidates ?? [])].sort(
    (a, b) =>
      Number(a.relationshipTier !== "possible-original-translation") -
        Number(b.relationshipTier !== "possible-original-translation") ||
      b.updatedAt.localeCompare(a.updatedAt),
  );
}

export interface NexusResultInput {
  entry: NexusSearchEntry;
  mods: ScannedMod[];
  skippedComponents: SkippedComponent[];
  traversalComplete: boolean;
  nexusIdentityIncomplete: boolean;
  isVortex: boolean;
  installedNexusTranslations: InstalledNexusTranslation[];
  vortexInstalledFiles: VortexInstalledFile[];
  fileMetadata: Record<number, NexusFiles>;
  targetLang: string;
  allowArchives: boolean;
  explicitSelection?: string;
}

/** One metadata selection for both the result card and the batch queue. */
export function deriveNexusResult(input: NexusResultInput) {
  const {
    entry,
    mods,
    skippedComponents,
    traversalComplete,
    nexusIdentityIncomplete,
    isVortex,
    fileMetadata,
    targetLang,
    allowArchives,
    explicitSelection,
  } = input;
  const sourceUnknown = nexusSourceScanIncomplete(
    mods,
    entry.modId,
    skippedComponents,
    traversalComplete,
    nexusIdentityIncomplete,
  );
  const coverage = nexusSourceDiskCoverage(
    mods,
    entry.modId,
    skippedComponents,
    traversalComplete,
    nexusIdentityIncomplete,
  );
  const candidates = nexusCandidates(entry);
  // Exact inventory is useful even when the scan cannot prove source coverage.
  const inventory = isVortex
    ? input.vortexInstalledFiles.filter((item) =>
        candidates.some((candidate) => candidate.modId === item.modId),
      )
    : [];
  const evidence =
    isVortex && !sourceUnknown
      ? input.installedNexusTranslations.filter(
          (item) => item.sourceNexusId === entry.modId,
        )
      : [];
  const installed = [...evidence, ...inventory];
  const allOptions = candidates.flatMap((candidate) =>
    translationFileOptions(
      fileMetadata[candidate.modId]?.files ?? [],
      targetLang,
      allowArchives ? "vortex" : "review",
    ).map((file) => ({
      candidate,
      file,
      value: `${candidate.modId}:${file.fileId}`,
    })),
  );
  const recordedOptions = allOptions.filter((option) =>
    installed.some(
      (item) =>
        item.modId === option.candidate.modId &&
        item.fileId === option.file.fileId,
    ),
  );
  const unavailableCandidates = candidates
    .filter(
      (candidate) =>
        !allOptions.some(
          (option) => option.candidate.modId === candidate.modId,
        ),
    )
    .map((candidate) => {
      const metadata = fileMetadata[candidate.modId];
      const files = metadata?.files ?? [];
      const reason = !metadata
        ? "Loading file details…"
        : metadata.error
          ? "File details unavailable. Retry metadata refresh."
          : !files.length
            ? "No files returned by Nexus."
            : !allowArchives &&
                files.every(
                  (file) => !file.fileName.toLowerCase().endsWith(".zip"),
                )
              ? "No ZIP available. Direct import supports ZIP archives."
              : `No current ${allowArchives ? "archive" : "ZIP"} matches the selected language.`;
      return { candidate, reason };
    });
  const options = allOptions.filter(
    (option) => !recordedOptions.includes(option),
  );
  const explicit = allOptions.find(
    (option) => option.value === explicitSelection,
  );
  const installedPages = new Set(installed.map((item) => item.modId));
  const preferredPool = explicit
    ? allOptions.filter(
        (option) => option.candidate.modId === explicit.candidate.modId,
      )
    : installedPages.size
      ? allOptions.filter((option) =>
          installedPages.has(option.candidate.modId),
        )
      : allOptions;
  const preferred = [...preferredPool].sort(
    (a, b) =>
      Number(a.candidate.relationshipTier !== "possible-original-translation") -
        Number(
          b.candidate.relationshipTier !== "possible-original-translation",
        ) ||
      (Date.parse(b.file.uploadedAt) || 0) -
        (Date.parse(a.file.uploadedAt) || 0) ||
      b.file.fileId - a.file.fileId,
  )[0];
  // Missing installed metadata cannot establish an upgrade; never pick an older fallback.
  const installedUnknown = installed.some((item) => {
    const known = fileMetadata[item.modId]?.files?.find(
      (file) => file.fileId === item.fileId,
    );
    if (!known) return true;
    if (preferred?.candidate.modId !== item.modId) return false;
    const installedDate = Date.parse(known.uploadedAt);
    const preferredDate = Date.parse(preferred.file.uploadedAt);
    return (
      !Number.isFinite(installedDate) ||
      !Number.isFinite(preferredDate) ||
      installedDate > preferredDate ||
      (installedDate === preferredDate && known.fileId > preferred.file.fileId)
    );
  });
  const value =
    explicitSelection !== undefined
      ? options.some((option) => option.value === explicitSelection)
        ? explicitSelection
        : ""
      : sourceUnknown || installedUnknown
        ? ""
        : options.some((option) => option.value === preferred?.value)
          ? preferred!.value
          : "";
  return {
    entry,
    sourceUnknown,
    coverage,
    covered: coverage?.complete ?? false,
    candidates,
    inventory,
    evidence,
    installed,
    deployedEvidence: evidence.filter(
      (item) => item.state === undefined || item.state === "deployed",
    ),
    problem: evidence.some((item) => item.state === "missing_dictionary"),
    allOptions,
    recordedOptions,
    unavailableCandidates,
    options,
    preferred,
    value,
    selected: options.find((option) => option.value === value),
    loading: candidates.some((candidate) => !fileMetadata[candidate.modId]),
    errors: candidates.flatMap((candidate) =>
      fileMetadata[candidate.modId]?.error
        ? [`${candidate.name}: ${fileMetadata[candidate.modId].error}`]
        : [],
    ),
  };
}
