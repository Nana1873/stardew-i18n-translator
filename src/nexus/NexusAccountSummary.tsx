import type { NexusStatus } from "../tauri/commands";

export function nexusAccountKind(status: NexusStatus | null) {
  if (!status) return "unknown";
  return (
    status.accountStatus ??
    (!status.configured
      ? "unconfigured"
      : !status.validated
        ? "unknown"
        : status.premium
          ? "premium"
          : "free")
  );
}
function observedAt(value: number) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString()
    : "Unknown time";
}
function allowance(remaining: number | null, limit: number | null) {
  if (remaining == null)
    return limit == null ? "Not reported" : `Not reported (limit ${limit})`;
  return `${remaining}${limit == null ? "" : ` of ${limit}`} remaining`;
}
const scopeLabel = (scope: string) =>
  scope === "rest-v1" ? "Mod data" : "Translation search";
export function NexusAccountSummary({
  status,
}: {
  status: NexusStatus | null;
}) {
  const kind = nexusAccountKind(status);
  const label = {
    unconfigured: "Not connected",
    unknown: "Account not checked",
    premium: "Premium account",
    free: "Free account",
    invalid: "Key not accepted",
    error: "Account check unavailable",
  }[kind];
  const quota = status?.quota ?? [];
  const reported = quota.some(
    (item) =>
      item.hourlyRemaining != null ||
      item.hourlyLimit != null ||
      item.dailyRemaining != null ||
      item.dailyLimit != null ||
      item.hourlyReset ||
      item.dailyReset ||
      item.retryAfterSeconds != null ||
      item.blockedUntil != null,
  );
  return (
    <div className="nexus-account-summary">
      <p role="status">
        {label}
        {status?.configured ? " · Key saved" : ""}
        {status?.checkedAt != null
          ? ` · Checked ${observedAt(status.checkedAt)}`
          : ""}
      </p>
      {(kind === "error" || kind === "invalid") && status?.error && (
        <p role="alert">{status.error}</p>
      )}
      {reported ? (
        <details>
          <summary>
            API requests left ·{" "}
            {quota
              .flatMap((item) => {
                const values = [
                  item.dailyRemaining != null
                    ? `${item.dailyRemaining.toLocaleString()} daily`
                    : "",
                  item.hourlyRemaining != null
                    ? `${item.hourlyRemaining.toLocaleString()} hourly`
                    : "",
                ].filter(Boolean);
                return values.length
                  ? [`${scopeLabel(item.scope)}: ${values.join(", ")}`]
                  : [];
              })
              .join(" · ") || "Remaining requests not reported"}
          </summary>
          {quota.map((item) => (
            <p key={item.scope}>
              <strong>{scopeLabel(item.scope)}</strong>
              {item.dailyRemaining == null &&
                item.dailyLimit == null &&
                item.hourlyRemaining == null &&
                item.hourlyLimit == null && <> · Usage not reported</>}{" "}
              {(item.dailyRemaining != null ||
                item.dailyLimit != null ||
                item.hourlyRemaining != null ||
                item.hourlyLimit != null) && (
                <>
                  · Daily: {allowance(item.dailyRemaining, item.dailyLimit)} ·
                  Hourly: {allowance(item.hourlyRemaining, item.hourlyLimit)}
                </>
              )}{" "}
              · Observed {observedAt(item.observedAt)}
              {item.dailyReset && <> · Daily reset: {item.dailyReset}</>}
              {item.hourlyReset && <> · Hourly reset: {item.hourlyReset}</>}
              {item.retryAfterSeconds != null && (
                <> · Retry after {item.retryAfterSeconds}s</>
              )}
              {item.blockedUntil != null && (
                <> · Retry at {observedAt(item.blockedUntil)}</>
              )}
            </p>
          ))}
          <small>
            Values last reported by Nexus; other apps may also use your account
            allowance.
          </small>
        </details>
      ) : (
        <small>API usage: Not reported by Nexus yet.</small>
      )}
    </div>
  );
}
