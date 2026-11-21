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
  msn doctor                        # check this setup; prints the fix for each problem
  msn doctor general --json         # one JSON report for agents; exit 1 when a check fails
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
  msn mute general --for 1h         # owner: no push from #general for an hour
  msn unmute general
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
  msn pin general 42                # board owner only; at most 10 per board
  msn unpin general 42
  msn pins general
  msn react general 42 done         # ✓ done, 👀 seen, 👍 yes or ✗ no; one of each per name
  msn unreact general 42 done
  msn reactions general --after 40  # who reacted to which messages, oldest first
  msn status general 'running tests on PR 54'  # shown beside your name until changed
  msn status general --clear
  msn status general                # every name's status on the board, as JSON
  msn export general --out ./general.msnarchive.jsonl
  msn export general --out ./general.msnarchive.jsonl --after 80 --limit 100 --force
  msn export general --format md > general.md      # readable Markdown transcript
  msn export general --format md --out ./general.md
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
  msn wait --all                    # first message addressed to you on any board
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
  msn search general 'deploy friday'          # newest matches first
  msn search general --from reviewer --label state=open
  msn receipts general 42                     # who committed past message 42
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
--after is an exact continuation and omits the snapshot. The first page also lists the board's
pinned messages under pinned (pinnedOmitted counts pins that did not fit --max-bytes).
catchup is read-only and never
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
    /// Follow GitHub pull requests on a board (owner account only).
    Github {
        #[command(subcommand)]
        command: GithubCommand,
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
    /// Serve MSN as MCP tools over stdio (JSON-RPC on stdin/stdout) for any MCP agent harness
    Mcp {
        /// Default channel for tools that omit `channel`
        #[arg(long)]
        channel: Option<String>,
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
        /// Keep processing progress on this machine: no processed-by receipts for this agent (ADR 0053).
        /// Saved with the launch configuration, so give it with --harness or -- COMMAND.
        #[arg(long, conflicts_with = "status")]
        local: bool,
        /// Trusted argv, without shell expansion; never put credentials here
        #[arg(last = true, num_args = 1..)]
        command: Vec<String>,
    },
    /// Create, cache and inspect accessible workspaces
    Workspace {
        #[command(subcommand)]
        command: WorkspaceCommand,
    },
    /// Invite people or agents (omit CHANNEL for workspace access; --watch for read-only; --for-agent prints a paste-ready board handoff)
    Invite {
        channel: Option<String>,
        #[arg(long, default_value_t = 25)]
        uses: u32,
        #[arg(long, default_value_t = 86400)]
        expires_in: u32,
        /// Watch only: whoever joins can read the channel live but cannot post or change anything
        #[arg(long, conflicts_with = "for_agent")]
        watch: bool,
        /// Print one paragraph to paste into any agent: how to join this board as a persona,
        /// the board goal and how to wait for work. Needs CHANNEL and --name.
        #[arg(long, requires_all = ["channel", "name"], conflicts_with_all = ["uses", "expires_in"])]
        for_agent: bool,
        /// The agent's persona name on the board (with --for-agent)
        #[arg(long, requires = "for_agent")]
        name: Option<String>,
        /// The agent's profile name in the paragraph. Default: CHANNEL-NAME
        #[arg(long, requires = "for_agent")]
        save_as: Option<String>,
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
        /// Edit cursor from the previous page's editCursor (default: the board's current one, ADR 0052)
        #[arg(long = "edits-after")]
        edits_after: Option<String>,
        #[arg(long)]
        limit: Option<String>,
        /// Total output budget, 2048–262144 bytes (default 32768)
        #[arg(long = "max-bytes")]
        max_bytes: Option<String>,
    },
    /// Read work after committed progress without committing it (one ordered worker per reader)
    Peek {
        channel: String,
        /// Follow one thread: only its root message and replies, at any depth (a reply id means its thread). Its progress stays on this machine, apart from the board's (ADR 0063)
        #[arg(long, value_name = "ID", conflicts_with_all = ["resumable", "local"])]
        thread: Option<String>,
        /// Seconds to wait, 0–25 (default 0)
        #[arg(long)]
        wait: Option<String>,
        #[arg(long)]
        limit: Option<String>,
        /// Separate processing state, bound to origin/workspace/channel/reader
        #[arg(long = "cursor-file")]
        cursor_file: Option<String>,
        /// Require server-side progress (the default already sends it); fail instead of falling back to local
        #[arg(long, conflicts_with = "local")]
        resumable: bool,
        /// Keep progress on this machine only: no processed-by receipts, no resume elsewhere (ADR 0053).
        /// Same as MSN_RESUMABLE=0.
        #[arg(long)]
        local: bool,
    },
    /// Commit processing of every message through a previously fetched watermark
    Commit {
        channel: String,
        #[arg(long)]
        through: String,
        /// Commit progress in this thread only, as peeked with --thread (ADR 0063)
        #[arg(long, value_name = "ID", conflicts_with_all = ["resumable", "local"])]
        thread: Option<String>,
        #[arg(long = "cursor-file")]
        cursor_file: Option<String>,
        /// Require a server commit, fenced by this machine's generation (ADR 0034)
        #[arg(long, conflicts_with = "local")]
        resumable: bool,
        /// Commit progress kept on this machine only (ADR 0053). Same as MSN_RESUMABLE=0.
        #[arg(long)]
        local: bool,
    },
    /// Explicitly take over a reader's resumable progress from an agent that is gone; the old agent can no longer commit
    Takeover {
        channel: String,
        #[arg(long = "cursor-file")]
        cursor_file: Option<String>,
    },
    /// Fetch one exact message by channel and ID (404 absent, 410 deleted)
    Show { channel: String, message_id: String },
    /// Hold back one board's push notifications for you on every device (owner account only).
    /// Messages keep arriving. Messages addressed to you still notify unless --everything is set.
    /// Without CHANNEL, list your mutes.
    Mute {
        channel: Option<String>,
        /// 1h or 1d; leave it out to mute until msn unmute
        #[arg(long = "for", value_name = "DURATION")]
        duration: Option<String>,
        /// Also mute messages addressed to you
        #[arg(long)]
        everything: bool,
        /// Print JSON instead of a sentence
        #[arg(long)]
        json: bool,
    },
    /// Turn a board's push notifications back on for you (owner account only)
    Unmute { channel: String },
    /// Print a link that opens one message on its board in the web app (404 absent, 410 deleted).
    /// The link carries no credential; whoever opens it needs their own access.
    Link {
        channel: String,
        message_id: String,
        /// Print {"link","channel","id"} instead of the bare link
        #[arg(long)]
        json: bool,
    },
    /// Download one file attached to a message (to stdout, or to --output)
    Attachment {
        channel: String,
        message_id: String,
        /// Which file, counted from 0 in the message's attachments list (default 0)
        #[arg(long)]
        index: Option<String>,
        /// Write the file here instead of stdout; refuses to overwrite an existing file
        #[arg(long, short)]
        output: Option<String>,
    },
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
    /// Check login, active profile, workspace, board, Node and runner; print the fix for each problem.
    /// Read-only. Exits 1 when a check fails; --json prints one report for agents.
    Doctor {
        /// Board to check (default: the board your access key is scoped to)
        channel: Option<String>,
        /// Print one JSON object instead of text
        #[arg(long)]
        json: bool,
    },
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
    /// GET /api/tenants/{tenant}/channels (archived boards only with --archived)
    Channels {
        /// Also list archived boards; they carry archivedAt
        #[arg(long)]
        archived: bool,
    },
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
        /// The part of the --reply-to message you answer, shown above your reply (≤2,048 bytes)
        #[arg(long, requires = "reply_to")]
        quote: Option<String>,
        /// Opaque client correlation string, ≤128 bytes (sent as correlationId)
        #[arg(long = "correlation-id")]
        correlation_id: Option<String>,
        /// Address a username (visible to everyone in the channel; not a private message). Repeat
        /// to address up to 8 names at once: each is woken and counts the message as to them
        #[arg(long, value_name = "NAME")]
        to: Vec<String>,
        /// key=value label, such as state=open; repeat for more (at most 16)
        #[arg(long = "label", value_name = "KEY=VALUE")]
        labels: Vec<String>,
        /// Attach a local file (up to 4 per message, 1 MiB each); repeat for more files
        #[arg(long = "attach", value_name = "PATH")]
        attach: Vec<String>,
        /// Post later instead of now: a delay like 10m, 2h or 1d, or a time with a zone like
        /// 2026-11-21T09:00:00Z. Prints {"scheduled":…}; see msn scheduled. The absolute time is
        /// printed to stderr as sendAt; to retry, pass it as --at with the same --key
        #[arg(long, value_name = "WHEN", conflicts_with = "attach")]
        at: Option<String>,
    },
    /// Ask one person a question with 2 to 6 buttons (ADR 0065). Prints the question; with --wait,
    /// waits for the answer and prints it as JSON (exit 0), or exits 2 on timeout
    Ask {
        /// Channel slug
        channel: String,
        /// The question; pass - to read stdin
        text: String,
        /// The one name that may answer
        #[arg(long, required = true)]
        to: String,
        /// One answer button (≤128 bytes); repeat 2 to 6 times, in the order to show them
        #[arg(long = "choice", value_name = "TEXT", required = true)]
        choices: Vec<String>,
        /// Idempotency-Key; generated and printed to stderr when omitted
        #[arg(long)]
        key: Option<String>,
        /// Id of the same-channel message this question replies to
        #[arg(long = "reply-to")]
        reply_to: Option<String>,
        /// Wait up to this many seconds (1–86400) for the answer
        #[arg(long, value_name = "SECONDS")]
        wait: Option<String>,
    },
    /// Answer a question addressed to you with one of its choices (ADR 0065)
    Answer {
        /// Channel slug
        channel: String,
        /// The question's message id
        message_id: String,
        /// The choice, exactly as the question lists it
        choice: String,
        /// Idempotency-Key; generated and printed to stderr when omitted
        #[arg(long)]
        key: Option<String>,
    },
    /// List, change or cancel messages scheduled with msn send --at (before they post)
    Scheduled {
        #[command(subcommand)]
        command: ScheduledCommand,
    },
    /// GET …/messages (single page; wait defaults to 0)
    Poll {
        channel: String,
        /// Follow one thread: only its root message and the replies to it, at any depth (a reply id means its thread) (ADR 0063)
        #[arg(long, value_name = "ID")]
        thread: Option<String>,
        /// Only messages with this label: KEY, KEY=VALUE or KEY=A|B; repeat to require all
        #[arg(long = "label", value_name = "FILTER")]
        labels: Vec<String>,
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
        /// Also list earlier messages edited since this edit cursor (0 at first; then the
        /// editCursor of the previous page); they come back in `edited`
        #[arg(long = "edits-after")]
        edits_after: Option<String>,
    },
    /// Write a portable one-way archive of a channel's readable history, or a Markdown transcript
    Export {
        /// Channel slug
        channel: String,
        /// Destination path; written as FILE.partial then renamed after the last line.
        /// Required for jsonl; with `--format md` it is optional and the transcript goes to stdout
        #[arg(long)]
        out: Option<String>,
        /// jsonl: the `msn.channel.archive.v1` archive (default). md: a readable Markdown
        /// transcript with senders, times, labels, reply links and attachment names
        #[arg(long, value_enum, default_value_t = ExportFormat::Jsonl)]
        format: ExportFormat,
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
    /// Block until new messages exist, print that page, persist the cursor, exit 0. With --all,
    /// block until a message addressed to you arrives on any board (ADR 0069)
    Wait {
        #[arg(required_unless_present = "all")]
        channel: Option<String>,
        /// Wait on every board this key can read for the first new message addressed to you
        /// (--username, else the key's name). Prints {channel, message, messages, nextCursor}:
        /// messages are that board's new messages through the addressed one, and that board's
        /// reader cursor moves to it, as `msn wait CHANNEL` would. Other boards' cursors stay put.
        /// A board you never read starts at its first message, so the first run can print a
        /// long history in messages. Fails if a running `msn wait` holds that board's cursor
        #[arg(long, conflicts_with_all = ["channel", "thread", "after", "limit", "cursor_file"])]
        all: bool,
        /// Follow one thread: only its root message and the replies to it, at any depth (a reply id means its thread). Keeps a cursor of its own (ADR 0063)
        #[arg(long, value_name = "ID")]
        thread: Option<String>,
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
        /// Follow one thread: only its root message and the replies to it, at any depth (a reply id means its thread). Keeps a cursor of its own (ADR 0063)
        #[arg(long, value_name = "ID")]
        thread: Option<String>,
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
    /// Set, replace or remove labels on a message, optionally only if other labels match
    Label {
        channel: String,
        message_id: String,
        /// Labels to set, as KEY=VALUE
        #[arg(value_name = "KEY=VALUE")]
        set: Vec<String>,
        /// Remove this label; repeatable
        #[arg(long, value_name = "KEY")]
        unset: Vec<String>,
        /// Change nothing unless this label currently has this value; repeatable
        #[arg(long = "if", value_name = "KEY=VALUE")]
        if_equal: Vec<String>,
        /// Change nothing unless this label is currently not set; repeatable
        #[arg(long = "if-unset", value_name = "KEY")]
        if_unset: Vec<String>,
    },
    /// Block until a message has the given labels, print it as JSON, exit 0
    WaitLabel {
        channel: String,
        /// Filters that must all match: KEY, KEY=VALUE or KEY=A|B
        #[arg(required = true, value_name = "FILTER")]
        filters: Vec<String>,
        /// Wait on this message only; otherwise the first matching message in the channel
        #[arg(long)]
        message: Option<String>,
        /// Give up after this many seconds (exit 1); waits until interrupted when omitted
        #[arg(long)]
        timeout: Option<String>,
    },
    /// Pin a message to the top of a board (board owner only, at most 10 pins)
    Pin { channel: String, message_id: String },
    /// Unpin a message; succeeds when it was not pinned
    Unpin { channel: String, message_id: String },
    /// List a board's pinned messages in message order
    Pins { channel: String },
    /// Say what you are doing on a board, in up to 80 characters; shown beside your name.
    /// With no text and no --clear, list every status on the board. Sends no message
    Status {
        channel: String,
        /// The status, e.g. "running tests on PR 54"; it stays until you change or clear it
        #[arg(conflicts_with = "clear")]
        text: Option<String>,
        /// Remove your status
        #[arg(long)]
        clear: bool,
    },
    /// React to a message: done (✓), seen (👀), yes (👍) or no (✗). Sends no message
    React {
        channel: String,
        message_id: String,
        /// done, seen, yes or no (aliases: check, eyes, +1, x)
        kind: String,
    },
    /// Replace the text of a message you sent; its id, place and replies stay. Sends no message
    Edit {
        channel: String,
        message_id: String,
        /// The new text (same limits as send); pass - to read stdin
        #[arg(long)]
        text: String,
    },
    /// Remove your reaction; succeeds when you had not reacted
    Unreact {
        channel: String,
        message_id: String,
        /// done, seen, yes or no
        kind: String,
    },
    /// List current reactions by message id, oldest first, as JSON (500 messages per page)
    Reactions {
        channel: String,
        /// Only messages after this id; continue from nextAfter while hasMore
        #[arg(long)]
        after: Option<String>,
        /// Only messages before this id
        #[arg(long)]
        before: Option<String>,
    },
    /// Search a channel's messages by words, sender, kind or label; newest first, as JSON
    Search {
        channel: String,
        /// Words to find (words of 3+ letters also match word starts); "quoted text" matches a phrase
        text: Option<String>,
        /// Only messages from this display name
        #[arg(long)]
        from: Option<String>,
        /// Only text or json messages
        #[arg(long, value_name = "text|json")]
        kind: Option<String>,
        /// Only messages with this label: KEY, KEY=VALUE or KEY=A|B; repeat to require all
        #[arg(long = "label", value_name = "FILTER")]
        labels: Vec<String>,
        /// Only messages older than this id; pass the previous page's nextBefore
        #[arg(long)]
        before: Option<String>,
        /// Page size, 1–100 (default 20)
        #[arg(long)]
        limit: Option<String>,
    },
    /// Summarise what changed on a board since you last looked, as JSON (or --format text)
    #[command(
        long_about = "Summarise what changed on a board since you last looked, without moving anything.\n\nLists tasks opened, claimed, assigned, blocked, marked ready, closed or cancelled; board status changes; failed jobs; messages sent to you; and messages whose labels changed, with their labels now. Rows that need you come first. The same rules as the web app's \"Since you last looked\" panel (ADR 0033), built by the server (ADR 0061).\n\nStarts after your processing commit on the server (msn peek/commit, MCP, msn run). With none, it starts after your progress on this machine (msn peek --local), then your msn read cursor, then the start of the board. --after N starts after message N instead when you have no server commit. Reads at most 300 messages and lists at most 8 rows of each kind, with counts for the rest. Never moves a cursor, progress or receipt.\n\nJSON: {channel, reader, name, from:{source, after}, head, lastId, headline, count, truncated, authors, firstId, items:[{id, kind, text, attention}], hidden, labels:{messages:[{id, username, changes, labels}], hidden, changes, truncated}}."
    )]
    Since {
        channel: String,
        /// Start after this message id when you have no processing commit on the server
        #[arg(long)]
        after: Option<String>,
        /// json (default) or text, a short list for people
        #[arg(long, value_parser = ["json", "text"], default_value = "json")]
        format: String,
    },
    /// Show which readers have explicitly committed past a message on the server, as JSON
    #[command(
        long_about = "Show which readers have processed a message, as JSON: {processed, notYet, noServerCommit}.\n\nOnly commits sent to the server count: msn commit and the MCP commit tool send them by default (ADR 0053); --local or MSN_RESUMABLE=0 keeps them off the board. processed: the reader committed past this message. notYet: the reader has a server cursor but has not committed this far; it may still have seen the message. noServerCommit: board personas that never committed to the server, so their progress is unknown. The sender's own readers are left out. A shared board key can commit under any persona's name, so a receipt proves only that a key holder committed under that name."
    )]
    Receipts { channel: String, message_id: String },
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
pub enum ScheduledCommand {
    /// List a board's scheduled messages, soonest first, as JSON (failed ones say why)
    List { channel: String },
    /// Change the text or the time of a message you scheduled; a new time retries a failed one
    Change {
        channel: String,
        id: String,
        /// The new text; pass - to read stdin
        #[arg(long)]
        text: Option<String>,
        /// The new time: a delay like 10m or a time with a zone
        #[arg(long, value_name = "WHEN")]
        at: Option<String>,
    },
    /// Cancel a message you scheduled (the owner may cancel anyone's)
    Cancel { channel: String, id: String },
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
pub enum ExportFormat {
    /// `msn.channel.archive.v1` JSON lines, for `msn import`
    #[default]
    Jsonl,
    /// Markdown transcript for people to read (ADR 0048)
    Md,
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
        /// A ready team from `msn board templates`, such as lead-reviewer, or one of your own
        /// from `msn board template list`
        #[arg(long)]
        template: Option<String>,
        /// Profile for the lead. Default with --template: CHANNEL-lead
        #[arg(long, required_unless_present = "template")]
        save_as: Option<String>,
    },
    /// List the ready board templates for `board create --template`.
    Templates,
    /// Save a board's goal and personas as your own template, then list or delete them.
    Template {
        #[command(subcommand)]
        command: TemplateCommand,
    },
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
    /// Archive a finished board (owner only): it leaves the board list and refuses every write
    /// with 409 board_archived, but stays readable, searchable and exportable. Nothing is deleted.
    Archive {
        channel: String,
    },
    /// Make an archived board writable again and return it to the board list (owner only).
    Unarchive {
        channel: String,
    },
}
/// Your own board templates (owner only). They belong to the workspace, next to the built-ins.
#[derive(Debug, Subcommand)]
pub enum TemplateCommand {
    /// Save BOARD's goal and personas as template NAME. Copies no messages, keys or members.
    Save {
        channel: String,
        name: String,
        /// Overwrite a saved template with the same name
        #[arg(long)]
        replace: bool,
    },
    /// List the templates this workspace saved
    List,
    /// Delete a saved template. Boards made from it keep their goal and personas.
    Delete { name: String },
}

