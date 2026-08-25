import { fireEvent, render, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { ModList } from "./ModList";
import type { ScannedMod } from "../tauri/commands";

function mod(partial: Partial<ScannedMod> & { uniqueId: string }): ScannedMod {
  return {
    name: partial.uniqueId,
    version: "1.0",
    nexusId: null,
    packageId: partial.uniqueId,
    folderPath: "",
    i18nFiles: [
      {
        relativeDir: "i18n",
        defaultPath: "d",
        targetPath: "t",
        targetExists: false,
        totalKeys: 10,
        translatedKeys: 0,
        reviewNeeded: 0,
      },
    ],
    totalKeys: 10,
    translatedKeys: 0,
    reviewNeeded: 0,
    progress: 0,
    status: "untranslated",
    ...partial,
  };
}

describe("ModList", () => {
  it("renders a single-component package as one flat row", () => {
    render(
      <ModList
        mods={[mod({ uniqueId: "solo", name: "Solo Mod", packageId: "Solo" })]}
        selectedId={null}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText("Solo Mod")).toBeInTheDocument();
    // No expand control for a single-component package.
    expect(screen.queryByRole("button", { name: "Collapse" })).toBeNull();
  });

  it("groups a multi-component package under an expandable parent", () => {
    const mods = [
      mod({
        uniqueId: "cp",
        name: "[CP] RSV",
        packageId: "Ridgeside",
        nexusId: 7286,
      }),
      mod({ uniqueId: "cc", name: "[CC] RSV", packageId: "Ridgeside" }),
    ];
    render(<ModList mods={mods} selectedId={null} onSelect={() => {}} />);

    // Parent shows the package name; children are the components.
    expect(screen.getByText("Ridgeside")).toBeInTheDocument();
    expect(screen.getByText("[CP] RSV")).toBeInTheDocument();
    expect(screen.getByText("[CC] RSV")).toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: /Ridgeside/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    // The real Nexus id is surfaced both on the parent (rolled up) and on the
    // [CP] child that owns it (SPEC §7).
    expect(screen.getAllByText("7286")).toHaveLength(2);
  });

  it("draws ├─/└─ tree connectors on the components of a package", () => {
    const mods = [
      mod({ uniqueId: "cp", name: "[CP] RSV", packageId: "Ridgeside" }),
      mod({ uniqueId: "cc", name: "[CC] RSV", packageId: "Ridgeside" }),
    ];
    render(<ModList mods={mods} selectedId={null} onSelect={() => {}} />);

    const branches = document.querySelectorAll(".stv3-tree-branch");
    expect(branches).toHaveLength(2);
    expect(branches[0]).not.toHaveClass("is-last");
    expect(branches[1]).toHaveClass("is-last");
  });

  it("renders a progress bar whose fill width matches the percentage", () => {
    render(
      <ModList
        mods={[
          mod({
            uniqueId: "p",
            name: "Half Done",
            packageId: "Half",
            totalKeys: 10,
            translatedKeys: 5,
            progress: 0.5,
          }),
        ]}
        selectedId={null}
        onSelect={() => {}}
      />,
    );
    const fill = document.querySelector(
      ".stv3-mod-progress span",
    ) as HTMLElement | null;
    expect(fill).not.toBeNull();
    expect(fill!.style.getPropertyValue("--stv3-progress")).toBe("50%");
    expect(screen.getByText("50%")).toBeInTheDocument();
  });

  it("sorts packages alphabetically by name", () => {
    render(
      <ModList
        mods={[
          mod({ uniqueId: "z", name: "Zebra Mod", packageId: "Zebra" }),
          mod({ uniqueId: "a", name: "Alpha Mod", packageId: "Alpha" }),
        ]}
        selectedId={null}
        onSelect={() => {}}
      />,
    );
    const names = screen
      .getAllByText(/Zebra Mod|Alpha Mod/)
      .map((n) => n.textContent);
    expect(names[0]).toBe("Alpha Mod");
    expect(names[1]).toBe("Zebra Mod");
  });

  it("filters the list by query (and shows an empty hint on no match)", () => {
    const mods = [
      mod({ uniqueId: "z", name: "Zebra Mod", packageId: "Zebra" }),
      mod({ uniqueId: "a", name: "Alpha Mod", packageId: "Alpha" }),
    ];
    const { rerender } = render(
      <ModList
        mods={mods}
        selectedId={null}
        onSelect={() => {}}
        query="alpha"
      />,
    );
    expect(screen.getByText("Alpha Mod")).toBeInTheDocument();
    expect(screen.queryByText("Zebra Mod")).toBeNull();

    const clear = vi.fn();
    rerender(
      <ModList
        mods={mods}
        selectedId={null}
        onSelect={() => {}}
        query="zzz"
        onClearQuery={clear}
      />,
    );
    expect(screen.getByText("No mods found")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));
    expect(clear).toHaveBeenCalledOnce();
  });

  it("keeps a matching package parent but renders only matching children", () => {
    const mods = [
      mod({
        uniqueId: "meadow.utilities",
        name: "Meadow Utilities",
        packageId: "Meadow Toolkit Bundle",
      }),
      mod({
        uniqueId: "cozy.crafting",
        name: "Cozy Crafting",
        packageId: "Meadow Toolkit Bundle",
      }),
      mod({
        uniqueId: "orchard.expansion",
        name: "Orchard Expansion",
        packageId: "Meadow Toolkit Bundle",
      }),
    ];
    const { rerender } = render(
      <ModList mods={mods} selectedId={null} onSelect={() => {}} />,
    );

    fireEvent.click(
      screen.getByRole("treeitem", { name: /Meadow Toolkit Bundle/ }),
    );
    expect(screen.queryByText("Cozy Crafting")).toBeNull();

    rerender(
      <ModList
        mods={mods}
        selectedId={null}
        onSelect={() => {}}
        query="cozy"
      />,
    );

    const parent = screen.getByRole("treeitem", {
      name: /Meadow Toolkit Bundle/,
    });
    expect(parent).toBeInTheDocument();
    expect(parent).toHaveAttribute("aria-expanded", "true");
    expect(parent).toHaveTextContent("3 comps.");
    expect(screen.getByText("Cozy Crafting")).toBeInTheDocument();
    expect(screen.queryByText("Meadow Utilities")).toBeNull();
    expect(screen.queryByText("Orchard Expansion")).toBeNull();
  });

  it("renders every child when the package name itself matches", () => {
    const mods = [
      mod({
        uniqueId: "meadow.utilities",
        name: "Meadow Utilities",
        packageId: "Meadow Toolkit Bundle",
      }),
      mod({
        uniqueId: "cozy.crafting",
        name: "Cozy Crafting",
        packageId: "Meadow Toolkit Bundle",
      }),
    ];
    render(
      <ModList
        mods={mods}
        selectedId={null}
        onSelect={() => {}}
        query="toolkit"
      />,
    );

    expect(screen.getByText("Meadow Utilities")).toBeInTheDocument();
    expect(screen.getByText("Cozy Crafting")).toBeInTheDocument();
  });

  it("does not draw a connector on a single-component (flat) mod", () => {
    render(
      <ModList
        mods={[mod({ uniqueId: "solo", name: "Solo Mod", packageId: "Solo" })]}
        selectedId={null}
        onSelect={() => {}}
      />,
    );
    expect(document.querySelector(".stv3-tree-branch")).toBeNull();
  });

  it("opens the selected mod folder from the context menu", () => {
    render(
      <ModList
        mods={[
          mod({
            uniqueId: "solo",
            name: "Solo Mod",
            packageId: "Solo",
            folderPath: "C:\\Games\\Stardew Valley\\Mods\\Solo",
          }),
        ]}
        selectedId={null}
        onSelect={() => {}}
      />,
    );

    fireEvent.contextMenu(screen.getByText("Solo Mod"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Open mod folder" }));

    expect(invoke).toHaveBeenCalledWith("open_mod_folder", {
      path: "C:\\Games\\Stardew Valley\\Mods\\Solo",
    });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("opens a real Nexus link from the mod context menu", () => {
    render(
      <ModList
        mods={[
          mod({
            uniqueId: "solo",
            name: "Solo Mod",
            packageId: "Solo",
            nexusId: 1234,
          }),
        ]}
        selectedId={null}
        onSelect={() => {}}
      />,
    );

    fireEvent.contextMenu(screen.getByText("Solo Mod"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Open on Nexus" }));

    expect(invoke).toHaveBeenCalledWith("open_url", {
      url: "https://www.nexusmods.com/stardewvalley/mods/1234",
    });
  });

  it("keeps Open on Nexus visible but unavailable without a real Nexus id", () => {
    vi.mocked(invoke).mockClear();
    render(
      <ModList
        mods={[
          mod({
            uniqueId: "solo",
            name: "Solo Mod",
            packageId: "Solo",
            nexusId: null,
          }),
        ]}
        selectedId={null}
        onSelect={() => {}}
      />,
    );

    fireEvent.contextMenu(screen.getByText("Solo Mod"));
    const nexus = screen.getByRole("menuitem", { name: "Open on Nexus" });
    expect(nexus).toBeVisible();
    expect(nexus).toBeDisabled();
    expect(nexus).toHaveTextContent("Unavailable");
    fireEvent.click(nexus);
    expect(invoke).not.toHaveBeenCalledWith("open_url", expect.anything());
  });

  it("uses roving menu focus and closes when focus leaves the mod menu", () => {
    render(
      <>
        <button type="button">Outside</button>
        <ModList
          mods={[
            mod({
              uniqueId: "solo",
              name: "Solo Mod",
              packageId: "Solo",
              nexusId: 1234,
            }),
          ]}
          selectedId={null}
          onSelect={() => {}}
        />
      </>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "More actions for Solo Mod" }),
    );
    const menu = screen.getByRole("menu", { name: "Mod actions" });
    const folder = screen.getByRole("menuitem", { name: "Open mod folder" });
    const nexus = screen.getByRole("menuitem", { name: "Open on Nexus" });
    expect(folder).toHaveFocus();
    expect(folder).toHaveAttribute("tabindex", "0");
    expect(nexus).toHaveAttribute("tabindex", "-1");

    fireEvent.keyDown(menu, { key: "End" });
    expect(nexus).toHaveFocus();
    expect(nexus).toHaveAttribute("tabindex", "0");

    const outside = screen.getByRole("button", { name: "Outside" });
    fireEvent.blur(nexus, { relatedTarget: outside });
    expect(screen.queryByRole("menu", { name: "Mod actions" })).toBeNull();
  });

  it("marks components with multiple real i18n sources", () => {
    const sample = mod({
      uniqueId: "multi",
      name: "Multi",
      packageId: "Multi",
    });
    sample.i18nFiles.push({
      relativeDir: "assets/i18n",
      defaultPath: "d2",
      targetPath: "t2",
      targetExists: false,
      totalKeys: 4,
      translatedKeys: 0,
      reviewNeeded: 0,
    });
    render(<ModList mods={[sample]} selectedId={null} onSelect={() => {}} />);
    expect(screen.getByText("2 i18n sources")).toBeInTheDocument();
  });

  it("moves through mod rows with arrows and selects with Enter or Space", () => {
    const onSelect = vi.fn();
    render(
      <ModList
        mods={[
          mod({ uniqueId: "a", name: "Alpha", packageId: "Alpha" }),
          mod({ uniqueId: "b", name: "Beta", packageId: "Beta" }),
        ]}
        selectedId={null}
        onSelect={onSelect}
      />,
    );

    const rows = screen.getAllByRole("treeitem");
    expect(rows[0]).toHaveAttribute("tabindex", "0");
    expect(rows[1]).toHaveAttribute("tabindex", "-1");
    rows[0].focus();
    fireEvent.keyDown(rows[0], { key: "ArrowDown" });
    expect(rows[1]).toHaveFocus();
    fireEvent.keyDown(rows[1], { key: "Enter" });
    expect(onSelect).toHaveBeenLastCalledWith("b");
    fireEvent.keyDown(rows[1], { key: " " });
    expect(onSelect).toHaveBeenLastCalledWith("b");
  });
});
