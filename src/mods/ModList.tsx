/**
 * Mod list tree — M1 / Issue 6 (SPEC §7.3).
 *
 * Mods grouped by package (top-level Mods subfolder), SSE-AT style. A package
 * with one component renders as a single flat row; a package with several
 * (e.g. Ridgeside's [CP]/[CC]/SMAPI) renders as an expandable parent whose
 * children are the components. Status/Fortschritt are placeholders until string
 * parsing (Issue 5) lands.
 */
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useState,
} from "react";
import {
  type ModStatus,
  type ScannedMod,
  openModFolder,
  openUrl,
} from "../tauri/commands";

type ContextMenuHandler = (mod: ScannedMod, event: ReactMouseEvent) => void;

interface PackageGroup {
  packageId: string;
  mods: ScannedMod[];
  fileCount: number;
  nexusId: number | null;
  totalKeys: number;
  translatedKeys: number;
  progress: number;
  status: ModStatus;
}

function deriveStatus(total: number, translated: number): ModStatus {
  if (total === 0) return "none";
  if (translated >= total) return "translated";
  return "untranslated";
}

const byName = (a: string, b: string) =>
  a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });

/** The label a group sorts/filters by (package name, or the lone mod's name). */
function groupLabel(group: PackageGroup): string {
  return group.mods.length === 1 ? group.mods[0].name : group.packageId;
}

function groupByPackage(mods: ScannedMod[]): PackageGroup[] {
  const order: string[] = [];
  const byId = new Map<string, ScannedMod[]>();
  for (const mod of mods) {
    const existing = byId.get(mod.packageId);
    if (existing) {
      existing.push(mod);
    } else {
      byId.set(mod.packageId, [mod]);
      order.push(mod.packageId);
    }
  }
  const groups = order.map((packageId) => {
    const group = byId.get(packageId)!;
    group.sort((a, b) => byName(a.name, b.name)); // components A→Z within a package
    const totalKeys = group.reduce((sum, mod) => sum + mod.totalKeys, 0);
    const translatedKeys = group.reduce(
      (sum, mod) => sum + mod.translatedKeys,
      0,
    );
    return {
      packageId,
      mods: group,
      fileCount: group.reduce((sum, mod) => sum + mod.i18nFiles.length, 0),
      nexusId: group.find((mod) => mod.nexusId != null)?.nexusId ?? null,
      totalKeys,
      translatedKeys,
      progress: totalKeys ? translatedKeys / totalKeys : 0,
      status: deriveStatus(totalKeys, translatedKeys),
    };
  });
  // Packages A→Z (no priority/load order — flat alphabetical, SPEC §7.3).
  groups.sort((a, b) => byName(groupLabel(a), groupLabel(b)));
  return groups;
}

function ProgressCell({
  total,
  progress,
}: {
  total: number;
  progress: number;
}) {
  if (total === 0) {
    return <span className="modrow__progress">—</span>;
  }
  const pct = Math.round(progress * 100);
  return (
    <span className="modrow__progress" title={`${pct}%`}>
      <span className="modrow__bar">
        <span
          className={`modrow__bar-fill${pct >= 100 ? " modrow__bar-fill--full" : ""}`}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className="modrow__pct">{pct}%</span>
    </span>
  );
}

interface ModListProps {
  mods: ScannedMod[];
  selectedId: string | null;
  onSelect: (uniqueId: string) => void;
  /** Filter packages/components by name (case-insensitive). */
  query?: string;
}

