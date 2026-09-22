import { request, validatePage } from "../event-runner.mjs";
import { loadProfile, normalizeOrigin } from "../onboarding-check.mjs";
import { name, requireValue, slug } from "./protocol.mjs";

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
    const shared = identity.sharedChannel === true;
    requireValue(
      identity.tenant === connection.tenant &&
        (shared ? slug(identity.channel) : name(identity.username) && !identity.usernamePrefix),
      "channel_or_exact_name_participant_required",
    );
    let username = identity.username;
    if (shared) {
      // A board profile selects an existing persona. Never create/rename one as a startup side effect.
      requireValue(slug(connection.reader) && name(connection.username), "board_persona_profile_required");
      const roster = await request(
        connection,
        `/api/tenants/${connection.tenant}/channels/${identity.channel}/personas`,
        signal,
      );
      const persona = Array.isArray(roster?.personas)
        ? roster.personas.find((entry) => entry.id === connection.reader)
        : null;
      requireValue(persona?.displayName === connection.username, "board_persona_identity_mismatch");
      username = persona.displayName;
      agent.personaId = persona.id;
      connection.personaId = persona.id;
      connection.sharedChannel = true;
    } else {
      requireValue(!connection.username || connection.username === username, "profile_identity_mismatch");
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
        ...(agent.personaId ? { personaId: agent.personaId } : {}),
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
