import { StrictMode, useState } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { vi } from "vitest";
import { ActivityLog } from "./ActivityLog";
import {
  appendActivity,
  operationActivity,
  reportActivity,
  type ActivityBuffer,
  type AiActivityUpdate,
  type ManualSaveActivity,
} from "./activity";
import type { OperationHistoryEntry } from "../tauri/commands";

const operation: OperationHistoryEntry = {
  id: "import-1",
  kind: "import",
  outcome: "warning",
  title: "LLM batch imported",
  summary: "3 suggestions staged for review.",
  itemCount: 3,
  canUndo: true,
  warnings: ["An empty value was skipped."],
  completedAtEpochMs: 1000,
  details: [
    { label: "Component", value: "a.b" },
    { label: "Local translations preserved", value: "2" },
    { label: "Skipped empty values", value: "1" },
  ],
};
const props = {
  lastScanAt: null,
  modCount: 1,
  totalStrings: 3,
  language: "German (de)",
  scanning: false,
  warningCount: 0,
  skippedCount: 0,
  scanError: null,
  history: [] as OperationHistoryEntry[],
  modNames: new Map([["a.b", "Test mod"]]),
  height: 106,
  onHeightChange: vi.fn(),
  onDetails: vi.fn(),
};
const save: ManualSaveActivity = {
  identity: "first",
  modUniqueId: "a.b",
  modName: "Test mod",
  key: "first",
  acceptedMismatch: false,
};
beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

it("animates only each batch's current step, keeps history static, and ignores stale run cleanup", async () => {
  render(<ActivityLog {...props} />);
  const log = screen.getByRole("log");
  const update = (detail: Omit<AiActivityUpdate, "time">) =>
    act(() => {
      window.dispatchEvent(
        new CustomEvent("translator-ai-activity", {
          detail: { time: 1000, ...detail },
        }),
      );
    });
  update({
    runId: "first",
    activeSteps: ["first:1:translating", "first:2:reviewing"],
    entries: [
      {
        message: "Batch 1 · Translating draft · 86 strings",
        aiStep: "first:1:translating",
      },
      {
        message: "Batch 2 · Checking translation quality · 86 strings",
        aiStep: "first:2:reviewing",
      },
    ],
  });
  expect(within(log).getAllByRole("img", { name: "In progress" })).toHaveLength(
    2,
  );
  update({ runId: "first", activeSteps: ["first:2:reviewing"], entries: [] });
  expect(log.querySelectorAll("p")).toHaveLength(2);
  expect(within(log).getAllByRole("img", { name: "In progress" })).toHaveLength(
    1,
  );
  update({
    runId: "first",
    activeSteps: ["first:1:translating"],
    entries: [
      {
        message: "Batch 1 · Translating draft · 86 strings",
        aiStep: "first:1:translating",
      },
    ],
  });
  const repeated = within(log).getAllByText(/Batch 1 · Translating draft/);
  expect(repeated[0]).not.toHaveAttribute("data-ai-active");
  expect(repeated[1]).toHaveAttribute("data-ai-active", "true");
  fireEvent.click(screen.getByRole("button", { name: "Copy log" }));
  await screen.findByRole("button", { name: "Copied" });
  const copied = vi.mocked(navigator.clipboard.writeText).mock.calls[0][0];
  expect(copied).not.toMatch(/In progress|\.\.\./);
  update({
    runId: "second",
    activeSteps: ["second:1:preparing"],
    entries: [
      {
        message: "Batch 1 · Preparing batch · 2 strings",
        aiStep: "second:1:preparing",
      },
    ],
  });
  update({ runId: "first", activeSteps: [], entries: [] });
  expect(within(log).getAllByRole("img", { name: "In progress" })).toHaveLength(
    1,
  );
  expect(within(log).getByText(/Preparing batch/)).toHaveAttribute(
    "data-ai-active",
    "true",
  );
  update({ runId: "second", activeSteps: [], entries: [] });
  expect(within(log).queryByRole("img", { name: "In progress" })).toBeNull();
});

