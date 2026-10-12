import { useState, type ReactNode } from "react";
import { CircleAlert, X } from "lucide-react";
import "./exportDialog.css";

/** A string an export or ZIP leaves out because of a game-breaking token
 * error. */
export interface LeftOutString {
  modUniqueId: string;
  modName: string;
  relativeDir: string;
  key: string;
  reason: string;
}

/** Shared header of the JSON and ZIP export dialogs: one fixed title and a
 * "<subject> · <language>" subtitle. */
export function ExportDialogHead({
  titleId,
  subject,
  language,
  closeLabel,
  closeDisabled = false,
  onClose,
}: {
  titleId: string;
  subject: string;
  language?: string | null;
  closeLabel: string;
  closeDisabled?: boolean;
  onClose: () => void;
}) {
  return (
    <div className="desktop-xd-head">
      <div>
        <h2 className="desktop-xd-title" id={titleId}>
          Export translations
        </h2>
        <p className="desktop-xd-subtitle">
          {subject}
          {language && <> · {language}</>}
        </p>
      </div>
      <button
        className="translator-icon-button"
        type="button"
        aria-label={closeLabel}
        onClick={onClose}
        disabled={closeDisabled}
      >
        <X aria-hidden="true" />
      </button>
    </div>
  );
}

/** The counts both export dialogs open with, as compact stat tiles. */
export function ExportCounts({
  included,
  untranslated,
  leftOut = 0,
  needsReview,
  keptOnPurpose,
  label,
}: {
  /** Null when the caller cannot count yet. */
  included: number | null;
  untranslated: number | null;
  leftOut?: number;
  needsReview: number | null;
  keptOnPurpose?: number | null;
  label: string;
}) {
  return (
    <div className="desktop-xd-stats-block">
      <div className="desktop-xd-stats" aria-label={label}>
        <div className="desktop-xd-stat is-primary">
          <strong>{included ?? "–"}</strong>{" "}
          <span>
            {included == null
              ? "Count not available yet"
              : included === 1
                ? "translation included"
                : "translations included"}
          </span>
        </div>
        {leftOut > 0 && (
          <div className="desktop-xd-stat is-danger">
            <strong>{leftOut}</strong> <span>left out</span>
          </div>
        )}
        {untranslated != null && untranslated > 0 && (
          <div className="desktop-xd-stat">
            <strong>{untranslated}</strong> <span>not translated yet</span>
          </div>
        )}
      </div>
      {((needsReview != null && needsReview > 0) ||
        (keptOnPurpose != null && keptOnPurpose > 0)) && (
        <p className="desktop-xd-note">
          {needsReview != null && needsReview > 0 && (
            <>
              Includes {needsReview}{" "}
              {needsReview === 1
                ? "translation that still needs"
                : "translations that still need"}{" "}
              review.
            </>
          )}
          {needsReview != null &&
            needsReview > 0 &&
            keptOnPurpose != null &&
            keptOnPurpose > 0 &&
            " "}
          {keptOnPurpose != null && keptOnPurpose > 0 && (
            <>
              Includes {keptOnPurpose} token{" "}
              {keptOnPurpose === 1 ? "difference" : "differences"} kept on
              purpose.
            </>
          )}
        </p>
      )}
    </div>
  );
}

const LEFT_OUT_VISIBLE = 3;

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
  const [showAll, setShowAll] = useState(false);
  if (problems.length === 0) return null;
  const one = problems.length === 1;
  const sorted = showModNames
    ? [...problems].sort((a, b) => a.modName.localeCompare(b.modName))
    : problems;
  const visible = showAll ? sorted : sorted.slice(0, LEFT_OUT_VISIBLE);
  return (
    <div className="desktop-xd-leftout">
      <div className="desktop-xd-leftout-head">
        <CircleAlert aria-hidden="true" />
        <p>
          <strong>
            {problems.length} {one ? "string stays" : "strings stay"} in English
          </strong>
          <span>
            Token errors that would break the game. Fix {one ? "it" : "them"} in
            the editor, or use Save anyway.
          </span>
        </p>
      </div>
      <ul aria-label={`Strings left out of the ${target}`}>
        {visible.map((problem, index) => (
          <li
            key={`${problem.modUniqueId}:${problem.relativeDir}:${problem.key}`}
          >
            {showModNames &&
              (index === 0 ||
                visible[index - 1].modUniqueId !== problem.modUniqueId) && (
                <span className="desktop-xd-leftout-mod">
                  {problem.modName}
                </span>
              )}
            <div className="desktop-xd-leftout-row">
              <code>{problem.key}</code>
              <span
                className="desktop-xd-leftout-reason"
                title={problem.reason}
              >
                {problem.reason}
              </span>
              {onInspect && (
                <button
                  className="desktop-xd-link"
                  type="button"
                  aria-label={`Open ${problem.key}`}
                  onClick={() => onInspect(problem)}
                  disabled={disabled}
                >
                  Open
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {problems.length > LEFT_OUT_VISIBLE && (
        <button
          className="desktop-xd-link desktop-xd-leftout-more"
          type="button"
          onClick={() => setShowAll((value) => !value)}
        >
          {showAll ? "Show fewer" : `Show all (${problems.length})`}
        </button>
      )}
    </div>
  );
}

/** A collapsible section with a one-line summary shown next to its title. */
export function ExportSection({
  title,
  summary,
  summaryId,
  defaultOpen = false,
  children,
}: {
  title: string;
  summary?: ReactNode;
  summaryId?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <details className="desktop-xd-section" open={defaultOpen || undefined}>
      <summary>
        <span className="desktop-xd-section-title">{title}</span>
        {summary != null && (
          <span className="desktop-xd-section-summary" id={summaryId}>
            {summary}
          </span>
        )}
      </summary>
      <div className="desktop-xd-section-body">{children}</div>
    </details>
  );
}
