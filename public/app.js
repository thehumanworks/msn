import { acquire, invitation, savePassword } from "./access.js";
import { onViewportChange } from "./viewport.js";

const $ = (id) => document.getElementById(id);
const SESSION_KEY = "msn.session";
const CHANNEL_KEY = (tenant) => `msn.channel.${tenant}`;
let session = null;
let channel = "";
let generation = 0;
let polling = null;
// A bounded, memory-only delivery cache, not a durable read receipt or unread counter.
const MAX_MESSAGES = 1000;
const MAX_CACHED_CHANNELS = 5;
const MAX_TOTAL_MESSAGES = 2000;

// Browser storage is optional: private windows or blocked site data must not break the app.
const storage = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {}
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {}
  },
};

function savedSession() {
  try {
    const parsed = JSON.parse(storage.get(SESSION_KEY) ?? "null");
    if (parsed && typeof parsed.tenant === "string" && typeof parsed.token === "string") return parsed;
  } catch {}
  return null;
}

function forgetSession(tenant) {
  storage.remove(SESSION_KEY);
  if (tenant) storage.remove(CHANNEL_KEY(tenant));
}

function draft(connection = session, name = channel) {
  if (!connection.drafts.has(name))
    connection.drafts.set(name, { content: "", recipient: "", retry: null, sending: false });
  return connection.drafts.get(name);
}

function status(message, error = false) {
  $("status").textContent = message;
  $("status").classList.toggle("error", error);
}

function chatVisible() {
  return $("messages").getClientRects().length > 0;
}

function savePosition() {
  const state = session?.channels.get(channel);
  if (!state || !chatVisible()) return;
  const box = $("messages");
  state.scrollTop = box.scrollTop;
  state.atBottom = box.scrollHeight - box.clientHeight - box.scrollTop < 40;
  const top = box.getBoundingClientRect().top;
  const anchor = state.atBottom
    ? null
    : [...box.children].find((node) => node.getBoundingClientRect().bottom > top);
  state.anchor = anchor ? { id: anchor.dataset.id, offset: anchor.getBoundingClientRect().top - top } : null;
  if (state.atBottom) state.newMessages = false;
}

function restorePosition(state) {
  const box = $("messages");
  const anchor = state.anchor && [...box.children].find((node) => node.dataset.id === state.anchor.id);
  if (state.atBottom) box.scrollTop = box.scrollHeight;
  else if (anchor)
    box.scrollTop +=
      anchor.getBoundingClientRect().top - box.getBoundingClientRect().top - state.anchor.offset;
  // If the reading anchor itself was pruned, show the oldest remaining row, not newer content.
  else box.scrollTop = state.anchor ? 0 : state.scrollTop;
  state.scrollTop = box.scrollTop;
}

function view(name) {
  if (name === "channels") savePosition();
  $("workspace").dataset.view = name;
}

function trimCache() {
  const cache = session.channels;
  let total = [...cache.values()].reduce((sum, state) => sum + state.messages.length, 0);
  for (const [name, state] of cache) {
    if (cache.size <= MAX_CACHED_CHANNELS && total <= MAX_TOTAL_MESSAGES) break;
    if (name === channel) continue;
    total -= state.messages.length;
    cache.delete(name);
  }
}

function endSession(connection, message) {
  if (session !== connection) return;
  stopPolling();
  forgetSession(connection?.tenant);
  if (connection) {
    connection.token = "";
    for (const state of connection.drafts.values()) {
      state.content = "";
      state.recipient = "";
      state.retry = null;
    }
    connection.drafts.clear();
    for (const state of connection.channels.values()) {
      state.messages.length = 0;
      state.seen.clear();
      state.cursor = 0;
      state.anchor = null;
    }
    connection.channels.clear();
  }
  session = null;
  channel = "";
  $("live").checked = false;
  $("token").value = "";
  $("credential-token").value = "";
  $("credential-name").value = "";
  $("invite-link").value = "";
  $("invite-dialog").close();
  $("message").value = "";
  $("recipient").value = "";
  $("new-channel").value = "";
  autosize();
  $("messages").replaceChildren();
  showCheckpoint(null);
  $("channels").replaceChildren();
  for (const id of ["workspace-name", "display-name", "identity-note", "channel-note"])
    $(id).textContent = "";
  $("identity-note").title = "";
  $("channel-note").title = "";
  $("channel-title").textContent = "Choose a channel";
  $("cursor").textContent = "Cursor 0";
  $("more").hidden = true;
  $("jump").hidden = true;
  for (const id of ["poll", "catchup", "reread", "recipient", "message", "send", "invite-channel"])
    $(id).disabled = true;
  $("workspace").hidden = true;
  $("welcome").hidden = false;
  view("channels");
  status(message, true);
  $("token").focus();
}

