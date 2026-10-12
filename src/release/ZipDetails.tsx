import { ExportCounts } from "../export/ExportOverview";
import type { ZipPreview } from "../tauri/commands";

export function ZipSourcePath({
  path,
  modsPath,
  installFolder,
  descriptionId,
}: {
  path?: string;
  modsPath?: string;
  installFolder: string;
  descriptionId: string;
}) {
  const originalPath = path?.replaceAll("\\", "/");
  const modsRoot = modsPath?.replaceAll("\\", "/").replace(/\/+$/, "");
  const relativeFolder =
    originalPath &&
    modsRoot &&
    originalPath.toLowerCase().startsWith(`${modsRoot.toLowerCase()}/`)
      ? originalPath.slice(modsRoot.length + 1)
      : installFolder;
  return (
    <p className="desktop-xd-hint" id={descriptionId}>
      Original mod: <code>Mods/{relativeFolder}</code>
    </p>
  );
}

/** Mirrors the per-mod ZIP warnings in release_zip.rs. */
export function outdatedZipWarning(modName: string, count: number) {
  return `${modName} has ${count} ${count === 1 ? "translation" : "translations"} to check after English changes.`;
}

export function reviewZipWarning(modName: string, count: number) {
  return `${modName} has ${count} AI ${count === 1 ? "suggestion" : "suggestions"} not reviewed yet.`;
}

export function remainingZipWarnings(preview: ZipPreview | null): string[] {
  return (preview?.warnings ?? []).filter(
    (warning) =>
      !preview?.entries.some(
        (entry) =>
          warning === outdatedZipWarning(entry.modName, entry.outdated) ||
          warning === reviewZipWarning(entry.modName, entry.reviewNeeded),
      ),
  );
}

export function ZipSummary({
  preview,
  untranslated,
  leftOut = 0,
}: {
  preview: ZipPreview;
  untranslated: number | null;
  leftOut?: number;
}) {
  const needsReview = preview.entries.reduce(
    (sum, entry) => sum + entry.reviewNeeded + entry.outdated,
    0,
  );
  return (
    <>
      <ExportCounts
        label="ZIP contents"
        included={preview.totalStrings}
        untranslated={untranslated}
        leftOut={leftOut}
        needsReview={needsReview}
      />
      {preview.entries.length === 0 && (
        <p className="desktop-xd-note">
          No translated files are ready to export.
        </p>
      )}
    </>
  );
}
