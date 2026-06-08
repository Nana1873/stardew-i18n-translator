import { render, screen } from "@testing-library/react";
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
    { key: "greeting", source: "Hello", target: "Hallo" },
    { key: "bye", source: "Bye", target: "" },
  ]);
});

describe("StringTable", () => {
  it("loads and renders the mod's source/target strings", async () => {
    render(<StringTable mod={MOD} />);

    expect(await screen.findByText("greeting")).toBeInTheDocument();
    expect(screen.getByText("Hello")).toBeInTheDocument();
    expect(screen.getByText("Hallo")).toBeInTheDocument();
    // Untranslated target shows a dash placeholder.
    expect(screen.getByText("bye")).toBeInTheDocument();

    expect(invokeMock).toHaveBeenCalledWith("load_strings", {
      defaultPath: "x/i18n/default.json",
      targetPath: "x/i18n/de.json",
    });
  });
});
