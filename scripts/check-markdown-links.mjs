import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

const git = spawnSync(
  "git",
  [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    "*.md",
  ],
  { encoding: "utf8", windowsHide: true },
);
if (git.status !== 0) {
  throw new Error(git.stderr || "Could not list repository Markdown files.");
}

// Include new documents before staging, and skip tracked files deleted locally.
const files = [...new Set(git.stdout.split("\0").filter(Boolean))].filter(
  existsSync,
);
const failures = [];
const documents = new Map();

function readDocument(file) {
  const absolute = resolve(file);
  if (documents.has(absolute)) return documents.get(absolute);

  let fence = null;
  const text = readFileSync(absolute, "utf8")
    .replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, " "))
    .split(/\r?\n/)
    .map((line) => {
      const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if (fence) {
        if (
          marker &&
          marker[1][0] === fence[0] &&
          marker[1].length >= fence.length &&
          !marker[2].trim()
        ) {
          fence = null;
        }
        return "";
      }
      if (marker) {
        fence = marker[1];
        return "";
      }
      return line;
    })
    .join("\n");

  const anchors = new Set();
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const heading = lines[index].match(/^ {0,3}#{1,6}(?:\s+|$)(.*)/);
    const setext = /^ {0,3}(?:=+|-+)\s*$/.test(lines[index + 1] ?? "");
    if (!heading && (!setext || !lines[index].trim())) continue;

    // GitHub heading anchors: visible text, lowercase, punctuation removed,
    // spaces replaced by hyphens; retain Unicode letters and literal underscores.
    const slug = (heading ? heading[1].replace(/\s+#+\s*$/, "") : lines[index])
      .replace(/!?\[([^\]]*)\](?:\([^)]*\)|\[[^\]]*\])/g, "$1")
      .replace(/<[^>]*>/g, "")
      .replace(/(?<!\w)(_+)(.*?)\1(?!\w)/g, "$2")
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}_\- ]/gu, "")
      .replace(/ /g, "-");
    let anchor = slug;
    let suffix = 0;
    while (anchors.has(anchor)) anchor = `${slug}-${++suffix}`;
    anchors.add(anchor);
  }
  for (const match of text.matchAll(
    /<a\s+[^>]*\b(?:name|id)=["']([^"']+)["'][^>]*>/gi,
  )) {
    anchors.add(match[1]);
  }

  const document = { text, anchors };
  documents.set(absolute, document);
  return document;
}

for (const file of files) {
  const text = readDocument(file).text.replace(/(`+)[^\n]*?\1/g, "");
  const links = [
    ...text.matchAll(/!?\[[^\]]*]\((<[^>]+>|[^)\n]+)\)/g),
    ...text.matchAll(/^ {0,3}\[[^\]]+\]:\s*(<[^>]+>|\S+)/gm),
  ];
  for (const match of links) {
    let target = match[1].trim();
    target = target.replace(/\s+["'][^"']*["']$/, "");
    if (target.startsWith("<") && target.endsWith(">")) {
      target = target.slice(1, -1);
    }

    if (!target || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) {
      continue;
    }

    let path;
    let fragment;
    try {
      const hash = target.indexOf("#");
      path = decodeURIComponent(
        (hash < 0 ? target : target.slice(0, hash)).split("?")[0],
      );
      fragment = hash < 0 ? "" : decodeURIComponent(target.slice(hash + 1));
    } catch {
      failures.push(`${file}: ${target} (invalid URL encoding)`);
      continue;
    }

    const absolute = path ? resolve(dirname(file), path) : resolve(file);
    if (!existsSync(absolute)) {
      failures.push(`${file}: ${target} (file does not exist)`);
    } else if (
      fragment &&
      extname(absolute).toLowerCase() === ".md" &&
      !readDocument(absolute).anchors.has(fragment)
    ) {
      failures.push(`${file}: ${target} (heading or anchor does not exist)`);
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

console.log(
  `Checked local files and Markdown anchors in ${files.length} Markdown files.`,
);
