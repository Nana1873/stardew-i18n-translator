use rusty_leveldb::{DB, LdbIterator, Options};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    time::{Instant, SystemTime, UNIX_EPOCH},
};

type R<T> = Result<T, String>;
const LIMIT: u64 = 64 * 1024 * 1024;

fn error(_: impl std::fmt::Display) -> String {
    "Filesystem or database operation failed; no raw values emitted".into()
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn text(v: &Value) -> R<&str> {
    v.as_str()
        .filter(|s| !s.is_empty() && s.len() < 8192)
        .ok_or("Unsupported/missing string metadata".into())
}
fn norm(p: &str) -> String {
    p.replace('\\', "/").to_lowercase()
}
fn object(v: &Value) -> R<&serde_json::Map<String, Value>> {
    v.as_object()
        .ok_or("Unsupported/missing object metadata".into())
}

fn safe_meta(path: &Path) -> R<fs::Metadata> {
    let m = fs::symlink_metadata(path).map_err(error)?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if m.file_attributes() & 0x400 != 0 {
            return Err("Reparse points are not supported in synthetic snapshots".into());
        }
    }
    if m.file_type().is_symlink() {
        return Err("Symlinks are not supported".into());
    }
    Ok(m)
}
fn inventory(root: &Path) -> R<BTreeMap<String, String>> {
    fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<String, String>, size: &mut u64) -> R<()> {
        for item in fs::read_dir(dir).map_err(error)? {
            let p = item.map_err(error)?.path();
            let m = safe_meta(&p)?;
            if m.is_dir() {
                walk(root, &p, out, size)?;
            } else if m.is_file() {
                *size += m.len();
                if *size > LIMIT || out.len() > 10000 {
                    return Err("Fixture exceeds probe limits".into());
                }
                out.insert(
                    p.strip_prefix(root)
                        .map_err(error)?
                        .to_string_lossy()
                        .into(),
                    digest(&fs::read(p).map_err(error)?),
                );
            }
        }
        Ok(())
    }
    safe_meta(root)?;
    let mut out = BTreeMap::new();
    walk(root, root, &mut out, &mut 0)?;
    Ok(out)
}
fn copy_tree(src: &Path, dst: &Path) -> R<()> {
    fs::create_dir_all(dst).map_err(error)?;
    for item in fs::read_dir(src).map_err(error)? {
        let p = item.map_err(error)?.path();
        let target = dst.join(p.file_name().ok_or("Missing filename")?);
        if safe_meta(&p)?.is_dir() {
            copy_tree(&p, &target)?;
        } else {
            fs::copy(p, target).map_err(error)?;
        }
    }
    Ok(())
}
fn write_json(path: &Path, value: &Value) -> R<()> {
    fs::write(path, serde_json::to_vec_pretty(value).map_err(error)?).map_err(error)
}
fn options() -> Options {
    // Source documents a compressor mismatch hazard. Native fixture uses Snappy.
    Options {
        create_if_missing: false,
        paranoid_checks: true,
        compressor: 1,
        ..Options::default()
    }
}

fn allowed(parts: &[&str]) -> bool {
    match parts {
        ["settings", "profiles", "activeProfileId"]
        | ["settings", "profiles", "lastActiveProfile", "stardewvalley"]
        | ["settings", "mods", "installPath", "stardewvalley"]
        | [
            "settings",
            "gameMode",
            "discovered",
            "stardewvalley",
            "path",
        ] => true,
        ["persistent", "profiles", _, "name" | "gameId"]
        | ["persistent", "profiles", _, "modState", _, "enabled"] => true,
        [
            "persistent",
            "mods",
            "stardewvalley",
            _,
            "installationPath" | "rules" | "fileOverrides" | "type",
        ] => true,
        [
            "persistent",
            "mods",
            "stardewvalley",
            _,
            "attributes",
            field,
        ] => matches!(
            *field,
            "modId" | "fileId" | "fileName" | "version" | "downloadGame"
        ),
        _ => false,
    }
}
fn insert(root: &mut Value, parts: &[&str], value: Value) -> R<()> {
    if parts.is_empty() {
        *root = value;
        return Ok(());
    }
    if root.is_null() {
        *root = json!({});
    }
    let map = root
        .as_object_mut()
        .ok_or("Conflicting database key shape")?;
    insert(
        map.entry(parts[0]).or_insert(Value::Null),
        &parts[1..],
        value,
    )
}
fn read_metadata(path: &Path) -> R<Value> {
    let mut db =
        DB::open(path, options()).map_err(|_| "Cannot open snapshot database".to_string())?;
    let mut iter = db
        .new_iter()
        .map_err(|_| "Cannot iterate snapshot database")?;
    let snapshot = db.get_snapshot();
    let mut result = Value::Null;
    let mut count = 0;
    while let Some((key, _)) = iter.next() {
        count += 1;
        if count > 50000 || key.len() > 2048 {
            return Err("Database exceeds key limits".into());
        }
        let key_text = std::str::from_utf8(&key).map_err(|_| "Invalid database key encoding")?;
        let parts: Vec<_> = key_text.split("###").collect();
        if !allowed(&parts) {
            continue;
        }
        // Use the fallible get API rather than the convenience get() that hides errors.
        let bytes = db
            .get_at(&snapshot, &key)
            .map_err(|_| "Cannot read allowlisted database value")?
            .ok_or("Allowlisted database value disappeared")?;
        if bytes.len() > 1024 * 1024 {
            return Err("Metadata value exceeds limit".into());
        }
        let value =
            serde_json::from_slice(&bytes).map_err(|_| "Invalid JSON in allowlisted metadata")?;
        insert(&mut result, &parts, value)?;
    }
    Ok(result)
}

