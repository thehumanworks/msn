import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

// Take a request (ADR 0075): one name marks a message as being handled, so others skip it. A
// second claim is refused and names the holder. Only the holder or the owner releases it. It
// is a visible signal stored on the message: no message, no event, no lock on any other write.

const ADMIN = "test-admin-secret-000000000000000000000";
const call = (tenant: string, suffix = "", token?: string, method = "GET", input?: unknown) =>
  exports.default.fetch(`https://msn.test/api/tenants/${tenant}${suffix}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    ...(input ? { body: JSON.stringify(input) } : {}),
  });

type Claim = { username: string; claimedAt: string };
type Message = {
  id: number;
  text: string;
  username: string;
  claim?: Claim;
  replaces?: number;
  replacedBy?: number;
};
type ErrorBody = { error: { code: string; message: string } };
type Fixture = Awaited<ReturnType<typeof fixture>>;

const adminDelete = (tenant: string, id: number) =>
  exports.default.fetch(`https://msn.test/api/admin/tenants/${tenant}/channels/work/messages/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${ADMIN}` },
  });

/** Owner `tomas` and three invited keys, each bound to its own name: `lead`, `dev` and `qa`. */
async function fixture() {
  const tenant = `claim-${crypto.randomUUID()}`;
  const owner = (await (await call(tenant, "", undefined, "PUT", { username: "tomas" })).json()) as {
    token: string;
  };
  await call(tenant, "/channels/work", owner.token, "PUT");
  const join = async (username: string, watch = false) => {
    const invite = (await (
      await call(tenant, "/invites", owner.token, "POST", { channel: "work", ...(watch ? { watch } : {}) })
    ).json()) as { code: string };
    return (
      (await (
        await call(tenant, "/invites/redeem", undefined, "POST", { code: invite.code, username })
      ).json()) as { token: string }
    ).token;
  };
  const keys: Record<string, string> = {
    tomas: owner.token,
    lead: await join("lead"),
    dev: await join("dev"),
    qa: await join("qa"),
  };
  const send = async (input: object, as = "tomas") => {
    const response = await call(tenant, "/channels/work/messages", keys[as], "POST", {
      username: as,
      ...input,
    });
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(201);
    return ((await response.json()) as { message: Message }).message;
  };
  const read = async () =>
    (
      (await (await call(tenant, "/channels/work/messages?after=0", owner.token)).json()) as {
        messages: Message[];
      }
    ).messages;
  const point = async (id: number) =>
    (
      (await (await call(tenant, `/channels/work/messages/${id}`, owner.token)).json()) as {
        message: Message;
      }
    ).message;
  return { tenant, keys, join, send, read, point };
}

/** `as` claims (or releases) message `id` with its own key; `name` overrides the name it gives. */
const claim = (f: { tenant: string; keys: Record<string, string> }, id: number, as: string, extra = {}) =>
  call(f.tenant, `/channels/work/messages/${id}/claim`, f.keys[as], "POST", { username: as, ...extra });
const release = (f: Fixture, id: number, as: string) => claim(f, id, as, { release: true });

async function refused(response: Response, status: number, code: string) {
  const body = (await response.json()) as ErrorBody;
  expect(response.status, JSON.stringify(body)).toBe(status);
  expect(body.error.code).toBe(code);
  return body.error.message;
}

