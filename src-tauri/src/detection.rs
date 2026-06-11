//! Stardew Valley install auto-detection (SPEC §4).
//!
//! Pure helpers (`is_stardew_install`, `mods_path_for`, `parse_steam_library_paths`)
//! are unit-tested. `detect()` touches the registry/filesystem and is verified
//! manually against a real install.

use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DetectedInstall {
    pub stardew_path: String,
    pub mods_path: String,
    /// "steam" | "gog" | "common"
    pub source: String,
}

/// A folder looks like a Stardew Valley install if it has the game assembly
/// (`Stardew Valley.dll`) or a `Content/` directory.
pub fn is_stardew_install(path: &Path) -> bool {
    path.join("Stardew Valley.dll").is_file()
        || path.join("StardewValley.dll").is_file()
        || path.join("Content").is_dir()
}

/// The default Mods folder for an install: `<Stardew Valley>/Mods`.
pub fn mods_path_for(stardew_path: &Path) -> PathBuf {
    stardew_path.join("Mods")
}

/// Extract library paths from a Steam `libraryfolders.vdf` body.
///
/// Lines look like: `\t\t"path"\t\t"C:\\Program Files (x86)\\Steam"`.
/// Backslashes are doubled in the file and are un-escaped here.
pub fn parse_steam_library_paths(vdf: &str) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    for line in vdf.lines() {
        let trimmed = line.trim_start();
        if let Some(rest) = trimmed.strip_prefix("\"path\"") {
            if let Some(value) = first_quoted(rest) {
                paths.push(PathBuf::from(value.replace("\\\\", "\\")));
            }
        }
    }
    paths
}

/// Return the contents of the first `"…"` quoted span in `s`.
fn first_quoted(s: &str) -> Option<String> {
    let start = s.find('"')? + 1;
    let rest = &s[start..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

/// Best-effort auto-detection of a Stardew Valley install.
pub fn detect() -> Option<DetectedInstall> {
    detect_steam().or_else(detect_common)
}

fn make_install(stardew_path: &Path, source: &str) -> DetectedInstall {
    DetectedInstall {
        stardew_path: stardew_path.display().to_string(),
        mods_path: mods_path_for(stardew_path).display().to_string(),
        source: source.to_string(),
    }
}

fn detect_steam() -> Option<DetectedInstall> {
    let steam = steam_install_dir()?;

    // The Steam install dir is itself library "0"; libraryfolders.vdf lists the rest.
    let mut libraries = vec![steam.clone()];
    let vdf_path = steam.join("steamapps").join("libraryfolders.vdf");
    if let Ok(body) = std::fs::read_to_string(&vdf_path) {
        libraries.extend(parse_steam_library_paths(&body));
    }

    libraries.into_iter().find_map(|lib| {
        let candidate = lib.join("steamapps").join("common").join("Stardew Valley");
        is_stardew_install(&candidate).then(|| make_install(&candidate, "steam"))
    })
}

fn steam_install_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    if let Some(path) = steam_dir_from_registry() {
        return Some(path);
    }

    let default = PathBuf::from(r"C:\Program Files (x86)\Steam");
    default.is_dir().then_some(default)
}

#[cfg(windows)]
fn steam_dir_from_registry() -> Option<PathBuf> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let key = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(r"Software\Valve\Steam")
        .ok()?;
    let path: String = key.get_value("SteamPath").ok()?;
    let path = PathBuf::from(path);
    path.is_dir().then_some(path)
}

fn detect_common() -> Option<DetectedInstall> {
    const CANDIDATES: &[(&str, &str)] = &[
        (
            r"C:\Program Files (x86)\GOG Galaxy\Games\Stardew Valley",
            "gog",
        ),
        (r"C:\Program Files\GOG Galaxy\Games\Stardew Valley", "gog"),
        (
            r"C:\Program Files (x86)\Steam\steamapps\common\Stardew Valley",
            "steam",
        ),
    ];

    CANDIDATES.iter().find_map(|(path, source)| {
        let path = PathBuf::from(path);
        is_stardew_install(&path).then(|| make_install(&path, source))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_real_world_vdf() {
        let vdf = "\"libraryfolders\"\n{\n\t\"0\"\n\t{\n\t\t\"path\"\t\t\"C:\\\\Program Files (x86)\\\\Steam\"\n\t}\n\t\"1\"\n\t{\n\t\t\"path\"\t\t\"E:\\\\SteamLibrary\"\n\t}\n}\n";
        let paths = parse_steam_library_paths(vdf);
        assert_eq!(
            paths,
            vec![
                PathBuf::from(r"C:\Program Files (x86)\Steam"),
                PathBuf::from(r"E:\SteamLibrary"),
            ]
        );
    }

    #[test]
    fn ignores_non_path_lines() {
        let vdf = "\t\t\"label\"\t\t\"\"\n\t\t\"contentid\"\t\t\"123\"\n";
        assert!(parse_steam_library_paths(vdf).is_empty());
    }

    #[test]
    fn detects_install_by_content_dir() {
        let dir = crate::test_support::temp_dir("detect-content");
        std::fs::create_dir_all(dir.join("Content")).unwrap();
        assert!(is_stardew_install(&dir));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_empty_dir() {
        let dir = crate::test_support::temp_dir("detect-empty");
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!is_stardew_install(&dir));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn mods_path_appends_mods() {
        assert_eq!(
            mods_path_for(Path::new(r"C:\Games\Stardew Valley")),
            PathBuf::from(r"C:\Games\Stardew Valley\Mods")
        );
    }

    /// Real-world smoke check: prints what `detect()` finds on this machine.
    /// Passes either way; if something is found, its path must actually exist.
    #[test]
    fn reports_detection_on_this_machine() {
        match detect() {
            Some(install) => {
                eprintln!("detect() => {install:?}");
                assert!(Path::new(&install.stardew_path).exists());
            }
            None => eprintln!("detect() => none (no install found on this machine)"),
        }
    }
}
