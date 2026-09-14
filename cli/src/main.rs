use clap::Parser;
use msn_cli::args::{Cli, Command};
use msn_cli::error::write_err;
use msn_cli::{execute, install_stop_signals};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

fn main() {
    let cli = Cli::parse();
    let stop = if matches!(cli.command, Command::Follow { .. }) {
        install_stop_signals()
    } else {
        Arc::new(AtomicBool::new(false))
    };
    if let Err(error) = execute(cli, stop) {
        write_err(&error);
        std::process::exit(error.exit_code());
    }
}
