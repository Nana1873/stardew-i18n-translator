import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { vi } from "vitest";

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

import {
  StringTable,
  StringTableHeader,
  type BulkChangeSnapshot,
} from "./StringTable";
import type { ScannedMod } from "../tauri/commands";

const MOD: ScannedMod = {
  uniqueId: "a.b",
  name: "Test Mod",
  version: "1.0",
  nexusId: null,
  packageId: "Test Package",
  folderPath: "x",
  i18nFiles: [
    {
      relativeDir: "i18n",
      defaultPath: "x/i18n/default.json",
      targetPath: "x/i18n/de.json",
      targetExists: true,
      totalKeys: 3,
      translatedKeys: 1,
      reviewNeeded: 0,
    },
  ],
  totalKeys: 3,
  translatedKeys: 1,
  reviewNeeded: 0,
  progress: 1 / 3,
  status: "untranslated",
};

const OTHER_MOD: ScannedMod = {
  ...MOD,
  uniqueId: "c.d",
  name: "Other Mod",
  packageId: "Other Package",
  folderPath: "y",
  i18nFiles: [
    {
      relativeDir: "i18n/dialogue",
      defaultPath: "y/i18n/dialogue/default.json",
      targetPath: "y/i18n/dialogue/de.json",
      targetExists: true,
      totalKeys: 1,
      translatedKeys: 0,
      reviewNeeded: 0,
    },
  ],
  totalKeys: 1,
  translatedKeys: 0,
  progress: 0,
};

const ROWS = {
  "a.b": [
    {
      key: "greeting",
      source: "Hello",
      target: "Hallo",
      targetPresent: true,
      status: "translated",
      tokenMismatchAccepted: false,
    },
    {
      key: "bye",
      source: "Bye",
      target: "",
      targetPresent: false,
      status: "untranslated",
      tokenMismatchAccepted: false,
    },
    {
      key: "token",
      source: "Hi {{name}}",
      target: "Hallo",
      targetPresent: true,
      status: "outdated",
      tokenMismatchAccepted: false,
      section: "Dialogue",
    },
  ],
  "c.d": [
    {
      key: "tomorrow",
      source: "See you tomorrow",
      target: "",
      targetPresent: false,
      status: "untranslated",
      tokenMismatchAccepted: false,
    },
  ],
} as const;

function installBackendRows(
  overrides?: Partial<Record<"a.b" | "c.d", readonly unknown[]>>,
) {
  invokeMock.mockImplementation((cmd: string, args?: unknown) => {
    if (cmd === "load_strings") {
      const id = (args as { modUniqueId: "a.b" | "c.d" }).modUniqueId;
      return Promise.resolve(overrides?.[id] ?? ROWS[id]);
    }
    return Promise.resolve(undefined);
  });
}

function dataRows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".stringrow--data"));
}

function rowFor(text: string): HTMLElement {
  const node = screen.getByText(text);
  const row = node.closest<HTMLElement>(".stringrow--data");
  if (!row) throw new Error("No row for " + text);
  return row;
}

