import { expect, it } from "vitest";
import type { NexusCandidate, NexusFile, ScannedMod } from "../tauri/commands";
import { supplementalFiles } from "./supplementalFiles";
const candidate = {
  modId: 17019,
  relationshipTier: "possible-original-translation",
} as NexusCandidate;
const component = {
  uniqueId: "frontier",
  name: "Frontier Farm",
  totalKeys: 69,
  translatedKeys: 0,
} as ScannedMod;
const file = (name: string, fileId = 1) =>
  ({
    name,
    fileId,
    fileName: `${name}.zip`,
    category: "OPTIONAL",
    uploadedAt: "2025-07-04",
  }) as NexusFile;
it("offers only the exact installed optional component and orders genuine alternatives", () => {
  const result = supplementalFiles(
    [component],
    [
      {
        candidate,
        files: [
          file("Frontier Farm - German"),
          file("Grandpa's Farm - German"),
          file("Immersive Farm 2 - German"),
          { ...file("Frontier Farm - German", 2), uploadedAt: "2026-01-01" },
        ],
      },
    ],
    "de",
  );
  expect(result).toHaveLength(1);
  expect(result[0].options.map((item) => item.file.fileId)).toEqual([2, 1]);
});
it("does not guess ambiguous component names, completed text, wrong language or related pages", () => {
  expect(
    supplementalFiles(
      [component, { ...component, uniqueId: "second" }],
      [{ candidate, files: [file("Frontier Farm - German")] }],
      "de",
    ),
  ).toEqual([]);
  expect(
    supplementalFiles(
      [component, { ...component, uniqueId: "grandpa", name: "Grandpa Farm" }],
      [{ candidate, files: [file("Frontier Farm and Grandpa Farm - German")] }],
      "de",
    ),
  ).toEqual([]);
  expect(
    supplementalFiles(
      [{ ...component, translatedKeys: 69 }],
      [{ candidate, files: [file("Frontier Farm - German")] }],
      "de",
    ),
  ).toEqual([]);
  expect(
    supplementalFiles(
      [component],
      [{ candidate, files: [file("Frontier Farm - French")] }],
      "de",
    ),
  ).toEqual([]);
  expect(
    supplementalFiles(
      [component],
      [
        {
          candidate: {
            ...candidate,
            relationshipTier: "possible-addon-or-other-translation",
          },
          files: [file("Frontier Farm - German")],
        },
      ],
      "de",
    ),
  ).toEqual([]);
});
