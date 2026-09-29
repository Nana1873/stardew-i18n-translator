import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, afterAll, expect, it, vi } from "vitest";
import type { AppSettings } from "../tauri/commands";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.stubEnv("VITE_CHATGPT_PROTOTYPE", "1");
const { SettingsDialog } = await import("./SettingsDialog");
const commands = await import("../tauri/commands");
afterAll(() => vi.unstubAllEnvs());

const settings: AppSettings = {
  stardewPath: null,
  modsPath: null,
  sourceLang: "default",
  targetLang: "de",
  llm: null,
  ai: {
    defaultEngine: "chatgpt",
    codexModel: "account-model",
    codexReasoning: "medium",
    codexQualityReview: true,
  },
};
beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation((command: string) => {
    if (command === "cloud_ai_status")
      return Promise.resolve({ installed: true, authenticated: true });
    if (command === "cloud_ai_models")
      return Promise.resolve([
        {
          model: "account-model",
          displayName: "Account model",
          isDefault: true,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: ["low", "medium", "high"],
        },
      ]);
    return Promise.resolve(null);
  });
});

it("uses website commands, ChatGPT preferences and reasoning without CLI setup or quota calls", async () => {
  expect(commands.CLOUD_ENGINE_ID).toBe("chatgpt");
  const onSave = vi.fn();
  render(
    <SettingsDialog
      settings={settings}
      onSave={onSave}
      onClose={() => {}}
      onReRunSetup={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole("tab", { name: "Translation engines" }));
  await screen.findByRole("button", { name: "Sign out" });
  fireEvent.click(screen.getByRole("button", { name: /ChatGPT.*Ready/ }));
  await screen.findByRole("option", { name: /Account model.*account-model/ });
  expect(
    screen.getByText("Authenticated by ChatGPT browser sign-in"),
  ).toBeVisible();
  expect(screen.queryByLabelText("Codex CLI setup guide")).toBeNull();
  expect(screen.queryByText(/Codex CLI/)).toBeNull();
  expect(
    screen.queryByText(/local prototype|credentials stay in memory/i),
  ).toBeNull();
  fireEvent.change(screen.getByLabelText("ChatGPT reasoning"), {
    target: { value: "high" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() =>
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        ai: expect.objectContaining({
          defaultEngine: "chatgpt",
          codexModel: "account-model",
          codexReasoning: "high",
        }),
      }),
    ),
  );
  expect(
    invokeMock.mock.calls.some(([command]) =>
      /codex|cli|rate_limits/.test(command),
    ),
  ).toBe(false);
  await commands.chatgptPrototypeSignIn();
  await commands.chatgptPrototypeSignOut();
  expect(invokeMock).toHaveBeenCalledWith("chatgpt_sign_in");
  expect(invokeMock).toHaveBeenCalledWith("chatgpt_sign_out");
});

it("asks for browser sign-in when no session exists", async () => {
  invokeMock.mockImplementation((command: string) =>
    Promise.resolve(
      command === "cloud_ai_status"
        ? { installed: true, authenticated: false }
        : null,
    ),
  );
  render(
    <SettingsDialog
      settings={settings}
      onSave={() => {}}
      onClose={() => {}}
      onReRunSetup={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole("tab", { name: "Translation engines" }));
  await screen.findByRole("button", { name: "Sign in with ChatGPT" });
  expect(screen.queryByText(/Codex CLI/)).toBeNull();
  expect(invokeMock).not.toHaveBeenCalledWith("cloud_ai_models");
});