describe("take a request (ADR 0075)", () => {
  it("marks the message as taken by the caller, once, and shows it on every read", async () => {
    const f = await fixture();
    const task = await f.send({ text: "Deploy the searchable worker" });
    expect("claim" in task).toBe(false);
    const first = await claim(f, task.id, "dev");
    expect(first.status).toBe(200);
    const body = (await first.json()) as { changed: boolean; message: Message };
    expect(body).toMatchObject({ changed: true, message: { id: task.id, claim: { username: "dev" } } });
    const at = body.message.claim?.claimedAt ?? "";
    expect(Number.isFinite(Date.parse(at))).toBe(true);
    // The holder claiming again changes nothing, and keeps the first time.
    expect(await (await claim(f, task.id, "dev")).json()).toMatchObject({
      changed: false,
      message: { claim: { username: "dev", claimedAt: at } },
    });

    const want = { username: "dev", claimedAt: at };
    expect((await f.read())[0].claim).toEqual(want);
    expect((await f.point(task.id)).claim).toEqual(want);
    const catchup = (await (await call(f.tenant, "/channels/work/catchup", f.keys.qa)).json()) as {
      messages: Message[];
    };
    expect(catchup.messages[0].claim).toEqual(want);
    await call(f.tenant, `/channels/work/pins/${task.id}`, f.keys.tomas, "PUT");
    const pins = (await (await call(f.tenant, "/channels/work/pins", f.keys.qa)).json()) as {
      pins: Message[];
    };
    expect(pins.pins[0].claim).toEqual(want);
    const found = (await (await call(f.tenant, "/channels/work/search?q=searchable", f.keys.qa)).json()) as {
      messages: Message[];
    };
    for (const message of found.messages) expect(message.claim).toEqual(want);
  });

  it("refuses a second claim and names the holder", async () => {
    const f = await fixture();
    const task = await f.send({ text: "Fix the flaky test" });
    expect((await claim(f, task.id, "dev")).status).toBe(200);
    const message = await refused(await claim(f, task.id, "qa"), 409, "already_claimed");
    expect(message).toContain('"dev"');
    expect(message).toContain(`Message ${task.id}`);
    // The owner cannot take it over either: it releases first, visibly.
    await refused(await claim(f, task.id, "tomas"), 409, "already_claimed");
    expect((await f.point(task.id)).claim?.username).toBe("dev");
  });

  it("lets exactly one of two racing claims win", async () => {
    const f = await fixture();
    const task = await f.send({ text: "Review PR 12" });
    const results = await Promise.all(["lead", "dev", "qa"].map((name) => claim(f, task.id, name)));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409, 409]);
    const winner = ["lead", "dev", "qa"][results.findIndex((r) => r.status === 200)];
    expect((await f.point(task.id)).claim?.username).toBe(winner);
  });

  it("lets only the holder or the owner release, and never releases by itself", async () => {
    const f = await fixture();
    const task = await f.send({ text: "Write the release notes" });
    // Releasing a message nobody took changes nothing.
    expect(await (await release(f, task.id, "qa")).json()).toMatchObject({ changed: false });
    await claim(f, task.id, "dev");
    const message = await refused(await release(f, task.id, "qa"), 403, "not_holder");
    expect(message).toContain('"dev"');
    expect((await f.point(task.id)).claim?.username).toBe("dev");

    const released = (await (await release(f, task.id, "dev")).json()) as {
      changed: boolean;
      message: Message;
    };
    expect(released.changed).toBe(true);
    expect("claim" in released.message).toBe(false);
    expect(await (await release(f, task.id, "dev")).json()).toMatchObject({ changed: false });
    // Free again: another name takes it.
    expect(await (await claim(f, task.id, "qa")).json()).toMatchObject({
      changed: true,
      message: { claim: { username: "qa" } },
    });
    // The owner releases someone else's claim, under its own name.
    expect(await (await release(f, task.id, "tomas")).json()).toMatchObject({ changed: true });
    expect("claim" in (await f.point(task.id))).toBe(false);

    // Other activity never frees a claim: sends, replies, reactions and the holder's own commits.
    await claim(f, task.id, "dev");
    await f.send({ text: "any progress?", replyTo: task.id }, "lead");
    await call(f.tenant, `/channels/work/messages/${task.id}/reactions`, f.keys.dev, "POST", {
      username: "dev",
      kind: "done",
    });
    expect((await f.point(task.id)).claim?.username).toBe("dev");
  });

  it("follows the bound-name rule: a key cannot take or release as another name", async () => {
    const f = await fixture();
    const task = await f.send({ text: "Rotate the keys" });
    // dev's key gives lead's name.
    const stolen = await call(f.tenant, `/channels/work/messages/${task.id}/claim`, f.keys.dev, "POST", {
      username: "lead",
    });
    await refused(stolen, 403, "username_bound");
    expect("claim" in (await f.point(task.id))).toBe(false);

    await claim(f, task.id, "lead");
    // dev's key cannot release it by giving the holder's name.
    const forged = await call(f.tenant, `/channels/work/messages/${task.id}/claim`, f.keys.dev, "POST", {
      username: "lead",
      release: true,
    });
    await refused(forged, 403, "username_bound");
    // Nor can the owner's key act as the holder; it releases as itself.
    const asHolder = await call(f.tenant, `/channels/work/messages/${task.id}/claim`, f.keys.tomas, "POST", {
      username: "lead",
      release: true,
    });
    await refused(asHolder, 403, "username_bound");
    expect((await f.point(task.id)).claim?.username).toBe("lead");
    // A case variant is another name: it does not hold lead's claim.
    const variant = await f.join("Lead");
    const other = await call(f.tenant, `/channels/work/messages/${task.id}/claim`, variant, "POST", {
      username: "Lead",
      release: true,
    });
    await refused(other, 403, "not_holder");
    // The github name stays reserved, as for sends.
    const admin = `claim-admin-${crypto.randomUUID()}`;
    const created = await exports.default.fetch(`https://msn.test/api/admin/tenants/${admin}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${ADMIN}` },
    });
    const { token } = (await created.json()) as { token: string };
    const sent = (await (
      await call(admin, "/channels/work/messages", token, "POST", { username: "a", text: "x" })
    ).json()) as { message: Message };
    await refused(
      await call(admin, `/channels/work/messages/${sent.message.id}/claim`, token, "POST", {
        username: "github",
      }),
      403,
      "reserved_name",
    );
  });

  it("a prefix key takes and releases as any name under its prefix, as it sends", async () => {
    const f = await fixture();
    const made = await exports.default.fetch(`https://msn.test/api/admin/tenants/${f.tenant}/keys/family`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ usernamePrefix: "lea" }),
    });
    expect(made.status).toBe(201);
    const family = ((await made.json()) as { token: string }).token;
    const task = await f.send({ text: "Rotate the keys" });
    const path = `/channels/work/messages/${task.id}/claim`;
    // Outside the prefix it is refused, like a send.
    await refused(await call(f.tenant, path, family, "POST", { username: "dev" }), 403, "username_bound");
    await claim(f, task.id, "dev");
    await refused(
      await call(f.tenant, path, family, "POST", { username: "dev", release: true }),
      403,
      "username_bound",
    );
    // Under the prefix it holds no claim of its own, so it cannot release dev's.
    await refused(
      await call(f.tenant, path, family, "POST", { username: "leaf", release: true }),
      403,
      "not_holder",
    );
    await release(f, task.id, "dev");
    // `lead` is a name under the prefix: the key speaks as it everywhere, so it releases its claim.
    await claim(f, task.id, "lead");
    expect(
      await (await call(f.tenant, path, family, "POST", { username: "lead", release: true })).json(),
    ).toMatchObject({ changed: true });
    expect("claim" in (await f.point(task.id))).toBe(false);
  });

  it("on a shared board, takes only as a registered persona", async () => {
    const tenant = `claim-board-${crypto.randomUUID()}`;
    const owner = (await (await call(tenant, "", undefined, "PUT", { username: "human" })).json()) as {
      token: string;
    };
    const agent = "c".repeat(64);
    await call(tenant, "/channels/work/board", owner.token, "PUT", { credential: agent, goal: "Ship" });
    for (const name of ["lead", "dev"])
      await call(tenant, `/channels/work/personas/${name}`, agent, "PUT", { displayName: name });
    const sent = (await (
      await call(tenant, "/channels/work/messages", agent, "POST", { username: "lead", text: "Build it" })
    ).json()) as { message: Message };
    const path = `/channels/work/messages/${sent.message.id}/claim`;
    await refused(await call(tenant, path, agent, "POST", { username: "stranger" }), 400, "persona_required");
    expect(await (await call(tenant, path, agent, "POST", { username: "dev" })).json()).toMatchObject({
      changed: true,
      message: { claim: { username: "dev" } },
    });
    await refused(await call(tenant, path, agent, "POST", { username: "lead" }), 409, "already_claimed");
    // The owner account, bound to `human`, releases it.
    await refused(
      await call(tenant, path, owner.token, "POST", { username: "dev", release: true }),
      403,
      "username_bound",
    );
    expect(
      await (await call(tenant, path, owner.token, "POST", { username: "human", release: true })).json(),
    ).toMatchObject({ changed: true });
  });

  it("writes no message and no event, and moves no cursor", async () => {
    const f = await fixture();
    const task = await f.send({ text: "first" });
    const events = async () =>
      (await (await call(f.tenant, "/events?channel=work&after=0", f.keys.tomas)).json()) as {
        events: unknown[];
        nextCursor: number;
      };
    const before = await events();
    await claim(f, task.id, "dev");
    await release(f, task.id, "dev");
    await claim(f, task.id, "qa");
    const page = (await (await call(f.tenant, "/channels/work/messages?after=0", f.keys.tomas)).json()) as {
      messages: Message[];
      nextCursor: number;
    };
    expect(page.messages.map((m) => m.id)).toEqual([task.id]);
    expect(page.nextCursor).toBe(task.id);
    const after = await events();
    expect(after.events.length).toBe(before.events.length);
    expect(after.nextCursor).toBe(before.nextCursor);
  });

  it("is a signal, not a lock: others can still reply, react and answer", async () => {
    const f = await fixture();
    const question = await f.send({ text: "Ship it?", to: "qa", choices: ["yes", "no"] });
    await claim(f, question.id, "dev");
    const answer = await call(f.tenant, "/channels/work/messages", f.keys.qa, "POST", {
      username: "qa",
      replyTo: question.id,
      answer: "yes",
    });
    expect(answer.status).toBe(201);
    await f.send({ text: "I looked too", replyTo: question.id }, "lead");
    const now = await f.point(question.id);
    expect(now.claim?.username).toBe("dev");
  });

  it("rejects malformed bodies, unknown ids and other methods", async () => {
    const f = await fixture();
    const task = await f.send({ text: "x" });
    const path = `/channels/work/messages/${task.id}/claim`;
    await refused(
      await call(f.tenant, path, f.keys.dev, "POST", { username: "dev", extra: 1 }),
      400,
      "invalid_claim",
    );
    await refused(
      await call(f.tenant, path, f.keys.dev, "POST", { username: "dev", release: "yes" }),
      400,
      "invalid_claim",
    );
    expect((await call(f.tenant, path, f.keys.dev, "POST", { release: true })).status).toBe(400);
    await refused(await claim(f, 99999, "dev"), 404, "message_not_found");
    expect((await call(f.tenant, path, f.keys.dev, "PUT", { username: "dev" })).status).toBe(404);
    expect("claim" in (await f.point(task.id))).toBe(false);
  });

  it("refuses watch-only keys with 403 and archived boards with 409", async () => {
    const f = await fixture();
    const task = await f.send({ text: "x" });
    f.keys.watcher = await f.join("watcher", true);
    await refused(await claim(f, task.id, "watcher"), 403, "watch_only");
    await claim(f, task.id, "dev");
    expect((await call(f.tenant, "/channels/work/archive", f.keys.tomas, "PUT")).status).toBe(200);
    await refused(await claim(f, task.id, "qa"), 409, "board_archived");
    await refused(await release(f, task.id, "dev"), 409, "board_archived");
    // The archived board still shows who had taken it.
    expect((await f.point(task.id)).claim?.username).toBe("dev");
  });

  it("keeps claims inside their board", async () => {
    const f = await fixture();
    const task = await f.send({ text: "x" });
    await call(f.tenant, "/channels/other", f.keys.tomas, "PUT");
    // The id belongs to `work`; on `other` it does not exist. Invited keys are scoped to `work`.
    const wrongBoard = await call(
      f.tenant,
      `/channels/other/messages/${task.id}/claim`,
      f.keys.tomas,
      "POST",
      {
        username: "tomas",
      },
    );
    expect(wrongBoard.status).toBe(404);
    const scoped = await call(f.tenant, `/channels/other/messages/${task.id}/claim`, f.keys.dev, "POST", {
      username: "dev",
    });
    expect(scoped.status).toBe(403);
    expect("claim" in (await f.point(task.id))).toBe(false);
  });

  it("drops the claim when the message is deleted, and refuses to take a deleted one", async () => {
    const f = await fixture();
    const task = await f.send({ text: "gone soon" });
    const kept = await f.send({ text: "stays" });
    await claim(f, task.id, "dev");
    await claim(f, kept.id, "qa");
    expect((await adminDelete(f.tenant, task.id)).status).toBe(204);
    await refused(await claim(f, task.id, "qa"), 410, "message_deleted");
    await refused(await release(f, task.id, "dev"), 410, "message_deleted");
    const listed = (await (await call(f.tenant, "/channels/work/reactions", f.keys.tomas)).json()) as {
      claims: { id: number }[];
    };
    expect(listed.claims.map((c) => c.id)).toEqual([kept.id]);
    await runInDurableObject(
      env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", f.tenant])),
      (_i, state) => {
        const row = state.storage.sql
          .exec("SELECT claimedBy, claimedAt FROM messages WHERE id = ?", task.id)
          .one();
        expect(row).toEqual({ claimedBy: null, claimedAt: null });
      },
    );
  });

  it("on a replaced message: keeps an earlier claim there, and sends new claims to the replacement", async () => {
    const f = await fixture();
    const old = await f.send({ text: "Deploy to staging" });
    await claim(f, old.id, "dev");
    const next = await f.send({ text: "Deploy to production", replaces: old.id });
    // The claim stays on the message it was made on; the replacement starts free.
    expect(await f.point(old.id)).toMatchObject({ replacedBy: next.id, claim: { username: "dev" } });
    expect("claim" in (await f.point(next.id))).toBe(false);
    expect("claim" in next).toBe(false);
    // The holder still releases the old one; nobody can take it again while it is replaced.
    expect(await (await release(f, old.id, "dev")).json()).toMatchObject({ changed: true });
    const message = await refused(await claim(f, old.id, "qa"), 409, "message_replaced");
    expect(message).toContain(`message ${next.id}`);
    expect(await (await claim(f, next.id, "qa")).json()).toMatchObject({
      changed: true,
      message: { claim: { username: "qa" }, replaces: old.id },
    });
    // Deleting the replacement makes the old message current again (ADR 0068), so it can be taken.
    expect((await adminDelete(f.tenant, next.id)).status).toBe(204);
    expect(await (await claim(f, old.id, "lead")).json()).toMatchObject({
      changed: true,
      message: { claim: { username: "lead" } },
    });
  });

  it("on a replaced message: a holder's claim made before the replacement survives its deletion", async () => {
    const f = await fixture();
    const old = await f.send({ text: "Plan A" });
    await claim(f, old.id, "dev");
    const next = await f.send({ text: "Plan B", replaces: old.id });
    // The holder claiming again is still a no-op, not a refusal.
    expect(await (await claim(f, old.id, "dev")).json()).toMatchObject({ changed: false });
    await adminDelete(f.tenant, next.id);
    const back = await f.point(old.id);
    expect("replacedBy" in back).toBe(false);
    expect(back.claim?.username).toBe("dev");
  });

  it("on a message to several names: one name takes it for all, addressed or not", async () => {
    const f = await fixture();
    const task = await f.send({ text: "One of you review PR 9", to: ["dev", "qa"] });
    expect(await (await claim(f, task.id, "qa")).json()).toMatchObject({
      changed: true,
      message: { to: "dev", recipients: ["dev", "qa"], claim: { username: "qa" } },
    });
    // The other addressee is refused like anyone else and told who holds it.
    expect(await refused(await claim(f, task.id, "dev"), 409, "already_claimed")).toContain('"qa"');
    await release(f, task.id, "qa");
    // A name the message does not address may take it: a claim is not a permission.
    expect(await (await claim(f, task.id, "lead")).json()).toMatchObject({
      changed: true,
      message: { claim: { username: "lead" } },
    });
  });

  it("lists current claims with the reactions refresh, by id range", async () => {
    const f = await fixture();
    const ids: number[] = [];
    for (let i = 0; i < 4; i++) ids.push((await f.send({ text: `m${i}` })).id);
    await claim(f, ids[0], "dev");
    await claim(f, ids[2], "qa");
    await claim(f, ids[3], "lead");
    await release(f, ids[3], "lead");
    await call(f.tenant, `/channels/work/messages/${ids[1]}/reactions`, f.keys.dev, "POST", {
      username: "dev",
      kind: "seen",
    });
    type Page = {
      reactions: { id: number }[];
      claims: { id: number; claim: Claim }[];
      hasMore: boolean;
      nextAfter?: number;
    };
    const all = (await (await call(f.tenant, "/channels/work/reactions", f.keys.qa)).json()) as Page;
    expect(all.hasMore).toBe(false);
    expect(all.reactions.map((r) => r.id)).toEqual([ids[1]]);
    expect(all.claims.map((c) => [c.id, c.claim.username])).toEqual([
      [ids[0], "dev"],
      [ids[2], "qa"],
    ]);
    expect(Number.isFinite(Date.parse(all.claims[0].claim.claimedAt))).toBe(true);
    const range = (await (
      await call(f.tenant, `/channels/work/reactions?after=${ids[0]}&before=${ids[3]}`, f.keys.qa)
    ).json()) as Page;
    expect(range.claims.map((c) => c.id)).toEqual([ids[2]]);
  });

  it("pages the refresh at the lower cut-off, so a page covers every id up to nextAfter", async () => {
    const tenant = `claim-page-${crypto.randomUUID()}`;
    const created = await exports.default.fetch(`https://msn.test/api/admin/tenants/${tenant}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${ADMIN}` },
    });
    const { token } = (await created.json()) as { token: string };
    await call(tenant, "/channels/work/messages", token, "POST", { username: "a", text: "seed" });
    // 520 claimed messages and one late reaction, written directly: the page holds 500.
    await runInDurableObject(
      env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", tenant])),
      (_i, state) => {
        for (let i = 0; i < 520; i++)
          state.storage.sql.exec(
            "INSERT INTO messages(channel, username, text, contentType, createdAt, digest, bytes, claimedBy, claimedAt) VALUES ('work', 'a', 'x', 'text', '2026-11-21T00:00:00.000Z', '', 1, 'a', '2026-11-21T00:00:01.000Z')",
          );
        state.storage.sql.exec(
          "INSERT INTO reactions(channel, messageId, kind, name, createdAt) VALUES ('work', 521, 'done', 'a', '2026-11-21T00:00:02.000Z')",
        );
      },
    );
    type Page = {
      reactions: { id: number }[];
      claims: { id: number }[];
      hasMore: boolean;
      nextAfter?: number;
    };
    const first = (await (await call(tenant, "/channels/work/reactions", token)).json()) as Page;
    expect(first.claims.length).toBe(500);
    expect(first.hasMore).toBe(true);
    expect(first.nextAfter).toBe(first.claims.at(-1)?.id);
    // The reaction lies past the cut-off, so it waits for the next page.
    expect(first.reactions).toEqual([]);
    const second = (await (
      await call(tenant, `/channels/work/reactions?after=${first.nextAfter}`, token)
    ).json()) as Page;
    expect(second.hasMore).toBe(false);
    expect(second.claims.length).toBe(20);
    expect(second.reactions.map((r) => r.id)).toEqual([521]);
  });

  it("adds two nullable columns without a schema version step", async () => {
    const f = await fixture();
    await f.send({ text: "x" });
    await runInDurableObject(
      env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", f.tenant])),
      (_i, state) => {
        const columns = state.storage.sql
          .exec<{ name: string; notnull: number }>("PRAGMA table_info(messages)")
          .toArray()
          .filter((column) => ["claimedBy", "claimedAt"].includes(column.name));
        expect(columns.map((column) => [column.name, column.notnull])).toEqual([
          ["claimedBy", 0],
          ["claimedAt", 0],
        ]);
        expect(
          state.storage.sql.exec<{ v: number }>("SELECT MAX(version) AS v FROM schema_version").one().v,
        ).toBe(20);
        expect(state.storage.sql.exec("SELECT claimedBy FROM messages").one()).toEqual({ claimedBy: null });
      },
    );
  });
});
