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
  for (const id of ["poll", "catchup", "reread", "recipient", "message", "send"]) $(id).disabled = true;
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
  const data = await response.json();
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
  const structured = message.contentType === "application/json";
  if (structured) {
    const kind = document.createElement("span");
    kind.className = "message-kind";
    kind.textContent = "application/json";
    meta.append(kind);
  }
  // The id stays last so every row ends the same way, typed or not.
  meta.append(label);
  const content = document.createElement(structured ? "pre" : "p");
  content.textContent = structured ? pretty(message.text) : message.text;
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
    button.setAttribute("aria-current", String(channel === item.name));
    button.addEventListener("click", () => selectChannel(item.name));
    $("channels").append(button);
  }
  if (!channels.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No channels yet. Create the first one below.";
    $("channels").append(empty);
  }
  return channels;
}

async function connect(connection, { initial = "" } = {}) {
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
    const channels = await refreshChannels(connection);
    if (session !== connection) return;
    $("token").value = "";
    $("welcome").hidden = true;
    $("workspace").hidden = false;
    $("workspace-name").textContent = connection.tenant;
    $("display-name").textContent = connection.username;
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
  const connection = {
    tenant: $("tenant").value.trim(),
    token: $("token").value.trim(),
    username: $("username").value.trim(),
    remember: $("remember").checked,
    drafts: new Map(),
    channels: new Map(),
  };
  if (!connection.username || new TextEncoder().encode(connection.username).length > 128) {
    status("Display name must be 1–128 UTF-8 bytes.", true);
    return;
  }
  await connect(connection, { initial: storage.get(CHANNEL_KEY(connection.tenant)) ?? "" });
});

$("channel-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const connection = session;
  const name = $("new-channel").value.trim();
  try {
    await api(`/channels/${name}`, { method: "PUT" }, connection);
    await refreshChannels(connection);
    if (session !== connection) return;
    $("new-channel").value = "";
    selectChannel(name);
  } catch (error) {
    if (session === connection) status(error.message, true);
  }
});

function autosize() {
  const box = $("message");
  box.style.height = "auto";
  box.style.height = `${Math.min(box.scrollHeight, 160)}px`;
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
$("messages").addEventListener("scroll", () => {
  savePosition();
  const state = session?.channels.get(channel);
  if (state) showJump(state);
});
$("jump").addEventListener("click", () => {
  $("messages").scrollTop = $("messages").scrollHeight;
  savePosition();
  showJump(session.channels.get(channel));
});

// Reconnect with remembered credentials; an invalid key is forgotten and the form shown instead.
const remembered = savedSession();
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
