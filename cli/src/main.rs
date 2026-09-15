use clap::parser::ValueSource;
use clap::{CommandFactory, FromArgMatches};
use msn_cli::args::{Cli, Command};
use msn_cli::error::write_err;
use msn_cli::{execute, install_stop_signals};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

fn main() {
    let matches = Cli::command().get_matches();
    let mut cli = Cli::from_arg_matches(&matches).unwrap_or_else(|error| error.exit());
    // MSN_USERNAME must never bind a token by accident: only an explicit flag counts for admin commands.
    cli.username_from_flag = matches.value_source("username") == Some(ValueSource::CommandLine);
    let stop = if matches!(cli.command, Command::Follow { .. } | Command::Wait { .. }) {
        install_stop_signals()
    } else {
        Arc::new(AtomicBool::new(false))
    };
    if let Err(error) = execute(cli, stop) {
        write_err(&error);
        std::process::exit(error.exit_code());
    }
}
