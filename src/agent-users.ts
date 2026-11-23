/** Hosted connectors (ADR 0081). All writes here are synchronous in the owning tenant's SQLite.
 * The home workspace owns users and installations. Each channel's workspace owns membership.
 * No shared key, participant key, OAuth token, or human owner key is stored on a member. */
import { HttpError, text } from "./http";

export type AgentUser = { id: string; name: string };
export type AgentPrincipal = { user: AgentUser; peers: string[] };
export type AgentMember = AgentUser & { channel: string; watchOnly: boolean };
type MemberRow = AgentUser & { channel: string; watch: number; grantId: string };
export const AGENT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS connector_consents (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS connector_users (id TEXT PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS connector_installs (
    id TEXT PRIMARY KEY, agent TEXT NOT NULL, label TEXT NOT NULL, kind TEXT NOT NULL,
    secretHash TEXT UNIQUE, createdAt TEXT NOT NULL, exchanged INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS connector_installs_agent ON connector_installs(agent);
  CREATE TABLE IF NOT EXISTS connector_peers (
    agent TEXT NOT NULL, peer TEXT NOT NULL, PRIMARY KEY(agent, peer)
  );
  CREATE TABLE IF NOT EXISTS connector_approvals (
    agent TEXT NOT NULL, inviteHash TEXT NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(agent, inviteHash)
  );
  CREATE TABLE IF NOT EXISTS connector_members (
    channel TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, watch INTEGER NOT NULL, grantId TEXT NOT NULL,
    PRIMARY KEY(channel, id)
  );
  CREATE INDEX IF NOT EXISTS connector_members_user ON connector_members(id);
  CREATE TABLE IF NOT EXISTS connector_joins (
    inviteHash TEXT NOT NULL, agent TEXT NOT NULL, channel TEXT NOT NULL, grantId TEXT NOT NULL,
    expires INTEGER NOT NULL, PRIMARY KEY(inviteHash, agent)
  );
`;

function unavailable(): never {
  throw new HttpError(403, "channel_unavailable", "This agent has no such membership.");
}
function quota(what: string): never {
  throw new HttpError(409, "connector_quota", `Limit reached: ${what}.`);
}
function external(m: MemberRow): AgentMember {
  return { id: m.id, name: m.name, channel: m.channel, watchOnly: m.watch === 1 };
}
export class AgentUsers {
  constructor(private sql: SqlStorage) {}
  users() {
    return this.sql.exec<AgentUser>("SELECT id,name FROM connector_users ORDER BY name,id").toArray();
  }
  user(id: string): AgentUser {
    const row = this.sql.exec<AgentUser>("SELECT id,name FROM connector_users WHERE id=?", id).toArray()[0];
    if (!row) throw new HttpError(404, "agent_not_found", "Choose an agent you own in this workspace.");
    return row;
  }
  create(name: string) {
    if (this.users().length >= 32) quota("32 agent users per workspace");
    return this.sql
      .exec<AgentUser>(
        "INSERT INTO connector_users VALUES (?,?) RETURNING id,name",
        crypto.randomUUID(),
        name,
      )
      .one();
  }
  installations(id: string) {
    this.user(id);
    return this.sql
      .exec<{ id: string; label: string; kind: string; createdAt: string }>(
        "SELECT id,label,kind,createdAt FROM connector_installs WHERE agent=? ORDER BY createdAt,id",
        id,
      )
      .toArray();
  }
  install(id: string, label: string, hash: string | null) {
    if (this.installations(id).length >= 16) quota("16 installations per agent; disconnect one first");
    const install = crypto.randomUUID();
    this.sql.exec(
      "INSERT INTO connector_installs(id,agent,label,kind,secretHash,createdAt) VALUES(?,?,?,?,?,?)",
      install,
      id,
      text(label, "installation name", 128),
      hash ? "bearer" : "oauth",
      hash,
      new Date().toISOString(),
    );
    return install;
  }
  revoke(id: string, install: string) {
    this.user(id);
    this.sql.exec("DELETE FROM connector_installs WHERE agent=? AND id=?", id, install);
  }
  principal(home: string, id: string): AgentPrincipal {
    return {
      user: this.user(id),
      peers: [
        home,
        ...this.sql
          .exec<{ peer: string }>("SELECT peer FROM connector_peers WHERE agent=? ORDER BY peer", id)
          .toArray()
          .map((v) => v.peer),
      ],
    };
  }
  login(
    home: string,
    credential: { hash: string } | { agent: string; install: string },
  ): AgentPrincipal | null {
    const row = (
      "hash" in credential
        ? this.sql.exec<{ agent: string }>(
            "SELECT agent FROM connector_installs WHERE kind='bearer' AND secretHash=?",
            credential.hash,
          )
        : this.sql.exec<{ agent: string }>(
            "SELECT agent FROM connector_installs WHERE kind='oauth' AND exchanged=1 AND agent=? AND id=?",
            credential.agent,
            credential.install,
          )
    ).toArray()[0];
    return row ? this.principal(home, row.agent) : null;
  }
  /** The OAuth provider checks PKCE/client/audience first. KV is not a single-use gate. */
  exchange(agent: string, install: string, first: boolean): boolean {
    return first
      ? this.sql.exec(
          "UPDATE connector_installs SET exchanged=1 WHERE agent=? AND id=? AND kind='oauth' AND exchanged=0",
          agent,
          install,
        ).rowsWritten === 1
      : this.sql
          .exec(
            "SELECT id FROM connector_installs WHERE agent=? AND id=? AND kind='oauth' AND exchanged=1",
            agent,
            install,
          )
          .toArray().length === 1;
  }
  rememberPeer(id: string, home: string, peer: string) {
    const p = this.principal(home, id);
    if (p.peers.includes(peer)) return;
    if (p.peers.length >= 24) quota("24 workspaces per agent");
    this.sql.exec("INSERT INTO connector_peers(agent,peer) VALUES(?,?)", id, peer);
  }
  approve(id: string, hash: string, expires: number) {
    this.sql.exec("DELETE FROM connector_approvals WHERE expires<=?", Date.now());
    if (
      !this.approved(id, hash) &&
      this.sql.exec("SELECT 1 FROM connector_approvals WHERE agent=? LIMIT 32", id).toArray().length >= 32
    )
      quota("32 pending invitations per agent");
    this.sql.exec("INSERT OR REPLACE INTO connector_approvals VALUES(?,?,?)", id, hash, expires);
  }
  approved(id: string, hash: string) {
    return !!this.sql
      .exec(
        "SELECT 1 FROM connector_approvals WHERE agent=? AND inviteHash=? AND expires>?",
        id,
        hash,
        Date.now(),
      )
      .toArray().length;
  }
  roster(channel: string) {
    return this.sql
      .exec<MemberRow>("SELECT * FROM connector_members WHERE channel=? ORDER BY name,id", channel)
      .toArray()
      .map(external);
  }
  memberships(id: string) {
    return this.sql
      .exec<MemberRow>("SELECT * FROM connector_members WHERE id=? ORDER BY channel", id)
      .toArray()
      .map(external);
  }
  member(channel: string, id: string) {
    return (
      this.sql
        .exec<MemberRow>("SELECT * FROM connector_members WHERE channel=? AND id=?", channel, id)
        .toArray()[0] ?? unavailable()
    );
  }
  add(channel: string, user: AgentUser, watch: boolean) {
    const existing = this.sql
      .exec<MemberRow>("SELECT * FROM connector_members WHERE channel=? AND id=?", channel, user.id)
      .toArray()[0];
    if (existing) return existing; // Neither another invitation nor a repeated direct add changes the mode.
    if (
      this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM connector_members").one().n >= 1000 ||
      this.memberships(user.id).length >= 32
    )
      quota("1,000 channel memberships per workspace, 32 per agent in it");
    return this.sql
      .exec<MemberRow>(
        "INSERT INTO connector_members(channel,id,name,watch,grantId) VALUES(?,?,?,?,?) RETURNING *",
        channel,
        user.id,
        user.name,
        watch ? 1 : 0,
        crypto.randomUUID(),
      )
      .one();
  }
  remove(channel: string, id: string) {
    this.sql.exec("DELETE FROM connector_members WHERE channel=? AND id=?", channel, id);
  }
  /** Once removed, an already accepted multi-use invitation cannot silently put this user back. */
  receipt(hash: string, id: string) {
    const receipt = this.sql
      .exec<{ channel: string; grantId: string; expires: number }>(
        "SELECT channel,grantId,expires FROM connector_joins WHERE inviteHash=? AND agent=?",
        hash,
        id,
      )
      .toArray()[0];
    if (!receipt) return null;
    const member = this.member(receipt.channel, id);
    if (member.grantId !== receipt.grantId) unavailable();
    return { channel: member.channel, watchOnly: !!member.watch, expires: receipt.expires };
  }
  record(hash: string, member: MemberRow, expires: number) {
    this.sql.exec("DELETE FROM connector_joins WHERE expires<=?", Date.now());
    if (this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM connector_joins").one().n >= 4000)
      quota("4,000 recent agent invitations");
    this.sql.exec(
      "INSERT INTO connector_joins VALUES(?,?,?,?,?)",
      hash,
      member.id,
      member.channel,
      member.grantId,
      expires,
    );
  }
}
