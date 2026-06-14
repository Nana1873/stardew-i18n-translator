import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

const git = spawnSync("git", ["ls-files", "*.md"], {
  encoding: "utf8",
  windowsHide: true,
});
if (git.status !== 0) {
  throw new Error(git.stderr || "Could not list tracked Markdown files.");
}

const files = git.stdout.split(/\r?\n/).filter(Boolean);
const failures = [];
const linkPattern = /!?\[[^\]]*]\(([^)]+)\)/g;

for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(linkPattern)) {
    let target = match[1].trim();
    if (target.startsWith("<") && target.endsWith(">")) {
      target = target.slice(1, -1);
    }
    target = target.split(/\s+["'][^"']*["']$/)[0];

    if (
      !target ||
      target.startsWith("#") ||
      /^(https?:|mailto:|data:|file:)/i.test(target)
    ) {
      continue;
    }

    const path = decodeURIComponent(target.split("#")[0].split("?")[0]);
    if (!path) {
      continue;
    }

    const absolute = resolve(dirname(file), path);
    if (!existsSync(absolute)) {
      failures.push(`${file}: ${target}`);
    }
  }
}

if (failures.length > 0) {
  console.error("Broken repository-local Markdown links:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(`Checked local links in ${files.length} Markdown files.`);