async function api(path, options = {}, connection = session) {
  if (!connection || session !== connection) throw new DOMException("Connection ended", "AbortError");
  const response = await fetch(`/api/tenants/${connection.tenant}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${connection.token}`, ...options.headers },
  });
  // Check at the headers, even if the error body is absent, invalid JSON, or slow.
  // Connection identity (not channel/poll generation) protects a newer login from old requests.
  if (response.status === 401) {
    const message = "Session ended: invalid access key. Enter a valid access key to reconnect.";
    endSession(connection, message);
    throw Object.assign(new Error(message), { status: 401 });
  }
  const data = response.status === 204 ? {} : await response.json();
  if (!response.ok) {
    const error = new Error(data.error?.message ?? `Request failed (${response.status})`);
    error.status = response.status;
    error.code = data.error?.code;
    if (session === connection && error.code === "origin_forbidden") {
      stopPolling();
      $("live").checked = false;
      status(`${error.message} Live paused; use the same-origin browser client.`, true);
    }
    throw error;
  }
  return data;
}

function stopPolling() {
  generation++;
  polling?.abort();
  polling = null;
}

/** Pretty-print an application/json body as text; unparsable bodies fall back to the raw text. */
function pretty(text) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function formatTime(iso) {
  const date = new Date(iso);
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function appendMessage(message) {
  const article = document.createElement("article");
  article.className = message.username === session?.username ? "message mine" : "message";
  article.dataset.id = message.id;
  const meta = document.createElement("div");
  meta.className = "message-meta";
  const name = document.createElement("strong");
  name.textContent = message.username;
  const time = document.createElement("time");
  time.dateTime = message.createdAt;
  time.textContent = formatTime(message.createdAt);
  time.title = message.createdAt;
  const label = document.createElement("span");
  label.textContent = `#${message.id}`;
  label.title = `#${message.channel} · message ${message.id}`;
  meta.append(name, time);
  // Untrusted content only ever goes through textContent, whatever its contentType claims.
  let boardUpdate = null;
  if (message.contentType === "application/json") {
    try {
      const data = JSON.parse(message.text);
      if (
        data.schema === "msn.board.v1" &&
        typeof data.goal === "string" &&
        ["active", "paused", "complete", "blocked"].includes(data.status)
      )
        boardUpdate = data;
    } catch {}
  }
  const structured = message.contentType === "application/json" && !boardUpdate;
  if (structured) {
    const kind = document.createElement("span");
    kind.className = "message-kind";
    kind.textContent = "application/json";
    meta.append(kind);
  }
  // The id stays last so every row ends the same way, typed or not.
  meta.append(label);
  const content = document.createElement(structured ? "pre" : "p");
  content.textContent = boardUpdate
    ? `Goal ${boardUpdate.status}: ${boardUpdate.goal}`
    : structured
      ? pretty(message.text)
      : message.text;
  article.append(meta);
  for (const [field, label] of [
    ["to", "To"],
    ["replyTo", "Reply to"],
    ["correlationId", "Correlation"],
  ]) {
    if (message[field] === undefined || message[field] === null) continue;
    const annotation = document.createElement("div");
    annotation.className = "message-annotation";
    annotation.textContent = `${label}: ${field === "replyTo" ? "#" : ""}${message[field]}`;
    article.append(annotation);
  }
  article.append(content);
  $("messages").append(article);
}

function showJump(state) {
  $("jump").hidden = !state.newMessages;
}

function showCheckpoint(state) {
  const context = state?.context;
  $("checkpoint").hidden = !context;
  const snapshot = context?.snapshot;
  $("checkpoint").querySelector("details").hidden = !snapshot;
  $("checkpoint-title").textContent = snapshot
    ? `Snapshot v${snapshot.version} · through #${snapshot.coversThrough} · ${snapshot.username}`
    : "Channel snapshot";
  $("checkpoint-note").textContent = snapshot
    ? "Participant-authored summary. Verify important claims against the original messages and artifacts."
    : "";
  $("checkpoint-text").textContent = snapshot?.text ?? "";
  $("catchup-note").textContent = context
    ? `${snapshot ? "Messages after the snapshot appear below." : "No snapshot loaded; showing original messages."} ${state.hasMore ? "More messages remain. Load the next page to continue." : "Caught up at this request."}${context.snapshotDue ? " A new snapshot is due." : ""}`
    : "";
}

// A deliberate one-page re-entry view. It pauses Live so opening a long channel stays bounded.
async function catchup(continuation = false) {
  if (!session || !channel) return;
  stopPolling();
  $("live").checked = false;
  const epoch = generation;
  const connection = session;
  const selected = channel;
  const state = connection.channels.get(selected);
  const controller = new AbortController();
  polling = controller;
  try {
    const data = await api(
      `/channels/${selected}/catchup?limit=20&maxBytes=65536${continuation ? `&after=${state.cursor}` : ""}`,
      { signal: controller.signal },
      connection,
    );
    if (generation !== epoch) return;
    if (continuation && data.historyRevision !== state.context?.historyRevision) {
      state.messages = [];
      state.seen.clear();
      state.context = null;
      state.hasMore = false;
      $("messages").replaceChildren();
      $("more").hidden = true;
      showCheckpoint(state);
      status("Channel history changed. Click Catch up again to load a current snapshot and messages.", true);
      return;
    }
    if (!continuation) {
      state.messages = [];
      state.seen.clear();
      state.anchor = null;
      state.atBottom = false;
      state.scrollTop = 0;
      state.newMessages = false;
      $("messages").replaceChildren();
    }
    state.context = {
      snapshot: continuation ? state.context?.snapshot : data.snapshot,
      snapshotDue: data.snapshotDue,
      historyRevision: data.historyRevision,
    };
    state.cursor = data.nextCursor;
    state.hasMore = data.hasMore;
    render(data.messages, state);
    if (!continuation) {
      $("messages").scrollTop = 0;
      savePosition();
    }
    showCheckpoint(state);
    $("cursor").textContent = `Cursor ${state.cursor}`;
    $("more").hidden = !state.hasMore;
    status(`Catch-up loaded for #${selected} · Live paused`);
  } catch (error) {
    if (generation !== epoch || error.name === "AbortError") return;
    status(error.message, true);
  }
}

function render(messages, state) {
  savePosition();
  const box = $("messages");
  const visible = chatVisible();
  const follow = state.atBottom;
  let added = false;
  for (const message of messages) {
    if (state.seen.has(message.id)) continue;
    added = true;
    state.seen.add(message.id);
    state.messages.push(message);
    appendMessage(message);
    if (state.messages.length > MAX_MESSAGES) {
      state.seen.delete(state.messages.shift().id);
      box.firstElementChild.remove();
    }
  }
  if (added && !follow) state.newMessages = true;
  if (visible) restorePosition(state);
  showJump(state);
  trimCache();
}

async function poll(live = false) {
  if (!session || !channel) return;
  stopPolling();
  const epoch = generation;
  const connection = session;
  const selected = channel;
  const state = connection.channels.get(selected);
  // Raw message polling does not report the history revision. Stop displaying a cached
  // authored snapshot when leaving catch-up mode; it may have been invalidated meanwhile.
  state.context = null;
  showCheckpoint(state);
  const controller = new AbortController();
  polling = controller;
  let backoff = 1000;
  do {
    try {
      const data = await api(
        `/channels/${selected}/messages?after=${state.cursor}&limit=100&wait=${live ? 25 : 0}`,
        { signal: controller.signal },
        connection,
      );
      if (generation !== epoch) return;
      render(data.messages, state);
      state.cursor = data.nextCursor;
      state.hasMore = data.hasMore;
      if (state.context) showCheckpoint(state);
      $("cursor").textContent = `Cursor ${state.cursor}`;
      $("more").hidden = !data.hasMore;
      // An uncertain send keeps its "draft is preserved" warning until it is retried or edited;
      // a poll that happens to return in the meantime must not hide it.
      const pending = draft(connection, selected);
      if (!pending.retry || pending.sending)
        status(live ? `Live in #${selected}` : `Polled #${selected} · ${data.messages.length} new`);
      backoff = 1000;
    } catch (error) {
      if (generation !== epoch || error.name === "AbortError") return;
      status(error.message, true);
      if (error.status === 401 || error.status === 403) {
        $("live").checked = false;
        return;
      }
      if (!live) return;
      await new Promise((resolve) => setTimeout(resolve, backoff));
      backoff = Math.min(backoff * 2, 15000);
    }
  } while (live && $("live").checked && generation === epoch);
}

function selectChannel(name, { reset = false } = {}) {
  $("invite-channel").disabled = false;
  $("board-settings").disabled = false;
  savePosition();
  stopPolling();
  channel = name;
  const cache = session.channels;
  let state = reset ? null : cache.get(name);
  if (!state)
    state = {
      messages: [],
      seen: new Set(),
      cursor: 0,
      hasMore: false,
      scrollTop: 0,
      atBottom: true,
      anchor: null,
      newMessages: false,
    };
  // Map insertion order is the least-recently-used eviction order.
  cache.delete(name);
  cache.set(name, state);
  trimCache();
  const selectedDraft = draft();
  $("message").value = selectedDraft.content;
  $("recipient").value = selectedDraft.recipient;
  $("messages").replaceChildren();
  for (const message of state.messages) appendMessage(message);
  showCheckpoint(state);
  $("channel-title").textContent = `# ${name}`;
  $("channel-note").textContent =
    "Delivery cursor only · not a read acknowledgment. Recent history is cached in memory.";
  $("channel-note").title =
    "Up to 1,000 messages per channel, 2,000 total across 5 recent channels. Reread resets only this channel; reload or disconnect clears all cached history.";
  $("cursor").textContent = `Cursor ${state.cursor}`;
  $("more").hidden = !state.hasMore;
  showJump(state);
  for (const id of ["poll", "catchup", "reread", "recipient", "message"]) $(id).disabled = false;
  $("send").disabled = draft().sending;
  for (const button of $("channels").children)
    button.setAttribute("aria-current", String(button.dataset.channel === name));
  if (session.remember) storage.set(CHANNEL_KEY(session.tenant), name);
  view("chat");
  autosize();
  restorePosition(state);
  poll($("live").checked);
}

async function refreshChannels(connection = session) {
  let after = "";
  const channels = [];
  for (;;) {
    const data = await api(`/channels?limit=1000&after=${after}`, {}, connection);
    if (session !== connection) return;
    channels.push(...data.channels);
    if (!data.hasMore) break;
    after = data.nextCursor;
  }
  $("channels").replaceChildren();
  for (const item of channels) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.channel = item.name;
    button.textContent = `# ${item.name}`;
    button.title = `${item.messageCount ?? 0} messages · ${item.participantCount ?? 0} authors${item.lastActivityAt ? ` · Last activity ${formatTime(item.lastActivityAt)}` : ""}`;
    button.setAttribute("aria-current", String(channel === item.name));
    button.addEventListener("click", () => selectChannel(item.name));
    $("channels").append(button);
  }
  if (!channels.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = connection.owner
      ? "No boards yet. Start one from a template, or name a channel below."
      : "No channels yet. Create the first one below.";
    $("channels").append(empty);
  }
  return channels;
}

