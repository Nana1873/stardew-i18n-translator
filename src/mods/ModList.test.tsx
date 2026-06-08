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
      },
    ],
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
      mod({ uniqueId: "cp", name: "[CP] RSV", packageId: "Ridgeside", nexusId: 7286 }),
      mod({ uniqueId: "cc", name: "[CC] RSV", packageId: "Ridgeside" }),
    ];
    render(<ModList mods={mods} selectedId={null} onSelect={() => {}} />);

    // Parent shows the package name; children are the components.
    expect(screen.getByText("Ridgeside")).toBeInTheDocument();
    expect(screen.getByText("[CP] RSV")).toBeInTheDocument();
    expect(screen.getByText("[CC] RSV")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Collapse" })).toBeInTheDocument();
    // The real Nexus id is surfaced both on the parent (rolled up) and on the
    // [CP] child that owns it (SPEC §7.3).
    expect(screen.getAllByRole("link", { name: "7286" })).toHaveLength(2);
  });
});
