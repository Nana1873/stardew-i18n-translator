import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));

import { SetupWizard } from "./SetupWizard";

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd: string) => {
    switch (cmd) {
      case "detect_stardew":
        return Promise.resolve({
          stardewPath: "E:/SDV",
          modsPath: "E:/SDV/Mods",
          source: "steam",
        });
      case "default_mods_path":
        return Promise.resolve("E:/SDV/Mods");
      case "validate_stardew_path":
        return Promise.resolve(true);
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
      case "build_glossary":
        return Promise.resolve({ targetLang: "de", termCount: 42 });
      default:
        return Promise.resolve(null);
    }
  });
});

async function gotoGlossaryStep(lang = "de") {
  fireEvent.click(screen.getByRole("button", { name: "Auto-detect" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Next" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Next" })); // step 2
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Next" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Next" })); // step 3
  fireEvent.change(screen.getByLabelText("Target language"), {
    target: { value: lang },
  });
  fireEvent.click(screen.getByRole("button", { name: "Next" })); // step 4
}

describe("SetupWizard", () => {
  it("presents the four setup steps and updates visible progress", async () => {
    render(<SetupWizard initial={null} onComplete={() => {}} />);

    expect(
      screen.getByRole("heading", {
        name: "Welcome to Stardew i18n Translator",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("navigation", { name: "Setup steps" }),
    ).toHaveTextContent("Game folder");
    expect(
      screen.getByRole("progressbar", { name: "Setup progress" }),
    ).toHaveAttribute("aria-valuenow", "1");

    fireEvent.click(screen.getByRole("button", { name: "Auto-detect" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Next" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(
      screen.getByRole("progressbar", { name: "Setup progress" }),
    ).toHaveAttribute("aria-valuenow", "2");
    expect(screen.getByText("Game folder").closest(".setup__step")).toHaveClass(
      "setup__step--complete",
    );
  });

  it("auto-detect fills the path and enables Next", async () => {
    render(<SetupWizard initial={null} onComplete={() => {}} />);

    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Auto-detect" }));

    expect(await screen.findByText("E:/SDV")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Next" })).toBeEnabled(),
    );
  });

  it("walks all 4 steps and completes with the chosen target language", async () => {
    const onComplete = vi.fn();
    render(<SetupWizard initial={null} onComplete={onComplete} />);

    fireEvent.click(screen.getByRole("button", { name: "Auto-detect" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Next" })).toBeEnabled(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Next" })); // step 2: mods
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Next" })).toBeEnabled(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Next" })); // step 3: languages
    fireEvent.change(screen.getByLabelText("Target language"), {
      target: { value: "de" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Next" })); // step 4: glossary
    fireEvent.click(screen.getByRole("button", { name: "Finish" }));

    expect(onComplete).toHaveBeenCalledWith({
      stardewPath: "E:/SDV",
      modsPath: "E:/SDV/Mods",
      sourceLang: "default",
      targetLang: "de",
      vortexExecutable: null,
      installationMethod: "folder",
    });
  });

  it.each([null, "C:/Detected/Vortex.exe"])(
    "saves Vortex detection result %s only with Finish",
    async (detected) => {
      const original = invokeMock.getMockImplementation()!;
      invokeMock.mockImplementation((cmd: string, ...args: unknown[]) =>
        cmd === "detect_vortex_executable"
          ? Promise.resolve(detected)
          : original(cmd, ...args),
      );
      const onComplete = vi.fn();
      render(
        <SetupWizard
          initial={{
            stardewPath: "E:/SDV",
            modsPath: "E:/SDV/Mods",
            sourceLang: "default",
            targetLang: "de",
            diagnosticLogging: false,
          }}
          onComplete={onComplete}
        />,
      );
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Next" })).toBeEnabled(),
      );
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
      fireEvent.change(screen.getByLabelText("Installation method"), {
        target: { value: "vortex" },
      });
      await waitFor(() =>
        expect(invokeMock).toHaveBeenCalledWith(
          "detect_vortex_executable",
          undefined,
        ),
      );
      await waitFor(() =>
        expect(screen.getByLabelText("Vortex executable")).toHaveTextContent(
          detected ?? "Not selected",
        ),
      );
      expect(onComplete).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
      fireEvent.click(screen.getByRole("button", { name: "Finish" }));
      expect(onComplete).toHaveBeenCalledWith(
        expect.objectContaining({
          installationMethod: "vortex",
          vortexExecutable: detected,
          diagnosticLogging: false,
        }),
      );
      expect(
        invokeMock.mock.calls.some(([cmd]) =>
          /nexus_save_key|nexus_handoff/.test(cmd),
        ),
      ).toBe(false);
    },
  );

  it("keeps setup open when saving fails", async () => {
    const onComplete = vi.fn().mockRejectedValue(new Error("cannot save"));
    render(<SetupWizard initial={null} onComplete={onComplete} />);
    await gotoGlossaryStep();

    fireEvent.click(screen.getByRole("button", { name: "Finish" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("cannot save");
    expect(screen.getByRole("dialog", { name: "Setup" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Finish" })).toBeEnabled();
  });

  it("shows StardewXnbHack guidance when no unpacked content is present", async () => {
    render(<SetupWizard initial={null} onComplete={() => {}} />);
    await gotoGlossaryStep();

    expect(
      await screen.findByRole("button", { name: "Open StardewXnbHack" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByText("How the glossary works"));
    expect(
      screen.getByRole("region", { name: "How the glossary works" }),
    ).toHaveTextContent("Read locally");
    expect(screen.getByText(/never changed or uploaded/)).toBeInTheDocument();
  });

  it("offers no glossary for a game-unsupported language (Thai)", async () => {
    render(<SetupWizard initial={null} onComplete={() => {}} />);
    await gotoGlossaryStep("th");

    expect(
      await screen.findByText(/Stardew Valley doesn’t include this language/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Build glossary" })).toBeNull();
  });

  it("auto-builds from community pack for an unsupported language with a detected pack", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "detect_stardew":
          return Promise.resolve({
            stardewPath: "E:/SDV",
            modsPath: "E:/SDV/Mods",
            source: "steam",
          });
        case "default_mods_path":
          return Promise.resolve("E:/SDV/Mods");
        case "validate_stardew_path":
          return Promise.resolve(true);
        case "glossary_status":
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
        case "build_glossary":
          return Promise.resolve({
            targetLang: "th",
            termCount: 7,
            source: "communityPack",
            packName: "Stardew Valley - THAI",
          });
        default:
          return Promise.resolve(null);
      }
    });

    render(<SetupWizard initial={null} onComplete={() => {}} />);
    await gotoGlossaryStep("th");

    expect(await screen.findByText(/7 official terms/)).toBeInTheDocument();
    expect(screen.getByText(/Stardew Valley - THAI/)).toBeInTheDocument();
  });

  it("auto-builds the glossary when a game string source is present", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "detect_stardew":
          return Promise.resolve({
            stardewPath: "E:/SDV",
            modsPath: "E:/SDV/Mods",
            source: "steam",
          });
        case "default_mods_path":
          return Promise.resolve("E:/SDV/Mods");
        case "validate_stardew_path":
          return Promise.resolve(true);
        case "glossary_status":
          return Promise.resolve({
            gameXnbPresent: true,
            unpackedPresent: true,
            sourceAvailable: true,
            cached: null,
            outdatedCache: false,
            packAvailable: false,
            packXnbAvailable: false,
          });
        case "build_glossary":
          return Promise.resolve({ targetLang: "de", termCount: 42 });
        default:
          return Promise.resolve(null);
      }
    });
    render(<SetupWizard initial={null} onComplete={() => {}} />);
    await gotoGlossaryStep();

    expect(await screen.findByText(/42 official terms/)).toBeInTheDocument();
  });

  it("offers Cancel only when settings already exist", () => {
    const { rerender } = render(
      <SetupWizard initial={null} onComplete={() => {}} />,
    );
    expect(
      screen.queryByRole("button", { name: "Cancel" }),
    ).not.toBeInTheDocument();

    rerender(
      <SetupWizard
        initial={{
          stardewPath: "E:/SDV",
          modsPath: "E:/SDV/Mods",
          sourceLang: "default",
          targetLang: "de",
        }}
        onComplete={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });
});

it("validates a new Nexus key on Finish before completing setup", async () => {
  const onComplete = vi.fn();
  render(<SetupWizard initial={null} onComplete={onComplete} />);
  await gotoGlossaryStep();
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  fireEvent.change(screen.getByLabelText("Nexus API key"), {
    target: { value: "synthetic-key" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(screen.queryByLabelText("Nexus API key")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Finish" }));
  await waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
  expect(invokeMock).toHaveBeenCalledWith("nexus_save_key", {
    key: "synthetic-key",
  });
  expect(JSON.stringify(onComplete.mock.calls)).not.toContain("synthetic-key");
});

it("keeps setup open when a typed Nexus key cannot be validated", async () => {
  const fallback = invokeMock.getMockImplementation()!;
  invokeMock.mockImplementation((cmd: string, args: unknown) =>
    cmd === "nexus_save_key"
      ? Promise.reject("synthetic-key")
      : fallback(cmd, args),
  );
  const onComplete = vi.fn();
  render(<SetupWizard initial={null} onComplete={onComplete} />);
  await gotoGlossaryStep();
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  fireEvent.change(screen.getByLabelText("Nexus API key"), {
    target: { value: "synthetic-key" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(screen.queryByLabelText("Nexus API key")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Finish" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "previous key is kept",
  );
  expect(onComplete).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog", { name: "Setup" })).toBeInTheDocument();
  expect(
    screen.getByRole("progressbar", { name: "Setup progress" }),
  ).toHaveAttribute("aria-valuenow", "2");
  expect(screen.getByLabelText("Nexus API key")).toHaveValue("synthetic-key");
});

it("places the optional key beside the deployed Mods folder and preserves a saved key on Cancel", async () => {
  const onCancel = vi.fn();
  const fallback = invokeMock.getMockImplementation()!;
  invokeMock.mockImplementation((cmd: string, args: unknown) =>
    cmd === "nexus_status"
      ? Promise.resolve({ configured: true, validated: false, premium: false })
      : fallback(cmd, args),
  );
  render(
    <SetupWizard
      initial={{
        stardewPath: "E:/SDV",
        modsPath: "E:/SDV/Mods",
        installationMethod: "vortex",
        sourceLang: "default",
        targetLang: "de",
      }}
      onComplete={() => {}}
      onCancel={onCancel}
    />,
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Next" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(screen.getByText("Deployed game Mods folder")).toBeInTheDocument();
  expect(
    screen.getByText(/not Vortex's staging or downloads folder/),
  ).toBeInTheDocument();
  expect(screen.getByLabelText("Nexus API key")).toHaveAttribute(
    "placeholder",
    "••••••••",
  );
  expect(screen.getByLabelText("Nexus API key")).toHaveValue("");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onCancel).toHaveBeenCalledOnce();
  expect(invokeMock.mock.calls.some(([cmd]) => cmd === "nexus_save_key")).toBe(
    false,
  );
});

it("keeps manual folder selection and resets content scroll and focus between steps", async () => {
  const original = invokeMock.getMockImplementation()!;
  invokeMock.mockImplementation((cmd: string, ...args: unknown[]) =>
    cmd === "pick_folder"
      ? Promise.resolve("C:/Synthetic/Stardew Valley")
      : original(cmd, ...args),
  );
  render(<SetupWizard initial={null} onComplete={() => {}} />);
  fireEvent.click(
    screen.getByRole("button", { name: "Browse Stardew Valley folder" }),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Next" })).toBeEnabled(),
  );
  const content = screen.getByRole("region", { name: "Setup step content" });
  content.scrollTop = 160;
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await waitFor(() => expect(content).toHaveFocus());
  expect(content.scrollTop).toBe(0);
  expect(
    screen.getByRole("button", { name: "Browse Mods folder" }),
  ).toHaveTextContent("Change");
  expect(screen.getByRole("region", { name: "Installation" })).toHaveClass(
    "translator-settings-group",
  );
  expect(
    screen.getByRole("region", { name: "Optional Nexus setup" }),
  ).toHaveClass("setup__nexus-card");
  expect(
    screen.queryByText(/experimental build|This choice controls/),
  ).toBeNull();
  expect(screen.getByLabelText("Nexus API key")).toHaveAttribute(
    "type",
    "password",
  );
});

it("includes glossary help in the modal keyboard focus loop", async () => {
  render(<SetupWizard initial={null} onComplete={() => {}} />);
  await gotoGlossaryStep();
  await screen.findByRole("button", { name: "Open StardewXnbHack" });
  const finish = screen.getByRole("button", { name: "Finish" });
  const summary = screen.getByText("How the glossary works");
  finish.focus();
  fireEvent.keyDown(finish, { key: "Tab" });
  expect(summary).toHaveFocus();
  fireEvent.keyDown(summary, { key: "Tab", shiftKey: true });
  expect(finish).toHaveFocus();
});
