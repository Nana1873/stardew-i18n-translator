import { render, screen } from "@testing-library/react";
import { NexusAccountSummary, NexusQuotaSummary } from "./NexusAccountSummary";
import type { NexusQuota } from "../tauri/commands";
const quota: NexusQuota = {
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
};
it.each(["free", "premium", "unknown", "invalid", "error"] as const)(
  "shows the reported account state %s",
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
  },
);
it("shows actionable sanitized status errors", () => {
  render(
    <NexusAccountSummary
      status={{
        configured: true,
        validated: false,
        premium: false,
        accountStatus: "invalid",
        error: "Key rejected. Enter a valid key.",
      }}
    />,
  );
  expect(screen.getByRole("alert")).toHaveTextContent("Key rejected");
});
it.each([
  {},
  { dailyLimit: 20 },
  { hourlyReset: "2026-09-07T00:00:00Z" },
  { retryAfterSeconds: 30 },
])(
  "keeps absent remaining values unknown with partial headers %j",
  (partial) => {
    const { container } = render(
      <NexusQuotaSummary
        status={{
          configured: true,
          validated: true,
          premium: true,
          quota: [{ ...quota, ...partial }],
        }}
      />,
    );
    expect(
      screen.getByText("API requests left: Not reported"),
    ).toBeInTheDocument();
    expect(container.querySelector("details, summary")).toBeNull();
  },
);
it("keeps reported zero distinct from unknown and preserves API scopes", () => {
  render(
    <NexusQuotaSummary
      status={{
        configured: true,
        validated: true,
        premium: true,
        quota: [
          {
            ...quota,
            dailyRemaining: 0,
            dailyLimit: 20,
            dailyReset: "2026-09-07T00:00:00Z",
          },
          { ...quota, scope: "graphql-v2", hourlyRemaining: 12 },
        ],
      }}
    />,
  );
  const text = screen.getByText(/^API requests left \|/);
  expect(text).toHaveTextContent(
    "Mod data: 0 daily | Translation search: 12 hourly",
  );
  expect(text).not.toHaveTextContent("Daily limit");
  expect(text).toHaveAttribute(
    "title",
    expect.stringContaining("Daily limit 20"),
  );
  expect(text).toHaveAttribute(
    "title",
    expect.stringContaining("2026-09-07T00:00:00Z"),
  );
});

it.each(["rest-v1", "graphql-v2"] as const)(
  "omits visible scope labels when only %s reports remaining values",
  (scope) => {
    render(
      <NexusQuotaSummary
        status={{
          configured: true,
          validated: true,
          premium: true,
          quota: [
            { ...quota, scope, dailyRemaining: 19833, hourlyRemaining: 1988 },
            { ...quota, scope: scope === "rest-v1" ? "graphql-v2" : "rest-v1" },
          ],
        }}
      />,
    );
    const text = screen.getByText(/^API requests left \|/);
    expect(text.textContent).toBe(
      `API requests left | ${(19833).toLocaleString()} daily | ${(1988).toLocaleString()} hourly`,
    );
    expect(text).toHaveAttribute(
      "title",
      expect.stringContaining(
        scope === "rest-v1" ? "Mod data" : "Translation search",
      ),
    );
  },
);
