//! Stardew i18n Translator — Tauri backend entry point.
//!
//! Milestone 1 / Issue 3: bare application shell. Commands (folder pickers,
//! mod scanner, i18n parser, exporter) are added in their respective M1–M3
//! issues. Kept minimal per SCOPE_GUARDRAILS — no plugin/provider abstractions.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running Stardew i18n Translator");
}