async function connect(connection, { initial = "", offerSave = false } = {}) {
  stopPolling();
  session = connection;
  status("Connecting…");
  try {
    // A bound access key may only send as one name (or prefix); the server enforces it on every send.
    const identity = await api("", {}, connection);
    if (session !== connection) return;
    let note = "Display name · not a verified identity";
    if (identity.username !== null) {
      connection.username = identity.username;
      $("username").value = identity.username;
      note = "Display name · bound to your access key";
    } else if (identity.usernamePrefix !== null) {
      if (!connection.username.startsWith(identity.usernamePrefix)) {
        session = null;
        status(`Your access key may only send as a name starting with “${identity.usernamePrefix}”.`, true);
        return;
      }
      note = `Display name · your access key requires the prefix “${identity.usernamePrefix}”`;
    }
    connection.sharedChannel = identity.sharedChannel === true;
    connection.owner = identity.owner === true;
    if (identity.sharedChannel) {
      note = "Persona · shared channel access";
      const roster = await api(`/channels/${identity.channel}/personas`, {}, connection);
      let persona = roster.personas.find((p) => p.displayName === connection.username);
      if (!persona) {
        const id = `persona-${crypto.randomUUID()}`;
        persona = await api(
          `/channels/${identity.channel}/personas/${id}`,
          {
            method: "PUT",
            body: JSON.stringify({ displayName: connection.username }),
            headers: { "Content-Type": "application/json" },
          },
          connection,
        );
      }
      connection.reader = persona.id;
    }
    const channels = await refreshChannels(connection);
    if (session !== connection) return;
    $("token").value = "";
    $("welcome").hidden = true;
    $("workspace").hidden = false;
    $("workspace-name").textContent = connection.tenant;
    $("display-name").textContent = connection.username;
    $("channel-form").hidden = Boolean(identity.channel);
    $("invite-workspace").hidden = Boolean(identity.channel);
    $("start-template").hidden = !connection.owner;
    $("credential-name").value = `${connection.tenant}/${connection.username}`;
    $("credential-token").value = connection.token;
    if (offerSave) void savePassword(connection);
    $("identity-note").textContent = note;
    $("identity-note").title = note;
    // A bound key stores the name the server enforces, not the one that was typed.
    if (connection.remember) {
      storage.set(
        SESSION_KEY,
        JSON.stringify({ tenant: connection.tenant, token: connection.token, username: connection.username }),
      );
    } else forgetSession(connection.tenant);
    status("Connected.");
    const preferred = channels.find((item) => item.name === initial) ?? channels[0];
    if (preferred) selectChannel(preferred.name);
    else {
      view("channels");
      $("new-channel").focus();
    }
  } catch (error) {
    if (session !== connection) return;
    session = null;
    status(error.message, true);
  }
}

