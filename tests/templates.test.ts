import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { splitTeam, templateFromBoard } from "../src/templates";

// Saved board templates (ADR 0051): the owner saves a board's goal and personas as the
// workspace's own template, lists and deletes them. Nothing else of the board is copied.

declare module "cloudflare:workers" {
  interface ProvidedEnv extends Env {}
}
type Init = { method?: string; json?: unknown };
const call = (path: string, token: string | undefined, init: Init = {}) =>
  exports.default.fetch(`https://msn.test${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.json !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
  });
type Persona = { name: string; role: string };
type Template = {
  id: string;
  title: string;
  summary: string;
  goal: string;
  personas: Persona[];
  own: true;
  savedFrom: string;
  savedBy?: string;
  createdAt: string;
};

const TEAM_GOAL =
  "Ship the release\n\nTeam (Lead and reviewer):\n- Tomas: Plans and does the work, then asks the reviewer to check each result.\n- reviewer: Reviews each result the lead hands over, and approves it or lists what to fix.";

/** An owner with board `work` (made from a template, with a message and a watcher) and `plain`. */
async function fixture() {
  const tenant = `templates-${crypto.randomUUID()}`;
  const api = `/api/tenants/${tenant}`;
  const owner = (
    await (
      await call(api, undefined, { method: "PUT", json: { username: "human" } })
    ).json<{
      token: string;
    }>()
  ).token;
  const shared = "b".repeat(64);
  for (const [channel, credential, goal] of [
    ["work", shared, TEAM_GOAL],
    ["plain", "c".repeat(64), "Keep the docs current."],
  ])
    expect(
      (await call(`${api}/channels/${channel}/board`, owner, { method: "PUT", json: { credential, goal } }))
        .status,
    ).toBe(201);
  for (const [id, displayName] of [
    ["p1", "Tomas"],
    ["p2", "reviewer"],
    ["p3", "Night Owl"],
  ])
    expect(
      (await call(`${api}/channels/work/personas/${id}`, shared, { method: "PUT", json: { displayName } }))
        .status,
    ).toBe(201);
  expect(
    (
      await call(`${api}/channels/work/messages`, shared, {
        method: "POST",
        json: { username: "Tomas", text: "secret plan" },
      })
    ).status,
  ).toBe(201);
  const invite = await (await call(`${api}/invites`, owner, { method: "POST", json: { watch: true } })).json<{
    code: string;
  }>();
  const watcher = await (
    await call(`${api}/invites/redeem`, undefined, {
      method: "POST",
      json: { code: invite.code, username: "watcher" },
    })
  ).json<{ token: string }>();
  return { tenant, api, owner, shared, watcher: watcher.token };
}

describe("saved board templates", () => {
  it("saves a board's goal and team, and lists it", async () => {
    const f = await fixture();
    const saved = await call(`${f.api}/templates/release-team`, f.owner, {
      method: "PUT",
      json: { channel: "work" },
    });
    expect(saved.status).toBe(201);
    const { template } = await saved.json<{ template: Template }>();
    expect(template).toMatchObject({
      id: "release-team",
      title: "release-team",
      own: true,
      savedFrom: "work",
      savedBy: "human",
      goal: "Ship the release",
      personas: [
        { name: "lead", role: "Plans and does the work, then asks the reviewer to check each result." },
        {
          name: "reviewer",
          role: "Reviews each result the lead hands over, and approves it or lists what to fix.",
        },
        { name: "night-owl", role: "Works toward the board goal and reports progress on the board." },
      ],
    });
    // Nothing but the goal and personas: no messages, keys, credentials or persona IDs.
    const raw = JSON.stringify(template);
    for (const leak of ["secret plan", f.shared, "p1", "p3"]) expect(raw).not.toContain(leak);
    const list = await (await call(`${f.api}/templates`, f.owner)).json<{
      templates: Template[];
      max: number;
    }>();
    expect(list.max).toBe(20);
    expect(list.templates.map((t) => t.id)).toEqual(["release-team"]);
    const stored = await runInDurableObject(
      env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", f.tenant])),
      (_, state) => state.storage.sql.exec("SELECT * FROM board_templates").toArray(),
    );
    expect(Object.keys(stored[0]).sort()).toEqual(
      ["createdAt", "goal", "name", "personas", "savedBy", "savedFrom"].sort(),
    );
  });

  it("refuses a duplicate name unless replace is true, then deletes", async () => {
    const f = await fixture();
    const put = (json: unknown) => call(`${f.api}/templates/mine`, f.owner, { method: "PUT", json });
    expect((await put({ channel: "work" })).status).toBe(201);
    const again = await put({ channel: "plain" });
    expect(again.status).toBe(409);
    expect((await again.json<{ error: { code: string } }>()).error.code).toBe("template_exists");
    const replaced = await put({ channel: "plain", replace: true });
    expect(replaced.status).toBe(200);
    expect((await replaced.json<{ template: Template }>()).template).toMatchObject({
      goal: "Keep the docs current.",
      savedFrom: "plain",
      personas: [{ name: "lead" }],
    });
    expect((await call(`${f.api}/templates/mine`, f.owner, { method: "DELETE" })).status).toBe(204);
    const gone = await call(`${f.api}/templates/mine`, f.owner, { method: "DELETE" });
    expect(gone.status).toBe(404);
    expect((await gone.json<{ error: { code: string } }>()).error.code).toBe("template_not_found");
    expect((await (await call(`${f.api}/templates`, f.owner)).json<{ templates: [] }>()).templates).toEqual(
      [],
    );
  });

  it("validates names, reserves built-in ids, needs a board and caps the count", async () => {
    const f = await fixture();
    const put = (name: string, json: unknown = { channel: "work" }) =>
      call(`${f.api}/templates/${name}`, f.owner, { method: "PUT", json });
    const code = async (response: Response) =>
      (await response.json<{ error: { code: string } }>()).error.code;
    expect(await code(await put("Bad Name"))).toBe("invalid_template_name");
    expect(await code(await put("x".repeat(41)))).toBe("invalid_template_name");
    const reserved = await put("lead-reviewer");
    expect(reserved.status).toBe(409);
    expect(await code(reserved)).toBe("template_name_reserved");
    expect(await code(await put("ok", { channel: "missing" }))).toBe("board_not_found");
    expect(await code(await put("ok", {}))).toBe("invalid_template");
    expect(await code(await put("ok", { channel: "work", replace: "yes" }))).toBe("invalid_template");
    for (let i = 0; i < 20; i++) expect((await put(`t${i}`)).status).toBe(201);
    const full = await put("t20");
    expect(full.status).toBe(409);
    expect(await code(full)).toBe("template_limit");
    // Replacing an existing one still works at the cap.
    expect((await put("t0", { channel: "plain", replace: true })).status).toBe(200);
  });

  it("refuses a board whose goal is too long", async () => {
    const f = await fixture();
    await call(`${f.api}/channels/long/board`, f.owner, {
      method: "PUT",
      json: { credential: "e".repeat(64), goal: "x".repeat(8001) },
    });
    const response = await call(`${f.api}/templates/long`, f.owner, {
      method: "PUT",
      json: { channel: "long" },
    });
    expect(response.status).toBe(413);
    expect((await response.json<{ error: { code: string } }>()).error.code).toBe("template_too_large");
  });

  it("is owner only: shared board keys and watch-only keys cannot save, list or delete", async () => {
    const f = await fixture();
    expect(
      (await call(`${f.api}/templates/kept`, f.owner, { method: "PUT", json: { channel: "work" } })).status,
    ).toBe(201);
    for (const [token, status, error] of [
      [f.shared, 403, "owner_required"],
      [f.watcher, 403, "watch_only"],
    ] as const) {
      const save = await call(`${f.api}/templates/mine`, token, { method: "PUT", json: { channel: "work" } });
      expect(save.status).toBe(status);
      expect((await save.json<{ error: { code: string } }>()).error.code).toBe(error);
      expect((await call(`${f.api}/templates/kept`, token, { method: "DELETE" })).status).toBe(403);
    }
    expect((await call(`${f.api}/templates`, f.shared)).status).toBe(403);
    expect((await call(`${f.api}/templates`, f.watcher)).status).toBe(403);
    expect((await call(`${f.api}/templates`, undefined)).status).toBe(401);
    // Another workspace's owner is a stranger here: 401, and its own list stays empty.
    const other = await fixture();
    expect((await call(`${f.api}/templates`, other.owner)).status).toBe(401);
    expect((await call(`${f.api}/templates/kept`, other.owner, { method: "DELETE" })).status).toBe(401);
    expect(
      (await (await call(`${other.api}/templates`, other.owner)).json<{ templates: [] }>()).templates,
    ).toEqual([]);
  });
});

describe("templateFromBoard", () => {
  it("splits a template goal into objective and team", () => {
    expect(splitTeam(TEAM_GOAL)).toEqual({
      objective: "Ship the release",
      team: [
        { name: "Tomas", role: "Plans and does the work, then asks the reviewer to check each result." },
        {
          name: "reviewer",
          role: "Reviews each result the lead hands over, and approves it or lists what to fix.",
        },
      ],
    });
    expect(splitTeam("Plain goal")).toBeNull();
    expect(splitTeam("Goal\n\nTeam (x):\nnot a persona line")).toBeNull();
  });

  it("takes the roster when the goal has no team, and renames the first persona lead", () => {
    expect(templateFromBoard("Do it", [{ displayName: "Ana" }, { displayName: "QA bot" }])).toEqual({
      goal: "Do it",
      personas: [
        { name: "lead", role: "Leads the work toward the board goal and reports progress on the board." },
        { name: "qa-bot", role: "Works toward the board goal and reports progress on the board." },
      ],
    });
    expect(templateFromBoard("Do it", []).personas.map((p) => p.name)).toEqual(["lead"]);
  });

  it("skips personas whose names collide or have no usable characters", () => {
    const t = templateFromBoard("Do it", [
      { displayName: "lead" },
      { displayName: "Worker" },
      { displayName: "worker" },
      { displayName: "🙂" },
    ]);
    expect(t.personas.map((p) => p.name)).toEqual(["lead", "worker"]);
  });
});