it("groups distinct manual saves without recording translation text or losing explicit acceptance", () => {
  let buffer: ActivityBuffer = { entries: [], omitted: 0 };
  buffer = appendActivity(buffer, { kind: "save", save }, 1000, 1);
  buffer = appendActivity(
    buffer,
    { kind: "save", save: { ...save, identity: "second" } },
    2000,
    2,
  );
  buffer = appendActivity(
    buffer,
    { kind: "save", save: { ...save, identity: "second" } },
    3000,
    3,
  );
  expect(buffer.entries).toHaveLength(1);
  expect(buffer.entries[0].message).toBe("2 translations saved · Test mod");
  buffer = appendActivity(
    buffer,
    { kind: "save", save: { ...save, acceptedMismatch: true } },
    3100,
    4,
  );
  expect(buffer.entries[1]).toMatchObject({
    tone: "warning",
    message:
      "Translation saved · Test mod · first · Token mismatch accepted; export allowed.",
  });
  buffer = appendActivity(buffer, { kind: "save", save }, 3200, 5);
  expect(buffer.entries).toHaveLength(3);
});

it("does not group across mods or after a pause", () => {
  let buffer: ActivityBuffer = { entries: [], omitted: 0 };
  buffer = appendActivity(buffer, { kind: "save", save }, 1000, 1);
  buffer = appendActivity(
    buffer,
    { kind: "save", save: { ...save, modUniqueId: "other" } },
    1100,
    2,
  );
  buffer = appendActivity(
    buffer,
    { kind: "save", save: { ...save, modUniqueId: "other" } },
    6200,
    3,
  );
  expect(buffer.entries).toHaveLength(3);
});

it("keeps early warnings through a long run, bounds memory, and reports omissions", () => {
  let buffer: ActivityBuffer = { entries: [], omitted: 0 };
  buffer = appendActivity(
    buffer,
    { kind: "message", message: "Important warning", tone: "warning" },
    1,
    1,
  );
  for (let id = 2; id <= 650; id++)
    buffer = appendActivity(
      buffer,
      { kind: "message", message: `Batch progress ${id}`, tone: "info" },
      id,
      id,
    );
  expect(buffer.entries).toHaveLength(500);
  expect(buffer.entries[0].message).toBe("Important warning");
  expect(buffer.entries.at(-1)?.message).toBe("Batch progress 650");
  expect(buffer.omitted).toBe(150);
  for (let id = 651; id <= 1250; id++)
    buffer = appendActivity(
      buffer,
      { kind: "message", message: `Failure ${id}`, tone: "error" },
      id,
      id,
    );
  expect(buffer.entries).toHaveLength(500);
  expect(buffer.entries.at(-1)?.message).toBe("Failure 1250");
  expect(buffer.entries[0].message).toBe("Failure 751");
});

it("includes actual import counts and mod identity with an immutable operation reference", () => {
  const event = operationActivity(operation, props.modNames);
  expect(event).toMatchObject({
    tone: "warning",
    message:
      "LLM batch imported · Test mod · warning: 3 suggestions staged for review. Local translations preserved: 2 · Skipped empty values: 1.",
    details: { kind: "operation", entry: { id: "import-1", canUndo: false } },
  });
  expect(operation.canUndo).toBe(true);
});

it("records repeated notifications and several operations once even with StrictMode or refreshed history", () => {
  const { rerender } = render(
    <StrictMode>
      <ActivityLog {...props} history={[operation]} />
    </StrictMode>,
  );
  const log = screen.getByRole("log");
  expect(within(log).getAllByText(/LLM batch imported/)).toHaveLength(1);
  rerender(
    <StrictMode>
      <ActivityLog {...props} history={[{ ...operation, canUndo: false }]} />
    </StrictMode>,
  );
  expect(within(log).getAllByText(/LLM batch imported/)).toHaveLength(1);
  act(() => {
    reportActivity({
      kind: "message",
      message: "Clipboard failed",
      tone: "error",
    });
    reportActivity({
      kind: "message",
      message: "Clipboard failed",
      tone: "error",
    });
  });
  expect(within(log).getAllByText(/Clipboard failed/)).toHaveLength(2);
});

