import type { AiRunProgress } from "../tauri/commands";
import { describeProgressChanges } from "./aiRunActivity";

function progress(overrides: Partial<AiRunProgress> = {}): AiRunProgress {
  return {
    runId: "run-1",
    phase: "tokenRepair",
    completed: 0,
    total: 4,
    retries: 0,
    splits: 0,
    ...overrides,
  };
}

test("a skipped repair adds one warning line per new skip", () => {
  const before = progress();
  const after = progress({
    tokenRepairSkipped: 3,
    terminologyRepairSkipped: 1,
  });

  const entries = describeProgressChanges(before, after);

  expect(entries).toContainEqual({
    message: "Token repair skipped for 3 texts; they go to Review as they are.",
    warning: true,
  });
  expect(entries).toContainEqual({
    message:
      "Terminology check skipped for 1 text; it goes to Review as it is.",
    warning: true,
  });
  expect(
    describeProgressChanges(after, after).filter((entry) =>
      entry.message.includes("skipped"),
    ),
  ).toEqual([]);
});
