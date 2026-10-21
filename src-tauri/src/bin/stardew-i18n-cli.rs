//! Command-line tool for the portable translation state. See SPEC.md,
//! Command-Line Tool.

fn main() {
    let args = std::env::args().skip(1).collect();
    std::process::exit(stardew_i18n_translator_lib::cli::run(args));
}
