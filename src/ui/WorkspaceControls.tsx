import { CircleAlert, TriangleAlert } from "lucide-react";
import type { StringTableFilter } from "../strings/StringTable";
import type { Severity } from "../strings/validation";

// Workspace status controls and activity feedback.
export function DesktopFilters({
  status,
  items,
  issues,
  issueCount,
  onStatus,
  onIssues,
  onHelp,
  onHideHelp,
}: {
  status: StringTableFilter;
  items: Array<{ value: StringTableFilter; label: string; count: number }>;
  issues: boolean;
  issueCount: number;
  onStatus: (status: StringTableFilter) => void;
  onIssues: (issues: boolean) => void;
  onHelp?: (target: HTMLElement, status: StringTableFilter | "issues") => void;
  onHideHelp?: () => void;
}) {
  return (
    <div className="desktop-filters" aria-label="String filters">
      <div
        className="desktop-status-labels"
        role="group"
        aria-label="String view"
      >
        {items.map((item) => (
          <button
            key={item.value}
            className="desktop-filter-action desktop-task-label"
            type="button"
            aria-label={item.label + " " + item.count}
            aria-pressed={!issues && status === item.value}
            data-status={item.value}
            onFocus={(event) => onHelp?.(event.currentTarget, item.value)}
            onBlur={onHideHelp}
            onPointerEnter={(event) =>
              onHelp?.(event.currentTarget, item.value)
            }
            onPointerLeave={onHideHelp}
            onClick={() => onStatus(item.value)}
          >
            {item.label}{" "}
            <span className="desktop-filter-count">{item.count}</span>
          </button>
        ))}
        <button
          className="desktop-filter-action desktop-task-label desktop-issues"
          type="button"
          aria-pressed={issues}
          aria-label={`Issues ${issueCount}`}
          disabled={!issues && issueCount === 0}
          data-status="issues"
          onFocus={(event) => onHelp?.(event.currentTarget, "issues")}
          onBlur={onHideHelp}
          onPointerEnter={(event) => onHelp?.(event.currentTarget, "issues")}
          onPointerLeave={onHideHelp}
          onClick={() => onIssues(true)}
        >
          <CircleAlert aria-hidden /> Issues
          <span className="desktop-filter-count">{issueCount}</span>
        </button>
      </div>
    </div>
  );
}

export function ValidationIcon({ severity }: { severity: Severity }) {
  const Icon = severity === "warning" ? TriangleAlert : CircleAlert;
  return <Icon className="desktop-validation-icon" aria-hidden />;
}

export function FileActionLabel({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <>
      <span className="desktop-export-copy">
        <span className="desktop-export-title">{title}</span>
        {description && (
          <span className="desktop-export-description">{description}</span>
        )}
      </span>
    </>
  );
}

export { ActivityLog } from "./ActivityLog";