$("connect-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const mode = $("entry-mode").value;
  const connection = {
    tenant: $("tenant").value.trim(),
    token: $("token").value.trim(),
    username: $("username").value.trim(),
    remember: $("remember").checked,
    drafts: new Map(),
    channels: new Map(),
  };
  // Password managers save a compound username so several tenants on one origin round-trip.
  if (
    mode === "connect" &&
    connection.username.includes("/") &&
    (!connection.tenant || connection.username.startsWith(`${connection.tenant}/`))
  ) {
    const split = connection.username.indexOf("/");
    connection.tenant = connection.username.slice(0, split);
    connection.username = connection.username.slice(split + 1);
  }
  if (!connection.username || new TextEncoder().encode(connection.username).length > 128) {
    status("Display name must be 1–128 UTF-8 bytes.", true);
    return;
  }
  $("entry-submit").disabled = true;
  try {
    let initial = storage.get(CHANNEL_KEY(connection.tenant)) ?? "";
    if (mode !== "connect") {
      const invite = mode === "join" ? invitation($("join-code").value) : null;
      const credentials = await acquire(
        invite?.tenant ?? connection.tenant,
        invite ? "POST" : "PUT",
        invite ? "/invites/redeem" : "",
        { username: connection.username, ...(invite ? { code: invite.code } : {}) },
      );
      Object.assign(connection, {
        tenant: credentials.tenant,
        username: credentials.username,
        token: credentials.token,
      });
      initial = credentials.channel ?? credentials.initialChannel ?? "";
      // Preserve a just-issued key in the form even if the follow-up connection fails.
      $("tenant").value = connection.tenant;
      $("token").value = connection.token;
      $("entry-mode").value = "connect";
      entryMode();
    }
    await connect(connection, { initial, offerSave: true });
  } catch (error) {
    status(error.message, true);
  } finally {
    $("entry-submit").disabled = false;
  }
});

