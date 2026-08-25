import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(resolve("src/styles.css"), "utf8");
const integrationStyles = readFileSync(
  resolve("src/v3-integration.css"),
  "utf8",
);
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

  it("binds the existing Setup layout to the accepted V3 palette", () => {
    expect(integrationStyles).toContain("#stv3-dense-demo .wizard__backdrop");
    expect(integrationStyles).toContain("#stv3-dense-demo .wizard {");
    expect(integrationStyles).toContain("background: var(--stv3-surface);");
    expect(integrationStyles).toContain("background: var(--stv3-sidebar);");
    expect(integrationStyles).toContain("background: var(--stv3-brand);");
    expect(integrationStyles).toContain("color: var(--stv3-text);");
    expect(integrationStyles).toContain(
      "border-left-color: var(--stv3-green);",
    );
    expect(integrationStyles).toContain(
      "border-left-color: var(--stv3-orange);",
    );
    expect(integrationStyles).toContain("color: var(--stv3-red);");
    expect(integrationStyles).toContain(
      "#stv3-dense-demo .wizard__path--empty .wizard__path-status",
    );
    expect(integrationStyles).toContain("color: var(--stv3-faint);");
  });
});
