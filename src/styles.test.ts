import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(resolve("src/styles.css"), "utf8");
const overrideStyles = readFileSync(
  resolve("src/translator-overrides.css"),
  "utf8",
);
const translatorStyles = readFileSync(resolve("src/translator.css"), "utf8");
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

  it("binds the existing Setup layout to the application palette", () => {
    expect(overrideStyles).toContain(
      "#stardew-i18n-translator .wizard__backdrop",
    );
    expect(overrideStyles).toContain("#stardew-i18n-translator .wizard {");
    expect(overrideStyles).toContain("background: var(--translator-surface);");
    expect(overrideStyles).toContain("background: var(--translator-sidebar);");
    expect(overrideStyles).toContain("background: var(--translator-brand);");
    expect(overrideStyles).toContain("color: var(--translator-text);");
    expect(overrideStyles).toContain(
      "border-left-color: var(--translator-green);",
    );
    expect(overrideStyles).toContain(
      "border-left-color: var(--translator-orange);",
    );
    expect(overrideStyles).toContain("color: var(--translator-red);");
    expect(overrideStyles).toContain(
      "#stardew-i18n-translator .wizard__path--empty .wizard__path-status",
    );
    expect(overrideStyles).toContain("color: var(--translator-faint);");
  });

  it("keeps the production string workbench inside its pane", () => {
    expect(overrideStyles).toMatch(
      /#stardew-i18n-translator \.translator-string-pane\s*{[^}]*grid-template-rows:\s*minmax\(0, 1fr\);/s,
    );
    expect(overrideStyles).toMatch(
      /#stardew-i18n-translator \.translator-string-workbench\s*{[^}]*width:\s*100%;[^}]*min-width:\s*0;/s,
    );
    expect(translatorStyles).toMatch(
      /#stardew-i18n-translator \.translator-table-wrap\s*{[^}]*min-width:\s*0;[^}]*overflow-x:\s*auto;/s,
    );
    expect(overrideStyles).toMatch(
      /#stardew-i18n-translator \.translator-table-wrap\s*{[^}]*display:\s*flex;[^}]*flex:\s*1 1 auto;[^}]*overflow-x:\s*auto;[^}]*overflow-y:\s*hidden;/s,
    );
    expect(overrideStyles).toMatch(
      /#stardew-i18n-translator \.translator-string-table-body\s*{[^}]*flex:\s*1 1 auto;[^}]*overflow-x:\s*hidden;[^}]*overflow-y:\s*auto;/s,
    );
  });

  it("keeps long result history labels inside the result tray", () => {
    expect(translatorStyles).toMatch(
      /#stardew-i18n-translator \.translator-result-head,\s*#stardew-i18n-translator \.translator-result-body\s*{[^}]*min-width:\s*0;/s,
    );
    expect(translatorStyles).toMatch(
      /#stardew-i18n-translator \.translator-result-body\s*{[^}]*min-height:\s*0;[^}]*overflow:\s*auto;/s,
    );
    expect(overrideStyles).toMatch(
      /#stardew-i18n-translator \.translator-result-history > select\s*{[^}]*min-width:\s*0;[^}]*width:\s*100%;/s,
    );
  });

  it("gives active batch controls a separate row at the desktop minimum", () => {
    expect(overrideStyles).toMatch(
      /@media \(max-width: 1120px\)[\s\S]*\.translator-string-toolbar\.is-selection-active\s*{[^}]*grid-template-columns:\s*minmax\(130px, 180px\) minmax\(0, 1fr\);/,
    );
    expect(overrideStyles).toMatch(
      /\.translator-string-toolbar\.is-selection-active\s*>\s*\.translator-bulk-wrap\s*{[^}]*grid-column:\s*1 \/ -1;/s,
    );
  });

  it("uses the same gold accent for every workspace summary number", () => {
    expect(translatorStyles).toMatch(
      /#stardew-i18n-translator \.translator-pane-count\s*{[^}]*color:\s*var\(--translator-brand\);[^}]*font-size:\s*11px;[^}]*font-weight:\s*600;/s,
    );
    expect(translatorStyles).toMatch(
      /#stardew-i18n-translator \.translator-pane-heading\s*{[^}]*display:\s*block;/s,
    );
  });

  it("keeps every resizable column boundary visibly discoverable", () => {
    expect(translatorStyles).toMatch(
      /\.translator-column-resizer::after\s*{[^}]*top:\s*6px;[^}]*bottom:\s*6px;[^}]*width:\s*1px;[^}]*background:\s*color-mix\(/s,
    );
    expect(translatorStyles).toMatch(
      /\.translator-column-resizer:focus-visible::after,[\s\S]*\.translator-column-resizer\.is-dragging::after\s*{[^}]*width:\s*2px;[^}]*background:\s*var\(--translator-brand\);/,
    );
    expect(overrideStyles).toMatch(
      /\.translator-column-resizer--target::after\s*{[^}]*right:\s*0;[^}]*left:\s*auto;/s,
    );
  });

  it("keeps transient status help behind modal dialogs", () => {
    expect(translatorStyles).toMatch(
      /\.translator-status-tooltip\s*{[^}]*z-index:\s*34;/s,
    );
    expect(translatorStyles).toMatch(
      /\.translator-flow-overlay\s*{[^}]*z-index:\s*45;/s,
    );
  });

  it("keeps scan and export actions visible while long bodies scroll", () => {
    expect(translatorStyles).toMatch(
      /\.translator-scan-dialog,\s*#stardew-i18n-translator \.translator-export-dialog\s*{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\) auto;[^}]*overflow:\s*hidden;/s,
    );
    expect(translatorStyles).toMatch(
      /\.translator-scan-dialog > \.translator-flow-body,\s*#stardew-i18n-translator \.translator-export-dialog > \.translator-flow-body\s*{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;/s,
    );
  });
});
