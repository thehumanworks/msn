import { acquire, invitation, savePassword } from "./access.js";
import { addressees, namesProblem, namesText, parseNames, toField } from "./address.js";
import { briefCount, briefLabel, briefNotice, closedKey, startsOpen } from "./brief.js";
import { answerBody, answeredBy, awaitedName, choiceState, choicesOf } from "./choices.js";
import { boardCurl, inviteCurl } from "./curl.js";
import { draftsFor, parseDrafts, putDraft, restoreDraft, unchangedRetryFiles } from "./drafts.js";
import { SHORTCUTS, shortcut, step } from "./keys.js";
import { renderMarkdown } from "./markdown.js";
import { addressAfterEdit, addressAfterPick, insertMention, mentionAt, people, suggest } from "./mention.js";
import { disablePush, enablePush, needsHomeScreen, pushEnabled, pushSupported } from "./notify.js";
import { quoteOf, quotePreview } from "./quote.js";
import {
  deviceZone,
  localInput,
  presets,
  repeatFrom,
  repeatText,
  SCHEDULED_REFRESH_MS,
  sendAtFrom,
  summary,
  whenText,
} from "./scheduled.js";
import { advance, headline, markId, parseMarks, SINCE_PAGES, summarize } from "./since.js";
import { conflictText, groupTasks, scanTasks, skippedCount, stateText } from "./tasks.js";
import { renderTranscript } from "./transcript.js";
import { badge, currentEntry, UNREAD_REFRESH_MS, unreadByBoard, unreadQuery } from "./unread.js";
import { onViewportChange } from "./viewport.js";
import { authText, subscribeNote, subscription, webhookSummary } from "./webhook.js";

const $ = (id) => document.getElementById(id);
const SESSION_KEY = "msn.session";
const CHANNEL_KEY = (tenant) => `msn.channel.${tenant}`;
// Where this reader stopped on each board. Device-local only; the server never learns it.
const MARKS_KEY = (tenant) => `msn.read.${tenant}`;
// Unsent drafts per board (ADR 0057). Device-local only, and only with "Stay signed in".
const DRAFTS_KEY = (tenant) => `msn.drafts.${tenant}`;
const DRAFT_SAVE_MS = 400;
let session = null;
let channel = "";
let generation = 0;
let polling = null;
// Paste-ready curl steps for the invite link on show (ADR 0056); null hides the button.
let inviteCurlText = null;
/**
 * The open @ suggestions (ADR 0055): where the @ is, the names shown and the highlighted one.
 * `dismissed` is the @ that Escape closed, so typing on after it does not reopen the list.
 */
const mention = { start: -1, options: [], active: 0, dismissed: -1 };
/** Boards the server reports archived (ADR 0046): read only, hidden unless Show archived. */
const archivedBoards = new Set();
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
  /** False when the browser refused the write (blocked storage or a full quota). */
  set(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
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
    storage.remove(DRAFTS_KEY(tenant));
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
  // An open thread shows replies newer than the rows below it; a folded reply has no box.
  for (const reply of box.querySelectorAll(".thread:not([hidden]) > article")) {
    const rect = reply.getClientRects()[0];
    if (rect && rect.top < bottom) seen = Math.max(seen ?? 0, Number(reply.dataset.id));
  }
  const state = session.channels.get(channel);
  const ceiling = state?.markCeiling;
  if (seen !== null && ceiling !== undefined && ceiling !== null) seen = Math.min(seen, ceiling);
  // A followed link that loaded messages holds the mark where it was (ADR 0042).
  const hold = state?.linkHold;
  if (seen !== null && hold !== undefined && hold !== null) seen = Math.min(seen, hold);
  // A reply still folded away has not been read; the mark waits just below it.
  const unseen = firstUnseenReply(state);
  if (seen !== null && unseen !== null) seen = Math.min(seen, unseen.id - 1);
  const next = advance(session.marks ?? {}, markId(session.username, channel), seen);
  if (!next) return;
  session.marks = next;
  if (session.remember) storage.set(MARKS_KEY(session.tenant), JSON.stringify(next));
}

function draft(connection = session, name = channel) {
  if (!connection.drafts.has(name))
    connection.drafts.set(name, {
      content: "",
      recipient: "",
      // The name an @ pick put in To (ADR 0055); To clears again if that @name is deleted.
      mentionTo: null,
      replyTo: null,
      // The part of the replyTo message this reply quotes (ADR 0059), or null.
      quote: null,
      // The id of your own message this one replaces (ADR 0068), or null.
      replaces: null,
      files: [],
      // Files a draft had before a reload; files are never stored, so they must be attached again.
      missingFiles: 0,
      retry: null,
      sending: false,
    });
  return connection.drafts.get(name);
}

/*
 * Keeping drafts on this device (ADR 0057). Only with "Stay signed in"; otherwise drafts live in
 * memory for the connection, as before. Typing is written at most every DRAFT_SAVE_MS; a send
 * writes at once, so its retry key is on disk before the request leaves. The stored value is
 * read again before each write, so two tabs on different boards do not erase each other.
 */
const draftsToSave = new Map();
let draftTimer = null;

function keepDraft(connection = session, name = channel, { now = false } = {}) {
  if (!connection?.remember || !name) return;
  draftsToSave.set(`${connection.tenant}\n${connection.username}\n${name}`, { connection, name });
  if (now) flushDrafts();
  else draftTimer ??= setTimeout(flushDrafts, DRAFT_SAVE_MS);
}

function flushDrafts() {
  clearTimeout(draftTimer);
  draftTimer = null;
  const pending = [...draftsToSave.values()];
  draftsToSave.clear();
  for (const { connection, name } of pending) {
    // A disconnected connection's drafts were already forgotten; never write them back.
    if (session !== connection || !connection.remember) continue;
    const key = DRAFTS_KEY(connection.tenant);
    const id = markId(connection.username, name);
    const next = putDraft(parseDrafts(storage.get(key)), id, draft(connection, name));
    if (!Object.keys(next).length) storage.remove(key);
    // A full quota keeps at least this board's draft; the others stay in memory.
    else if (!storage.set(key, JSON.stringify(next)) && next[id])
      storage.set(key, JSON.stringify({ [id]: next[id] }));
  }
}
addEventListener("pagehide", flushDrafts);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushDrafts();
});

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
  // Fold first: a fold after the restore would move the reading position (ADR 0050).
  foldAll(box);
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
    for (const [id, pending] of draftsToSave) if (pending.connection === connection) draftsToSave.delete(id);
    for (const state of connection.drafts.values()) {
      state.content = "";
      state.recipient = "";
      state.mentionTo = null;
      state.replyTo = null;
      state.quote = null;
      state.replaces = null;
      state.files = [];
      state.retry = null;
    }
    connection.drafts.clear();
    for (const state of connection.channels.values()) {
      state.messages.length = 0;
      state.seen.clear();
      state.cursor = 0;
      state.anchor = null;
      state.pins = [];
      state.brief = null;
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
  inviteCurlText = null;
  $("invite-dialog").close();
  $("message").value = "";
  $("recipient").value = "";
  closeMentions();
  $("new-channel").value = "";
  autosize();
  $("attach-list").replaceChildren();
  $("attach-list").hidden = true;
  showReplyTo(null);
  $("messages").replaceChildren();
  showCheckpoint(null);
  showSince(null);
  showBrief(null);
  showPins(null);
  showLinkNote(null);
  // A link waiting for another workspace survives Disconnect: its note says to connect there next.
  $("channels").replaceChildren();
  for (const id of ["workspace-name", "display-name", "identity-note", "channel-note"])
    $(id).textContent = "";
  $("identity-note").title = "";
  $("channel-note").title = "";
  $("channel-title").textContent = "Choose a channel";
  $("cursor").textContent = "Cursor 0";
  $("more").hidden = true;
  $("jump").hidden = true;
  $("thread-jump").hidden = true;
  for (const id of [
    "poll",
    "catchup",
    "reread",
    "recipient",
    "message",
    "send",
    "attach",
    "invite-channel",
    "tasks",
    "search",
    "search-all",
    "search-submit",
  ])
    $(id).disabled = true;
  if ($("tasks-dialog").open) $("tasks-dialog").close();
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
    // Archived from another device (ADR 0046): show the board as read only right away.
    const board = /^\/channels\/([a-z0-9][a-z0-9_-]{0,63})(\/|$)/.exec(path)?.[1];
    if (session === connection && error.code === "board_archived" && board) markArchived(board, true);
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
      keepDraft();
    });
    item.append(remove);
    list.append(item);
  }
  // Files are never kept on the device (ADR 0057): say which draft lost them on reload.
  if (state.missingFiles > 0) {
    const item = document.createElement("li");
    item.className = "attach-missing";
    const count = state.missingFiles === 1 ? "1 file" : `${state.missingFiles} files`;
    // An unchanged uncertain send still points at its uploads; anything else needs them again.
    const kept =
      session &&
      unchangedRetryFiles(state.retry, {
        username: session.username,
        content: state.content,
        recipient: state.recipient,
        replyTo: state.replyTo,
        quote: state.replyTo === null ? null : state.quote,
        replaces: state.replaces ?? null,
      });
    item.textContent = kept
      ? `Send retries this message with its ${count} already uploaded · editing it needs them attached again`
      : `${count} ${state.missingFiles === 1 ? "was" : "were"} not kept after the reload · attach again`;
    list.append(item);
  }
  list.hidden = !state.files.length && !(state.missingFiles > 0);
}

function appendMessage(message, target = $("messages")) {
  const article = document.createElement("article");
  article.className = message.username === session?.username ? "message mine" : "message";
  article.dataset.id = message.id;
  // Log rows take focus from j and k (ADR 0054); Tab still moves only between controls.
  if (target === $("messages")) {
    article.tabIndex = -1;
    // A focused row is announced by who wrote it, not only as "article".
    article.setAttribute("aria-label", `Message #${message.id} from ${message.username}`);
  }
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
  // A hit from "All boards" (ADR 0073) names its board first; pressing it opens the message there.
  // A hit on another board shows what it has, but its links act on that board, not this one.
  const hit = target === $("search-results") && Boolean(searchState?.all);
  const elsewhere = hit && message.channel !== channel;
  if (hit) {
    const board = document.createElement("button");
    board.type = "button";
    board.className = "quiet search-board";
    board.textContent = `#${message.channel}`;
    board.title = `Open message #${message.id} on board #${message.channel}`;
    board.setAttribute("aria-label", `Open message #${message.id} on board ${message.channel}`);
    board.addEventListener("click", () => void openLink({ channel: message.channel, id: message.id }));
    meta.append(board);
  }
  meta.append(name, time);
  if (message.editedAt) meta.append(editedMark(message));
  // Untrusted content only ever goes through textContent, whatever its contentType claims.
  const boardUpdate = boardNotice(message);
  const structured = message.contentType === "application/json" && !boardUpdate;
  if (structured) {
    const kind = document.createElement("span");
    kind.className = "message-kind";
    kind.textContent = "application/json";
    meta.append(kind);
  }
  // The id stays last so every row ends the same way, typed or not.
  meta.append(label);
  // Only the owner pins (ADR 0038); the strip at the top shows pins to everyone.
  if (session?.owner && target === $("messages")) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "quiet pin-toggle";
    setPinToggle(toggle, isPinned(message.id));
    toggle.addEventListener("click", () => setPin(message.id, !isPinned(message.id)));
    meta.append(toggle);
  }
  // Only the sender edits (ADR 0052); the server checks it too.
  if (target === $("messages") && canEdit(message)) {
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "quiet message-edit";
    edit.textContent = "Edit";
    edit.title = `Edit message #${message.id}`;
    edit.setAttribute("aria-label", `Edit message #${message.id}`);
    edit.addEventListener("click", () => startEdit(article, message.id));
    meta.append(edit);
    // Replace (ADR 0068): post a newer instruction linked to this one; this one stays.
    if (message.replacedBy == null) {
      const replace = document.createElement("button");
      replace.type = "button";
      replace.className = "quiet message-replace";
      replace.textContent = "Replace";
      replace.title = `Send a new message that replaces #${message.id}`;
      replace.setAttribute("aria-label", `Replace message #${message.id} with a new one`);
      replace.addEventListener("click", () => replaceMessage(message));
      meta.append(replace);
    }
  }
  // A link to this one message (ADR 0042). It carries no credential: the reader needs their own access.
  if (session) {
    const link = document.createElement("button");
    link.type = "button";
    link.className = "quiet copy-link";
    link.textContent = "Link";
    link.title = `Copy a link to message #${message.id}`;
    link.setAttribute("aria-label", `Copy link to message #${message.id}`);
    link.addEventListener("click", () =>
      copy(
        messageLink(session.tenant, message.channel, message.id),
        `Link to message #${message.id} copied.`,
      ),
    );
    meta.append(link);
  }
  // Reply (ADR 0054): the button and the r key both address the next message to this one.
  if (session && target === $("messages")) {
    const reply = document.createElement("button");
    reply.type = "button";
    reply.className = "quiet reply-button";
    reply.textContent = "Reply";
    reply.title = `Reply to message #${message.id} (r)`;
    reply.setAttribute("aria-label", `Reply to message #${message.id}`);
    reply.setAttribute("aria-keyshortcuts", "r");
    reply.addEventListener("click", () => replyTo(message));
    // Quote (ADR 0059): the text selected in this message, or all of it, goes above the reply.
    const quote = document.createElement("button");
    quote.type = "button";
    quote.className = "quiet quote-button";
    quote.textContent = "Quote";
    quote.title = `Quote message #${message.id}, or the part of it you selected (q)`;
    quote.setAttribute("aria-label", `Quote message #${message.id} in a reply`);
    quote.setAttribute("aria-keyshortcuts", "q");
    // A tap can clear the selection before the click; read it while it is still there.
    quote.addEventListener("pointerdown", () => {
      pressedSelection = selectionIn(article);
    });
    quote.addEventListener("click", () => {
      const selected = pressedSelection ?? selectionIn(article);
      pressedSelection = null;
      quoteMessage(message, selected);
    });
    meta.append(reply, quote);
  }
  const content = messageContent(message, boardUpdate, structured);
  article.append(meta);
  for (const [field, label] of [
    ["to", "To"],
    ["replyTo", "Reply to"],
    ["correlationId", "Correlation"],
  ]) {
    if (message[field] === undefined || message[field] === null) continue;
    const annotation = document.createElement("div");
    annotation.className = "message-annotation";
    if (field === "replyTo") {
      // The target is a link: it shows a loaded parent, or fetches one that is not loaded (ADR 0041).
      const link = document.createElement("button");
      link.type = "button";
      link.className = "reply-link";
      link.textContent = `#${message.replyTo}`;
      link.title = `Show message #${message.replyTo}, the one this replies to`;
      link.addEventListener("click", () =>
        elsewhere
          ? void openLink({ channel: message.channel, id: message.replyTo })
          : showParent(message, article),
      );
      annotation.append(`${label}: `, link);
    } else if (field === "to") {
      // Several names (ADR 0067) show in the order they were given.
      annotation.textContent = `${label}: ${namesText(addressees(message))}`;
      annotation.classList.add("message-to");
    } else annotation.textContent = `${label}: ${message[field]}`;
    article.append(annotation);
  }
  // Replace an instruction (ADR 0068): each end links to the other, and the old one is dimmed.
  const elsewhereBoard = elsewhere ? message.channel : null;
  if (Number.isSafeInteger(message.replaces))
    article.append(replaceLink("Replaces", message.replaces, elsewhereBoard));
  if (Number.isSafeInteger(message.replacedBy)) markReplaced(article, message.replacedBy, elsewhereBoard);
  // Take a request (ADR 0075): who is handling this, and the button to take or release it.
  fillClaim(article, message, target === $("messages"));
  // The quoted part of the replyTo message (ADR 0059). Plain text; pressing it shows the source.
  if (typeof message.quote === "string" && message.replyTo != null) {
    const block = document.createElement("blockquote");
    block.className = "message-quote";
    block.cite = `#msg=${message.replyTo}`;
    const source = document.createElement("button");
    source.type = "button";
    source.className = "quote-source";
    source.textContent = message.quote;
    source.title = `Quoted from message #${message.replyTo}. Show it`;
    source.setAttribute("aria-label", `Quote from message #${message.replyTo}: ${message.quote}`);
    source.addEventListener("click", () =>
      elsewhere
        ? void openLink({ channel: message.channel, id: message.replyTo })
        : showParent(message, article),
    );
    block.append(source);
    article.append(block);
  }
  // Search hits show in full: the match may be below the fold (ADR 0050).
  article.append(...(target === $("search-results") ? [content] : foldable(content)));
  if (Array.isArray(message.attachments) && message.attachments.length)
    article.append(attachmentList(message));
  // A question's buttons (ADR 0065). Live only in the log; pins and search show the state.
  if (choicesOf(message)) {
    const row = document.createElement("div");
    row.className = "message-choices";
    fillChoices(row, message, target === $("messages"));
    article.append(row);
  }
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
      // The label list is this board's; a hit from another board shows its labels as text.
      if (elsewhere) {
        chip.disabled = true;
        chip.title = `Label on board #${message.channel}`;
      } else {
        chip.title = `Show messages in this channel with ${key}=${value}`;
        chip.addEventListener("click", () => showLabel(key, value));
      }
      row.append(chip);
    }
    article.append(row);
  }
  // Reactions (ADR 0047) on every log message; the chips toggle your own.
  if (target === $("messages") || message.reactions) {
    const reactions = document.createElement("div");
    reactions.className = "message-reactions";
    fillReactions(reactions, message, target === $("messages"));
    article.append(reactions);
  }
  if (target === $("messages")) {
    const receipts = document.createElement("div");
    receipts.className = "message-receipts";
    receipts.title = RECEIPTS_MEANING;
    showReceipt(receipts, message, session?.channels.get(channel)?.receipts);
    article.append(receipts);
  }
  if (target !== $("messages")) {
    target.append(article);
    return article;
  }
  placeInLog(article, message);
  if (session?.channels.get(channel)?.since?.firstId === message.id) {
    article.classList.add("since-start");
    revealInThread(article);
  }
  return article;
}

