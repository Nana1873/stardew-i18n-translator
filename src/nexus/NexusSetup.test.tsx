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
import { NexusSetup, useNexusSetup } from "./NexusSetup";
function Harness() {
  const connection = useNexusSetup();
  return (
    <>
      <NexusSetup connection={connection} />
      <button onClick={() => void connection.save()}>Save</button>
    </>
  );
}
beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue({
    configured: true,
    premium: false,
    validated: false,
    accountStatus: "unknown",
  });
});

it("keeps a saved key as an empty password field with a mask placeholder and never submits the mask", async () => {
  render(<Harness />);
  await screen.findByText(/Key saved/);
  const input = screen.getByLabelText("Nexus API key");
  expect(input).toHaveAttribute("type", "password");
  expect(input).toHaveAttribute("placeholder", "••••••••");
  expect(input).toHaveValue("");
  expect(
    screen.queryByRole("button", { name: /Replace|Refresh|Connect/ }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await act(async () => {});
  expect(invoke.mock.calls).toEqual([
    ["nexus_status", { forceRefresh: false }],
  ]);
});

it("validates only a typed key on save and clears the input", async () => {
  render(<Harness />);
  fireEvent.change(screen.getByLabelText("Nexus API key"), {
    target: { value: "synthetic-key" },
  });
  expect(invoke.mock.calls.some(([cmd]) => cmd === "nexus_save_key")).toBe(
    false,
  );
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(screen.getByLabelText("Nexus API key")).toHaveValue(""),
  );
  expect(invoke).toHaveBeenCalledWith("nexus_save_key", {
    key: "synthetic-key",
  });
});

it("preserves saved status and does not echo credential-bearing save failures", async () => {
  invoke.mockImplementation((cmd: string) =>
    cmd === "nexus_save_key"
      ? Promise.reject(new Error("synthetic-key"))
      : Promise.resolve({ configured: true, validated: true, premium: true }),
  );
  render(<Harness />);
  await screen.findByText(/Premium account/);
  fireEvent.change(screen.getByLabelText("Nexus API key"), {
    target: { value: "synthetic-key" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).not.toHaveTextContent(
    "synthetic-key",
  );
  expect(screen.getByText(/Premium account/)).toBeInTheDocument();
});

it("discards the initial local snapshot after saving a new key", async () => {
  let resolveInitial!: (value: unknown) => void;
  invoke.mockImplementation((cmd: string) =>
    cmd === "nexus_status"
      ? new Promise((resolve) => {
          resolveInitial = resolve;
        })
      : Promise.resolve({ configured: true, validated: true, premium: true }),
  );
  render(<Harness />);
  fireEvent.change(screen.getByLabelText("Nexus API key"), {
    target: { value: "synthetic-key" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText(/Premium account/);
  await act(async () =>
    resolveInitial({ configured: false, validated: false, premium: false }),
  );
  expect(screen.getByText(/Premium account/)).toBeInTheDocument();
});
