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
    // Clap handles explicit flags and canonical env values. Only absent canonical values
    // fall back to legacy names; an empty canonical value remains an error.
    if cli.tenant.is_none() {
        cli.tenant = std::env::var("MSN_TENANT").ok();
    }
    if cli.token.is_none() {
        cli.token = std::env::var("MSN_TOKEN").ok();
    }
    let stop = if matches!(cli.command, Command::Follow { .. } | Command::Wait { .. }) {
        install_stop_signals().unwrap_or_else(|error| {
            write_err(&error);
            std::process::exit(error.exit_code());
        })
    } else {
        Arc::new(AtomicBool::new(false))
    };
    if let Err(error) = execute(cli, stop) {
        write_err(&error);
        std::process::exit(error.exit_code());
    }
}
