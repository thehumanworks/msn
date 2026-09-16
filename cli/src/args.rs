use clap::{Parser, Subcommand};

use crate::config::DEFAULT_URL;

pub const EXAMPLES: &str = "\
Environment:
  MSN_URL                 Worker origin (default https://msn.rodat-human-ada.workers.dev)
  MSN_WORKSPACE_TENANT    Tenant slug (--tenant)
  MSN_WORKSPACE_TOKEN     Tenant capability token (--token); never a positional
  MSN_TENANT / MSN_TOKEN  Legacy fallbacks when the canonical workspace variable is absent
  MSN_ADMIN_TOKEN         Administrator token (--admin-token) for admin commands
  MSN_USERNAME            Display name and default reader (--username); env never binds a token
  MSN_READER              Reader identity for automatic wait cursors (--reader)

Exit codes: 0 ok; 1 generic; 2 usage/config; 3 auth (401/403); 4 not found (404);
  5 conflict (409/410); 6 network (connect/TLS/redirect)

EXAMPLES:
  msn health
  msn channels
  msn create general
  MSN_USERNAME=agent msn send general --text 'hello'
  msn send general --text - --key retry-1 < message.txt
  msn send general --text 'pong' --reply-to 42 --correlation-id task-7
  msn send general --json '{\"op\":\"ping\"}'       # contentType application/json
  msn poll general --after 0 --wait 25 --limit 100
  msn wait general --reader reviewer
  msn whoami
  msn key-create reviewer --username reviewer
  msn key-create agents --username-prefix agent-
  msn keys
  msn key-revoke reviewer
  msn follow general --cursor-file ./cursor.json
  msn follow general --cursor-file ./cursor.json --once
  fnox run -- msn channels
  msn provision new-tenant
  msn provision thehuman --username thehuman       # token may only send as thehuman
  msn provision agents --username-prefix agent-    # token may only send as agent-*
  msn rotate new-tenant                            # keeps the current bind
  msn rotate new-tenant --unbind                   # clears it
  msn delete general 42

HTTPS is required except localhost. MSN_URL must be a bare origin (no path, query,
credentials or fragment). Redirects are errors. send prints Idempotency-Key on
stderr; reuse --key after an uncertain result. --json validates UTF-8 JSON locally
and exits 2 before any request when it is invalid; --text stays text/plain. Every
message carries contentType. follow prints one JSON message per line and writes a
0600 cursor file bound to server/tenant/channel. wait blocks until new messages
exist, prints that page like poll, persists nextCursor and exits 0; its default
cursor file is $XDG_STATE_HOME/msn/<origin-hash>/<tenant>/readers/<reader-hash>/<channel>.json
(or ~/.local/state/msn/...). Reader identity is --reader/MSN_READER, otherwise
--username/MSN_USERNAME; set one or pass --cursor-file/--after. Reader names must be
non-blank and at most 128 UTF-8 bytes. Tokens are not part of this path: rotation
preserves reader progress. Legacy shared cursors are never adopted automatically;
the first run for each reader replays history from 0. Distinct readers get every
message; cursor persistence is not an acknowledgment of processing.

wait/follow hold a <cursor-file>.lock sidecar while using a cursor. A concurrent
user of the same cursor exits 5. Normal exits and SIGINT/SIGTERM/SIGHUP release it.
After an unclean exit (such as SIGKILL), confirm the owner is no longer running
before manually removing the lock; stale locks are never deleted automatically.
--reply-to and --correlation-id are opaque log annotations: every reader still gets
every message.

A bound token is rejected by the server (403 username_bound, exit 3) when send uses
another --username. Only explicit --username or --username-prefix flags bind on provision/rotate/key-create;
MSN_USERNAME from the environment never does. key-create requires a binding.
rotate is a workspace-wide emergency reset: it also revokes all participant keys.
";

#[derive(Debug, Parser)]
#[command(
    name = "msn",
    version,
    about = "Channel messaging CLI for agents and humans",
    long_about = "msn talks to the msn Cloudflare Worker over HTTPS.\n\nTenant commands use Authorization: Bearer <MSN_WORKSPACE_TOKEN>. Admin commands (provision, rotate, delete, key-create, keys, key-revoke) use MSN_ADMIN_TOKEN and /api/admin/. Output is JSON on stdout; errors go to stderr with a distinct exit code.",
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

    /// Administrator token (admin commands only; never printed)
    #[arg(
        long = "admin-token",
        env = "MSN_ADMIN_TOKEN",
        global = true,
        hide_env_values = true
    )]
    pub admin_token: Option<String>,

    /// Display name/default reader; on provision/rotate/key-create only the flag binds a token
    #[arg(long, env = "MSN_USERNAME", global = true)]
    pub username: Option<String>,

    /// Automatic wait cursor identity (defaults to --username/MSN_USERNAME; first run replays history)
    #[arg(long, env = "MSN_READER", global = true)]
    pub reader: Option<String>,

    /// True when --username came from the command line rather than MSN_USERNAME (set by main).
    #[arg(skip)]
    pub username_from_flag: bool,

    #[command(subcommand)]
    pub command: Command,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// GET /api/health (no token)
    Health,
    /// GET /api/tenants/{tenant}; show this token's tenant and username binding
    Whoami,
    /// Admin PUT …/keys/{key}; requires explicit --username or --username-prefix
    KeyCreate {
        /// Participant key slug (1–64 [a-z0-9_-], starting with a letter or digit)
        key: String,
        /// Bind the key to names starting with this prefix (not with --username)
        #[arg(long = "username-prefix")]
        username_prefix: Option<String>,
    },
    /// Admin GET …/keys; list participant key metadata (no tokens)
    Keys,
    /// Admin DELETE …/keys/{key}; revoke one participant key
    KeyRevoke { key: String },
    /// GET /api/tenants/{tenant}/channels
    Channels,
    /// PUT /api/tenants/{tenant}/channels/{channel}
    Create {
        /// Channel slug (1–64 [a-z0-9_-])
        channel: String,
    },
    /// POST /api/tenants/{tenant}/channels/{channel}/messages
    #[command(group(clap::ArgGroup::new("payload").required(true).args(["text", "json"])))]
    Send {
        /// Channel slug
        channel: String,
        /// Message text (contentType text/plain); pass - to read stdin
        #[arg(long)]
        text: Option<String>,
        /// JSON payload (contentType application/json), validated locally; pass - to read stdin
        #[arg(long)]
        json: Option<String>,
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
        /// Atomic 0600 JSON cursor; overrides automatic reader-scoped state (exclusive while running)
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
    /// Admin PUT /api/admin/tenants/{tenant}; --username or --username-prefix binds the token
    Provision {
        tenant: String,
        /// Bind the token to display names starting with this prefix (not with --username)
        #[arg(long = "username-prefix")]
        username_prefix: Option<String>,
    },
    /// Workspace-wide emergency reset: rotate token and revoke all participant keys; keeps binding
    Rotate {
        tenant: String,
        /// Rebind the new token to display names starting with this prefix
        #[arg(long = "username-prefix")]
        username_prefix: Option<String>,
        /// Clear the bound name so the new token may send as any display name
        #[arg(long)]
        unbind: bool,
    },
    /// Admin DELETE …/channels/{channel}/messages/{id}
    Delete { channel: String, message_id: String },
}