/*
 * Reply threads (ADR 0041). Display only: the log, cursors and read marks still follow message
 * ids. A reply whose parent is loaded folds into the parent's thread; a reply to a reply joins the
 * same thread, so threads are one level deep. A reply whose parent is not loaded stays in the log
 * at its own place, and its "Reply to" link fetches the parent with an ordinary message read.
 */
const topLevel = (node) => node.closest("#messages > article");
const logArticle = (id) => $("messages").querySelector(`article[data-id="${id}"]`);

function placeInLog(article, message) {
  const parent =
    message.replyTo === undefined || message.replyTo === null ? null : logArticle(message.replyTo);
  if (!parent) return insertById($("messages"), article);
  const root = topLevel(parent);
  article.classList.add("reply");
  insertById(threadOf(root), article);
  showThread(root);
}

/** Insert in id order. New messages are the newest, so the scan from the end usually stops at once. */
function insertById(container, article) {
  const id = Number(article.dataset.id);
  let next = null;
  for (
    let node = container.lastElementChild;
    node && Number(node.dataset.id) > id;
    node = node.previousElementSibling
  )
    next = node;
  container.insertBefore(article, next);
}

function threadOf(root) {
  let thread = root.querySelector(":scope > .thread");
  if (thread) return thread;
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "thread-toggle";
  toggle.addEventListener("click", () => {
    const state = session?.channels.get(channel);
    const id = Number(root.dataset.id);
    if (!state) return;
    state.expanded ??= new Set();
    if (state.expanded.has(id)) state.expanded.delete(id);
    else state.expanded.add(id);
    state.unseen?.delete(id);
    showThread(root);
    savePosition();
    showJump(state);
  });
  thread = document.createElement("div");
  thread.className = "thread";
  thread.id = `thread-${root.dataset.id}`;
  toggle.setAttribute("aria-controls", thread.id);
  root.append(toggle, thread);
  return thread;
}

/** The toggle reads "3 replies", plus "· 1 new" for replies that arrived while it was folded. */
function showThread(root) {
  const thread = root.querySelector(":scope > .thread");
  const toggle = root.querySelector(":scope > .thread-toggle");
  if (!thread || !toggle) return;
  const state = session?.channels.get(channel);
  const id = Number(root.dataset.id);
  const count = thread.children.length;
  if (!count) {
    thread.remove();
    toggle.remove();
    return;
  }
  const open = Boolean(state?.expanded?.has(id));
  const fresh = open ? 0 : (state?.unseen?.get(id)?.size ?? 0);
  thread.hidden = !open;
  toggle.setAttribute("aria-expanded", String(open));
  toggle.textContent = `${open ? "Hide" : "Show"} ${count} repl${count === 1 ? "y" : "ies"}${fresh ? ` · ${fresh} new` : ""}`;
  toggle.classList.toggle("fresh", fresh > 0);
}

/** Open the folded thread holding this article, so a marker or a jump target can be seen. */
function revealInThread(article) {
  if (!article.classList.contains("reply")) return;
  const root = topLevel(article);
  const state = session?.channels.get(channel);
  if (!root || !state) return;
  state.expanded ??= new Set();
  state.expanded.add(Number(root.dataset.id));
  state.unseen?.delete(Number(root.dataset.id));
  showThread(root);
  showJump(state);
}

/** Remove one message from the log. Replies folded under it go back to the log on their own. */
function removeFromLog(id, state) {
  const node = logArticle(id);
  if (!node) return;
  const root = topLevel(node);
  const orphans = [...node.querySelectorAll(":scope > .thread > article")].map((reply) =>
    Number(reply.dataset.id),
  );
  node.remove();
  if (root !== node) {
    state.unseen?.get(Number(root.dataset.id))?.delete(id);
    return showThread(root);
  }
  state.expanded?.delete(id);
  state.unseen?.delete(id);
  if (!orphans.length) return;
  const byId = new Map(state.messages.map((message) => [message.id, message]));
  for (const reply of orphans) if (byId.has(reply)) appendMessage(byId.get(reply));
}

/** "Reply to #N": show the loaded parent, else fetch it once and quote it in the reply. */
async function showParent(message, article) {
  const id = message.replyTo;
  if (logArticle(id)) {
    if (article.closest("#messages")) return showMessage(id);
    clearSearch();
    clearLabel();
    return showMessage(id);
  }
  if (article.querySelector(":scope > .reply-parent")) return;
  const state = session?.channels.get(channel);
  if (!state) return;
  state.parents ??= new Map();
  let parent = state.parents.get(id);
  if (parent === undefined) {
    try {
      parent = (await api(`/channels/${message.channel}/messages/${id}`)).message;
    } catch (error) {
      // 404: no such message; 410: it was deleted. Either way it is gone.
      if (error.status !== 404 && error.status !== 410) {
        status(error.message, true);
        return;
      }
      parent = null;
    }
    state.parents.set(id, parent);
  }
  if (article.querySelector(":scope > .reply-parent")) return;
  const quote = document.createElement("blockquote");
  quote.className = "reply-parent";
  quote.textContent = parent
    ? `${parent.username}: ${parent.text.length > 280 ? `${parent.text.slice(0, 280)}…` : parent.text}`
    : `Message #${id} is no longer available.`;
  article.querySelector(":scope > .message-annotation")?.after(quote);
}

/**
 * Processed-by receipts (ADR 0040). They come only from explicit processing commits (ADR 0053), so the line
 * names only readers that have committed on the server: who committed past this message and who
 * committed but not this far. A persona that never committed is not listed at all (its progress
 * is unknown), and the sender is left out of its own message.
 */
const RECEIPTS_MEANING =
  "From explicit processing commits sent to the server only (the default for msn commit, MCP and msn run; --local keeps them off). Processed: the reader committed past this message. Not yet: the reader has committed, but not this far; it may still have seen it. Agents that never commit to the server are not listed. A shared board key can commit under any persona's name.";
const RECEIPTS_EVERY_MS = 10000;
const RECEIPTS_MAX_NAMES = 10;
function receiptNames(list) {
  const shown = list.slice(0, RECEIPTS_MAX_NAMES).join(", ");
  return list.length > RECEIPTS_MAX_NAMES ? `${shown} +${list.length - RECEIPTS_MAX_NAMES} more` : shown;
}
function receiptLine(receipts, message) {
  if (!Array.isArray(receipts)) return null;
  const relevant = receipts.filter(
    (r) =>
      r.committedThrough !== null &&
      !(message.personaId != null && r.personaId === message.personaId) &&
      r.name !== message.username &&
      !r.name.startsWith(`${message.username}/`),
  );
  const done = relevant.filter((r) => r.committedThrough >= message.id).map((r) => r.name);
  const waiting = relevant.filter((r) => r.committedThrough < message.id).map((r) => r.name);
  if (!done.length && !waiting.length) return null;
  if (!waiting.length) return `Processed by ${receiptNames(done)}`;
  if (!done.length) return `Not yet processed by ${receiptNames(waiting)}`;
  return `Processed by ${receiptNames(done)} · not yet: ${receiptNames(waiting)}`;
}
function showReceipt(element, message, receipts) {
  const line = receiptLine(receipts, message);
  element.textContent = line ?? "";
  element.hidden = line === null;
}
async function loadReceipts(connection, name, state, force = false) {
  if (!force && state.receiptsAt && Date.now() - state.receiptsAt < RECEIPTS_EVERY_MS) return;
  state.receiptsAt = Date.now();
  try {
    const data = await api(`/channels/${name}/receipts`, {}, connection);
    if (data.channel !== name || !Array.isArray(data.receipts)) return;
    state.receipts = data.receipts;
  } catch {
    // Receipts are an extra; an older server or a failed request just leaves them as they were.
    return;
  }
  if (session !== connection || channel !== name) return;
  const byId = new Map(state.messages.map((message) => [message.id, message]));
  // Replies folded into a thread (ADR 0041) are articles inside their root's article.
  for (const article of $("messages").querySelectorAll("article")) {
    const element = article.querySelector(":scope > .message-receipts");
    const message = byId.get(Number(article.dataset.id));
    if (element && message) showReceipt(element, message, state.receipts);
  }
}

const COPIED_MS = 2000;
/** A fence's language tag is the sender's text; the button's name keeps only its start. */
const LANG_LABEL_MAX = 32;

/**
 * Each fenced code block gets a Copy button (ADR 0058). It copies the code as the sender wrote
 * it, without the fence or language tag; the <pre> keeps only the code, so its text is unchanged.
 */
function addCodeCopy(content) {
  for (const pre of content.querySelectorAll("pre.md-code")) {
    const block = document.createElement("div");
    block.className = "md-codeblock";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "copy-code";
    button.textContent = "Copy";
    const lang = pre.dataset.lang?.slice(0, LANG_LABEL_MAX);
    button.setAttribute("aria-label", lang ? `Copy ${lang} code` : "Copy code");
    let timer = 0;
    button.addEventListener("click", async () => {
      const failed = "Clipboard unavailable. The code is selected: copy it manually.";
      if (!(await copy(pre.textContent, "Code copied.", failed))) {
        // Select the code so a manual copy is one keystroke away.
        getSelection()?.selectAllChildren(pre);
        return;
      }
      button.textContent = "Copied";
      clearTimeout(timer);
      timer = setTimeout(() => {
        button.textContent = "Copy";
      }, COPIED_MS);
    });
    pre.replaceWith(block);
    block.append(pre, button);
  }
  return content;
}

/**
 * The plain line shown for a board control message: a goal or status change (`msn.board.v1`) or a
 * brief change (`msn.brief.v1`, ADR 0074). Null for every other message.
 */
function boardNotice(message) {
  if (message.contentType !== "application/json") return null;
  try {
    const data = JSON.parse(message.text);
    if (
      data.schema === "msn.board.v1" &&
      typeof data.goal === "string" &&
      ["active", "paused", "complete", "blocked"].includes(data.status)
    )
      return `Goal ${data.status}: ${data.goal}`;
    return briefNotice(data);
  } catch {
    return null;
  }
}

/** Plain text renders as safe Markdown built from DOM nodes, never innerHTML (ADR 0043). */
function messageContent(message, boardUpdate, structured) {
  if (!boardUpdate && !structured) return addCodeCopy(renderMarkdown(message.text));
  const content = document.createElement(structured ? "pre" : "p");
  content.textContent = boardUpdate ?? pretty(message.text);
  return content;
}

/*
 * Edit a message you sent (ADR 0052). The id, place, replies and read marks stay; only the text
 * changes. Other people's edits arrive from GET …/edits, re-read like reactions.
 */
const EDIT_REFRESH_MS = 15_000;

function canEdit(message) {
  return (
    Boolean(session) &&
    !session.watchOnly &&
    message.username === session.username &&
    message.username !== "github" &&
    !archivedBoards.has(message.channel)
  );
}

/** "Replaces: #N" or "Replaced by: #N", where #N shows that message. */
/** `board` is set for a search hit from another board: the link then opens the message there. */
function replaceLink(label, id, board = null) {
  const annotation = document.createElement("div");
  annotation.className = "message-annotation";
  const link = document.createElement("button");
  link.type = "button";
  link.className = "reply-link";
  link.textContent = `#${id}`;
  link.title = `Show message #${id}`;
  link.addEventListener("click", () => (board ? void openLink({ channel: board, id }) : showMessage(id)));
  annotation.append(`${label}: `, link);
  return annotation;
}

/** Marks one row as replaced by message `id` (ADR 0068): a note under its header, no Replace. */
function markReplaced(article, id, board = null) {
  article.classList.add("replaced");
  article.querySelector(":scope > .message-meta .message-replace")?.remove();
  // A replaced message cannot be taken (ADR 0075); a claim made earlier stays shown.
  article.querySelector(":scope > .message-meta .claim-button")?.remove();
  if (article.querySelector(":scope > .replaced-note")) return;
  const note = replaceLink("Replaced by", id, board);
  note.classList.add("replaced-note");
  article.querySelector(":scope > .message-meta").after(note);
}

/** A newer message replaced `oldId`: mark it in the cache and every row that shows it. */
function showReplaced(state, oldId, newId) {
  const old = state.messages.find((item) => item.id === oldId);
  if (old) old.replacedBy = newId;
  for (const article of document.querySelectorAll(`article[data-id="${oldId}"]`))
    markReplaced(article, newId);
}

function editedMark(message) {
  const mark = document.createElement("span");
  mark.className = "message-edited";
  mark.textContent = "edited";
  mark.title = `Edited ${message.editedAt}`;
  return mark;
}

function startEdit(article, id) {
  const state = session?.channels.get(channel);
  const message = state?.messages.find((item) => item.id === id);
  if (!message || article.querySelector(":scope > .edit-form")) return;
  const body = article.querySelector(":scope > .message-body");
  const toggle = article.querySelector(":scope > .fold-toggle");
  const form = document.createElement("form");
  form.className = "edit-form";
  // The version this editor started from: a save after someone else's edit is refused (409).
  let base = message.editedAt ?? null;
  const input = document.createElement("textarea");
  input.value = message.text;
  input.rows = Math.min(12, Math.max(2, message.text.split("\n").length));
  input.setAttribute("aria-label", `New text for message #${id}`);
  const actions = document.createElement("div");
  actions.className = "edit-actions";
  const save = document.createElement("button");
  save.type = "submit";
  save.textContent = "Save";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "quiet";
  cancel.textContent = "Cancel";
  actions.append(save, cancel);
  form.append(input, actions);
  const close = () => {
    form.remove();
    if (body) body.hidden = false;
    if (toggle) toggle.classList.remove("editing");
  };
  cancel.addEventListener("click", close);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = input.value;
    if (!text.trim()) return status("A message cannot be empty.", true);
    if (text === message.text) return close();
    save.disabled = true;
    const ok = await saveEdit(message, text, base);
    save.disabled = false;
    // After a conflict the user has seen the warning; a second Save replaces the newer version.
    if (ok === "conflict") base = message.editedAt ?? null;
    else if (ok) close();
  });
  if (body) body.hidden = true;
  if (toggle) toggle.classList.add("editing");
  (body ?? article.querySelector(":scope > .message-meta")).after(form);
  input.focus();
}

