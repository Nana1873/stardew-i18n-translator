import { render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { App } from "./App";

beforeEach(() => {
  invokeMock.mockReset();
});

describe("App shell", () => {
  it("renders the toolbar and two-panel layout", async () => {
    invokeMock.mockResolvedValue({
      stardewPath: "E:/SDV",
      modsPath: "E:/SDV/Mods",
      sourceLang: "default",
      targetLang: "de",
    });
    render(<App />);

    expect(screen.getByText("Stardew i18n Translator")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Mod list" })).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "String table" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Scan" })).toBeDisabled();

    // Settings enables once settings have loaded; configured -> no wizard.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Settings" })).toBeEnabled(),
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
});
