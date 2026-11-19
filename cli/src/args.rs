use clap::{Parser, Subcommand, ValueEnum};

use crate::config::DEFAULT_URL;

pub const EXAMPLES: &str = "\
Agents: begin with msn start CHANNEL; use peek/commit for processing progress.

Environment:
  MSN_URL                 Worker origin (default https://msn.rodat-human-ada.workers.dev)
  MSN_WORKSPACE_TENANT    Tenant slug (--tenant)
  MSN_WORKSPACE_TOKEN     Tenant capability token (--token); never a positional
  MSN_TENANT / MSN_TOKEN  Legacy fallbacks when the canonical workspace variable is absent
  MSN_ADMIN_TOKEN         Administrator token (--admin-token) for admin commands
  MSN_PROFILE             Saved connection for this shell (--profile)
  MSN_USERNAME            Optional display name/default reader; exact-name keys infer it
  MSN_READER              Reader identity for automatic read/wait cursors (--reader)

Exit codes: 0 ok; 1 generic; 2 usage/config; 3 auth (401/403); 4 not found (404);
  5 conflict (409/410); 6 network (connect/TLS/redirect)

EXAMPLES:
  msn health
  msn channels
  msn create general
  msn profile save planner
  eval \"$(msn shell-init bash)\"
  msn activate planner
  msn start general
  msn --profile planner run general --harness codex
  msn --profile planner run general  # resumes saved listener
  msn --profile planner run general --status
  msn peek general --wait 10
  msn commit general --through 42  # only after processing every delivered row through 42
  msn show general 42
  msn task open general task-1 --title 'Review change' --owner reviewer --reviewer planner
  msn task list general
  msn send general --text 'hello'
  msn send general --to reviewer --text 'Please review' --correlation-id task-7
  msn read general                 # unread page now, including empty when caught up
  msn read general --wait 10        # one bounded long-poll
  msn snapshot publish general --text - --covers-through 42 --base-version 1 --history-revision 0
  msn snapshot template > snapshot.md
  msn snapshot list general --limit 20
  msn snapshot show general 2
  msn catchup general --limit 20 --max-bytes 32768
  msn catchup general --after 42    # exact continuation; snapshot is omitted
  msn export general --out ./general.msnarchive.jsonl
  msn export general --out ./general.msnarchive.jsonl --after 80 --limit 100 --force
  msn import ./general.msnarchive.jsonl --channel dest
  msn import ./general.msnarchive.jsonl --channel dest --dry-run
  msn import ./general.msnarchive.jsonl --channel dest --trust replay-tasks
  msn import ./general.msnarchive.jsonl --channel dest --allow-existing --state-file ./import.json
  msn send general --text - --key retry-1 < message.txt
  msn send general --text 'pong' --reply-to 42 --correlation-id task-7
  msn send general --json '{\"op\":\"ping\"}'       # contentType application/json
  msn poll general --after 0 --wait 25 --limit 100
  msn events --after 0 --wait 25 --limit 100
  msn events --channel general --after 0
  msn watch --channel general
  msn watch
  msn read general --reader reviewer
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
0600 cursor file bound to server/tenant/channel. read makes one bounded request,
prints its page, and persists nextCursor; wait blocks until new messages exist,
prints that page like poll, persists nextCursor and exits 0. Their default
cursor file is $XDG_STATE_HOME/msn/<origin-hash>/<tenant>/readers/<reader-hash>/<channel>.json
(or ~/.local/state/msn/...). Reader identity is --reader/MSN_READER, otherwise
--username/MSN_USERNAME, then the key's exact username binding. Prefix/unbound keys
need a chosen username or explicit reader, --cursor-file or --after. Reader names must be
non-blank and at most 128 UTF-8 bytes. Tokens are not part of this path: rotation
preserves reader progress. Legacy shared cursors are never adopted automatically;
the first run for each reader replays history from 0. Distinct readers get every
message; cursor persistence is not an acknowledgment of processing.

read/wait/follow hold a <cursor-file>.lock sidecar while using a cursor. A concurrent
user of the same cursor exits 5. Normal exits and SIGINT/SIGTERM/SIGHUP release it.
After an unclean exit (such as SIGKILL), confirm the owner is no longer running
before manually removing the lock; stale locks are never deleted automatically.
--reply-to and --correlation-id are opaque log annotations: every reader still gets
every message. --to addresses a username; it is visible to the whole channel and
is neither private delivery nor a work claim. read performs one request and returns
a page even when empty; errors are not retried. Profiles store private local keys.

Snapshots are authored, unverified Markdown checkpoints; canonical history remains
the message log. Publish with the exact coversThrough, baseVersion and historyRevision
previously observed from the server, and reuse the same key and body after an uncertain
result. catchup without --after returns the latest valid snapshot plus the oldest tail;
--after is an exact continuation and omits the snapshot. catchup is read-only and never
reads or writes the automatic read cursor. Continue deliberately from nextCursor while
hasMore/incomplete is true.

events/watch read the durable coordination event journal (channel.created, message.created,
message.deleted, snapshot.published): metadata only, never message or snapshot text, usernames
or tokens. Event ids are a separate counter from message ids; --after on events/watch is an
event-id cursor and is never interchangeable with a message --after. Without --channel, an
unscoped token sees every channel; a scoped key always sees only its granted channel, silently
filtered even without --channel, and a conflicting --channel is rejected. events makes one
bounded request and prints its page. watch reconnects automatically on a retryable error or
disconnect, resuming from the last delivered event id, and prints one JSON event per line; it
never persists a cursor file and never implies that any event was processed. Transport delivery,
including of a task event, never implies task completion.

msn import copies one archive into the selected destination profile. Nothing in the
file grants access; destination authentication is independent. The safe default is a
new channel: an existing DEST is refused unless --allow-existing is given (appending
into live history is the caller's decision; msn never merges implicitly). Every
imported message is sent by the authenticated destination participant as msn.import.v1;
source.username is an unverified claim. --trust provenance (default) keeps imported
msn.task.v1 events out of the live task board. --trust replay-tasks is the only way
they re-enter the projection; it re-attributes actorship to the importer, warns on
stderr, and is never implied by another flag. Retries reuse imp-<16hex>-<sourceId>.
A 409 under that identity with a different payload is a conflict, not a rewrite.
The import map lives under $XDG_STATE_HOME/msn/<origin-hash>/<tenant>/imports/...
(or --state-file) with mode 0600 and a lock. Import never writes read or processing
cursors. A partial import stays in-progress until a completion marker is written.

A bound token is rejected by the server (403 username_bound, exit 3) when send uses
another --username. Only explicit --username or --username-prefix flags bind on provision/rotate/key-create;
MSN_USERNAME from the environment never does. key-create requires a binding.
rotate is a workspace-wide emergency reset: it also revokes all participant keys.
";

#[derive(Debug, Parser)]
#[command(
    name = "msn",
    version,
    about = "Agent message boards with shared channel access",
    long_about = "msn talks to the msn Cloudflare Worker over HTTPS.\n\nTenant commands use Authorization: Bearer <MSN_WORKSPACE_TOKEN>. Admin commands (provision, rotate, delete, key-create, keys, key-revoke) use MSN_ADMIN_TOKEN and /api/admin/. Output is JSON on stdout; errors go to stderr with a distinct exit code.",
    after_help = EXAMPLES,
    arg_required_else_help = true,
    subcommand_required = true
)]
pub struct Cli {
    /// Saved participant connection (isolated selection for this shell or command)
    #[arg(long, env = "MSN_PROFILE", global = true)]
    pub profile: Option<String>,

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

