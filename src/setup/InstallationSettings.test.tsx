import { StrictMode, useState } from "react";
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
    "Choose Vortex.exe if it was not found automatically.",
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("prefills once in StrictMode without saving, launching, or changing the installation method", async () => {
  const values = props();
  invoke.mockResolvedValue("C:/Detected/Vortex.exe");
  function Harness() {
    const [executable, setExecutable] = useState<string | null>(null);
    return (
      <InstallationSettings
        {...values}
        executable={executable}
        onExecutableChange={setExecutable}
      />
    );
  }
  const view = render(
    <StrictMode>
      <Harness />
    </StrictMode>,
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Vortex executable")).toHaveValue(
      "C:/Detected/Vortex.exe",
    ),
  );
  expect(screen.queryByRole("status")).toBeNull();
  expect(
    screen.getByRole("button", { name: "Choose Vortex.exe" }),
  ).toBeEnabled();
  view.rerender(
    <StrictMode>
      <Harness />
    </StrictMode>,
  );
  fireEvent.focus(window);
  expect(invoke.mock.calls).toEqual([["detect_vortex_executable"]]);
  expect(values.onMethodChange).not.toHaveBeenCalled();
});

it.each(["manual", "inactive", "disabled", "configured"])(
  "does not detect while %s",
  async (state) => {
    const values = props();
    render(
      <InstallationSettings
        {...values}
        method={state === "manual" ? "folder" : "vortex"}
        active={state !== "inactive"}
        disabled={state === "disabled"}
        executable={state === "configured" ? "C:/Manual/Vortex.exe" : null}
      />,
    );
    await act(async () => {});
    expect(invoke).not.toHaveBeenCalled();
    expect(values.onExecutableChange).not.toHaveBeenCalled();
  },
);

it.each(["missing", "failure"])(
  "keeps Browse and fallback available after detection %s without retrying on rerender",
  async (outcome) => {
    const values = props();
    if (outcome === "missing") invoke.mockResolvedValue(null);
    else invoke.mockRejectedValue(new Error("private registry details"));
    const view = render(<InstallationSettings {...values} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledOnce());
    expect(screen.getByRole("status")).toHaveTextContent(
      "Choose Vortex.exe if it was not found automatically.",
    );
    expect(screen.queryByRole("alert")).toBeNull();
    view.rerender(<InstallationSettings {...values} />);
    fireEvent.focus(window);
    expect(invoke).toHaveBeenCalledOnce();
    expect(values.onExecutableChange).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Choose Vortex.exe" }),
    ).toBeEnabled();
  },
);

it.each(["detection-first", "picker-first", "picker-cancel"])(
  "lets Browse supersede a pending detector: %s",
  async (order) => {
    const detected = deferred<string | null>();
    const selected = deferred<string | null>();
    const values = props();
    invoke.mockImplementation((command) =>
      command === "detect_vortex_executable"
        ? detected.promise
        : selected.promise,
    );
    render(<InstallationSettings {...values} />);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("detect_vortex_executable"),
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Looking for Vortex.exe",
    );
    fireEvent.click(screen.getByRole("button", { name: "Choose Vortex.exe" }));
    if (order === "detection-first")
      await act(async () => detected.resolve("C:/Detected/Vortex.exe"));
    await act(async () =>
      selected.resolve(
        order === "picker-cancel" ? null : "C:/Manual/Vortex.exe",
      ),
    );
    if (order !== "detection-first")
      await act(async () => detected.resolve("C:/Detected/Vortex.exe"));
    expect(values.onExecutableChange.mock.calls).toEqual(
      order === "picker-cancel" ? [] : [["C:/Manual/Vortex.exe"]],
    );
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      "detect_vortex_executable",
      "pick_vortex_executable",
    ]);
  },
);

it.each(["unmount", "method", "page", "saving", "external-path"])(
  "ignores detection after %s and does not restart on return",
  async (change) => {
    const pending = deferred<string | null>();
    invoke.mockReturnValue(pending.promise);
    const values = props();
    const view = render(<InstallationSettings {...values} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledOnce());
    if (change === "unmount") view.unmount();
    else
      view.rerender(
        <InstallationSettings
          {...values}
          method={change === "method" ? "folder" : "vortex"}
          active={change !== "page"}
          disabled={change === "saving"}
          executable={change === "external-path" ? "C:/Other/Vortex.exe" : null}
        />,
      );
    await act(async () => pending.resolve("C:/Late/Vortex.exe"));
    expect(values.onExecutableChange).not.toHaveBeenCalled();
    if (change !== "unmount") {
      view.rerender(<InstallationSettings {...values} />);
      await act(async () => {});
      expect(invoke).toHaveBeenCalledOnce();
    }
  },
);

it("starts when the initially inactive Vortex page becomes active", async () => {
  const values = props();
  invoke.mockResolvedValue(null);
  const view = render(<InstallationSettings {...values} active={false} />);
  await act(async () => {});
  view.rerender(<InstallationSettings {...values} />);
  await waitFor(() => expect(invoke).toHaveBeenCalledOnce());
});

it("uses the existing compact settings rows with an accessible full path and no success paragraph", async () => {
  render(
    <InstallationSettings
      {...props()}
      compact
      executable="C:/Very long local installation folder/Vortex/Vortex.exe"
    />,
  );
  expect(screen.getByRole("region", { name: "Installation" })).toHaveClass(
    "translator-settings-group",
  );
  expect(screen.getByLabelText("Installation method")).toHaveClass(
    "translator-select",
  );
  expect(screen.getByLabelText("Vortex executable")).toHaveAttribute(
    "title",
    "C:/Very long local installation folder/Vortex/Vortex.exe",
  );
  expect(
    screen.getByRole("button", { name: "Choose Vortex.exe" }),
  ).toHaveTextContent("Change");
  expect(
    screen.queryByText(
      /This choice controls|Vortex uses its own Nexus account|Save to use/,
    ),
  ).toBeNull();
  expect(screen.queryByRole("status")).toBeNull();
  await act(async () => {});
  expect(invoke).not.toHaveBeenCalled();
});
