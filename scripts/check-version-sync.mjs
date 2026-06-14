import { readFileSync } from "node:fs";
import process from "node:process";

const read = (path) => readFileSync(path, "utf8");
const packageJson = JSON.parse(read("package.json"));
const tauriConfig = JSON.parse(read("src-tauri/tauri.conf.json"));
const cargoToml = read("src-tauri/Cargo.toml");
const cargoLock = read("src-tauri/Cargo.lock");
const changelog = read("CHANGELOG.md");
const projectStatus = read("docs/development/project-status.md");

function match(text, pattern, description) {
  const result = text.match(pattern);
  if (!result) {
    throw new Error(`Could not find ${description}.`);
  }
  return result[1];
}

const cargoPackage = match(
  cargoToml,
  /^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m,
  "the package version in src-tauri/Cargo.toml",
);
const lockPackage = match(
  cargoLock,
  /\[\[package\]\]\s+name = "stardew-i18n-translator"\s+version = "([^"]+)"/,
  "the root package version in src-tauri/Cargo.lock",
);
const statusVersion = match(
  projectStatus,
  /Latest release:\s*([0-9]+\.[0-9]+\.[0-9]+)\./,
  "the latest release in docs/development/project-status.md",
);
const changelogBase = match(
  changelog,
  /^\[Unreleased\]: .*\/compare\/v([0-9]+\.[0-9]+\.[0-9]+)\.\.\.HEAD$/m,
  "the Unreleased comparison base in CHANGELOG.md",
);

const versions = new Map([
  ["package.json", packageJson.version],
  ["src-tauri/tauri.conf.json", tauriConfig.version],
  ["src-tauri/Cargo.toml", cargoPackage],
  ["src-tauri/Cargo.lock", lockPackage],
  ["docs/development/project-status.md", statusVersion],
  ["CHANGELOG.md Unreleased link", changelogBase],
]);
const expected = packageJson.version;
const mismatches = [...versions].filter(([, version]) => version !== expected);

if (mismatches.length > 0) {
  console.error(`Expected every current version reference to be ${expected}:`);
  for (const [source, version] of versions) {
    console.error(`- ${source}: ${version}`);
  }
  process.exit(1);
}

console.log(`All current version references match ${expected}.`);