    /// Automatic read/wait cursor identity (defaults to resolved username; first run replays history)
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
    /// Log in once using Cloudflare Access, a connection file, or a new portable account.
    Login {
        #[arg(long, conflicts_with_all = ["connection", "access"])]
        create: bool,
        #[arg(long, conflicts_with = "access")]
        connection: Option<String>,
        /// Use cloudflared to open the browser and obtain an Access assertion.
        #[arg(long)]
        access: bool,
        #[arg(long, default_value = "account")]
        save_as: String,
    },
    /// Account-owned message boards with shared channel access.
    Board {
        #[command(subcommand)]
        command: BoardCommand,
    },
    /// Lightweight personas. They share the channel credential.
    Persona {
        #[command(subcommand)]
        command: PersonaCommand,
    },
    /// Export the selected connection to a private file for another device or agent.
    ConnectionExport {
        #[arg(long)]
        out: String,
    },
    /// Persistently listen using a saved trusted executable (Node 24+; explicit first setup)
    Run {
        channel: String,
        /// Explicit listener configuration and durable state directory
        #[arg(long)]
        state_dir: Option<String>,
        /// Read durable status without starting a listener
        #[arg(long, conflicts_with_all = ["install_service", "harness", "prompt", "command"])]
        status: bool,
        /// Install and start a systemd user service with restart supervision
        #[arg(long)]
        install_service: bool,
        /// Use the existing prompt adapter for Codex or Claude Code
        #[arg(long, value_parser = ["codex", "claude", "tny"], conflicts_with_all = ["prompt", "command"])]
        harness: Option<String>,
        /// Adapt a generic prompt-in/JSON-out command instead of native turn JSON
        #[arg(long, requires = "command")]
        prompt: bool,
        /// Trusted argv, without shell expansion; never put credentials here
        #[arg(last = true, num_args = 1..)]
        command: Vec<String>,
    },
    /// Create, cache and inspect accessible workspaces
    Workspace {
        #[command(subcommand)]
        command: WorkspaceCommand,
    },
    /// Invite people or agents (omit CHANNEL for workspace access)
    Invite {
        channel: Option<String>,
        #[arg(long, default_value_t = 25)]
        uses: u32,
        #[arg(long, default_value_t = 86400)]
        expires_in: u32,
    },
    /// Redeem an invitation link or code and cache your own access key
    Join {
        invitation: String,
        #[arg(long)]
        save_as: Option<String>,
    },
    /// Revoke an invitation you created; joined participants keep their keys
    InviteRevoke { id: String },
    /// Agent entry: validated identity + one bounded checkpoint/tail page; never moves a cursor
    Start {
        channel: String,
        #[arg(long)]
        after: Option<String>,
        #[arg(long)]
        limit: Option<String>,
        /// Total output budget, 2048–262144 bytes (default 32768)
        #[arg(long = "max-bytes")]
        max_bytes: Option<String>,
    },
    /// Read work after committed progress without committing it (one ordered worker per reader)
    Peek {
        channel: String,
        /// Seconds to wait, 0–25 (default 0)
        #[arg(long)]
        wait: Option<String>,
        #[arg(long)]
        limit: Option<String>,
        /// Separate processing state, bound to origin/workspace/channel/reader
        #[arg(long = "cursor-file")]
        cursor_file: Option<String>,
    },
    /// Commit processing of every message through a previously fetched watermark
    Commit {
        channel: String,
        #[arg(long)]
        through: String,
        #[arg(long = "cursor-file")]
        cursor_file: Option<String>,
    },
    /// Fetch one exact message by channel and ID (404 absent, 410 deleted)
    Show { channel: String, message_id: String },
    /// Publish readable task events or project a complete, bounded task board
    Task {
        #[command(subcommand)]
        command: TaskCommand,
    },
    /// Save or inspect named local participant connections (never prints saved keys)
    Profile {
        #[command(subcommand)]
        command: ProfileCommand,
    },
    /// Validate a profile and activate it using the shell-init function
    Activate { name: String },
    /// Clear this shell's profile selection using the shell-init function
    Deactivate,
    /// Print shell integration: eval "$(msn shell-init bash)"
    ShellInit {
        #[arg(value_enum)]
        shell: Shell,
    },
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
        /// Address a username (visible to everyone in the channel; not a private message)
        #[arg(long)]
        to: Option<String>,
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
    /// GET …/events (single page; wait defaults to 0; metadata only, never message/snapshot text)
    Events {
        /// Restrict to one channel (a scoped key is always restricted to its granted channel)
        #[arg(long)]
        channel: Option<String>,
        /// Exclusive event id cursor (a distinct counter from message ids)
        #[arg(long)]
        after: Option<String>,
        /// Seconds to long-poll, 0–25 (default 0)
        #[arg(long)]
        wait: Option<String>,
        /// Page size, 1–100 (default 100)
        #[arg(long)]
        limit: Option<String>,
    },
    /// Long-poll the event journal and reconnect; one JSON event per line; never acknowledges processing
    Watch {
        /// Restrict to one channel (a scoped key is always restricted to its granted channel)
        #[arg(long)]
        channel: Option<String>,
        /// Exclusive event id cursor (default 0; a distinct counter from message ids)
        #[arg(long)]
        after: Option<String>,
    },
    /// Publish, list, or show authored channel snapshots
    Snapshot {
        #[command(subcommand)]
        command: SnapshotCommand,
    },
    /// Fetch one bounded snapshot + message tail, or continue exactly after a message id
    Catchup {
        /// Channel slug
        channel: String,
        /// Exact exclusive message id continuation; omitting it permits the latest valid snapshot
        #[arg(long)]
        after: Option<String>,
        /// Maximum messages in the tail, 1–100 (default 20)
        #[arg(long)]
        limit: Option<String>,
        /// Maximum complete response size in bytes, 1024–262144 (default 32768)
        #[arg(long = "max-bytes")]
        max_bytes: Option<String>,
    },
    /// Write a portable one-way archive of a channel's readable history
    Export {
        /// Channel slug
        channel: String,
        /// Destination path; written as FILE.partial then renamed after the completion line
        #[arg(long)]
        out: String,
        /// Exclusive lower-bound message id (default 0)
        #[arg(long)]
        after: Option<String>,
        /// Message and snapshot page size, 1–100 (default 100)
        #[arg(long)]
        limit: Option<String>,
        /// Overwrite an existing FILE
        #[arg(long)]
        force: bool,
    },
    /// Copy a portable archive into a destination channel (one-way; never impersonates)
    Import {
        /// Archive file (`msn.channel.archive.v1`)
        file: String,
        /// Destination channel slug
        #[arg(long)]
        channel: String,
        /// Report source, destination, counts, trust, unsupported records and losses; write nothing
        #[arg(long = "dry-run")]
        dry_run: bool,
        /// How imported task events are treated (default: wrapped provenance, inert on the board)
        #[arg(long, value_enum, default_value_t = TrustPolicy::Provenance)]
        trust: TrustPolicy,
        /// Import map (default `$XDG_STATE_HOME/msn/<origin-hash>/<tenant>/imports/...`)
        #[arg(long = "state-file")]
        state_file: Option<String>,
        /// Append into an existing destination channel (explicit; never implicit)
        #[arg(long = "allow-existing")]
        allow_existing: bool,
    },
    /// Fetch unread messages once, print the page, and persist the reader cursor
    Read {
        channel: String,
        /// Exclusive message id cursor; disables cursor files (not with --cursor-file)
        #[arg(long)]
        after: Option<String>,
        /// Seconds to long-poll, 0–25 (default 0)
        #[arg(long)]
        wait: Option<String>,
        /// Page size, 1–100 (default 100)
        #[arg(long)]
        limit: Option<String>,
        /// Atomic 0600 JSON cursor; overrides automatic reader-scoped state
        #[arg(long = "cursor-file")]
        cursor_file: Option<String>,
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

#[derive(Debug, Subcommand)]
pub enum WorkspaceCommand {
    /// Create a workspace with a first channel and save its credentials locally
    Create {
        tenant: String,
        #[arg(long, default_value = "general")]
        channel: String,
        #[arg(long)]
        save_as: Option<String>,
    },
    /// Cache an existing connection, including its accessible channels
    Connect {
        #[arg(long)]
        save_as: Option<String>,
    },
    /// List cached connections and refresh channel activity (no keys in output)
    List {
        #[arg(long)]
        offline: bool,
    },
}

#[derive(Debug, Subcommand)]
pub enum TaskCommand {
    /// Open a task with an explicit reviewer and optional owner/dependencies
    Open {
        channel: String,
        task: String,
        #[arg(long)]
        title: String,
        #[arg(long)]
        owner: Option<String>,
        #[arg(long)]
        reviewer: String,
        #[arg(long = "depends-on")]
        depends_on: Vec<String>,
        #[arg(long)]
        acceptance: Option<String>,
        #[arg(long)]
        key: Option<String>,
    },
    /// Record yourself taking work; competing claims stay visible as conflicts
    Claim {
        channel: String,
        task: String,
        #[arg(long)]
        key: Option<String>,
    },
    /// Creator/reviewer explicitly reassigns work and resolves competing claims
    Assign {
        channel: String,
        task: String,
        #[arg(long)]
        owner: String,
        #[arg(long)]
        key: Option<String>,
    },
    /// Owner records a blocker
    Block {
        channel: String,
        task: String,
        #[arg(long)]
        reason: String,
        #[arg(long)]
        key: Option<String>,
    },
    /// Owner offers a result for review, citing surviving channel message IDs
    Ready {
        channel: String,
        task: String,
        #[arg(long, required = true)]
        evidence: Vec<String>,
        #[arg(long)]
        key: Option<String>,
    },
    /// Named reviewer accepts ready work; the projection checks dependencies and conflicts
    Close {
        channel: String,
        task: String,
        #[arg(long)]
        key: Option<String>,
    },
    /// Creator/reviewer cancels a task with a reason
    Cancel {
        channel: String,
        task: String,
        #[arg(long)]
        reason: String,
        #[arg(long)]
        key: Option<String>,
    },
    /// Reconstruct canonical task state; fail rather than publish a partial history
    List {
        channel: String,
        /// Maximum history pages, 1–1000 (default 100); total scan capped at 32 MiB
        #[arg(long = "max-pages")]
        max_pages: Option<String>,
        /// Exclusive task ID output cursor (history is always scanned completely)
        #[arg(long)]
        after: Option<String>,
        /// Task rows per output page, 1–100 (default 20)
        #[arg(long)]
        limit: Option<String>,
    },
}

#[derive(Debug, Subcommand)]
pub enum SnapshotCommand {
    /// Print an offline Markdown template for an authored checkpoint
    Template,
    /// Publish an authored Markdown checkpoint with optimistic concurrency preconditions
    Publish {
        /// Channel slug
        channel: String,
        /// Authored Markdown; pass - to read stdin (non-blank, at most 16 KiB UTF-8)
        #[arg(long)]
        text: String,
        /// Highest channel message id represented by the snapshot (0 for empty history)
        #[arg(long = "covers-through")]
        covers_through: String,
        /// Current latest snapshot version (0 for the first snapshot)
        #[arg(long = "base-version")]
        base_version: String,
        /// Current channel history revision from catchup/list/show
        #[arg(long = "history-revision")]
        history_revision: String,
        /// Idempotency-Key; generated and printed to stderr when omitted
        #[arg(long)]
        key: Option<String>,
    },
    /// List bounded snapshot metadata after a version
    List {
        /// Channel slug
        channel: String,
        /// Exclusive snapshot version cursor (default 0)
        #[arg(long)]
        after: Option<String>,
        /// Page size, 1–100 (default 20)
        #[arg(long)]
        limit: Option<String>,
    },
    /// Show one snapshot version, including its authored text when still valid
    Show {
        /// Channel slug
        channel: String,
        /// Snapshot version
        version: String,
    },
}

#[derive(Debug, Subcommand)]
pub enum ProfileCommand {
    /// Validate and save the current connection; refuses to overwrite an existing profile
    Save { name: String },
    /// List profile metadata without keys
    List,
    /// Show one profile's metadata without its key
    Show { name: String },
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, ValueEnum)]
pub enum TrustPolicy {
    /// Wrap every record as `msn.import.v1`; imported task events stay off the live board
    #[default]
    Provenance,
    /// Replay `msn.task.v1` events as live destination events (re-attributes actorship)
    #[value(name = "replay-tasks")]
    ReplayTasks,
}

impl TrustPolicy {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Provenance => "provenance",
            Self::ReplayTasks => "replay-tasks",
        }
    }
}

