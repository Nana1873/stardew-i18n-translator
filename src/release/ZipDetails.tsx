import { AlertTriangle } from "lucide-react";
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
    <p className="desktop-zip-hint" id={descriptionId}>
      Original mod: <code>Mods/{relativeFolder}</code>
    </p>
  );
}

export function remainingZipWarnings(preview: ZipPreview | null): string[] {
  return (preview?.warnings ?? []).filter(
    (warning) =>
      !preview?.entries.some(
        (entry) =>
          warning ===
            `${entry.modName} contains ${entry.outdated} outdated translation(s).` ||
          warning ===
            `${entry.modName} contains ${entry.reviewNeeded} unreviewed AI suggestion(s).`,
      ),
  );
}

export function ZipSummary({ preview }: { preview: ZipPreview }) {
  const needsReview = preview.entries.reduce(
    (sum, entry) => sum + entry.reviewNeeded + entry.outdated,
    0,
  );
  const omitted = Math.max(
    0,
    preview.totalSourceStrings - preview.totalStrings,
  );
  return (
    <div className="desktop-zip-summary" aria-label="ZIP contents">
      <p>
        <strong>{preview.totalStrings}</strong> of {preview.totalSourceStrings}{" "}
        translations included
        {omitted > 0 && <span>{omitted} not included</span>}
      </p>
      {needsReview > 0 && (
        <p className="desktop-zip-review">
          <AlertTriangle aria-hidden="true" />
          Includes {needsReview}{" "}
          {needsReview === 1
            ? "translation that still needs"
            : "translations that still need"}{" "}
          review.
        </p>
      )}
      {preview.entries.length === 0 && (
        <p className="desktop-zip-empty">
          No translated files are ready to export.
        </p>
      )}
    </div>
  );
}
