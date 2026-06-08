import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));

import { App } from "./App";

const CONFIGURED = {
  stardewPath: "E:/SDV",
  modsPath: "E:/SDV/Mods",
  sourceLang: "default",
  targetLang: "de",
};

beforeEach(() => {
  invokeMock.mockReset();
});

describe("App shell", () => {
  it("renders the toolbar and two-panel layout", async () => {
    invokeMock.mockResolvedValue(CONFIGURED);
    render(<App />);

    expect(screen.getByText("Stardew i18n Translator")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Mod list" })).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "String table" }),
    ).toBeInTheDocument();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Scan" })).toBeEnabled(),
    );
    expect(
      screen.queryByRole("dialog", { name: "Setup" }),
    ).not.toBeInTheDocument();
  });

  it("opens the setup wizard on first launch (no saved Stardew path)", async () => {
    invokeMock.mockResolvedValue({
      stardewPath: null,
      modsPath: null,
      sourceLang: "default",
      targetLang: null,
    });
    render(<App />);

    expect(
      await screen.findByRole("dialog", { name: "Setup" }),
    ).toBeInTheDocument();
  });

  it("scans and shows the discovered mods", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
      if (cmd === "scan_mods")
        return Promise.resolve({
          mods: [
            {
              uniqueId: "a.b",
              name: "Test Mod",
              version: "1.0",
              nexusId: 7286,
              packageId: "Test Mod",
              folderPath: "E:/SDV/Mods/Test Mod",
              i18nFiles: [
                {
                  relativeDir: "i18n",
                  defaultPath: "x/i18n/default.json",
                  targetPath: "x/i18n/de.json",
                  targetExists: false,
                  totalKeys: 5,
                  translatedKeys: 0,
                },
              ],
              totalKeys: 5,
              translatedKeys: 0,
              progress: 0,
              status: "untranslated",
            },
          ],
          warnings: [],
          modCount: 1,
          fileCount: 1,
        });
      return Promise.resolve(null);
    });

    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Scan" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Scan" }));

    expect(await screen.findByText("Test Mod")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "7286" })).toBeInTheDocument();
  });
});
