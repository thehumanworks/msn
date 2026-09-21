/** Pure validation shared by the host and executable adapters. No harness SDK. */
import { createHash } from "node:crypto";
import { resolve } from "node:path";

export const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const MAX_OUTPUT = 65536;
export const slug = (value) => typeof value === "string" && SLUG.test(value);
export class HostError extends Error {
  constructor(code) {
    super(code);
    this.name = "HostError";
    this.code = code;
  }
}
export function requireValue(condition, code) {
  if (!condition) throw new HostError(code);
}
export function integer(value, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}
export function name(value) {
  return typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value) <= 128;
}
function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function keys(value, allowed) {
  requireValue(object(value) && Object.keys(value).every((key) => allowed.includes(key)), "invalid_fields");
}
export function digest(...values) {
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}
export function permitted(agent, channel) {
  return slug(channel) && (agent.allowedChannels.includes("*") || agent.allowedChannels.includes(channel));
}
export function validateConfig(raw, base) {
  keys(raw, [
    "schema",
    "hostId",
    "stateDir",
    "maxConcurrent",
    "maxPending",
    "maxTurnsPerConversation",
    "softTurnsPerConversation",
    "replayHistory",
    "agents",
  ]);
  requireValue(raw.schema === "msn.host.v1" && slug(raw.hostId), "invalid_host_config");
  requireValue(typeof raw.stateDir === "string" && raw.stateDir.length > 0, "state_directory_required");
  requireValue(
    Array.isArray(raw.agents) && raw.agents.length > 0 && raw.agents.length <= 32,
    "invalid_agents",
  );
  const config = {
    ...raw,
    stateDir: resolve(base, raw.stateDir),
    maxConcurrent: raw.maxConcurrent ?? 4,
    maxPending: raw.maxPending ?? 1000,
    maxTurnsPerConversation: raw.maxTurnsPerConversation ?? 64,
    // Soft reassessment interval in logical agent turns since the last human message; 0 disables it.
    softTurnsPerConversation: raw.softTurnsPerConversation ?? Math.min(16, raw.maxTurnsPerConversation ?? 64),
    replayHistory: raw.replayHistory ?? false,
  };
  requireValue(
    integer(config.maxConcurrent, 1, 32) &&
      integer(config.maxPending, 1, 10000) &&
      integer(config.maxTurnsPerConversation, 1, 10000) &&
      integer(config.softTurnsPerConversation, 0, config.maxTurnsPerConversation),
    "invalid_host_limits",
  );
  requireValue(typeof config.replayHistory === "boolean", "invalid_replay_policy");
  const ids = new Set();
  config.agents = raw.agents.map((item) => {
    keys(item, [
      "id",
      "profile",
      "connection",
      "command",
      "cwd",
      "channels",
      "allowedChannels",
      "role",
      "description",
      "permissionMode",
      "timeoutMs",
      "attempts",
    ]);
    requireValue(slug(item.id) && !ids.has(item.id), "invalid_agent_id");
    ids.add(item.id);
    requireValue(item.permissionMode === "yolo", "all_agents_require_yolo_mode");
    requireValue(
      Array.isArray(item.command) &&
        item.command.length > 0 &&
        item.command.length <= 64 &&
        item.command.every(
          (arg) => typeof arg === "string" && arg.length > 0 && !arg.includes("\0") && arg.length <= 8192,
        ),
      "invalid_trusted_command",
    );
    requireValue(Boolean(item.profile) !== Boolean(item.connection), "one_connection_source_required");
    if (item.profile) requireValue(slug(item.profile), "invalid_profile");
    if (item.connection) {
      keys(item.connection, ["origin", "tenant", "tokenEnv"]);
      requireValue(
        slug(item.connection.tenant) &&
          typeof item.connection.origin === "string" &&
          typeof item.connection.tokenEnv === "string" &&
          /^[A-Z_][A-Z0-9_]*$/.test(item.connection.tokenEnv),
        "invalid_connection",
      );
    }
    requireValue(
      Array.isArray(item.channels) &&
        item.channels.length > 0 &&
        item.channels.length <= 64 &&
        item.channels.every((v) => typeof v === "string" && SLUG.test(v)),
      "invalid_channels",
    );
    const agent = {
      ...item,
      channels: [...new Set(item.channels)],
      allowedChannels: item.allowedChannels ?? item.channels,
      cwd: resolve(base, item.cwd ?? "."),
      role: item.role ?? "peer",
      description: item.description ?? "",
      // `null` is an explicit no-deadline turn; an absent field keeps the finite default.
      timeoutMs: item.timeoutMs === undefined ? 300000 : item.timeoutMs,
      attempts: item.attempts ?? 3,
    };
    requireValue(
      Array.isArray(agent.allowedChannels) &&
        agent.allowedChannels.length > 0 &&
        agent.allowedChannels.length <= 64 &&
        agent.allowedChannels.every((v) => v === "*" || (typeof v === "string" && SLUG.test(v))),
      "invalid_allowed_channels",
    );
    requireValue(
      agent.channels.every((channel) => permitted(agent, channel)),
      "channel_not_permitted",
    );
    requireValue(
      ["peer", "coordinator"].includes(agent.role) &&
        typeof agent.description === "string" &&
        agent.description.length <= 2048,
      "invalid_agent_description",
    );
    requireValue(
      (agent.timeoutMs === null || integer(agent.timeoutMs, 10, 3600000)) && integer(agent.attempts, 1, 10),
      "invalid_agent_limits",
    );
    return agent;
  });
  return config;
}
/** Grace a replacement host reserves before reclaiming a turn that was running when the previous
 * host died. The orphaned watchdog needs its host-disconnect SIGTERM/SIGKILL escalation to finish;
 * recovery measures this grace from replacement startup, so an expired or reconfigured lease never
 * permits an immediate overlapping claim. A no-deadline turn's lease is this grace alone. */
