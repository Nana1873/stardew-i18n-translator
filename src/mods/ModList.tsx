/**
 * Mod list tree — M1 / Issue 6 (SPEC §7.3).
 *
 * Mods grouped by package (top-level Mods subfolder), SSE-AT style. A package
 * with one component renders as a single flat row; a package with several
 * (e.g. Ridgeside's [CP]/[CC]/SMAPI) renders as an expandable parent whose
 * children are the components. Status/Fortschritt are placeholders until string
 * parsing (Issue 5) lands.
 */
import { useState } from "react";
import { type ModStatus, type ScannedMod, openUrl } from "../tauri/commands";

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
  if (translated >= total) return "imported";
  return "untranslated";
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
  return order.map((packageId) => {
    const group = byId.get(packageId)!;
    const totalKeys = group.reduce((sum, mod) => sum + mod.totalKeys, 0);
    const translatedKeys = group.reduce((sum, mod) => sum + mod.translatedKeys, 0);
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
}

function StatusDot({ status }: { status: ModStatus }) {
  const color =
    status === "imported"
      ? "#6ab0ff"
      : status === "untranslated"
        ? "#e06c6c"
        : "var(--text-muted)";
  const title =
    status === "imported"
      ? "All strings present (imported)"
      : status === "untranslated"
        ? "Has untranslated strings"
        : "No translatable strings";
  return (
    <span className="modrow__status" style={{ color }} title={title} aria-label={status}>
      ●
    </span>
  );
}

function ProgressCell({ total, progress }: { total: number; progress: number }) {
  if (total === 0) {
    return <span className="modrow__progress">—</span>;
  }
  return <span className="modrow__progress">{Math.round(progress * 100)}%</span>;
}

interface ModListProps {
  mods: ScannedMod[];
  selectedId: string | null;
  onSelect: (uniqueId: string) => void;
}

export function ModList({ mods, selectedId, onSelect }: ModListProps) {
  const groups = groupByPackage(mods);
  return (
    <div className="modlist" role="tree" aria-label="Mods">
      <div className="modrow modrow--head">
        <span title="Status" aria-label="Status" />
        <span>Mod</span>
        <span>Ver</span>
        <span>Nexus</span>
        <span>Files</span>
        <span>Progress</span>
      </div>
      {groups.map((group) =>
        group.mods.length === 1 ? (
          <ModRow
            key={group.mods[0].uniqueId}
            mod={group.mods[0]}
            depth={0}
            selectedId={selectedId}
            onSelect={onSelect}
          />
        ) : (
          <PackageNode
            key={group.packageId}
            group={group}
            selectedId={selectedId}
            onSelect={onSelect}
          />
        ),
      )}
    </div>
  );
}

function PackageNode({
  group,
  selectedId,
  onSelect,
}: {
  group: PackageGroup;
  selectedId: string | null;
  onSelect: (uniqueId: string) => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <div className="modrow modrow--package" role="treeitem" aria-expanded={open}>
        <StatusDot status={group.status} />
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
            onSelect={onSelect}
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
  onSelect,
}: {
  mod: ScannedMod;
  depth: number;
  child?: boolean;
  lastChild?: boolean;
  selectedId: string | null;
  onSelect: (uniqueId: string) => void;
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
      onClick={() => onSelect(mod.uniqueId)}
    >
      <StatusDot status={mod.status} />
      <span
        className="modrow__name"
        style={{ paddingLeft: depth ? 16 + depth * 14 : undefined }}
        title={mod.name}
      >
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
