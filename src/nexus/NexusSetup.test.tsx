import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";
const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));
import { NexusSetup } from "./NexusSetup";
beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue({ configured: true, premium: true });
});

it("shows optional setup without reading a secret and tests only on explicit action", async () => {
  render(<NexusSetup searchOnScan={false} onSearchOnScanChange={() => {}} />);
  await screen.findByText(/NEXUS_API_KEY configured/);
  expect(invoke).toHaveBeenCalledWith("nexus_status", { forceRefresh: false });
  expect(screen.getByLabelText("Nexus API key")).toHaveAttribute(
    "type",
    "password",
  );
  expect(screen.getByLabelText(/Search Nexus/)).not.toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "Test existing key" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("nexus_status", { forceRefresh: true }),
  );
});

it("clears a synthetic key after validation and never writes it into settings", async () => {
  const onChange = vi.fn();
  render(<NexusSetup searchOnScan={false} onSearchOnScanChange={onChange} />);
  fireEvent.change(screen.getByLabelText("Nexus API key"), {
    target: { value: "synthetic-test-key" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Validate and save key" }),
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Nexus API key")).toHaveValue(""),
  );
  expect(invoke).toHaveBeenCalledWith("nexus_save_key", {
    key: "synthetic-test-key",
  });
  expect(onChange).not.toHaveBeenCalled();
  expect(invoke.mock.calls.some(([name]) => name === "save_settings")).toBe(
    false,
  );
});

it("does not echo credential-bearing failures", async () => {
  invoke.mockImplementation((cmd: string) =>
    cmd === "nexus_save_key"
      ? Promise.reject(new Error("synthetic-secret"))
      : Promise.resolve({ configured: false, premium: false }),
  );
  render(<NexusSetup searchOnScan={false} onSearchOnScanChange={() => {}} />);
  fireEvent.change(screen.getByLabelText("Nexus API key"), {
    target: { value: "synthetic-secret" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Validate and save key" }),
  );
  expect(await screen.findByRole("alert")).not.toHaveTextContent(
    "synthetic-secret",
  );
});

it("chooses the validated Vortex executable without launching or saving it", async () => {
  const change = vi.fn();
  invoke.mockImplementation((cmd: string) =>
    Promise.resolve(
      cmd === "pick_vortex_executable"
        ? "C:/Tools/Vortex/Vortex.exe"
        : { configured: false, premium: false },
    ),
  );
  render(
    <NexusSetup
      searchOnScan={false}
      onSearchOnScanChange={() => {}}
      onVortexExecutableChange={change}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Choose Vortex.exe" }));
  await waitFor(() =>
    expect(change).toHaveBeenCalledWith("C:/Tools/Vortex/Vortex.exe"),
  );
  expect(
    invoke.mock.calls.some(([cmd]) => /handoff|save_settings/.test(cmd)),
  ).toBe(false);
});
