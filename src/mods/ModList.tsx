import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { ExternalLink, FolderOpen, SearchX } from "lucide-react";
import { type ScannedMod, openModFolder, openUrl } from "../tauri/commands";

interface PackageGroup {
  packageId: string;
  mods: ScannedMod[];
  nexusId: number | null;
  totalKeys: number;
  translatedKeys: number;
  reviewNeeded: number;
  fileCount: number;
  progress: number;
}

interface ModListProps {
  mods: ScannedMod[];
  selectedId: string | null;
  onSelect: (uniqueId: string) => void;
  /** Filter packages/components by name (case-insensitive). */
  query?: string;
  /** Clears the search field rendered by the owning mod pane. */
  onClearQuery?: () => void;
}

interface ModMenuState {
  x: number;
  y: number;
  mod: ScannedMod;
  trigger: HTMLElement | null;
}

const byName = (a: string, b: string) =>
  a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });

function groupLabel(group: PackageGroup): string {
  return group.mods.length === 1 ? group.mods[0].name : group.packageId;
}

function groupByPackage(mods: ScannedMod[]): PackageGroup[] {
  const byId = new Map<string, ScannedMod[]>();
  for (const mod of mods) {
    const existing = byId.get(mod.packageId);
    if (existing) existing.push(mod);
    else byId.set(mod.packageId, [mod]);
  }

  return Array.from(byId, ([packageId, groupMods]) => {
    const sortedMods = [...groupMods].sort((a, b) => byName(a.name, b.name));
    const totalKeys = sortedMods.reduce((sum, mod) => sum + mod.totalKeys, 0);
    const translatedKeys = sortedMods.reduce(
      (sum, mod) => sum + mod.translatedKeys,
      0,
    );
    const reviewNeeded = sortedMods.reduce(
      (sum, mod) => sum + mod.reviewNeeded,
      0,
    );
    const fileCount = sortedMods.reduce(
      (sum, mod) => sum + mod.i18nFiles.length,
      0,
    );
    return {
      packageId,
      mods: sortedMods,
      nexusId: sortedMods.find((mod) => mod.nexusId != null)?.nexusId ?? null,
      totalKeys,
      translatedKeys,
      reviewNeeded,
      fileCount,
      progress: totalKeys > 0 ? translatedKeys / totalKeys : 0,
    };
  }).sort((a, b) => byName(groupLabel(a), groupLabel(b)));
}

function progressStyle(progress: number): CSSProperties {
  return {
    "--translator-progress": `${Math.round(progress * 100)}%`,
  } as CSSProperties;
}

function progressState(progress: number): string | undefined {
  const percent = Math.round(progress * 100);
  return percent > 0 && percent < 20 ? "warning" : undefined;
}

