//! One process owns a portable profile for its entire application lifetime.

use std::fs::{File, OpenOptions};
use std::path::Path;

pub(crate) struct ProfileOwner {
    _lock: File,
}

pub(crate) fn acquire(directory: &Path) -> Result<ProfileOwner, String> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(0);
    }
    // Retain the existing filename so older versions' ChatGPT ownership also
    // prevents a second writer. The lock now protects every profile operation.
    let lock = options
        .open(directory.join("chatgpt-session.lock"))
        .map_err(|error| {
            format!(
                "Could not own the portable data folder {}: {error}. Close another Translator using this folder and try again; also check that the folder is writable.",
                directory.display()
            )
        })?;
    #[cfg(not(windows))]
    lock.try_lock()
        .map_err(|error| format!("Another Translator owns this portable data folder: {error}"))?;
    Ok(ProfileOwner { _lock: lock })
}

pub(crate) fn show_startup_error(message: &str) {
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            MessageBoxW, MB_ICONERROR, MB_OK, MB_SETFOREGROUND,
        };
        let message = message
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let title = "Portable profile unavailable"
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        unsafe {
            MessageBoxW(
                std::ptr::null_mut(),
                message.as_ptr(),
                title.as_ptr(),
                MB_OK | MB_ICONERROR | MB_SETFOREGROUND,
            );
        }
    }
    #[cfg(not(windows))]
    eprintln!("{message}");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_a_second_owner_and_releases_ownership_on_drop() {
        let directory = crate::test_support::temp_dir("profile-owner");
        std::fs::create_dir_all(&directory).unwrap();
        let owner = acquire(&directory).unwrap();
        assert!(acquire(&directory).is_err());
        drop(owner);
        let next_owner = acquire(&directory).unwrap();
        drop(next_owner);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn different_portable_profiles_can_run_together() {
        let root = crate::test_support::temp_dir("independent-profiles");
        let first = root.join("first");
        let second = root.join("second");
        std::fs::create_dir_all(&first).unwrap();
        std::fs::create_dir_all(&second).unwrap();
        let first_owner = acquire(&first).unwrap();
        let second_owner = acquire(&second).unwrap();
        drop((first_owner, second_owner));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn profile_owner_child() {
        let Some(directory) = std::env::var_os("SIT_PROFILE_OWNER_TEST_DIRECTORY") else {
            return;
        };
        let directory = std::path::PathBuf::from(directory);
        let expected = std::env::var("SIT_PROFILE_OWNER_TEST_EXPECTED").unwrap() == "owned";
        let owner = acquire(&directory);
        assert_eq!(owner.is_ok(), expected);
        if let Ok(_owner) = owner {
            crate::translations::save_one(
                &directory,
                "Fixture.Profile",
                "child".into(),
                crate::translations::StoredString {
                    target: "Child translation".into(),
                    status: "translated".into(),
                    source_hash: "synthetic".into(),
                },
            )
            .unwrap();
        }
    }

    #[test]
    fn another_process_cannot_write_until_the_profile_is_released() {
        let directory = crate::test_support::temp_dir("profile-process-owner");
        std::fs::create_dir_all(&directory).unwrap();
        let owner = acquire(&directory).unwrap();
        let child = |expected| {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "portable_profile::tests::profile_owner_child",
                    "--nocapture",
                ])
                .env("SIT_PROFILE_OWNER_TEST_DIRECTORY", &directory)
                .env("SIT_PROFILE_OWNER_TEST_EXPECTED", expected)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        };
        child("blocked");
        assert!(crate::translations::load(&directory, "Fixture.Profile")
            .unwrap()
            .is_empty());
        drop(owner);
        child("owned");
        assert_eq!(
            crate::translations::load(&directory, "Fixture.Profile").unwrap()["child"].target,
            "Child translation"
        );
        std::fs::remove_dir_all(directory).unwrap();
    }
}
