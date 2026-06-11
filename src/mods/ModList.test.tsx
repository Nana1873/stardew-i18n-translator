import { render, screen } from "@testing-library/react";
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
    expect(
      screen.getByRole("button", { name: "Collapse" }),
    ).toBeInTheDocument();
    // The real Nexus id is surfaced both on the parent (rolled up) and on the
    // [CP] child that owns it (SPEC §7.3).
    expect(screen.getAllByRole("link", { name: "7286" })).toHaveLength(2);
  });

  it("draws ├─/└─ tree connectors on the components of a package", () => {
    const mods = [
      mod({ uniqueId: "cp", name: "[CP] RSV", packageId: "Ridgeside" }),
      mod({ uniqueId: "cc", name: "[CC] RSV", packageId: "Ridgeside" }),
    ];
    render(<ModList mods={mods} selectedId={null} onSelect={() => {}} />);

    // First child gets ├─, the last child gets └─.
    expect(screen.getByText("├─")).toBeInTheDocument();
    expect(screen.getByText("└─")).toBeInTheDocument();
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
      ".modrow__bar-fill",
    ) as HTMLElement | null;
    expect(fill).not.toBeNull();
    expect(fill!.style.width).toBe("50%");
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

    rerender(
      <ModList mods={mods} selectedId={null} onSelect={() => {}} query="zzz" />,
    );
    expect(screen.getByText(/No mods match/)).toBeInTheDocument();
  });

  it("does not draw a connector on a single-component (flat) mod", () => {
    render(
      <ModList
        mods={[mod({ uniqueId: "solo", name: "Solo Mod", packageId: "Solo" })]}
        selectedId={null}
        onSelect={() => {}}
      />,
    );
    expect(screen.queryByText("├─")).toBeNull();
    expect(screen.queryByText("└─")).toBeNull();
  });
});
