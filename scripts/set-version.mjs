import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("Usage: node scripts/set-version.mjs <major.minor.patch>");
  process.exit(1);
}

const read = (path) => readFileSync(path, "utf8");
const write = (path, contents) => writeFileSync(path, contents, "utf8");

function updateJson(path) {
  const value = JSON.parse(read(path));
  value.version = version;
  write(path, `${JSON.stringify(value, null, 2)}\n`);
}

function replace(path, pattern, replacement, description) {
  const current = read(path);
  if (!pattern.test(current)) {
    throw new Error(`Could not find ${description} in ${path}.`);
  }
  write(path, current.replace(pattern, replacement));
}

updateJson("package.json");
updateJson("src-tauri/tauri.conf.json");
replace(
  "src-tauri/Cargo.toml",
  /^(\[package\][\s\S]*?^version\s*=\s*)"[^"]+"/m,
  `$1"${version}"`,
  "the package version",
);
replace(
  "src-tauri/Cargo.lock",
  /(\[\[package\]\]\s+name = "stardew-i18n-translator"\s+version = ")[^"]+"/,
  `$1${version}"`,
  "the root package version",
);
replace(
  "docs/development/project-status.md",
  /(Latest release:\s*)[0-9]+\.[0-9]+\.[0-9]+(\.)/,
  `$1${version}$2`,
  "the latest release",
);
replace(
  "CHANGELOG.md",
  /^(\[Unreleased\]: .*\/compare\/v)[0-9]+\.[0-9]+\.[0-9]+(\.\.\.HEAD)$/m,
  `$1${version}$2`,
  "the Unreleased comparison base",
);

console.log(`Updated current version references to ${version}.`);
