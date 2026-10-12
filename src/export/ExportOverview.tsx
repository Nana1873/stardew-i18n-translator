import { AlertTriangle } from "lucide-react";

/** A string an export or ZIP leaves out because of a game-breaking token
 * error. */
export interface LeftOutString {
  modUniqueId: string;
  modName: string;
  relativeDir: string;
  key: string;
  reason: string;
}

/** The counts both export dialogs open with, worded the same way. */
export function ExportCounts({
  included,
  untranslated,
  needsReview,
  keptOnPurpose,
  label,
}: {
  /** Null when the caller cannot count yet. */
  included: number | null;
  untranslated: number | null;
  needsReview: number | null;
  keptOnPurpose?: number | null;
  label: string;
}) {
  return (
    <div className="desktop-export-summary" aria-label={label}>
      <p>
        {included == null ? (
          "Count not available yet"
        ) : (
          <>
            <strong>{included}</strong>{" "}
            {included === 1 ? "translation" : "translations"} included
          </>
        )}
        {untranslated != null && untranslated > 0 && (
          <span>{untranslated} not translated yet</span>
        )}
      </p>
      {needsReview != null && needsReview > 0 && (
        <p className="desktop-export-review">
          <AlertTriangle aria-hidden="true" />
          Includes {needsReview}{" "}
          {needsReview === 1
            ? "translation that still needs"
            : "translations that still need"}{" "}
          review.
        </p>
      )}
      {keptOnPurpose != null && keptOnPurpose > 0 && (
        <p className="desktop-export-muted">
          Includes {keptOnPurpose} token{" "}
          {keptOnPurpose === 1 ? "difference" : "differences"} kept on purpose.
        </p>
      )}
    </div>
  );
}

/** Strings left out because of a token error, each with a way to open it.
 * Mod names show once per mod, and only when several mods are exported. */
export function LeftOutStrings<T extends LeftOutString>({
  problems,
  target,
  showModNames,
  onInspect,
  disabled = false,
}: {
  problems: T[];
  target: "export" | "ZIP";
  showModNames: boolean;
  onInspect?: (problem: T) => void;
  disabled?: boolean;
}) {
  if (problems.length === 0) return null;
  const one = problems.length === 1;
  const sorted = showModNames
    ? [...problems].sort((a, b) => a.modName.localeCompare(b.modName))
    : problems;
  return (
    <div className="desktop-export-left-out">
      <div className="translator-flow-callout is-warning">
        <strong>
          {problems.length} {one ? "string stays" : "strings stay"} in English:
        </strong>{" "}
        {one ? "it has" : "they have"} a token error that would break the game,
        so the {target} leaves {one ? "it" : "them"} out. Fix{" "}
        {one ? "it" : "them"} in the editor, or use Save anyway if the change is
        intended.
      </div>
      <ul
        className="translator-flow-list"
        aria-label={`Strings left out of the ${target}`}
      >
        {sorted.map((problem, index) => (
          <li
            key={`${problem.modUniqueId}:${problem.relativeDir}:${problem.key}`}
          >
            <span>
              {showModNames &&
                (index === 0 ||
                  sorted[index - 1].modUniqueId !== problem.modUniqueId) && (
                  <>
                    <strong>{problem.modName}</strong>
                    <br />
                  </>
                )}
              <code>{problem.key}</code> · {problem.reason}
            </span>
            {onInspect && (
              <button
                className="translator-button translator-button-quiet"
                type="button"
                onClick={() => onInspect(problem)}
                disabled={disabled}
              >
                Open issue
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