beforeEach(() => {
  invokeMock.mockReset();
  installBackendRows();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

describe("StringTable V3 workbench", () => {
  it("loads only real selected-mod files and renders accepted V3 controls", async () => {
    render(<StringTable mod={MOD} />);

    expect(await screen.findByText("greeting")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "This mod" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "All mods" })).toBeEnabled();
    expect(
      screen.getByRole("checkbox", { name: "Select all visible strings" }),
    ).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith("load_strings", {
      modUniqueId: "a.b",
      relativeDir: "i18n",
      defaultPath: "x/i18n/default.json",
      targetPath: "x/i18n/de.json",
    });
  });

  it("uses the accepted direct grid geometry without the legacy footer column", async () => {
    const { container } = render(
      <StringTable mod={MOD} targetLanguageLabel="German (de)" />,
    );
    await screen.findByText("greeting");

    const header = container.querySelector<HTMLElement>(
      ".stv3-string-table-head",
    );
    expect(header).toHaveStyle({
      gridTemplateColumns: "34px 102px 250px 360px minmax(180px, 1fr)",
      columnGap: "0",
      padding: "0",
    });
    expect(dataRows()[0]).toHaveStyle({
      gridTemplateColumns: "34px 102px 250px 360px minmax(180px, 1fr)",
    });
    expect(
      screen
        .getByRole("button", { name: "Key" })
        .closest("[role=columnheader]"),
    ).toHaveStyle({
      height: "27px",
      display: "flex",
      alignItems: "center",
      padding: "0 8px",
    });
    expect(
      screen.getByRole("columnheader", { name: /German translation/ }),
    ).toBeVisible();
    expect(
      screen.queryByRole("separator", { name: "Resize mod column" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("separator", { name: "Resize file column" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("separator", { name: "Resize status column" }),
    ).not.toBeInTheDocument();
    for (const name of [
      "Resize key column",
      "Resize English source column",
      "Resize German translation column",
    ]) {
      expect(screen.getByRole("separator", { name })).toBeVisible();
    }
    expect(container.querySelector(".stv3-table-foot")).toBeNull();
  });

  it("marks the compact toolbar while batch selection controls are visible", async () => {
    const { container } = render(<StringTable mod={MOD} />);
    await screen.findByText("greeting");

    const toolbar = container.querySelector(".stv3-string-toolbar");
    expect(toolbar).not.toHaveClass("is-selection-active");

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select all visible strings" }),
    );
    expect(toolbar).toHaveClass("is-selection-active");

    fireEvent.click(
      screen.getByRole("button", { name: "Clear selected strings" }),
    );
    expect(toolbar).not.toHaveClass("is-selection-active");
  });

  it("switches scope through a controlled prop callback", async () => {
    const onScopeChange = vi.fn();
    render(
      <StringTable
        mod={MOD}
        mods={[MOD, OTHER_MOD]}
        scope="mod"
        onScopeChange={onScopeChange}
      />,
    );
    await screen.findByText("greeting");

    fireEvent.click(screen.getByRole("button", { name: "All mods" }));
    expect(onScopeChange).toHaveBeenCalledWith("all");
  });

  it("renders the complete V3 heading from real package, language, and progress data", async () => {
    render(
      <StringTable
        mod={MOD}
        targetLanguageLabel="German (de)"
        headerMeta="scanned just now"
      />,
    );
    await screen.findByText("greeting");

    expect(
      screen.getByRole("heading", { name: /Test Package.*Test Mod/ }),
    ).toBeVisible();
    expect(screen.getByText("German (de)")).toBeVisible();
    expect(screen.getByText("2 / 3 translated · 67%")).toBeVisible();
    expect(screen.getByText("scanned just now")).toBeVisible();
  });

  it("loads every real mod in all-mod scope and hides a redundant File column", async () => {
    const onOpenMod = vi.fn();
    render(
      <StringTable
        mod={MOD}
        mods={[MOD, OTHER_MOD]}
        scope="all"
        onOpenMod={onOpenMod}
      />,
    );

    expect(await screen.findByText("tomorrow")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /Mod/ })).toBeVisible();
    expect(
      screen.queryByRole("columnheader", { name: /File/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Open Other Mod" }),
    ).not.toBeInTheDocument();
    const otherModCell = screen.getByText("Other Mod");
    fireEvent.click(otherModCell);
    expect(rowFor("tomorrow")).toHaveAttribute("aria-selected", "true");
    fireEvent.click(otherModCell, { ctrlKey: true });
    expect(rowFor("tomorrow")).toHaveAttribute("aria-selected", "false");
    expect(onOpenMod).not.toHaveBeenCalled();
    expect(
      invokeMock.mock.calls.filter(([cmd]) => cmd === "load_strings"),
    ).toHaveLength(2);
  });

  it("filters by search, explicit statuses, and validation issues using real rows", async () => {
    installBackendRows({
      "a.b": [
        ...ROWS["a.b"],
        {
          key: "review",
          source: "Review me",
          target: "Prüfen",
          targetPresent: true,
          status: "review-needed",
          tokenMismatchAccepted: false,
        },
      ],
    });
    render(<StringTable mod={MOD} />);
    await screen.findByText("greeting");
    expect(
      screen.queryByRole("button", { name: /^Needs attention/ }),
    ).not.toBeInTheDocument();

    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search strings" }),
      {
        target: { value: "bye" },
      },
    );
    expect(screen.getByText("bye")).toBeVisible();
    expect(screen.queryByText("greeting")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    fireEvent.click(screen.getByRole("button", { name: /^Changed/ }));
    expect(screen.getByText("token")).toBeVisible();
    expect(screen.queryByText("bye")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Review/ }));
    expect(screen.getByText("review")).toBeVisible();
    expect(screen.queryByText("token")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^All \d/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Validation issues/ }));
    expect(screen.getByText("token")).toBeVisible();
    expect(screen.queryByText("greeting")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "All mods" }));
    expect(
      screen.queryByRole("button", { name: /^Needs attention/ }),
    ).not.toBeInTheDocument();
  });

  it("searches and marks real mod and file metadata only in All mods", async () => {
    render(
      <StringTable
        mod={MOD}
        mods={[MOD, OTHER_MOD]}
        scope="all"
        onOpenMod={() => {}}
      />,
    );
    await screen.findByText("tomorrow");
    const search = screen.getByRole("searchbox", { name: "Search strings" });

    fireEvent.change(search, { target: { value: "Other Mod" } });

    expect(screen.getByText("tomorrow")).toBeVisible();
    expect(screen.queryByText("greeting")).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "Search preview: 1 matching rows · 4 strings in All mods",
      ),
    ).toBeVisible();
    const modCell = rowFor("tomorrow").querySelector(
      '.stv3-global-mod-col[data-search-field="mod"]',
    );
    expect(modCell).toHaveClass("is-search-match");
    expect(modCell).toHaveAttribute("aria-description", "Search match in Mod.");

    expect(
      screen.queryByRole("columnheader", { name: /File/ }),
    ).not.toBeInTheDocument();
  });

  it("searches and marks File metadata when all-mod scope has multi-component mods", async () => {
    const secondFile = {
      ...MOD.i18nFiles[0],
      relativeDir: "assets/i18n",
      defaultPath: "x/assets/i18n/default.json",
      targetPath: "x/assets/i18n/de.json",
      totalKeys: 1,
      translatedKeys: 0,
    };
    const multiMod: ScannedMod = {
      ...MOD,
      i18nFiles: [MOD.i18nFiles[0], secondFile],
      totalKeys: 4,
    };
    invokeMock.mockImplementation((cmd: string, args?: unknown) => {
      if (cmd !== "load_strings") return Promise.resolve(undefined);
      const relativeDir = (args as { relativeDir: string }).relativeDir;
      return Promise.resolve(
        relativeDir === "assets/i18n"
          ? [
              {
                key: "asset-key",
                source: "Asset source",
                target: "",
                targetPresent: false,
                status: "untranslated",
                tokenMismatchAccepted: false,
              },
            ]
          : ROWS["a.b"],
      );
    });
    render(<StringTable mod={multiMod} mods={[multiMod]} scope="all" />);
    await screen.findByText("asset-key");

    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search strings" }),
      { target: { value: "assets/i18n" } },
    );

    const fileCell = rowFor("asset-key").querySelector(
      '.stv3-file-col[data-search-field="file"]',
    );
    expect(fileCell).toHaveClass("is-search-match");
    expect(fileCell).toHaveAttribute(
      "aria-description",
      "Search match in File.",
    );
  });

  it("adds native titles only while real cell content is ellipsized", async () => {
    const secondFile = {
      ...MOD.i18nFiles[0],
      relativeDir: "assets/i18n",
      defaultPath: "x/assets/i18n/default.json",
      targetPath: "x/assets/i18n/de.json",
    };
    const multiMod: ScannedMod = {
      ...MOD,
      i18nFiles: [MOD.i18nFiles[0], secondFile],
    };
    invokeMock.mockImplementation((cmd: string, args?: unknown) => {
      if (cmd !== "load_strings") return Promise.resolve(undefined);
      return Promise.resolve(
        (args as { relativeDir: string }).relativeDir === "i18n"
          ? ROWS["a.b"]
          : [],
      );
    });
    render(<StringTable mod={multiMod} mods={[multiMod]} scope="all" />);
    await screen.findByText("greeting");
    const row = rowFor("greeting");
    const modText = row.querySelector<HTMLElement>(".stv3-global-mod-text");
    const fileText = row.querySelector<HTMLElement>(
      ".stv3-file-col .stv3-cell-clip",
    );
    const keyText = screen.getByRole("button", { name: "greeting" });
    const sourceText = row.querySelector<HTMLElement>(
      ".stv3-source-col .stv3-cell-clip",
    );
    const targetText = row.querySelector<HTMLElement>(
      ".stv3-translation-col .stv3-cell-clip",
    );
    if (!modText || !fileText || !sourceText || !targetText) {
      throw new Error("Missing overflow test cell");
    }
    const dimensions = (
      node: HTMLElement,
      clientWidth: number,
      scrollWidth: number,
    ) => {
      Object.defineProperty(node, "clientWidth", {
        configurable: true,
        value: clientWidth,
      });
      Object.defineProperty(node, "scrollWidth", {
        configurable: true,
        value: scrollWidth,
      });
    };
    for (const node of [modText, fileText, keyText, sourceText]) {
      dimensions(node, 40, 100);
    }
    dimensions(targetText, 100, 40);
    fireEvent.resize(window);

    await waitFor(() => expect(modText).toHaveAttribute("title", "Test Mod"));
    expect(fileText).toHaveAttribute("title", "i18n");
    expect(keyText).toHaveAttribute("title", "greeting");
    expect(sourceText).toHaveAttribute("title", "Hello");
    expect(targetText).not.toHaveAttribute("title");

    dimensions(keyText, 100, 40);
    fireEvent.resize(window);
    await waitFor(() => expect(keyText).not.toHaveAttribute("title"));
  });

  it("uses the real target language in translation search descriptions", async () => {
    render(<StringTable mod={MOD} targetLanguageLabel="French (fr)" />);
    await screen.findByText("greeting");

    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search strings" }),
      { target: { value: "Hallo" } },
    );

    const targetCell = rowFor("greeting").querySelector(
      '[data-search-field="translation"]',
    );
    expect(targetCell).toHaveAttribute(
      "aria-description",
      "Search match in French translation.",
    );
  });

  it("clears selection when search, filters, scope, or sort changes", async () => {
    render(<StringTable mod={MOD} mods={[MOD, OTHER_MOD]} />);
    await screen.findByText("greeting");
    const select = (key: string) => {
      fireEvent.click(screen.getByRole("checkbox", { name: `Select ${key}` }));
      expect(rowFor(key)).toHaveAttribute("aria-selected", "true");
    };

    select("greeting");
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search strings" }),
      { target: { value: "greeting" } },
    );
    expect(rowFor("greeting")).toHaveAttribute("aria-selected", "false");

    select("greeting");
    fireEvent.click(screen.getByRole("button", { name: /^Done 1$/ }));
    expect(rowFor("greeting")).toHaveAttribute("aria-selected", "false");
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));

    select("token");
    fireEvent.click(
      screen.getByRole("button", { name: /^Validation issues 1$/ }),
    );
    expect(rowFor("token")).toHaveAttribute("aria-selected", "false");
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));

    select("greeting");
    fireEvent.click(screen.getByRole("button", { name: "All mods" }));
    await screen.findByText("tomorrow");
    expect(rowFor("greeting")).toHaveAttribute("aria-selected", "false");

    select("greeting");
    fireEvent.click(screen.getByRole("button", { name: /^Key/ }));
    expect(rowFor("greeting")).toHaveAttribute("aria-selected", "false");
  });

  it("sorts status in the accepted Open, Changed, Review, Done order", async () => {
    installBackendRows({
      "a.b": [
        ROWS["a.b"][0],
        ROWS["a.b"][1],
        ROWS["a.b"][2],
        {
          key: "review",
          source: "Review me",
          target: "Prüfen",
          targetPresent: true,
          status: "review-needed",
          tokenMismatchAccepted: false,
        },
      ],
    });
    render(<StringTable mod={MOD} />);
    await screen.findByText("review");
    const statusSort = screen.getByRole("button", { name: /^Status/ });

    fireEvent.click(statusSort);
    expect(dataRows().map((row) => row.dataset.status)).toEqual([
      "untranslated",
      "outdated",
      "review-needed",
      "translated",
    ]);

    fireEvent.click(statusSort);
    expect(dataRows().map((row) => row.dataset.status)).toEqual([
      "translated",
      "review-needed",
      "outdated",
      "untranslated",
    ]);
  });

  it("opens the editor from the accepted inline validation and row-more actions", async () => {
    render(<StringTable mod={MOD} onLlmBatchExportForMod={vi.fn()} />);
    await screen.findByText("token");

    const validation = screen.getByRole("button", {
      name: /Token count mismatch for.*\{\{name\}\}/i,
    });
    expect(validation).toHaveClass("stv3-inline-validation");
    fireEvent.click(validation);
    expect(screen.getByRole("textbox", { name: "Translation" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Close editor" }));

    fireEvent.click(
      screen.getByRole("button", { name: "More actions for token" }),
    );
    const menu = await screen.findByRole("menu", { name: "String actions" });
    expect(
      screen.getByRole("menuitem", { name: /^Edit string.*Enter/ }),
    ).toBeVisible();
    expect(menu.querySelector(".lucide-pencil")).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", {
        name: /Translate selected with AI.*\(1\)/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", {
        name: /Export LLM batch.*\(1\)/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Copy translation" }),
    ).toBeVisible();
    expect(
      screen.getByRole("menuitem", { name: "Clear translation" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("menuitem", { name: "Copy translations" }),
    ).not.toBeInTheDocument();
  });

  it("keeps checkbox and modifier selection gestures out of the editor", async () => {
    render(<StringTable mod={MOD} />);
    await screen.findByText("greeting");
    const greetingRow = rowFor("greeting");
    const checkbox = screen.getByRole("checkbox", { name: "Select greeting" });

    fireEvent.doubleClick(checkbox);
    expect(
      screen.queryByRole("textbox", { name: "Translation" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "greeting" }), {
      ctrlKey: true,
    });
    expect(greetingRow).toHaveAttribute("aria-selected", "true");
    expect(
      screen.queryByRole("textbox", { name: "Translation" }),
    ).not.toBeInTheDocument();

    fireEvent.doubleClick(greetingRow, { ctrlKey: true });
    expect(
      screen.queryByRole("textbox", { name: "Translation" }),
    ).not.toBeInTheDocument();

    fireEvent.doubleClick(greetingRow);
    expect(screen.getByRole("textbox", { name: "Translation" })).toBeVisible();
  });

  it("treats an accepted token mismatch as resolved in issues and visuals", async () => {
    installBackendRows({
      "a.b": [
        ROWS["a.b"][0],
        ROWS["a.b"][1],
        {
          ...ROWS["a.b"][2],
          status: "translated",
          tokenMismatchAccepted: true,
        },
      ],
    });
    const onBulkApplied = vi.fn();
    render(<StringTable mod={MOD} onBulkApplied={onBulkApplied} />);
    await screen.findByText("token");

    expect(
      screen.queryByRole("button", { name: /^Validation issues/ }),
    ).not.toBeInTheDocument();
    expect(rowFor("token").querySelector(".stv3-inline-validation")).toBeNull();

    fireEvent.click(screen.getByRole("checkbox", { name: "Select token" }));
    fireEvent.keyDown(screen.getByRole("button", { name: /1 selected/ }), {
      key: "ArrowDown",
    });
    fireEvent.click(screen.getByRole("menuitem", { name: /Keep original/ }));
    await waitFor(() => expect(onBulkApplied).toHaveBeenCalledOnce());
    expect(onBulkApplied).toHaveBeenCalledWith(
      expect.objectContaining({
        rows: [
          expect.objectContaining({
            key: "token",
            tokenMismatchAccepted: true,
          }),
        ],
      }),
    );
  });

  it("shows status help on filter focus or status-badge pointer only", async () => {
    render(<StringTable mod={MOD} />);
    await screen.findByText("greeting");

    const changedFilter = screen.getByRole("button", { name: /^Changed/ });
    fireEvent.focus(changedFilter);
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "The English source changed",
    );
    fireEvent.resize(window);
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.focus(changedFilter);
    fireEvent.blur(changedFilter);
    expect(screen.queryByRole("tooltip")).toBeNull();

    fireEvent.focus(rowFor("token"));
    expect(screen.queryByRole("tooltip")).toBeNull();

    const changedState =
      rowFor("token").querySelector<HTMLElement>(".stv3-state");
    if (!changedState) throw new Error("Missing row status");
    fireEvent.pointerEnter(changedState);
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "The English source changed",
    );
    fireEvent.pointerLeave(changedState);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("positions a measured long tooltip above a bottom-edge target", async () => {
    render(<StringTable mod={MOD} />);
    await screen.findByText("greeting");
    const changedFilter = screen.getByRole("button", { name: /^Changed/ });
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 500,
    });
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        if (this === changedFilter) {
          return {
            x: 100,
            y: 440,
            left: 100,
            right: 180,
            top: 440,
            bottom: 460,
            width: 80,
            height: 20,
            toJSON: () => ({}),
          } as DOMRect;
        }
        if (this.classList.contains("stv3-status-tooltip")) {
          return {
            x: 0,
            y: 0,
            left: 0,
            right: 290,
            top: 0,
            bottom: 140,
            width: 290,
            height: 140,
            toJSON: () => ({}),
          } as DOMRect;
        }
        return {
          x: 0,
          y: 0,
          left: 0,
          right: 0,
          top: 0,
          bottom: 0,
          width: 0,
          height: 0,
          toJSON: () => ({}),
        } as DOMRect;
      });

    fireEvent.focus(changedFilter);

    await waitFor(() =>
      expect(screen.getByRole("tooltip")).toHaveStyle({
        left: "8px",
        top: "293px",
      }),
    );
    rectSpy.mockRestore();
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: originalInnerHeight,
    });
  });

  it("applies the hidden Overview has-value filter and exposes it in the query summary", async () => {
    const onStatusFilterChange = vi.fn();
    render(
      <StringTable
        mod={MOD}
        statusFilter="has-value"
        onStatusFilterChange={onStatusFilterChange}
      />,
    );

    expect(await screen.findByText("greeting")).toBeVisible();
    expect(screen.getByText("token")).toBeVisible();
    expect(screen.queryByText("bye")).not.toBeInTheDocument();
    expect(screen.getByText(/2 of 3 strings · Has target text/)).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /Has target text/ }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onStatusFilterChange).toHaveBeenCalledWith("all");
  });

  it("sorts naturally and clears the pre-sort selection", async () => {
    render(<StringTable mod={MOD} />);
    await screen.findByText("greeting");

    fireEvent.click(screen.getByRole("checkbox", { name: "Select greeting" }));
    fireEvent.click(screen.getByRole("button", { name: /^Key/ }));

    expect(dataRows()[0]).toHaveTextContent("bye");
    expect(
      screen.getByRole("checkbox", { name: "Select greeting" }),
    ).not.toBeChecked();
    expect(rowFor("greeting")).toHaveAttribute("aria-selected", "false");
  });

  it("uses the accepted Lucide sort icons for inactive and active directions", async () => {
    render(<StringTable mod={MOD} />);
    await screen.findByText("greeting");
    const keySort = screen.getByRole("button", { name: "Key" });

    expect(keySort.querySelector(".lucide-chevrons-up-down")).not.toBeNull();
    fireEvent.click(keySort);
    expect(keySort.querySelector(".lucide-arrow-up")).not.toBeNull();
    fireEvent.click(keySort);
    expect(keySort.querySelector(".lucide-arrow-down")).not.toBeNull();
    fireEvent.click(keySort);
    expect(keySort.querySelector(".lucide-chevrons-up-down")).not.toBeNull();
  });

  it("hides the complete table when no rows match and restores it after Clear", async () => {
    render(<StringTable mod={MOD} />);
    await screen.findByText("greeting");
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search strings" }),
      {
        target: { value: "does-not-exist" },
      },
    );

    expect(screen.getByText("No matching strings")).toBeVisible();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));
    expect(await screen.findByRole("table")).toBeVisible();
  });

  it("renders the same section header again when a second i18n file begins", async () => {
    const secondFile = {
      ...MOD.i18nFiles[0],
      relativeDir: "assets/i18n",
      defaultPath: "x/assets/i18n/default.json",
      targetPath: "x/assets/i18n/de.json",
      totalKeys: 1,
      translatedKeys: 0,
    };
    const multiFileMod: ScannedMod = {
      ...MOD,
      i18nFiles: [MOD.i18nFiles[0], secondFile],
      totalKeys: 2,
      translatedKeys: 0,
    };
    invokeMock.mockImplementation((cmd: string, args?: unknown) => {
      if (cmd !== "load_strings") return Promise.resolve(undefined);
      const relativeDir = (args as { relativeDir: string }).relativeDir;
      return Promise.resolve([
        {
          key: relativeDir === "i18n" ? "first" : "second",
          source: relativeDir,
          target: "",
          targetPresent: false,
          status: "untranslated",
          tokenMismatchAccepted: false,
          section: "Shared section",
        },
      ]);
    });

    render(<StringTable mod={multiFileMod} />);

    expect(await screen.findAllByText(/Shared section/)).toHaveLength(2);
  });

  it("supports select-all, Ctrl toggles, and Shift ranges with a visible bulk bar", async () => {
    render(<StringTable mod={MOD} />);
    await screen.findByText("greeting");

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select all visible strings" }),
    );
    expect(screen.getByRole("button", { name: /3 selected/ })).toBeVisible();

    fireEvent.click(rowFor("greeting"));
    fireEvent.click(rowFor("bye"), { ctrlKey: true });
    expect(screen.getByRole("button", { name: /2 selected/ })).toBeVisible();

    fireEvent.click(rowFor("greeting"));
    fireEvent.click(rowFor("token"), { shiftKey: true });
    expect(screen.getByRole("button", { name: /3 selected/ })).toBeVisible();
    expect(screen.getByText("Ctrl+click adds more")).toBeVisible();
  });

  it("handles Ctrl+A across the workspace while preserving native input selection", async () => {
    render(<StringTable mod={MOD} />);
    await screen.findByText("greeting");

    const search = screen.getByRole("searchbox", { name: "Search strings" });
    const inputEvent = new KeyboardEvent("keydown", {
      key: "a",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    fireEvent(search, inputEvent);
    expect(inputEvent.defaultPrevented).toBe(false);
    expect(screen.queryByRole("button", { name: /selected/ })).toBeNull();

    const workspaceEvent = new KeyboardEvent("keydown", {
      key: "a",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    fireEvent(screen.getByRole("button", { name: "This mod" }), workspaceEvent);
    expect(workspaceEvent.defaultPrevented).toBe(true);
    expect(screen.getByRole("button", { name: /3 selected/ })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: /3 selected/ }));
    const menuEvent = new KeyboardEvent("keydown", {
      key: "a",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    fireEvent(
      screen.getByRole("menuitem", { name: /Copy source text/ }),
      menuEvent,
    );
    expect(menuEvent.defaultPrevented).toBe(true);
    expect(screen.getByRole("button", { name: /3 selected/ })).toBeVisible();
  });

  it("shows every accepted bulk action and clears selection explicitly", async () => {
    const onNotify = vi.fn();
    render(<StringTable mod={MOD} onNotify={onNotify} />);
    await screen.findByText("greeting");
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select all visible strings" }),
    );
    fireEvent.click(screen.getByRole("button", { name: /3 selected/ }));

    expect(
      screen.getByRole("menuitem", { name: /Copy source text/ }),
    ).toBeVisible();
    expect(
      screen.getByRole("menuitem", { name: /Copy translations/ }),
    ).toBeVisible();
    expect(
      screen.getByRole("menuitem", { name: /Mark as done/ }),
    ).toBeVisible();
    expect(
      screen.getByRole("menuitem", { name: /Keep original/ }),
    ).toBeVisible();
    expect(
      screen.getByRole("menuitem", { name: /Clear translations/ }),
    ).toBeVisible();
    expect(
      screen.getByRole("menuitem", { name: /Translate selected with AI/ }),
    ).toBeVisible();
    expect(
      screen.getByRole("menuitem", { name: /Export selection as LLM batch/ }),
    ).toBeVisible();

    fireEvent.click(
      screen.getByRole("button", { name: "Clear selected strings" }),
    );
    expect(screen.queryByRole("button", { name: /selected/ })).toBeNull();
    expect(onNotify).toHaveBeenCalledWith("Selection cleared.", "info");
  });

  it("opens Batch actions with ArrowDown and closes menus when focus leaves", async () => {
    render(<StringTable mod={MOD} />);
    await screen.findByText("greeting");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select bye" }));
    const trigger = screen.getByRole("button", { name: /1 selected/ });

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const menu = await screen.findByRole("menu", { name: "Batch actions" });
    await waitFor(() =>
      expect(
        screen.getByRole("menuitem", { name: /Copy source text/ }),
      ).toHaveFocus(),
    );
    const enabled = screen
      .getAllByRole("menuitem")
      .filter((item) => !(item as HTMLButtonElement).disabled);
    expect(enabled[0]).toHaveAttribute("tabindex", "0");
    for (const item of enabled.slice(1)) {
      expect(item).toHaveAttribute("tabindex", "-1");
    }
    fireEvent.keyDown(menu, { key: "End" });
    expect(enabled.at(-1)).toHaveFocus();
    expect(enabled.at(-1)).toHaveAttribute("tabindex", "0");
    expect(enabled[0]).toHaveAttribute("tabindex", "-1");
    fireEvent.keyDown(menu, { key: "Home" });
    expect(enabled[0]).toHaveFocus();

    const search = screen.getByRole("searchbox", { name: "Search strings" });
    fireEvent.blur(menu, { relatedTarget: search });
    expect(screen.queryByRole("menu", { name: "Batch actions" })).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "More actions for bye" }),
    );
    const context = await screen.findByRole("menu", {
      name: "String actions",
    });
    fireEvent.blur(context, { relatedTarget: search });
    expect(screen.queryByRole("menu", { name: "String actions" })).toBeNull();
  });

  it("treats Mark as done on an empty Open string as a no-op", async () => {
    const onBulkApplied = vi.fn();
    const onNotify = vi.fn();
    render(
      <StringTable
        mod={MOD}
        onBulkApplied={onBulkApplied}
        onNotify={onNotify}
      />,
    );
    await screen.findByText("bye");

    fireEvent.click(screen.getByRole("checkbox", { name: "Select bye" }));
    fireEvent.click(screen.getByRole("button", { name: /1 selected/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Mark as done/ }));

    expect(onNotify).toHaveBeenCalledWith(
      "No selected strings needed a change.",
      "info",
    );
    expect(onBulkApplied).not.toHaveBeenCalled();
    expect(
      invokeMock.mock.calls.filter(([cmd]) => cmd === "save_strings"),
    ).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /1 selected/ })).toBeNull();
    expect(rowFor("bye").querySelector(".stv3-inline-validation")).toBeNull();
  });

  it("writes one save_strings batch per mod and emits an exact undo snapshot", async () => {
    const onBulkApplied = vi.fn();
    render(
      <StringTable
        mod={MOD}
        mods={[MOD, OTHER_MOD]}
        scope="all"
        onBulkApplied={onBulkApplied}
      />,
    );
    await screen.findByText("tomorrow");
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select all visible strings" }),
    );
    fireEvent.click(screen.getByRole("button", { name: /4 selected/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Keep original/ }));

    await waitFor(() =>
      expect(
        invokeMock.mock.calls.filter(([cmd]) => cmd === "save_strings"),
      ).toHaveLength(2),
    );
    expect(invokeMock).toHaveBeenCalledWith(
      "save_strings",
      expect.objectContaining({ modUniqueId: "a.b" }),
    );
    expect(invokeMock).toHaveBeenCalledWith(
      "save_strings",
      expect.objectContaining({ modUniqueId: "c.d" }),
    );
    expect(onBulkApplied).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "Kept original text",
        rows: expect.arrayContaining([
          expect.objectContaining({
            modUniqueId: "a.b",
            key: "greeting",
            target: "Hallo",
            status: "translated",
          }),
          expect.objectContaining({
            modUniqueId: "c.d",
            key: "tomorrow",
            target: "",
            status: "untranslated",
          }),
        ]),
      } satisfies Partial<BulkChangeSnapshot>),
    );
  });

  it("supports Local AI across mods while keeping LLM export single-mod", async () => {
    const onTranslate = vi.fn();
    const onLlmBatchExportForMod = vi.fn();
    const onEditorOpen = vi.fn();
    const onNotify = vi.fn();
    render(
      <StringTable
        mod={MOD}
        mods={[MOD, OTHER_MOD]}
        scope="all"
        onTranslate={onTranslate}
        onLlmBatchExportForMod={onLlmBatchExportForMod}
        onEditorOpen={onEditorOpen}
        onNotify={onNotify}
      />,
    );
    await screen.findByText("tomorrow");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select bye" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select tomorrow" }));
    fireEvent.click(screen.getByRole("button", { name: /2 selected/ }));

    expect(
      screen.getByRole("menuitem", { name: /Translate selected with AI/ }),
    ).toBeEnabled();
    expect(
      screen.getByRole("menuitem", { name: /Export selection as LLM batch/ }),
    ).toBeEnabled();
    expect(
      screen.getByRole("menuitem", { name: /Export selection as LLM batch/ }),
    ).toHaveAttribute(
      "title",
      "Select Open or Changed strings from one mod; each LLM batch is bound to exactly one mod.",
    );

    fireEvent.click(
      screen.getByRole("menuitem", { name: /Export selection as LLM batch/ }),
    );
    expect(onNotify).toHaveBeenCalledWith(
      "Select Open or Changed strings from one mod; each LLM batch is bound to exactly one mod.",
      "info",
    );
    expect(onLlmBatchExportForMod).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /2 selected/ }));
    fireEvent.click(
      screen.getByRole("menuitem", { name: /Translate selected with AI/ }),
    );
    expect(onEditorOpen).toHaveBeenCalledOnce();
    expect(await screen.findByText("2 selected across 2 mods")).toBeVisible();
    expect(screen.getByRole("checkbox", { name: /Open/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Changed/ })).not.toBeChecked();
  });

  it("explains why selected Done or Review strings are not LLM-exportable", async () => {
    const onLlmBatchExportForMod = vi.fn();
    const onNotify = vi.fn();
    render(
      <StringTable
        mod={MOD}
        onLlmBatchExportForMod={onLlmBatchExportForMod}
        onNotify={onNotify}
      />,
    );
    await screen.findByText("greeting");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select greeting" }));
    fireEvent.click(screen.getByRole("button", { name: /1 selected/ }));

    const action = screen.getByRole("menuitem", {
      name: /Export selection as LLM batch/,
    });
    expect(action).toBeEnabled();
    expect(action).toHaveAttribute(
      "title",
      "No selected Open or Changed strings are exportable. Done and Review text would be preserved on import.",
    );
    fireEvent.click(action);

    expect(onNotify).toHaveBeenCalledWith(
      "No selected Open or Changed strings are exportable. Done and Review text would be preserved on import.",
      "info",
    );
    expect(onLlmBatchExportForMod).not.toHaveBeenCalled();
  });

  it("opens the Local AI preview when the engine is unavailable and disables only Start", async () => {
    render(<StringTable mod={MOD} />);
    await screen.findByText("bye");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select bye" }));
    fireEvent.click(screen.getByRole("button", { name: /1 selected/ }));

    const action = screen.getByRole("menuitem", {
      name: /Translate selected with AI/,
    });
    expect(action).toBeEnabled();
    fireEvent.click(action);

    expect(
      await screen.findByRole("dialog", { name: "Translate with AI" }),
    ).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This engine is not ready; check its status in Settings first.",
    );
    expect(
      screen.getByRole("button", { name: "Start AI translation" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      screen.queryByRole("dialog", { name: "Translate with AI" }),
    ).not.toBeInTheDocument();
  });

  it("translates only eligible selected rows and persists every AI result to Review", async () => {
    const onTranslate = vi.fn().mockResolvedValue({
      text: "KI-Text",
      missingTokens: [],
      glossaryMisses: [],
    });
    const onStatusFilterChange = vi.fn();
    const onNotify = vi.fn();
    const onAiBatchFinished = vi.fn();
    render(
      <StringTable
        mod={MOD}
        onTranslate={onTranslate}
        onStatusFilterChange={onStatusFilterChange}
        onNotify={onNotify}
        onAiBatchFinished={onAiBatchFinished}
      />,
    );
    await screen.findByText("greeting");
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select all visible strings" }),
    );
    fireEvent.click(screen.getByRole("button", { name: /3 selected/ }));
    fireEvent.click(
      screen.getByRole("menuitem", { name: /Translate selected with AI/ }),
    );
    expect(screen.getByText("1 strings")).toBeVisible();
    fireEvent.click(screen.getByRole("checkbox", { name: /Changed/ }));
    expect(screen.getByText("2 strings")).toBeVisible();
    fireEvent.click(
      await screen.findByRole("button", { name: /Start AI translation/ }),
    );

    await waitFor(() => expect(onTranslate).toHaveBeenCalledTimes(2));
    const saves = invokeMock.mock.calls.filter(
      ([cmd]) => cmd === "save_string",
    );
    expect(saves).toHaveLength(2);
    expect(
      saves.every(([, args]) =>
        Object.is((args as { status: string }).status, "review-needed"),
      ),
    ).toBe(true);
    expect(onStatusFilterChange).toHaveBeenCalledWith("review-needed");
    expect(onNotify).toHaveBeenCalledWith(
      "2 AI suggestions saved to Review.",
      "success",
    );
    expect(onAiBatchFinished).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "complete",
        done: 2,
        total: 2,
        engine: "Local AI",
        undo: expect.objectContaining({
          label: "AI suggestions saved to Review",
          rows: expect.arrayContaining([
            expect.objectContaining({ key: "bye" }),
            expect.objectContaining({ key: "token" }),
          ]),
        }),
      }),
    );
    expect(
      screen.queryByRole("dialog", { name: "Batch AI translation" }),
    ).not.toBeInTheDocument();
  });

  it("reports cancellation with saved partial Review work and an undoable result", async () => {
    let release:
      | ((result: {
          text: string;
          missingTokens: string[];
          glossaryMisses: string[];
        }) => void)
      | null = null;
    const onTranslate = vi.fn(
      () =>
        new Promise<{
          text: string;
          missingTokens: string[];
          glossaryMisses: string[];
        }>((resolve) => {
          release = resolve;
        }),
    );
    const onNotify = vi.fn();
    const onStatusFilterChange = vi.fn();
    const onBulkApplied = vi.fn();
    const onAiBatchFinished = vi.fn();
    render(
      <StringTable
        mod={MOD}
        onTranslate={onTranslate}
        onNotify={onNotify}
        onStatusFilterChange={onStatusFilterChange}
        onBulkApplied={onBulkApplied}
        onAiBatchFinished={onAiBatchFinished}
      />,
    );
    await screen.findByText("bye");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select bye" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select token" }));
    fireEvent.click(screen.getByRole("button", { name: /2 selected/ }));
    fireEvent.click(
      screen.getByRole("menuitem", { name: /Translate selected with AI/ }),
    );
    fireEvent.click(screen.getByRole("checkbox", { name: /Changed/ }));
    fireEvent.click(
      screen.getByRole("button", { name: /Start AI translation/ }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    if (!release) throw new Error("AI request did not start");
    act(() =>
      release?.({ text: "Tschüss", missingTokens: [], glossaryMisses: [] }),
    );

    await waitFor(() => expect(onAiBatchFinished).toHaveBeenCalledOnce());
    expect(onStatusFilterChange).toHaveBeenCalledWith("review-needed");
    expect(onNotify).not.toHaveBeenCalled();
    expect(onBulkApplied).not.toHaveBeenCalled();
    expect(onAiBatchFinished).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "cancelled",
        done: 1,
        total: 2,
        engine: "Local AI",
        modName: "Test Mod",
        undo: expect.objectContaining({
          label: "AI translation cancelled · suggestions saved to Review",
          rows: [expect.objectContaining({ key: "bye" })],
        }),
      }),
    );
    expect(
      screen.queryByRole("dialog", { name: "Batch AI translation" }),
    ).not.toBeInTheDocument();
  });

  it("reports an AI error after partial progress and switches to Review", async () => {
    const onTranslate = vi
      .fn()
      .mockResolvedValueOnce({
        text: "Tschüss",
        missingTokens: [],
        glossaryMisses: [],
      })
      .mockRejectedValueOnce(new Error("Local AI offline"));
    const onNotify = vi.fn();
    const onStatusFilterChange = vi.fn();
    const onBulkApplied = vi.fn();
    const onAiBatchFinished = vi.fn();
    render(
      <StringTable
        mod={MOD}
        onTranslate={onTranslate}
        onNotify={onNotify}
        onStatusFilterChange={onStatusFilterChange}
        onBulkApplied={onBulkApplied}
        onAiBatchFinished={onAiBatchFinished}
      />,
    );
    await screen.findByText("bye");
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select all visible strings" }),
    );
    fireEvent.click(screen.getByRole("button", { name: /3 selected/ }));
    fireEvent.click(
      screen.getByRole("menuitem", { name: /Translate selected with AI/ }),
    );
    fireEvent.click(screen.getByRole("checkbox", { name: /Changed/ }));
    fireEvent.click(
      screen.getByRole("button", { name: /Start AI translation/ }),
    );

    await waitFor(() => expect(onAiBatchFinished).toHaveBeenCalledOnce());
    expect(onStatusFilterChange).toHaveBeenCalledWith("review-needed");
    expect(onNotify).not.toHaveBeenCalled();
    expect(onBulkApplied).not.toHaveBeenCalled();
    expect(onAiBatchFinished).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "error",
        done: 1,
        total: 2,
        error: "Error: Local AI offline",
        engine: "Local AI",
        modName: "Test Mod",
        undo: expect.objectContaining({
          label: "AI translation failed · suggestions saved to Review",
          rows: [expect.objectContaining({ key: "bye" })],
        }),
      }),
    );
    expect(
      screen.queryByRole("dialog", { name: "Batch AI translation" }),
    ).not.toBeInTheDocument();
  });

  it("reports a zero-progress AI failure without inventing an undo snapshot", async () => {
    const onAiBatchFinished = vi.fn();
    const onStatusFilterChange = vi.fn();
    render(
      <StringTable
        mod={MOD}
        onTranslate={vi.fn().mockRejectedValue(new Error("Local AI offline"))}
        onAiBatchFinished={onAiBatchFinished}
        onStatusFilterChange={onStatusFilterChange}
      />,
    );
    await screen.findByText("bye");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select bye" }));
    fireEvent.click(screen.getByRole("button", { name: /1 selected/ }));
    fireEvent.click(
      screen.getByRole("menuitem", { name: /Translate selected with AI/ }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Start AI translation" }),
    );

    await waitFor(() => expect(onAiBatchFinished).toHaveBeenCalledOnce());
    expect(onAiBatchFinished).toHaveBeenCalledWith({
      outcome: "error",
      done: 0,
      total: 1,
      error: "Error: Local AI offline",
      engine: "Local AI",
      modName: "Test Mod",
      undo: null,
    });
    expect(onStatusFilterChange).not.toHaveBeenCalled();
  });

  it("exports only open/changed rows for one real mod", async () => {
    const onLlmBatchExportForMod = vi.fn().mockResolvedValue({
      path: "C:/out/Test.llm-batch.json",
      stringCount: 2,
    });
    render(
      <StringTable mod={MOD} onLlmBatchExportForMod={onLlmBatchExportForMod} />,
    );
    await screen.findByText("greeting");
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select all visible strings" }),
    );
    fireEvent.click(screen.getByRole("button", { name: /3 selected/ }));
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: /Export selection as LLM batch/,
      }),
    );

    await waitFor(() => expect(onLlmBatchExportForMod).toHaveBeenCalled());
    expect(onLlmBatchExportForMod).toHaveBeenCalledWith(MOD, [
      { relativeDir: "i18n", key: "bye", source: "Bye" },
      {
        relativeDir: "i18n",
        key: "token",
        source: "Hi {{name}}",
      },
    ]);
  });

  it("focuses search with Ctrl+F and opens row actions with Shift+F10", async () => {
    render(<StringTable mod={MOD} />);
    await screen.findByText("greeting");
    const first = dataRows()[0];
    act(() => first.focus());

    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    const search = screen.getByRole("searchbox", { name: "Search strings" });
    expect(search).toHaveFocus();
    fireEvent.change(search, { target: { value: "greeting" } });
    fireEvent.keyDown(search, { key: "Escape" });
    expect(search).toHaveValue("");
    expect(search).toHaveFocus();

    act(() => first.focus());
    fireEvent.keyDown(first, { key: "F10", shiftKey: true });
    expect(
      await screen.findByRole("menu", { name: "String actions" }),
    ).toBeVisible();
    await waitFor(() =>
      expect(
        screen.getByRole("menuitem", { name: /^Edit string/ }),
      ).toHaveFocus(),
    );
    fireEvent.keyDown(screen.getByRole("menu", { name: "String actions" }), {
      key: "ArrowDown",
    });
    expect(
      screen.getByRole("menuitem", { name: /Copy source text/ }),
    ).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("menu", { name: "String actions" }), {
      key: "Escape",
    });
    await waitFor(() => expect(first).toHaveFocus());
  });

  it("returns row-more context focus to the exact trigger", async () => {
    render(<StringTable mod={MOD} />);
    await screen.findByText("greeting");
    const more = screen.getByRole("button", {
      name: "More actions for greeting",
    });
    act(() => more.focus());
    fireEvent.click(more);
    const menu = await screen.findByRole("menu", { name: "String actions" });
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(more).toHaveFocus());
  });

  it("supports Home, End, Shift+Space ranges, and the ContextMenu key", async () => {
    render(<StringTable mod={MOD} />);
    await screen.findByText("greeting");
    const [first, , last] = dataRows();
    act(() => first.focus());

    fireEvent.keyDown(first, { key: " " });
    fireEvent.keyDown(first, { key: "End" });
    await waitFor(() => expect(last).toHaveFocus());
    fireEvent.keyDown(last, { key: " ", shiftKey: true });
    expect(screen.getByRole("button", { name: /3 selected/ })).toBeVisible();

    fireEvent.keyDown(last, { key: "Home" });
    await waitFor(() => expect(first).toHaveFocus());
    fireEvent.keyDown(first, { key: "ContextMenu" });
    expect(
      await screen.findByRole("menu", { name: "String actions" }),
    ).toBeVisible();
  });

  it("clamps a row context menu to the app bounds", async () => {
    render(<StringTable mod={MOD} />);
    await screen.findByText("greeting");

    fireEvent.contextMenu(rowFor("greeting"), {
      clientX: 9_999,
      clientY: 9_999,
    });
    const menu = await screen.findByRole("menu", { name: "String actions" });
    await waitFor(() => {
      expect(Number.parseFloat(menu.style.left)).toBeLessThan(9_999);
      expect(Number.parseFloat(menu.style.top)).toBeLessThan(9_999);
    });
  });

  it("resizes every visible content column while status stays fixed", async () => {
    const secondFile = {
      ...MOD.i18nFiles[0],
      relativeDir: "assets/i18n",
      defaultPath: "x/assets/i18n/default.json",
      targetPath: "x/assets/i18n/de.json",
    };
    const multiMod: ScannedMod = {
      ...MOD,
      i18nFiles: [MOD.i18nFiles[0], secondFile],
    };
    const { container } = render(
      <StringTable
        mod={multiMod}
        mods={[multiMod]}
        scope="all"
        targetLanguageLabel="German (de)"
      />,
    );
    await screen.findAllByText("greeting");

    const resizers = [
      ["Resize mod column", "146"],
      ["Resize file column", "121"],
      ["Resize key column", "266"],
      ["Resize English source column", "376"],
      ["Resize German translation column", "196"],
    ] as const;
    for (const [name, expectedWidth] of resizers) {
      const resizer = screen.getByRole("separator", { name });
      fireEvent.keyDown(resizer, { key: "ArrowRight" });
      expect(resizer).toHaveAttribute("aria-valuenow", expectedWidth);
    }

    const header = container.querySelector<HTMLElement>(
      ".stv3-string-table-head",
    );
    expect(header).toHaveStyle({
      gridTemplateColumns:
        "34px 146px 121px 102px 266px 376px 196px minmax(0, 1fr)",
    });
    expect(
      screen.queryByRole("separator", { name: "Resize status column" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("table")).toHaveStyle({ minWidth: "1241px" });
  });

  it("drags a column boundary and removes the temporary window listeners", async () => {
    render(<StringTable mod={MOD} />);
    await screen.findByText("greeting");
    const targetResizer = screen.getByRole("separator", {
      name: "Resize translation column",
    });
    const targetHeader = targetResizer.parentElement;
    if (!targetHeader) throw new Error("Missing target column header");
    vi.spyOn(targetHeader, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      right: 340,
      top: 0,
      bottom: 30,
      width: 340,
      height: 30,
      toJSON: () => ({}),
    } as DOMRect);

    fireEvent.pointerDown(targetResizer, {
      button: 2,
      clientX: 100,
      pointerId: 6,
    });
    fireEvent.pointerMove(window, { clientX: 148, pointerId: 6 });
    expect(targetResizer).not.toHaveClass("is-dragging");
    expect(targetResizer).toHaveAttribute("aria-valuenow", "180");

    fireEvent.pointerDown(targetResizer, { clientX: 100, pointerId: 7 });
    expect(targetResizer).toHaveClass("is-dragging");
    fireEvent.pointerMove(window, { clientX: 52, pointerId: 7 });
    expect(targetResizer).toHaveAttribute("aria-valuenow", "292");
    fireEvent.pointerMove(window, { clientX: 148, pointerId: 7 });
    expect(targetResizer).toHaveAttribute("aria-valuenow", "388");
    fireEvent.pointerUp(window, { pointerId: 7 });
    expect(targetResizer).not.toHaveClass("is-dragging");
    fireEvent.pointerMove(window, { clientX: 196, pointerId: 7 });
    expect(targetResizer).toHaveAttribute("aria-valuenow", "388");
  });

  it("opens the existing editor and saves against the row's true mod/file identity", async () => {
    render(<StringTable mod={MOD} />);
    await screen.findByText("greeting");
    const targetCell = rowFor("greeting").querySelector<HTMLElement>(
      ".stv3-translation-col",
    );
    if (!targetCell) throw new Error("Missing target cell");
    fireEvent.doubleClick(targetCell);
    const textarea = screen.getByRole("textbox", { name: "Translation" });
    fireEvent.change(textarea, { target: { value: "Hallo Welt" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save / }));

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

  it("preserves section dividers in natural mod order and hides them when sorted", async () => {
    render(<StringTable mod={MOD} />);
    expect(await screen.findByText("// Dialogue")).toBeVisible();
    expect(screen.queryByText(/Section ·/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Key/ }));
    expect(screen.queryByText("// Dialogue")).not.toBeInTheDocument();
  });

  it("keeps virtualized bottom clearance for the floating result tray", async () => {
    const { rerender } = render(
      <StringTable mod={MOD} bottomClearance={260} />,
    );
    await screen.findByText("greeting");
    expect(screen.getByTestId("stringtable-scroll-content")).toHaveStyle({
      height: "380px",
    });

    rerender(<StringTable mod={MOD} bottomClearance={58} />);
    expect(screen.getByTestId("stringtable-scroll-content")).toHaveStyle({
      height: "178px",
    });
  });

  it("shows a clickable real review count in the compact heading", () => {
    const onShowReview = vi.fn();
    render(
      <StringTableHeader
        mod={{
          ...MOD,
          statusCounts: {
            untranslated: 1,
            translated: 1,
            outdated: 0,
            "review-needed": 2,
          },
        }}
        onShowReview={onShowReview}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /2 need review/ }));
    expect(onShowReview).toHaveBeenCalledOnce();
  });
});