it("keeps details tied to the older operation after the latest result changes", () => {
  const { rerender } = render(<ActivityLog {...props} history={[operation]} />);
  const original = within(screen.getByRole("log")).getByRole("button", {
    name: /Details: LLM batch imported/,
  });
  rerender(
    <ActivityLog
      {...props}
      history={[{ ...operation, id: "import-2", summary: "New result." }]}
    />,
  );
  fireEvent.click(original);
  expect(props.onDetails).toHaveBeenCalledWith({
    kind: "operation",
    entry: { ...operation, canUndo: false },
  });
});

it("only links the matching latest scan and does not duplicate a scan in StrictMode", () => {
  const { rerender } = render(
    <StrictMode>
      <ActivityLog {...props} lastScanAt={1000} />
    </StrictMode>,
  );
  expect(within(screen.getByRole("log")).getAllByRole("button")).toHaveLength(
    1,
  );
  const first = within(screen.getByRole("log")).getByRole("button");
  rerender(
    <StrictMode>
      <ActivityLog {...props} lastScanAt={2000} />
    </StrictMode>,
  );
  expect(first).toBeDisabled();
  const latest = within(screen.getByRole("log")).getAllByRole("button")[1];
  fireEvent.click(latest);
  expect(props.onDetails).toHaveBeenCalledWith({ kind: "scan", time: 2000 });
});

it("copies the retained log and reports clipboard failure without claiming success", async () => {
  render(<ActivityLog {...props} history={[operation]} />);
  fireEvent.click(screen.getByRole("button", { name: "Copy log" }));
  await screen.findByRole("button", { name: "Copied" });
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
    expect.stringContaining("[warning] LLM batch imported · Test mod"),
  );
  vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(
    new Error("Denied"),
  );
  fireEvent.click(screen.getByRole("button", { name: "Copied" }));
  expect(
    await within(screen.getByRole("log")).findByText(
      /Could not copy the Activity log/,
    ),
  ).toBeInTheDocument();
});

it("does not open a newer in-progress or failed scan through an earlier successful scan link", () => {
  const view = render(<ActivityLog {...props} lastScanAt={1000} />);
  const details = within(screen.getByRole("log")).getByRole("button");
  expect(details).toBeEnabled();
  view.rerender(<ActivityLog {...props} lastScanAt={1000} scanning />);
  expect(details).toBeDisabled();
  view.rerender(
    <ActivityLog {...props} lastScanAt={1000} scanError="Folder unavailable" />,
  );
  expect(details).toBeDisabled();
  fireEvent.click(details);
  expect(props.onDetails).not.toHaveBeenCalled();
});

it("pauses automatic following while reading and returns to the latest entries", () => {
  render(<ActivityLog {...props} history={[operation]} />);
  const log = screen.getByRole("log");
  Object.defineProperties(log, {
    scrollHeight: { value: 1000, configurable: true },
    clientHeight: { value: 100, configurable: true },
  });
  log.scrollTop = 100;
  fireEvent.scroll(log);
  act(() =>
    reportActivity({ kind: "message", message: "New entry", tone: "info" }),
  );
  expect(log.scrollTop).toBe(100);
  fireEvent.click(screen.getByRole("button", { name: "Latest entries" }));
  expect(log.scrollTop).toBe(1000);
  expect(
    screen.queryByRole("button", { name: "Latest entries" }),
  ).not.toBeInTheDocument();
});

it("expands, collapses, and allows keyboard resizing with bounds", () => {
  function Harness() {
    const [height, setHeight] = useState(106);
    return (
      <ActivityLog {...props} height={height} onHeightChange={setHeight} />
    );
  }
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "Expand Activity log" }));
  expect(
    screen.getByRole("button", { name: "Collapse Activity log" }),
  ).toHaveAttribute("aria-expanded", "true");
  fireEvent.click(
    screen.getByRole("button", { name: "Collapse Activity log" }),
  );
  const resize = screen.getByRole("separator", { name: "Resize Activity log" });
  fireEvent.keyDown(resize, { key: "ArrowUp" });
  expect(resize).toHaveAttribute("aria-valuenow", "146");
  for (let i = 0; i < 10; i++) fireEvent.keyDown(resize, { key: "ArrowDown" });
  expect(resize).toHaveAttribute("aria-valuenow", "80");
});