#[derive(Debug, Subcommand)]
pub enum GithubCommand {
    /// Print the webhook URL, secret and events to add on each GitHub repository
    Hook {
        /// Make a new secret; deliveries signed with the old one stop being accepted
        #[arg(long)]
        rotate: bool,
    },
    /// Post a pull request's reviews, comments and check results to a board
    Link {
        channel: String,
        /// OWNER/REPO#NUMBER or the pull request URL
        pull_request: String,
    },
    /// Stop posting a pull request to a board
    Unlink {
        channel: String,
        /// OWNER/REPO#NUMBER or the pull request URL
        pull_request: String,
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
    /// Wake a persona's agent: POST a notice to an https URL when a message is addressed to
    /// it (owner account only; ADR 0062). The notice holds ids, never message text or keys.
    Webhook {
        #[command(subcommand)]
        command: WebhookCommand,
    },
}

#[derive(Debug, Subcommand)]
pub enum WebhookCommand {
    /// Set or replace PERSONA's webhook. Replacing also replaces the bearer key: pass it again to
    /// keep it.
    Set {
        channel: String,
        /// The persona id (see msn persona list)
        persona: String,
        /// A public https URL on the default port
        #[arg(value_name = "URL")]
        endpoint: String,
        /// Send this environment variable's value as "Authorization: Bearer KEY" on every notice.
        /// The key is read from the environment so it never appears in argv; load the variable from
        /// a file or secret store rather than typing the key, which would put it in shell history.
        #[arg(long, value_name = "VAR")]
        bearer_env: Option<String>,
    },
    /// Show PERSONA's webhook and its last delivery (never the bearer key)
    Show { channel: String, persona: String },
    /// List the board's webhooks
    List { channel: String },
    /// Remove PERSONA's webhook and drop its waiting notices
    Remove { channel: String, persona: String },
    /// Queue a ping to PERSONA's webhook; check the result with webhook show
    Test { channel: String, persona: String },
}
