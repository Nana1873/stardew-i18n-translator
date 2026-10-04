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
    fireEvent.click(screen.getByRole("button", { name: "Browse..." }));
    await screen.findByText("E:/OtherGame");
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    await act(async () => finishValidation(false));
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    expect(
      screen.getByText(/does not look like a Stardew Valley folder/),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Browse..." })).toBeEnabled();
  });
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
    });
  });

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
    expect(
      screen.getByRole("region", { name: "How the glossary works" }),
    ).toHaveTextContent("Read locally");
    expect(screen.getByText(/never changed or uploaded/)).toBeInTheDocument();
  });

  it("offers no glossary for a game-unsupported language (Thai)", async () => {
    render(<SetupWizard initial={null} onComplete={() => {}} />);
    await gotoGlossaryStep("th");

    expect(
      await screen.findByText(
        /No local glossary source was found for this language/i,
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
              unpackedPresent: false,
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
      expect(
        await screen.findByText("Cached glossary available"),
      ).toBeVisible();
      expect(screen.getByText(/7 cached terms remain available/)).toBeVisible();
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