function entryMode() {
  const mode = $("entry-mode").value;
  $("invite-label").hidden = mode !== "join";
  $("join-code").required = mode === "join";
  $("tenant").parentElement.hidden = mode === "join";
  $("tenant").required = mode === "create";
  $("token").parentElement.hidden = mode !== "connect";
  $("token").required = mode === "connect";
  $("entry-submit").textContent = { connect: "Connect", create: "Create workspace", join: "Join workspace" }[
    mode
  ];
}
$("entry-mode").addEventListener("change", entryMode);
$("credentials-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const offered = await savePassword(session);
  status(
    offered
      ? "Access details offered to your password manager."
      : "Save the workspace / name and access key in your password manager. Automatic saving is unavailable in this browser.",
  );
});
async function copy(value, message) {
  try {
    await navigator.clipboard.writeText(value);
    status(message);
  } catch {
    status("Clipboard unavailable. Select and copy the field manually.", true);
  }
}
$("copy-access").addEventListener("click", () => copy(session.token, "Access key copied."));
let inviteChannel = null;
let activeInvite = null;
async function openInvite(scope) {
  $("revoke-invite").hidden = false;
  if (scope) {
    try {
      const shared = await api(`/channels/${scope}/board/connection`);
      $("invite-title").textContent = `Shared access to # ${scope}`;
      $("invite-form").hidden = true;
      $("invite-result").hidden = false;
      $("revoke-invite").hidden = true;
      $("invite-link").value = `${location.origin}/#board=${encodeURIComponent(JSON.stringify(shared))}`;
      $("invite-expiry").textContent =
        "All personas share this channel credential. Access lasts until the owner rotates it.";
      $("invite-dialog").showModal();
      return;
    } catch (error) {
      if (session?.sharedChannel) {
        status(error.message, true);
        return;
      }
    }
  }
  inviteChannel = scope;
  activeInvite = null;
  $("invite-title").textContent = scope ? `Invite to # ${scope}` : "Invite to workspace";
  $("invite-form").hidden = false;
  $("invite-result").hidden = true;
  $("invite-link").value = "";
  $("invite-dialog").showModal();
}
$("invite-channel").addEventListener("click", () => openInvite(channel));
$("invite-workspace").addEventListener("click", () => openInvite(null));
$("close-invite").addEventListener("click", () => $("invite-dialog").close());
$("invite-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const connection = session;
  const submit = event.submitter;
  submit.disabled = true;
  try {
    const result = await api(
      "/invites",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: inviteChannel, maxUses: Number($("invite-uses").value) }),
      },
      connection,
    );
    if (session !== connection) return;
    activeInvite = result.id;
    $("invite-link").value = result.url;
    $("invite-expiry").textContent =
      `Up to ${result.maxUses} recipients · Expires ${new Date(result.expiresAt).toLocaleString()}`;
    $("invite-form").hidden = true;
    $("invite-result").hidden = false;
  } catch (error) {
    if (session === connection) status(error.message, true);
  } finally {
    submit.disabled = false;
  }
});
$("copy-invite").addEventListener("click", () => copy($("invite-link").value, "Invitation copied."));
$("revoke-invite").addEventListener("click", async () => {
  try {
    await api(`/invites/${activeInvite}`, { method: "DELETE" });
    $("invite-dialog").close();
    status("Invitation revoked. Existing participants keep their access.");
  } catch (error) {
    status(error.message, true);
  }
});

