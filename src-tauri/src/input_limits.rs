//! Bounded reads for JSON-shaped input accepted from mods, imports, and the
//! portable data folder.

use std::fs::File;
use std::io::Read;
use std::path::Path;

/// Large enough for real-world SMAPI dictionaries while preventing an
/// attacker-controlled file from driving an unbounded allocation.
pub(crate) const MAX_JSON_BYTES: u64 = 64 * 1024 * 1024;

/// Keep every JSON file produced by the app readable by [`read_json_text`].
/// Call this immediately after serialization and before any backup or write.
pub(crate) fn ensure_json_output_size(byte_len: u64, label: &str) -> Result<(), String> {
    if byte_len > MAX_JSON_BYTES {
        return Err(format!(
            "{label} exceeds the 64 MiB JSON limit ({byte_len} bytes); nothing was written."
        ));
    }
    Ok(())
}

pub(crate) fn read_json_text(path: &Path) -> Result<String, String> {
    let file =
        File::open(path).map_err(|error| format!("Could not read {}: {error}", path.display()))?;
    let length = file
        .metadata()
        .map_err(|error| format!("Could not inspect {}: {error}", path.display()))?
        .len();
    if length > MAX_JSON_BYTES {
        return Err(format!(
            "{} exceeds the 64 MiB JSON input limit.",
            path.display()
        ));
    }

    // Read at most one byte past the boundary as a second check in case the
    // file grows between metadata inspection and the read.
    let mut body = String::with_capacity(length as usize);
    file.take(MAX_JSON_BYTES + 1)
        .read_to_string(&mut body)
        .map_err(|error| format!("Could not read {} as UTF-8: {error}", path.display()))?;
    if body.len() as u64 > MAX_JSON_BYTES {
        return Err(format!(
            "{} exceeds the 64 MiB JSON input limit.",
            path.display()
        ));
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_oversized_file_before_reading_it() {
        let dir = crate::test_support::temp_dir("oversized-json");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("oversized.json");
        let file = File::create(&path).unwrap();
        file.set_len(MAX_JSON_BYTES + 1).unwrap();

        let error = read_json_text(&path).unwrap_err();
        assert!(error.contains("64 MiB"));

        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn accepts_utf8_json_within_the_limit() {
        let dir = crate::test_support::temp_dir("bounded-json");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("small.json");
        std::fs::write(&path, "{\"greeting\":\"Olá\"}").unwrap();

        assert_eq!(read_json_text(&path).unwrap(), "{\"greeting\":\"Olá\"}");

        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn output_size_guard_accepts_the_boundary_and_rejects_one_byte_more() {
        ensure_json_output_size(MAX_JSON_BYTES, "Test JSON").unwrap();
        let error = ensure_json_output_size(MAX_JSON_BYTES + 1, "Test JSON").unwrap_err();
        assert!(error.contains("Test JSON"));
        assert!(error.contains("64 MiB"));
        assert!(error.contains("nothing was written"));
    }
}
