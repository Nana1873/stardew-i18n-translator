import { render, screen } from "@testing-library/react";
import { NexusAccountSummary } from "./NexusAccountSummary";
import type { NexusStatus } from "../tauri/commands";

it.each(["free", "premium", "unknown", "invalid", "error"] as const)(
  "shows observed account state %s without guessing membership",
  (accountStatus) => {
    render(
      <NexusAccountSummary
        status={{
          configured: true,
          validated: false,
          premium: false,
          accountStatus,
        }}
      />,
    );
    const labels = {
      free: "Free account",
      premium: "Premium account",
      unknown: "Account not checked",
      invalid: "Key not accepted",
      error: "Account check unavailable",
    };
    expect(screen.getByRole("status")).toHaveTextContent(labels[accountStatus]);
    expect(
      screen.getByText("API usage: Not reported by Nexus yet."),
    ).toBeInTheDocument();
  },
);

it("keeps missing quota values unknown and scopes independent including zero remaining", () => {
  const quota = {
    scope: "rest-v1" as const,
    observedAt: 0,
    hourlyLimit: null,
    hourlyRemaining: 0,
    hourlyReset: null,
    dailyLimit: 20,
    dailyRemaining: 12,
    dailyReset: "2026-09-07T00:00:00Z",
    retryAfterSeconds: null,
    blockedUntil: null,
  };
  const status: NexusStatus = {
    configured: true,
    premium: true,
    validated: true,
    quota: [
      quota,
      {
        ...quota,
        scope: "graphql-v2",
        dailyLimit: null,
        dailyRemaining: null,
        dailyReset: null,
        hourlyRemaining: null,
      },
    ],
  };
  render(<NexusAccountSummary status={status} />);
  const summary = screen.getByText(/^API requests left ·/);
  expect(summary).toHaveTextContent("Mod data: 12 daily, 0 hourly");
  expect(summary).not.toHaveTextContent("Translation search");
  const rest = screen.getByText("Mod data").parentElement!;
  const graph = screen.getByText("Translation search").parentElement!;
  expect(rest).toHaveTextContent("2026-09-07T00:00:00Z");
  expect(rest).toHaveTextContent("Observed");
  expect(graph).toHaveTextContent("Usage not reported");
  expect(graph).not.toHaveTextContent("2026-09-07T00:00:00Z");
});

it("shows sanitized account errors, including rate-limit guidance", () => {
  render(
    <NexusAccountSummary
      status={{
        configured: true,
        premium: false,
        validated: false,
        accountStatus: "error",
        error: "Nexus request limit reached. Retry later.",
      }}
    />,
  );
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Nexus request limit reached. Retry later.",
  );
});

it.each([
  { dailyLimit: 20 },
  { hourlyReset: "2026-09-07T00:00:00Z" },
  { retryAfterSeconds: 30 },
])("keeps remaining requests unknown with partial headers %j", (partial) => {
  render(
    <NexusAccountSummary
      status={{
        configured: true,
        validated: true,
        premium: false,
        quota: [
          {
            scope: "rest-v1",
            observedAt: 0,
            hourlyLimit: null,
            hourlyRemaining: null,
            hourlyReset: null,
            dailyLimit: null,
            dailyRemaining: null,
            dailyReset: null,
            retryAfterSeconds: null,
            blockedUntil: null,
            ...partial,
          },
        ],
      }}
    />,
  );
  const summary = screen.getByText(/^API requests left/);
  expect(summary).toHaveTextContent("Remaining requests not reported");
  expect(summary).not.toHaveTextContent(/0 (daily|hourly)/);
});
