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
    let mut bytes = Vec::with_capacity(length as usize);
    file.take(MAX_JSON_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
    if bytes.len() as u64 > MAX_JSON_BYTES {
        return Err(format!(
            "{} exceeds the 64 MiB JSON input limit.",
            path.display()
        ));
    }
    decode_text(bytes).map_err(|error| format!("Could not read {} as {error}", path.display()))
}

/// SMAPI reads JSON through .NET, which honours a UTF-16 byte order mark, so
/// translation files saved as UTF-16 by Windows editors work in the game.
/// Everything else must be UTF-8 (an optional UTF-8 BOM is stripped later by
/// the lenient parser).
fn decode_text(bytes: Vec<u8>) -> Result<String, String> {
    let utf16 = |little_endian: bool| {
        let body = &bytes[2..];
        if !body.len().is_multiple_of(2) {
            return Err("UTF-16: the file ends in the middle of a character".to_string());
        }
        let units: Vec<u16> = body
            .chunks_exact(2)
            .map(|pair| {
                if little_endian {
                    u16::from_le_bytes([pair[0], pair[1]])
                } else {
                    u16::from_be_bytes([pair[0], pair[1]])
                }
            })
            .collect();
        String::from_utf16(&units).map_err(|error| format!("UTF-16: {error}"))
    };
    match bytes.as_slice() {
        [0xFF, 0xFE, ..] => utf16(true),
        [0xFE, 0xFF, ..] => utf16(false),
        _ => String::from_utf8(bytes).map_err(|error| format!("UTF-8: {error}")),
    }
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
    fn reads_utf16_files_with_a_byte_order_mark() {
        let dir = crate::test_support::temp_dir("utf16-json");
        std::fs::create_dir_all(&dir).unwrap();
        let text = "{\"greeting\":\"Olá\"}";
        let little: Vec<u8> = [0xFF, 0xFE]
            .into_iter()
            .chain(text.encode_utf16().flat_map(u16::to_le_bytes))
            .collect();
        let big: Vec<u8> = [0xFE, 0xFF]
            .into_iter()
            .chain(text.encode_utf16().flat_map(u16::to_be_bytes))
            .collect();
        std::fs::write(dir.join("le.json"), little).unwrap();
        std::fs::write(dir.join("be.json"), big).unwrap();

        assert_eq!(read_json_text(&dir.join("le.json")).unwrap(), text);
        assert_eq!(read_json_text(&dir.join("be.json")).unwrap(), text);

        std::fs::write(dir.join("latin1.json"), b"{\"a\":\"\xe9\"}").unwrap();
        assert!(read_json_text(&dir.join("latin1.json"))
            .unwrap_err()
            .contains("as UTF-8"));
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
