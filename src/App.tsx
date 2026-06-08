/**
 * Application shell — Milestone 1 / Issue 3.
 *
 * Renders only the static frame defined in SPEC §7.3: a toolbar plus the
 * two-panel layout (left = mod list, right = string table). No feature logic
 * yet — the setup wizard, scanner, and string table are wired up in later
 * M1 issues. Kept deliberately flat per SCOPE_GUARDRAILS (2 panels + toolbar).
 */
export function App() {
  return (
    <div className="app">
      <Toolbar />
      <main className="workspace">
        <ModListPanel />
        <StringTablePanel />
      </main>
    </div>
  );
}

function Toolbar() {
  return (
    <header className="toolbar" role="banner">
      <span className="toolbar__title">Stardew i18n Translator</span>
      <div className="toolbar__actions">
        {/* Placeholders — enabled as their M1/M2/M3 issues land. */}
        <button type="button" disabled>
          Scan
        </button>
        <button type="button" disabled>
          Export
        </button>
        <button type="button" disabled>
          Settings
        </button>
      </div>
      <input
        className="toolbar__search"
        type="search"
        placeholder="Search…"
        aria-label="Search strings"
        disabled
      />
    </header>
  );
}

function ModListPanel() {
  return (
    <section className="panel panel--mods" aria-label="Mod list">
      <div className="panel__header">Mods</div>
      <div className="panel__empty">No mods scanned yet.</div>
    </section>
  );
}

function StringTablePanel() {
  return (
    <section className="panel panel--strings" aria-label="String table">
      <div className="panel__header">Strings</div>
      <div className="panel__empty">Select a mod to view its strings.</div>
    </section>
  );
}
