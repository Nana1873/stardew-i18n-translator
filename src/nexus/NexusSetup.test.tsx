import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { vi } from "vitest";
const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));
import { NexusSetup } from "./NexusSetup";
beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue({
    configured: true,
    premium: false,
    validated: false,
    accountStatus: "unknown",
    quota: [],
  });
});

it("shows a saved connection without an empty key field or automatic validation", async () => {
  render(<NexusSetup />);
  await screen.findByText(/Account not checked · Key saved/);
  expect(invoke).toHaveBeenCalledWith("nexus_status", { forceRefresh: false });
  expect(screen.queryByLabelText("Nexus API key")).not.toBeInTheDocument();
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /Test/ }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Refresh account" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("nexus_status", { forceRefresh: true }),
  );
});

it("reveals Replace key only on demand and clears it after connection", async () => {
  const onKeySaved = vi.fn();
  render(<NexusSetup onKeySaved={onKeySaved} />);
  fireEvent.click(await screen.findByRole("button", { name: "Replace key" }));
  fireEvent.change(screen.getByLabelText("Nexus API key"), {
    target: { value: "synthetic-test-key" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Connect key" }));
  await waitFor(() =>
    expect(screen.queryByLabelText("Nexus API key")).not.toBeInTheDocument(),
  );
  expect(invoke).toHaveBeenCalledWith("nexus_save_key", {
    key: "synthetic-test-key",
  });
  expect(onKeySaved).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Replace key" }));
  expect(screen.getByLabelText("Nexus API key")).toHaveValue("");
  expect(invoke.mock.calls.some(([name]) => name === "save_settings")).toBe(
    false,
  );
});

it("does not echo credential-bearing failures", async () => {
  invoke.mockImplementation((cmd: string) =>
    cmd === "nexus_save_key"
      ? Promise.reject(new Error("synthetic-secret"))
      : Promise.resolve({
          configured: false,
          premium: false,
          validated: false,
        }),
  );
  render(<NexusSetup />);
  fireEvent.click(await screen.findByRole("button", { name: "Connect Nexus" }));
  fireEvent.change(screen.getByLabelText("Nexus API key"), {
    target: { value: "synthetic-secret" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Connect key" }));
  expect(await screen.findByRole("alert")).not.toHaveTextContent(
    "synthetic-secret",
  );
});

it("ignores an initial local snapshot arriving after a successful connection", async () => {
  let resolveInitial!: (value: unknown) => void;
  invoke.mockImplementation((cmd: string) =>
    cmd === "nexus_status"
      ? new Promise((resolve) => {
          resolveInitial = resolve;
        })
      : Promise.resolve({
          configured: true,
          validated: true,
          premium: true,
          accountStatus: "premium",
        }),
  );
  render(<NexusSetup />);
  fireEvent.click(screen.getByRole("button", { name: "Connect Nexus" }));
  fireEvent.change(screen.getByLabelText("Nexus API key"), {
    target: { value: "synthetic-key" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Connect key" }));
  await screen.findByText(/^Premium account/);
  await act(async () =>
    resolveInitial({ configured: false, validated: false, premium: false }),
  );
  expect(screen.getByText(/^Premium account/)).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Replace key" }),
  ).toBeInTheDocument();
});
