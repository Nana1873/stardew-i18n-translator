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
import {
  InstallationSettings,
  installationMethodFor,
} from "./InstallationSettings";

beforeEach(() => {
  invoke.mockReset();
});

it("defaults new settings to manual and migrates only a nonblank legacy executable", () => {
  expect(installationMethodFor(null)).toBe("folder");
  expect(installationMethodFor({ vortexExecutable: "  " })).toBe("folder");
  expect(installationMethodFor({ vortexExecutable: "C:/Vortex.exe" })).toBe(
    "vortex",
  );
  expect(
    installationMethodFor({
      installationMethod: "folder",
      vortexExecutable: "C:/Vortex.exe",
    }),
  ).toBe("folder");
});

const props = () => ({
  method: "vortex" as const,
  onMethodChange: vi.fn(),
  executable: null,
  onExecutableChange: vi.fn(),
});

it("selects an executable without saving settings or launching Vortex", async () => {
  const values = props();
  invoke.mockResolvedValue("C:/Tools/Vortex.exe");
  render(<InstallationSettings {...values} />);
  expect(screen.getByRole("status")).toHaveTextContent(
    "continue working offline",
  );
  fireEvent.click(screen.getByRole("button", { name: "Choose Vortex.exe" }));
  await waitFor(() =>
    expect(values.onExecutableChange).toHaveBeenCalledWith(
      "C:/Tools/Vortex.exe",
    ),
  );
  expect(invoke.mock.calls.map(([cmd]) => cmd)).toEqual([
    "pick_vortex_executable",
  ]);
});

it.each(["cancel", "failure"])(
  "keeps the existing selection on picker %s",
  async (outcome) => {
    const values = props();
    if (outcome === "cancel") invoke.mockResolvedValue(null);
    else invoke.mockRejectedValue(new Error("private path"));
    render(<InstallationSettings {...values} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose Vortex.exe" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Choose Vortex.exe" }),
      ).toBeEnabled(),
    );
    expect(values.onExecutableChange).not.toHaveBeenCalled();
    if (outcome === "failure")
      expect(screen.getByRole("alert")).not.toHaveTextContent("private path");
  },
);

it.each(["unmount", "method", "page", "saving"])(
  "ignores a late picker result after %s",
  async (change) => {
    const values = props();
    let resolve!: (value: string) => void;
    invoke.mockReturnValue(
      new Promise<string>((done) => {
        resolve = done;
      }),
    );
    const view = render(<InstallationSettings {...values} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose Vortex.exe" }));
    if (change === "unmount") view.unmount();
    else
      view.rerender(
        <InstallationSettings
          {...values}
          method={change === "method" ? "folder" : "vortex"}
          active={change !== "page"}
          disabled={change === "saving"}
        />,
      );
    await act(async () => resolve("C:/Late/Vortex.exe"));
    expect(values.onExecutableChange).not.toHaveBeenCalled();
  },
);
