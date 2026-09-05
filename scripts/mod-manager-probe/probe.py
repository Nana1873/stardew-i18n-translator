"""Synthetic-only Vortex experiment. Not an application integration or deployer."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import uuid

START = time.perf_counter()
HERE = Path(__file__).resolve().parent
FROZEN = getattr(sys, "frozen", False)
ROOT = (Path(sys.executable).resolve().parents[2] if FROZEN
        else HERE.parents[1] / "target" / "mod-manager-probe")
PIN = "a40880d22e0658f717d301a0a5047ed6a6cffbe8"


def hashes(root):
    return {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(root.rglob("*")) if p.is_file()}


def dump(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2), encoding="utf-8")


def fixture(run):
    # Fixture construction is a separate phase; writes are intentional here only.
    import plyvel_next

    inputs = run / "input"
    staging = inputs / "staging"
    game = inputs / "game"
    game.mkdir(parents=True)
    normal = "Example/i18n/de.json"
    override = "Example/i18n/override.json"
    mods = {}

    def mod(mid, files, after=(), archive=None, rules=(), overrides=()):
        folder = staging / mid
        for path in files:
            dump(folder / path, {"fixture": mid})
        index = len(mods) + 1
        mods[mid] = {
            "id": mid, "installationPath": mid, "state": "installed",
            "attributes": {"customFileName": mid, "fileName": archive or mid + ".zip",
                           "modId": 1000 + index, "fileId": 2000 + index,
                           "version": "1.0", "downloadGame": "stardewvalley"},
            "rules": [{"type": "after", "reference": {"id": other}} for other in after] + list(rules),
            "fileOverrides": list(overrides),
        }

    mod("original", ["Example/manifest.json", "Example/i18n/default.json", normal, override],
        overrides=[str(game / "Mods" / override)])
    dump(staging / "original" / "Example" / "manifest.json", {
        "Name": "Synthetic Example", "Author": "Probe", "Version": "1.0.0",
        "UniqueID": "Probe.Example", "UpdateKeys": ["Nexus:1001"],
    })
    mod("community", [normal, override], after=["original"])
    mod("own-output", [normal], after=["community"])
    # The private output deliberately has no borrowed Nexus identifiers.
    mods["own-output"]["attributes"].update(modId=None, fileId=None)
    mod("disabled", [normal], after=["own-output"])
    amb = "Ambiguous/i18n/de.json"
    mod("variant-a", [amb], archive="shared.zip")
    mod("variant-b", [amb], archive="shared.zip")
    mod("ambiguous-rule", [amb], rules=[
        {"type": "after", "reference": {"fileExpression": "shared.zip"}}])
    unsupported = "Unsupported/i18n/de.json"
    mod("unsupported-base", [unsupported])
    mod("unsupported-rule", [unsupported], rules=[
        {"type": "requires", "reference": {"id": "unsupported-base"}}])
    cycle = "Cycle/i18n/de.json"
    mod("cycle-a", [cycle], after=["cycle-b"])
    mod("cycle-b", [cycle], after=["cycle-a"])
    unordered = "Unordered/i18n/de.json"
    mod("unordered-a", [unordered])
    mod("unordered-b", [unordered])
    profiles = {
        "personal": {"name": "Personal", "gameId": "stardewvalley", "modState": {
            mid: {"enabled": mid != "disabled"} for mid in mods}},
        "community-only": {"name": "Community only", "gameId": "stardewvalley", "modState": {
            mid: {"enabled": mid not in {"disabled", "own-output"}} for mid in mods}},
    }
    data = {
        "persistent": {"profiles": profiles, "mods": {"stardewvalley": mods}},
        "settings": {
            "mods": {"installPath": {"stardewvalley": str(staging)}},
            "profiles": {"activeProfileId": "personal", "lastActiveProfile": {"stardewvalley": "personal"}},
            "gameMode": {"discovered": {"stardewvalley": {"path": str(game)}}},
        },
    }
    entries = {}

    def flatten(value, prefix=""):
        for key, item in value.items():
            full = prefix + key
            if isinstance(item, dict):
                flatten(item, full + "###")
            else:
                entries[full] = json.dumps(item)

    flatten(data)
    db_path = inputs / "state.v2"
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with plyvel_next.DB(str(db_path), create_if_missing=True) as database:
        for key, value in entries.items():
            database.put(key.encode(), value.encode())
    dump(inputs / "expected-data.json", data)
    dump(inputs / "request.json", {"schema": 1, "ownOutputIds": ["own-output"]})
    return inputs


def guard(inputs, scratch):
    """Python audit guard, not an OS sandbox; native DB opens are guarded below."""
    allowed_read = [inputs, scratch, HERE, Path(sys.prefix), Path(sys.base_prefix)]
    if FROZEN:
        allowed_read.append(Path(sys.executable).resolve().parent)
    counters = {"pythonWrites": 0, "blocked": [], "nativeDbOpens": 0}

    def within(path, roots):
        if isinstance(path, int) or path is None:
            return True
        p = Path(os.fsdecode(path)).resolve()
        return any(p.is_relative_to(root.resolve()) for root in roots)

    def deny(reason):
        counters["blocked"].append(reason)
        raise PermissionError(reason)

    def audit(event, args):
        if event.startswith(("socket.", "subprocess.", "winreg.")) or event in {
            "os.system", "os.startfile", "os.startfile/2", "os.symlink", "os.link"}:
            deny(event)
        if event == "open":
            path, mode, flags = args
            writing = (isinstance(mode, str) and any(x in mode for x in "wax+")) or (
                isinstance(flags, int) and flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC))
            if writing:
                if not within(path, [scratch]):
                    deny("write outside scratch")
                counters["pythonWrites"] += 1
            elif not within(path, allowed_read):
                deny("read outside fixture/runtime")
        elif event in {"os.listdir", "os.scandir"} and not within(args[0], allowed_read):
            deny("directory outside fixture/runtime")
        elif event in {"os.remove", "os.rmdir", "os.mkdir", "os.rename", "os.chmod", "os.utime"}:
            targets = args[:2] if event == "os.rename" else args[:1]
            if not all(within(p, [scratch]) for p in targets):
                deny("filesystem mutation outside scratch")

    sys.addaudithook(audit)
    return counters, deny


def normalize(path):
    return str(path).replace("\\", "/").casefold()


def resolve_file(path, active, raw_mods, own_ids, exclude_output=False):
    """Small conservative fixture resolver; NOT supplied by mod-manager-lib.

    Unlike an arbitrary topological sort, require a unique comparable winner.
    Only the exercised exact-id / exact-fileExpression and fileOverride subset
    is accepted. Any unsupported reference/rule remains explicit.
    """
    active = {mid: mod for mid, mod in active.items()
              if not (exclude_output and mid in own_ids)}
    candidates = {mid for mid, mod in active.items()
                  if path in {normalize(p) for p in mod.files}}
    if not candidates:
        return {"state": "absent"}
    edges = {mid: set() for mid in active}
    problems = []
    for mid, model in active.items():
        for rule in raw_mods[mid].get("rules", []):
            ref = rule.get("reference", {})
            matches = []
            if set(ref) == {"id"}:
                matches = [ref["id"]] if ref["id"] in active else []
            elif set(ref) == {"fileExpression"}:
                matches = [other for other in active if
                           raw_mods[other]["attributes"]["fileName"].casefold() == ref["fileExpression"].casefold()]
                if len(matches) > 1 and mid in candidates:
                    problems.append("ambiguous fileExpression")
            elif mid in candidates:
                problems.append("unsupported reference")
            kind = rule.get("type")
            if kind not in {"before", "after"}:
                if mid in candidates:
                    problems.append("unsupported rule type")
                continue
            if len(matches) == 1:
                other = matches[0]
                if kind == "before":
                    edges[mid].add(other)
                else:
                    edges[other].add(mid)
    if problems:
        return {"state": "unresolved", "reasons": sorted(set(problems))}

    reach = {}
    for mid in active:
        seen, todo = set(), list(edges[mid])
        while todo:
            next_id = todo.pop()
            if next_id not in seen:
                seen.add(next_id)
                todo.extend(edges[next_id])
        reach[mid] = seen
    if any(mid in reach[mid] for mid in candidates):
        return {"state": "unresolved", "reasons": ["cyclic rules"]}
    # Vortex fileOverrides names the forced winner (observed source contract).
    forced = [mid for mid in candidates if any(
        normalize(p).endswith("/mods/" + path) or normalize(p) == path
        for p in raw_mods[mid].get("fileOverrides", []))]
    winners = forced or [mid for mid in candidates
                         if all(mid == other or mid in reach[other] for other in candidates)]
    if len(winners) != 1:
        return {"state": "unresolved", "reasons": ["no unique ordered winner"]}
    mid = winners[0]
    actual = next(p for p in active[mid].files if normalize(p) == path)
    physical = active[mid].path / actual
    return {"state": "resolved", "managerModId": mid, "path": str(physical),
            "sha256": hashlib.sha256(physical.read_bytes()).hexdigest(),
            "reason": "fileOverride" if forced else "unique ordered candidate"}


def worker(run):
    inputs, scratch = run / "input", run / "scratch"
    # Parent prepares this scratch DB. Never open the immutable input DB natively.
    os.environ.update(APPDATA=str(scratch / "appdata"), LOCALAPPDATA=str(scratch / "localappdata"),
                      USERPROFILE=str(scratch / "user"), TEMP=str(scratch / "tmp"), TMP=str(scratch / "tmp"))
    for name in ("NEXUS_API_KEY", "PYTHONPATH"):
        os.environ.pop(name, None)
    sys.dont_write_bytecode = True
    counters, deny = guard(inputs, scratch)
    import plyvel_next
    import pyuac

    pyuac.runAsAdmin = lambda *a, **kw: deny("UAC")
    native_db = plyvel_next.DB
    db_path = scratch / "appdata" / "Vortex" / "state.v2"

    class ReadCallsOnly:
        def __init__(self, path, *args, **kwargs):
            if Path(path).resolve() != db_path.resolve() or args or kwargs:
                deny("unexpected native DB open")
            counters["nativeDbOpens"] += 1
            self.db = native_db(path, create_if_missing=False)

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            self.db.close()

        def iterator(self, *args, **kwargs):
            return self.db.iterator(*args, **kwargs)

        def __getattr__(self, name):
            deny("native DB mutation/access: " + name)

    plyvel_next.DB = ReadCallsOnly
    import mod_manager_lib.core.game as game_module
    from mod_manager_lib.core.game_service import GameService
    from mod_manager_lib.core.mod_manager.vortex.api import Vortex
    from mod_manager_lib.core.mod_manager.vortex.leveldb import LevelDB
    from mod_manager_lib.core.mod_manager.vortex.profile_info import ProfileInfo

    game_module.get_documents_folder = lambda: scratch / "documents"
    for name in ("prepare_instance", "create_instance", "install_mod", "finalize_instance", "add_tool", "install_mod_files"):
        setattr(Vortex, name, lambda *a, _name=name, **kw: deny("manager mutation: " + _name))
    LevelDB.save = lambda *a, **kw: deny("DB save")
    GameService(json.dumps([{"id": "stardewvalley", "display_name": "Stardew Valley",
                            "short_name": "stardewvalley", "nexus_id": "stardewvalley",
                            "inidir": str(scratch / "documents"), "inifiles": [], "mods_folder": "Mods"}]))
    game = GameService.get_game_by_id("stardewvalley")
    request = json.loads((inputs / "request.json").read_text())
    vortex = Vortex()
    assert vortex.db_path == db_path
    database = LevelDB(db_path, use_symlink=False)
    def logical_db_hash():
        with plyvel_next.DB(str(db_path)) as handle:
            content = [[k.decode(), v.decode()] for k, v in handle.iterator()]
        return hashlib.sha256(json.dumps(content).encode()).hexdigest()

    logical_before = logical_db_hash()
    # Independent raw metadata supports conservative unresolved reporting. This
    # extra resolver is our experiment code, never claimed as library capability.
    raw_mods = database.get_section("persistent###mods###stardewvalley###")["persistent"]["mods"]["stardewvalley"]
    active_profile = database.get_key("settings###profiles###activeProfileId")
    profiles = []
    for pid, display in [("personal", "Personal"), ("community-only", "Community only")]:
        info = ProfileInfo(id=pid, display_name=f"{display} ({pid})", game=game)
        models = vortex.load_mods(info, inputs / "game", load_conflicts=True)
        by_id = {mod.path.name: mod for mod in models}
        active = {mid: mod for mid, mod in by_id.items() if mod.enabled}
        paths = sorted({normalize(path) for mod in active.values() for path in mod.files})
        profiles.append({
            "profileId": pid, "isActive": pid == active_profile,
            "activeMods": [{"managerModId": mid, "nexus": mod.metadata.model_dump(),
                            "path": str(mod.path), "ownOutput": mid in request["ownOutputIds"],
                            "libraryOverwrittenBy": [other.path.name for other in mod.mod_conflicts],
                            "libraryFileConflicts": {key: val.path.name for key, val in mod.file_conflicts.items()}}
                           for mid, mod in active.items()],
            "files": [{"relativePath": path,
                       "effectiveCandidate": resolve_file(path, active, raw_mods, request["ownOutputIds"]),
                       "communityBase": resolve_file(path, active, raw_mods, request["ownOutputIds"], True)}
                      for path in paths],
        })
    import psutil
    memory = psutil.Process().memory_info()
    logical_after = logical_db_hash()
    assert logical_before == logical_after, "Logical database entries changed"
    normal_guard = dict(counters, blocked=list(counters["blocked"]))
    expected_blocks = []
    # Exercise the barriers, not merely their registration. No operation below
    # reaches its resource when the guard works; failed checks stop this probe.
    import socket
    checks = {
        "network": lambda: socket.socket(),
        "process": lambda: sys.audit("subprocess.Popen", "unused", [], None, None),
        "registry": lambda: sys.audit("winreg.OpenKey", 0, "unused", 0),
        "uac": lambda: pyuac.runAsAdmin([]),
        "inputWrite": lambda: (inputs / "request.json").write_text("invalid"),
        "outsideRead": lambda: (ROOT.parent / "never-read-probe-sentinel").read_bytes(),
        "managerMutation": lambda: vortex.install_mod(None),
        "nativeInputDb": lambda: plyvel_next.DB(str(inputs / "state.v2")),
    }
    for label, action in checks.items():
        try:
            action()
        except PermissionError:
            expected_blocks.append(label)
        else:
            raise AssertionError("Guard failed: " + label)
    print(json.dumps({"schema": 1, "pin": PIN, "activeProfileId": active_profile,
                      "profiles": profiles, "guard": normal_guard,
                      "logicalDbHashes": {"before": logical_before, "after": logical_after},
                      "guardNegativeChecks": expected_blocks,
                      "metrics": {"workerSeconds": time.perf_counter() - START,
                                  "peakWorkingSetBytes": memory.peak_wset},
                      "limitations": ["Candidates from metadata, not proof of deployed files or SMAPI behavior",
                                      "Python audit guard is not an OS sandbox; native loader is outside its coverage",
                                      "Native LevelDB opens only a disposable scratch copy",
                                      "Conservative winner resolver is probe code, not a mod-manager-lib API"]}))


def check(result):
    assert result["activeProfileId"] == "personal"
    for profile in result["profiles"]:
        active = {m["managerModId"]: m for m in profile["activeMods"]}
        assert "disabled" not in active
        assert active["original"]["nexus"]["mod_id"] == 1001
        assert active["community"]["nexus"]["file_id"] == 2002
        files = {f["relativePath"]: f for f in profile["files"]}
        normal = files["example/i18n/de.json"]
        expected = "own-output" if profile["profileId"] == "personal" else "community"
        assert normal["effectiveCandidate"]["managerModId"] == expected
        assert normal["communityBase"]["managerModId"] == "community"
        override = files["example/i18n/override.json"]
        assert override["effectiveCandidate"]["managerModId"] == "original"
        assert override["effectiveCandidate"]["reason"] == "fileOverride"
        for folder, reason in [("ambiguous", "ambiguous fileExpression"),
                               ("unsupported", "unsupported rule type"),
                               ("cycle", "cyclic rules"),
                               ("unordered", "no unique ordered winner")]:
            value = files[folder + "/i18n/de.json"]["effectiveCandidate"]
            assert value == {"state": "unresolved", "reasons": [reason]}, value
    assert not result["guard"]["blocked"], result["guard"]
    assert len(result["guardNegativeChecks"]) == 8


def main():
    if len(sys.argv) == 3 and sys.argv[1] == "--worker":
        run = Path(sys.argv[2]).resolve()
        if run.parent != ROOT.resolve() or not run.name.startswith("run-"):
            raise ValueError("Only generated probe runs are accepted")
        worker(run)
        return
    packaged = sys.argv[1:] == ["--packaged"]
    if FROZEN or (len(sys.argv) != 1 and not packaged):
        raise ValueError("Only --packaged or a generated --worker run is accepted")
    run = ROOT / ("run-" + uuid.uuid4().hex)
    inputs = fixture(run)
    before = hashes(inputs)
    scratch = run / "scratch"
    for name in ("appdata", "localappdata", "user", "tmp", "documents"):
        (scratch / name).mkdir(parents=True, exist_ok=True)
    db = scratch / "appdata" / "Vortex" / "state.v2"
    shutil.copytree(inputs / "state.v2", db)
    db_before = hashes(db)
    started = time.perf_counter()
    executable = ROOT / "packaged" / "mod-manager-probe" / "mod-manager-probe.exe"
    command = ([str(executable)] if packaged else [sys.executable, "-B", str(Path(__file__).resolve())])
    completed = subprocess.run(command + ["--worker", str(run)],
                               text=True, capture_output=True, timeout=60)
    wall = time.perf_counter() - started
    (run / "worker.stderr.txt").write_text(completed.stderr, encoding="utf-8")
    if completed.returncode:
        raise RuntimeError(completed.stderr)
    result = json.loads(completed.stdout)
    check(result)
    assert hashes(inputs) == before, "Immutable fixture inputs changed"
    db_after = hashes(db)
    result["verification"] = {
        "passed": True, "inputHashesUnchanged": True, "inputFileCount": len(before),
        "scratchDbChangedFiles": sorted(k for k in db_before.keys() | db_after.keys()
                                       if db_before.get(k) != db_after.get(k)),
        "scope": "Synthetic native LevelDB only; no live deployment or Collection proof",
    }
    result["metrics"]["processWallSeconds"] = wall
    result["metrics"]["packaged"] = packaged
    if packaged:
        result["metrics"]["packagedLogicalBytes"] = sum(p.stat().st_size for p in
            executable.parent.rglob("*") if p.is_file())
    result["metrics"]["sitePackagesLogicalBytes"] = sum(p.stat().st_size for p in
        (Path(sys.prefix) / "Lib" / "site-packages").rglob("*") if p.is_file())
    result["metrics"]["pythonRuntimeLogicalBytes"] = sum(p.stat().st_size for p in
        Path(sys.base_prefix).rglob("*") if p.is_file())
    dump(run / "input-hashes.json", before)
    dump(run / "result.json", result)
    print(json.dumps({"result": str(run / "result.json"), "metrics": result["metrics"],
                      "verification": result["verification"]}, indent=2))


if __name__ == "__main__":
    main()
