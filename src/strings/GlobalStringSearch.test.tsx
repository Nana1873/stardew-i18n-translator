import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import type { ScannedMod } from "../tauri/commands";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));

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
    scrollToIndex: () => {},
  }),
}));

import { GlobalStringSearch } from "./GlobalStringSearch";

const MODS: ScannedMod[] = [
  {
    uniqueId: "first.mod",
    name: "First Mod",
    version: "1.0",
    nexusId: null,
    packageId: "First Mod",
    folderPath: "x/first",
    i18nFiles: [
      {
        relativeDir: "i18n",
        defaultPath: "x/first/i18n/default.json",
        targetPath: "x/first/i18n/de.json",
        targetExists: true,
        totalKeys: 1,
        translatedKeys: 1,
        reviewNeeded: 0,
      },
    ],
    totalKeys: 1,
    translatedKeys: 1,
    reviewNeeded: 0,
    progress: 1,
    status: "translated",
  },
  {
    uniqueId: "second.mod",
    name: "Second Mod",
    version: "1.0",
    nexusId: null,
    packageId: "Second Mod",
    folderPath: "x/second",
    i18nFiles: [
      {
        relativeDir: "i18n/dialogue",
        defaultPath: "x/second/i18n/dialogue/default.json",
        targetPath: "x/second/i18n/dialogue/de.json",
        targetExists: true,
        totalKeys: 1,
        translatedKeys: 1,
        reviewNeeded: 0,
      },
    ],
    totalKeys: 1,
    translatedKeys: 1,
    reviewNeeded: 0,
    progress: 1,
    status: "translated",
  },
];

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd: string, args?: unknown) => {
    if (cmd !== "load_strings") return Promise.resolve(null);
    const modUniqueId = (args as { modUniqueId: string }).modUniqueId;
    return Promise.resolve(
      modUniqueId === "first.mod"
        ? [
            {
              key: "greeting",
              source: "Hello farmer",
              target: "Hallo Farmer",
              targetPresent: true,
              status: "translated",
            },
          ]
        : [
            {
              key: "farewell",
              source: "See you tomorrow",
              target: "Bis morgen",
              targetPresent: true,
              status: "translated",
            },
          ],
    );
  });
});

describe("GlobalStringSearch", () => {
  it("searches every mod in the shared workbench with passive mod metadata", async () => {
    const onOpenMod = vi.fn();
    render(
      <GlobalStringSearch mods={MODS} query="morgen" onOpenMod={onOpenMod} />,
    );

    expect(await screen.findByText("farewell")).toBeInTheDocument();
    const modLabel = screen.getByText("Second Mod");
    expect(screen.queryByText("greeting")).toBeNull();

    expect(screen.getByRole("columnheader", { name: /Mod/ })).toBeVisible();
    expect(
      screen.queryByRole("columnheader", { name: /File/ }),
    ).not.toBeInTheDocument();
    fireEvent.click(modLabel);
    expect(modLabel.closest(".stringrow--data")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(onOpenMod).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(
        invokeMock.mock.calls.filter(([cmd]) => cmd === "load_strings"),
      ).toHaveLength(2),
    );
  });

  it("matches keys and original text as well as translations", async () => {
    const { rerender } = render(
      <GlobalStringSearch mods={MODS} query="greeting" onOpenMod={() => {}} />,
    );
    expect(await screen.findByText("Hello farmer")).toBeInTheDocument();

    rerender(
      <GlobalStringSearch mods={MODS} query="tomorrow" onOpenMod={() => {}} />,
    );
    expect(await screen.findByText("farewell")).toBeInTheDocument();
  });
});