#[derive(Clone)]
struct Mod {
    id: String,
    path: PathBuf,
    attrs: Value,
    rules: Vec<Value>,
    overrides: Vec<String>,
    files: BTreeMap<String, PathBuf>,
}
fn files(path: &Path) -> R<BTreeMap<String, PathBuf>> {
    let hashes = inventory(path)?;
    let mut out = BTreeMap::new();
    for relative in hashes.keys() {
        if out.insert(norm(relative), path.join(relative)).is_some() {
            return Err("Case-insensitive file collision".into());
        }
    }
    Ok(out)
}
fn relative_only(value: &str) -> R<&str> {
    let p = Path::new(value);
    if p.is_absolute()
        || p.components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        return Err("Unsupported installation path".into());
    }
    Ok(value)
}
fn load_mods(data: &Value, input: &Path) -> R<BTreeMap<String, Mod>> {
    let mut mods = BTreeMap::new();
    for (id, value) in object(&data["persistent"]["mods"]["stardewvalley"])? {
        if !value["type"].is_null() && value["type"] != "" {
            return Err("Unsupported mod type; root/Collection semantics not inferred".into());
        }
        let folder = relative_only(text(&value["installationPath"])?)?;
        let path = input.join("staging").join(folder);
        let attrs = object(&value["attributes"])?;
        for key in ["modId", "fileId"] {
            let v = attrs.get(key).unwrap_or(&Value::Null);
            if !v.is_null() && v.as_u64().is_none_or(|n| n == 0) {
                return Err("Unsupported Nexus identifier value".into());
            }
        }
        for key in ["fileName", "version", "downloadGame"] {
            text(&value["attributes"][key])?;
        }
        let rules = value["rules"].as_array().cloned().unwrap_or_default();
        if !value["rules"].is_null() && !value["rules"].is_array() {
            return Err("Unsupported rules shape".into());
        }
        let overrides = match &value["fileOverrides"] {
            Value::Null => vec![],
            Value::Array(values) => values
                .iter()
                .map(|v| text(v).map(String::from))
                .collect::<R<Vec<_>>>()?,
            _ => return Err("Unsupported fileOverrides shape".into()),
        };
        mods.insert(
            id.clone(),
            Mod {
                id: id.clone(),
                path: path.clone(),
                attrs: value["attributes"].clone(),
                rules,
                overrides,
                files: files(&path)?,
            },
        );
    }
    Ok(mods)
}
fn unresolved(reason: &str) -> Value {
    json!({"state":"unresolved", "reason":reason})
}
fn resolve(
    path: &str,
    game_path: &str,
    active: &BTreeMap<String, Mod>,
    own: &BTreeSet<String>,
    base: bool,
) -> R<Value> {
    let active: BTreeMap<_, _> = active
        .iter()
        .filter(|(id, _)| !base || !own.contains(*id))
        .collect();
    let candidates: BTreeSet<_> = active
        .iter()
        .filter(|(_, m)| m.files.contains_key(path))
        .map(|(id, _)| (*id).clone())
        .collect();
    if candidates.is_empty() {
        return Ok(json!({"state":"absent"}));
    }
    let mut edges: BTreeMap<String, BTreeSet<String>> = active
        .keys()
        .map(|id| ((*id).clone(), BTreeSet::new()))
        .collect();
    let mut issues: BTreeMap<String, &str> = BTreeMap::new();
    for (id, m) in &active {
        for rule in &m.rules {
            let Some(reference) = rule["reference"].as_object() else {
                issues.insert((*id).clone(), "unsupported reference");
                continue;
            };
            let matches: Vec<_> = if reference.len() == 1 && reference.contains_key("id") {
                let target = text(&reference["id"])?;
                active
                    .keys()
                    .filter(|other| other.as_str() == target)
                    .map(|v| (*v).clone())
                    .collect()
            } else if reference.len() == 1 && reference.contains_key("fileExpression") {
                let expr = text(&reference["fileExpression"])?;
                if expr.contains(['*', '?']) {
                    issues.insert((*id).clone(), "unsupported fileExpression");
                }
                active
                    .iter()
                    .filter(|(_, other)| {
                        other.attrs["fileName"]
                            .as_str()
                            .is_some_and(|s| s.eq_ignore_ascii_case(expr))
                    })
                    .map(|(other, _)| (*other).clone())
                    .collect()
            } else {
                issues.insert((*id).clone(), "unsupported reference");
                vec![]
            };
            if matches.len() > 1 {
                issues.insert((*id).clone(), "ambiguous fileExpression");
            }
            let kind = rule["type"].as_str().unwrap_or("");
            if kind != "before" && kind != "after" {
                issues.insert((*id).clone(), "unsupported rule type");
                continue;
            }
            if matches.len() == 1 {
                let other = &matches[0];
                let (from, to) = if kind == "before" {
                    ((*id).clone(), other.clone())
                } else {
                    (other.clone(), (*id).clone())
                };
                edges.get_mut(&from).ok_or("Missing graph node")?.insert(to);
            }
        }
    }
    let mut reach = BTreeMap::new();
    for id in active.keys() {
        let mut seen = BTreeSet::new();
        let mut todo: Vec<_> = edges[*id].iter().cloned().collect();
        while let Some(next) = todo.pop() {
            if seen.insert(next.clone()) {
                todo.extend(edges[&next].iter().cloned());
            }
        }
        reach.insert((*id).clone(), seen);
    }
    // Include connected order nodes when checking unsupported references.
    for (id, reason) in &issues {
        if candidates.contains(id)
            || candidates
                .iter()
                .any(|c| reach[c].contains(id) || reach[id].contains(c))
        {
            return Ok(unresolved(reason));
        }
    }
    if candidates.iter().any(|id| reach[id].contains(id)) {
        return Ok(unresolved("cyclic rules"));
    }
    let forced: Vec<_> = candidates
        .iter()
        .filter(|id| {
            active[id].overrides.iter().any(|p| {
                let p = norm(p);
                p == path || p == norm(&format!("{game_path}/Mods/{path}"))
            })
        })
        .collect();
    let winners: Vec<_> = if forced.is_empty() {
        candidates
            .iter()
            .filter(|id| {
                candidates
                    .iter()
                    .all(|other| *id == other || reach[other].contains(*id))
            })
            .collect()
    } else {
        forced.clone()
    };
    if winners.len() != 1 {
        return Ok(unresolved("no unique ordered winner"));
    }
    let winner = winners[0];
    let physical = &active[winner].files[path];
    Ok(
        json!({"state":"resolved", "managerModId":winner, "physicalPath":physical,
              "sha256":digest(&fs::read(physical).map_err(error)?), "reason":if forced.is_empty(){"unique ordered candidate"}else{"fileOverride"}}),
    )
}