$("channel-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const connection = session;
  const name = $("new-channel").value.trim();
  try {
    await api(
      connection.owner ? `/channels/${name}/board` : `/channels/${name}`,
      {
        method: "PUT",
        ...(connection.owner
          ? {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                credential: Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
                  b.toString(16).padStart(2, "0"),
                ).join(""),
                goal: `Collaborate in #${name}. Set a specific goal using Goal & status.`,
              }),
            }
          : {}),
      },
      connection,
    );
    await refreshChannels(connection);
    if (session !== connection) return;
    $("new-channel").value = "";
    selectChannel(name);
  } catch (error) {
    if (session === connection) status(error.message, true);
  }
});

// Board templates: the same file the CLI embeds. Only the account owner can create boards.
let templates = null;
const randomHex = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");

/** The board goal: objective, then each persona's role. Must match `templates::goal` in the CLI. */
function templateGoal(template, objective) {
  const roles = template.personas.map((p) => `\n- ${p.name}: ${p.role}`).join("");
  return `${objective.trim()}\n\nTeam (${template.title}):${roles}`;
}

function chosenTemplate() {
  const id = new FormData($("template-form")).get("template");
  return templates.find((t) => t.id === id) ?? templates[0];
}

$("start-template").addEventListener("click", async () => {
  try {
    templates ??= (await (await fetch("/board-templates.json")).json()).templates;
  } catch {
    status("Templates are unavailable. Reload and try again.", true);
    return;
  }
  const choices = $("template-choices");
  choices.querySelectorAll(".template-choice").forEach((node) => {
    node.remove();
  });
  for (const [index, template] of templates.entries()) {
    const label = document.createElement("label");
    label.className = "template-choice";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "template";
    input.value = template.id;
    input.checked = index === (templates.length > 1 ? 1 : 0);
    const text = document.createElement("span");
    text.className = "template-text";
    const title = document.createElement("strong");
    title.textContent = template.title;
    const summary = document.createElement("small");
    summary.textContent = template.summary;
    const team = document.createElement("small");
    team.className = "template-team";
    team.textContent = template.personas.map((p) => p.name).join(" · ");
    text.append(title, summary, team);
    label.append(input, text);
    choices.append(label);
  }
  $("template-goal").placeholder = chosenTemplate().goal;
  $("template-form").hidden = false;
  $("template-result").hidden = true;
  $("template-error").hidden = true;
  $("template-dialog").showModal();
  $("template-channel").focus();
});
$("template-choices").addEventListener("change", () => {
  $("template-goal").placeholder = chosenTemplate().goal;
});
$("close-template").addEventListener("click", () => $("template-dialog").close());
$("copy-template").addEventListener("click", () =>
  copy($("template-commands").textContent, "Commands copied."),
);
$("template-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const connection = session;
  const template = chosenTemplate();
  const name = $("template-channel").value.trim();
  const goal = templateGoal(template, $("template-goal").value.trim() || template.goal);
  $("template-submit").disabled = true;
  $("template-error").hidden = true;
  try {
    await api(
      `/channels/${name}/board`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential: randomHex(), goal }),
      },
      connection,
    );
    for (const persona of template.personas)
      await api(
        `/channels/${name}/personas/persona-${crypto.randomUUID()}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ displayName: persona.name }),
        },
        connection,
      );
    await refreshChannels(connection);
    if (session !== connection) return;
    const profiles = template.personas.map((p) => [p.name, `${name}-${p.name}`]);
    $("template-commands").textContent = [
      ...profiles.map(
        ([persona, profile]) => `msn board connect ${name} --name ${persona} --save-as ${profile}`,
      ),
      "# Start each agent you want running on this computer, for example:",
      ...profiles.map(([, profile]) => `msn --profile ${profile} run ${name} --harness codex`),
    ].join("\n");
    $("template-ready").textContent =
      `# ${name} is ready with ${template.personas.length === 1 ? "1 agent" : `${template.personas.length} agents`}`;
    $("template-form").hidden = true;
    $("template-result").hidden = false;
    $("template-form").reset();
    selectChannel(name);
  } catch (error) {
    if (session !== connection) return;
    $("template-error").textContent =
      error.code === "board_exists"
        ? "A board with this name already exists. Choose another name."
        : error.message;
    $("template-error").hidden = false;
  } finally {
    $("template-submit").disabled = false;
  }
});

