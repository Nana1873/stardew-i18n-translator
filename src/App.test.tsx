import { StrictMode } from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));

// jsdom has no layout — the real virtualizer measures 0px forever. Render
// every item instead (same mock as StringTable.test).
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 30,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        key: index,
        index,
        start: index * 30,
        size: 30,
      })),
    measure: () => {},
  }),
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

const EMPTY_SCAN = {
  mods: [],
  warnings: [],
  modCount: 0,
  fileCount: 0,
};

function mockConfigured(scanResult: unknown = EMPTY_SCAN) {
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
    if (cmd === "scan_mods") return Promise.resolve(scanResult);
    if (cmd === "load_glossary") return Promise.resolve(null);
    return Promise.resolve(null);
  });
}

describe("App shell", () => {
  it("renders the toolbar and the dashboard landing", async () => {
    mockConfigured();
    render(<App />);

    // The nav toggle is labelled with its destination (work view from here).
    expect(
      screen.getByRole("button", { name: /Mod list/ }),
    ).toBeInTheDocument();
    // Landing screen is the dashboard (SPEC §7.0 rollout ④), not the panels.
    expect(screen.getByRole("main", { name: "Dashboard" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Mod list" })).toBeNull();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Scan" })).toBeEnabled(),
    );
    expect(
      screen.queryByRole("dialog", { name: "Setup" }),
    ).not.toBeInTheDocument();
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("scan_mods", {
        modsPath: "E:/SDV/Mods",
        targetLang: "de",
      }),
    );
    expect(screen.queryByRole("dialog", { name: "Scan" })).toBeNull();
  });

  it("starts only one automatic scan under React StrictMode", async () => {
    mockConfigured();
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("scan_mods", {
        modsPath: "E:/SDV/Mods",
        targetLang: "de",
      }),
    );
    expect(
      invokeMock.mock.calls.filter(([cmd]) => cmd === "scan_mods"),
    ).toHaveLength(1);
  });

  it("the nav toggle switches views and renames to its destination", async () => {
    mockConfigured();
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: /Mod list/ }));
    expect(
      await screen.findByRole("region", { name: "Mod list" }),
    ).toBeInTheDocument();

    // In the work view the same button now offers the way back.
    fireEvent.click(screen.getByRole("button", { name: /Dashboard/ }));
    expect(
      await screen.findByRole("main", { name: "Dashboard" }),
    ).toBeInTheDocument();
  });

  it("opens the setup wizard on first launch (no saved Stardew path)", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_settings")
        return Promise.resolve({
          stardewPath: null,
          modsPath: null,
          sourceLang: "default",
          targetLang: null,
        });
      if (cmd === "load_glossary") return Promise.resolve(null);
      return Promise.resolve(null);
    });
    render(<App />);

    expect(
      await screen.findByRole("dialog", { name: "Setup" }),
    ).toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalledWith("scan_mods", expect.anything());
  });

  it("automatically scans and shows discovered mods on configured startup", async () => {
    mockConfigured({
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
              reviewNeeded: 2,
            },
          ],
          totalKeys: 5,
          translatedKeys: 0,
          reviewNeeded: 2,
          progress: 0,
          status: "untranslated",
        },
      ],
      warnings: [],
      modCount: 1,
      fileCount: 1,
    });

    render(<App />);

    // The dashboard reflects the scan (queue + toolbar pill)…
    expect(await screen.findByText(/1 mods scanned/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /2 to review/ }),
    ).toBeInTheDocument();

    // …and Browse switches into the work view with the mod list.
    fireEvent.click(screen.getByRole("button", { name: /Browse all mods/ }));
    expect(await screen.findByText("Test Mod")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "7286" })).toBeInTheDocument();
  });

  it("the dashboard review queue jumps into the mod filtered to review-needed", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
      if (cmd === "scan_mods")
        return Promise.resolve({
          mods: [
            {
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
                  totalKeys: 1,
                  translatedKeys: 1,
                  reviewNeeded: 1,
                },
              ],
              totalKeys: 1,
              translatedKeys: 1,
              reviewNeeded: 1,
              progress: 1,
              status: "translated",
            },
          ],
          warnings: [],
          modCount: 1,
          fileCount: 1,
        });
      if (cmd === "load_strings")
        return Promise.resolve([
          {
            key: "greeting",
            source: "Hello",
            target: "Hallo KI",
            targetPresent: true,
            status: "review-needed",
          },
        ]);
      return Promise.resolve(null);
    });

    render(<App />);

    // The queue lists the mod; clicking it opens the work view on its
    // review backlog (status filter pre-set to review-needed).
    fireEvent.click(await screen.findByRole("button", { name: /Test Mod/ }));
    expect(
      await screen.findByRole("region", { name: "String table" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("Hallo KI")).toBeInTheDocument();
  });

  it("opens the scan dialog when an automatic scan has warnings", async () => {
    mockConfigured({
      ...EMPTY_SCAN,
      warnings: ["Skipped broken manifest"],
    });
    render(<App />);

    expect(
      await screen.findByRole("dialog", { name: "Scan" }),
    ).toHaveTextContent("Skipped broken manifest");
  });

  it("opens the scan dialog when an automatic scan fails", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
      if (cmd === "scan_mods") return Promise.reject("Mods folder not found");
      if (cmd === "load_glossary") return Promise.resolve(null);
      return Promise.resolve(null);
    });
    render(<App />);

    expect(
      await screen.findByRole("dialog", { name: "Scan" }),
    ).toHaveTextContent("Mods folder not found");
  });

  it("keeps the progress dialog for a manual re-scan", async () => {
    let finishScan: (result: typeof EMPTY_SCAN) => void = () => {};
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
      if (cmd === "load_glossary") return Promise.resolve(null);
      if (cmd === "scan_mods")
        return new Promise((resolve) => {
          finishScan = resolve;
        });
      return Promise.resolve(null);
    });
    render(<App />);

    // Finish the silent startup scan first.
    await waitFor(() =>
      expect(
        invokeMock.mock.calls.filter(([cmd]) => cmd === "scan_mods"),
      ).toHaveLength(1),
    );
    finishScan(EMPTY_SCAN);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Scan" })).toBeEnabled(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Scan" }));
    expect(
      await screen.findByRole("dialog", { name: "Scan" }),
    ).toHaveTextContent("Scanning mods");
    finishScan(EMPTY_SCAN);
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Scan" })).toBeNull(),
    );
  });
});
