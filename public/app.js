const $ = (id) => document.getElementById(id);
const SESSION_KEY = "msn.session";
const CHANNEL_KEY = (tenant) => `msn.channel.${tenant}`;
let session = null;
let channel = "";
let cursor = 0;
let generation = 0;
let polling = null;
const seen = new Set();

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
  if (!connection.drafts.has(name)) connection.drafts.set(name, { content: "", retry: null, sending: false });
  return connection.drafts.get(name);
}

function status(message, error = false) {
  $("status").textContent = message;
  $("status").classList.toggle("error", error);
}

function view(name) {
  $("workspace").dataset.view = name;
}

async function api(path, options = {}, connection = session) {
  const response = await fetch(`/api/tenants/${connection.tenant}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${connection.token}`, ...options.headers },
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error?.message ?? `Request failed (${response.status})`);
    error.status = response.status;
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

function render(messages) {
  if (messages.length) $("messages").querySelector(".empty")?.remove();
  for (const message of messages) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
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
    article.append(meta, content);
    $("messages").append(article);
    if (seen.size > 1000) {
      const first = $("messages").firstElementChild;
      seen.delete(Number(first.dataset.id));
      first.remove();
    }
  }
  if (messages.length) $("messages").scrollTop = $("messages").scrollHeight;
}

async function poll(live = false) {
  if (!session || !channel) return;
  stopPolling();
  const epoch = generation;
  const connection = session;
  const selected = channel;
  const controller = new AbortController();
  polling = controller;
  let backoff = 1000;
  do {
    try {
      const data = await api(
        `/channels/${selected}/messages?after=${cursor}&limit=100&wait=${live ? 25 : 0}`,
        { signal: controller.signal },
        connection,
      );
      if (generation !== epoch) return;
      render(data.messages);
      cursor = data.nextCursor;
      $("cursor").textContent = `Cursor ${cursor}`;
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

function selectChannel(name) {
  stopPolling();
  channel = name;
  cursor = 0;
  $("message").value = draft().content;
  seen.clear();
  $("messages").replaceChildren();
  $("channel-title").textContent = `# ${name}`;
  $("channel-note").textContent = "Everyone in the workspace receives a copy.";
  $("cursor").textContent = "Cursor 0";
  $("more").hidden = true;
  for (const id of ["poll", "reread", "message"]) $(id).disabled = false;
  $("send").disabled = draft().sending;
  for (const button of $("channels").children)
    button.setAttribute("aria-current", String(button.dataset.channel === name));
  if (session.remember) storage.set(CHANNEL_KEY(session.tenant), name);
  view("chat");
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
    if (error.status === 401 || error.status === 403) forgetSession(connection.tenant);
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
  state.content = content;
  if (!content.trim() || new TextEncoder().encode(content).length > 16384) {
    status("Message must be 1–16,384 UTF-8 bytes.", true);
    return;
  }
  const payload = JSON.stringify({ username: connection.username, text: content });
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
    if (state.content === content) state.content = "";
    if (state.retry === attempt) state.retry = null;
    if (session !== connection || selected !== channel) return;
    $("message").value = state.content;
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
$("more").addEventListener("click", () => poll($("live").checked));
$("reread").addEventListener("click", () => selectChannel(channel));
$("live").addEventListener("change", () => {
  if ($("live").checked) poll(true);
  else {
    stopPolling();
    status("Live paused. Poll once when ready.");
  }
});
$("back").addEventListener("click", () => view("channels"));
$("refresh").addEventListener("click", () => refreshChannels().catch((error) => status(error.message, true)));
$("disconnect").addEventListener("click", () => {
  stopPolling();
  forgetSession(session?.tenant);
  session = null;
  channel = "";
  cursor = 0;
  seen.clear();
  $("message").value = "";
  autosize();
  $("messages").replaceChildren();
  $("channels").replaceChildren();
  $("workspace").hidden = true;
  $("welcome").hidden = false;
  view("channels");
  status("Disconnected. Access key cleared from this browser.");
  $("token").focus();
});

// Reconnect with remembered credentials; an invalid key is forgotten and the form shown instead.
const remembered = savedSession();
if (remembered) {
  $("tenant").value = remembered.tenant;
  $("token").value = remembered.token; // Cleared on success; left in place so a transient failure is one tap to retry.
  $("username").value = remembered.username ?? "";
  connect(
    { ...remembered, remember: true, drafts: new Map() },
    { initial: storage.get(CHANNEL_KEY(remembered.tenant)) ?? "" },
  );
}
