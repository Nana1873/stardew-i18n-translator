//! Bounded, stdout-only RAR/7z reading through Windows' system bsdtar.

#[cfg(windows)]
use std::{
    collections::HashSet,
    ffi::OsString,
    path::Path,
    time::{Duration, Instant},
};

const ARCHIVE_LIMIT: usize = 64 * 1024 * 1024;
#[cfg(windows)]
const JSON_LIMIT: usize = 16 * 1024 * 1024;
#[cfg(windows)]
const TOTAL_LIMIT: usize = 32 * 1024 * 1024;

pub(crate) fn read_archive(bytes: &[u8]) -> Result<Vec<(String, Vec<u8>)>, String> {
    if bytes.len() > ARCHIVE_LIMIT {
        return Err("Archive exceeds the 64 MiB download limit.".into());
    }
    if !bytes.starts_with(b"Rar!\x1a\x07") && !bytes.starts_with(b"7z\xbc\xaf\x27\x1c") {
        return Err("Unsupported or invalid RAR/7z archive.".into());
    }
    #[cfg(windows)]
    {
        let temporary = TemporaryArchive::create(bytes)?;
        read_path(&temporary.0.join("archive"))
    }
    #[cfg(not(windows))]
    Err("RAR/7z import requires the Windows system archive reader.".into())
}

#[cfg(windows)]
struct TemporaryArchive(std::path::PathBuf);

#[cfg(windows)]
impl TemporaryArchive {
    fn create(bytes: &[u8]) -> Result<Self, String> {
        use std::{
            io::Write,
            sync::atomic::{AtomicU64, Ordering},
            time::{SystemTime, UNIX_EPOCH},
        };
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "Could not create archive temporary file.")?
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "stardew-archive-{}-{stamp}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).map_err(|_| "Could not create archive temporary folder.")?;
        let temporary = Self(path);
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(temporary.0.join("archive"))
            .map_err(|_| "Could not create archive temporary file.")?;
        file.write_all(bytes)
            .map_err(|_| "Could not write archive temporary file.")?;
        Ok(temporary)
    }
}

#[cfg(windows)]
impl Drop for TemporaryArchive {
    fn drop(&mut self) {
        // Only our fixed file and freshly created directory; never recursive.
        let _ = std::fs::remove_file(self.0.join("archive"));
        let _ = std::fs::remove_dir(&self.0);
    }
}

#[cfg(windows)]
fn system_tar() -> Result<std::path::PathBuf, String> {
    use std::os::windows::ffi::OsStringExt;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetSystemDirectoryW(buffer: *mut u16, size: u32) -> u32;
    }
    let mut buffer = vec![0u16; 32_768];
    // SAFETY: the output buffer is valid for its stated number of UTF-16 units.
    let length = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) } as usize;
    if length == 0 || length >= buffer.len() {
        return Err("Could not locate the Windows system archive reader.".into());
    }
    Ok(std::path::PathBuf::from(OsString::from_wide(&buffer[..length])).join("tar.exe"))
}

#[cfg(windows)]
fn checked_path(name: &str) -> Result<String, String> {
    // bsdtar escapes controls/backslashes in its text listing. Reject those
    // spellings instead of guessing how they correspond to archive bytes.
    if name.is_empty()
        || name.len() > 4096
        || name.starts_with('/')
        || name.contains(['\\', ':'])
        || name.chars().any(char::is_control)
        || name.split('/').any(|part| {
            part == "." || part == ".." || part.is_empty() || part.ends_with(['.', ' '])
        })
    {
        return Err("Unsafe or ambiguous archive entry path.".into());
    }
    Ok(name.to_owned())
}

