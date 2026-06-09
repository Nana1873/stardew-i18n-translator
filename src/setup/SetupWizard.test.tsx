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
        return Promise.resolve({ unpackedPresent: false, cached: null });
      case "build_glossary":
        return Promise.resolve({ targetLang: "de", termCount: 42 });
      default:
        return Promise.resolve(null);
    }
  });
});

async function gotoGlossaryStep() {
  fireEvent.click(screen.getByRole("button", { name: "Auto-detect" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Next" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Next" })); // step 2
  await waitFor(() => expect(screen.getByRole("button", { name: "Next" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Next" })); // step 3
  fireEvent.change(screen.getByLabelText("Target language"), { target: { value: "de" } });
  fireEvent.click(screen.getByRole("button", { name: "Next" })); // step 4
}

describe("SetupWizard", () => {
  it("auto-detect fills the path and enables Next", async () => {
    render(<SetupWizard initial={null} onComplete={() => {}} />);

    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Auto-detect" }));

    expect(await screen.findByText("E:/SDV")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Next" })).toBeEnabled(),
    );
  });

  it("walks all steps and completes; skipping AI leaves llm null", async () => {
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
    fireEvent.click(screen.getByRole("button", { name: "Next" })); // step 5: AI
    fireEvent.click(screen.getByRole("button", { name: "Finish" }));

    expect(onComplete).toHaveBeenCalledWith({
      stardewPath: "E:/SDV",
      modsPath: "E:/SDV/Mods",
      sourceLang: "default",
      targetLang: "de",
      llm: null,
    });
  });

  it("tests the local-AI connection and persists the chosen model", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "detect_stardew":
          return Promise.resolve({ stardewPath: "E:/SDV", modsPath: "E:/SDV/Mods", source: "steam" });
        case "default_mods_path":
          return Promise.resolve("E:/SDV/Mods");
        case "validate_stardew_path":
          return Promise.resolve(true);
        case "glossary_status":
          return Promise.resolve({ unpackedPresent: false, cached: null });
        case "llm_models":
          return Promise.resolve(["llama3.1:8b", "qwen2.5"]);
        default:
          return Promise.resolve(null);
      }
    });
    const onComplete = vi.fn();
    render(<SetupWizard initial={null} onComplete={onComplete} />);
    await gotoGlossaryStep();
    fireEvent.click(screen.getByRole("button", { name: "Next" })); // step 5: AI

    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    // First model is auto-selected after a successful test.
    expect(await screen.findByText(/2 models available/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Finish" }));
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        llm: {
          provider: "lmstudio",
          baseUrl: "http://localhost:1234/v1",
          model: "llama3.1:8b",
        },
      }),
    );
  });

  it("shows StardewXnbHack guidance when no unpacked content is present", async () => {
    render(<SetupWizard initial={null} onComplete={() => {}} />);
    await gotoGlossaryStep();

    expect(
      await screen.findByRole("button", { name: /Get StardewXnbHack/ }),
    ).toBeInTheDocument();
  });

  it("builds the glossary when unpacked content is present", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "detect_stardew":
          return Promise.resolve({ stardewPath: "E:/SDV", modsPath: "E:/SDV/Mods", source: "steam" });
        case "default_mods_path":
          return Promise.resolve("E:/SDV/Mods");
        case "validate_stardew_path":
          return Promise.resolve(true);
        case "glossary_status":
          return Promise.resolve({ unpackedPresent: true, cached: null });
        case "build_glossary":
          return Promise.resolve({ targetLang: "de", termCount: 42 });
        default:
          return Promise.resolve(null);
      }
    });
    render(<SetupWizard initial={null} onComplete={() => {}} />);
    await gotoGlossaryStep();

    fireEvent.click(await screen.findByRole("button", { name: "Build glossary" }));
    expect(await screen.findByText(/42 terms/)).toBeInTheDocument();
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
