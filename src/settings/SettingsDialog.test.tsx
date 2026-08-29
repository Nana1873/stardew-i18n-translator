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

    // The reset control falls back to the backend default (persisted as null).
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

  it("locks every settings control while persistence is pending", async () => {
    const pending = deferred<void>();
    const onSave = vi.fn(() => pending.promise);
    render(
      <SettingsDialog
        settings={baseSettings}
        onSave={onSave}
        onClose={() => {}}
        onReRunSetup={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());

    const dialog = screen.getByRole("dialog", { name: "Settings" });
    expect(dialog).toHaveAttribute("aria-busy", "true");
    const controls = dialog.querySelectorAll<HTMLElement>(
      "button, input, select, textarea",
    );
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) expect(control).toBeDisabled();

    pending.resolve(undefined);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Save changes" }),
      ).toBeEnabled(),
    );
    expect(screen.getByLabelText("Target language")).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Close settings" }),
    ).toBeEnabled();
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

  it("does not present an unavailable glossary as a ready state", async () => {
    render(
      <SettingsDialog
        settings={baseSettings}
        onSave={() => {}}
        onClose={() => {}}
        onReRunSetup={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Glossary" }));
    const unavailable = await screen.findByText("Glossary unavailable");
    expect(unavailable.closest(".translator-glossary-summary")).not.toHaveClass(
      "is-ready",
    );
  });

  it("formats glossary term counts for the English UI", async () => {
    const localeSpy = vi
      .spyOn(Number.prototype, "toLocaleString")
      .mockReturnValue("1.185");
    try {
      invokeMock.mockImplementation((cmd: string) => {
        if (cmd === "glossary_status")
          return Promise.resolve({
            gameXnbPresent: true,
            unpackedPresent: true,
            sourceAvailable: true,
            cached: {
              targetLang: "de",
              termCount: 1185,
              source: "official",
            },
            outdatedCache: false,
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
      expect(await screen.findByText("1,185")).toBeInTheDocument();
      expect(
        screen.getByText(
          /1,185 terms · optional and not included in a release/,
        ),
      ).toBeInTheDocument();
      expect(screen.queryByText("1.185")).toBeNull();
    } finally {
      localeSpy.mockRestore();
    }
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

  it("opens the requested page and exposes the complete navigation", () => {
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
    expect(
      container.querySelector(".translator-settings-dialog"),
    ).not.toBeNull();
    expect(
      container.querySelector(".translator-settings-layout"),
    ).not.toBeNull();
  });

  it("keeps an available saved Codex model and exposes the CLI catalog", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "glossary_status") return Promise.resolve(null);
      if (cmd === "codex_cli_status")
        return Promise.resolve({
          installed: true,
          authenticated: true,
          version: "1.2.3",
          authentication: "ChatGPT account",
        });
      if (cmd === "codex_cli_models")
        return Promise.resolve([
          {
            model: "gpt-5.6-sol",
            displayName: "GPT-5.6-Sol",
            isDefault: true,
            defaultReasoningEffort: "low",
            supportedReasoningEfforts: ["low", "medium", "high"],
          },
          {
            model: "gpt-5.5",
            displayName: "GPT-5.5",
            isDefault: false,
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: ["low", "medium", "high"],
          },
        ]);
      if (cmd === "codex_cli_rate_limits")
        return Promise.resolve({
          primary: {
            usedPercent: 25,
            windowDurationMins: 300,
            resetsAt: 1_730_947_200,
          },
          secondary: {
            usedPercent: 43,
            windowDurationMins: 10_080,
            resetsAt: 1_731_552_000,
          },
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
            codexModel: "gpt-5.5",
            codexReasoning: "high",
            codexQualityReview: true,
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
    expect(screen.getByLabelText("Codex model")).toHaveValue("gpt-5.5");
    expect(screen.getByLabelText("Codex model")).toHaveTextContent(
      "GPT-5.6-Sol",
    );
    expect(screen.getByLabelText("Codex reasoning")).toHaveValue("high");
    expect(screen.getByText("ChatGPT account")).toBeVisible();
    expect(screen.getByText("Usage remaining")).toBeVisible();
    expect(screen.getByText(/5 h: 75% remaining/)).toBeVisible();
    expect(screen.getByText(/7 d: 57% remaining/)).toBeVisible();
    expect(screen.getByText(/resets \d{1,2} Nov, \d{2}:\d{2}/)).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Check status" }));
    await waitFor(() =>
      expect(
        invokeMock.mock.calls.filter(([cmd]) => cmd === "codex_cli_status"),
      ).toHaveLength(2),
    );
    await waitFor(() =>
      expect(
        invokeMock.mock.calls.filter(([cmd]) => cmd === "codex_cli_models"),
      ).toHaveLength(2),
    );
    await waitFor(() =>
      expect(
        invokeMock.mock.calls.filter(
          ([cmd]) => cmd === "codex_cli_rate_limits",
        ),
      ).toHaveLength(2),
    );

    fireEvent.change(screen.getByLabelText("Codex model"), {
      target: { value: "gpt-5.6-sol" },
    });
    expect(screen.getByLabelText("Codex model")).toHaveValue("gpt-5.6-sol");

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        ai: {
          defaultEngine: "codex",
          codexModel: "gpt-5.6-sol",
          codexReasoning: "high",
          codexQualityReview: true,
        },
      }),
    );
  });

  it("defaults Codex quality review on and warns before saving first-draft mode", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "glossary_status") return Promise.resolve(null);
      if (cmd === "codex_cli_status")
        return Promise.resolve({ installed: true, authenticated: true });
      if (cmd === "codex_cli_models") return Promise.resolve([]);
      if (cmd === "codex_cli_rate_limits") return Promise.resolve(null);
      return Promise.resolve(null);
    });
    const onSave = vi.fn();
    render(
      <SettingsDialog
        settings={{
          ...baseSettings,
          ai: {
            defaultEngine: "codex",
            codexReasoning: "medium",
          } as unknown as NonNullable<AppSettings["ai"]>,
        }}
        initialPage="ai"
        onSave={onSave}
        onClose={() => {}}
        onReRunSetup={() => {}}
      />,
    );

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Check status" }),
      ).toBeEnabled(),
    );

    const qualityReview = screen.getByRole("checkbox", {
      name: "AI quality review and repairs",
    });
    expect(qualityReview).toBeChecked();
    expect(
      screen.getByText(/Reviews meaning, natural language, terminology/),
    ).toHaveTextContent(
      "Reviews meaning, natural language, terminology, grammar, register, speaker voice, and dialogue continuity, then applies focused terminology and protected-token repairs when needed.",
    );
    expect(
      screen.queryByRole("note", { name: "First draft quality warning" }),
    ).toBeNull();

    fireEvent.click(qualityReview);
    expect(qualityReview).not.toBeChecked();
    const warning = screen.getByRole("note", {
      name: "First draft quality warning",
    });
    expect(warning).toHaveTextContent("faster and uses fewer tokens");
    expect(warning).toHaveTextContent(
      "Drafts may contain wording, terminology, grammar, register, speaker voice, dialogue continuity, or protected-token errors",
    );
    expect(warning).toHaveTextContent(
      "Validation still runs and every result still enters Review",
    );

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        ai: {
          defaultEngine: "codex",
          codexModel: null,
          codexReasoning: "medium",
          codexQualityReview: false,
        },
      }),
    );
  });

  it("announces asynchronous Codex status updates and errors", async () => {
    const pendingStatus = deferred<{
      installed: boolean;
      authenticated: boolean;
      error?: string;
    }>();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "glossary_status") return Promise.resolve(null);
      if (cmd === "codex_cli_status") return pendingStatus.promise;
      return Promise.resolve(null);
    });

    render(
      <SettingsDialog
        settings={baseSettings}
        initialPage="ai"
        onSave={() => {}}
        onClose={() => {}}
        onReRunSetup={() => {}}
      />,
    );
    fireEvent.click(screen.getByText("Codex CLI").closest("button")!);

    const checking = screen.getByRole("status");
    expect(checking).toHaveTextContent("Checking the installed Codex CLI…");
    expect(checking).toHaveAttribute("aria-live", "polite");
    expect(checking).toHaveAttribute("aria-atomic", "true");

    pendingStatus.resolve({
      installed: false,
      authenticated: false,
      error: "Codex CLI status failed.",
    });

    const error = await screen.findByRole("alert");
    expect(error).toHaveTextContent("Codex CLI status failed.");
    expect(error).toHaveAttribute("aria-live", "assertive");
    expect(error).toHaveAttribute("aria-atomic", "true");
  });

  it("shows rate-limit loading until Codex CLI reports usage", async () => {
    const pendingLimits = deferred<{
      primary: {
        usedPercent: number;
        windowDurationMins: number;
        resetsAt: number;
      };
    } | null>();

    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "glossary_status") return Promise.resolve(null);
      if (cmd === "codex_cli_status")
        return Promise.resolve({
          installed: true,
          authenticated: true,
          authentication: "ChatGPT account",
        });
      if (cmd === "codex_cli_models") return Promise.resolve([]);
      if (cmd === "codex_cli_rate_limits") return pendingLimits.promise;
      return Promise.resolve(null);
    });

    render(
      <SettingsDialog
        settings={{
          ...baseSettings,
          ai: {
            defaultEngine: "codex",
            codexReasoning: "medium",
            codexQualityReview: true,
          },
        }}
        initialPage="ai"
        onSave={() => {}}
        onClose={() => {}}
        onReRunSetup={() => {}}
      />,
    );

    expect(
      await screen.findByText("Reading ChatGPT limits from Codex CLI…"),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Checking…" })).toBeDisabled();

    pendingLimits.resolve({
      primary: {
        usedPercent: 20,
        windowDurationMins: 300,
        resetsAt: 1_730_947_200,
      },
    });

    expect(await screen.findByText(/5 h: 80% remaining/)).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Check status" }),
    ).not.toBeDisabled();
  });

  it("shows only the rate-limit details reported by Codex CLI", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "glossary_status") return Promise.resolve(null);
      if (cmd === "codex_cli_status")
        return Promise.resolve({
          installed: true,
          authenticated: true,
          authentication: "ChatGPT",
        });
      if (cmd === "codex_cli_models") return Promise.resolve([]);
      if (cmd === "codex_cli_rate_limits")
        return Promise.resolve({ primary: { usedPercent: 12.4 } });
      return Promise.resolve(null);
    });

    render(
      <SettingsDialog
        settings={baseSettings}
        initialPage="ai"
        onSave={() => {}}
        onClose={() => {}}
        onReRunSetup={() => {}}
      />,
    );

    fireEvent.click(screen.getByText("Codex CLI").closest("button")!);

    const usage = (await screen.findByText("Usage remaining")).closest(
      ".translator-setting-line",
    )!;
    await waitFor(() => expect(usage).toHaveTextContent("88% remaining"));
    expect(usage).not.toHaveTextContent("resets");
    expect(usage).not.toHaveTextContent("7 d");
  });

  it("does not request ChatGPT limits for API-key billing", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "glossary_status") return Promise.resolve(null);
      if (cmd === "codex_cli_status")
        return Promise.resolve({
          installed: true,
          authenticated: true,
          authentication: "API key",
        });
      if (cmd === "codex_cli_models") return Promise.resolve([]);
      return Promise.resolve(null);
    });

    render(
      <SettingsDialog
        settings={baseSettings}
        initialPage="ai"
        onSave={() => {}}
        onClose={() => {}}
        onReRunSetup={() => {}}
      />,
    );

    fireEvent.click(screen.getByText("Codex CLI").closest("button")!);

    expect(await screen.findByText("Usage remaining")).toBeVisible();
    expect(screen.getByText("Not reported for API-key billing")).toBeVisible();
    expect(
      invokeMock.mock.calls.some(([cmd]) => cmd === "codex_cli_rate_limits"),
    ).toBe(false);
  });

  it("keeps Codex ready with the CLI default when its model list is unavailable", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "glossary_status") return Promise.resolve(null);
      if (cmd === "codex_cli_status")
        return Promise.resolve({ installed: true, authenticated: true });
      if (cmd === "codex_cli_models")
        return Promise.reject(new Error("model list unavailable"));
      return Promise.resolve(null);
    });
    const onSave = vi.fn();
    render(
      <SettingsDialog
        settings={{
          ...baseSettings,
          ai: {
            defaultEngine: "codex",
            codexReasoning: "medium",
            codexQualityReview: true,
          },
        }}
        initialPage="ai"
        onSave={onSave}
        onClose={() => {}}
        onReRunSetup={() => {}}
      />,
    );

    await waitFor(() =>
      expect(screen.getByLabelText("Codex model")).toBeDisabled(),
    );
    expect(screen.getByLabelText("Codex model")).toHaveValue("");
    expect(screen.getByText(/using the CLI default/i)).toBeVisible();
    expect(screen.getByText("Codex CLI").closest("button")).toHaveTextContent(
      "Ready",
    );
    expect(screen.getByText("Usage remaining")).toBeVisible();
    expect(screen.getByText("Not reported by this Codex CLI")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        ai: {
          defaultEngine: "codex",
          codexModel: null,
          codexReasoning: "medium",
          codexQualityReview: true,
        },
      }),
    );
  });

  it("automatically selects Codex when Local AI is not configured", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "glossary_status") return Promise.resolve(null);
      if (cmd === "codex_cli_status")
        return Promise.resolve({ installed: true, authenticated: true });
      if (cmd === "codex_cli_models")
        return Promise.resolve([
          {
            model: "gpt-5.6-terra",
            displayName: "GPT-5.6-Terra",
            isDefault: false,
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: ["low", "medium", "high"],
          },
          {
            model: "gpt-5.6-sol",
            displayName: "GPT-5.6-Sol",
            isDefault: true,
            defaultReasoningEffort: "low",
            supportedReasoningEfforts: ["low", "medium", "high"],
          },
        ]);
      return Promise.resolve(null);
    });
    render(
      <SettingsDialog
        settings={{
          ...baseSettings,
          ai: {
            defaultEngine: "local",
            codexModel: "retired-model",
            codexReasoning: "medium",
            codexQualityReview: true,
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
      expect(screen.getByLabelText("Codex model")).toHaveValue("gpt-5.6-sol");
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
        ai: {
          defaultEngine: "local",
          codexModel: null,
          codexReasoning: "medium",
          codexQualityReview: true,
        },
      }),
    );
  });

  it("shows the official setup guide when Codex CLI is unavailable", async () => {
    render(
      <SettingsDialog
        settings={baseSettings}
        initialPage="ai"
        onSave={() => {}}
        onClose={() => {}}
        onReRunSetup={() => {}}
      />,
    );
    fireEvent.click(screen.getByText("Codex CLI").closest("button")!);

    const guide = await screen.findByRole("note", {
      name: "Codex CLI setup guide",
    });
    expect(guide).toHaveTextContent("Set up Codex CLI");
    expect(guide).toHaveTextContent("Install or update Codex CLI for Windows");
    expect(guide).toHaveTextContent("Sign in with ChatGPT");
    expect(guide).toHaveTextContent(
      "ChatGPT sign-in uses the account's current plan and its limits",
    );
    expect(guide).toHaveTextContent(
      "API-key sign-in uses separate usage-based billing",
    );
    expect(guide).not.toHaveTextContent("A ChatGPT account is required");
    expect(screen.queryByText("Usage remaining")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Open Codex setup guide" }),
    );
    expect(invokeMock).toHaveBeenCalledWith("open_url", {
      url: "https://learn.chatgpt.com/docs/codex/cli",
    });
  });

  it("shows only the sign-in steps when Codex CLI is installed", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "glossary_status") return Promise.resolve(null);
      if (cmd === "codex_cli_status")
        return Promise.resolve({
          installed: true,
          authenticated: false,
          error: "Codex CLI is not signed in. Run `codex login` first.",
        });
      return Promise.resolve(null);
    });
    render(
      <SettingsDialog
        settings={baseSettings}
        initialPage="ai"
        onSave={() => {}}
        onClose={() => {}}
        onReRunSetup={() => {}}
      />,
    );
    fireEvent.click(screen.getByText("Codex CLI").closest("button")!);

    const guide = await screen.findByRole("note", {
      name: "Codex CLI setup guide",
    });
    expect(guide).toHaveTextContent("Finish Codex CLI setup");
    expect(guide).toHaveTextContent("Sign in with ChatGPT");
    expect(guide).not.toHaveTextContent("Install or update Codex CLI");
  });

  it.each([
    "This Codex CLI version does not support the isolated translation mode required by the app. Update Codex CLI.",
    "Codex CLI did not answer the login-status check in time.",
  ])(
    "shows recovery guidance for an installed unavailable CLI: %s",
    async (error) => {
      invokeMock.mockImplementation((cmd: string) => {
        if (cmd === "glossary_status") return Promise.resolve(null);
        if (cmd === "codex_cli_status")
          return Promise.resolve({
            installed: true,
            authenticated: false,
            error,
          });
        return Promise.resolve(null);
      });
      render(
        <SettingsDialog
          settings={baseSettings}
          initialPage="ai"
          onSave={() => {}}
          onClose={() => {}}
          onReRunSetup={() => {}}
        />,
      );
      fireEvent.click(screen.getByText("Codex CLI").closest("button")!);

      const guide = await screen.findByRole("note", {
        name: "Codex CLI setup guide",
      });
      expect(guide).toHaveTextContent("Check Codex CLI setup");
      expect(guide).toHaveTextContent(
        "Run codex in PowerShell and confirm it responds",
      );
      expect(guide).not.toHaveTextContent("Finish Codex CLI setup");
    },
  );

  it("includes the Ctrl+F string-search shortcut", () => {
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
