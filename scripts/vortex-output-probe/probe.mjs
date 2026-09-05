import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// No app/profile discovery: every write is confined to the repository's target.
const repo = fileURLToPath(new URL("../../", import.meta.url));
const root = path.join(repo, "target", "vortex-output-probe");
const upstream = path.join(root, "upstream");
const lock = JSON.parse(
  await fs.readFile(new URL("source-lock.json", import.meta.url)),
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const source = new Map();
for (const [name, expected] of Object.entries(lock.files)) {
  const destination = path.join(upstream, name);
  if (process.argv.includes("--fetch")) {
    const response = await fetch(
      `https://raw.githubusercontent.com/${lock.repository}/${lock.revision}/${name}`,
    );
    assert(
      response.ok,
      `Upstream request failed: ${name} (${response.status})`,
    );
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(
      hash(bytes),
      expected,
      `Pinned upstream hash mismatch: ${name}`,
    );
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, bytes);
  }
  const bytes = await fs.readFile(destination);
  assert.equal(
    hash(bytes),
    expected,
    `Upstream hash mismatch: ${name}; use --fetch`,
  );
  source.set(name, bytes.toString("utf8"));
}

// Execute original isolated TS functions. Only host path semantics and unused
// dependencies are supplied; classifier/installer bodies are not rewritten.
const context = vm.createContext({});
const modules = new Map();
function stub(id, exports) {
  const module = new vm.SyntheticModule(
    Object.keys(exports),
    function () {
      for (const [key, value] of Object.entries(exports))
        this.setExport(key, value);
    },
    { context, identifier: id },
  );
  modules.set(id, module);
  return module;
}
stub("path", { ...path.win32, default: path.win32 });
stub("@nexusmods/vortex-api", { log() {} });
stub("parseManifest", {
  parseManifest() {
    throw new Error("Manifest parsing is outside this locale-only probe");
  },
});
async function load(name) {
  if (modules.has(name)) return modules.get(name);
  assert(source.has(name), `Unapproved module import: ${name}`);
  const module = new vm.SourceTextModule(
    stripTypeScriptTypes(source.get(name)),
    { context, identifier: name },
  );
  modules.set(name, module);
  await module.link(async (specifier) => {
    if (modules.has(specifier)) return modules.get(specifier);
    if (specifier.endsWith("/parseManifest"))
      return modules.get("parseManifest");
    return load(
      path.posix.normalize(
        path.posix.join(path.posix.dirname(name), `${specifier}.ts`),
      ),
    );
  });
  await module.evaluate();
  return module;
}
const prefix = "extensions/games/game-stardewvalley/src/";
const classifier = (await load(`${prefix}installers/archiveClassifier.ts`))
  .namespace;
const manifest = (await load(`${prefix}installers/stardewValleyInstaller.ts`))
  .namespace;
const rootInstaller = (await load(`${prefix}installers/rootFolderInstaller.ts`))
  .namespace;
