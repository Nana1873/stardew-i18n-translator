import { describe, expect, it } from "vitest";
import { coveragePercent } from "./coverage";

describe("coveragePercent", () => {
  it.each([
    [0, 0, 0],
    [0, 10, 0],
    [2, 3, 67],
    [199, 200, 99.5],
    [17744, 17756, 99.9],
    [99999, 100000, 99.9],
    [10, 10, 100],
  ])("formats %i of %i as %s percent", (covered, total, expected) => {
    expect(coveragePercent(covered, total)).toBe(expected);
  });
});