async function saveEdit(message, text, base) {
  if (!session || !channel) return false;
  const connection = session;
  const name = channel;
  try {
    const data = await api(
      `/channels/${name}/messages/${message.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: connection.username, text, ifEditedAt: base }),
      },
      connection,
    );
    const state = connection.channels.get(name);
    if (state && session === connection && channel === name) showEdit(state, data.message);
    status(`Message #${message.id} edited.`);
    return true;
  } catch (error) {
    if (error.name === "AbortError") return false;
    if (error.code === "edit_conflict") {
      // Someone saved first (another tab or device): fetch their version, keep this editor open.
      const state = connection.channels.get(name);
      if (state) await loadEdits(connection, name, state);
      status(
        `Message #${message.id} changed while you were editing. Save again to replace it, or Cancel to keep the new version.`,
        true,
      );
      return "conflict";
    }
    status(error.message, true);
    return false;
  }
}

/** Applies an edited message's text to the cached copy and every row that shows it. */
function showEdit(state, edited) {
  const message = state.messages.find((item) => item.id === edited.id);
  if (!message || (message.text === edited.text && message.editedAt === edited.editedAt)) return;
  message.text = edited.text;
  message.editedAt = edited.editedAt;
  // An edited task message changes the board (ADR 0070).
  tasksChanged([message], state);
  const boardUpdate = boardNotice(message);
  const structured = message.contentType === "application/json" && !boardUpdate;
  for (const article of $("messages").querySelectorAll(`article[data-id="${edited.id}"]`)) {
    const body = article.querySelector(":scope > .message-body");
    if (body) {
      for (const old of body.children) foldObserver?.unobserve(old);
      const content = messageContent(message, boardUpdate, structured);
      body.replaceChildren(content);
      foldObserver?.observe(content);
    }
    const meta = article.querySelector(":scope > .message-meta");
    const mark = meta?.querySelector(".message-edited");
    if (mark) mark.title = `Edited ${message.editedAt}`;
    else meta?.querySelector("time")?.after(editedMark(message));
  }
}

/**
 * Re-reads edits since the board's edit cursor. The first read starts at 0, so an edit made
 * while the log was loading is not missed; applying an edit twice changes nothing.
 */
async function loadEdits(connection, name, state) {
  state.editsAt = Date.now();
  try {
    for (let page = 0; page < 5; page++) {
      const data = await api(`/channels/${name}/edits?after=${state.editCursor ?? 0}`, {}, connection);
      if (session !== connection || channel !== name) return;
      for (const message of data.edits) showEdit(state, message);
      state.editCursor = data.editCursor;
      if (!data.hasMore) break;
    }
  } catch {}
}

/*
 * Reactions (ADR 0047): a fixed set, one of each per name per message. Reacting sends no message,
 * so the log, cursors and read marks never move; the chips are re-read now and then instead.
 */
const REACTIONS = [
  ["done", "✓", "Done"],
  ["seen", "👀", "Seen"],
  ["yes", "👍", "Yes"],
  ["no", "✗", "No"],
];
const REACTION_REFRESH_MS = 15_000;

function fillReactions(row, message, interactive = true) {
  row.replaceChildren();
  const me = session?.username;
  const canReact =
    interactive && Boolean(session) && !session.watchOnly && !archivedBoards.has(message.channel);
  for (const [kind, symbol, label] of REACTIONS) {
    const names = message.reactions?.[kind] ?? [];
    if (!names.length && !canReact) continue;
    const mine = names.includes(me);
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = names.length ? "reaction-chip" : "reaction-chip reaction-add";
    chip.dataset.kind = kind;
    chip.setAttribute("aria-pressed", String(mine));
    const glyph = document.createElement("span");
    glyph.className = "reaction-glyph";
    glyph.textContent = symbol;
    chip.append(glyph);
    if (names.length) chip.append(` ${names.length}`);
    // Names are untrusted: textContent and attributes only.
    chip.title = names.length
      ? `${label}: ${names.join(", ")}${canReact ? (mine ? " · click to remove yours" : " · click to add yours") : ""}`
      : `React: ${label.toLowerCase()}`;
    chip.setAttribute(
      "aria-label",
      names.length ? `${label}, ${names.length}: ${names.join(", ")}` : `React ${label.toLowerCase()}`,
    );
    if (canReact) chip.addEventListener("click", () => react(message, kind, !mine));
    else chip.disabled = true;
    row.append(chip);
  }
  row.hidden = !row.childElementCount;
}

/** Applies current reactions to the cached message and every row that shows it. */
function showReactions(state, id, reactions) {
  for (const message of state.messages)
    if (message.id === id) {
      if (reactions && Object.keys(reactions).length) message.reactions = reactions;
      else delete message.reactions;
    }
  const message = state.messages.find((item) => item.id === id);
  if (!message) return;
  for (const article of $("messages").querySelectorAll(`article[data-id="${id}"]`)) {
    const row = article.querySelector(":scope > .message-reactions");
    if (row) fillReactions(row, message);
  }
}

async function react(message, kind, add) {
  if (!session || !channel) return;
  const connection = session;
  const name = channel;
  try {
    const data = await api(
      `/channels/${name}/messages/${message.id}/reactions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: connection.username, kind, ...(add ? {} : { remove: true }) }),
      },
      connection,
    );
    const state = connection.channels.get(name);
    if (state && session === connection && channel === name)
      showReactions(state, message.id, data.message?.reactions);
  } catch (error) {
    if (error.name !== "AbortError") status(error.message, true);
  }
}

/**
 * A question's buttons (ADR 0065). The addressed name taps one to answer; everyone else sees who
 * is asked. Once answered, the buttons lock and the chosen one is marked. Choices are untrusted:
 * textContent and attributes only.
 */
function fillChoices(row, message, interactive = true) {
  const choices = choicesOf(message);
  const live = interactive && Boolean(session) && !session.watchOnly && !archivedBoards.has(message.channel);
  const mode = choiceState(message, session?.username, { interactive: live });
  row.replaceChildren();
  row.setAttribute("role", "group");
  row.setAttribute("aria-label", `Answers to message #${message.id}`);
  row.dataset.state = mode;
  for (const choice of choices) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "choice-button";
    button.textContent = choice;
    const chosen = mode === "answered" && message.answered.choice === choice;
    if (mode === "answered") button.setAttribute("aria-pressed", String(chosen));
    if (chosen) button.classList.add("chosen");
    if (mode === "open") {
      button.title = `Answer ${choice}`;
      button.addEventListener("click", () => answerQuestion(message, choice, row));
    } else button.disabled = true;
    row.append(button);
  }
  const note = document.createElement("span");
  note.className = "choice-note";
  if (mode === "answered")
    note.textContent = `${message.answered.username} answered ${message.answered.choice}`;
  else if (mode === "waiting") note.textContent = `Waiting for ${awaitedName(message)}`;
  else note.textContent = "Your answer";
  row.append(note);
}

/** Marks a question answered in the cache and in every row that shows it (ADR 0065). */
function showAnswered(state, questionId, answered) {
  // A question that is not loaded shows its answer when it is read; it carries `answered`.
  const question = state.messages.find((item) => item.id === questionId);
  if (!question || question.answered || !choicesOf(question)) return;
  question.answered = answered;
  for (const row of document.querySelectorAll(`article[data-id="${questionId}"] > .message-choices`))
    fillChoices(row, question, row.closest("#messages") !== null);
}

/** One tap answers a question (ADR 0065): a reply whose text and answer are the choice. */
async function answerQuestion(message, choice, row) {
  if (!session || !channel) return;
  const connection = session;
  const name = channel;
  for (const button of row.querySelectorAll("button")) button.disabled = true;
  try {
    const data = await api(
      `/channels/${name}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify(answerBody(connection.username, message, choice)),
      },
      connection,
    );
    const state = connection.channels.get(name);
    const answered = answeredBy(data.message);
    if (state && answered) showAnswered(state, message.id, answered);
  } catch (error) {
    if (error.name === "AbortError") return;
    const state = connection.channels.get(name);
    // Someone answered first: show their answer instead of the buttons.
    if (error.code === "already_answered" && state) {
      try {
        const fresh = await api(`/channels/${name}/messages/${message.id}`, {}, connection);
        if (fresh.message?.answered) showAnswered(state, message.id, fresh.message.answered);
      } catch {}
    } else fillChoices(row, message, true);
    status(error.message, true);
  }
}

/** Re-reads reactions for the loaded messages. Failure keeps what is shown. */
async function loadReactions(connection, name, state) {
  if (!state.messages.length) return;
  state.reactionsAt = Date.now();
  const ids = state.messages.map((message) => message.id);
  const before = Math.max(...ids) + 1;
  let after = Math.min(...ids) - 1;
  const found = new Map();
  // Claims (ADR 0075) come on the same pages. A server without them sends no `claims` list.
  const claims = new Map();
  let claimsKnown = true;
  // Ids at or below this were covered by the pages read; later ones keep what they show.
  let covered = after;
  try {
    for (let page = 0; page < 5; page++) {
      const data = await api(`/channels/${name}/reactions?after=${after}&before=${before}`, {}, connection);
      for (const entry of data.reactions) found.set(entry.id, entry.reactions);
      if (Array.isArray(data.claims)) for (const entry of data.claims) claims.set(entry.id, entry.claim);
      else claimsKnown = false;
      covered = data.hasMore ? data.nextAfter : before;
      if (!data.hasMore) break;
      after = data.nextAfter;
    }
  } catch {
    return;
  }
  if (session !== connection || channel !== name) return;
  for (const message of [...state.messages]) {
    if (message.id > covered) continue;
    const next = found.get(message.id);
    if (JSON.stringify(next ?? null) !== JSON.stringify(message.reactions ?? null))
      showReactions(state, message.id, next);
    const claim = claims.get(message.id);
    if (claimsKnown && JSON.stringify(claim ?? null) !== JSON.stringify(message.claim ?? null))
      showClaim(state, message.id, claim);
  }
}

/*
 * Take a request (ADR 0075). One name marks a message as being handled, so others skip it. It is
 * a visible signal, not a lock. Only the holder or the owner releases it. Names are untrusted:
 * textContent and attributes only. Other people's claims arrive with the reactions refresh.
 */
const claimOf = (message) =>
  typeof message.claim?.username === "string" && message.claim.username ? message.claim : null;

/** Draws the claim state of one row: a "Taking this" button in its header, or a "Taken by" note. */
function fillClaim(article, message, interactive = true) {
  const meta = article.querySelector(":scope > .message-meta");
  meta?.querySelector(":scope > .claim-button")?.remove();
  article.querySelector(":scope > .claim-note")?.remove();
  article.classList.remove("claimed");
  const live = interactive && Boolean(session) && !session.watchOnly && !archivedBoards.has(message.channel);
  const claim = claimOf(message);
  if (!claim) {
    if (!live || !meta || message.replacedBy != null) return;
    const take = document.createElement("button");
    take.type = "button";
    take.className = "quiet claim-button";
    take.textContent = "Taking this";
    take.title = `Tell everyone you are handling message #${message.id}, so others skip it`;
    take.setAttribute("aria-label", `Take message #${message.id}: tell everyone you are handling it`);
    take.addEventListener("click", () => setClaim(message, false, take));
    meta.append(take);
    return;
  }
  article.classList.add("claimed");
  const mine = claim.username === session?.username;
  const note = document.createElement("div");
  note.className = "message-annotation claim-note";
  const text = document.createElement("span");
  text.className = "claim-holder";
  text.textContent = `Taken by ${claim.username}${mine ? " (you)" : ""}`;
  text.title = `${claim.username} is handling this since ${claim.claimedAt}. Others skip it.`;
  note.append(text);
  // The holder gives it back; the owner can release anyone's. The server checks both.
  if (live && (mine || session.owner)) {
    const release = document.createElement("button");
    release.type = "button";
    release.className = "quiet claim-release";
    release.textContent = "Release";
    release.title = mine
      ? `Stop handling message #${message.id}, so someone else can take it`
      : `Release message #${message.id} from ${claim.username}, so someone else can take it`;
    release.setAttribute("aria-label", `Release message #${message.id}`);
    release.addEventListener("click", () => setClaim(message, true, release));
    note.append(release);
  }
  // Under the header and any "Replaced by" note.
  (article.querySelector(":scope > .replaced-note") ?? meta)?.after(note);
}

/** Applies the current claim to the cached message and every row that shows it. */
function showClaim(state, id, claim) {
  const lists = [state.messages, state.pins ?? []];
  let message = null;
  for (const list of lists)
    for (const item of list)
      if (item.id === id) {
        if (claim) item.claim = claim;
        else delete item.claim;
        message ??= item;
      }
  if (!message) return;
  for (const article of document.querySelectorAll(`article[data-id="${id}"]`)) {
    // Search results keep what the search returned; the log and the pins follow the board.
    if (article.closest("#search-results")) continue;
    fillClaim(article, message, Boolean(article.closest("#messages")));
  }
}

async function setClaim(message, release, button) {
  if (!session || !channel) return;
  const connection = session;
  const name = channel;
  const path = `/channels/${name}/messages/${message.id}`;
  const current = () => connection.channels.get(name);
  const shown = () => session === connection && channel === name && current();
  button.disabled = true;
  try {
    const data = await api(
      `${path}/claim`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: connection.username, ...(release ? { release: true } : {}) }),
      },
      connection,
    );
    if (shown()) showClaim(current(), message.id, data.message?.claim);
  } catch (error) {
    if (error.name === "AbortError") return;
    button.disabled = false;
    status(error.message, true);
    // Someone else got there first, or it changed: show what the board says now.
    if (["already_claimed", "not_holder", "message_replaced"].includes(error.code)) {
      try {
        const data = await api(path, {}, connection);
        if (shown()) {
          showClaim(current(), message.id, data.message?.claim);
          if (Number.isSafeInteger(data.message?.replacedBy))
            showReplaced(current(), message.id, data.message.replacedBy);
        }
      } catch {}
    }
  }
}

/** Pinned messages (ADR 0038): owner-chosen rules, decisions or plans shown above the log. */
const PIN_REFRESH_MS = 30_000;

function isPinned(id) {
  return Boolean(session?.channels.get(channel)?.pins?.some((pin) => pin.id === id));
}

function setPinToggle(button, pinned) {
  button.textContent = pinned ? "Unpin" : "Pin";
  button.title = pinned ? "Remove from the top of this board" : "Pin to the top of this board";
  button.setAttribute("aria-pressed", String(pinned));
}

function showPins(state) {
  const pins = state?.pins ?? [];
  $("pins").hidden = !pins.length;
  $("pins-title").textContent = `Pinned · ${pins.length}`;
  $("pins-list").replaceChildren();
  for (const pin of pins) {
    const row = document.createElement("li");
    const open = document.createElement("button");
    open.type = "button";
    open.className = "quiet pin-text";
    // Untrusted content: textContent only.
    open.textContent = `${pin.username}: ${pin.text}`;
    open.title = `Message #${pin.id}. Click to show it, or to expand it when it is not loaded.`;
    open.addEventListener("click", () => {
      if ($("messages").querySelector(`[data-id="${pin.id}"]`)) showMessage(pin.id);
      else row.classList.toggle("expanded");
    });
    row.append(open);
    if (session?.owner) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "quiet pin-remove";
      remove.textContent = "Unpin";
      remove.title = `Unpin message #${pin.id}`;
      remove.addEventListener("click", () => setPin(pin.id, false));
      row.append(remove);
    }
    $("pins-list").append(row);
  }
  for (const toggle of $("messages").querySelectorAll(".pin-toggle"))
    setPinToggle(
      toggle,
      pins.some((pin) => pin.id === Number(toggle.closest(".message")?.dataset.id)),
    );
}

// Agent status (ADR 0064): one line each name says about what it is doing, with the time it was
// set. Shown exactly as said (textContent only) and never inferred from silence.
const STATUS_REFRESH_MS = 15_000;
function showStatuses(state) {
  const statuses = state?.statuses ?? [];
  $("statuses").hidden = !statuses.length;
  $("statuses-title").textContent = `Agent status · ${statuses.length}`;
  $("statuses-list").replaceChildren(...statuses.map((entry) => statusRow(entry.name, entry)));
}

/** One "name · status · 3 min ago" line; untrusted text goes in through textContent only. */
function statusRow(name, status, tag = "li") {
  const row = document.createElement(tag);
  row.className = "status-row";
  const who = document.createElement("strong");
  who.textContent = name;
  const said = document.createElement("span");
  said.className = "status-text";
  said.textContent = status.text;
  const when = document.createElement("time");
  when.dateTime = status.setAt;
  when.textContent = ago(status.setAt);
  when.title = `Set ${formatTime(status.setAt)}`;
  row.append(who, said, when);
  return row;
}

// A quiet board's long poll can hold for 25 s, so statuses also refresh on their own clock while
// the page is visible. One small read per board every 15 s; nothing while hidden.
setInterval(() => {
  const state = session?.channels.get(channel);
  if (!state || document.hidden) return;
  if (Date.now() - (state.statusesAt ?? 0) > STATUS_REFRESH_MS) void loadStatuses(session, channel);
}, 5000);

// Coming back to the page reads statuses at once instead of waiting for the next tick.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && session && channel) void loadStatuses(session, channel);
});

/*
 * The board brief (ADR 0074): the owner's standing instructions, as the board's header. Folding it
 * is remembered on this device until the owner writes a newer version.
 */
function briefClosedKey() {
  return closedKey(location.origin, session?.tenant ?? "", channel);
}

function showBrief(state) {
  const brief = state?.brief ?? null;
  $("brief").hidden = !brief;
  // Only the account owner writes the brief; the server refuses everyone else.
  $("edit-brief").hidden = !session?.owner || !channel;
  if (!brief) {
    $("brief-text").replaceChildren();
    return;
  }
  $("brief-meta").textContent = briefLabel(brief, formatTime);
  $("brief-text").replaceChildren(addCodeCopy(renderMarkdown(brief.text)));
  let closed = null;
  try {
    closed = localStorage.getItem(briefClosedKey());
  } catch {}
  $("brief").querySelector("details").open = startsOpen(closed, brief.version);
}

$("brief")
  .querySelector("details")
  .addEventListener("toggle", (event) => {
    const details = event.currentTarget;
    const version = session?.channels.get(channel)?.brief?.version;
    if (!version) return;
    try {
      if (details.open) localStorage.removeItem(briefClosedKey());
      else localStorage.setItem(briefClosedKey(), String(version));
    } catch {}
  });

/** Reads the board's brief. Failure keeps what is shown: the log still works without it. */
async function loadBrief(connection = session, name = channel) {
  const state = connection?.channels.get(name);
  if (!state) return null;
  state.briefAt = Date.now();
  let data;
  try {
    data = await api(`/channels/${name}/brief`, {}, connection);
  } catch {
    return null;
  }
  state.brief = data.brief;
  state.briefVersion = data.currentVersion;
  if (session === connection && channel === name) showBrief(state);
  return data;
}

function briefDialogNote(text, error = false) {
  $("brief-note").textContent = text;
  $("brief-note").classList.toggle("error", error);
  $("brief-note").hidden = !text;
}

function showBriefCount() {
  const count = briefCount($("brief-input").value);
  $("brief-count").textContent = count.over ? `${count.text}: too long to save` : count.text;
  $("brief-count").classList.toggle("error", count.over);
  $("brief-save").disabled = count.over;
}

