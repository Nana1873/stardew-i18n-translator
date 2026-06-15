// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

const WEBVIEW2_DOWNLOAD_URL: &str =
    "https://developer.microsoft.com/en-us/microsoft-edge/webview2/";

fn missing_webview2_message() -> String {
    format!(
        "Stardew i18n Translator needs Microsoft Edge WebView2 Runtime to start.\n\n\
         WebView2 is included with Windows 11 and most Windows 10 installations, \
         but it is missing on this computer.\n\n\
         Select Yes to open the official Microsoft download page:\n\
         {WEBVIEW2_DOWNLOAD_URL}\n\n\
         Select No to close the app. Nothing will be downloaded or installed automatically."
    )
}

fn startup_gate(
    runtime_available: impl FnOnce() -> bool,
    show_missing_guidance: impl FnOnce(),
) -> bool {
    if runtime_available() {
        true
    } else {
        show_missing_guidance();
        false
    }
}

#[cfg(windows)]
fn webview2_runtime_available() -> bool {
    use webview2_com_sys::Microsoft::Web::WebView2::Win32::GetAvailableCoreWebView2BrowserVersionString;
    use windows_core::{PCWSTR, PWSTR};
    use windows_sys::Win32::System::Com::CoTaskMemFree;

    let mut version = PWSTR::null();
    let found =
        unsafe { GetAvailableCoreWebView2BrowserVersionString(PCWSTR::null(), &mut version) }
            .is_ok()
            && !version.0.is_null();
    if !version.0.is_null() {
        unsafe { CoTaskMemFree(version.0.cast()) };
    }
    found
}

#[cfg(windows)]
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
fn show_missing_webview2_guidance() {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, IDYES, MB_DEFBUTTON1, MB_ICONERROR, MB_SETFOREGROUND, MB_YESNO, SW_SHOWNORMAL,
    };

    let title = wide("Microsoft Edge WebView2 is required");
    let message = wide(&missing_webview2_message());
    let choice = unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            message.as_ptr(),
            title.as_ptr(),
            MB_YESNO | MB_ICONERROR | MB_DEFBUTTON1 | MB_SETFOREGROUND,
        )
    };
    if choice == IDYES {
        let operation = wide("open");
        let url = wide(WEBVIEW2_DOWNLOAD_URL);
        unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                operation.as_ptr(),
                url.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            );
        }
    }
}

fn main() {
    #[cfg(windows)]
    if !startup_gate(webview2_runtime_available, show_missing_webview2_guidance) {
        return;
    }

    stardew_i18n_translator_lib::run();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn available_runtime_starts_without_showing_guidance() {
        let guidance_shown = Cell::new(false);
        let start = startup_gate(
            || true,
            || {
                guidance_shown.set(true);
            },
        );
        assert!(start);
        assert!(!guidance_shown.get());
    }

    #[test]
    fn missing_runtime_shows_guidance_and_stops_startup() {
        let guidance_count = Cell::new(0);
        let start = startup_gate(
            || false,
            || {
                guidance_count.set(guidance_count.get() + 1);
            },
        );
        assert!(!start);
        assert_eq!(guidance_count.get(), 1);
    }

    #[cfg(windows)]
    #[test]
    fn native_strings_are_null_terminated_utf16() {
        let encoded = wide("WebView2");
        assert_eq!(encoded.last(), Some(&0));
        assert_eq!(
            &encoded[..encoded.len() - 1],
            "WebView2".encode_utf16().collect::<Vec<_>>()
        );
    }

    #[test]
    fn guidance_names_the_official_page_and_avoids_automatic_installation() {
        let message = missing_webview2_message();

        assert!(message.contains(WEBVIEW2_DOWNLOAD_URL));
        assert!(message.contains("Nothing will be downloaded or installed automatically."));
    }
}