const fallback = (
  await load(
    "src/renderer/src/extensions/mod_management/util/basicInstaller.ts",
  )
).namespace;
const common = (await load(`${prefix}common.ts`)).namespace;
assert.match(
  source.get(`${prefix}game/StardewValleyGame.ts`),
  /queryModPath\(\)\s*\{\s*return MODS_REL_PATH;/,
);
assert.match(
  source.get(`${prefix}game/StardewValleyGame.ts`),
  /mergeMods:\s*boolean\s*=\s*true/,
);
assert.equal(common.MODS_REL_PATH, "Mods");
assert.match(
  source.get("src/renderer/src/extensions/mod_management/index.ts"),
  /registerInstaller\("fallback", 1000, basicInstaller.testSupported, basicInstaller.install\)/,
);

const first = "Synthetic Valley/[CP] Valley/i18n/de.json";
const second = "Synthetic Farm/Companion/nested/i18n/de.json";
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const base = new Map([
  [first, json({ greeting: "Hallo {{PlayerName}}!", weather: "Sonnig" })],
  [second, json({ sign: "Testhof", visit: "Willkommen" })],
]);
const revision1 = new Map([
  [
    first,
    json({ greeting: "Hallo {{PlayerName}}!", weather: "Mein sonniger Tag" }),
  ],
  [second, json({ sign: "Mein Testhof", visit: "Willkommen" })],
]);
// Removing an override removes the whole generated file; base returns on deploy.
const revision2 = new Map([
  [
    first,
    json({ greeting: "Hallo {{PlayerName}}!", weather: "Mein neuer Tag" }),
  ],
]);
async function instructionsFor(entries) {
  const files = [...entries.keys()].map((name) => name.replaceAll("/", "\\"));
  const flags = classifier.classifyArchive(files, "stardewvalley");
  assert.equal(flags.hasManifest, false);
  assert.equal(flags.hasContentFolder, false);
  assert.equal(flags.hasSmapiInstallerDll, false);
  assert.equal(
    (await manifest.testSupported(files, "stardewvalley")).supported,
    false,
  );
  assert.equal(
    (await rootInstaller.testRootFolder(files, "stardewvalley")).supported,
    false,
  );
  assert.equal((await fallback.testSupported(files)).supported, true);
  const result = await fallback.install(
    files,
    "synthetic-extraction",
    "stardewvalley",
    () => {},
  );
  assert.equal(result.instructions.length, entries.size);
  for (const [i, instruction] of result.instructions.entries()) {
    assert.equal(instruction.type, "copy");
    assert.equal(instruction.destination, files[i]);
    assert.equal(instruction.source, files[i]);
  }
  return JSON.parse(JSON.stringify(result.instructions));
}
const instructions = await instructionsFor(revision1);
await instructionsFor(revision2);
// Negative packaging control: fallback does not remove a decorative wrapper.
const wrapped = await fallback.install(
  [`Output\\${first.replaceAll("/", "\\")}`],
  "fixture",
  "stardewvalley",
  () => {},
);
assert(wrapped.instructions[0].destination.startsWith("Output\\"));

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
// Deterministic ZIP STORE, fixed DOS timestamp, UTF-8 names, no dependencies.
function zip(entries) {
  const local = [],
    central = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const filename = Buffer.from(name),
      body = Buffer.from(text),
      crc = crc32(body);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(33, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(body.length, 22);
    header.writeUInt16LE(filename.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(20, 4);
    header.copy(directory, 6, 4, 28);
    directory.writeUInt32LE(offset, 42);
    local.push(header, filename, body);
    central.push(directory, filename);
    offset += header.length + filename.length + body.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.size, 8);
  end.writeUInt16LE(entries.size, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
async function writeTree(label, entries) {
  const folder = path.join(root, "fixtures", label);
  await fs.mkdir(folder, { recursive: true });
  for (const [name, body] of entries) {
    const destination = path.join(folder, ...name.split("/"));
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, body);
  }
}
await writeTree("community-base", base);
await writeTree("output-v1", revision1);
await writeTree("output-v2", revision2);
await fs.writeFile(
  path.join(root, "fixtures", "Synthetic-output-v1.zip"),
  zip(revision1),
);
await fs.writeFile(
  path.join(root, "fixtures", "Synthetic-output-v2.zip"),
  zip(revision2),
);
// This is deliberately a file-overlay model, NOT Vortex deployment execution.
const baseHashes = [...base].map(([name, body]) => [name, hash(body)]);
const deployed = (overlay) => new Map([...base, ...overlay]);
assert.equal(deployed(revision1).get(second), revision1.get(second));
assert.equal(deployed(revision2).get(second), base.get(second));
assert.deepEqual([...deployed(new Map())], [...base]);
assert.deepEqual(
  [...base].map(([name, body]) => [name, hash(body)]),
  baseHashes,
);
assert.equal(
  JSON.parse(revision1.get(first)).greeting,
  JSON.parse(base.get(first)).greeting,
);
const evidence = {
  revision: lock.revision,
  executed: [
    "official classifier",
    "official manifest matcher",
    "official root matcher",
    "official fallback installer",
  ],
  staticChecks: [
    "default deployment root Mods",
    "mergeMods true",
    "fallback registered priority 1000",
  ],
  instructions,
  simulatedOnly: [
    "output wins whole files",
    "replacement removes stale override",
    "disable/removal restores community base",
  ],
  practicalGate:
    "Real Vortex import, selected mod type/root, priority, replacement, purge/redeploy and in-game text remain unverified.",
  zipSha256: { v1: hash(zip(revision1)), v2: hash(zip(revision2)) },
};
await fs.writeFile(path.join(root, "evidence.json"), json(evidence));
console.log(JSON.stringify(evidence, null, 2));