let editingBrief = null;
$("edit-brief").addEventListener("click", async () => {
  if (!session || !channel) return;
  const connection = session;
  const name = channel;
  const current = await loadBrief(connection, name);
  if (!current) {
    status("Could not read the board's brief. Try again.", true);
    return;
  }
  editingBrief = { connection, name, version: current.currentVersion };
  $("brief-input").value = current.brief?.text ?? "";
  showBriefCount();
  briefDialogNote("");
  const history = $("brief-history");
  history.replaceChildren();
  $("brief-history-row").hidden = true;
  $("brief-dialog").showModal();
  try {
    const { versions } = await api(`/channels/${name}/brief/versions`, {}, connection);
    if (editingBrief?.name !== name || versions.length < 2) return;
    const first = document.createElement("option");
    first.value = "";
    first.textContent = "Load an earlier version…";
    history.append(first);
    for (const version of versions) {
      const option = document.createElement("option");
      option.value = String(version.version);
      option.textContent = briefLabel(version, formatTime) + (version.bytes ? "" : " · removed");
      history.append(option);
    }
    $("brief-history-row").hidden = false;
  } catch {}
});
$("brief-history").addEventListener("change", async () => {
  const version = $("brief-history").value;
  if (!version || !editingBrief) return;
  try {
    const { brief } = await api(
      `/channels/${editingBrief.name}/brief?version=${version}`,
      {},
      editingBrief.connection,
    );
    $("brief-input").value = brief.text;
    showBriefCount();
    briefDialogNote(`Loaded version ${version}. Press Save to make it the brief again.`);
  } catch (error) {
    briefDialogNote(error.message, true);
  }
});
$("brief-input").addEventListener("input", showBriefCount);
$("close-brief").addEventListener("click", () => $("brief-dialog").close());
$("brief-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!editingBrief) return;
  const { connection, name, version } = editingBrief;
  $("brief-save").disabled = true;
  try {
    const saved = await api(
      `/channels/${name}/brief`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: $("brief-input").value, baseVersion: version }),
      },
      connection,
    );
    const state = connection.channels.get(name);
    if (state) {
      state.brief = saved.brief;
      state.briefVersion = saved.currentVersion;
      if (session === connection && channel === name) showBrief(state);
    }
    $("brief-dialog").close();
    status(
      !saved.changed
        ? "The brief is unchanged."
        : saved.brief
          ? `Brief saved as version ${saved.currentVersion} · agents are told it changed`
          : "Brief removed.",
    );
  } catch (error) {
    if (error.code === "brief_conflict") {
      // Written from another device meanwhile: keep this text, and save over the newer version
      // only on a second, deliberate press.
      const current = await loadBrief(connection, name);
      if (current) editingBrief.version = current.currentVersion;
      briefDialogNote(
        "The brief was changed somewhere else while you were writing. Your text is kept here; press Save again to replace the newer version.",
        true,
      );
    } else briefDialogNote(error.message, true);
  } finally {
    showBriefCount();
  }
});

/** Reads the board's statuses. Failure keeps what is shown, like pins. */
async function loadStatuses(connection = session, name = channel) {
  const state = connection?.channels.get(name);
  if (!state) return;
  state.statusesAt = Date.now();
  try {
    const data = await api(`/channels/${name}/statuses`, {}, connection);
    state.statuses = data.statuses;
  } catch {
    return;
  }
  if (session === connection && channel === name) showStatuses(state);
}

/** Reads the board's pins. Failure keeps what is shown: pins are a convenience, not the log. */
async function loadPins(connection = session, name = channel) {
  const state = connection?.channels.get(name);
  if (!state) return;
  state.pinsAt = Date.now();
  try {
    const data = await api(`/channels/${name}/pins`, {}, connection);
    state.pins = data.pins;
  } catch {
    return;
  }
  if (session === connection && channel === name) showPins(state);
}

async function setPin(id, pinned) {
  if (!session || !channel) return;
  const connection = session;
  const name = channel;
  try {
    await api(`/channels/${name}/pins/${id}`, { method: pinned ? "PUT" : "DELETE" }, connection);
    status(pinned ? `Pinned #${id} to the top of #${name}` : `Unpinned #${id}`);
  } catch (error) {
    if (error.name !== "AbortError") status(error.message, true);
  }
  await loadPins(connection, name);
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
    // All boards (ADR 0073): one request for every board this key can read. The server picks the
    // boards from the key. Archived boards are searched only while the board list shows them.
    const all = $("search-all").checked && !$("search-all-label").hidden;
    searchState = { q, from, count: 0, before: null, all, archived: all && $("show-archived").checked };
    $("search-results").replaceChildren();
  }
  const { all, archived } = searchState;
  const describe = [q && `“${q}”`, from && `from ${from}`].filter(Boolean).join(" ");
  const where = all ? " on all boards" : "";
  $("search-panel").hidden = false;
  $("search-older").hidden = true;
  $("search-title").textContent = `Searching${where} for ${describe}…`;
  const params = new URLSearchParams({ limit: "20" });
  if (q) params.set("q", q);
  if (from) params.set("from", from);
  if (older && searchState.before) params.set("before", String(searchState.before));
  if (archived) params.set("include", "archived");
  try {
    const data = await api(all ? `/search?${params}` : `/channels/${channel}/search?${params}`);
    if (query !== searchQuery) return;
    for (const message of data.messages) appendMessage(message, $("search-results"));
    searchState.count += data.messages.length;
    searchState.before = data.nextBefore ?? null;
    const count = searchState.count;
    $("search-title").textContent =
      `${count}${data.hasMore ? "+" : ""} message${count === 1 ? "" : "s"}${where} matching ${describe}, newest first` +
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
  const first = logArticle(since.firstId);
  if (!first) return;
  first.classList.add("since-start");
  revealInThread(first);
}

/*
 * Long messages fold (ADR 0050). Display only: the page holds the whole text, so search, copy,
 * links, exports and agents see it unchanged. A body taller than FOLD_LINES rendered lines is
 * clipped by CSS to its first lines, with Show more under it. Folding by rendered height never
 * cuts Markdown in its source, so a code block or table is clipped, not broken.
 */
const FOLD_LINES = 15;
const foldObserver =
  typeof ResizeObserver === "function"
    ? new ResizeObserver((entries) => foldBoxes(entries.map((entry) => entry.target.parentElement)))
    : null;

/** [body, toggle]: the content in a box that folds when it is long, and its Show more button. */
function foldable(content) {
  const box = document.createElement("div");
  box.className = "message-body";
  box.append(content);
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "fold-toggle";
  toggle.hidden = true;
  toggle.addEventListener("click", () => {
    setFold(box, !box.classList.contains("folded"));
    // Folding a long message the reader scrolled through keeps its button in view.
    if (box.classList.contains("folded")) toggle.scrollIntoView({ block: "nearest" });
  });
  // Tabbing to a link hidden by the fold opens it, so the focused element is visible. Links in
  // the lines that show leave the fold as it is.
  box.addEventListener("focusin", (event) => {
    if (!box.classList.contains("folded")) return;
    const hidden =
      box.scrollTop > 0 || event.target.getBoundingClientRect().bottom > box.getBoundingClientRect().bottom;
    if (!hidden) return;
    box.scrollTop = 0;
    setFold(box, false);
  });
  foldObserver?.observe(content);
  return [box, toggle];
}

/** The ids the reader opened on the open board: Show more and jumps survive a board switch. */
function unfoldedIds() {
  const state = session?.channels.get(channel);
  if (!state) return null;
  state.unfolded ??= new Set();
  return state.unfolded;
}

const isOpen = (box) => Boolean(unfoldedIds()?.has(Number(box.closest("article")?.dataset.id)));

/**
 * Fold each box whose content is taller than FOLD_LINES lines, unless the reader opened it. All
 * heights are read first and all classes written after, so a long log lays out once.
 */
function foldBoxes(boxes) {
  const measured = [];
  for (const box of boxes) {
    const content = box?.firstElementChild;
    const toggle = box?.nextElementSibling;
    if (!content || !toggle?.classList.contains("fold-toggle")) continue;
    const height = content.offsetHeight;
    // A hidden thread or panel measures 0; it keeps its state and is measured when it shows.
    if (!height) continue;
    const line = Number.parseFloat(getComputedStyle(content).lineHeight) || 22;
    measured.push([box, toggle, height > FOLD_LINES * line]);
  }
  for (const [box, toggle, long] of measured) {
    if (toggle.hidden === long) toggle.hidden = !long;
    box.classList.toggle("folded", long && !isOpen(box));
    showFoldToggle(box, toggle);
  }
}

/** Fold every message in `container` now, before anything scrolls to or restores a position. */
function foldAll(container = $("messages")) {
  foldBoxes(container.querySelectorAll(".message-body"));
}

function setFold(box, folded) {
  const id = Number(box.closest("article")?.dataset.id);
  const open = unfoldedIds();
  if (open && id) {
    if (folded) open.delete(id);
    else open.add(id);
  }
  box.classList.toggle("folded", folded);
  const toggle = box.nextElementSibling;
  if (toggle?.classList.contains("fold-toggle")) showFoldToggle(box, toggle);
}

function showFoldToggle(box, toggle) {
  const folded = box.classList.contains("folded");
  const text = folded ? "Show more" : "Show less";
  if (toggle.textContent !== text) toggle.textContent = text;
  if (toggle.getAttribute("aria-expanded") !== String(!folded))
    toggle.setAttribute("aria-expanded", String(!folded));
}

/** Open a folded message: a link, a jump or a pin shows the whole message. */
function unfold(article) {
  const box = article.querySelector(":scope > .message-body");
  if (box) setFold(box, false);
}

function showMessage(id, block = "center") {
  const node = $("messages").querySelector(`[data-id="${id}"]`);
  if (!node) {
    status("That message is not loaded yet. Turn on Live or load the next page.", true);
    return;
  }
  revealInThread(node);
  unfold(node);
  // Messages above fold now, not on the next frame, or the scroll would land short of the target.
  foldAll();
  node.scrollIntoView({ block });
  node.classList.remove("flash");
  void node.offsetWidth;
  node.classList.add("flash");
  savePosition();
  const state = session?.channels.get(channel);
  if (state) showJump(state);
}

/*
 * Message links (ADR 0042). /#board=TENANT/CHANNEL&msg=ID opens that board scrolled to the message
 * and highlights it. A link names a message, never a credential: whoever opens it reads with their
 * own access. Only the existing point read and message pages are used; nothing new on the server.
 */
const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
// Pages read forward from the loaded log, like "Load next page", before jumping to the message.
const LINK_PAGES = 3;
let pendingLink = null;

function messageLink(tenant, name, id) {
  return `${location.origin}/#board=${tenant}/${name}&msg=${id}`;
}

/*
 * Board links (ADR 0066). /#board=TENANT/CHANNEL&key=KEY joins a board with its shared key. It reads
 * like a message link and needs no escaping (slugs and a hex key). The key stays in the fragment,
 * which never reaches the server. Links from before carry URL-encoded JSON (#board=%7B...) and
 * still work.
 */
function boardLink({ tenant, channel: name, token }) {
  return `${location.origin}/#board=${tenant}/${name}&key=${token}`;
}

/** { tenant, token } from a board link's fragment parameters, or null when it is not valid. */
function parseBoardLink(params) {
  const board = params.get("board") ?? "";
  if (params.has("key")) {
    const [tenant = "", name = "", ...rest] = board.split("/");
    const token = params.get("key") ?? "";
    if (rest.length || !SLUG.test(tenant) || !SLUG.test(name) || !/^[A-Za-z0-9_-]{16,256}$/.test(token))
      return null;
    return { tenant, token };
  }
  try {
    const data = JSON.parse(board);
    if (new URL(data.url).origin !== location.origin) return null;
    if (typeof data.tenant !== "string" || typeof data.token !== "string") return null;
    return { tenant: data.tenant, token: data.token };
  } catch {
    return null;
  }
}

/** { tenant, channel, id } from #board=TENANT/CHANNEL&msg=ID, or null when it is not a valid link. */
function parseMessageLink(params) {
  const [tenant = "", name = "", ...rest] = (params.get("board") ?? "").split("/");
  const raw = params.get("msg") ?? "";
  const id = Number(raw);
  if (rest.length || !SLUG.test(tenant) || !SLUG.test(name)) return null;
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(id)) return null;
  return { tenant, channel: name, id };
}

function showLinkNote(text, { fromStart = false } = {}) {
  $("link-note").hidden = !text;
  $("link-note-text").textContent = text ?? "";
  $("link-note-start").hidden = !fromStart;
}

function otherWorkspace(link) {
  return `This link is for workspace “${link.tenant}”. Disconnect, then connect to it to open message #${link.id}.`;
}

/** Open a link now when this connection can; otherwise keep it until a connection to its workspace. */
function followLink(link) {
  const connected = Boolean(session) && !$("workspace").hidden;
  if (connected && session.tenant === link.tenant) return void openLink(link);
  pendingLink = link;
  if (connected) return status(otherWorkspace(link), true);
  if (!session) {
    // A remembered connection to the same workspace replaces this right away and opens the link.
    $("entry-mode").value = "connect";
    entryMode();
    $("tenant").value = link.tenant;
    status(`Connect to workspace “${link.tenant}” to open message #${link.id}.`);
  }
}

/** The connection just finished: open its link, or say why the link waits. True when it opened. */
function takePendingLink(connection, channels) {
  const link = pendingLink;
  if (!link) return false;
  if (link.tenant !== connection.tenant) {
    status(otherWorkspace(link), true);
    return false;
  }
  pendingLink = null;
  if (!channels.some((item) => item.name === link.channel)) {
    status(`Board #${link.channel} is not in this workspace, or your access key cannot read it.`, true);
    return false;
  }
  void openLink(link);
  return true;
}

/**
 * Show message `id` of board `name`: select the board, load the message if it is not loaded, open
 * its thread if it is a folded reply, scroll to it and highlight it. 404 and 410 leave a note.
 */
async function openLink({ channel: name, id }) {
  if (!session) return;
  if (![...$("channels").children].some((node) => node.dataset.channel === name)) {
    status(`Board #${name} is not in this workspace, or your access key cannot read it.`, true);
    return;
  }
  if (name !== channel) selectChannel(name);
  else view("chat");
  clearSearch();
  clearLabel();
  showLinkNote(null);
  // The link drives loading until the message shows.
  stopPolling();
  const epoch = generation;
  const connection = session;
  const state = connection.channels.get(name);
  const current = () => generation === epoch && session === connection && channel === name;
  try {
    if (!logArticle(id)) {
      status(`Opening message #${id}…`);
      try {
        await api(`/channels/${name}/messages/${id}`, {}, connection);
      } catch (error) {
        if (!current()) return;
        if (error.status !== 404 && error.status !== 410) throw error;
        const note =
          error.status === 410
            ? `Message #${id} was deleted from #${name}.`
            : `Message #${id} is not on #${name}. Check the link.`;
        showLinkNote(note);
        status(note, true);
        return;
      }
      if (!current()) return;
      // Following a link is not reading what it skips: the read mark stays where it was for the
      // rest of this visit, so "since you last looked" still lists those messages. A fresh read
      // (Reread or Load from the start) starts a new board state without the hold.
      const mark = readMark(name, connection);
      if (mark !== undefined) state.linkHold = Math.min(state.linkHold ?? mark, mark);
      for (let page = 0; page < LINK_PAGES && !logArticle(id) && id > state.cursor; page++) {
        const data = await api(`/channels/${name}/messages?after=${state.cursor}&limit=100`, {}, connection);
        if (!current()) return;
        render(data.messages, state);
        state.cursor = data.nextCursor;
        state.hasMore = data.hasMore;
        if (!data.hasMore) break;
      }
      if (!logArticle(id)) {
        // Older than the loaded log, or far ahead of it: show the board from the message onward.
        Object.assign(state, {
          context: null,
          anchor: null,
          atBottom: false,
          scrollTop: 0,
          newMessages: false,
        });
        state.messages = [];
        state.seen.clear();
        // A summary still loading would draw on the replaced log; the held mark keeps it for later.
        state.sinceLoad = null;
        state.since = null;
        showSince(state);
        $("messages").replaceChildren();
        showCheckpoint(state);
        const data = await api(`/channels/${name}/messages?after=${id - 1}&limit=100`, {}, connection);
        if (!current()) return;
        render(data.messages, state);
        state.cursor = data.nextCursor;
        state.hasMore = data.hasMore;
        // Unseen replies stay unseen; only those no longer in the log lose their pointer.
        for (const [root, ids] of state.unseen ?? []) {
          for (const reply of ids) if (!logArticle(reply)) ids.delete(reply);
          if (!ids.size) state.unseen.delete(root);
        }
        showJump(state);
        showLinkNote(`Showing #${name} from message #${id}. Earlier messages are not loaded.`, {
          fromStart: true,
        });
      }
      $("cursor").textContent = `Cursor ${state.cursor}`;
      $("more").hidden = !state.hasMore;
    }
    const article = logArticle(id);
    if (!article) {
      status(`Message #${id} could not be shown. Reread the board and try the link again.`, true);
      return;
    }
    // A reply whose parent is not loaded quotes the parent, so the message reads in context.
    const message = state.messages.find((item) => item.id === id);
    // A reply that carries a quote (ADR 0059) already shows what it answers.
    if (message?.replyTo != null && message.quote == null && !logArticle(message.replyTo))
      void showParent(message, article);
    for (const node of $("messages").querySelectorAll(".linked")) node.classList.remove("linked");
    article.classList.add("linked");
    showMessage(id);
    status(`Showing message #${id} in #${name}.`);
  } catch (error) {
    if (current() && error.name !== "AbortError") status(error.message, true);
  } finally {
    // Live resumes. Without Live, only an empty log (a link that failed) gets its first page.
    if (current() && ($("live").checked || !state.messages.length)) poll($("live").checked);
  }
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
  const next = firstUnseenReply(state);
  $("thread-jump").hidden = next === null;
  if (next !== null) $("thread-jump").textContent = `New reply in thread #${next.root} · Show`;
}

