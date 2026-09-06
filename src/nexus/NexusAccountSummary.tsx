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
  return (
    <div className="nexus-account-summary">
      <p role="status">
        {label}
        {status?.configured ? " · Key saved" : ""}
      </p>
      {(kind === "error" || kind === "invalid") && status?.error && (
        <p role="alert">{status.error}</p>
      )}
    </div>
  );
}

export function NexusQuotaSummary({ status }: { status: NexusStatus | null }) {
  const quota = status?.quota ?? [];
  const scopeLabel = (scope: string) =>
    scope === "rest-v1" ? "Mod data" : "Translation search";
  const remaining = quota
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
    .join(" · ");
  const detail = quota
    .map((item) =>
      [
        scopeLabel(item.scope),
        `Observed ${new Date(item.observedAt).toLocaleString()}`,
        item.dailyLimit != null ? `Daily limit ${item.dailyLimit}` : "",
        item.hourlyLimit != null ? `Hourly limit ${item.hourlyLimit}` : "",
        item.dailyReset ? `Daily reset ${item.dailyReset}` : "",
        item.hourlyReset ? `Hourly reset ${item.hourlyReset}` : "",
        item.retryAfterSeconds != null
          ? `Retry after ${item.retryAfterSeconds}s`
          : "",
        item.blockedUntil != null
          ? `Retry at ${new Date(item.blockedUntil).toLocaleString()}`
          : "",
      ]
        .filter(Boolean)
        .join(" · "),
    )
    .join("; ");
  return (
    <small title={detail || undefined}>
      {remaining
        ? `API requests left · ${remaining}`
        : "API requests left: Not reported"}
    </small>
  );
}