export function ModList({
  mods,
  selectedId,
  onSelect,
  query = "",
  onClearQuery,
}: ModListProps) {
  const groups = groupByPackage(mods);
  const [menu, setMenu] = useState<ModMenuState | null>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const q = query.trim().toLocaleLowerCase();
  const visible = q
    ? groups.flatMap((group) => {
        const packageMatches = group.packageId.toLocaleLowerCase().includes(q);
        const matchingMods = group.mods.filter(
          (mod) =>
            mod.name.toLocaleLowerCase().includes(q) ||
            mod.uniqueId.toLocaleLowerCase().includes(q),
        );
        if (!packageMatches && matchingMods.length === 0) return [];
        return [
          {
            group,
            mods: packageMatches ? group.mods : matchingMods,
          },
        ];
      })
    : groups.map((group) => ({ group, mods: group.mods }));
  const visibleIds = visible.flatMap(({ mods: visibleMods }) =>
    visibleMods.map((mod) => mod.uniqueId),
  );
  const selectedVisible =
    selectedId !== null && visibleIds.includes(selectedId);
  const firstVisibleId = visibleIds[0] ?? null;

  useEffect(() => {
    if (!menu) return;
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]',
      ) ?? [],
    );
    items.forEach((item, index) => {
      item.tabIndex = index === 0 ? 0 : -1;
    });
    items[0]?.focus();
  }, [menu]);

  function closeMenu(restoreFocus = false) {
    const trigger = menu?.trigger;
    setMenu(null);
    if (restoreFocus) requestAnimationFrame(() => trigger?.focus());
  }

  function openContextMenu(
    mod: ScannedMod,
    event: Pick<ReactMouseEvent, "preventDefault" | "clientX" | "clientY">,
    trigger: HTMLElement | null,
  ) {
    event.preventDefault();
    onSelect(mod.uniqueId);
    const maxX = Math.max(8, window.innerWidth - 254);
    const maxY = Math.max(8, window.innerHeight - 112);
    setMenu({
      x: Math.max(8, Math.min(event.clientX, maxX)),
      y: Math.max(8, Math.min(event.clientY, maxY)),
      mod,
      trigger,
    });
  }

  function onTreeKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const row = (event.target as HTMLElement).closest<HTMLElement>(
      ".translator-mod-row[role='treeitem']",
    );
    if (!row) return;
    if (
      event.key === "ContextMenu" ||
      (event.shiftKey && event.key === "F10")
    ) {
      event.preventDefault();
      const mod = mods.find(
        (candidate) => candidate.uniqueId === row.dataset.modId,
      );
      if (!mod) return;
      const box = row.getBoundingClientRect();
      openContextMenu(
        mod,
        {
          preventDefault() {},
          clientX: box.left + 24,
          clientY: box.top + 20,
        },
        row,
      );
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      if (event.target !== row) return;
      event.preventDefault();
      row.click();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;

    event.preventDefault();
    const rows = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        ".translator-mod-row[role='treeitem']",
      ),
    );
    const index = rows.indexOf(row);
    const next =
      event.key === "Home"
        ? rows[0]
        : event.key === "End"
          ? rows.at(-1)
          : rows[
              Math.max(
                0,
                Math.min(
                  rows.length - 1,
                  index + (event.key === "ArrowDown" ? 1 : -1),
                ),
              )
            ];
    if (!next) return;
    rows.forEach((candidate) => {
      candidate.tabIndex = candidate === next ? 0 : -1;
    });
    next.focus();
  }

  function onMenuKeyDown(event: ReactKeyboardEvent<HTMLUListElement>) {
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not(:disabled)',
      ),
    );
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const nextIndex =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : event.key === "ArrowDown"
              ? (index + 1 + items.length) % items.length
              : (index - 1 + items.length) % items.length;
      items.forEach((item, itemIndex) => {
        item.tabIndex = itemIndex === nextIndex ? 0 : -1;
      });
      items[nextIndex]?.focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeMenu(true);
    }
  }

  return (
    <>
      <div className="translator-mod-columns" aria-hidden="true">
        <span>Mod</span>
        <span>Ver.</span>
        <span>Nexus</span>
        <span>Progress</span>
      </div>
      <div
        className="translator-mod-list"
        role="tree"
        aria-label="Mods"
        onKeyDown={onTreeKeyDown}
      >
        {visible.map(({ group, mods: visibleMods }) =>
          group.mods.length === 1 ? (
            <ModRow
              key={group.mods[0].uniqueId}
              mod={group.mods[0]}
              selectedId={selectedId}
              tabStop={
                group.mods[0].uniqueId === selectedId ||
                (!selectedVisible && group.mods[0].uniqueId === firstVisibleId)
              }
              onSelect={onSelect}
              onContextMenu={openContextMenu}
              menuOpen={menu?.mod.uniqueId === group.mods[0].uniqueId}
            />
          ) : (
            <PackageNode
              key={group.packageId}
              group={group}
              visibleMods={visibleMods}
              searching={Boolean(q)}
              selectedId={selectedId}
              firstVisibleId={firstVisibleId}
              selectedVisible={selectedVisible}
              onSelect={onSelect}
              onContextMenu={openContextMenu}
              menuOpenId={menu?.mod.uniqueId ?? null}
            />
          ),
        )}
      </div>

      {visible.length === 0 && (
        <div className="translator-empty-state" data-mod-empty>
          <SearchX aria-hidden="true" />
          <strong>
            {query.trim() ? "No mods found" : "No translatable mods found"}
          </strong>
          <span>
            {query.trim()
              ? "Change or clear the search term."
              : "The latest scan did not find a supported i18n component."}
          </span>
          {query.trim() && (
            <button
              className="translator-button translator-button-quiet"
              type="button"
              onClick={onClearQuery}
              disabled={!onClearQuery}
            >
              Clear filter
            </button>
          )}
        </div>
      )}

      {menu && (
        <>
          <div
            className="translator-context-scrim"
            onMouseDown={() => closeMenu(false)}
            onContextMenu={(event) => {
              event.preventDefault();
              closeMenu(false);
            }}
          />
          <ul
            ref={menuRef}
            className="translator-context-menu"
            style={{ left: menu.x, top: menu.y }}
            role="menu"
            aria-label="Mod actions"
            onKeyDown={onMenuKeyDown}
            onBlur={(event) => {
              const next = event.relatedTarget;
              if (
                !(next instanceof Node) ||
                !event.currentTarget.contains(next)
              ) {
                closeMenu(false);
              }
            }}
          >
            <li className="translator-context-count" role="presentation">
              <span>{menu.mod.name}</span>
            </li>
            <li role="none">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  void openModFolder(menu.mod.folderPath);
                  closeMenu(false);
                }}
              >
                <span className="translator-menu-label">
                  <FolderOpen aria-hidden="true" /> Open mod folder
                </span>
              </button>
            </li>
            <li role="none">
              <button
                type="button"
                role="menuitem"
                aria-label="Open on Nexus"
                disabled={menu.mod.nexusId == null}
                title={
                  menu.mod.nexusId == null
                    ? "No Nexus Mods link available"
                    : undefined
                }
                onClick={() => {
                  if (menu.mod.nexusId == null) return;
                  void openUrl(
                    `https://www.nexusmods.com/stardewvalley/mods/${menu.mod.nexusId}`,
                  );
                  closeMenu(false);
                }}
              >
                <span className="translator-menu-label">
                  <ExternalLink aria-hidden="true" /> Open on Nexus
                </span>
                {menu.mod.nexusId == null && (
                  <span
                    className="translator-context-shortcut"
                    aria-hidden="true"
                  >
                    Unavailable
                  </span>
                )}
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
  visibleMods,
  searching,
  selectedId,
  firstVisibleId,
  selectedVisible,
  onSelect,
  onContextMenu,
  menuOpenId,
}: {
  group: PackageGroup;
  visibleMods: ScannedMod[];
  searching: boolean;
  selectedId: string | null;
  firstVisibleId: string | null;
  selectedVisible: boolean;
  onSelect: (uniqueId: string) => void;
  onContextMenu: (
    mod: ScannedMod,
    event: Pick<ReactMouseEvent, "preventDefault" | "clientX" | "clientY">,
    trigger: HTMLElement | null,
  ) => void;
  menuOpenId: string | null;
}) {
  const [open, setOpen] = useState(true);
  const percent = Math.round(group.progress * 100);
  const expanded = searching || open;
  return (
    <>
      <button
        className="translator-mod-group-row"
        type="button"
        role="treeitem"
        aria-expanded={expanded}
        title={`${group.translatedKeys.toLocaleString()} of ${group.totalKeys.toLocaleString()} ${group.totalKeys === 1 ? "string" : "strings"} translated, ${group.reviewNeeded.toLocaleString()} awaiting review, ${group.fileCount.toLocaleString()} i18n ${group.fileCount === 1 ? "file" : "files"}, ${percent} percent.`}
        onClick={() => setOpen((value) => !value)}
      >
        <strong>
          <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
          <span className="translator-mod-group-name">{group.packageId}</span>
          <span
            className="translator-mod-component-badge"
            title={`${group.mods.length} translatable components`}
          >
            {group.mods.length} comps.
          </span>
        </strong>
        <span />
        <span className="translator-mod-nexus">{group.nexusId ?? "—"}</span>
        <span className="translator-mod-percent">{percent}%</span>
        <span className="translator-mod-progress" aria-hidden="true">
          <span style={progressStyle(group.progress)} />
        </span>
      </button>
      {expanded &&
        visibleMods.map((mod, index) => (
          <ModRow
            key={mod.uniqueId}
            mod={mod}
            child
            lastChild={index === visibleMods.length - 1}
            selectedId={selectedId}
            tabStop={
              mod.uniqueId === selectedId ||
              (!selectedVisible && mod.uniqueId === firstVisibleId)
            }
            onSelect={onSelect}
            onContextMenu={onContextMenu}
            menuOpen={menuOpenId === mod.uniqueId}
          />
        ))}
    </>
  );
}