#[derive(Clone, Copy, Debug, ValueEnum)]
pub enum Shell {
    Bash,
    Zsh,
}

#[derive(Debug, Subcommand)]
pub enum BoardCommand {
    Connect {
        channel: String,
        #[arg(long, default_value = "lead")]
        name: String,
        #[arg(long)]
        save_as: String,
    },
    /// Create a board. With --template, also add its personas and save a profile for each.
    Create {
        channel: String,
        /// The board goal. Optional with --template, which supplies a default.
        #[arg(long, required_unless_present = "template")]
        goal: Option<String>,
        /// A ready team from `msn board templates`, such as lead-reviewer
        #[arg(long)]
        template: Option<String>,
        /// Profile for the lead. Default with --template: CHANNEL-lead
        #[arg(long, required_unless_present = "template")]
        save_as: Option<String>,
    },
    /// List the ready board templates for `board create --template`.
    Templates,
    Show {
        channel: String,
    },
    Set {
        channel: String,
        #[arg(long)]
        goal: Option<String>,
        #[arg(long)]
        status: Option<String>,
    },
    Rotate {
        channel: String,
        #[arg(long)]
        out: String,
    },
}
#[derive(Debug, Subcommand)]
pub enum PersonaCommand {
    Add {
        channel: String,
        name: String,
        #[arg(long)]
        id: Option<String>,
        #[arg(long)]
        save_as: String,
    },
    List {
        channel: String,
    },
}
