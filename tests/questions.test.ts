import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

// Ask a question with buttons (ADR 0065): a message may carry `choices` and `to`. The addressed
// name answers with a reply carrying `answer`. Only the first valid answer counts, and the server
// records it on the question as `answered`.

const call = (tenant: string, suffix = "", token?: string, method = "GET", input?: unknown, key?: string) =>
  exports.default.fetch(`https://msn.test/api/tenants/${tenant}${suffix}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(key ? { "Idempotency-Key": key } : {}),
      "Content-Type": "application/json",
    },
    ...(input ? { body: JSON.stringify(input) } : {}),
  });

type Answered = { id: number; choice: string; username: string; answeredAt: string };
type Message = {
  id: number;
  text: string;
  username: string;
  createdAt: string;
  to?: string;
  replyTo?: number;
  choices?: string[];
  answer?: string;
  answered?: Answered;
};
const adminDelete = (tenant: string, id: number) =>
  exports.default.fetch(`https://msn.test/api/admin/tenants/${tenant}/channels/work/messages/${id}`, {
    method: "DELETE",
    headers: { Authorization: "Bearer test-admin-secret-000000000000000000000" },
  });
type ErrorBody = { error: { code: string; message: string } };

async function fixture() {
  const tenant = `ask-${crypto.randomUUID()}`;
  const owner = (await (await call(tenant, "", undefined, "PUT", { username: "tomas" })).json()) as {
    token: string;
  };
  await call(tenant, "/channels/work", owner.token, "PUT");
  const invite = (await (
    await call(tenant, "/invites", owner.token, "POST", { channel: "work" })
  ).json()) as {
    code: string;
  };
  const agent = (await (
    await call(tenant, "/invites/redeem", undefined, "POST", { code: invite.code, username: "agent" })
  ).json()) as { token: string };
  // The owner's key is bound to "tomas"; an answer from tomas uses it, everything else the agent's.
  const tokenFor = (input: object) =>
    (input as { username?: string }).username === "tomas" ? owner.token : agent.token;
  const post = (input: object, key?: string, token = tokenFor(input)) =>
    call(tenant, "/channels/work/messages", token, "POST", { username: "agent", ...input }, key);
  const send = async (input: object, key?: string, token = tokenFor(input)) => {
    const response = await post(input, key, token);
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(201);
    return ((await response.json()) as { message: Message }).message;
  };
  const ask = () => send({ text: "Ship it?", to: "tomas", choices: ["yes", "no"] });
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
  const usage = () =>
    runInDurableObject(env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", tenant])), (_, state) =>
      state.storage.sql.exec<{ bytes: number }>("SELECT bytes FROM usage").one(),
    );
  return { tenant, owner: owner.token, agent: agent.token, post, send, ask, read, point, usage };
}

