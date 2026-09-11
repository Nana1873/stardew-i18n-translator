import assert from "node:assert/strict";
import test from "node:test";
import { checkMatrix } from "./check-matrix.mjs";
const hash = "a".repeat(64);
function reports() {
  return [96, 120, 144, 192].map((dpi) => ({
    result: {
      passed: true,
      releaseZip: { sha256: hash },
      executableSha256: "b".repeat(64),
      requested: { expectedDpi: dpi },
      displays: [{ dpi, awareness: 2, renderScale: null }],
      installation: { passed: true },
      steps: [
        "release-combined-output-preserves-paths-and-statuses",
        "stress-20000-strings-edit-rescan-export-restart",
        "install-native-startup-and-runtime-guidance",
        "install-updated-edit-export-and-restart",
        ...[1, 1.25, 1.5, 2].map((scale) => `layout-render-scale-${scale}`),
        ...["local", "codex"].map(
          (engine) => `live-${engine}-translate-review-export-restart`,
        ),
      ],
      liveAi: ["local", "codex"].map((engine) => ({
        engine,
        passed: true,
        items: 2,
      })),
    },
    cleanup: { exitCode: 0, runtimeRemoved: true, ownedProcesses: [] },
  }));
}
test("accepts matching complete native configurations", () =>
  assert.equal(checkMatrix(reports(), hash).passed, true));
test("rejects missing installation or upgrade coverage", () => {
  const input = reports();
  delete input[0].result.installation;
  assert.throws(
    () => checkMatrix(input, hash),
    /installation\/upgrade evidence/,
  );
  const other = reports();
  other[0].result.steps = other[0].result.steps.filter(
    (name) => !name.startsWith("install-"),
  );
  assert.throws(
    () => checkMatrix(other, hash),
    /installation\/upgrade evidence/,
  );
});
test("rendering emulation cannot replace native DPI", () => {
  const input = reports();
  input[1].result.displays[0].renderScale = 1.25;
  assert.throws(
    () => checkMatrix(input, hash),
    /Native Windows DPI runs missing/,
  );
});
test("rejects failed or incomplete cleanup", () => {
  for (const patch of [
    { exitCode: 1 },
    { runtimeRemoved: false },
    { ownedProcesses: [{ id: 12, exited: false }] },
  ]) {
    const input = reports();
    Object.assign(input[0].cleanup, patch);
    assert.throws(() => checkMatrix(input, hash));
  }
});
test("rejects another artifact and mixed executables", () => {
  assert.throws(
    () => checkMatrix(reports(), "c".repeat(64)),
    /another release ZIP/,
  );
  const input = reports();
  input[1].result.executableSha256 = "c".repeat(64);
  assert.throws(() => checkMatrix(input, hash), /different executables/);
});
test("rejects skipped engine or stress stage", () => {
  const input = reports();
  input[0].result.liveAi.pop();
  assert.throws(() => checkMatrix(input, hash), /Live codex results/);
  const other = reports();
  other[0].result.steps = [];
  assert.throws(() => checkMatrix(other, hash), /cases are missing/);
});
test("duplicate or default-DPI runs do not complete the matrix", () => {
  assert.throws(
    () => checkMatrix([reports()[0], reports()[0]], hash),
    /Native Windows DPI runs missing/,
  );
  const input = reports();
  input[3].result.requested.expectedDpi = 0;
  assert.throws(() => checkMatrix(input, hash), /192 DPI/);
});
