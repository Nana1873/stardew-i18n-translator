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
          unpackedPresent: false,
          cached: null,
          outdatedCache: false,
        });
      case "build_glossary":
        return Promise.resolve({ targetLang: "de", termCount: 42 });
      default:
        return Promise.resolve(null);
    }
  });
});

async function gotoGlossaryStep() {
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
    target: { value: "de" },
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
    });
  });

  it("shows StardewXnbHack guidance when no unpacked content is present", async () => {
    render(<SetupWizard initial={null} onComplete={() => {}} />);
    await gotoGlossaryStep();

    expect(
      await screen.findByRole("button", { name: "Open StardewXnbHack" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "How the glossary works" }),
    ).toHaveTextContent("Unpack once");
    expect(screen.getByText(/never changed or uploaded/)).toBeInTheDocument();
  });

  it("builds the glossary when unpacked content is present", async () => {
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
            unpackedPresent: true,
            cached: null,
            outdatedCache: false,
          });
        case "build_glossary":
          return Promise.resolve({ targetLang: "de", termCount: 42 });
        default:
          return Promise.resolve(null);
      }
    });
    render(<SetupWizard initial={null} onComplete={() => {}} />);
    await gotoGlossaryStep();

    fireEvent.click(
      await screen.findByRole("button", { name: "Build glossary" }),
    );
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
