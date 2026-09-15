use clap::{Parser, Subcommand};

use crate::config::DEFAULT_URL;

pub const EXAMPLES: &str = "\
Environment:
  MSN_URL                 Worker origin (default https://msn.rodat-human-ada.workers.dev)
  MSN_WORKSPACE_TENANT    Tenant slug (--tenant)
  MSN_WORKSPACE_TOKEN     Tenant capability token (--token); never a positional
  MSN_ADMIN_TOKEN         Administrator token (--admin-token) for provision/rotate/delete
  MSN_USERNAME            Display name for send (--username)

Exit codes: 0 ok; 1 generic; 2 usage/config; 3 auth (401/403); 4 not found (404);
  5 conflict (409/410); 6 network (connect/TLS/redirect)

EXAMPLES:
  msn health
  msn channels
  msn create general
  MSN_USERNAME=agent msn send general --text 'hello'
  msn send general --text - --key retry-1 < message.txt
  msn send general --text 'pong' --reply-to 42 --correlation-id task-7
  msn poll general --after 0 --wait 25 --limit 100
  msn wait general
  msn follow general --cursor-file ./cursor.json
  msn follow general --cursor-file ./cursor.json --once
  fnox run -- msn channels
  msn provision new-tenant
  msn rotate new-tenant
  msn delete general 42

HTTPS is required except localhost. MSN_URL must be a bare origin (no path, query,
credentials or fragment). Redirects are errors. send prints Idempotency-Key on
stderr; reuse --key after an uncertain result. follow prints one JSON message per
line and writes a 0600 cursor file bound to server/tenant/channel. wait blocks until
new messages exist, prints that page like poll, persists nextCursor and exits 0; its
default cursor file is $XDG_STATE_HOME or ~/.local/state/msn/<origin-hash>/<tenant>/<channel>.json.
--reply-to and --correlation-id are opaque log annotations: every reader still gets
every message.
";

#[derive(Debug, Parser)]
#[command(
    name = "msn",
    version,
    about = "Channel messaging CLI for agents and humans",
    long_about = "msn talks to the msn Cloudflare Worker over HTTPS.\n\nTenant commands use Authorization: Bearer <MSN_WORKSPACE_TOKEN>. Admin commands (provision, rotate, delete) use MSN_ADMIN_TOKEN and /api/admin/. Output is JSON on stdout; errors go to stderr with a distinct exit code.",
    after_help = EXAMPLES,
    arg_required_else_help = true,
    subcommand_required = true
)]
pub struct Cli {
    /// Worker origin (no path, query, credentials or fragment)
    #[arg(long, env = "MSN_URL", global = true, default_value = DEFAULT_URL)]
    pub url: String,

    /// Workspace tenant slug
    #[arg(long, env = "MSN_WORKSPACE_TENANT", global = true)]
    pub tenant: Option<String>,

    /// Tenant capability token (never printed)
    #[arg(
        long,
        env = "MSN_WORKSPACE_TOKEN",
        global = true,
        hide_env_values = true
    )]
    pub token: Option<String>,

    /// Administrator token (provision/rotate/delete only; never printed)
    #[arg(
        long = "admin-token",
        env = "MSN_ADMIN_TOKEN",
        global = true,
        hide_env_values = true
    )]
    pub admin_token: Option<String>,

    /// Unverified display name for send
    #[arg(long, env = "MSN_USERNAME", global = true)]
    pub username: Option<String>,

    #[command(subcommand)]
    pub command: Command,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// GET /api/health (no token)
    Health,
    /// GET /api/tenants/{tenant}/channels
    Channels,
    /// PUT /api/tenants/{tenant}/channels/{channel}
    Create {
        /// Channel slug (1–64 [a-z0-9_-])
        channel: String,
    },
    /// POST /api/tenants/{tenant}/channels/{channel}/messages
    Send {
        /// Channel slug
        channel: String,
        /// Message text; pass - to read stdin
        #[arg(long)]
        text: String,
        /// Idempotency-Key; generated and printed to stderr when omitted
        #[arg(long)]
        key: Option<String>,
        /// Id of the same-channel message this one answers (sent as replyTo)
        #[arg(long = "reply-to")]
        reply_to: Option<String>,
        /// Opaque client correlation string, ≤128 bytes (sent as correlationId)
        #[arg(long = "correlation-id")]
        correlation_id: Option<String>,
    },
    /// GET …/messages (single page; wait defaults to 0)
    Poll {
        channel: String,
        /// Exclusive message id cursor
        #[arg(long)]
        after: Option<String>,
        /// Seconds to long-poll, 0–25 (default 0)
        #[arg(long)]
        wait: Option<String>,
        /// Page size, 1–100 (default 100)
        #[arg(long)]
        limit: Option<String>,
    },
    /// Block until new messages exist, print that page, persist the cursor, exit 0
    Wait {
        channel: String,
        /// Exclusive message id cursor; disables cursor files (not with --cursor-file)
        #[arg(long)]
        after: Option<String>,
        /// Seconds per long-poll, 1–25 (default 25)
        #[arg(long)]
        wait: Option<String>,
        /// Page size, 1–100 (default 100)
        #[arg(long)]
        limit: Option<String>,
        /// Atomic 0600 JSON cursor bound to server/tenant/channel (default under ~/.local/state/msn)
        #[arg(long = "cursor-file")]
        cursor_file: Option<String>,
    },
    /// Long-poll loop; one JSON message per line
    Follow {
        channel: String,
        /// Exclusive message id cursor (not with --cursor-file)
        #[arg(long)]
        after: Option<String>,
        /// Seconds to long-poll, 1–25 (default 25)
        #[arg(long)]
        wait: Option<String>,
        /// Page size, 1–100 (default 100)
        #[arg(long)]
        limit: Option<String>,
        /// Atomic 0600 JSON cursor bound to server/tenant/channel
        #[arg(long = "cursor-file")]
        cursor_file: Option<String>,
        /// Exit 0 after the first non-empty page
        #[arg(long)]
        once: bool,
    },
    /// Admin PUT /api/admin/tenants/{tenant}
    Provision { tenant: String },
    /// Admin POST /api/admin/tenants/{tenant}/token
    Rotate { tenant: String },
    /// Admin DELETE …/channels/{channel}/messages/{id}
    Delete { channel: String, message_id: String },
}