export const RECOVERY_GRACE_MS = 15000;
/** Lease recorded at turn start. A finite deadline covers the watchdog deadline plus its
 * SIGTERM/SIGKILL escalation; a no-deadline turn only relies on the watchdog's host-disconnect
 * cleanup, so its lease is the fixed recovery grace instead of forever. */
export function turnLease(timeoutMs, now = Date.now()) {
  return now + (timeoutMs === null ? RECOVERY_GRACE_MS : timeoutMs + 5000);
}
export function validateMessage(message, event, connection) {
  requireValue(
    object(message) &&
      message.id === event.resourceId &&
      message.tenant === connection.tenant &&
      message.channel === event.channel &&
      name(message.username) &&
      typeof message.text === "string" &&
      Buffer.byteLength(message.text) <= 16384 &&
      ["text/plain", "application/json"].includes(message.contentType) &&
      (message.to === undefined || name(message.to)) &&
      (message.correlationId === undefined || name(message.correlationId)),
    "invalid_canonical_message",
  );
  if (message.contentType === "application/json") {
    try {
      JSON.parse(message.text);
    } catch {
      throw new HostError("invalid_canonical_json");
    }
  }
  return message;
}
export function diagnostic(message) {
  if (message.contentType !== "application/json") return false;
  try {
    return JSON.parse(message.text)?.schema === "msn.host.status.v1";
  } catch {
    return false;
  }
}
export function validateResult(result, agent, currentChannels) {
  keys(result, ["schema", "actions", "state", "wait"]);
  requireValue(
    result.schema === "msn.turn.result.v1" && Buffer.byteLength(JSON.stringify(result)) <= MAX_OUTPUT,
    "invalid_turn_result",
  );
  requireValue(Array.isArray(result.actions) && result.actions.length <= 16, "invalid_actions");
  const memberships = new Set(currentChannels);
  for (const action of result.actions) {
    if (action.type === "send") {
      keys(action, ["type", "channel", "text", "to", "replyTo", "contentType"]);
      requireValue(
        permitted(agent, action.channel) && memberships.has(action.channel),
        "send_requires_joined_channel",
      );
      requireValue(
        typeof action.text === "string" &&
          action.text.trim().length > 0 &&
          Buffer.byteLength(action.text) <= 16384,
        "invalid_send_text",
      );
      requireValue(
        action.to === undefined || (name(action.to) && action.to !== agent.username),
        "invalid_recipient_or_self_send",
      );
      requireValue(
        action.replyTo === undefined || integer(action.replyTo, 1, Number.MAX_SAFE_INTEGER),
        "invalid_reply_reference",
      );
      requireValue(
        action.contentType === undefined || ["text/plain", "application/json"].includes(action.contentType),
        "invalid_content_type",
      );
      if (action.contentType === "application/json") {
        try {
          JSON.parse(action.text);
        } catch {
          throw new HostError("invalid_send_json");
        }
      }
    } else {
      keys(action, ["type", "channel"]);
      requireValue(
        ["join", "leave"].includes(action.type) && permitted(agent, action.channel),
        "invalid_membership_action",
      );
      if (action.type === "join") memberships.add(action.channel);
      else memberships.delete(action.channel);
      requireValue(memberships.size <= 64, "too_many_memberships");
    }
  }
  if (Object.hasOwn(result, "state"))
    requireValue(Buffer.byteLength(JSON.stringify(result.state)) <= 16384, "state_too_large");
  if (result.wait !== undefined && result.wait !== null) {
    keys(result.wait, ["for", "timeoutMs", "reason"]);
    requireValue(
      Array.isArray(result.wait.for) &&
        result.wait.for.length > 0 &&
        result.wait.for.length <= 32 &&
        result.wait.for.every(name) &&
        new Set(result.wait.for).size === result.wait.for.length,
      "invalid_wait_peers",
    );
    requireValue(
      integer(result.wait.timeoutMs, 1, 3600000) &&
        typeof result.wait.reason === "string" &&
        result.wait.reason.length <= 2048,
      "bounded_wait_required",
    );
  }
  return { ...result, memberships: [...memberships] };
}