function ModRow({
  mod,
  child = false,
  lastChild = false,
  selectedId,
  tabStop,
  onSelect,
  onContextMenu,
  menuOpen,
}: {
  mod: ScannedMod;
  child?: boolean;
  lastChild?: boolean;
  selectedId: string | null;
  tabStop: boolean;
  onSelect: (uniqueId: string) => void;
  onContextMenu: (
    mod: ScannedMod,
    event: Pick<ReactMouseEvent, "preventDefault" | "clientX" | "clientY">,
    trigger: HTMLElement | null,
  ) => void;
  menuOpen: boolean;
}) {
  const selected = mod.uniqueId === selectedId;
  const percent = Math.round(mod.progress * 100);
  const multipleSources = mod.i18nFiles.length > 1;
  return (
    <div
      className={`translator-mod-row${child ? " is-child" : ""}`}
      role="treeitem"
      aria-current={selected ? "true" : undefined}
      tabIndex={tabStop ? 0 : -1}
      data-mod-id={mod.uniqueId}
      data-mod-progress={`${mod.translatedKeys} / ${mod.totalKeys} · ${percent}%`}
      data-progress-state={progressState(mod.progress)}
      title={`${mod.name} · ${mod.translatedKeys.toLocaleString()} of ${mod.totalKeys.toLocaleString()} ${mod.totalKeys === 1 ? "string" : "strings"} translated · ${mod.i18nFiles.length} i18n ${mod.i18nFiles.length === 1 ? "source" : "sources"}`}
      onClick={() => onSelect(mod.uniqueId)}
      onContextMenu={(event) => onContextMenu(mod, event, event.currentTarget)}
    >
      <span
        className={`translator-mod-name${multipleSources ? " has-files" : ""}`}
      >
        {child && (
          <span
            className={`translator-tree-branch${lastChild ? " is-last" : ""}`}
            aria-hidden="true"
          />
        )}
        <span className="translator-mod-label">{mod.name}</span>
        {multipleSources && (
          <span
            className="translator-mod-file-badge"
            title={`${mod.i18nFiles.length} i18n source folders`}
          >
            {mod.i18nFiles.length} i18n sources
          </span>
        )}
      </span>
      <span className="translator-mod-version">{mod.version || "—"}</span>
      <span
        className="translator-mod-nexus"
        title={
          mod.nexusId == null
            ? "No Nexus Mods link available"
            : "Open Nexus Mods from the context menu"
        }
      >
        {mod.nexusId ?? "—"}
      </span>
      <span className="translator-mod-percent">
        {mod.totalKeys > 0 ? `${percent}%` : "—"}
      </span>
      <span className="translator-mod-progress" aria-hidden="true">
        <span style={progressStyle(mod.progress)} />
      </span>
      <button
        type="button"
        className="translator-row-more"
        aria-label={`More actions for ${mod.name}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        title="More actions"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          const box = event.currentTarget.getBoundingClientRect();
          onContextMenu(
            mod,
            {
              preventDefault() {},
              clientX: box.left,
              clientY: box.bottom,
            },
            event.currentTarget,
          );
        }}
      >
        <span aria-hidden="true">⋯</span>
      </button>
    </div>
  );
}
