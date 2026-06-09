import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));

// jsdom has no layout, so the real virtualizer renders nothing — return a fixed
// window of items so the rendering logic is exercised.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: () => ({
    getTotalSize: () => 60,
    getVirtualItems: () => [
      { key: 0, index: 0, start: 0, size: 30 },
      { key: 1, index: 1, start: 30, size: 30 },
    ],
  }),
}));

import { StringTable } from "./StringTable";
import type { ScannedMod } from "../tauri/commands";

const MOD: ScannedMod = {
  uniqueId: "a.b",
  name: "Test Mod",
  version: "1.0",
  nexusId: null,
  packageId: "Test Mod",
  folderPath: "x",
  i18nFiles: [
    {
      relativeDir: "i18n",
      defaultPath: "x/i18n/default.json",
      targetPath: "x/i18n/de.json",
      targetExists: true,
      totalKeys: 2,
      translatedKeys: 1,
    },
  ],
  totalKeys: 2,
  translatedKeys: 1,
  progress: 0.5,
  status: "untranslated",
};

function mockStrings(
  rows: Array<{ key: string; source: string; target: string; targetPresent?: boolean; status?: string }>,
) {
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "load_strings") {
      return Promise.resolve(
        rows.map((r) => ({
          targetPresent: false,
          status: r.target ? "translated" : "untranslated",
          ...r,
        })),
      );
    }
    return Promise.resolve(undefined); // save_string
  });
}

beforeEach(() => {
  invokeMock.mockReset();
  mockStrings([
    { key: "greeting", source: "Hello", target: "Hallo", targetPresent: true },
    { key: "bye", source: "Bye", target: "" },
  ]);
});

describe("StringTable", () => {
  it("loads the mod's strings via load_strings and renders them", async () => {
    render(<StringTable mod={MOD} />);

    expect(await screen.findByText("greeting")).toBeInTheDocument();
    expect(screen.getByText("Hello")).toBeInTheDocument();
    expect(screen.getByText("Hallo")).toBeInTheDocument();

    expect(invokeMock).toHaveBeenCalledWith("load_strings", {
      modUniqueId: "a.b",
      relativeDir: "i18n",
      defaultPath: "x/i18n/default.json",
      targetPath: "x/i18n/de.json",
    });
  });

  it("persists an edit via save_string (status done) on Save", async () => {
    render(<StringTable mod={MOD} />);
    fireEvent.doubleClick(await screen.findByText("greeting"));

    fireEvent.change(screen.getByLabelText("Translation"), {
      target: { value: "Hallo Welt" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("save_string", {
        modUniqueId: "a.b",
        relativeDir: "i18n",
        key: "greeting",
        target: "Hallo Welt",
        status: "translated",
        source: "Hello",
      }),
    );
  });

  it("Reset clears the field and saves the string as untranslated", async () => {
    render(<StringTable mod={MOD} />);
    fireEvent.doubleClick(await screen.findByText("greeting"));

    const textarea = screen.getByLabelText("Translation") as HTMLTextAreaElement;
    expect(textarea.value).toBe("Hallo");

    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(textarea.value).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "save_string",
        expect.objectContaining({ key: "greeting", target: "", status: "untranslated" }),
      ),
    );
  });

  it("shows a validation error icon when a source token is missing", async () => {
    mockStrings([
      { key: "greet", source: "Hi {{name}}", target: "Hallo", targetPresent: true },
      { key: "ok", source: "Yes", target: "Ja", targetPresent: true },
    ]);
    render(<StringTable mod={MOD} />);

    expect(await screen.findByTitle("Missing token {{name}}")).toBeInTheDocument();
  });

  it("inserts a protected token at the cursor when its chip is clicked", async () => {
    mockStrings([
      { key: "g", source: "Hi {{name}}", target: "" },
      { key: "ok", source: "Yes", target: "" },
    ]);
    render(<StringTable mod={MOD} />);

    fireEvent.doubleClick(await screen.findByText("g"));
    const textarea = screen.getByLabelText("Translation") as HTMLTextAreaElement;
    expect(textarea.value).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "{{name}}" }));
    expect(textarea.value).toBe("{{name}}");
  });

  it("filters rows by search text across key/original/target", async () => {
    render(<StringTable mod={MOD} search="bye" statusFilter="all" />);

    expect(await screen.findByText("bye")).toBeInTheDocument();
    expect(screen.queryByText("greeting")).not.toBeInTheDocument();
  });

  it("filters rows by status", async () => {
    render(<StringTable mod={MOD} search="" statusFilter="untranslated" />);

    // Only the untranslated row ("bye", empty target) remains.
    expect(await screen.findByText("bye")).toBeInTheDocument();
    expect(screen.queryByText("greeting")).not.toBeInTheDocument();
  });

  it("shows an empty hint when nothing matches the filter", async () => {
    render(<StringTable mod={MOD} search="zzz-no-match" statusFilter="all" />);

    expect(
      await screen.findByText("No strings match the current filter."),
    ).toBeInTheDocument();
  });

  it("right-click → Mark as not translatable persists the status", async () => {
    render(<StringTable mod={MOD} />);
    fireEvent.contextMenu(await screen.findByText("greeting"));

    fireEvent.click(screen.getByRole("menuitem", { name: "Mark as not translatable" }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "save_string",
        expect.objectContaining({ key: "greeting", status: "not-translatable" }),
      ),
    );
  });
});
