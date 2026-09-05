import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const checker = fileURLToPath(
  new URL("./check-markdown-links.mjs", import.meta.url),
);

function fixture(t, files) {
  const root = mkdtempSync(join(tmpdir(), "translator-doc-links-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync("git", args, {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
  };
  git("init", "--quiet");
  for (const [file, text] of Object.entries(files)) {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  return {
    root,
    git,
    check: () =>
      spawnSync(process.execPath, [checker], {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
      }),
  };
}

test("accepts local files and GitHub-style anchors in new and tracked documents", (t) => {
  const repo = fixture(t, {
    "README.md": [
      "# Start",
      "[Here](#start)",
      "[First](docs/guide.md#repeat)",
      "[Second](docs/guide.md#repeat-1)",
      "[Third](docs/guide.md#repeat-2)",
      "[Collision](docs/guide.md#repeat-1-1)",
      "[Unicode and formatting](docs/guide.md#caf%C3%A9--review--save_string)",
      "[Emphasis](docs/guide.md#helpful-section)",
      "[Setext](docs/guide.md#another-heading)",
      "[Custom](docs/guide.md#custom-anchor)",
      '[Space in filename](<docs/übersicht page.md> "Overview")',
      "![Image](docs/image.svg)",
      "[Reference][guide]",
      "[guide]: docs/guide.md#repeat",
      "`[Example](missing-inline.md)`",
      "<!-- [Example](missing-comment.md) -->",
      "~~~md",
      "[Example](missing-fenced.md)",
      "# Start",
      "~~~",
      "[External](https://example.com/missing#anchor)",
    ].join("\n"),
    "docs/guide.md": [
      "# Guide",
      "## Repeat",
      "## Repeat",
      "## Repeat-1",
      "## Repeat",
      "## Café & **Review** / `save_string`",
      "## Helpful _section_ ##",
      "Another heading",
      "---------------",
      '<a name="custom-anchor"></a>',
      "```md",
      "## Repeat",
      "```",
    ].join("\n"),
    "docs/übersicht page.md": "# Overview\n",
    "docs/image.svg": "<svg />",
  });
  repo.git("add", "README.md");
  const result = repo.check();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /3 Markdown files/);
});

test("rejects missing files, same-document and cross-document anchors, and malformed URLs", (t) => {
  const repo = fixture(t, {
    "README.md": [
      "# Start",
      "[Missing section](#missing)",
      "[Wrong case](#Start)",
      "[Wrong other section](docs/guide.md#missing)",
      "[Unallocated duplicate](docs/guide.md#repeat-2)",
      "[Not a rendered heading](docs/guide.md#inside-code)",
      "[Missing file](missing.md)",
      "[Malformed](bad%XY.md)",
      "[Reference]: docs/guide.md#missing-reference",
    ].join("\n"),
    "docs/guide.md": "## Repeat\n## Repeat\n```md\n## Inside code\n```\n",
    "new.md": "[A new file is checked too](#missing-new)\n",
  });
  const result = repo.check();
  assert.equal(result.status, 1);
  for (const target of [
    "#missing",
    "#Start",
    "docs/guide.md#missing",
    "docs/guide.md#repeat-2",
    "docs/guide.md#inside-code",
    "missing.md",
    "bad%XY.md",
    "#missing-reference",
    "#missing-new",
  ]) {
    assert.ok(result.stderr.includes(target), result.stderr);
  }
});

test("skips deleted and ignored documents but still rejects links to deleted files", (t) => {
  const repo = fixture(t, {
    "README.md": "# Start\n",
    "retired.md": "[Obsolete broken link](missing.md)\n",
    ".gitignore": "ignored/\n",
    "ignored/scratch.md": "[Private draft](missing.md)\n",
  });
  repo.git("add", "README.md", "retired.md", ".gitignore");
  unlinkSync(join(repo.root, "retired.md"));
  const result = repo.check();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 Markdown files/);

  writeFileSync(join(repo.root, "README.md"), "[Stale link](retired.md)\n");
  const stale = repo.check();
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /retired\.md \(file does not exist\)/);
});
