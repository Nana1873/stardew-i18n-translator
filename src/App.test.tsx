import { render, screen } from "@testing-library/react";
import { App } from "./App";

describe("App shell", () => {
  it("renders the toolbar with placeholder actions", () => {
    render(<App />);
    expect(screen.getByText("Stardew i18n Translator")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Scan" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Export" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Settings" })).toBeDisabled();
  });

  it("renders the two-panel layout (mod list + string table)", () => {
    render(<App />);
    expect(screen.getByRole("region", { name: "Mod list" })).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "String table" }),
    ).toBeInTheDocument();
    expect(screen.getByText("No mods scanned yet.")).toBeInTheDocument();
    expect(
      screen.getByText("Select a mod to view its strings."),
    ).toBeInTheDocument();
  });
});