describe("ask a question with buttons (ADR 0065)", () => {
  it("stores choices, records the first answer on the question, and returns both on every read", async () => {
    const f = await fixture();
    const question = await f.ask();
    expect(question).toMatchObject({ to: "tomas", choices: ["yes", "no"] });
    expect("answered" in question).toBe(false);
    // A plain message has none of the new keys, so older clients see today's shape.
    const plain = await f.send({ text: "hello" });
    for (const key of ["choices", "answer", "answered"]) expect(key in plain).toBe(false);

    const reply = await f.send({ username: "tomas", text: "yes", replyTo: question.id, answer: "yes" });
    expect(reply).toMatchObject({ replyTo: question.id, answer: "yes", text: "yes" });
    const asked = await f.point(question.id);
    expect(asked.answered).toEqual({
      id: reply.id,
      choice: "yes",
      username: "tomas",
      answeredAt: reply.createdAt,
    });
    const page = await f.read();
    expect(page.find((m) => m.id === question.id)?.answered?.id).toBe(reply.id);
    expect(page.find((m) => m.id === reply.id)?.answer).toBe("yes");
  });

  it("lets an answer leave out text: the reply reads as the choice", async () => {
    const f = await fixture();
    const question = await f.ask();
    const reply = await f.send({ username: "tomas", replyTo: question.id, answer: "no" });
    expect(reply.text).toBe("no");
  });

  it("refuses bad choices and stores nothing", async () => {
    const f = await fixture();
    for (const input of [
      { choices: ["yes", "no"] },
      { choices: ["yes", "no"], to: null },
      { choices: ["yes"], to: "tomas" },
      { choices: ["a", "b", "c", "d", "e", "f", "g"], to: "tomas" },
      { choices: ["yes", "yes"], to: "tomas" },
      { choices: ["yes", " "], to: "tomas" },
      { choices: ["yes", 2], to: "tomas" },
      { choices: "yes,no", to: "tomas" },
      { choices: ["yes", "x".repeat(129)], to: "tomas" },
    ]) {
      const response = await f.post({ text: "Ship it?", ...input });
      expect(response.status, JSON.stringify(input).slice(0, 60)).toBe(400);
      expect(((await response.json()) as ErrorBody).error.code).toBe("invalid_choices");
    }
    expect(await f.read()).toEqual([]);
    // Six choices of 128 bytes each are allowed.
    const six = ["a", "b", "c", "d", "e", "x".repeat(128)];
    expect((await f.send({ text: "Pick", to: "tomas", choices: six })).choices).toEqual(six);
  });

  it("accepts only a listed choice, as a reply to a question, from the addressed name", async () => {
    const f = await fixture();
    const question = await f.ask();
    const plain = await f.send({ text: "not a question" });
    const cases: [object, number, string][] = [
      [{ answer: "yes" }, 400, "invalid_answer"],
      [{ answer: "yes", replyTo: plain.id }, 400, "not_a_question"],
      [{ answer: "maybe", replyTo: question.id }, 400, "invalid_answer"],
      [{ answer: "Yes", replyTo: question.id }, 400, "invalid_answer"],
      [{ answer: "", replyTo: question.id }, 400, "invalid_answer"],
      [{ answer: "yes", replyTo: question.id, choices: ["a", "b"], to: "x" }, 400, "invalid_answer"],
      [{ answer: "yes", replyTo: question.id, username: "agent" }, 403, "not_addressed"],
    ];
    for (const [input, status, code] of cases) {
      const response = await f.post({ username: "tomas", text: "yes", ...input });
      expect(response.status, JSON.stringify(input)).toBe(status);
      expect(((await response.json()) as ErrorBody).error.code).toBe(code);
    }
    expect((await f.point(question.id)).answered).toBeUndefined();
    expect((await f.read()).length).toBe(2);
  });

  it("counts only the first answer, and a retry of it replays", async () => {
    const f = await fixture();
    const question = await f.ask();
    const first = await f.send({ username: "tomas", replyTo: question.id, answer: "no" }, "tap-1");
    // The same tap retried (same key and body) replays instead of failing.
    const retry = await f.post({ username: "tomas", replyTo: question.id, answer: "no" }, "tap-1");
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as { message: Message }).message.id).toBe(first.id);
    for (const answer of ["yes", "no"]) {
      const late = await f.post({ username: "tomas", replyTo: question.id, answer });
      expect(late.status).toBe(409);
      const body = (await late.json()) as ErrorBody;
      expect(body.error.code).toBe("already_answered");
      expect(body.error.message).toContain(`message ${first.id}`);
    }
    expect((await f.point(question.id)).answered?.choice).toBe("no");
    // An ordinary reply without an answer is still fine after the question is answered.
    await f.send({ username: "tomas", text: "and thanks", replyTo: question.id });
  });

  it("lets two racing answers leave exactly one", async () => {
    const f = await fixture();
    const question = await f.ask();
    const responses = await Promise.all(
      ["yes", "no", "yes", "no"].map((answer) => f.post({ username: "tomas", replyTo: question.id, answer })),
    );
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409, 409, 409]);
    expect((await f.read()).filter((m) => m.answer).length).toBe(1);
  });

  it("lets a bound key answer only as its own name", async () => {
    const f = await fixture();
    const invite = (await (
      await call(f.tenant, "/invites", f.owner, "POST", { channel: "work" })
    ).json()) as {
      code: string;
    };
    const bob = (await (
      await call(f.tenant, "/invites/redeem", undefined, "POST", { code: invite.code, username: "bob" })
    ).json()) as { token: string };
    const toTomas = await f.ask();
    const toBob = await f.send({ text: "Merge?", to: "bob", choices: ["merge", "wait"] });
    // Bob's key cannot answer as tomas, even though tomas is addressed.
    const impersonated = await f.post(
      { username: "tomas", replyTo: toTomas.id, answer: "yes" },
      undefined,
      bob.token,
    );
    expect(impersonated.status).toBe(403);
    expect(((await impersonated.json()) as ErrorBody).error.code).toBe("username_bound");
    // As itself, it cannot answer a question addressed to tomas…
    const notBob = await f.post(
      { username: "bob", replyTo: toTomas.id, answer: "yes" },
      undefined,
      bob.token,
    );
    expect(notBob.status).toBe(403);
    expect(((await notBob.json()) as ErrorBody).error.code).toBe("not_addressed");
    // …and can answer its own.
    await f.send({ username: "bob", replyTo: toBob.id, answer: "wait" }, undefined, bob.token);
    expect((await f.point(toBob.id)).answered).toMatchObject({ username: "bob", choice: "wait" });
  });

  it("refuses to schedule a question or an answer", async () => {
    const f = await fixture();
    const question = await f.ask();
    const sendAt = new Date(Date.now() + 3_600_000).toISOString();
    for (const input of [
      { text: "Later?", to: "tomas", choices: ["yes", "no"], sendAt },
      { username: "tomas", replyTo: question.id, answer: "yes", sendAt },
    ]) {
      const response = await f.post(input);
      expect(response.status).toBe(400);
      expect(((await response.json()) as ErrorBody).error.code).toBe("invalid_send_at");
    }
  });

  it("keeps choices and the answer through edits, counts them as stored bytes, and scrubs them on delete", async () => {
    const f = await fixture();
    const before = (await f.usage()).bytes;
    const question = await f.ask();
    const asked = (await f.usage()).bytes - before;
    expect(asked).toBe(new TextEncoder().encode(`agentShip it?${JSON.stringify(["yes", "no"])}`).length);
    const edited = await call(f.tenant, `/channels/work/messages/${question.id}`, f.agent, "PATCH", {
      username: "agent",
      text: "Ship it today?",
    });
    expect(edited.status).toBe(200);
    expect(((await edited.json()) as { message: Message }).message.choices).toEqual(["yes", "no"]);
    const reply = await f.send({ username: "tomas", replyTo: question.id, answer: "yes" });
    // Deleting the answer reopens the question; the addressed name may answer again.
    expect((await adminDelete(f.tenant, reply.id)).status).toBe(204);
    expect((await f.point(question.id)).answered).toBeUndefined();
    const again = await f.send({ username: "tomas", replyTo: question.id, answer: "no" });
    expect((await f.point(question.id)).answered?.id).toBe(again.id);
    // Deleting the question scrubs its choices and answer record, and it can no longer be answered.
    expect((await adminDelete(f.tenant, question.id)).status).toBe(204);
    await runInDurableObject(
      env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", f.tenant])),
      (_, state) => {
        const row = state.storage.sql
          .exec<{ choices: string | null; answered: string | null }>(
            "SELECT choices, answered FROM messages WHERE id = ?",
            question.id,
          )
          .one();
        expect(row).toEqual({ choices: null, answered: null });
      },
    );
  });

  it("trims choices and answers and refuses control, direction and invisible characters", async () => {
    const f = await fixture();
    for (const choices of [
      ["yes", "yes "],
      ["yes", "no\nmaybe"],
      ["yes", "n\to"],
      ["yes", "n\u202Eo"],
      ["yes", "n\u200Bo"],
      ["yes", "n\u2028o"],
      ["yes", "n\uFEFFo"],
      ["yes", "no\u0085"],
    ]) {
      const response = await f.post({ text: "Q?", to: "tomas", choices });
      expect(response.status, JSON.stringify(choices)).toBe(400);
      expect(((await response.json()) as ErrorBody).error.code).toBe("invalid_choices");
    }
    // Surrounding spaces and a leading byte order mark go; joiners inside an emoji stay.
    const question = await f.send({
      text: "Q?",
      to: "tomas",
      choices: ["  yes ", "👍🏽", "👨\u200D💻", "\uFEFFok"],
    });
    expect(question.choices).toEqual(["yes", "👍🏽", "👨\u200D💻", "ok"]);
    const bad = await f.post({ username: "tomas", replyTo: question.id, answer: "y\u200Bes" });
    expect(bad.status).toBe(400);
    const reply = await f.send({ username: "tomas", replyTo: question.id, answer: " yes " });
    expect(reply).toMatchObject({ answer: "yes", text: "yes" });
  });

  it("matches the addressed name ignoring case and surrounding spaces, as unread counts do", async () => {
    const f = await fixture();
    const question = await f.send({ text: "Ship?", to: " Tomas ", choices: ["yes", "no"] });
    const reply = await f.send({ username: "tomas", replyTo: question.id, answer: "yes" });
    expect((await f.point(question.id)).answered).toMatchObject({ id: reply.id, username: "tomas" });
    const other = await f.send({ text: "Merge?", to: "TOMASZ", choices: ["a", "b"] });
    const refused = await f.post({ username: "tomas", replyTo: other.id, answer: "a" });
    expect(refused.status).toBe(403);
  });

  it("refuses to change the words of an answered question or of an answer", async () => {
    const f = await fixture();
    const question = await f.ask();
    const reply = await f.send({ username: "tomas", replyTo: question.id, answer: "yes" });
    const edit = (id: number, username: string, token: string, text: string) =>
      call(f.tenant, `/channels/work/messages/${id}`, token, "PATCH", { username, text });
    const asked = await edit(question.id, "agent", f.agent, "Delete prod?");
    expect(asked.status).toBe(409);
    expect(((await asked.json()) as ErrorBody).error.code).toBe("answered_locked");
    const answered = await edit(reply.id, "tomas", f.owner, "no");
    expect(answered.status).toBe(409);
    // Saving the same text is still a no-op success.
    expect((await edit(reply.id, "tomas", f.owner, "yes")).status).toBe(200);
    expect((await f.point(question.id)).text).toBe("Ship it?");
  });

  it("hashes a send without choices or answer exactly as before", async () => {
    const { payload } = await import("../src/store");
    expect(payload("a", "b", "text/plain", {})).toBe(JSON.stringify(["a", "b"]));
    expect(payload("a", "b", "text/plain", { quote: "q", replyTo: 1 })).toBe(
      JSON.stringify([JSON.stringify(["a", "b", "text/plain", 1, null]), { quote: "q" }]),
    );
    expect(payload("a", "b", "text/plain", { to: "t", choices: ["x", "y"] })).not.toBe(
      payload("a", "b", "text/plain", { to: "t", choices: ["y", "x"] }),
    );
  });
});