fn project(data: &Value, input: &Path) -> R<Value> {
    let active_id = text(&data["settings"]["profiles"]["activeProfileId"])?;
    let last_id = text(&data["settings"]["profiles"]["lastActiveProfile"]["stardewvalley"])?;
    let game_path = text(&data["settings"]["gameMode"]["discovered"]["stardewvalley"]["path"])?;
    let staging_path = text(&data["settings"]["mods"]["installPath"]["stardewvalley"])?;
    // Path values are emitted as provenance only. File reads use copied staging.
    let mods = load_mods(data, input)?;
    let own: BTreeSet<_> = ["own-output".to_string()].into();
    let mut profiles = vec![];
    for (pid, p) in object(&data["persistent"]["profiles"])? {
        if p["gameId"] != "stardewvalley" {
            continue;
        }
        let states = object(&p["modState"])?;
        let mut selected = BTreeMap::new();
        let mut enabled_state = BTreeMap::new();
        for (id, state) in states {
            let enabled = state["enabled"]
                .as_bool()
                .ok_or("Unsupported enabled-state value")?;
            let m = mods
                .get(id)
                .ok_or("Profile references unavailable mod metadata")?;
            enabled_state.insert(id, enabled);
            if enabled {
                selected.insert(id.clone(), m.clone());
            }
        }
        let paths: BTreeSet<_> = selected
            .values()
            .flat_map(|m| m.files.keys().cloned())
            .collect();
        let mut views = vec![];
        for path in paths {
            views.push(json!({"relativePath":path, "effectiveCandidate":resolve(&path,game_path,&selected,&own,false)?,
                              "communityBase":resolve(&path,game_path,&selected,&own,true)?}));
        }
        // Rules are projected field-by-field, never dumping arbitrary rule attributes.
        let metadata: Vec<_> = selected.values().map(|m| json!({"managerModId":m.id,"installationPath":m.path,
            "nexus":m.attrs,"rules":m.rules.iter().map(|r| json!({"type":r["type"].as_str(),
                "referenceId":r["reference"]["id"].as_str(),"fileExpression":r["reference"]["fileExpression"].as_str()})).collect::<Vec<_>>(),
            "fileOverrides":m.overrides,"ownOutput":own.contains(&m.id)})).collect();
        profiles.push(json!({"profileId":pid,"isActive":pid==active_id,"modState":enabled_state,"activeMods":metadata,"files":views}));
    }
    if !profiles.iter().any(|p| p["profileId"] == active_id)
        || !profiles.iter().any(|p| p["profileId"] == last_id)
    {
        return Err("Active/last-active profile missing or not Stardew".into());
    }
    if active_id != last_id {
        return Err("Active/last-active profile disagreement".into());
    }
    Ok(
        json!({"schema":1,"activeProfileId":active_id,"lastActiveProfileId":last_id,
        "gamePath":game_path,"stagingPath":staging_path,"profiles":profiles,
        "scope":"synthetic metadata candidates, not live/deployed/in-game verification"}),
    )
}

