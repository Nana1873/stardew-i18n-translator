import type { NexusCandidate, NexusFile, ScannedMod } from "../tauri/commands";
import { translationFileOptions } from "./resolveTranslation";

const words = (value: string) =>
  value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** A metadata offer only. Native archive mapping still validates every import. */
export function supplementalFiles(
  components: ScannedMod[],
  pages: { candidate: NexusCandidate; files: NexusFile[] }[],
  language: string,
  includeComplete = false,
) {
  const matches = new Map<
    string,
    {
      component: ScannedMod;
      options: { candidate: NexusCandidate; file: NexusFile; value: string }[];
    }
  >();
  for (const { candidate, files } of pages) {
    if (candidate.relationshipTier !== "possible-original-translation")
      continue;
    for (const file of files) {
      if (
        file.category?.toUpperCase() !== "OPTIONAL" ||
        !translationFileOptions([file], language).length
      )
        continue;
      const name = ` ${words(file.name)} `;
      const named = components.filter(
        (component) =>
          words(component.name) && name.includes(` ${words(component.name)} `),
      );
      if (named.length !== 1) continue;
      const component = named[0];
      const missing =
        component.statusCounts?.untranslated ??
        component.totalKeys -
          component.translatedKeys -
          (component.noTranslationNeededKeys ?? 0);
      if (!Number.isFinite(missing) || (!includeComplete && missing <= 0))
        continue;
      const group = matches.get(component.uniqueId) ?? {
        component,
        options: [],
      };
      group.options.push({
        candidate,
        file,
        value: `${candidate.modId}:${file.fileId}`,
      });
      matches.set(component.uniqueId, group);
    }
  }
  return [...matches.values()].map((group) => ({
    ...group,
    options: group.options.sort(
      (a, b) =>
        (Date.parse(b.file.uploadedAt) || 0) -
          (Date.parse(a.file.uploadedAt) || 0) || b.file.fileId - a.file.fileId,
    ),
  }));
}
