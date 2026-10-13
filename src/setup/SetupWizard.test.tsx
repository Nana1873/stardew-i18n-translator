import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
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

/** The Setup dialog is named by its visible heading. */
const SETUP_DIALOG =
  /^(Welcome to Stardew i18n Translator|Configure your workspace)$/;

describe("SetupWizard", () => {
  it("groups target languages by whether the game includes them", async () => {
    render(<SetupWizard initial={null} onComplete={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Auto-detect" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Next" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Next" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    const select = screen.getByLabelText("Target language");
    const groups = [...select.querySelectorAll("optgroup")];
    expect(groups.map((group) => group.label)).toEqual([
      "In the game",
      "Needs a language mod in the game",
    ]);
    expect(groups[0]).toHaveTextContent("German (de)");
    expect(groups[1]).toHaveTextContent("Thai (th)");
    expect(groups[0]).not.toHaveTextContent("Thai (th)");
  });

  it("does not reuse a previous folder validation while a new folder is being checked", async () => {
    let finishValidation!: (valid: boolean) => void;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "pick_folder") return Promise.resolve("E:/OtherGame");
      if (cmd === "validate_stardew_path")
        return new Promise<boolean>((resolve) => {
          finishValidation = resolve;
        });
      return Promise.resolve(null);
    });
    render(
      <SetupWizard
        initial={{
          stardewPath: "E:/SDV",
          modsPath: "E:/SDV/Mods",
          sourceLang: "default",
          targetLang: "de",
        }}
        onComplete={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Next" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Browse…" }));
    await screen.findByText("E:/OtherGame");
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    await act(async () => finishValidation(false));
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    expect(
      screen.getByText(/does not look like a Stardew Valley folder/),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Browse…" })).toBeEnabled();
  });
  it("presents the four setup steps and updates visible progress", async () => {
    render(<SetupWizard initial={null} onComplete={() => {}} />);

    expect(
      screen.getByRole("heading", {
        name: "Welcome to Stardew i18n Translator",
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Setup steps" })).toHaveTextContent(
      "Game folder",
    );
    expect(screen.getByText("Step 1 of 4 · Game folder")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Auto-detect" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Next" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(screen.getByText("Step 2 of 4 · Mods folder")).toBeInTheDocument();
    expect(
      screen.getByText("Game folder").closest(".translator-setup-step"),
    ).toHaveAttribute("data-state", "complete");
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
    });
  });

  it("keeps setup open when saving fails", async () => {
    const onComplete = vi.fn().mockRejectedValue(new Error("cannot save"));
    render(<SetupWizard initial={null} onComplete={onComplete} />);
    await gotoGlossaryStep();

    fireEvent.click(screen.getByRole("button", { name: "Finish" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("cannot save");
    const setup = screen.getByRole("dialog", { name: SETUP_DIALOG });
    expect(setup).toBeVisible();
    expect(setup).toHaveAccessibleName("Welcome to Stardew i18n Translator");
    expect(setup).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("button", { name: "Finish" })).toBeEnabled();
  });

  it("asks to check the game folder when the game Strings are missing", async () => {
    render(<SetupWizard initial={null} onComplete={() => {}} />);
    await gotoGlossaryStep();

    expect(
      await screen.findByText(
        /The game's text files \(Content\/Strings\) were not found\. Check the Stardew Valley folder/,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /StardewXnbHack/ })).toBeNull();
    expect(
      screen.getByRole("heading", { name: "Add a glossary" }),
    ).toBeVisible();
    expect(screen.getByText(/never changed or uploaded/)).toBeInTheDocument();
  });

  it("offers no glossary for a game-unsupported language (Thai)", async () => {
    render(<SetupWizard initial={null} onComplete={() => {}} />);
    await gotoGlossaryStep("th");

    expect(
      await screen.findByText(
        /doesn.t include this language, so no official glossary/i,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Build glossary" })).toBeNull();
  });

  it.each([false, true])(
    "keeps a cached community glossary usable when its pack is missing (source available: %s)",
    async (sourceAvailable) => {
      const originalInvoke = invokeMock.getMockImplementation()!;
      invokeMock.mockImplementation((cmd: string) =>
        cmd === "glossary_status"
          ? Promise.resolve({
              gameXnbPresent: sourceAvailable,
              sourceAvailable,
              cached: {
                targetLang: "th",
                termCount: 7,
                source: "communityPack",
                packName: "Thai",
              },
              outdatedCache: false,
              packAvailable: false,
              packXnbAvailable: false,
            })
          : originalInvoke(cmd),
      );
      render(<SetupWizard initial={null} onComplete={() => {}} />);
      await gotoGlossaryStep("th");
      expect(await screen.findByText("Glossary ready")).toBeVisible();
      expect(screen.getByText("7")).toBeVisible();
      expect(
        screen.getByText(
          sourceAvailable
            ? /needs the community language pack/
            : /needs the game.s text files/,
        ),
      ).toBeVisible();
      expect(screen.getByRole("button", { name: "Finish" })).toBeEnabled();
      expect(screen.queryByText("No glossary for this language")).toBeNull();
    },
  );

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

    expect(
      await screen.findByText("Glossary is up to date"),
    ).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(screen.getAllByText(/Stardew Valley - THAI/).length).toBeGreaterThan(
      0,
    );
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

    expect(
      await screen.findByText("Glossary is up to date"),
    ).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
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
