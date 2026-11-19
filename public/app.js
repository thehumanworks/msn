import { acquire, invitation, savePassword } from "./access.js";
import { disablePush, enablePush, needsHomeScreen, pushEnabled, pushSupported } from "./notify.js";
import { advance, headline, markId, parseMarks, SINCE_PAGES, summarize } from "./since.js";
import { onViewportChange } from "./viewport.js";

const $ = (id) => document.getElementById(id);
const SESSION_KEY = "msn.session";
const CHANNEL_KEY = (tenant) => `msn.channel.${tenant}`;
// Where this reader stopped on each board. Device-local only; the server never learns it.
const MARKS_KEY = (tenant) => `msn.read.${tenant}`;
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
  if (tenant) {
    storage.remove(CHANNEL_KEY(tenant));
    storage.remove(MARKS_KEY(tenant));
  }
}

function readMark(name, connection = session) {
  return connection?.marks?.[markId(connection.username, name)];
}

/**
 * Move this board's read mark to the newest message whose top has reached the visible log.
 * Only while the page is visible: a background tab that keeps receiving does not count as read.
 * While a summary loads, and while a truncated one is showing, the mark stops at the last
 * message the summary covered: following Live to the bottom is not reading what it skipped.
 */
function advanceMark() {
  if (!session || !channel || !chatVisible() || document.visibilityState !== "visible") return;
  const box = $("messages");
  const bottom = box.getBoundingClientRect().bottom;
  let seen = null;
  for (let node = box.lastElementChild; node; node = node.previousElementSibling) {
    if (node.dataset.id && node.getBoundingClientRect().top < bottom) {
      seen = Number(node.dataset.id);
      break;
    }
  }
  const ceiling = session.channels.get(channel)?.markCeiling;
  if (seen !== null && ceiling !== undefined && ceiling !== null) seen = Math.min(seen, ceiling);
  const next = advance(session.marks ?? {}, markId(session.username, channel), seen);
  if (!next) return;
  session.marks = next;
  if (session.remember) storage.set(MARKS_KEY(session.tenant), JSON.stringify(next));
}

