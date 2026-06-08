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
      default:
        return Promise.resolve(null);
    }
  });
});

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