/** The oldest reply that arrived in a folded thread and has not been shown yet. */
function firstUnseenReply(state) {
  let next = null;
  for (const [root, ids] of state?.unseen ?? [])
    for (const id of ids) if (next === null || id < next.id) next = { root, id };
  return next;
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
    if (Array.isArray(data.pinned) && !data.pinnedOmitted) {
      state.pins = data.pinned;
      state.pinsAt = Date.now();
    }
    render(data.messages, state);
    showPins(state);
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
  const visible = chatVisible();
  const follow = state.atBottom;
  let added = false;
  let addedRow = false;
  for (const message of messages) {
    if (state.seen.has(message.id)) continue;
    added = true;
    state.seen.add(message.id);
    state.messages.push(message);
    const article = appendMessage(message);
    // An answer locks its question's buttons (ADR 0065); only the first answer counts.
    const answered = answeredBy(message);
    if (answered) showAnswered(state, message.replyTo, answered);
    if (Number.isSafeInteger(message.replaces)) showReplaced(state, message.replaces, message.id);
    if (article.classList.contains("reply")) {
      // Someone else's reply after your read mark, in a folded thread, is unseen until the
      // thread is opened: the toggle and the thread pointer say so, and the read mark waits
      // below it. On a board you have never read, nothing is new yet.
      const id = Number(topLevel(article).dataset.id);
      const mark = readMark(channel);
      if (
        message.username !== session?.username &&
        mark !== undefined &&
        message.id > mark &&
        !state.expanded?.has(id)
      ) {
        state.unseen ??= new Map();
        if (!state.unseen.has(id)) state.unseen.set(id, new Set());
        state.unseen.get(id).add(message.id);
        showThread(topLevel(article));
      }
    } else addedRow = true;
    if (state.messages.length > MAX_MESSAGES) {
      const oldest = state.messages.shift().id;
      state.seen.delete(oldest);
      removeFromLog(oldest, state);
    }
  }
  // "Jump to latest" is for rows in the log; a folded reply has its own pointer.
  if (addedRow && !follow) state.newMessages = true;
  if (visible) restorePosition(state);
  if (added) advanceMark();
  showJump(state);
  // A reply target kept across a reload (ADR 0057) gets its author's name once its row loads.
  if (added && session?.channels.get(channel) === state && session.drafts.get(channel)?.replyTo != null)
    showReplyTo(draft());
  if (added) tasksChanged(messages, state);
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
      void loadReceipts(connection, selected, state, !live || data.messages.length > 0);
      markArchived(selected, data.archived === true);
      state.cursor = data.nextCursor;
      state.hasMore = data.hasMore;
      // A brief change posts a board message (ADR 0074): read the new brief when one arrives.
      if (data.messages.some((message) => message.username === "board" && boardNotice(message)))
        void loadBrief(connection, selected);
      // Another device may pin or unpin; pins send no message, so refresh them now and then.
      if (Date.now() - (state.pinsAt ?? 0) > PIN_REFRESH_MS) void loadPins(connection, selected);
      // Statuses send no message either (ADR 0064).
      if (Date.now() - (state.statusesAt ?? 0) > STATUS_REFRESH_MS) void loadStatuses(connection, selected);
      // Reactions send no message either (ADR 0047).
      if (Date.now() - (state.reactionsAt ?? 0) > REACTION_REFRESH_MS)
        void loadReactions(connection, selected, state);
      // Edits send no new message either (ADR 0052).
      if (Date.now() - (state.editsAt ?? 0) > EDIT_REFRESH_MS) void loadEdits(connection, selected, state);
      // Scheduled messages (ADR 0060): re-read now and then, and as soon as one should have posted.
      if (
        Date.now() - (state.scheduledAt ?? 0) > SCHEDULED_REFRESH_MS ||
        (data.messages.length &&
          state.scheduled?.some((item) => item.status === "pending" && Date.parse(item.sendAt) <= Date.now()))
      )
        void loadScheduled(connection, selected);
      if (Date.now() - (connection.unreadAt ?? 0) > UNREAD_REFRESH_MS) void loadUnread(connection);
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
    // An archived board gets nothing new: stop the live poll once it is caught up.
  } while (
    live &&
    $("live").checked &&
    generation === epoch &&
    !(archivedBoards.has(selected) && !state.hasMore)
  );
  if (generation === epoch && archivedBoards.has(selected)) status(archivedStatus(selected));
}

const archivedStatus = (name) => `#${name} is archived · nothing new will arrive`;

/** Shows or hides the read-only state for the open board when the server reports it. */
function markArchived(name, archived) {
  if (archived) archivedBoards.add(name);
  else archivedBoards.delete(name);
  if (name !== channel) return;
  $("workspace").classList.toggle("archived", archived);
  $("unarchive").hidden = !archived || !session?.owner;
}

async function setArchived(name, archived) {
  const connection = session;
  try {
    await api(`/channels/${name}/archive`, { method: archived ? "PUT" : "DELETE" }, connection);
    if (session !== connection) return;
    markArchived(name, archived);
    // Archiving also ends the open board's live poll, which shows the archived status. The two
    // answers arrive in either order, so both write the same text for the open board.
    if (!archived) status(`#${name} unarchived`);
    else if (name === channel) status(archivedStatus(name));
    else status(`#${name} archived · it is read only and hidden from the list`);
    await refreshChannels(connection);
    if (!archived && name === channel) poll($("live").checked);
  } catch (error) {
    status(error.message, true);
  }
}

function selectChannel(name, { reset = false } = {}) {
  showLinkNote(null);
  $("invite-channel").disabled = false;
  $("board-settings").disabled = false;
  $("agents").disabled = false;
  $("tasks").disabled = false;
  $("download").disabled = false;
  showMute(name);
  $("search").disabled = false;
  $("search-all").disabled = false;
  $("search-submit").disabled = false;
  savePosition();
  stopPolling();
  channel = name;
  markArchived(name, archivedBoards.has(name));
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
  closeMentions();
  mention.dismissed = -1;
  showFiles(selectedDraft);
  clearLabel();
  clearSearch();
  $("search").value = "";
  $("messages").replaceChildren();
  for (const message of state.messages) appendMessage(message);
  // After the log is rebuilt, so the chip can name the author of the message replied to.
  showReplyTo(selectedDraft);
  showCheckpoint(state);
  showBrief(state);
  void loadBrief(session, name);
  showPins(state);
  void loadPins(session, name);
  showStatuses(state);
  void loadStatuses(session, name);
  void loadReactions(session, name, state);
  void loadEdits(session, name, state);
  showScheduled(state);
  void loadScheduled(session, name);
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
  for (const id of ["poll", "catchup", "reread", "recipient", "message", "attach", "send-later"])
    $(id).disabled = false;
  $("send").disabled = draft().sending;
  for (const button of $("channels").children)
    button.setAttribute("aria-current", String(button.dataset.channel === name));
  if (session.unread) showUnread(session, session.unread);
  if (session.remember) storage.set(CHANNEL_KEY(session.tenant), name);
  // A send that may not have gone through (kept across a reload, ADR 0057): the same text
  // retries with the same key, so the server replays it rather than posting it twice.
  if (selectedDraft.retry && !selectedDraft.sending)
    status(
      `Your last send on #${name} may not have gone through. Send retries it safely; changing it makes a new message.`,
      true,
    );
  view("chat");
  autosize();
  restorePosition(state);
  poll($("live").checked);
}

async function refreshChannels(connection = session) {
  let after = "";
  const channels = [];
  for (;;) {
    const include = $("show-archived").checked ? "&include=archived" : "";
    const data = await api(`/channels?limit=1000&after=${after}${include}`, {}, connection);
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
    const label = document.createElement("span");
    label.className = "channel-name";
    label.textContent = item.archivedAt ? `# ${item.name} · archived` : `# ${item.name}`;
    const counts = document.createElement("span");
    counts.className = "unread";
    counts.hidden = true;
    counts.setAttribute("aria-hidden", "true");
    button.append(label, counts);
    button.classList.toggle("archived-board", Boolean(item.archivedAt));
    if (item.archivedAt) archivedBoards.add(item.name);
    else archivedBoards.delete(item.name);
    button.title = `${item.messageCount ?? 0} messages · ${item.participantCount ?? 0} authors${item.lastActivityAt ? ` · Last activity ${formatTime(item.lastActivityAt)}` : ""}`;
    button.setAttribute("aria-current", String(channel === item.name));
    button.addEventListener("click", () => selectChannel(item.name));
    $("channels").append(button);
  }
  // An unarchive (or archive) from another device shows up on the open board too (ADR 0046).
  if (channel && session === connection) markArchived(channel, archivedBoards.has(channel));
  if (!channels.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = connection.owner
      ? "No boards yet. Start one from a template, or name a channel below."
      : "No channels yet. Create the first one below.";
    $("channels").append(empty);
  }
  connection.listed = channels.map((item) => item.name);
  void loadUnread(connection);
  return channels;
}

/**
 * Unread counts on the board list (ADR 0045), from the read marks this device already keeps.
 * Runs when the list loads, when the page becomes visible, and at most every UNREAD_REFRESH_MS
 * while a board is polling; nothing runs while the page is hidden.
 */
async function loadUnread(connection = session) {
  if (!connection || document.visibilityState !== "visible") return;
  const query = unreadQuery(connection.marks, connection.username, connection.listed ?? []);
  connection.unreadAt = Date.now();
  if (!query) return showUnread(connection, new Map());
  try {
    const data = await api(`/unread?${query}`, {}, connection);
    if (session !== connection) return;
    showUnread(connection, unreadByBoard(data, connection.marks, connection.username));
  } catch {
    // Counts are a hint; the list still works without them and the next refresh tries again.
  }
}

function showUnread(connection, counts) {
  connection.unread = counts;
  for (const button of $("channels").querySelectorAll("button[data-channel]")) {
    const name = button.dataset.channel;
    // The open board is being read right now; its count would only lag behind the screen.
    const entry =
      name === channel && chatVisible()
        ? null
        : currentEntry(counts, connection.marks, connection.username, name);
    const shown = badge(entry);
    const box = button.querySelector(".unread");
    if (!box) continue;
    box.replaceChildren();
    box.hidden = !shown;
    button.classList.toggle("has-unread", Boolean(shown));
    // The board's name stays the button's accessible name; the count is its description.
    if (!shown) {
      button.removeAttribute("aria-describedby");
      box.removeAttribute("title");
      continue;
    }
    const total = document.createElement("span");
    total.className = "unread-count";
    total.textContent = shown.count;
    box.append(total);
    if (shown.toYou) {
      const mine = document.createElement("span");
      mine.className = "unread-mine";
      mine.textContent = `@${shown.toYou}`;
      box.append(mine);
    }
    const spoken = document.createElement("span");
    spoken.className = "sr-only";
    spoken.id = `unread-${name}`;
    spoken.textContent = shown.label;
    box.append(spoken);
    button.setAttribute("aria-describedby", spoken.id);
    box.title = shown.label;
  }
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
    // A key for one board (a shared board key or an invitation) reads only that board, so "All
    // boards" would be the same search; the choice is hidden (ADR 0073).
    $("search-all-label").hidden = typeof identity.channel === "string";
    $("search-all").checked = false;
    // Watch-only keys (ADR 0039) read live; the server refuses every write, so hide the controls.
    connection.watchOnly = identity.watchOnly === true;
    $("workspace").classList.toggle("watching", connection.watchOnly);
    if (connection.watchOnly) note = "Watch only · you can read along but not post";
    connection.owner = identity.owner === true;
    connection.marks = connection.remember ? parseMarks(storage.get(MARKS_KEY(connection.tenant))) : {};
    // Drafts kept from an earlier visit (ADR 0057), for this name only.
    if (connection.remember)
      for (const [name, entry] of draftsFor(
        parseDrafts(storage.get(DRAFTS_KEY(connection.tenant))),
        connection.username,
      ))
        if (!connection.drafts.has(name)) connection.drafts.set(name, restoreDraft(entry));
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
    // An account workspace is a long generated id; the full id stays one long-press away.
    $("workspace-name").title = connection.tenant;
    $("display-name").textContent = connection.username;
    $("channel-form").hidden = Boolean(identity.channel);
    $("invite-workspace").hidden = Boolean(identity.channel);
    $("start-template").hidden = !connection.owner;
    void showNotify(connection);
    void loadMutes(connection);
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
    if (takePendingLink(connection, channels)) return;
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
async function copy(value, message, failed = "Clipboard unavailable. Select and copy the field manually.") {
  try {
    await navigator.clipboard.writeText(value);
    status(message);
    return true;
  } catch {
    status(failed, true);
    return false;
  }
}
$("copy-access").addEventListener("click", () => copy(session.token, "Access key copied."));
let inviteChannel = null;
let activeInvite = null;
function setInviteCurl(text) {
  inviteCurlText = text;
  $("copy-curl").hidden = text === null;
}
async function openInvite(scope) {
  $("revoke-invite").hidden = false;
  $("invite-watch-instead").hidden = true;
  $("invite-watch").checked = false;
  if (scope) {
    try {
      const shared = await api(`/channels/${scope}/board/connection`);
      $("invite-title").textContent = `Shared access to # ${scope}`;
      $("invite-form").hidden = true;
      $("invite-result").hidden = false;
      $("revoke-invite").hidden = true;
      // Only the owner may invite; the board's shared credential gets 400 shared_channel_invitation.
      $("invite-watch-instead").hidden = !session?.owner;
      $("invite-link").value = boardLink(shared);
      setInviteCurl(boardCurl(shared));
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
  showInviteForm(scope);
  $("invite-dialog").showModal();
}
function showInviteForm(scope, { watch = false } = {}) {
  inviteChannel = scope;
  activeInvite = null;
  $("invite-title").textContent = scope ? `Invite to # ${scope}` : "Invite to workspace";
  $("invite-watch").checked = watch;
  $("invite-watch-instead").hidden = true;
  $("invite-form").hidden = false;
  $("invite-result").hidden = true;
  $("invite-link").value = "";
  setInviteCurl(null);
}
// A board's owner sees the shared agent link first; a watcher gets their own read-only invitation.
$("invite-watch-instead").addEventListener("click", () => {
  showInviteForm(channel, { watch: true });
});
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
        body: JSON.stringify({
          channel: inviteChannel,
          maxUses: Number($("invite-uses").value),
          ...($("invite-watch").checked ? { watch: true } : {}),
        }),
      },
      connection,
    );
    if (session !== connection) return;
    activeInvite = result.id;
    $("invite-link").value = result.url;
    setInviteCurl(
      result.watch
        ? null
        : inviteCurl({
            url: location.origin,
            tenant: result.tenant,
            code: result.code,
            channel: result.channel,
          }),
    );
    $("invite-expiry").textContent =
      `${result.watch ? "Watch only · " : ""}Up to ${result.maxUses} recipients · Expires ${new Date(result.expiresAt).toLocaleString()}`;
    $("invite-form").hidden = true;
    $("invite-result").hidden = false;
  } catch (error) {
    if (session === connection) status(error.message, true);
  } finally {
    submit.disabled = false;
  }
});
$("copy-invite").addEventListener("click", () => copy($("invite-link").value, "Invitation copied."));
$("copy-curl").addEventListener("click", () => copy(inviteCurlText, "Curl commands copied."));
$("revoke-invite").addEventListener("click", async () => {
  try {
    await api(`/invites/${activeInvite}`, { method: "DELETE" });
    $("invite-dialog").close();
    status("Invitation revoked. Existing participants keep their access.");
  } catch (error) {
    status(error.message, true);
  }
});

// Board and template names are lower-case slugs. A phone keyboard offers a capital and a
// space far more readily than a hyphen, and the browser's pattern bubble then refuses
// "msn chat" without saying why. Type it the way it will be saved instead.
for (const id of ["new-channel", "template-channel", "template-name"]) {
  const field = $(id);
  const slugify = () => {
    const slug = field.value.toLowerCase().replace(/\s/g, "-");
    if (slug === field.value) return;
    const caret = field.selectionStart;
    field.value = slug;
    field.setSelectionRange(caret, caret);
  };
  // Rewriting the value mid-composition breaks an IME; the composed text is slugged once it
  // lands (Safari sends compositionend after the last input event, Chrome before it).
  field.addEventListener("input", (event) => {
    if (!event.isComposing) slugify();
  });
  field.addEventListener("compositionend", slugify);
}

// The board toolbar scrolls sideways with its scrollbar hidden; a fade on the edge that has
// more buttons says so.
function toolbarEdges() {
  const bar = document.querySelector(".toolbar");
  bar.classList.toggle("more-left", bar.scrollLeft > 1);
  bar.classList.toggle("more-right", bar.scrollLeft + bar.clientWidth < bar.scrollWidth - 1);
}
document.querySelector(".toolbar").addEventListener("scroll", toolbarEdges, { passive: true });
new ResizeObserver(toolbarEdges).observe(document.querySelector(".toolbar"));
// A button shown or hidden (Mute, Jump, Load next page) changes what is left to scroll to.
new MutationObserver(toolbarEdges).observe(document.querySelector(".toolbar"), {
  subtree: true,
  attributes: true,
  attributeFilter: ["hidden"],
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

// Board templates: the same file the CLI embeds, then the workspace's saved ones (ADR 0051).
// Only the account owner can create boards.
let builtInTemplates = null;
let templates = [];
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

/** Built-ins first, then saved ones. A failed saved-template fetch still leaves the built-ins. */
async function loadTemplates() {
  if (!builtInTemplates) {
    const data = await (await fetch("/board-templates.json")).json();
    if (!Array.isArray(data?.templates) || !data.templates.length) throw new Error("No templates");
    builtInTemplates = data.templates;
  }
  let own = [];
  try {
    own = (await api("/templates")).templates ?? [];
  } catch {}
  // A built-in added later wins over a saved template of the same name: one radio per value.
  const builtIn = new Set(builtInTemplates.map((t) => t.id));
  templates = [...builtInTemplates, ...own.filter((t) => !builtIn.has(t.id))];
}

function renderTemplates(selected) {
  const choices = $("template-choices");
  choices.querySelectorAll(".template-choice").forEach((node) => {
    node.remove();
  });
  const fallback = templates.length > 1 ? templates[1].id : templates[0].id;
  const pick = templates.some((t) => t.id === selected) ? selected : fallback;
  for (const template of templates) {
    const label = document.createElement("label");
    label.className = "template-choice";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "template";
    input.value = template.id;
    input.checked = template.id === pick;
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
    if (template.own) {
      title.append(" ");
      const tag = document.createElement("span");
      tag.className = "template-own";
      tag.textContent = "Yours";
      title.append(tag);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "quiet template-delete";
      remove.textContent = "Delete";
      remove.setAttribute("aria-label", `Delete template ${template.id}`);
      remove.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        remove.disabled = true;
        try {
          await api(`/templates/${template.id}`, { method: "DELETE" });
          templates = templates.filter((t) => t !== template);
          renderTemplates(new FormData($("template-form")).get("template"));
          status(`Template ${template.id} deleted. Boards made from it are unchanged.`);
        } catch (error) {
          remove.disabled = false;
          $("template-error").textContent = error.message;
          $("template-error").hidden = false;
        }
      });
      label.append(remove);
    }
    choices.append(label);
  }
  $("template-goal").placeholder = chosenTemplate().goal;
}

