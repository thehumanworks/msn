use std::process::ExitCode;

use msn_desktop::{app, smoke};

const USAGE: &str = "\
msn-desktop: native egui client for the msn channel messaging service

USAGE:
  msn-desktop          Launch the GUI (connect with origin/workspace/token or a saved
                       `msn profile`).
  msn-desktop --smoke  Headless integration check against a real server. Reads
                       MSN_URL, MSN_WORKSPACE_TENANT, MSN_WORKSPACE_TOKEN (never argv),
                       optional MSN_USERNAME and MSN_SMOKE_CHANNEL. Opens no window and is
                       not GUI execution. Exits non-zero unless every check passes.
  msn-desktop --help   Show this message.
";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.as_slice() {
        [] => run_gui(),
        [flag] if flag == "--smoke" => smoke::run(),
        [flag] if flag == "--help" || flag == "-h" => {
            print!("{USAGE}");
            ExitCode::SUCCESS
        }
        _ => {
            eprintln!("error: unrecognised arguments\n\n{USAGE}");
            ExitCode::FAILURE
        }
    }
}

fn run_gui() -> ExitCode {
    let options = eframe::NativeOptions {
        viewport: eframe::egui::ViewportBuilder::default()
            .with_title("msn desktop")
            .with_app_id("msn-desktop")
            .with_transparent(true)
            .with_inner_size([980.0, 640.0])
            .with_min_inner_size([560.0, 360.0]),
        ..Default::default()
    };
    let result = eframe::run_native(
        "msn desktop",
        options,
        Box::new(|cc| Ok(Box::new(app::MsnDesktopApp::new(cc)))),
    );
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("msn-desktop failed to start: {err}");
            ExitCode::FAILURE
        }
    }
}