fn expected(result: &Value) -> R<()> {
    if result["profiles"].as_array().is_none_or(|p| p.len() != 2) {
        return Err("Expected two profiles".into());
    }
    for p in result["profiles"].as_array().ok_or("Missing profiles")? {
        if p["activeMods"]
            .as_array()
            .ok_or("Missing mods")?
            .iter()
            .any(|m| m["managerModId"] == "disabled")
        {
            return Err("Disabled competitor leaked".into());
        }
        let views = p["files"].as_array().ok_or("Missing files")?;
        let original = p["activeMods"]
            .as_array()
            .ok_or("Missing mods")?
            .iter()
            .find(|m| m["managerModId"] == "original")
            .ok_or("Original missing")?;
        if original["nexus"]["modId"] != 1001 || original["nexus"]["fileId"] != 2001 {
            return Err("Wrong original Nexus identity".into());
        }
        let get = |s: &str| {
            views
                .iter()
                .find(|v| v["relativePath"] == s)
                .ok_or("Expected fixture file missing")
        };
        let normal = get("example/i18n/de.json")?;
        let winner = if p["profileId"] == "personal" {
            "own-output"
        } else {
            "community"
        };
        if normal["effectiveCandidate"]["managerModId"] != winner
            || normal["communityBase"]["managerModId"] != "community"
        {
            return Err("Wrong current/base winner".into());
        }
        if get("example/i18n/override.json")?["effectiveCandidate"]["managerModId"] != "original" {
            return Err("Wrong file override winner".into());
        }
        for (folder, reason) in [
            ("ambiguous", "ambiguous fileExpression"),
            ("unsupported", "unsupported rule type"),
            ("cycle", "cyclic rules"),
            ("unordered", "no unique ordered winner"),
        ] {
            if get(&format!("{folder}/i18n/de.json"))?["effectiveCandidate"] != unresolved(reason) {
                return Err("Expected unresolved fixture failed".into());
            }
        }
    }
    Ok(())
}

fn inject(working: &Path, mode: &str) -> R<()> {
    if mode == "corrupt-table" {
        let table = fs::read_dir(working)
            .map_err(error)?
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|p| p.extension().is_some_and(|s| s == "ldb"))
            .ok_or("Native SST fixture is missing")?;
        fs::write(table, b"truncated table fixture").map_err(error)?;
    } else if mode == "corrupt-current" {
        fs::write(working.join("CURRENT"), b"not-a-manifest\n").map_err(error)?;
    } else if matches!(
        mode,
        "invalid-json" | "invalid-state" | "escape-path" | "unknown-fields"
    ) {
        // Intentional fault injection on this experiment's disposable working DB.
        let mut db = DB::open(working, options()).map_err(error)?;
        let (key, value): (&[u8], &[u8]) = match mode {
            "invalid-json" => (b"settings###profiles###activeProfileId", b"{broken-json"),
            "invalid-state" => (
                b"persistent###profiles###personal###modState###original###enabled",
                b"\"yes\"",
            ),
            "escape-path" => (
                b"persistent###mods###stardewvalley###original###installationPath",
                b"\"../outside\"",
            ),
            _ => (
                b"persistent###mods###stardewvalley###original###attributes###privateToken",
                b"\"PROBE_SECRET_SENTINEL\"",
            ),
        };
        db.put(key, value).map_err(error)?;
        db.flush().map_err(error)?;
    }
    Ok(())
}