#[cfg(windows)]
fn parse_listing(names: &[u8], details: &[u8]) -> Result<Vec<(String, u64)>, String> {
    let names = std::str::from_utf8(names).map_err(|_| "Archive paths must be UTF-8.")?;
    let details = std::str::from_utf8(details).map_err(|_| "Archive paths must be UTF-8.")?;
    let names: Vec<_> = names.lines().collect();
    let details: Vec<_> = details.lines().collect();
    if names.len() > 5000 || names.len() != details.len() {
        return Err("Archive contains too many or ambiguous entries.".into());
    }
    let mut seen = HashSet::new();
    let mut wanted = Vec::new();
    let mut total = 0u64;
    for (name, detail) in names.into_iter().zip(details) {
        let path = checked_path(name.trim_end_matches('/'))?;
        if !seen.insert(path.to_lowercase()) {
            return Err("Archive contains ambiguous duplicate paths.".into());
        }
        // -tv --numeric-owner has eight metadata columns. Matching its exact
        // suffix with the independent -t listing avoids splitting spaced names.
        let prefix = detail
            .strip_suffix(name)
            .ok_or("Ambiguous archive entry listing.")?;
        let fields: Vec<_> = prefix.split_whitespace().collect();
        if fields.len() != 8 || !prefix.ends_with(' ') || fields[0].len() != 10 {
            return Err("Unsupported Windows archive listing format.".into());
        }
        let kind = fields[0].as_bytes()[0];
        if kind != b'-' && kind != b'd' {
            return Err("Archive links and special files are unsupported.".into());
        }
        let size: u64 = fields[4]
            .parse()
            .map_err(|_| "Invalid archive entry size.")?;
        if kind == b'd' {
            continue;
        }
        if name != path {
            return Err("Ambiguous regular archive entry path.".into());
        }
        let lower = path.to_lowercase();
        let i18n = (lower.split('/').rev().nth(1) == Some("i18n")
            || lower.split('/').rev().nth(2) == Some("i18n"))
            && !lower.starts_with("assets/i18n/")
            && !lower.contains("/assets/i18n/");
        if !lower.ends_with(".json") || (!i18n && lower.rsplit('/').next() != Some("manifest.json"))
        {
            continue;
        }
        total = total.saturating_add(size);
        if size > JSON_LIMIT as u64 || total > TOTAL_LIMIT as u64 {
            return Err("Archive JSON exceeds decompression limits.".into());
        }
        wanted.push((path, size));
    }
    Ok(wanted)
}

#[cfg(windows)]
fn glob_literal(path: &str) -> String {
    let mut pattern = String::new();
    for ch in path.chars() {
        if matches!(ch, '[' | ']' | '*' | '?' | '\\') {
            pattern.push('\\');
        }
        pattern.push(ch);
    }
    pattern
}

