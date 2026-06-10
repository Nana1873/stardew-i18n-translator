import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));

import { SettingsDialog } from "./SettingsDialog";
import type { AppSettings } from "../tauri/commands";

const baseSettings: AppSettings = {
  stardewPath: "E:/SDV",
  modsPath: "E:/SDV/Mods",
  sourceLang: "default",
  targetLang: "de",
  llm: null,
};

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd: string) => {
    switch (cmd) {
      case "glossary_status":
        return Promise.resolve({ unpackedPresent: false, cached: null });
      case "llm_models":
        return Promise.resolve(["llama3.1:8b", "qwen2.5"]);
      default:
        return Promise.resolve(null);
    }
  });
});

describe("SettingsDialog", () => {
  it("shows the current folders and a Re-run setup button (not the wizard)", () => {
    const onReRunSetup = vi.fn();
    render(
      <SettingsDialog
        settings={baseSettings}
        onSave={() => {}}
        onClose={() => {}}
        onReRunSetup={onReRunSetup}
      />,
    );
    expect(screen.getByText("E:/SDV")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Re-run setup…" }));
    expect(onReRunSetup).toHaveBeenCalled();
  });

  it("tests the AI connection and saves the chosen model", async () => {
    const onSave = vi.fn();
    render(
      <SettingsDialog
        settings={baseSettings}
        onSave={onSave}
        onClose={() => {}}
        onReRunSetup={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText(/2 models available/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        targetLang: "de",
        llm: {
          provider: "lmstudio",
          baseUrl: "http://localhost:1234/v1",
          model: "llama3.1:8b",
        },
      }),
    );
  });

  it("saves llm null when the AI connection is left untested", () => {
    const onSave = vi.fn();
    render(
      <SettingsDialog
        settings={baseSettings}
        onSave={onSave}
        onClose={() => {}}
        onReRunSetup={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ llm: null }));
  });

  it("keeps a previously saved model selected on open", async () => {
    const onSave = vi.fn();
    render(
      <SettingsDialog
        settings={{
          ...baseSettings,
          llm: {
            provider: "ollama",
            baseUrl: "http://localhost:11434/v1",
            model: "qwen2.5",
          },
        }}
        onSave={onSave}
        onClose={() => {}}
        onReRunSetup={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        llm: {
          provider: "ollama",
          baseUrl: "http://localhost:11434/v1",
          model: "qwen2.5",
        },
      }),
    );
  });
});
