import type { SkippedComponent } from "../tauri/commands";
import type {
  NexusArchive,
  NexusFile,
  NexusImportRequest,
  ScannedMod,
} from "../tauri/commands";

export type TranslationFileSelection =
  | { kind: "selected"; file: NexusFile; reason: string }
  | { kind: "choice"; files: NexusFile[]; reason: string }
  | { kind: "unavailable"; reason: string };

export interface TranslationMappingChoice {
  reason: string;
  options: NexusImportRequest[];
  requiresDefaultConfirmation: boolean;
}
export interface TranslationResolution {
  mappings: NexusImportRequest[];
  choices: TranslationMappingChoice[];
  rejected: number;
  reason: string;
}

const languageNames: Record<string, string[]> = {
  de: ["german", "deutsch", "deutsche", "deutschen"],
  es: ["spanish", "español", "espanol"],
  fr: ["french", "français", "francais"],
  hu: ["hungarian", "magyar"],
  it: ["italian", "italiano"],
  ja: ["japanese", "日本語"],
  ko: ["korean", "한국어"],
  pt: ["portuguese", "português", "portugues", "brazilian"],
  ru: ["russian", "русский"],
  tr: ["turkish", "türkçe", "turkce"],
  zh: ["chinese", "中文", "汉化", "漢化"],
  vi: ["vietnamese", "vietnamien", "việt"],
  id: ["indonesian", "indonesia"],
  uk: ["ukrainian", "українська"],
  pl: ["polish", "polski", "spolszczenie"],
  fi: ["finnish", "suomi"],
  nl: ["dutch", "nederlands"],
  cs: ["czech", "čeština"],
  th: ["thai", "ไทย"],
  en: ["english"],
};
const locale = (value: string) => {
  const code = value.trim().toLowerCase();
  return code === "pt-br" ? "pt" : code;
};
function signals(value: string): string[] {
  const text = value.toLowerCase();
  const words = new Set(text.split(/[^\p{L}\p{N}]+/u));
  return Object.entries(languageNames)
    .filter(
      ([code, names]) =>
        names.some((name) => words.has(name)) ||
        new RegExp(
          `(?:\\[|\\(|(?:lang(?:uage)?|locale)\\s*[:=]\\s*)${code}(?:\\]|\\)|\\b)`,
          "i",
        ).test(text) ||
        (code === "pt" && /\bpt-br\b/.test(text)),
    )
    .map(([code]) => code);
}
function timestamp(file: NexusFile): number {
  const value = Date.parse(file.uploadedAt);
  return Number.isFinite(value) ? value : 0;
}
function series(file: NexusFile): string {
  // Dates/version suffixes identify revisions; words such as Lite/Full or
  // Content Patcher/SMAPI remain, so distinct variants never collapse together.
  let name = file.name
    .toLowerCase()
    .replace(/\.zip$/i, "")
    .trim();
  if (file.version && !/\b(?:for|stardew|smapi|sdv)\b/i.test(name)) {
    const version = file.version
      .toLowerCase()
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    name = name.replace(new RegExp(`(?:^|[\\s_-])v?${version}$`), " ");
  }
  return name
    .replace(/\.(?:zip|7z|rar)\b/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Metadata selection only; personal imports must also pass native archive preflight. */
export function selectTranslationFile(
  files: NexusFile[],
  targetLang: string,
  purpose: "review" | "vortex" = "review",
): TranslationFileSelection {
  const target = locale(targetLang);
  const eligible = files.filter((file) => {
    if (
      !(purpose === "vortex"
        ? /\.(zip|7z|rar)$/i.test(file.fileName)
        : file.fileName.toLowerCase().endsWith(".zip")) ||
      file.fileId <= 0
    )
      return false;
    const category = (file.category ?? "").toUpperCase().replace(/[ -]/g, "_");
    if (
      ["OLD_VERSION", "ARCHIVED", "REMOVED", "HIDDEN", "DELETED"].includes(
        category,
      )
    )
      return false;
    if (/\b(?:android|mobile|legacy|obsolete|archived)\b/i.test(file.name))
      return false;
    const namedLanguages = signals(`${file.name} ${file.fileName}`);
    return namedLanguages.length === 0 || namedLanguages.includes(target);
  });
  if (!eligible.length)
    return {
      kind: "unavailable",
      reason:
        purpose === "vortex"
          ? "No current archive suitable for this language. Check the Nexus files page."
          : "No current ZIP suitable for this language. Open the Nexus files page for other formats or versions.",
    };
  const languageSpecific = eligible.filter((file) =>
    signals(`${file.name} ${file.fileName}`).includes(target),
  );
  // Explicit file-language evidence outranks a generic MAIN file. Description
  // prose can mention source languages and is not an exclusion signal.
  let pool = languageSpecific.length ? languageSpecific : eligible;
  if (!languageSpecific.length) {
    const described = pool.filter(
      (file) =>
        signals(file.description ?? "").length === 1 &&
        signals(file.description ?? "")[0] === target,
    );
    if (described.length) pool = described;
  }
  const main = pool.filter(
    (file) => (file.category ?? "").toUpperCase() === "MAIN",
  );
  if (main.length) pool = main;
  const sorted = [...pool].sort(
    (a, b) => timestamp(b) - timestamp(a) || b.fileId - a.fileId,
  );
  const sameSeries = new Set(sorted.map(series)).size === 1;
  if (
    sorted.length === 1 ||
    (sameSeries && timestamp(sorted[0]) > timestamp(sorted[1]))
  ) {
    return {
      kind: "selected",
      file: sorted[0],
      reason:
        purpose === "vortex"
          ? "Newest suitable current archive; install and deploy in Vortex."
          : "Newest suitable current ZIP; translation contents will be checked before import.",
    };
  }
  return {
    kind: "choice",
    files: sorted,
    reason:
      purpose === "vortex"
        ? "Choose the archive variant for your installed mod."
        : "Choose the ZIP variant for your installed mod.",
  };
}

function pathParts(value: string): string[] | null {
  const normalized = value.replaceAll("\\", "/").toLowerCase();
  const parts = normalized.split("/");
  return !normalized ||
    normalized.startsWith("/") ||
    /[:\0]/.test(normalized) ||
    parts.some((part) => !part || part === "." || part === "..")
    ? null
    : parts;
}
function destination(request: NexusImportRequest): string {
  return JSON.stringify([
    request.modUniqueId.toLowerCase(),
    request.relativeDir.replaceAll("\\", "/").toLowerCase(),
  ]);
}

/** Scanner package identity includes companion components without update keys. */
export function nexusSourceComponents(
  mods: ScannedMod[],
  sourceNexusId: number,
): ScannedMod[] {
  const packages = new Set(
    mods
      .filter((mod) => mod.nexusId === sourceNexusId && mod.packageId)
      .map((mod) => mod.packageId),
  );
  return mods.filter(
    (mod) =>
      mod.nexusId === sourceNexusId ||
      (!!mod.packageId && packages.has(mod.packageId)),
  );
}

/** Disk-only evidence; saved drafts/Review must never prove deployment. */
export function nexusSourceDiskCoverage(
  mods: ScannedMod[],
  sourceNexusId: number,
  skipped: SkippedComponent[] = [],
  traversalComplete = false,
) {
  const components = nexusSourceComponents(mods, sourceNexusId);
  if (
    !traversalComplete ||
    !components.length ||
    skipped.some(
      (item) =>
        item.requiresAttention &&
        ((!item.packageId && !item.componentUniqueId) ||
          components.some(
            (mod) =>
              (!!item.packageId && mod.packageId === item.packageId) ||
              (!!item.componentUniqueId &&
                mod.uniqueId === item.componentUniqueId),
          )),
    ) ||
    components.some(
      (mod) =>
        !Number.isFinite(mod.totalKeys) ||
        mod.totalKeys < 0 ||
        (mod.totalKeys > 0 && !Number.isFinite(mod.diskTranslatedKeys)),
    )
  )
    return null;
  const total = components.reduce((sum, mod) => sum + mod.totalKeys, 0);
  const covered = components.reduce(
    (sum, mod) =>
      sum + Math.min(mod.totalKeys, Math.max(0, mod.diskTranslatedKeys ?? 0)),
    0,
  );
  const differences = components.reduce(
    (sum, mod) => sum + (mod.stateDiskDifferences ?? 0),
    0,
  );
  return {
    total,
    covered,
    differences,
    complete: total > 0 && covered >= total,
  };
}

/** Resolve within the clicked original mod only; native fresh-scan checks remain authoritative. */
export function resolveArchiveTranslations(
  archive: NexusArchive,
  sourceNexusId: number,
  mods: ScannedMod[],
  targetLang: string,
): TranslationResolution {
  const target = locale(targetLang);
  const scoped = nexusSourceComponents(mods, sourceNexusId).filter(
    (mod) => mod.nexusId === sourceNexusId || !mod.nexusId || mod.nexusId <= 0,
  );
  const result: TranslationResolution = {
    mappings: [],
    choices: [],
    rejected: 0,
    reason: "",
  };
  const possibilities: { request: NexusImportRequest; isDefault: boolean }[] =
    [];
  for (const file of archive.files) {
    const parts = pathParts(file.path);
    if (
      !parts ||
      parts.at(-2) !== "i18n" ||
      parts.some((part, i) => part === "assets" && parts[i + 1] === "i18n")
    ) {
      result.rejected++;
      continue;
    }
    const name = parts.at(-1)!;
    const isDefault = name === "default.json";
    if (
      !isDefault &&
      name !== `${target}.json` &&
      !(target === "pt" && name === "pt-br.json")
    )
      continue;
    const components = file.manifestUniqueId
      ? scoped.filter(
          (mod) =>
            mod.uniqueId.toLowerCase() === file.manifestUniqueId!.toLowerCase(),
        )
      : scoped;
    const directory = parts.slice(0, -1).join("/");
    const matches = components.flatMap((mod) =>
      mod.i18nFiles.flatMap((i18n) => {
        const relative = pathParts(i18n.relativeDir)?.join("/");
        return relative &&
          (directory === relative || directory.endsWith(`/${relative}`))
          ? [
              {
                request: {
                  archiveId: archive.archiveId,
                  archivePath: file.path,
                  modUniqueId: mod.uniqueId,
                  relativeDir: i18n.relativeDir,
                },
                length: relative.length,
                folderMatches: (() => {
                  const folder = mod.folderPath
                    ?.replaceAll("\\", "/")
                    .replace(/\/$/, "")
                    .split("/")
                    .at(-1)
                    ?.toLowerCase();
                  return (
                    !!folder &&
                    (directory === `${folder}/${relative}` ||
                      directory.endsWith(`/${folder}/${relative}`))
                  );
                })(),
              },
            ]
          : [];
      }),
    );
    const folderMatches = matches.filter((match) => match.folderMatches);
    const contextual =
      !file.manifestUniqueId && folderMatches.length ? folderMatches : matches;
    const longest = Math.max(0, ...contextual.map((match) => match.length));
    const best = contextual.filter((match) => match.length === longest);
    if (!best.length) result.rejected++;
    for (const match of best)
      possibilities.push({ request: match.request, isDefault });
  }
  // A real locale file makes the same destination's English default irrelevant.
  const localeDestinations = new Set(
    possibilities
      .filter((p) => !p.isDefault)
      .map((p) => destination(p.request)),
  );
  const pending = possibilities.filter(
    (p) => !p.isDefault || !localeDestinations.has(destination(p.request)),
  );
  // Connected options form one choice: either competing JSON files for one
  // destination or one JSON with several plausible destinations. Never import
  // a supposedly unique option that overlaps another unresolved choice.
  while (pending.length) {
    const group = [pending.shift()!];
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (let i = pending.length - 1; i >= 0; i--) {
        const next = pending[i];
        if (
          group.some(
            (p) =>
              p.request.archivePath === next.request.archivePath ||
              destination(p.request) === destination(next.request),
          )
        ) {
          group.push(...pending.splice(i, 1));
          expanded = true;
        }
      }
    }
    const options = group.map((p) => p.request);
    const requiresDefaultConfirmation = group.some((p) => p.isDefault);
    if (group.length === 1 && !requiresDefaultConfirmation)
      result.mappings.push(options[0]);
    else
      result.choices.push({
        options,
        requiresDefaultConfirmation,
        reason: requiresDefaultConfirmation
          ? "Confirm that this default.json contains the target-language translation, not the original English."
          : "Choose one archive file and installed component for this translation.",
      });
  }
  result.reason =
    result.mappings.length || result.choices.length
      ? "Resolved against the clicked original mod; native preflight checks current strings before saving."
      : "No matching target-language i18n file for this installed mod was found.";
  return result;
}
