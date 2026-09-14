const $ = (id) => document.getElementById(id);
let session = null;
let channel = "";
let cursor = 0;
let generation = 0;
let polling = null;
const seen = new Set();

function draft(connection = session, name = channel) {
  if (!connection.drafts.has(name)) connection.drafts.set(name, { content: "", retry: null, sending: false });
  return connection.drafts.get(name);
}

function status(message, error = false) {
  $("status").textContent = message;
  $("status").classList.toggle("error", error);
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

function render(messages) {
  if (messages.length) $("messages").querySelector(".empty")?.remove();
  for (const message of messages) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    const article = document.createElement("article");
    article.className = "message";
    article.dataset.id = message.id;
    const meta = document.createElement("div");
    meta.className = "message-meta";
    const name = document.createElement("strong");
    name.textContent = message.username;
    const time = document.createElement("time");
    time.dateTime = message.createdAt;
    time.textContent = new Date(message.createdAt).toLocaleString();
    time.title = message.createdAt;
    const label = document.createElement("span");
    label.textContent = `#${message.channel} · ${message.id}`;
    meta.append(name, time, label);
    const content = document.createElement("p");
    content.textContent = message.text;
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
      $("cursor").textContent = `Cursor ${cursor} · last 1,000 displayed`;
      $("more").hidden = !data.hasMore;
      status(
        live
          ? `Live in #${selected} · waiting for messages`
          : `Poll complete · ${data.messages.length} messages`,
      );
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
  $("channel-note").textContent = "A shared conversation for humans and agents.";
  $("cursor").textContent = "Cursor 0";
  $("more").hidden = true;
  for (const id of ["poll", "reread", "message"]) $(id).disabled = false;
  $("send").disabled = draft().sending;
  for (const button of $("channels").children)
    button.setAttribute("aria-current", String(button.dataset.channel === name));
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
  return channels;
}

$("connect-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const connection = {
    tenant: $("tenant").value.trim(),
    token: $("token").value.trim(),
    username: $("username").value.trim(),
    drafts: new Map(),
  };
  if (!connection.username || new TextEncoder().encode(connection.username).length > 128) {
    status("Display name must be 1–128 UTF-8 bytes.", true);
    return;
  }
  session = connection;
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
    status("Connected. Choose or create a channel.");
    if (channels.length) selectChannel(channels[0].name);
    else $("new-channel").focus();
  } catch (error) {
    if (session === connection) {
      session = null;
      status(error.message, true);
    }
  }
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
});
$("message").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
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
$("refresh").addEventListener("click", () => refreshChannels().catch((error) => status(error.message, true)));
$("disconnect").addEventListener("click", () => {
  stopPolling();
  session = null;
  channel = "";
  cursor = 0;
  seen.clear();
  $("message").value = "";
  $("messages").replaceChildren();
  $("channels").replaceChildren();
  $("workspace").hidden = true;
  $("welcome").hidden = false;
  status("Disconnected. Access key cleared.");
  $("token").focus();
});