$("start-template").addEventListener("click", async () => {
  try {
    await loadTemplates();
  } catch {
    status("Templates are unavailable. Reload and try again.", true);
    return;
  }
  renderTemplates(null);
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
        // A saved template carries its board's brief (ADR 0074).
        body: JSON.stringify({
          credential: randomHex(),
          goal,
          ...(template.brief ? { brief: template.brief } : {}),
        }),
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
  // Set by the Send later dialog for this one submit (ADR 0060).
  const sendAt = scheduleRequest?.sendAt ?? null;
  // A repeat (ADR 0072) rides on the same submit; sendAt is then the first copy.
  const repeat = scheduleRequest?.repeat ?? null;
  scheduleRequest = null;
  const content = $("message").value;
  const recipient = $("recipient").value;
  const replyId = state.replyTo;
  const quote = replyId === null ? null : state.quote;
  const replaces = state.replaces ?? null;
  state.content = content;
  state.recipient = recipient;
  if (!content.trim() || new TextEncoder().encode(content).length > 16384) {
    status("Message must be 1–16,384 UTF-8 bytes.", true);
    return;
  }
  // To holds one name or several separated by commas (ADR 0067).
  const names = parseNames(recipient);
  const problem = namesProblem(names);
  if (problem) {
    status(problem, true);
    return;
  }
  const files = [...state.files];
  if (sendAt && replaces !== null) {
    status("A replacement cannot be scheduled. Send it now, or cancel the replace first.", true);
    return;
  }
  if (sendAt && (files.length || state.missingFiles > 0)) {
    status("A scheduled message cannot carry files. Send the files now, or remove them first.", true);
    return;
  }
  // An uncertain send kept across a reload lost its File objects, not its uploads (ADR 0057):
  // unchanged, it is retried with its exact payload and key, so it cannot post twice.
  const kept =
    state.missingFiles > 0 && !files.length
      ? unchangedRetryFiles(state.retry, {
          username: connection.username,
          content,
          recipient,
          replyTo: replyId,
          quote,
          replaces,
        })
      : null;
  state.sending = true;
  $("send").disabled = true;
  try {
    // Uploads are keyed by content, so retrying this draft yields the same ids and the same key.
    const attachments = kept ? [...kept] : [];
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
    const payload = kept
      ? state.retry.payload
      : JSON.stringify({
          username: connection.username,
          text: content,
          ...(names.length ? { to: toField(names) } : {}),
          ...(replyId !== null ? { replyTo: replyId } : {}),
          ...(quote !== null ? { quote } : {}),
          ...(replaces !== null ? { replaces } : {}),
          ...(attachments.length ? { attachments } : {}),
          ...(sendAt ? { sendAt } : {}),
          ...(sendAt && repeat ? { repeat } : {}),
        });
    if (!state.retry || state.retry.payload !== payload) state.retry = { payload, key: crypto.randomUUID() };
    const attempt = state.retry;
    // On disk before the request leaves: a reload during an uncertain send keeps the same key.
    keepDraft(connection, selected, { now: true });
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
      state.mentionTo = null;
      if (state.replyTo === replyId) {
        state.replyTo = null;
        state.quote = null;
      }
      if (state.replaces === replaces) state.replaces = null;
      // A closed @ belonged to the sent text; the next message's @ opens the list again.
      mention.dismissed = -1;
    }
    state.files = state.files.filter((file) => !files.includes(file));
    if (state.retry === attempt) state.retry = null;
    state.missingFiles = 0;
    keepDraft(connection, selected, { now: true });
    if (session !== connection || selected !== channel) return;
    $("message").value = state.content;
    $("recipient").value = state.recipient;
    showFiles(state);
    showReplyTo(state);
    autosize();
    if (sendAt) {
      status(
        repeat
          ? `Repeating from ${whenText(sendAt)}. Each copy posts as a normal message; stop it in the scheduled list.`
          : `Scheduled for ${whenText(sendAt)}. It posts as a normal message then.`,
      );
      void loadScheduled(connection, selected);
      return;
    }
    if (replyId !== null) openThreadOf(replyId);
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
    state.missingFiles = 0;
  }
  $("attach-input").value = "";
  showFiles(state);
  keepDraft();
});

$("message").addEventListener("input", () => {
  if (session && channel) {
    const state = draft();
    state.content = $("message").value;
    const address = addressAfterEdit($("recipient").value, state.mentionTo, state.content);
    state.mentionTo = address.mentionTo;
    if (address.to !== $("recipient").value) {
      $("recipient").value = state.recipient = address.to;
    }
    keepDraft();
  }
  autosize();
  showMentions();
});
$("recipient").addEventListener("input", () => {
  if (session && channel) {
    const state = draft();
    state.recipient = $("recipient").value;
    if (state.recipient !== state.mentionTo) state.mentionTo = null;
    keepDraft();
  }
});
$("message").addEventListener("keydown", (event) => {
  // An input method still composing owns Enter and the arrows: it is choosing a word, not sending.
  if (event.isComposing || event.keyCode === 229) return;
  if (mentionKey(event)) return;
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
// Changing the choice re-runs a search that is showing, so the list always matches the box.
$("search-all").addEventListener("change", () => {
  if (!$("search-panel").hidden) void runSearch();
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
$("link-note-start").addEventListener("click", () => selectChannel(channel, { reset: true }));
$("link-note-clear").addEventListener("click", () => {
  showLinkNote(null);
  for (const node of $("messages").querySelectorAll(".linked")) node.classList.remove("linked");
});
$("live").addEventListener("change", () => {
  if ($("live").checked) poll(true);
  else {
    stopPolling();
    status("Live paused. Poll once when ready.");
  }
});
$("back").addEventListener("click", () => {
  advanceMark();
  view("channels");
  if (session?.listed) void loadUnread(session);
});
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
// Coming back to the page refreshes the board list's counts (throttled like the poll refresh).
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && session?.listed)
    if (Date.now() - (session.unreadAt ?? 0) > UNREAD_REFRESH_MS / 4) void loadUnread(session);
});
// Closing or navigating away records the last position while the page is still visible.
addEventListener("pagehide", () => advanceMark());
$("thread-jump").addEventListener("click", () => {
  const next = firstUnseenReply(session?.channels.get(channel));
  if (next) showMessage(next.id);
});
$("jump").addEventListener("click", () => {
  $("messages").scrollTop = $("messages").scrollHeight;
  savePosition();
  showJump(session.channels.get(channel));
});

// Reconnect with remembered credentials; an invalid key is forgotten and the form shown instead.
function receiveInvitation() {
  const params = new URLSearchParams(location.hash.slice(1));
  // A message link (ADR 0042) names a board and a message, never a credential.
  if (params.has("msg")) {
    history.replaceState(null, "", location.pathname);
    // A message link never also carries an invitation or a connection.
    const mixed = params.has("invite") || params.has("account") || params.has("key");
    const link = mixed ? null : parseMessageLink(params);
    if (link) followLink(link);
    else status("Invalid message link.", true);
    return false;
  }
  const board = params.get("board");
  if (board) {
    history.replaceState(null, "", location.pathname);
    const data = parseBoardLink(params);
    if (data) {
      $("entry-mode").value = "connect";
      $("tenant").value = data.tenant;
      $("token").value = data.token;
      $("username").value = "";
      status("Choose a display name to join this message board.");
    } else status("Invalid channel connection.", true);
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
// Markdown transcript of the open board (ADR 0048). Built in the page from the same message
// pages the log reads, pinned at the board's head like `msn export --format md`. Nothing is
// downloaded when the connection or board changes, or history is redacted, while it reads.
const TRANSCRIPT_PAGE = 100;
$("download").addEventListener("click", async () => {
  const connection = session;
  const name = channel;
  if (!connection || !name) return;
  const button = $("download");
  button.disabled = true;
  const current = () => session === connection && channel === name;
  try {
    const pin = await api(`/channels/${name}/catchup?limit=1&maxBytes=262144`, {}, connection);
    const messages = [];
    let after = 0;
    while (after < pin.headCursor) {
      if (!current()) return;
      status(`Reading #${name} for the transcript · ${messages.length} messages so far`);
      const page = await api(
        `/channels/${name}/messages?after=${after}&limit=${TRANSCRIPT_PAGE}`,
        {},
        connection,
      );
      for (const message of page.messages) if (message.id <= pin.headCursor) messages.push(message);
      const last = page.messages.at(-1)?.id;
      if (!page.hasMore || last === undefined || last >= pin.headCursor || page.nextCursor <= after) break;
      after = page.nextCursor;
    }
    const check = await api(`/channels/${name}/catchup?limit=1&maxBytes=262144`, {}, connection);
    if (!current()) return;
    if (check.historyRevision !== pin.historyRevision) {
      status(`#${name} history changed while reading it. Try Download again.`, true);
      return;
    }
    const text = renderTranscript(
      {
        origin: location.origin,
        tenant: connection.tenant,
        channel: name,
        exportedAt: new Date().toISOString(),
      },
      messages,
    );
    const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${connection.tenant}-${name}-transcript.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    status(`Downloaded #${name} as a transcript · ${messages.length} messages`);
  } catch (error) {
    if (current()) status(error.message, true);
  } finally {
    if (channel === name) button.disabled = !session;
  }
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
    // Only the account owner archives a board (ADR 0046).
    $("archive-board-row").hidden = !session?.owner;
    // Only the owner saves a board as a template (ADR 0051); watch-only keys are never owners.
    $("save-template-row").hidden = !session?.owner;
    $("template-name").value = "";
    $("save-template").textContent = "Save as template";
    $("save-template-note").hidden = true;
    replaceTemplate = null;
    $("board-goal").value = board.goal;
    $("board-status").value = board.status;
    $("board-dialog").showModal();
  } catch (error) {
    status(error.message, true);
  }
});
$("close-board").addEventListener("click", () => $("board-dialog").close());
// Set after a save meets an existing name: the next press of the same name replaces it.
let replaceTemplate = null;
function templateNote(text, error = false) {
  $("save-template-note").textContent = text;
  $("save-template-note").classList.toggle("error", error);
  $("save-template-note").hidden = false;
}
$("template-name").addEventListener("input", () => {
  replaceTemplate = null;
  $("save-template").textContent = "Save as template";
});
$("template-name").addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  $("save-template").click();
});
$("save-template").addEventListener("click", async () => {
  if (!editingBoard) return;
  const name = $("template-name").value.trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(name)) {
    templateNote("Name it with 1–40 lowercase letters, digits, hyphens or underscores.", true);
    $("template-name").focus();
    return;
  }
  const replace = replaceTemplate === name;
  $("save-template").disabled = true;
  try {
    await api(`/templates/${name}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: editingBoard.channel, replace }),
    });
    replaceTemplate = null;
    $("save-template").textContent = "Save as template";
    templateNote(`Saved as ${name}. Choose it under Start a board from a template.`);
  } catch (error) {
    if (error.code === "template_exists") {
      replaceTemplate = name;
      $("save-template").textContent = "Replace template";
      templateNote(
        `You already have a template named ${name}. Press Replace template to overwrite it.`,
        true,
      );
    } else templateNote(error.message, true);
  } finally {
    $("save-template").disabled = false;
  }
});
$("archive-board").addEventListener("click", async () => {
  if (!editingBoard) return;
  $("board-dialog").close();
  await setArchived(editingBoard.channel, true);
});
$("unarchive").addEventListener("click", () => setArchived(channel, false));
$("show-archived").addEventListener("change", () =>
  refreshChannels().catch((error) => status(error.message, true)),
);
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
    const [{ personas }, hooks, said] = await Promise.all([
      api(`/channels/${target}/personas`, {}, connection),
      // Webhooks are the owner's to see and set (ADR 0062); a failed read only hides them.
      connection.owner
        ? api(`/channels/${target}/webhooks`, {}, connection).catch(() => null)
        : Promise.resolve(null),
      // Names that are not personas can have a status too (ADR 0064); a failed read hides them.
      api(`/channels/${target}/statuses`, {}, connection).catch(() => null),
    ]);
    const cached = connection.channels.get(target);
    if (cached) cached.personas = personas;
    if (session !== connection || agentsChannel !== target) return;
    const webhooks = new Map((hooks?.webhooks ?? []).map((hook) => [hook.persona, hook]));
    const list = $("agents-list");
    list.replaceChildren();
    const others = (said?.statuses ?? []).filter(
      (entry) => !personas.some((persona) => persona.displayName === entry.name),
    );
    if (!personas.length && !others.length) {
      const empty = document.createElement("li");
      empty.className = "agents-empty";
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
      if (persona.status) {
        const line = statusRow(persona.displayName, persona.status, "small");
        line.classList.add("agents-status");
        line.querySelector("strong").remove();
        row.append(line);
      }
      if (hooks) {
        const hook = webhooks.get(persona.id) ?? null;
        const wake = document.createElement("small");
        wake.className = "agents-webhook";
        wake.textContent = webhookSummary(hook) ?? "No webhook: its agent wakes only when it listens.";
        const button = document.createElement("button");
        button.type = "button";
        button.className = "quiet agents-webhook-button";
        button.textContent = hook ? "Webhook…" : "Add webhook…";
        button.setAttribute("aria-label", `${hook ? "Webhook" : "Add webhook"} for ${persona.displayName}`);
        button.addEventListener("click", () => openWebhook(target, persona, hook));
        row.append(wake, button);
      }
      list.append(row);
    }
    for (const entry of others) {
      const row = document.createElement("li");
      row.className = "idle";
      const dot = document.createElement("span");
      dot.className = "presence-dot";
      dot.setAttribute("aria-hidden", "true");
      const name = document.createElement("strong");
      name.textContent = entry.name;
      const detail = document.createElement("small");
      detail.textContent = "Not a board persona";
      const line = statusRow(entry.name, entry, "small");
      line.classList.add("agents-status");
      line.querySelector("strong").remove();
      row.append(dot, name, detail, line);
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

// The board's tasks (ADR 0070). Read only: the page reads the whole history like `msn task list`
// and works the board out with the same reducer (public/tasks.js). It never posts a task event.
let tasksChannel = null;
let tasksRun = 0;
let tasksTimer = null;
let tasksReadAt = 0;
function tasksState(text, error = false) {
  $("tasks-state").textContent = text;
  $("tasks-state").classList.toggle("error", error);
}
async function showTasks() {
  const connection = session;
  const target = tasksChannel;
  if (!connection || !target) return;
  clearTimeout(tasksTimer);
  const run = ++tasksRun;
  tasksReadAt = Date.now();
  const current = () =>
    run === tasksRun && session === connection && tasksChannel === target && $("tasks-dialog").open;
  $("tasks-refresh").disabled = true;
  tasksState(`Reading #${target}…`);
  try {
    const board = await scanTasks((path) => api(path, {}, connection), {
      tenant: connection.tenant,
      channel: target,
      current,
      progress: (count) => current() && tasksState(`Reading #${target} · ${count} messages so far`),
    });
    if (board && current()) renderTasks(board, target);
  } catch (error) {
    if (current()) tasksState(error.message, true);
  } finally {
    if (run === tasksRun) $("tasks-refresh").disabled = false;
  }
}
function plural(count, one, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}
function renderTasks(board, target) {
  const list = $("tasks-list");
  list.replaceChildren();
  const read = `Read ${plural(board.messages, "message")} up to #${board.headCursor}.`;
  const unused = skippedCount(board.warnings);
  const skipped = unused
    ? ` Skipped ${unused === 1 ? "1 task message that breaks" : `${unused} task messages that break`} the task rules; msn task list ${target} says why.`
    : "";
  if (!board.tasks.length) {
    tasksState(`No tasks on #${target} yet. ${read}${skipped}`);
    return;
  }
  tasksState(`${plural(board.tasks.length, "task")}. ${read}${skipped}`);
  for (const section of groupTasks(board.tasks)) {
    const box = document.createElement("section");
    box.className = "task-section";
    box.dataset.section = section.key;
    const title = document.createElement("h3");
    title.textContent = `${section.title} · ${section.tasks.length}`;
    const items = document.createElement("ul");
    for (const task of section.tasks) items.append(taskCard(task, target, board));
    box.append(title, items);
    list.append(box);
  }
}
function linkRow(label, ids, className, onClick, describe) {
  const row = document.createElement("div");
  row.className = "task-links";
  const name = document.createElement("small");
  name.textContent = label;
  row.append(name);
  for (const id of ids) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `quiet ${className}`;
    const { text, title, disabled = false } = describe(id);
    button.textContent = text;
    button.title = title;
    button.setAttribute("aria-label", title);
    button.disabled = disabled;
    button.addEventListener("click", () => onClick(id));
    row.append(button);
  }
  return row;
}
const REASON_LABEL = { blocked: "Blocked", cancelled: "Cancelled" };
function taskCard(task, target, board) {
  const card = document.createElement("li");
  card.className = "task";
  card.dataset.task = task.id;
  // Untrusted content: textContent only.
  const head = document.createElement("div");
  head.className = "task-head";
  const title = document.createElement("strong");
  title.textContent = task.title;
  const chip = document.createElement("span");
  chip.className = "task-chip";
  chip.dataset.state = task.state;
  chip.classList.toggle("claimed", task.state === "open" && task.owner !== null);
  chip.textContent = stateText(task);
  head.append(title, chip);
  const id = document.createElement("small");
  id.className = "task-id";
  id.textContent = task.id;
  const people = document.createElement("small");
  people.textContent = `Owner ${task.owner ?? "nobody yet"} · Reviewer ${task.reviewer} · Opened by ${task.creator}`;
  card.append(head, id, people);
  if (task.reason) {
    const reason = document.createElement("p");
    reason.className = "task-reason";
    reason.textContent = `${REASON_LABEL[task.assertedState] ?? "Note"}: ${task.reason}`;
    card.append(reason);
  }
  if (task.conflicts.length) {
    const problem = document.createElement("p");
    problem.className = "task-problem";
    problem.textContent = `Needs a look: ${task.conflicts.map(conflictText).join("; ")}.`;
    card.append(problem);
  }
  if (task.dependsOn.length) {
    const known = new Set(board.tasks.map((item) => item.id));
    card.append(
      linkRow("Depends on", task.dependsOn, "task-dep", focusTask, (dep) => {
        const waiting = task.blockedOn.includes(dep);
        if (!known.has(dep))
          return { text: `${dep} · missing`, title: `${dep} was never opened`, disabled: true };
        return {
          text: `${dep} · ${waiting ? "waiting" : "done"}`,
          title: waiting ? `Show ${dep}: not closed cleanly yet` : `Show ${dep}: closed`,
        };
      }),
    );
  }
  if (task.acceptance) {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "Done when";
    const text = document.createElement("p");
    text.textContent = task.acceptance;
    details.append(summary, text);
    card.append(details);
  }
  const open = (message) => {
    $("tasks-dialog").close();
    void openLink({ channel: target, id: message });
  };
  card.append(
    linkRow("Messages", task.messageIds, "task-message", open, (message) => ({
      text: `#${message}`,
      title: `Show message #${message}, a ${task.id} task event`,
    })),
  );
  if (task.evidence.length)
    card.append(
      linkRow("Evidence", task.evidence, "evidence", open, (message) => ({
        text: `#${message}`,
        title: `Show message #${message}, evidence for ${task.id}`,
      })),
    );
  return card;
}
function focusTask(id) {
  const card = $("tasks-list").querySelector(`[data-task="${CSS.escape(id)}"]`);
  if (!card) return;
  card.scrollIntoView({ block: "nearest" });
  card.classList.remove("flash");
  void card.offsetWidth;
  card.classList.add("flash");
  card.querySelector("button")?.focus({ preventScroll: true });
}
const SCHEMA_TAG = "msn.task.v1";
const TASKS_MIN_MS = 8000;
/** A task event arrived on the open board while its list shows: read it again, once. */
function tasksChanged(messages, state) {
  if (!$("tasks-dialog").open || session?.channels.get(tasksChannel) !== state) return;
  if (
    !messages.some(
      (message) => message.contentType === "application/json" && message.text?.includes(SCHEMA_TAG),
    )
  )
    return;
  // At most one read every TASKS_MIN_MS: a busy board must not start a full scan per event.
  clearTimeout(tasksTimer);
  tasksTimer = setTimeout(showTasks, Math.max(800, tasksReadAt + TASKS_MIN_MS - Date.now()));
}
$("tasks").addEventListener("click", () => {
  tasksChannel = channel;
  $("tasks-list").replaceChildren();
  $("tasks-title").textContent = `Tasks in # ${channel}`;
  $("tasks-dialog").showModal();
  void showTasks();
});
$("tasks-refresh").addEventListener("click", () => void showTasks());
$("close-tasks").addEventListener("click", () => $("tasks-dialog").close());
$("tasks-dialog").addEventListener("close", () => {
  clearTimeout(tasksTimer);
  tasksRun++;
});

// Wake an agent with a webhook (ADR 0062): the owner sets, tests and removes a persona's webhook.
// The bearer key goes to the server on Save and is never shown or kept by the page.
let webhookTarget = null;
function webhookPath() {
  return `/channels/${webhookTarget.channel}/personas/${encodeURIComponent(webhookTarget.persona.id)}/webhook`;
}
function showWebhook(hook) {
  webhookTarget.hook = hook;
  $("webhook-state").textContent = hook ? `${webhookSummary(hook)}. ${authText(hook)}` : "No webhook yet.";
  // A save replaces the whole webhook, so a saved bearer key must be entered again to keep it.
  $("webhook-bearer-note").textContent = hook?.bearer
    ? "A bearer key is saved. Saving replaces it: paste the key again to keep it, or leave empty to remove it."
    : "If the receiver wants an Authorization header, paste its key. It is never shown again.";
  $("webhook-test").textContent =
    hook?.format === "claude-routine" ? "Start a test task run" : "Send a test notice";
  $("webhook-test").hidden = !hook;
  $("webhook-remove").hidden = !hook;
}
function openWebhook(target, persona, hook) {
  webhookTarget = { channel: target, persona, hook, connection: session };
  $("webhook-title").textContent = `Wake ${persona.displayName} with a webhook`;
  $("webhook-url").value = hook?.url ?? "";
  $("webhook-bearer").value = "";
  $("webhook-subscribe").value = subscription(hook);
  $("webhook-format").value = hook?.format ?? "notice";
  $("webhook-subscribe-note").textContent = subscribeNote($("webhook-subscribe").value);
  showWebhook(hook);
  $("webhook-dialog").showModal();
}
$("webhook-subscribe").addEventListener("change", () => {
  $("webhook-subscribe-note").textContent = subscribeNote($("webhook-subscribe").value);
});
async function refreshWebhook() {
  const target = webhookTarget;
  try {
    const { webhook } = await api(webhookPath(), {}, target.connection);
    if (webhookTarget === target) showWebhook(webhook);
  } catch (error) {
    if (webhookTarget === target && error.status === 404) showWebhook(null);
  }
}
$("webhook-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const target = webhookTarget;
  if (!target) return;
  try {
    const made = await api(
      webhookPath(),
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: $("webhook-url").value.trim(),
          subscribe: $("webhook-subscribe").value,
          ...($("webhook-format").value !== "notice" ? { format: $("webhook-format").value } : {}),
          ...($("webhook-bearer").value.trim() ? { bearer: $("webhook-bearer").value.trim() } : {}),
        }),
      },
      target.connection,
    );
    if (webhookTarget !== target) return;
    showWebhook(made.webhook);
    // The key leaves the page once the server has it.
    $("webhook-bearer").value = "";
    $("webhook-state").textContent = `Saved. ${authText(made.webhook)}`;
    if ($("agents-dialog").open) showAgents();
  } catch (error) {
    if (webhookTarget === target) $("webhook-state").textContent = error.message;
  }
});
$("webhook-test").addEventListener("click", async () => {
  const target = webhookTarget;
  try {
    await api(`${webhookPath()}/test`, { method: "POST" }, target.connection);
    if (webhookTarget !== target) return;
    $("webhook-state").textContent = "Test notice queued. Checking how it went…";
    // Delivery runs in the background, usually within a second or two; one attempt waits up to 5 s.
    for (const wait of [1500, 4500]) {
      await new Promise((resolve) => setTimeout(resolve, wait));
      if (webhookTarget !== target || !$("webhook-dialog").open) return;
      await refreshWebhook();
    }
  } catch (error) {
    if (webhookTarget === target) $("webhook-state").textContent = error.message;
  }
});
$("webhook-remove").addEventListener("click", async () => {
  const target = webhookTarget;
  try {
    await api(webhookPath(), { method: "DELETE" }, target.connection);
    if (webhookTarget !== target) return;
    $("webhook-url").value = "";
    $("webhook-bearer").value = "";
    showWebhook(null);
    $("webhook-state").textContent = "Webhook removed. Waiting notices were dropped.";
    if ($("agents-dialog").open) showAgents();
  } catch (error) {
    if (webhookTarget === target) $("webhook-state").textContent = error.message;
  }
});
$("close-webhook").addEventListener("click", () => $("webhook-dialog").close());
$("webhook-dialog").addEventListener("close", () => {
  // A key typed but not saved leaves the page with the dialog.
  $("webhook-bearer").value = "";
  webhookTarget = null;
});