function draft(connection = session, name = channel) {
  if (!connection.drafts.has(name))
    connection.drafts.set(name, { content: "", recipient: "", files: [], retry: null, sending: false });
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
  advanceMark();
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

// `stopPush` turns off this device's notifications: on Disconnect and on a revoked key, not when
// an invitation link switches identity.
function endSession(connection, message, { stopPush = false } = {}) {
  if (session !== connection) return;
  stopPolling();
  forgetSession(connection?.tenant);
  if (connection) {
    // The request is sent before the token is cleared.
    const token = connection.token;
    if (stopPush)
      disablePush(connection.tenant, (path, options) =>
        fetch(`/api/tenants/${connection.tenant}${path}`, {
          ...options,
          headers: { Authorization: `Bearer ${token}`, ...options.headers },
        }),
      ).catch(() => {});
    connection.token = "";
    for (const state of connection.drafts.values()) {
      state.content = "";
      state.recipient = "";
      state.files = [];
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
  $("attach-list").replaceChildren();
  $("attach-list").hidden = true;
  $("messages").replaceChildren();
  showCheckpoint(null);
  showSince(null);
  $("channels").replaceChildren();
  for (const id of ["workspace-name", "display-name", "identity-note", "channel-note"])
    $(id).textContent = "";
  $("identity-note").title = "";
  $("channel-note").title = "";
  $("channel-title").textContent = "Choose a channel";
  $("cursor").textContent = "Cursor 0";
  $("more").hidden = true;
  $("jump").hidden = true;
  for (const id of [
    "poll",
    "catchup",
    "reread",
    "recipient",
    "message",
    "send",
    "attach",
    "invite-channel",
    "search",
    "search-submit",
  ])
    $(id).disabled = true;
  clearSearch();
  $("notify").hidden = true;
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
    endSession(connection, message, { stopPush: true });
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

const INLINE_IMAGES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const MAX_ATTACHMENT_BYTES = 1024 * 1024;
const MAX_ATTACHMENTS = 4;

function fileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

/** Fetches one attachment with the bearer key; the browser cannot send it on a plain link. */
async function attachmentBlob(message, index, connection = session) {
  if (!connection || session !== connection) throw new DOMException("Connection ended", "AbortError");
  const response = await fetch(
    `/api/tenants/${connection.tenant}/channels/${message.channel}/messages/${message.id}/attachments/${index}`,
    { headers: { Authorization: `Bearer ${connection.token}` } },
  );
  if (!response.ok) throw new Error(`Attachment unavailable (${response.status})`);
  return response.blob();
}

/** Saves through a temporary object URL; the file's own name comes from the message, as text. */
async function saveAttachment(message, file) {
  try {
    const url = URL.createObjectURL(await attachmentBlob(message, file.index));
    const link = document.createElement("a");
    link.href = url;
    link.download = file.name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (error) {
    status(error.message, true);
  }
}

/** Files under a message: a chip per file, and a preview for common image types. */
function attachmentList(message) {
  const list = document.createElement("ul");
  list.className = "attachments";
  for (const file of message.attachments) {
    const item = document.createElement("li");
    if (INLINE_IMAGES.includes(file.mediaType)) {
      const image = document.createElement("img");
      image.alt = file.name;
      image.loading = "lazy";
      image.className = "attachment-preview";
      const connection = session;
      attachmentBlob(message, file.index, connection)
        .then((blob) => {
          image.src = URL.createObjectURL(blob);
        })
        .catch(() => image.remove());
      item.append(image);
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "attachment";
    button.textContent = `${file.name} · ${fileSize(file.bytes)}`;
    button.title = `Download ${file.name} (${file.mediaType})`;
    button.addEventListener("click", () => saveAttachment(message, file));
    item.append(button);
    list.append(item);
  }
  return list;
}

/** The browser's type without parameters, when the server accepts it; else the server guesses from the name. */
function mediaTypeOf(file) {
  const type = file.type.split(";")[0].trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/.test(type)
    ? { mediaType: type }
    : {};
}

/** The composer's pending files for the selected channel. */
function showFiles(state) {
  const list = $("attach-list");
  list.replaceChildren();
  for (const [index, file] of state.files.entries()) {
    const item = document.createElement("li");
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "quiet";
    remove.textContent = `${file.name} · ${fileSize(file.size)} ✕`;
    remove.title = `Remove ${file.name}`;
    remove.addEventListener("click", () => {
      state.files.splice(index, 1);
      showFiles(state);
    });
    item.append(remove);
    list.append(item);
  }
  list.hidden = !state.files.length;
}

function appendMessage(message, target = $("messages")) {
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
  if (Array.isArray(message.attachments) && message.attachments.length)
    article.append(attachmentList(message));
  // key=value labels (ADR 0032). Each chip lists the channel's messages with that label now.
  const labels = Object.entries(message.labels ?? {});
  if (labels.length) {
    const row = document.createElement("div");
    row.className = "message-labels";
    for (const [key, value] of labels) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "label-chip";
      chip.textContent = `${key}=${value}`;
      chip.title = `Show messages in this channel with ${key}=${value}`;
      chip.addEventListener("click", () => showLabel(key, value));
      row.append(chip);
    }
    article.append(row);
  }
  if (target === $("messages") && session?.channels.get(channel)?.since?.firstId === message.id)
    article.classList.add("since-start");
  target.append(article);
}

/**
 * Board search (ADR 0037). `from:name` words become the sender filter; everything else is sent as
 * q, where each word also matches word starts and "quoted text" is a phrase. Newest matches first.
 */
function parseSearch(input) {
  const from = [];
  const q = input
    .replace(/(^|\s)from:(\S+)/g, (_, space, name) => {
      from.push(name);
      return space;
    })
    .trim();
  return { q, from: from.at(-1) ?? "" };
}

let searchQuery = 0;
let searchState = null;
async function runSearch(older = false) {
  if (!session || !channel) return;
  const query = ++searchQuery;
  const { q, from } = older && searchState ? searchState : parseSearch($("search").value);
  if (!q && !from) return clearSearch();
  if (!older) {
    searchState = { q, from, count: 0, before: null };
    $("search-results").replaceChildren();
  }
  const describe = [q && `“${q}”`, from && `from ${from}`].filter(Boolean).join(" ");
  $("search-panel").hidden = false;
  $("search-older").hidden = true;
  $("search-title").textContent = `Searching for ${describe}…`;
  const params = new URLSearchParams({ limit: "20" });
  if (q) params.set("q", q);
  if (from) params.set("from", from);
  if (older && searchState.before) params.set("before", String(searchState.before));
  try {
    const data = await api(`/channels/${channel}/search?${params}`);
    if (query !== searchQuery) return;
    for (const message of data.messages) appendMessage(message, $("search-results"));
    searchState.count += data.messages.length;
    searchState.before = data.nextBefore ?? null;
    const count = searchState.count;
    $("search-title").textContent =
      `${count}${data.hasMore ? "+" : ""} message${count === 1 ? "" : "s"} matching ${describe}, newest first` +
      (data.complete ? "" : " · older messages are still being indexed");
    $("search-older").hidden = !data.hasMore;
  } catch (error) {
    if (query === searchQuery) $("search-title").textContent = error.message;
  }
}

function clearSearch() {
  searchQuery++;
  searchState = null;
  $("search-panel").hidden = true;
  $("search-older").hidden = true;
  $("search-results").replaceChildren();
}

let labelQuery = 0;
/** Labels can change after a message loads, so the filter always asks the server for the current set. */
async function showLabel(key, value) {
  if (!session || !channel) return;
  const query = ++labelQuery;
  const filter = `${key}=${value}`;
  $("label-filter").hidden = false;
  $("label-filter-title").textContent = `Loading messages with ${filter}…`;
  $("label-results").replaceChildren();
  try {
    const data = await api(`/channels/${channel}/messages?label=${encodeURIComponent(filter)}&limit=100`);
    if (query !== labelQuery) return;
    const count = data.messages.length;
    $("label-filter-title").textContent =
      `${data.hasMore ? "First 100" : count} message${count === 1 ? "" : "s"} with ${filter}`;
    for (const message of data.messages) appendMessage(message, $("label-results"));
  } catch (error) {
    if (query === labelQuery) $("label-filter-title").textContent = error.message;
  }
}

function clearLabel() {
  labelQuery++;
  $("label-filter").hidden = true;
  $("label-results").replaceChildren();
}

function showSince(state) {
  const since = state?.since ?? null;
  $("since").hidden = !since;
  for (const node of $("messages").querySelectorAll(".since-start")) node.classList.remove("since-start");
  $("since-list").replaceChildren();
  if (!since) return;
  $("since-title").textContent = headline(since);
  for (const item of since.items) {
    const row = document.createElement("li");
    row.className = item.attention ? `since-${item.kind} attention` : `since-${item.kind}`;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "quiet";
    button.textContent = item.text;
    button.title = `Show message #${item.id}`;
    button.addEventListener("click", () => showMessage(item.id));
    row.append(button);
    $("since-list").append(row);
  }
  if (since.hidden) {
    const more = document.createElement("li");
    more.className = "since-more";
    more.textContent = `and ${since.hidden} more on the board`;
    $("since-list").append(more);
  }
  $("messages").querySelector(`[data-id="${since.firstId}"]`)?.classList.add("since-start");
}

function showMessage(id, block = "center") {
  const node = $("messages").querySelector(`[data-id="${id}"]`);
  if (!node) {
    status("That message is not loaded yet. Turn on Live or load the next page.", true);
    return;
  }
  node.scrollIntoView({ block });
  node.classList.remove("flash");
  void node.offsetWidth;
  node.classList.add("flash");
  savePosition();
  const state = session?.channels.get(channel);
  if (state) showJump(state);
}

/**
 * Read up to SINCE_PAGES pages after `mark` and summarise them. Plain message reads with the
 * reader's own key: no new endpoint, no server state, no model calls.
 */
async function loadSince(connection, name, state, mark) {
  const load = Symbol(name);
  state.sinceLoad = load;
  state.markCeiling = mark;
  const messages = [];
  let after = mark;
  let truncated = false;
  try {
    for (let page = 0; page < SINCE_PAGES; page++) {
      const data = await api(`/channels/${name}/messages?after=${after}&limit=100`, {}, connection);
      messages.push(...data.messages);
      after = data.nextCursor;
      if (!data.hasMore) break;
      if (page === SINCE_PAGES - 1) truncated = true;
    }
  } catch {
    // The summary is a convenience: the messages themselves still load.
    if (state.sinceLoad === load) state.markCeiling = null;
    return;
  }
  if (state.sinceLoad !== load || session !== connection) return;
  const summary = summarize(messages, { after: mark, me: connection.username, truncated });
  state.since = summary.count ? { mark, ...summary } : null;
  state.markCeiling = truncated ? (messages.at(-1)?.id ?? mark) : null;
  if (channel !== name) return;
  const visible = chatVisible();
  if (visible) savePosition();
  showSince(state);
  if (visible) restorePosition(state);
  advanceMark();
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
  if (added) advanceMark();
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
  $("agents").disabled = false;
  $("search").disabled = false;
  $("search-submit").disabled = false;
  savePosition();
  stopPolling();
  channel = name;
  const cache = session.channels;
  let state = reset ? null : cache.get(name);
  // Only a board loaded fresh in this connection gets a new summary. Returning to a cached
  // board keeps any list still showing; what was loaded while you were here is not news.
  const opening = !state;
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
  showFiles(selectedDraft);
  clearLabel();
  clearSearch();
  $("search").value = "";
  $("messages").replaceChildren();
  for (const message of state.messages) appendMessage(message);
  showCheckpoint(state);
  // Capture where the reader stopped before this visit's own reading moves the mark.
  const mark = state.since?.mark ?? readMark(name);
  showSince(state);
  if (opening && mark !== undefined) void loadSince(session, name, state, mark);
  $("channel-title").textContent = `# ${name}`;
  $("channel-note").textContent =
    "Delivery cursor only · not a read acknowledgment. Where you stopped stays on this device.";
  $("channel-note").title =
    "Up to 1,000 messages per channel, 2,000 total across 5 recent channels. Reread resets only this channel; reload or disconnect clears all cached history. Where you stopped reading is kept in this browser only and is never sent to the server.";
  $("cursor").textContent = `Cursor ${state.cursor}`;
  $("more").hidden = !state.hasMore;
  showJump(state);
  for (const id of ["poll", "catchup", "reread", "recipient", "message", "attach"]) $(id).disabled = false;
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
    connection.marks = connection.remember ? parseMarks(storage.get(MARKS_KEY(connection.tenant))) : {};
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
    void showNotify(connection);
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
    if (!templates) {
      const data = await (await fetch("/board-templates.json")).json();
      if (!Array.isArray(data?.templates) || !data.templates.length) throw new Error("No templates");
      templates = data.templates;
    }
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
  let created = false;
  let failure = null;
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
    created = true;
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
  } catch (error) {
    failure = error;
  }
  $("template-submit").disabled = false;
  if (session !== connection) return;
  if (!created) {
    $("template-error").textContent =
      failure.code === "board_exists"
        ? "A board with this name already exists. Choose another name."
        : failure.message;
    $("template-error").hidden = false;
    return;
  }
  // The board exists even if a persona failed: board connect registers any missing persona,
  // so the same commands finish the setup and a retry is never needed.
  const profiles = template.personas.map((p) => [p.name, `${name}-${p.name}`]);
  $("template-commands").textContent = [
    ...profiles.map(
      ([persona, profile]) => `msn board connect ${name} --name ${persona} --save-as ${profile}`,
    ),
    "# Start each agent you want running on this computer, for example:",
    ...profiles.map(([, profile]) => `msn --profile ${profile} run ${name} --harness codex`),
  ].join("\n");
  const count = template.personas.length === 1 ? "1 agent" : `${template.personas.length} agents`;
  $("template-ready").textContent = `# ${name} is ready with ${count}`;
  $("template-partial").textContent = failure
    ? `Some agents were not added yet (${failure.message}). The connect commands below add them.`
    : "";
  $("template-partial").hidden = !failure;
  $("template-form").hidden = true;
  $("template-result").hidden = false;
  $("template-form").reset();
  try {
    await refreshChannels(connection);
  } catch (error) {
    if (session === connection) status(error.message, true);
  }
  if (session === connection) selectChannel(name);
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
  const files = [...state.files];
  state.sending = true;
  $("send").disabled = true;
  try {
    // Uploads are keyed by content, so retrying this draft yields the same ids and the same key.
    const attachments = [];
    for (const file of files) {
      const { attachment } = await api(
        `/channels/${selected}/attachments`,
        { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file },
        connection,
      );
      attachments.push({
        id: attachment.id,
        name: file.name,
        ...mediaTypeOf(file),
      });
    }
    const payload = JSON.stringify({
      username: connection.username,
      text: content,
      ...(recipient.trim() ? { to: recipient } : {}),
      ...(attachments.length ? { attachments } : {}),
    });
    if (!state.retry || state.retry.payload !== payload) state.retry = { payload, key: crypto.randomUUID() };
    const attempt = state.retry;
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
    state.files = state.files.filter((file) => !files.includes(file));
    if (state.retry === attempt) state.retry = null;
    if (session !== connection || selected !== channel) return;
    $("message").value = state.content;
    $("recipient").value = state.recipient;
    showFiles(state);
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

$("attach").addEventListener("click", () => $("attach-input").click());
$("attach-input").addEventListener("change", () => {
  if (!session || !channel) return;
  const state = draft();
  for (const file of $("attach-input").files) {
    if (state.files.length >= MAX_ATTACHMENTS) {
      status(`A message can carry at most ${MAX_ATTACHMENTS} files.`, true);
      break;
    }
    if (!file.size || file.size > MAX_ATTACHMENT_BYTES) {
      status(`${file.name} must be 1 byte to 1 MiB.`, true);
      continue;
    }
    if (state.files.some((pending) => pending.name === file.name)) {
      status(`A file named ${file.name} is already attached.`, true);
      continue;
    }
    state.files.push(file);
  }
  $("attach-input").value = "";
  showFiles(state);
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
$("label-filter-clear").addEventListener("click", clearLabel);
$("search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void runSearch();
});
$("search-clear").addEventListener("click", () => {
  $("search").value = "";
  clearSearch();
});
$("search-older").addEventListener("click", () => void runSearch(true));
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
  endSession(session, "Disconnected. Access key cleared from this browser.", { stopPush: true });
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
$("since-jump").addEventListener("click", () => {
  const since = session?.channels.get(channel)?.since;
  if (since) showMessage(since.firstId, "start");
});
$("since-done").addEventListener("click", () => {
  const state = session?.channels.get(channel);
  if (!state) return;
  state.since = null;
  state.markCeiling = null;
  showSince(state);
  advanceMark();
});
// Leaving the tab records where you stopped; coming back summarises what arrived meanwhile.
document.addEventListener("visibilitychange", () => {
  const state = session?.channels.get(channel);
  if (!state) return;
  if (document.visibilityState !== "visible") {
    state.hiddenAfter = state.messages.at(-1)?.id ?? 0;
    return;
  }
  const away = state.hiddenAfter;
  state.hiddenAfter = undefined;
  const stored = readMark(channel);
  const mark =
    away === undefined
      ? undefined
      : (state.since?.mark ?? (stored === undefined ? undefined : Math.max(stored, away)));
  // Capture the mark first; then what is on screen now counts as seen (up to any ceiling).
  if (mark !== undefined) void loadSince(session, channel, state, mark);
  advanceMark();
});
// Closing or navigating away records the last position while the page is still visible.
addEventListener("pagehide", () => advanceMark());
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
// A notification opens /?channel=NAME; the address bar goes back to / once it is read.
const notified = new URLSearchParams(location.search);
const notifiedChannel = notified.get("channel");
if (notifiedChannel !== null) history.replaceState(null, "", "/");
if (
  remembered &&
  notified.get("tenant") === remembered.tenant &&
  notifiedChannel &&
  /^[a-z0-9][a-z0-9_-]{0,63}$/.test(notifiedChannel)
)
  storage.set(CHANNEL_KEY(remembered.tenant), notifiedChannel);
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

/** "3 min ago" style text for a past ISO time; coarse on purpose (ADR 0028). */
function ago(iso, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return "just now";
  const units = [
    [86400, "d"],
    [3600, "h"],
    [60, "min"],
  ];
  for (const [size, unit] of units) if (seconds >= size) return `${Math.floor(seconds / size)} ${unit} ago`;
  return "just now";
}
let agentsTimer = null;
let agentsChannel = null;
async function showAgents() {
  const connection = session;
  const target = agentsChannel;
  try {
    const { personas } = await api(`/channels/${target}/personas`, {}, connection);
    if (session !== connection || agentsChannel !== target) return;
    const list = $("agents-list");
    list.replaceChildren();
    if (!personas.length) {
      const empty = document.createElement("li");
      empty.textContent = "No personas on this board yet.";
      list.append(empty);
    }
    for (const persona of personas) {
      const row = document.createElement("li");
      row.className = persona.listening ? "listening" : "idle";
      const dot = document.createElement("span");
      dot.className = "presence-dot";
      dot.setAttribute("aria-hidden", "true");
      const name = document.createElement("strong");
      name.textContent = persona.displayName;
      const detail = document.createElement("small");
      const heard = persona.listening
        ? "Listening"
        : persona.lastListeningAt
          ? `Last listened ${ago(persona.lastListeningAt)}`
          : "Never listened";
      const acted = persona.lastActedAt ? `last acted ${ago(persona.lastActedAt)}` : "no messages yet";
      detail.textContent = `${heard} · ${acted}`;
      row.append(dot, name, detail);
      list.append(row);
    }
    $("agents-title").textContent = `Agents in # ${target}`;
  } catch (error) {
    if (error.name === "AbortError") return;
    $("agents-dialog").close();
    status(
      error.status === 404 ? "This channel is not a board, so it has no agent personas." : error.message,
      true,
    );
  }
}
$("agents").addEventListener("click", async () => {
  agentsChannel = channel;
  $("agents-list").replaceChildren();
  $("agents-title").textContent = `Agents in # ${channel}`;
  $("agents-dialog").showModal();
  await showAgents();
  clearInterval(agentsTimer);
  if ($("agents-dialog").open) agentsTimer = setInterval(showAgents, 30000);
});
$("agents-dialog").addEventListener("close", () => {
  clearInterval(agentsTimer);
  agentsTimer = null;
});
$("close-agents").addEventListener("click", () => $("agents-dialog").close());

// Owner notifications (ADR 0029). Only the human account can turn them on.
async function showNotify(connection) {
  const button = $("notify");
  button.hidden = !connection.owner || (!pushSupported() && !needsHomeScreen());
  if (button.hidden) return;
  button.disabled = !pushSupported();
  if (!pushSupported()) {
    button.textContent = "Add to Home Screen to get notifications";
    return;
  }
  let enabled = false;
  try {
    enabled = await pushEnabled(connection.tenant);
  } catch {}
  if (session !== connection) return;
  button.dataset.enabled = String(enabled);
  button.setAttribute("aria-pressed", String(enabled));
  button.textContent = enabled ? "Notifications on · turn off" : "Notify me when agents need me";
}
$("notify").addEventListener("click", async () => {
  const connection = session;
  if (!connection) return;
  const button = $("notify");
  button.disabled = true;
  try {
    if (button.dataset.enabled === "true") {
      await disablePush(connection.tenant, (path, options) => api(path, options, connection));
      status("Notifications are off on this device.");
    } else {
      await enablePush(connection.tenant, (path, options) => api(path, options, connection));
      status("Notifications are on. You will hear when an agent blocks work or asks you something.");
    }
  } catch (error) {
    status(error.message, true);
  } finally {
    button.disabled = false;
    if (session === connection) await showNotify(connection);
  }
});
if ("serviceWorker" in navigator)
  navigator.serviceWorker.addEventListener("message", (event) => {
    const data = event.data;
    if (data?.type !== "msn.open" || !session || data.tenant !== session.tenant) return;
    if ([...$("channels").children].some((button) => button.dataset.channel === data.channel))
      selectChannel(data.channel);
  });