#[cfg(windows)]
fn read_path(path: &Path) -> Result<Vec<(String, Vec<u8>)>, String> {
    let executable = system_tar()?;
    let deadline = Instant::now() + Duration::from_secs(60);
    let run = |args: &[OsString], limit| {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or("Archive reader timed out.")?;
        crate::codex_cli::windows_process::run_archive(
            &executable,
            args,
            path.parent().ok_or("Invalid archive path.")?,
            remaining.min(Duration::from_secs(15)),
            limit,
        )
    };
    let names = run(&["-tf".into(), path.as_os_str().into()], 2 * 1024 * 1024)?;
    let details = run(
        &[
            "-tvf".into(),
            path.as_os_str().into(),
            "--numeric-owner".into(),
        ],
        3 * 1024 * 1024,
    )?;
    let entries = parse_listing(&names, &details)?;
    let mut output = Vec::new();
    for (name, size) in entries {
        let body = run(
            &[
                "-xOf".into(),
                path.as_os_str().into(),
                "--".into(),
                glob_literal(&name).into(),
            ],
            size as usize,
        )?;
        if body.len() as u64 != size {
            return Err("Archive entry size did not match its listing.".into());
        }
        output.push((name, body));
    }
    Ok(output)
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    fn listing(name: &str, kind: char, size: usize) -> (Vec<u8>, Vec<u8>) {
        (
            format!("{name}\n").into_bytes(),
            format!("{kind}rw-r--r--  0 0 0 {size} Jan 1 2026 {name}\n").into_bytes(),
        )
    }

    #[test]
    fn listing_preserves_spaces_and_globs_but_rejects_unsafe_paths() {
        let (names, details) = listing("[CP] Example/i18n/de.json", '-', 2);
        assert_eq!(
            parse_listing(&names, &details).unwrap()[0].0,
            "[CP] Example/i18n/de.json"
        );
        assert_eq!(glob_literal("[CP] a*b?.json"), "\\[CP\\] a\\*b\\?.json");
        for name in [
            "../i18n/de.json",
            "/i18n/de.json",
            "C:/i18n/de.json",
            "x\\ni18n/de.json",
            "a//de.json",
            "./de.json",
        ] {
            let (names, details) = listing(name, '-', 2);
            assert!(parse_listing(&names, &details).is_err(), "{name}");
        }
    }

    #[test]
    fn listing_rejects_links_duplicates_and_size_bombs() {
        for kind in ['l', 'h', 'b', 'p'] {
            let (names, details) = listing("i18n/de.json", kind, 2);
            assert!(parse_listing(&names, &details).is_err());
        }
        let (mut names, mut details) = listing("i18n/de.json", '-', 2);
        let (more_names, more_details) = listing("I18N/DE.JSON", '-', 2);
        names.extend(more_names);
        details.extend(more_details);
        assert!(parse_listing(&names, &details).is_err());
        let (names, details) = listing("i18n/de.json", '-', JSON_LIMIT + 1);
        assert!(parse_listing(&names, &details).is_err());
    }

    fn tar_fixture(entries: &[(&str, u8, &[u8])]) -> Vec<u8> {
        let mut bytes = Vec::new();
        for (name, kind, body) in entries {
            let mut header = [0u8; 512];
            header[..name.len()].copy_from_slice(name.as_bytes());
            header[100..108].copy_from_slice(b"0000644\0");
            header[108..116].copy_from_slice(b"0000000\0");
            header[116..124].copy_from_slice(b"0000000\0");
            header[124..136].copy_from_slice(format!("{:011o}\0", body.len()).as_bytes());
            header[136..148].copy_from_slice(b"00000000000\0");
            header[148..156].fill(b' ');
            header[156] = *kind;
            if *kind == b'1' || *kind == b'2' {
                header[157..163].copy_from_slice(b"target");
            }
            header[257..263].copy_from_slice(b"ustar\0");
            header[263..265].copy_from_slice(b"00");
            let checksum: u64 = header.iter().map(|byte| *byte as u64).sum();
            header[148..156].copy_from_slice(format!("{checksum:06o}\0 ").as_bytes());
            bytes.extend(header);
            bytes.extend_from_slice(body);
            bytes.resize(bytes.len().next_multiple_of(512), 0);
        }
        bytes.resize(bytes.len() + 1024, 0);
        bytes
    }

    #[test]
    fn system_tar_reads_only_bounded_json_and_cleans_temporary_archive() {
        let bytes = tar_fixture(&[
            ("[CP] Example/manifest.json", b'0', b"{}"),
            ("[CP] Example/i18n/de/Dialogue.json", b'0', b"{\"a\":\"b\"}"),
            ("[CP] Example/assets/i18n/de.json", b'0', b"ignored"),
            ("picture.png", b'0', b"ignored"),
        ]);
        let temporary = TemporaryArchive::create(&bytes).unwrap();
        let path = temporary.0.join("archive");
        let found = read_path(&path).unwrap();
        assert_eq!(found.len(), 2);
        assert_eq!(found[1].1, b"{\"a\":\"b\"}");
        let executable = system_tar().unwrap();
        let args = [OsString::from("-tf"), path.as_os_str().into()];
        let run = |timeout, cap| {
            crate::codex_cli::windows_process::run_archive(
                &executable,
                &args,
                &temporary.0,
                timeout,
                cap,
            )
        };
        assert!(run(Duration::from_secs(5), 1)
            .unwrap_err()
            .contains("size limit"));
        let start = Instant::now();
        assert!(run(Duration::ZERO, 1024).unwrap_err().contains("timed out"));
        assert!(start.elapsed() < Duration::from_secs(6));
        drop(temporary);
        assert!(!path.exists());
        assert!(!path.parent().unwrap().exists());
    }

    #[test]
    fn system_tar_rejects_unsafe_links_duplicates_and_escaped_names() {
        for entries in [
            vec![("i18n/de.json", b'2', b"".as_slice())],
            vec![("i18n/de.json", b'1', b"".as_slice())],
            vec![("../i18n/de.json", b'0', b"{}".as_slice())],
            vec![("i18n/line\nname.json", b'0', b"{}".as_slice())],
            vec![
                ("i18n/de.json", b'0', b"{}".as_slice()),
                ("I18N/DE.JSON", b'0', b"{}".as_slice()),
            ],
        ] {
            let temporary = TemporaryArchive::create(&tar_fixture(&entries)).unwrap();
            assert!(
                read_path(&temporary.0.join("archive")).is_err(),
                "{entries:?}"
            );
        }
    }

    #[test]
    #[ignore = "Read-only proof for an explicitly supplied local archive"]
    fn local_archive_read_only_probe() {
        let path = std::env::var_os("SDV_ARCHIVE_READ_PROBE")
            .expect("Set SDV_ARCHIVE_READ_PROBE to a local archive");
        let bytes = std::fs::read(path).unwrap();
        let entries = read_archive(&bytes).unwrap();
        assert!(!entries.is_empty());
        println!(
            "Read {} JSON entries, {} bytes",
            entries.len(),
            entries.iter().map(|(_, body)| body.len()).sum::<usize>()
        );
        for (_, body) in entries {
            assert!(std::str::from_utf8(&body).is_ok());
        }
    }
}