fn run(source: &Path, mode: &str) -> R<Value> {
    let started = Instant::now();
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let repo = manifest
        .parent()
        .and_then(Path::parent)
        .ok_or("Missing repo path")?;
    let source = source.canonicalize().map_err(error)?;
    let fixture_parent = repo
        .join("target/mod-manager-probe")
        .canonicalize()
        .map_err(error)?;
    if !source.starts_with(fixture_parent)
        || source.file_name().is_none_or(|s| s != "input")
        || !source.join("expected-data.json").is_file()
    {
        return Err("Only the prior synthetic Python probe input is accepted".into());
    }
    let original_hashes = inventory(&source)?;
    let db_source = if matches!(mode, "native-table" | "corrupt-table") {
        source
            .parent()
            .ok_or("Missing fixture parent")?
            .join("scratch/appdata/Vortex/state.v2")
    } else {
        source.join("state.v2")
    };
    let db_source_hashes = inventory(&db_source)?;
    if matches!(mode, "native-table" | "corrupt-table")
        && !db_source_hashes.keys().any(|k| k.ends_with(".ldb"))
    {
        return Err("Native SST fixture is missing".into());
    }
    let id = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(error)?
        .as_nanos();
    let run = repo
        .join("target/vortex-state-probe")
        .join(format!("run-{id}"));
    let input = run.join("input");
    copy_tree(&source, &input)?;
    let input_hashes = inventory(&input)?;
    let working = run.join("working-state.v2");
    copy_tree(&db_source, &working)?;
    let working_before = inventory(&working)?;
    inject(&working, mode)?;
    let reader_started = Instant::now();
    let operation = std::panic::catch_unwind(|| -> R<Value> {
        let data = read_metadata(&working)?;
        let mut output = project(&data, &input)?;
        expected(&output)?;
        output["metrics"] = json!({"elapsedSeconds":started.elapsed().as_secs_f64(),
            "readerSeconds":reader_started.elapsed().as_secs_f64(),
            "executableBytes":fs::metadata(std::env::current_exe().map_err(error)?).map_err(error)?.len()});
        Ok(output)
    }).map_err(|_| "Reader panicked on unsupported/corrupt input".to_string()).and_then(|r| r);
    let unchanged = inventory(&source)? == original_hashes
        && inventory(&input)? == input_hashes
        && inventory(&db_source)? == db_source_hashes;
    if !unchanged {
        return Err("Immutable inputs changed".into());
    }
    let mut result = match operation {
        Ok(value) => value,
        Err(message) => {
            write_json(
                &run.join("failure.json"),
                &json!({"mode":mode,"error":message,"immutableInputsUnchanged":true}),
            )?;
            return Err(format!("{message}; immutable input hashes unchanged"));
        }
    };
    if result.to_string().contains("PROBE_SECRET_SENTINEL") {
        return Err("Unknown field leaked".into());
    }
    result["mode"] = json!(mode);
    result["verification"] = json!({"passed":true,"immutableInputsUnchanged":true,
        "workingDbChanged":inventory(&working)? != working_before});
    write_json(&run.join("result.json"), &result)?;
    Ok(
        json!({"resultPath":run.join("result.json"),"metrics":result["metrics"],"verification":result["verification"]}),
    )
}
fn main() {
    // Suppress raw panic details (database records must never reach stderr).
    std::panic::set_hook(Box::new(|_| {}));
    let args: Vec<_> = std::env::args_os().collect();
    let result = if args.len() == 2 {
        run(Path::new(&args[1]), "normal")
    } else if args.len() == 4
        && args[1] == "--case"
        && [
            "native-table",
            "corrupt-table",
            "corrupt-current",
            "invalid-json",
            "invalid-state",
            "escape-path",
            "unknown-fields",
        ]
        .iter()
        .any(|s| args[2] == *s)
    {
        run(Path::new(&args[3]), &args[2].to_string_lossy())
    } else {
        Err(
            "Usage: vortex-state-probe [--case <fixture-case>] <prior synthetic input directory>"
                .into(),
        )
    };
    match result {
        Ok(value) => println!("{value}"),
        Err(message) => {
            eprintln!("{}", json!({"status":"failed","error":message}));
            std::process::exit(1);
        }
    }
}