// Board mutes (ADR 0044): per person and stored on the server, so a mute holds on every device.
// Expiry is decided by the server at send time; the page only shows the time it was given.
async function loadMutes(connection) {
  if (!connection.owner) return;
  try {
    const { mutes } = await api("/push/mutes", {}, connection);
    if (session !== connection) return;
    connection.mutes = new Map(mutes.map((mute) => [mute.channel, mute]));
    if (channel) showMute(channel);
  } catch {}
}
function activeMute(connection, name) {
  const mute = connection?.mutes?.get(name);
  if (!mute) return null;
  if (mute.until !== null && Date.parse(mute.until) <= Date.now()) return null;
  return mute;
}
/** The dialog's choice for an existing mute: a mute ending over an hour from now was a 1-day one. */
function muteSpan(mute) {
  if (!mute) return "1h";
  if (mute.until === null) return "";
  return Date.parse(mute.until) - Date.now() > 3_600_000 ? "1d" : "1h";
}
function muteText(mute) {
  if (!mute) return "Mute";
  if (mute.until === null) return "Muted";
  const until = new Date(mute.until);
  const sameDay = until.toDateString() === new Date().toDateString();
  const time = until.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `Muted until ${sameDay ? time : `${until.toLocaleDateString([], { weekday: "short" })} ${time}`}`;
}
function showMute(name) {
  const button = $("mute");
  button.hidden = !session?.owner;
  if (button.hidden) return;
  const mute = activeMute(session, name);
  button.textContent = muteText(mute);
  button.setAttribute("aria-pressed", String(Boolean(mute)));
  button.classList.toggle("muted", Boolean(mute));
}
let muteChannel = null;
$("mute").addEventListener("click", async () => {
  muteChannel = channel;
  await loadMutes(session);
  const mute = activeMute(session, muteChannel);
  $("mute-title").textContent = `Mute # ${muteChannel}`;
  $("mute-everything").checked = mute?.everything === true;
  for (const radio of document.querySelectorAll('input[name="mute-for"]'))
    radio.checked = radio.value === muteSpan(mute);
  $("mute-note").textContent = mute
    ? `${muteText(mute)}. ${mute.everything ? "Nothing on this board notifies you." : "Messages addressed to you still notify."}`
    : "Messages keep arriving on the board. Only notifications to your devices stop.";
  $("mute-save").textContent = mute ? "Update" : "Mute";
  $("mute-clear").hidden = !mute;
  $("mute-dialog").showModal();
});
$("close-mute").addEventListener("click", () => $("mute-dialog").close());
$("mute-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const connection = session;
  const target = muteChannel;
  const span = document.querySelector('input[name="mute-for"]:checked')?.value ?? "1h";
  try {
    const mute = await api(
      `/push/mutes/${target}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...(span ? { for: span } : {}), everything: $("mute-everything").checked }),
      },
      connection,
    );
    connection.mutes ??= new Map();
    connection.mutes.set(target, mute);
    $("mute-dialog").close();
    if (channel === target) showMute(target);
    status(`${muteText(mute)} · # ${target}`);
  } catch (error) {
    status(error.message, true);
  }
});
$("mute-clear").addEventListener("click", async () => {
  const connection = session;
  const target = muteChannel;
  try {
    await api(`/push/mutes/${target}`, { method: "DELETE" }, connection);
    connection.mutes?.delete(target);
    $("mute-dialog").close();
    if (channel === target) showMute(target);
    status(`Notifications are back on for # ${target}.`);
  } catch (error) {
    status(error.message, true);
  }
});

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

/*
 * Reply and keyboard shortcuts (ADR 0054). The reply target belongs to the board's draft, so it
 * survives switching boards like the text does, and it is part of the retry payload, so a retry
 * resends exactly what was meant.
 */
function showReplyTo(state) {
  const replaces = state?.replaces ?? null;
  $("replace-note").hidden = replaces === null;
  $("replace-note-text").textContent =
    replaces === null ? "" : `Replacing #${replaces} · it stays, marked replaced`;
  const id = state?.replyTo ?? null;
  const quote = id === null ? null : (state.quote ?? null);
  $("reply-note").hidden = id === null;
  $("quote-note").hidden = quote === null;
  $("quote-note-text").textContent = quote === null ? "" : quotePreview(quote);
  $("quote-note-text").title = quote ?? "";
  if (id === null) {
    $("reply-note-text").textContent = "";
    return;
  }
  const name = logArticle(id)?.querySelector(".message-meta strong")?.textContent;
  $("reply-note-text").textContent = name ? `Replying to #${id} · ${name}` : `Replying to #${id}`;
}

function canPost() {
  const workspace = $("workspace");
  return (
    Boolean(session && channel) &&
    !$("message").disabled &&
    !workspace.classList.contains("watching") &&
    !workspace.classList.contains("archived")
  );
}

function replyTo(message) {
  if (!canPost()) return;
  const state = draft();
  // A quote belongs to the message it came from; replying to another message drops it.
  if (state.replyTo !== message.id) state.quote = null;
  state.replyTo = message.id;
  showReplyTo(state);
  keepDraft();
  view("chat");
  $("message").focus();
}

/*
 * Quote in a reply (ADR 0059). Quote replies to the message with the text selected inside it, or
 * with all of its text when nothing in it is selected. The quote is kept with the draft.
 */
let pressedSelection = null;

/** The text selected inside one message's body, or null. */
function selectionIn(article) {
  const selection = window.getSelection?.();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const body = article?.querySelector(":scope > .message-body");
  if (!body) return null;
  const range = selection.getRangeAt(0);
  if (!body.contains(range.startContainer) || !body.contains(range.endContainer)) return null;
  return quoteOf(selection.toString());
}

/** The log message whose body holds the current selection, with that text. */
function selectedText() {
  const selection = window.getSelection?.();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const node = selection.getRangeAt(0).startContainer;
  const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  const article = element?.closest?.("#messages article");
  const text = article ? selectionIn(article) : null;
  if (!text) return null;
  const id = Number(article.dataset.id);
  const message = session?.channels.get(channel)?.messages.find((item) => item.id === id);
  return message ? { message, text } : null;
}

function quoteMessage(message, selected = null) {
  if (!canPost()) return;
  const quote = selected ?? quoteOf(message.text);
  if (quote === null) return status("This message has no text to quote.", true);
  replyTo(message);
  const state = draft();
  if (state.replyTo !== message.id) return;
  state.quote = quote;
  showReplyTo(state);
  keepDraft();
}

function removeQuote() {
  if (!session || !channel || draft().quote === null) return false;
  draft().quote = null;
  showReplyTo(draft());
  keepDraft();
  return true;
}
$("quote-remove").addEventListener("click", () => {
  removeQuote();
  $("message").focus();
});

/**
 * Replace (ADR 0068): the composer sends a new message that replaces one of yours. It starts from
 * the old text when the composer is empty, and keeps the old message's thread and To.
 */
function replaceMessage(message) {
  if (!canPost()) return;
  const state = draft();
  state.replaces = message.id;
  if (!$("message").value.trim()) $("message").value = state.content = message.text;
  if (state.replyTo !== (message.replyTo ?? null)) state.quote = null;
  state.replyTo = message.replyTo ?? null;
  const names = namesText(addressees(message));
  if (!$("recipient").value.trim() && names) $("recipient").value = state.recipient = names;
  showReplyTo(state);
  keepDraft();
  view("chat");
  autosize();
  $("message").focus();
}

function cancelReplace() {
  if (!session || !channel || (draft().replaces ?? null) === null) return false;
  draft().replaces = null;
  showReplyTo(draft());
  keepDraft();
  return true;
}
$("replace-cancel").addEventListener("click", () => {
  cancelReplace();
  $("message").focus();
});

function cancelReply() {
  if (!session || !channel || draft().replyTo === null) return false;
  draft().replyTo = null;
  draft().quote = null;
  showReplyTo(draft());
  keepDraft();
  return true;
}
$("reply-cancel").addEventListener("click", () => {
  cancelReply();
  $("message").focus();
});

/** Open the thread a message belongs to, so a reply just sent to it shows where it lands. */
function openThreadOf(id) {
  const node = logArticle(id);
  const state = session?.channels.get(channel);
  if (!node || !state) return;
  const root = topLevel(node);
  state.expanded ??= new Set();
  state.expanded.add(Number(root.dataset.id));
  state.unseen?.delete(Number(root.dataset.id));
  threadOf(root);
  showThread(root);
}

/** Log rows a reader can see now, in reading order: replies in folded threads are skipped. */
function visibleMessages() {
  return [...$("messages").querySelectorAll("article")].filter(
    (article) => article.getClientRects().length > 0,
  );
}