export function ModList({
  mods,
  selectedId,
  onSelect,
  query = "",
}: ModListProps) {
  const groups = groupByPackage(mods);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    mod: ScannedMod;
  } | null>(null);
  const q = query.trim().toLowerCase();
  const visible = q
    ? groups.filter(
        (group) =>
          group.packageId.toLowerCase().includes(q) ||
          group.mods.some((mod) => mod.name.toLowerCase().includes(q)),
      )
    : groups;
  const visibleIds = visible.flatMap((group) =>
    group.mods.map((mod) => mod.uniqueId),
  );
  const selectedVisible =
    selectedId !== null && visibleIds.includes(selectedId);
  const firstVisibleId = visibleIds[0] ?? null;

  function openContextMenu(mod: ScannedMod, event: ReactMouseEvent) {
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY, mod });
  }

  function onTreeKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const row = (event.target as HTMLElement).closest<HTMLElement>(
      ".modrow--mod[role='treeitem']",
    );
    if (!row) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      row.click();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;

    event.preventDefault();
    const rows = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        ".modrow--mod[role='treeitem']",
      ),
    );
    const index = rows.indexOf(row);
    const next = Math.max(
      0,
      Math.min(rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)),
    );
    rows.forEach((candidate, candidateIndex) => {
      candidate.tabIndex = candidateIndex === next ? 0 : -1;
    });
    rows[next]?.focus();
  }

  return (
    <>
      <div
        className="modlist"
        role="tree"
        aria-label="Mods"
        onKeyDown={onTreeKeyDown}
      >
        <div className="modrow modrow--head">
          <span>Mod</span>
          <span>Ver</span>
          <span>Nexus</span>
          <span>Files</span>
          <span>Progress</span>
        </div>
        {visible.length === 0 ? (
          <div className="panel__empty">No mods match “{query}”.</div>
        ) : (
          visible.map((group) =>
            group.mods.length === 1 ? (
              <ModRow
                key={group.mods[0].uniqueId}
                mod={group.mods[0]}
                depth={0}
                selectedId={selectedId}
                tabStop={
                  group.mods[0].uniqueId === selectedId ||
                  (!selectedVisible &&
                    group.mods[0].uniqueId === firstVisibleId)
                }
                onSelect={onSelect}
                onContextMenu={openContextMenu}
              />
            ) : (
              <PackageNode
                key={group.packageId}
                group={group}
                selectedId={selectedId}
                firstVisibleId={firstVisibleId}
                selectedVisible={selectedVisible}
                onSelect={onSelect}
                onContextMenu={openContextMenu}
              />
            ),
          )
        )}
      </div>
      {menu && (
        <>
          <div
            className="ctxmenu__scrim"
            onMouseDown={() => setMenu(null)}
            onContextMenu={(event) => {
              event.preventDefault();
              setMenu(null);
            }}
          />
          <ul
            className="ctxmenu"
            style={{ left: menu.x, top: menu.y }}
            role="menu"
          >
            <li>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  void openModFolder(menu.mod.folderPath);
                  setMenu(null);
                }}
              >
                Open Mods Folder
              </button>
            </li>
          </ul>
        </>
      )}
    </>
  );
}

function PackageNode({
  group,
  selectedId,
  firstVisibleId,
  selectedVisible,
  onSelect,
  onContextMenu,
}: {
  group: PackageGroup;
  selectedId: string | null;
  firstVisibleId: string | null;
  selectedVisible: boolean;
  onSelect: (uniqueId: string) => void;
  onContextMenu: ContextMenuHandler;
}) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <div
        className="modrow modrow--package"
        role="treeitem"
        aria-expanded={open}
      >
        <span className="modrow__name">
          <button
            type="button"
            className="modrow__twisty"
            onClick={() => setOpen((value) => !value)}
            aria-label={open ? "Collapse" : "Expand"}
          >
            {open ? "▾" : "▸"}
          </button>
          {group.packageId}
        </span>
        <span />
        <NexusCell nexusId={group.nexusId} />
        <span className="modrow__files">{group.fileCount}</span>
        <ProgressCell total={group.totalKeys} progress={group.progress} />
      </div>
      {open &&
        group.mods.map((mod, index) => (
          <ModRow
            key={mod.uniqueId}
            mod={mod}
            depth={1}
            child
            lastChild={index === group.mods.length - 1}
            selectedId={selectedId}
            tabStop={
              mod.uniqueId === selectedId ||
              (!selectedVisible && mod.uniqueId === firstVisibleId)
            }
            onSelect={onSelect}
            onContextMenu={onContextMenu}
          />
        ))}
    </>
  );
}

function ModRow({
  mod,
  depth,
  child = false,
  lastChild = false,
  selectedId,
  tabStop,
  onSelect,
  onContextMenu,
}: {
  mod: ScannedMod;
  depth: number;
  child?: boolean;
  lastChild?: boolean;
  selectedId: string | null;
  tabStop: boolean;
  onSelect: (uniqueId: string) => void;
  onContextMenu: ContextMenuHandler;
}) {
  const selected = mod.uniqueId === selectedId;
  const className = [
    "modrow modrow--mod",
    child ? "modrow--child" : "",
    lastChild ? "modrow--child-last" : "",
    selected ? "modrow--selected" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div
      className={className}
      role="treeitem"
      aria-selected={selected}
      tabIndex={tabStop ? 0 : -1}
      onClick={() => onSelect(mod.uniqueId)}
      onContextMenu={(event) => onContextMenu(mod, event)}
    >
      <span
        className="modrow__name"
        style={{ paddingLeft: child ? 6 + (depth - 1) * 14 : undefined }}
        title={mod.name}
      >
        {child && (
          <span className="modrow__tree" aria-hidden>
            {lastChild ? "└─ " : "├─ "}
          </span>
        )}
        {mod.name}
      </span>
      <span className="modrow__version">{mod.version}</span>
      <NexusCell nexusId={mod.nexusId} />
      <span className="modrow__files">{mod.i18nFiles.length}</span>
      <ProgressCell total={mod.totalKeys} progress={mod.progress} />
    </div>
  );
}

function NexusCell({ nexusId }: { nexusId: number | null }) {
  if (nexusId == null) {
    return <span className="modrow__nexus modrow__nexus--none">—</span>;
  }
  const url = `https://www.nexusmods.com/stardewvalley/mods/${nexusId}`;
  return (
    <a
      className="modrow__nexus"
      href={url}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void openUrl(url);
      }}
    >
      {nexusId}
    </a>
  );
}
