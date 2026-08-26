import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));

import { SettingsDialog } from "./SettingsDialog";
import type { AppSettings } from "../tauri/commands";
import packageInfo from "../../package.json";

const baseSettings: AppSettings = {
  stardewPath: "E:/SDV",
  modsPath: "E:/SDV/Mods",
  sourceLang: "default",
  targetLang: "de",
  llm: null,
  diagnosticLogging: true,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd: string) => {
    switch (cmd) {
      case "glossary_status":
        return Promise.resolve({
          gameXnbPresent: false,
          unpackedPresent: false,
          sourceAvailable: false,
          cached: null,
          outdatedCache: false,
          packAvailable: false,
          packXnbAvailable: false,
        });
      case "llm_models":
        return Promise.resolve(["llama3.1:8b", "qwen2.5"]);
      case "codex_cli_status":
        return Promise.resolve({ installed: false, authenticated: false });
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
    fireEvent.click(screen.getByRole("button", { name: "Setup …" }));
    expect(onReRunSetup).toHaveBeenCalled();
  });

  it("changes each folder with its native picker and saves only the chosen paths", async () => {
    const onSave = vi.fn();
    const onReRunSetup = vi.fn();
    invokeMock.mockImplementation((cmd: string, args?: unknown) => {
      if (cmd === "glossary_status") return Promise.resolve(null);
      if (cmd === "pick_folder") {
        return Promise.resolve(
          (args as { title?: string }).title ===
            "Select your Stardew Valley folder"
            ? "D:/Games/Stardew Valley"
            : "D:/Games/Stardew Valley/Mods",
        );
      }
      return Promise.resolve(null);
    });

    render(
      <SettingsDialog
        settings={baseSettings}
        onSave={onSave}
        onClose={() => {}}
        onReRunSetup={onReRunSetup}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Change Stardew Valley folder" }),
    );
    expect(
      await screen.findByText("D:/Games/Stardew Valley"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Change Mods folder" }));
    expect(
      await screen.findByText("D:/Games/Stardew Valley/Mods"),
    ).toBeInTheDocument();

    expect(invokeMock).toHaveBeenCalledWith("pick_folder", {
      title: "Select your Stardew Valley folder",
    });
    expect(invokeMock).toHaveBeenCalledWith("pick_folder", {
      title: "Select your Mods folder",
    });
    expect(onReRunSetup).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        stardewPath: "D:/Games/Stardew Valley",
        modsPath: "D:/Games/Stardew Valley/Mods",
      }),
    );
  });

  it("keeps the current folder when the native picker is cancelled", async () => {
    const onSave = vi.fn();
    const onReRunSetup = vi.fn();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "glossary_status") return Promise.resolve(null);
      if (cmd === "pick_folder") return Promise.resolve(null);
      return Promise.resolve(null);
    });

    render(
      <SettingsDialog
        settings={baseSettings}
        onSave={onSave}
        onClose={() => {}}
        onReRunSetup={onReRunSetup}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Change Mods folder" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("pick_folder", {
        title: "Select your Mods folder",
      }),
    );
    expect(screen.getByText("E:/SDV/Mods")).toBeInTheDocument();
    expect(onReRunSetup).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ modsPath: "E:/SDV/Mods" }),
    );
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

    fireEvent.click(screen.getByRole("tab", { name: "Translation engines" }));
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(
      await screen.findByText(/Connected · responded in/),
    ).toBeInTheDocument();
    expect(screen.getByText(/2 models available/)).toBeInTheDocument();
    expect(screen.getByLabelText("AI model").tagName).toBe("SELECT");

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
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

  it("resets a saved LM Studio URL and clears its endpoint-bound model", async () => {
    const onSave = vi.fn();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "glossary_status") return Promise.resolve(null);
      if (cmd === "llm_models") return Promise.resolve(["legacy-model"]);
      return Promise.resolve(null);
    });

    render(
      <SettingsDialog
        settings={{
          ...baseSettings,
          llm: {
            provider: "lmstudio",
            baseUrl: "http://localhost:9999/v1",
            model: "legacy-model",
          },
        }}
        onSave={onSave}
        onClose={() => {}}
        onReRunSetup={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Translation engines" }));
    expect(screen.getByLabelText("AI base URL")).toHaveValue(
      "http://localhost:9999/v1",
    );
    expect(screen.getByLabelText("AI model")).toHaveValue("legacy-model");

    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(
      await screen.findByText(/Connected · responded in/),
    ).toBeInTheDocument();

    const reset = screen.getByRole("button", {
      name: "Reset AI base URL to default",
    });
    expect(reset).toHaveAttribute("title", "Reset to http://localhost:1234/v1");
    fireEvent.click(reset);

    expect(screen.getByLabelText("AI base URL")).toHaveValue(
      "http://localhost:1234/v1",
    );
    expect(screen.getByLabelText("AI model")).toBeDisabled();
    expect(screen.getByLabelText("AI model")).toHaveValue("");
    expect(screen.queryByText(/Connected · responded in/)).toBeNull();
    expect(reset).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        llm: null,
      }),
    );
  });

  it("resets a saved Ollama URL to the Ollama default", () => {
    render(
      <SettingsDialog
        settings={{
          ...baseSettings,
          llm: {
            provider: "ollama",
            baseUrl: "http://localhost:9999/v1",
            model: "legacy-model",
          },
        }}
        onSave={() => {}}
        onClose={() => {}}
        onReRunSetup={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Translation engines" }));
    const reset = screen.getByRole("button", {
      name: "Reset AI base URL to default",
    });
    expect(reset).toHaveAttribute(
      "title",
      "Reset to http://localhost:11434/v1",
    );

    fireEvent.click(reset);

    expect(screen.getByLabelText("AI base URL")).toHaveValue(
      "http://localhost:11434/v1",
    );
    expect(screen.getByLabelText("AI base URL")).not.toHaveValue(
      "http://localhost:1234/v1",
    );
    expect(reset).toBeDisabled();
  });

  it("disables reset for a custom endpoint and explains why", () => {
    render(
      <SettingsDialog
        settings={{
          ...baseSettings,
          llm: {
            provider: "custom",
            baseUrl: "http://localhost:9999/v1",
            model: "custom-model",
          },
        }}
        onSave={() => {}}
        onClose={() => {}}
        onReRunSetup={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Translation engines" }));
    const reset = screen.getByRole("button", {
      name: "Reset AI base URL to default",
    });

    expect(reset).toBeDisabled();
    expect(reset).toHaveAttribute(
      "title",
      "Custom endpoints have no default URL",
    );
    expect(screen.getByLabelText("AI base URL")).toHaveValue(
      "http://localhost:9999/v1",
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
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ llm: null }));
  });

  it("allows every advertised target language to be selected and saved", async () => {
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
    const save = screen.getByRole("button", { name: "Save changes" });
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
      await waitFor(() =>
        expect(onSave).toHaveBeenLastCalledWith(
          expect.objectContaining({ targetLang: code }),
        ),
      );
      await waitFor(() => expect(save).toBeEnabled());
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
        initialPage="ai"
        onSave={onSave}
        onClose={() => {}}
        onReRunSetup={() => {}}
      />,
    );
    expect(screen.getByLabelText("AI model")).toHaveValue("qwen2.5");
    expect(screen.getByText("Local AI").closest("button")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
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
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Save changes" }),
      ).toBeEnabled(),
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

    fireEvent.click(screen.getByRole("tab", { name: "Translation engines" }));
    const field = screen.getByLabelText("AI temperature") as HTMLInputElement;
    expect(field.value).toBe("0.5");

    fireEvent.change(field, { target: { value: "0.7" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        llm: expect.objectContaining({ temperature: 0.7 }),
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Save changes" }),
      ).toBeEnabled(),
    );

    // The V3 reset control falls back to the backend default (persisted as null).
    fireEvent.click(screen.getByRole("button", { name: "Use default" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSave).toHaveBeenLastCalledWith(
      expect.objectContaining({
        llm: expect.objectContaining({ temperature: null }),
      }),
    );
  });

  it("keeps settings open when persistence fails", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("settings locked"));
    const onClose = vi.fn();
    render(
      <SettingsDialog
        settings={baseSettings}
        onSave={onSave}
        onClose={onClose}
        onReRunSetup={() => {}}
      />,
    );

    fireEvent.change(screen.getByLabelText("Target language"), {
      target: { value: "fr" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "settings locked",
    );
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeVisible();
    expect(screen.getByLabelText("Target language")).toHaveValue("fr");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("ignores a connection result after the URL changes", async () => {
    const pending = deferred<string[]>();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "llm_models") return pending.promise;
      if (cmd === "glossary_status") return Promise.resolve(null);
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

    fireEvent.click(screen.getByRole("tab", { name: "Translation engines" }));
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    fireEvent.change(screen.getByLabelText("AI base URL"), {
      target: { value: "http://localhost:9999/v1" },
    });
    pending.resolve(["stale-model"]);

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("llm_models", expect.anything()),
    );
    expect(screen.queryByText(/Connected/)).toBeNull();
    expect(screen.queryByText("stale-model")).toBeNull();
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
    expect(screen.getByRole("heading", { name: "About" })).toBeInTheDocument();
    expect(screen.getByText(packageInfo.version)).toBeInTheDocument();
    expect(
      screen.getByText("Author & license").parentElement,
    ).toHaveTextContent("GPL-3.0-or-later");
    expect(screen.getByRole("tab", { name: "Shortcuts" })).toBeInTheDocument();

    // Diagnostics: the logs-folder button bridges to the backend command so a
    // user can attach a log file to a bug report.
    fireEvent.click(screen.getByRole("button", { name: "Open logs" }));
    expect(invokeMock).toHaveBeenCalledWith("open_logs_dir", undefined);
  });

  it("moves vertical tabs with arrows, Home, and End", () => {
    render(
      <SettingsDialog
        settings={baseSettings}
        onSave={() => {}}
        onClose={() => {}}
        onReRunSetup={() => {}}
      />,
    );

    const folders = screen.getByRole("tab", { name: "Folders & language" });
    folders.focus();
    fireEvent.keyDown(folders, { key: "ArrowDown" });
    expect(
      screen.getByRole("tab", { name: "Translation engines" }),
    ).toHaveFocus();
    expect(
      screen.getByRole("heading", { name: "Translation engines" }),
    ).toBeVisible();

    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(screen.getByRole("tab", { name: "About" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(folders).toHaveFocus();
    fireEvent.keyDown(folders, { key: "ArrowUp" });
    expect(screen.getByRole("tab", { name: "About" })).toHaveFocus();
  });

  it("saves the local diagnostic logging preference", () => {
    const onSave = vi.fn();
    render(
      <SettingsDialog
        settings={baseSettings}
        onSave={onSave}
        onClose={() => {}}
        onReRunSetup={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "About" }));
    const logging = screen.getByRole("checkbox", {
      name: "Enable local diagnostic logging",
    });
    expect(logging).toBeChecked();
    fireEvent.click(logging);
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ diagnosticLogging: false }),
    );
  });

  it("defaults missing diagnostic settings to enabled", () => {
    render(
      <SettingsDialog
        settings={{ ...baseSettings, diagnosticLogging: undefined }}
        onSave={() => {}}
        onClose={() => {}}
        onReRunSetup={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "About" }));
    expect(
      screen.getByRole("checkbox", {
        name: "Enable local diagnostic logging",
      }),
    ).toBeChecked();
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
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ shortcuts: {} }),
    );
  });

  it("does not restore one default shortcut when another command uses it", () => {
    render(
      <SettingsDialog
        settings={{
          ...baseSettings,
          shortcuts: {
            "table.search": "Ctrl+G",
            "table.edit": "Ctrl+F",
          },
        }}
        onSave={() => {}}
        onClose={() => {}}
        onReRunSetup={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Shortcuts" }));
    const searchShortcut = screen.getByRole("button", {
      name: "Change Focus string search",
    });
    expect(searchShortcut).toHaveTextContent("Ctrl+G");

    fireEvent.click(
      screen.getByRole("button", { name: "Reset Focus string search" }),
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Ctrl+F is already assigned to “Edit string”",
    );
    expect(searchShortcut).toHaveTextContent("Ctrl+G");
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
    fireEvent.click(screen.getByRole("button", { name: "GitHub" }));
    expect(invokeMock).toHaveBeenCalledWith("open_url", {
      url: "https://github.com/Nana1873/stardew-i18n-translator",
    });
  });

  it("recommends a rebuild when an old/invalid glossary cache is present", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "glossary_status")
        return Promise.resolve({
          gameXnbPresent: true,
          unpackedPresent: true,
          sourceAvailable: true,
          cached: null,
          outdatedCache: true,
          packAvailable: false,
          packXnbAvailable: false,
        });
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

    fireEvent.click(screen.getByRole("tab", { name: "Glossary" }));
    expect(await screen.findByText(/rebuild recommended/i)).toBeInTheDocument();
  });

  it("offers Build for a game-supported language with unpacked content", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "glossary_status")
        return Promise.resolve({
          gameXnbPresent: true,
          unpackedPresent: true,
          sourceAvailable: true,
          cached: null,
          outdatedCache: false,
          packAvailable: false,
          packXnbAvailable: false,
        });
      return Promise.resolve(null);
    });

    render(
      <SettingsDialog
        settings={baseSettings} // targetLang "de" — natively supported
        onSave={() => {}}
        onClose={() => {}}
        onReRunSetup={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Glossary" }));
    expect(
      await screen.findByRole("button", { name: "Build glossary" }),
    ).toBeInTheDocument();
  });

  it("shows no glossary and no Build button for an unsupported language (Thai)", async () => {
    render(
      <SettingsDialog
        settings={{ ...baseSettings, targetLang: "th" }}
        onSave={() => {}}
        onClose={() => {}}
        onReRunSetup={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Glossary" }));
    expect(
      await screen.findByText(/Stardew Valley doesn’t include this language/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Build glossary" })).toBeNull();
  });

  it("offers Build from community pack for an unsupported language when a pack is detected", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "glossary_status")
        return Promise.resolve({
          gameXnbPresent: true,
          unpackedPresent: true,
          sourceAvailable: true,
          cached: null,
          outdatedCache: false,
          packAvailable: true,
          packXnbAvailable: false,
          packName: "Stardew Valley - THAI",
        });
      return Promise.resolve(null);
    });

    render(
      <SettingsDialog
        settings={{ ...baseSettings, targetLang: "th" }}
        onSave={() => {}}
        onClose={() => {}}
        onReRunSetup={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Glossary" }));
    expect(
      await screen.findByRole("button", {
        name: "Build from community pack",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Stardew Valley - THAI/)).toBeInTheDocument();
    // The dead-end "no glossary" message must NOT be shown when a pack exists.
    expect(
      screen.queryByText(/so no official glossary is available/i),
    ).toBeNull();
  });

  it("shows a retryable diagnostic when the AI connection fails", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "glossary_status")
        return Promise.resolve({
          gameXnbPresent: false,
          unpackedPresent: false,
          sourceAvailable: false,
          cached: null,
          outdatedCache: false,
          packAvailable: false,
          packXnbAvailable: false,
        });
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

    fireEvent.click(screen.getByRole("tab", { name: "Translation engines" }));
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Connection refused (ECONNREFUSED)",
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("distinguishes a reachable server with no loaded models", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "glossary_status")
        return Promise.resolve({
          gameXnbPresent: false,
          unpackedPresent: false,
          sourceAvailable: false,
          cached: null,
          outdatedCache: false,
          packAvailable: false,
          packXnbAvailable: false,
        });
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

    fireEvent.click(screen.getByRole("tab", { name: "Translation engines" }));
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "server reports no loaded models",
    );
  });

  it("opens the requested V3 page and exposes the complete V3 navigation", () => {
    const { container } = render(
      <SettingsDialog
        settings={baseSettings}
        initialPage="ai"
        onSave={() => {}}
        onClose={() => {}}
        onReRunSetup={() => {}}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Translation engines" }),
    ).toBeVisible();
    expect(
      screen.getByText(
        /two preceding and two following English strings as read-only context/i,
      ),
    ).toBeVisible();
    expect(screen.getAllByRole("tab")).toHaveLength(5);
    expect(container.querySelector(".stv3-settings-dialog")).not.toBeNull();
    expect(container.querySelector(".stv3-settings-layout")).not.toBeNull();
  });

  it("keeps an available saved Codex default and uses the CLI default model", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "glossary_status") return Promise.resolve(null);
      if (cmd === "codex_cli_status")
        return Promise.resolve({
          installed: true,
          authenticated: true,
          version: "1.2.3",
          authentication: "ChatGPT account",
        });
      return Promise.resolve(null);
    });
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
          ai: {
            defaultEngine: "codex",
            codexReasoning: "high",
          },
        }}
        initialPage="ai"
        onSave={onSave}
        onClose={() => {}}
        onReRunSetup={() => {}}
      />,
    );

    const codex = screen.getByText("Codex CLI").closest("button")!;
    expect(codex).not.toHaveAttribute("aria-disabled");
    await waitFor(() => {
      expect(codex).toHaveTextContent("Ready · 1.2.3");
      expect(codex).toHaveAttribute("aria-pressed", "true");
    });
    expect(screen.getByText("Local AI").closest("button")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByRole("region", { name: "Codex CLI" })).toBeVisible();
    expect(screen.queryByLabelText("Codex model")).toBeNull();
    expect(screen.getByLabelText("Codex reasoning")).toHaveValue("high");
    expect(screen.getByText("ChatGPT account")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Check status" }));
    await waitFor(() =>
      expect(
        invokeMock.mock.calls.filter(([cmd]) => cmd === "codex_cli_status"),
      ).toHaveLength(2),
    );

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        ai: {
          defaultEngine: "codex",
          codexReasoning: "high",
        },
      }),
    );
  });

  it("automatically selects Codex when Local AI is not configured", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "glossary_status") return Promise.resolve(null);
      if (cmd === "codex_cli_status")
        return Promise.resolve({ installed: true, authenticated: true });
      return Promise.resolve(null);
    });
    render(
      <SettingsDialog
        settings={{
          ...baseSettings,
          ai: {
            defaultEngine: "local",
            codexReasoning: "medium",
          },
        }}
        initialPage="ai"
        onSave={() => {}}
        onClose={() => {}}
        onReRunSetup={() => {}}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Codex CLI").closest("button")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(screen.getByRole("region", { name: "Codex CLI" })).toBeVisible();
    });
    expect(screen.getByText("Local AI").closest("button")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    fireEvent.click(screen.getByText("Local AI").closest("button")!);
    expect(screen.getByText("Local AI").closest("button")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByText("Codex CLI").closest("button")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByRole("region", { name: "Local AI" })).toBeVisible();
    expect(screen.queryByText("OpenAI API")).toBeNull();
    expect(
      invokeMock.mock.calls.some(([cmd]) => String(cmd).startsWith("openai_")),
    ).toBe(false);
  });

  it("highlights unavailable engine settings without saving them as the default", async () => {
    const onSave = vi.fn();
    render(
      <SettingsDialog
        settings={baseSettings}
        initialPage="ai"
        onSave={onSave}
        onClose={() => {}}
        onReRunSetup={() => {}}
      />,
    );

    const local = screen.getByText("Local AI").closest("button")!;
    const codex = screen.getByText("Codex CLI").closest("button")!;
    await waitFor(() => expect(codex).toHaveTextContent("Not installed"));
    expect(local).toHaveAttribute("aria-pressed", "true");
    expect(codex).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(codex);
    expect(screen.getByRole("region", { name: "Codex CLI" })).toBeVisible();
    expect(codex).toHaveAttribute("aria-pressed", "true");
    expect(local).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        ai: { defaultEngine: "local", codexReasoning: "medium" },
      }),
    );
  });

  it("includes the accepted Ctrl+F string-search shortcut", () => {
    render(
      <SettingsDialog
        settings={baseSettings}
        initialPage="shortcuts"
        onSave={() => {}}
        onClose={() => {}}
        onReRunSetup={() => {}}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Change Focus string search" }),
    ).toHaveTextContent("Ctrl+F");
  });

  it("traps Tab, contains shortcuts, closes on Escape, and restores focus", async () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    const bubbled = vi.fn();
    document.body.addEventListener("keydown", bubbled);
    const onClose = vi.fn();
    const { unmount } = render(
      <SettingsDialog
        settings={baseSettings}
        onSave={() => {}}
        onClose={onClose}
        onReRunSetup={() => {}}
      />,
    );

    await waitFor(() =>
      expect(
        screen.getByRole("tab", { name: "Folders & language" }),
      ).toHaveFocus(),
    );
    const first = screen.getByRole("button", { name: "Close settings" });
    const last = screen.getByRole("button", { name: "Save changes" });
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(first).toHaveFocus();
    expect(bubbled).not.toHaveBeenCalled();

    fireEvent.keyDown(first, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    unmount();
    expect(trigger).toHaveFocus();

    document.body.removeEventListener("keydown", bubbled);
    trigger.remove();
  });
});