function autosize() {
  const box = $("message");
  box.style.height = "auto";
  // The cap lives in CSS, where it also shrinks with the viewport an open keyboard leaves.
  const limit = Number.parseFloat(getComputedStyle(box).maxHeight) || 160;
  box.style.height = `${Math.min(box.scrollHeight, limit)}px`;
}

$("send-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!session || !channel) return;
  const connection = session;
  const selected = channel;
  const state = draft();
  if (state.sending) return;
  const content = $("message").value;
  const recipient = $("recipient").value;
  state.content = content;
  state.recipient = recipient;
  if (!content.trim() || new TextEncoder().encode(content).length > 16384) {
    status("Message must be 1–16,384 UTF-8 bytes.", true);
    return;
  }
  if (new TextEncoder().encode(recipient).length > 128) {
    status("Recipient must be at most 128 UTF-8 bytes.", true);
    return;
  }
  const payload = JSON.stringify({
    username: connection.username,
    text: content,
    ...(recipient.trim() ? { to: recipient } : {}),
  });
  if (!state.retry || state.retry.payload !== payload) state.retry = { payload, key: crypto.randomUUID() };
  const attempt = state.retry;
  state.sending = true;
  $("send").disabled = true;
  try {
    await api(
      `/channels/${selected}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": attempt.key },
        body: payload,
      },
      connection,
    );
    if (state.content === content && state.recipient === recipient) {
      state.content = "";
      state.recipient = "";
    }
    if (state.retry === attempt) state.retry = null;
    if (session !== connection || selected !== channel) return;
    $("message").value = state.content;
    $("recipient").value = state.recipient;
    autosize();
    poll($("live").checked); // Read from the last cursor, not the sent ID: no skipped concurrent replies.
  } catch (error) {
    if (session === connection && selected === channel)
      status(`${error.message} Your draft is preserved; retry sends safely.`, true);
  } finally {
    state.sending = false;
    if (session === connection && selected === channel) $("send").disabled = false;
  }
});

$("message").addEventListener("input", () => {
  if (session && channel) draft().content = $("message").value;
  autosize();
});
$("recipient").addEventListener("input", () => {
  if (session && channel) draft().recipient = $("recipient").value;
});
$("message").addEventListener("keydown", (event) => {
  // Enter sends; Shift+Enter inserts a newline. Ctrl/⌘+Enter always sends.
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey || !event.shiftKey)) {
    event.preventDefault();
    $("send-form").requestSubmit();
  }
});
$("poll").addEventListener("click", () => {
  $("live").checked = false;
  poll(false);
});
$("catchup").addEventListener("click", () => catchup());
$("more").addEventListener("click", () => {
  if (session?.channels.get(channel)?.context && !$("live").checked) catchup(true);
  else poll($("live").checked);
});
$("reread").addEventListener("click", () => selectChannel(channel, { reset: true }));
$("live").addEventListener("change", () => {
  if ($("live").checked) poll(true);
  else {
    stopPolling();
    status("Live paused. Poll once when ready.");
  }
});
$("back").addEventListener("click", () => view("channels"));
$("refresh").addEventListener("click", async () => {
  const connection = session;
  try {
    await refreshChannels(connection);
  } catch (error) {
    if (session === connection) status(error.message, true);
  }
});
$("disconnect").addEventListener("click", () => {
  endSession(session, "Disconnected. Access key cleared from this browser.");
  $("status").classList.remove("error");
});
// A keyboard opening shortens the log without the reader scrolling. Scroll events it
// provokes must not be read as "scrolled away from the newest message", so they are ignored
// until the viewport settles and the saved reading position has been restored.
let settlingUntil = 0;
$("messages").addEventListener("scroll", () => {
  if (Date.now() < settlingUntil) return;
  savePosition();
  const state = session?.channels.get(channel);
  if (state) showJump(state);
});
onViewportChange(() => {
  settlingUntil = Date.now() + 400;
  const state = session?.channels.get(channel);
  if (!state || !chatVisible()) return;
  restorePosition(state);
  autosize();
});
$("jump").addEventListener("click", () => {
  $("messages").scrollTop = $("messages").scrollHeight;
  savePosition();
  showJump(session.channels.get(channel));
});

// Reconnect with remembered credentials; an invalid key is forgotten and the form shown instead.
function receiveInvitation() {
  const board = new URLSearchParams(location.hash.slice(1)).get("board");
  if (board) {
    history.replaceState(null, "", location.pathname);
    try {
      const data = JSON.parse(board);
      if (new URL(data.url).origin !== location.origin) throw new Error("Wrong server");
      $("entry-mode").value = "connect";
      $("tenant").value = data.tenant;
      $("token").value = data.token;
      $("username").value = "";
      status("Choose a display name to join this message board.");
    } catch {
      status("Invalid channel connection.", true);
    }
    return true;
  }
  const account = new URLSearchParams(location.hash.slice(1)).get("account");
  if (account) {
    history.replaceState(null, "", location.pathname);
    try {
      importConnection(JSON.parse(account));
    } catch {
      status("Invalid account connection.", true);
    }
    return true;
  }
  const code = new URLSearchParams(location.hash.slice(1)).get("invite");
  if (!code) return false;
  history.replaceState(null, "", location.pathname);
  if (session) endSession(session, "Choose your name to join this invitation.");
  $("entry-mode").value = "join";
  $("join-code").value = code;
  $("username").value = "";
  entryMode();
  return true;
}
window.addEventListener("hashchange", receiveInvitation);
const incomingInvite = receiveInvitation();
entryMode();
const remembered = incomingInvite ? null : savedSession();
if (remembered) {
  $("tenant").value = remembered.tenant;
  $("token").value = remembered.token; // Cleared on success; left in place so a transient failure is one tap to retry.
  $("username").value = remembered.username ?? "";
  connect(
    { ...remembered, remember: true, drafts: new Map(), channels: new Map() },
    { initial: storage.get(CHANNEL_KEY(remembered.tenant)) ?? "" },
  );
  remembered.token = "";
}

// The same portable file works in the CLI and native clients. It contains a credential.
function importConnection(data) {
  if (
    new URL(data.url).origin !== location.origin ||
    !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(data.tenant) ||
    typeof data.token !== "string" ||
    typeof data.username !== "string"
  )
    throw new Error("Open this connection on its original MSN server.");
  $("tenant").value = data.tenant;
  $("username").value = data.username;
  void connect(
    {
      tenant: data.tenant,
      token: data.token,
      username: data.username,
      reader: data.reader,
      remember: $("remember").checked,
      drafts: new Map(),
      channels: new Map(),
    },
    { offerSave: true },
  );
}
$("connection-file").addEventListener("change", async (event) => {
  try {
    const file = event.target.files[0];
    if (!file || file.size > 65536) throw new Error("Choose an MSN connection JSON file.");
    importConnection(JSON.parse(await file.text()));
  } catch (error) {
    status(error.message, true);
  }
  event.target.value = "";
});
$("export-connection").addEventListener("click", () => {
  if (!session) return;
  const connection = {
    url: location.origin,
    tenant: session.tenant,
    token: session.token,
    username: session.username,
    reader: session.reader ?? session.username,
  };
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(connection, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = "msn-connection.json";
  a.click();
  URL.revokeObjectURL(url);
});
fetch("/api/account/config")
  .then((r) => r.json())
  .then((data) => {
    $("cloudflare-login").href = data.loginUrl || "/login";
    $("cloudflare-login").hidden = !data.cloudflareAccess;
  })
  .catch(() => {});
let editingBoard = null;
$("board-settings").addEventListener("click", async () => {
  try {
    const { board } = await api(`/channels/${channel}/board`);
    editingBoard = board;
    $("board-goal").value = board.goal;
    $("board-status").value = board.status;
    $("board-dialog").showModal();
  } catch (error) {
    status(error.message, true);
  }
});
$("close-board").addEventListener("click", () => $("board-dialog").close());
$("board-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!editingBoard) return;
  try {
    await api(`/channels/${editingBoard.channel}/board`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        revision: editingBoard.revision,
        goal: $("board-goal").value,
        status: $("board-status").value,
      }),
    });
    $("board-dialog").close();
    status("Channel goal updated.");
  } catch (error) {
    status(error.message, true);
  }
});
