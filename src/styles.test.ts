import { describe, expect, it } from "vitest";
import styles from "./styles.css?raw";

describe("CSS custom properties", () => {
  it("declares every variable used by the stylesheet", () => {
    const declared = new Set(
      [...styles.matchAll(/--([a-z0-9-]+)\s*:/gi)].map((match) => match[1]),
    );
    const used = new Set(
      [...styles.matchAll(/var\(\s*--([a-z0-9-]+)/gi)].map((match) => match[1]),
    );

    expect([...used].filter((name) => !declared.has(name)).sort()).toEqual([]);
  });
});
