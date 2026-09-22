import { request, validatePage } from "../event-runner.mjs";
import { loadProfile, normalizeOrigin } from "../onboarding-check.mjs";
import { requireValue, slug } from "./protocol.mjs";

export { request };
export async function connectionsFor(config, env, signal) {
  const connections = new Map();
  let workspace;
  const names = new Set();
  for (const agent of config.agents) {
    const connection = agent.profile
      ? await loadProfile(agent.profile, env)
      : {
          origin: normalizeOrigin(agent.connection.origin),
          tenant: agent.connection.tenant,
          token: env[agent.connection.tokenEnv],
        };
    requireValue(
      typeof connection.token === "string" && connection.token.trim().length > 0,
      "participant_credential_required",
    );
    const identity = await request(connection, `/api/tenants/${connection.tenant}`, signal);
    const shared = identity.sharedChannel === true && typeof identity.channel === "string";
    requireValue(
      identity.tenant === connection.tenant &&
        (shared ||
          (typeof identity.username === "string" &&
            identity.username.trim().length > 0 &&
            !identity.usernamePrefix)),
      "channel_or_participant_credential_required",
    );
    const username = shared ? connection.username || agent.username || agent.id : identity.username;
    requireValue(
      !connection.username || shared || connection.username === identity.username,
      "profile_identity_mismatch",
    );
    if (shared) {
      await request(
        connection,
        `/api/tenants/${connection.tenant}/channels/${identity.channel}/personas/${agent.id}`,
        signal,
        { method: "PUT", body: { displayName: username } },
      );
      agent.personaId = agent.id;
    }
    requireValue(!names.has(username), "duplicate_agent_identity");
    names.add(username);
    if (identity.channel != null) {
      requireValue(
        slug(identity.channel) && agent.channels.every((channel) => channel === identity.channel),
        "participant_channel_scope_mismatch",
      );
      agent.allowedChannels = agent.allowedChannels.includes("*")
        ? [identity.channel]
        : agent.allowedChannels;
      requireValue(
        agent.allowedChannels.every((channel) => channel === identity.channel),
        "participant_channel_scope_mismatch",
      );
    }
    const key = JSON.stringify([connection.origin, connection.tenant]);
    requireValue(!workspace || workspace === key, "agents_must_share_one_workspace");
    workspace = key;
    agent.username = username;
    connection.username = username;
    connection.channel = identity.channel ?? null;
    connections.set(agent.id, connection);
  }
  const first = connections.values().next().value;
  const binding = {
    version: 1,
    hostId: config.hostId,
    origin: first.origin,
    tenant: first.tenant,
    agents: config.agents
      .map((agent) => ({
        id: agent.id,
        username: agent.username,
        allowedChannels: [...agent.allowedChannels].sort(),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
  return { connections, binding };
}
export function validateHostPage(page, connection, after) {
  requireValue(
    page &&
      Array.isArray(page.events) &&
      page.events.length <= 100 &&
      typeof page.hasMore === "boolean" &&
      Object.keys(page).every((key) => ["events", "nextCursor", "hasMore"].includes(key)),
    "invalid_event_page",
  );
  let previous = after;
  for (const event of page.events) {
    requireValue(
      event &&
        slug(event.channel) &&
        (!connection.channel || event.channel === connection.channel) &&
        Object.keys(event).every((key) =>
          ["id", "tenant", "channel", "type", "resourceId", "historyRevision", "createdAt"].includes(key),
        ),
      "invalid_event_scope",
    );
    validatePage(
      { events: [event], nextCursor: event.id, hasMore: false },
      { tenant: connection.tenant, channel: event.channel },
      previous,
    );
    previous = event.id;
  }
  requireValue(
    page.nextCursor === previous && (!page.hasMore || page.events.length > 0),
    "invalid_event_continuation",
  );
  return page.events;
}
