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

  it("allows every advertised target language to be selected and saved", () => {
    const onSave = vi.fn();
    render(
      <SettingsDialog
        settings={baseSettings}
        onSave={onSave}
        onClose={() => {}}
        onReRunSetup={() => {}}
      />,
    );

    const select = screen.getByLabelText("Target language");
    const save = screen.getByRole("button", { name: "Save" });
    for (const code of [
      "de",
      "es",
      "fr",
      "hu",
      "it",
      "ja",
      "ko",
      "pt",
      "ru",
      "tr",
      "zh",
    ]) {
      fireEvent.change(select, { target: { value: code } });
      fireEvent.click(save);
      expect(onSave).toHaveBeenLastCalledWith(
        expect.objectContaining({ targetLang: code }),
      );
    }
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
    expect(screen.getByText("Version 1.1.1")).toBeInTheDocument();
    expect(screen.getByText("GPL-3.0-or-later")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Shortcuts" })).toBeInTheDocument();

    // Diagnostics: the logs-folder button bridges to the backend command so a
    // user can attach a log file to a bug report.
    fireEvent.click(screen.getByRole("button", { name: /Open logs folder/ }));
    expect(invokeMock).toHaveBeenCalledWith("open_logs_dir", undefined);
  });

  it("captures, validates, resets, and saves shortcut overrides", () => {
    const onSave = vi.fn();
    render(
      <SettingsDialog
        settings={baseSettings}
        onSave={onSave}
        onClose={() => {}}
        onReRunSetup={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Shortcuts" }));
    const saveShortcut = screen.getByRole("button", {
      name: "Change Save and close",
    });
    fireEvent.click(saveShortcut);
    fireEvent.keyDown(saveShortcut, { key: "s", ctrlKey: true });
    expect(saveShortcut).toHaveTextContent("Ctrl+S");

    const saveNextShortcut = screen.getByRole("button", {
      name: "Change Save and open next",
    });
    fireEvent.click(saveNextShortcut);
    fireEvent.keyDown(saveNextShortcut, { key: "s", ctrlKey: true });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Already assigned to “Save and close”",
    );
    expect(saveNextShortcut).toHaveTextContent("Press keys…");

    fireEvent.click(
      screen.getByRole("button", { name: "Reset Save and close" }),
    );
    expect(saveShortcut).toHaveTextContent("Ctrl+Enter");

    fireEvent.click(saveShortcut);
    fireEvent.keyDown(saveShortcut, { key: "s", ctrlKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        shortcuts: { "editor.save": "Ctrl+S" },
      }),
    );
  });

  it("resets every shortcut to its default", () => {
    const onSave = vi.fn();
    render(
      <SettingsDialog
        settings={{
          ...baseSettings,
          shortcuts: { "editor.save": "Ctrl+S", "editor.reset": "F8" },
        }}
        onSave={onSave}
        onClose={() => {}}
        onReRunSetup={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Shortcuts" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset all" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ shortcuts: {} }),
    );
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
