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

    fireEvent.click(screen.getByRole("tab", { name: "Local AI" }));
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(
      await screen.findByText(/Connected · responded in/),
    ).toBeInTheDocument();
    expect(screen.getByText(/2 models available/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        targetLang: "de",
        llm: {
          provider: "lmstudio",
          baseUrl: "http://localhost:1234/v1",
          model: "llama3.1:8b",
          temperature: null,
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
          temperature: null,
        },
      }),
    );
  });

  it("saves a custom temperature and restores it on open", async () => {
    const onSave = vi.fn();
    render(
      <SettingsDialog
        settings={{
          ...baseSettings,
          llm: {
            provider: "ollama",
            baseUrl: "http://localhost:11434/v1",
            model: "qwen2.5",
            temperature: 0.5,
          },
        }}
        onSave={onSave}
        onClose={() => {}}
        onReRunSetup={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Local AI" }));
    const field = screen.getByLabelText("AI temperature") as HTMLInputElement;
    expect(field.value).toBe("0.5");

    fireEvent.change(field, { target: { value: "0.7" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        llm: expect.objectContaining({ temperature: 0.7 }),
      }),
    );

    // Clearing the field falls back to the default (persisted as null).
    fireEvent.change(field, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenLastCalledWith(
      expect.objectContaining({
        llm: expect.objectContaining({ temperature: null }),
      }),
    );
  });

  it("switches between the settings pages", () => {
    render(
      <SettingsDialog
        settings={baseSettings}
        onSave={() => {}}
        onClose={() => {}}
        onReRunSetup={() => {}}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Folders & language" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Glossary" }));
    expect(
      screen.getByRole("heading", { name: "Glossary" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "About" }));
    expect(
      screen.getByRole("heading", { name: "Stardew i18n Translator" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Version 1.0.1")).toBeInTheDocument();
    expect(screen.getByText("GPL-3.0-or-later")).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Shortcuts" })).toBeNull();
  });

  it("opens the repository from About", () => {
    render(
      <SettingsDialog
        settings={baseSettings}
        onSave={() => {}}
        onClose={() => {}}
        onReRunSetup={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "About" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Open project on GitHub ↗" }),
    );
    expect(invokeMock).toHaveBeenCalledWith("open_url", {
      url: "https://github.com/Nana1873/stardew-i18n-translator",
    });
  });

  it("shows a retryable diagnostic when the AI connection fails", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "glossary_status")
        return Promise.resolve({ unpackedPresent: false, cached: null });
      if (cmd === "llm_models")
        return Promise.reject("Connection refused (ECONNREFUSED)");
      return Promise.resolve(null);
    });

    render(
      <SettingsDialog
        settings={baseSettings}
        onSave={() => {}}
        onClose={() => {}}
        onReRunSetup={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Local AI" }));
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Connection refused (ECONNREFUSED)",
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("distinguishes a reachable server with no loaded models", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "glossary_status")
        return Promise.resolve({ unpackedPresent: false, cached: null });
      if (cmd === "llm_models") return Promise.resolve([]);
      return Promise.resolve(null);
    });

    render(
      <SettingsDialog
        settings={baseSettings}
        onSave={() => {}}
        onClose={() => {}}
        onReRunSetup={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Local AI" }));
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "server reports no loaded models",
    );
  });
});
