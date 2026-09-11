import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// A rendering-scale pass must never silently stand in for native Windows DPI.
export function checkMatrix(reports, zipHash) {
  const required = [96, 120, 144, 192];
  const native = new Set();
  let executable;
  for (const { result, cleanup } of reports) {
    assert.equal(result.passed, true, "A supplied desktop run failed.");
    assert.equal(cleanup.exitCode, 0, "Cleanup failed.");
    assert.equal(cleanup.runtimeRemoved, true, "Test runtime was not removed.");
    assert.ok(
      Array.isArray(cleanup.ownedProcesses) &&
        cleanup.ownedProcesses.every((process) => process.exited === true),
      "Owned process cleanup is unproven.",
    );
    assert.equal(
      result.releaseZip?.sha256,
      zipHash,
      "Evidence belongs to another release ZIP.",
    );
    assert.match(result.executableSha256 ?? "", /^[a-f0-9]{64}$/);
    executable ??= result.executableSha256;
    assert.equal(
      result.executableSha256,
      executable,
      "Evidence uses different executables.",
    );
    assert.ok(
      result.steps?.includes(
        "release-combined-output-preserves-paths-and-statuses",
      ),
      "Release-specific cases are missing.",
    );
    assert.ok(
      result.steps?.includes("stress-20000-strings-edit-rescan-export-restart"),
      "Stress evidence is missing.",
    );
    for (const scale of [1, 1.25, 1.5, 2])
      assert.ok(
        result.steps?.includes(`layout-render-scale-${scale}`),
        `Rendering scale ${scale} is untested.`,
      );
    for (const engine of ["local", "codex"]) {
      assert.ok(
        result.steps?.includes(
          `live-${engine}-translate-review-export-restart`,
        ),
        `Live ${engine} stage is missing.`,
      );
      assert.ok(
        result.liveAi?.some(
          (entry) =>
            entry.engine === engine &&
            entry.passed === true &&
            entry.items === 2,
        ),
        `Live ${engine} results are missing.`,
      );
    }
    const expected = result.requested?.expectedDpi;
    if (
      required.includes(expected) &&
      result.displays?.some(
        (display) =>
          display.dpi === expected &&
          display.awareness === 2 &&
          display.renderScale === null,
      )
    )
      native.add(expected);
  }
  const missing = required.filter((dpi) => !native.has(dpi));
  assert.equal(
    missing.length,
    0,
    `Native Windows DPI runs missing: ${missing.map((dpi) => `${dpi} DPI (${(dpi / 96) * 100}%)`).join(", ")}. Rendering emulation does not satisfy this gate.`,
  );
  return {
    passed: true,
    zipSha256: zipHash,
    executableSha256: executable,
    nativeDpi: [...native].sort((a, b) => a - b),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const [zip, ...directories] = process.argv.slice(2);
    assert.ok(
      zip && directories.length,
      "Usage: pnpm test:desktop:matrix <release.zip> <run-directory> [...run-directories]",
    );
    const hash = createHash("sha256")
      .update(await readFile(zip))
      .digest("hex");
    const json = async (path) =>
      JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
    const reports = await Promise.all(
      directories.map(async (directory) => ({
        result: await json(join(directory, "result.json")),
        cleanup: await json(join(directory, "cleanup.json")),
      })),
    );
    console.log(JSON.stringify(checkMatrix(reports, hash), null, 2));
  } catch (error) {
    console.error(`Desktop acceptance incomplete: ${error.message}`);
    process.exitCode = 1;
  }
}