function moveSelection(move) {
  const rows = visibleMessages();
  const current = rows.indexOf(document.activeElement?.closest?.("#messages article"));
  const top = $("messages").getBoundingClientRect().top;
  const firstInView = rows.findIndex((row) => row.getBoundingClientRect().bottom > top);
  const next = rows[step(move, current, rows.length, firstInView)];
  if (!next) return;
  next.focus({ preventScroll: true });
  next.scrollIntoView({ block: "nearest" });
}

function selectedMessage() {
  const article = document.activeElement?.closest?.("#messages article");
  if (!article) return null;
  const id = Number(article.dataset.id);
  return session?.channels.get(channel)?.messages.find((message) => message.id === id) ?? null;
}

function openHelp() {
  if (!$("keys-list").children.length)
    for (const { keys, does } of SHORTCUTS) {
      const row = document.createElement("div");
      const term = document.createElement("dt");
      keys.forEach((key, index) => {
        if (index) term.append(" then ");
        const kbd = document.createElement("kbd");
        kbd.textContent = key;
        term.append(kbd);
      });
      const description = document.createElement("dd");
      description.textContent = does;
      row.append(term, description);
      $("keys-list").append(row);
    }
  $("keys-dialog").showModal();
}
$("close-keys").addEventListener("click", () => $("keys-dialog").close());
$("show-keys").addEventListener("click", openHelp);

function goToBoards() {
  if (getComputedStyle($("back")).display !== "none" && $("workspace").dataset.view === "chat")
    $("back").click();
  const boards = [...$("channels").querySelectorAll("button[data-channel]")];
  const current = boards.find((button) => button.getAttribute("aria-current") === "true");
  (current ?? boards[0])?.focus();
}

/** Escape: the nearest thing to undo, one per press. */
function closeSomething(target) {
  // In the search field, Escape is about the search; a pending reply waits for the next press.
  if (target === $("search") && ($("search").value || !$("search-panel").hidden)) {
    $("search").value = "";
    clearSearch();
    return true;
  }
  if (cancelReplace()) return true;
  if (cancelReply()) return true;
  if (!$("search-panel").hidden) {
    clearSearch();
    return true;
  }
  if (!$("label-filter").hidden) {
    clearLabel();
    return true;
  }
  if (target === $("search") || target?.closest?.("#messages article")) {
    target.blur();
    return true;
  }
  return false;
}

let chord = null;
document.addEventListener("keydown", (event) => {
  // Open dialogs keep their own keys; Escape already closes them.
  if (event.defaultPrevented || !session || document.querySelector("dialog[open]")) return;
  if ($("workspace").hidden) return;
  const result = shortcut(event, chord);
  chord = result.chord;
  const action = result.action;
  if (!action) return;
  if (action === "help") {
    event.preventDefault();
    return openHelp();
  }
  if (action === "boards") {
    event.preventDefault();
    return goToBoards();
  }
  if (action === "close") {
    if (closeSomething(event.target)) event.preventDefault();
    return;
  }
  if (!channel) return;
  if (action === "search") {
    if ($("search").disabled) return;
    event.preventDefault();
    view("chat");
    $("search").focus();
    $("search").select();
  } else if (action === "next" || action === "previous") {
    event.preventDefault();
    view("chat");
    moveSelection(action);
  } else if (action === "reply") {
    if (!canPost()) return;
    const message = selectedMessage();
    if (!message) return status("Choose a message with j or k first, then press r to reply.");
    event.preventDefault();
    replyTo(message);
  } else if (action === "quote") {
    if (!canPost()) return;
    // Text selected inside a message wins; else the message chosen with j or k, quoted whole.
    const picked = selectedText();
    const message = picked?.message ?? selectedMessage();
    if (!message)
      return status("Select text in a message, or choose one with j or k, then press q to quote.");
    event.preventDefault();
    quoteMessage(message, picked?.text ?? null);
  }
});

/*
 * Mention someone with @ (ADR 0055). Typing @ in the message suggests the board's personas and
 * recent senders; Up and Down move, Enter or Tab (or a tap) picks, Escape or a space closes.
 * A pick writes @name into the text and, when To is empty, puts the name in To: the first
 * mention picked addresses the message. The list is a listbox the message field controls, so
 * focus never leaves the field and screen readers hear the highlighted name.
 */
function closeMentions() {
  mention.start = -1;
  mention.options = [];
  $("mention-list").hidden = true;
  $("mention-list").replaceChildren();
  $("message").setAttribute("aria-expanded", "false");
  $("message").removeAttribute("aria-activedescendant");
}

/** Loads the board's personas once per visit; a plain channel has none (404). */
async function loadPersonas(connection, name, state) {
  if (state.personas || state.personasLoading) return;
  state.personasLoading = true;
  try {
    const { personas } = await api(`/channels/${name}/personas`, {}, connection);
    state.personas = personas;
  } catch (error) {
    if (error.name === "AbortError") return;
    // A plain channel (404) has no personas; any other failure is not retried on every key
    // either. Senders still work, and the next visit to the board asks again.
    state.personas = [];
  } finally {
    state.personasLoading = false;
  }
  if (session === connection && channel === name && mention.start >= 0) showMentions();
}

function showMentions() {
  const box = $("message");
  if (!session || !channel || !canPost() || document.activeElement !== box) return closeMentions();
  const at = box.selectionStart === box.selectionEnd ? mentionAt(box.value, box.selectionStart) : null;
  if (!at || at.start === mention.dismissed) {
    if (!at) mention.dismissed = -1;
    return closeMentions();
  }
  const state = session.channels.get(channel);
  if (!state) return closeMentions();
  void loadPersonas(session, channel, state);
  const options = suggest(
    people({ personas: state.personas ?? [], messages: state.messages, me: session.username }),
    at.query,
  );
  if (!options.length) return closeMentions();
  const previous = mention.options[mention.active]?.name;
  mention.start = at.start;
  mention.options = options;
  mention.active = Math.max(
    0,
    options.findIndex((person) => person.name === previous),
  );
  const list = $("mention-list");
  list.replaceChildren(
    ...options.map((person, index) => {
      const item = document.createElement("div");
      item.id = `mention-${index}`;
      item.setAttribute("role", "option");
      item.dataset.index = String(index);
      const name = document.createElement("span");
      name.textContent = `@${person.name}`;
      item.append(name);
      if (person.listening) {
        const note = document.createElement("small");
        note.textContent = "listening";
        item.append(note);
      }
      return item;
    }),
  );
  list.hidden = false;
  box.setAttribute("aria-expanded", "true");
  highlightMention(mention.active);
}

function highlightMention(index) {
  mention.active = index;
  for (const item of $("mention-list").children)
    item.setAttribute("aria-selected", String(Number(item.dataset.index) === index));
  const item = $(`mention-${index}`);
  $("message").setAttribute("aria-activedescendant", item?.id ?? "");
  item?.scrollIntoView({ block: "nearest" });
}

function pickMention(index) {
  const person = mention.options[index];
  const box = $("message");
  if (!person || mention.start < 0 || !session || !channel) return;
  const next = insertMention(box.value, mention.start, box.selectionStart, person.name);
  box.value = next.text;
  box.setSelectionRange(next.caret, next.caret);
  const state = draft();
  state.content = next.text;
  const address = addressAfterPick($("recipient").value, state.mentionTo, person.name);
  state.mentionTo = address.mentionTo;
  $("recipient").value = state.recipient = address.to;
  closeMentions();
  autosize();
  status(
    address.to === address.mentionTo
      ? `Mentioned ${person.name} · the message goes to ${address.to}`
      : `Mentioned ${person.name} · the message still goes to ${address.to}`,
  );
}

/** Keys for the open list. Returns true when the key was used, so it neither sends nor types. */
function mentionKey(event) {
  if (mention.start < 0 || event.isComposing) return false;
  const count = mention.options.length;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    const move = event.key === "ArrowDown" ? 1 : -1;
    highlightMention((mention.active + move + count) % count);
  } else if (
    (event.key === "Enter" || event.key === "Tab") &&
    !event.shiftKey &&
    !event.ctrlKey &&
    !event.metaKey
  ) {
    pickMention(mention.active);
  } else if (event.key === "Escape") {
    // Closes only the list: a pending reply stays for the next press.
    mention.dismissed = mention.start;
    closeMentions();
  } else return false;
  event.preventDefault();
  return true;
}

$("mention-list").addEventListener("mousedown", (event) => event.preventDefault());
$("mention-list").addEventListener("click", (event) => {
  const item = event.target.closest?.("[data-index]");
  if (item) pickMention(Number(item.dataset.index));
});
$("message").addEventListener("click", showMentions);
$("message").addEventListener("blur", closeMentions);

// Send a message later (ADR 0060). The composer's clock button schedules what is in the composer;
// the bar above it opens the board's list, where the sender changes or cancels a message.
let scheduleRequest = null;
/** null schedules the composer's text; an item changes that scheduled message. */
let scheduleTarget = null;

async function loadScheduled(connection = session, name = channel) {
  try {
    const data = await api(`/channels/${name}/scheduled`, {}, connection);
    const state = connection.channels.get(name);
    if (!state) return;
    state.scheduled = data.scheduled;
    state.scheduledAt = Date.now();
    if (session === connection && channel === name) showScheduled(state);
  } catch {
    // Older Workers have no schedule; the bar stays hidden and the next refresh tries again.
  }
}

function showScheduled(state) {
  const list = state?.scheduled ?? [];
  const text = summary(list);
  $("scheduled-bar").hidden = !text;
  $("scheduled-bar").classList.toggle(
    "failed",
    list.some((item) => item.status === "failed"),
  );
  $("scheduled-open").textContent = text ? `${text} · show` : "";
  if ($("scheduled-dialog").open) renderScheduledList(list);
}

function ownScheduled(item) {
  return item.username === session?.username;
}

function renderScheduledList(list) {
  const rows = list.map((item) => {
    const row = document.createElement("li");
    const when = document.createElement("span");
    when.className = "scheduled-when";
    when.textContent = `${item.status === "failed" ? "Was due" : item.repeat ? "Next" : "Posts"} ${whenText(item.sendAt)} · ${item.username}${addressees(item).length ? ` → ${namesText(addressees(item))}` : ""}`;
    when.title = new Date(item.sendAt).toLocaleString();
    const body = document.createElement("p");
    body.className = "scheduled-text";
    body.textContent = item.text;
    row.append(when, body);
    if (item.repeat) {
      const rule = document.createElement("p");
      rule.className = "scheduled-repeat";
      rule.textContent = repeatText(item.repeat);
      row.append(rule);
    }
    if (item.status === "failed") {
      const reason = document.createElement("p");
      reason.className = "scheduled-error";
      reason.textContent = `Not posted: ${item.error?.message || item.error?.code || "unknown error"}`;
      row.append(reason);
    }
    const mine = ownScheduled(item);
    if (mine || session?.owner) {
      const actions = document.createElement("div");
      actions.className = "scheduled-actions";
      if (mine && !archivedBoards.has(channel)) {
        const change = document.createElement("button");
        change.type = "button";
        change.className = "quiet";
        change.textContent = item.status === "failed" ? "Pick a new time" : "Change";
        change.addEventListener("click", () => openSchedule(item));
        actions.append(change);
      }
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "quiet";
      cancel.textContent = item.repeat ? "Stop repeating" : "Cancel message";
      cancel.addEventListener("click", () => void cancelScheduled(item, cancel));
      actions.append(cancel);
      row.append(actions);
    }
    return row;
  });
  if (!rows.length) {
    const empty = document.createElement("li");
    empty.textContent = "Nothing scheduled on this board.";
    rows.push(empty);
  }
  $("scheduled-list").replaceChildren(...rows);
}

async function cancelScheduled(item, button) {
  const connection = session;
  const name = channel;
  button.disabled = true;
  try {
    await api(
      `/channels/${name}/scheduled/${item.id}?username=${encodeURIComponent(connection.username)}`,
      { method: "DELETE" },
      connection,
    );
    status(
      item.repeat
        ? "Stopped the repeating message. Copies already posted stay on the board."
        : `Cancelled the message scheduled for ${whenText(item.sendAt)}.`,
    );
  } catch (error) {
    status(error.message, true);
  } finally {
    button.disabled = false;
    await loadScheduled(connection, name);
  }
}

function scheduleError(message) {
  $("schedule-error").textContent = message ?? "";
  $("schedule-error").hidden = !message;
}

function openSchedule(item = null) {
  if (!session || !channel) return;
  if (!item) {
    if (!canPost()) return;
    const content = $("message").value;
    if (!content.trim()) {
      status("Write the message first, then choose when to send it.", true);
      $("message").focus();
      return;
    }
    const state = draft();
    if (state.files.length || state.missingFiles > 0) {
      status("A scheduled message cannot carry files. Send the files now, or remove them first.", true);
      return;
    }
  }
  scheduleTarget = item;
  scheduleError(null);
  const now = new Date();
  const choices = presets(now);
  $("schedule-title").textContent = item ? "Change scheduled message" : "Send later";
  $("schedule-submit").textContent = item ? "Save" : "Schedule";
  $("schedule-text-row").hidden = !item;
  $("schedule-text").value = item?.text ?? "";
  $("schedule-text").required = Boolean(item);
  const due = item && item.status === "pending" ? new Date(item.sendAt) : choices[0].at;
  $("schedule-at").min = localInput(now);
  $("schedule-at").value = localInput(due);
  // Repeat (ADR 0072) is chosen when scheduling. A change keeps the rule and moves the next copy.
  $("schedule-repeat-rows").hidden = Boolean(item);
  $("schedule-repeat").value = "";
  $("schedule-until").value = "";
  $("schedule-until").min = localInput(now).slice(0, 10);
  // The server takes an end at most 366 days ahead; 365 days is inside that in every zone.
  $("schedule-until").max = localInput(new Date(now.getTime() + 365 * 86400000)).slice(0, 10);
  $("schedule-at-label").textContent = item?.repeat ? "Next copy posts at" : "Post at";
  $("schedule-repeat-note").textContent = item?.repeat
    ? `${repeatText(item.repeat)}. A new time moves the next copy only. To change the rule, stop it and schedule a new one.`
    : "";
  showRepeatFields();
  const legend = document.createElement("legend");
  legend.className = "sr-only";
  legend.textContent = "Quick times";
  $("schedule-presets").replaceChildren(
    legend,
    ...choices.map((choice) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "quiet";
      button.textContent = choice.label;
      button.addEventListener("click", () => {
        $("schedule-at").value = localInput(choice.at);
        scheduleError(null);
      });
      return button;
    }),
  );
  $("schedule-dialog").showModal();
  (item ? $("schedule-text") : $("schedule-at")).focus();
}

/** Shows the repeat fields that fit the chosen rule, and says which zone the times are in. */
function showRepeatFields() {
  const every = $("schedule-repeat").value;
  const changing = $("schedule-repeat-rows").hidden;
  $("schedule-hours-row").hidden = every !== "hours";
  $("schedule-until-row").hidden = !every;
  if (!changing)
    $("schedule-repeat-note").textContent = every
      ? every === "hours"
        ? "Each copy posts as a normal message and counts toward the workspace's 100,000 messages: every hour is 8,784 a year. Without a last day it repeats for a year."
        : `Each copy posts as a normal message at this time in ${deviceZone()} time, also after a clock change. Without a last day it repeats for a year.`
      : "";
  $("schedule-repeat-note").hidden = !$("schedule-repeat-note").textContent;
}
$("schedule-repeat").addEventListener("change", () => {
  showRepeatFields();
  scheduleError(null);
});

$("send-later").addEventListener("click", () => openSchedule());
$("close-schedule").addEventListener("click", () => $("schedule-dialog").close());
$("schedule-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const sendAt = sendAtFrom($("schedule-at").value);
  if (!sendAt) {
    scheduleError("Pick a time in the future, at most a year ahead.");
    return;
  }
  const item = scheduleTarget;
  if (!item) {
    const rule = repeatFrom({
      every: $("schedule-repeat").value,
      hours: $("schedule-hours").value,
      until: $("schedule-until").value,
      first: $("schedule-at").value,
    });
    if (rule.error) {
      scheduleError(rule.error);
      return;
    }
    $("schedule-dialog").close();
    scheduleRequest = { sendAt, repeat: rule.repeat };
    $("send-form").requestSubmit();
    return;
  }
  const connection = session;
  const name = channel;
  const text = $("schedule-text").value;
  if (!text.trim() || new TextEncoder().encode(text).length > 16384) {
    scheduleError("Message must be 1–16,384 UTF-8 bytes.");
    return;
  }
  const change = { username: connection.username };
  if (text !== item.text) change.text = text;
  // A failed message needs a new time to post; an unchanged time on a waiting one is left alone.
  if (sendAt !== item.sendAt || item.status === "failed") change.sendAt = sendAt;
  if (!change.text && !change.sendAt) {
    $("schedule-dialog").close();
    return;
  }
  $("schedule-submit").disabled = true;
  try {
    await api(
      `/channels/${name}/scheduled/${item.id}`,
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(change) },
      connection,
    );
    $("schedule-dialog").close();
    status(`Scheduled for ${whenText(change.sendAt ?? item.sendAt)}.`);
    await loadScheduled(connection, name);
  } catch (error) {
    scheduleError(error.message);
  } finally {
    $("schedule-submit").disabled = false;
  }
});
$("scheduled-open").addEventListener("click", () => {
  if (!session || !channel) return;
  renderScheduledList(session.channels.get(channel)?.scheduled ?? []);
  $("scheduled-dialog").showModal();
  void loadScheduled(session, channel);
});
$("close-scheduled").addEventListener("click", () => $("scheduled-dialog").close());
