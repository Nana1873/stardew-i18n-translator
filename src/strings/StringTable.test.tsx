import { render, screen, fireEvent } from "@testing-library/react";
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

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue([
    { key: "greeting", source: "Hello", target: "Hallo", targetPresent: true },
    { key: "bye", source: "Bye", target: "", targetPresent: false },
  ]);
});

describe("StringTable", () => {
  it("loads and renders the mod's source/target strings", async () => {
    render(<StringTable mod={MOD} edits={{}} onSaveEdit={() => {}} />);

    expect(await screen.findByText("greeting")).toBeInTheDocument();
    expect(screen.getByText("Hello")).toBeInTheDocument();
    expect(screen.getByText("Hallo")).toBeInTheDocument();
    expect(screen.getByText("bye")).toBeInTheDocument();

    expect(invokeMock).toHaveBeenCalledWith("load_strings", {
      defaultPath: "x/i18n/default.json",
      targetPath: "x/i18n/de.json",
    });
  });

  it("opens the editor on double-click and saves the edited target", async () => {
    const onSaveEdit = vi.fn();
    render(<StringTable mod={MOD} edits={{}} onSaveEdit={onSaveEdit} />);

    const keyCell = await screen.findByText("greeting");
    fireEvent.doubleClick(keyCell);

    const dialog = screen.getByRole("dialog", { name: "Edit string" });
    expect(dialog).toBeInTheDocument();

    const textarea = screen.getByLabelText("Translation");
    fireEvent.change(textarea, { target: { value: "Hallo Welt" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSaveEdit).toHaveBeenCalledWith("i18n", "greeting", "Hallo Welt");
  });

  it("shows a validation error icon when a source token is missing", async () => {
    invokeMock.mockResolvedValue([
      { key: "greet", source: "Hi {{name}}", target: "Hallo", targetPresent: true },
      { key: "ok", source: "Yes", target: "Ja", targetPresent: true },
    ]);
    render(<StringTable mod={MOD} edits={{}} onSaveEdit={() => {}} />);

    expect(
      await screen.findByTitle("Missing token {{name}}"),
    ).toBeInTheDocument();
  });

  it("inserts a protected token at the cursor when its chip is clicked", async () => {
    invokeMock.mockResolvedValue([
      { key: "g", source: "Hi {{name}}", target: "", targetPresent: false },
      { key: "ok", source: "Yes", target: "", targetPresent: false },
    ]);
    render(<StringTable mod={MOD} edits={{}} onSaveEdit={() => {}} />);

    fireEvent.doubleClick(await screen.findByText("g"));
    const textarea = screen.getByLabelText("Translation") as HTMLTextAreaElement;
    expect(textarea.value).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "{{name}}" }));
    expect(textarea.value).toBe("{{name}}");
  });
});
