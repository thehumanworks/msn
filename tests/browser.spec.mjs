import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";

const ADMIN = "browser-test-admin-000000000000000000000";
const cli = fileURLToPath(new URL("../scripts/msn.mjs", import.meta.url));
async function provision(request, bind) {
  const tenant = `browser-${crypto.randomUUID()}`;
  const response = await request.put(`/api/admin/tenants/${tenant}`, {
    headers: { Authorization: `Bearer ${ADMIN}` },
    ...(bind ? { data: bind } : {}),
  });
  expect(response.status()).toBe(201);
  const { token } = await response.json();
  return { tenant, token, headers: { Authorization: `Bearer ${token}` }, path: `/api/tenants/${tenant}` };
}
async function connect(page, t, name = "Tomas", { remember = true, live = true } = {}) {
  await page.goto("/");
  await page.locator("#live").evaluate((box, enabled) => {
    box.checked = enabled;
  }, live);
  await page.getByLabel("Workspace", { exact: true }).fill(t.tenant);
  await page.getByLabel("Access key").fill(t.token);
  await page.getByLabel("Your display name").fill(name);
  await page.getByLabel("Stay signed in on this device").setChecked(remember);
  await page.getByRole("button", { name: "Connect", exact: false }).click();
  await expect(page.locator("#workspace")).toBeVisible();
}
// Phones show one pane at a time; the back button is hidden on wide viewports.
async function channelsPane(page) {
  const back = page.getByRole("button", { name: "Back to channels" });
  if (await back.isVisible()) await back.click();
}
async function openChannel(page, name) {
  await channelsPane(page);
  await page.getByRole("button", { name: `# ${name}`, exact: true }).click();
  await expect(page.locator("#channel-title")).toHaveText(`# ${name}`);
}
async function disconnect(page) {
  await channelsPane(page);
  await page.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.locator("#welcome")).toBeVisible();
}
const stored = (page) => page.evaluate(() => [localStorage.length, sessionStorage.length]);

test("account connection opens every board and shared invitation adds a persona", async ({
  page,
  request,
  browser,
}, testInfo) => {
  const t = await provision(request, { username: "human" });
  for (const channel of ["work", "research"]) {
    const response = await request.put(`${t.path}/channels/${channel}/board`, {
      headers: t.headers,
      data: { credential: crypto.randomUUID().replaceAll("-", "").repeat(2), goal: `Goal for ${channel}` },
    });
    expect(response.status()).toBe(201);
  }
  await page.goto("/");
  await page.locator("#connection-file").setInputFiles({
    name: "account.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        url: new URL(page.url()).origin,
        tenant: t.tenant,
        token: t.token,
        username: "human",
        reader: "human",
      }),
    ),
  });
  await expect(page.locator("#workspace")).toBeVisible();
  await openChannel(page, "work");
  await page.locator("#board-settings").click();
  await expect(page.locator("#board-goal")).toHaveValue("Goal for work");
  await page.locator("#board-goal").fill("Complete the implementation and verify it");
  await page.locator("#board-form").getByRole("button", { name: "Save", exact: true }).click();
  await page.locator("#invite-channel").click();
  await expect(page.locator("#invite-title")).toHaveText("Shared access to # work");
  const link = await page.locator("#invite-link").inputValue();
  expect(link).toContain("#board=");
  await page.locator("#close-invite").click();
  const guest = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const other = await guest.newPage();
    await other.goto(link);
    await other.locator("#username").fill("reviewer");
    await other.locator("#entry-submit").click();
    await expect(other.locator("#workspace")).toBeVisible();
    await expect(other.locator("#identity-note")).toHaveText("Persona · shared channel access");
    await other.locator("#message").fill("Review started");
    await other.locator("#send").click();
    await expect(page.locator("#messages")).toContainText("Review started");
    await channelsPane(other);
    await expect(other.getByRole("button", { name: "# research", exact: true })).toHaveCount(0);
  } finally {
    await guest.close();
  }
  await page.screenshot({ path: testInfo.outputPath("message-board.png"), fullPage: true });
});

test("an owner starts a ready board from a template in one step", async ({ page, request }, testInfo) => {
  const t = await provision(request, { username: "human" });
  const file = (data) => ({
    name: "connection.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ url: new URL(page.url()).origin, ...data })),
  });
  await page.goto("/");
  await page
    .locator("#connection-file")
    .setInputFiles(file({ tenant: t.tenant, token: t.token, username: "human", reader: "human" }));
  await expect(page.locator("#workspace")).toBeVisible();
  await expect(page.locator("#channels")).toContainText("Start one from a template");
  await page.getByRole("button", { name: "Start a board from a template" }).click();
  const dialog = page.locator("#template-dialog");
  await expect(dialog).toBeVisible();
  // Lead and reviewer is preselected; every template shows its team.
  await expect(dialog.getByRole("radio", { name: /Lead and reviewer/ })).toBeChecked();
  await expect(dialog.locator(".template-choice")).toHaveCount(3);
  await expect(dialog).toContainText("lead · worker-1 · worker-2 · worker-3");
  await dialog.getByRole("radio", { name: /Lead and three workers/ }).check();
  await expect(page.locator("#template-goal")).toHaveAttribute(
    "placeholder",
    "Split the project into tasks, finish every task and verify the result.",
  );
  await page.locator("#template-channel").fill("launch");
  await page.locator("#template-goal").fill("Ship the launch page");
  await page.screenshot({ path: testInfo.outputPath("template-picker.png") });
  await dialog.getByRole("button", { name: "Create board" }).click();
  await expect(page.locator("#template-ready")).toHaveText("# launch is ready with 4 agents");
  await expect(page.locator("#template-commands")).toContainText(
    "msn board connect launch --name worker-2 --save-as launch-worker-2",
  );
  await expect(page.locator("#template-commands")).toContainText(
    "msn --profile launch-lead run launch --harness codex",
  );
  await page.screenshot({ path: testInfo.outputPath("template-ready.png") });
  await page.locator("#close-template").click();
  await expect(page.locator("#channel-title")).toHaveText("# launch");

  const board = await (await request.get(`${t.path}/channels/launch/board`, { headers: t.headers })).json();
  expect(board.board.goal).toBe(
    [
      "Ship the launch page",
      "",
      "Team (Lead and three workers):",
      "- lead: Splits the work into tasks, assigns them, checks finished tasks and reports progress.",
      "- worker-1: Claims a task, finishes it with evidence and reports to the lead.",
      "- worker-2: Claims a task, finishes it with evidence and reports to the lead.",
      "- worker-3: Claims a task, finishes it with evidence and reports to the lead.",
    ].join("\n"),
  );
  const roster = await (
    await request.get(`${t.path}/channels/launch/personas`, { headers: t.headers })
  ).json();
  expect(roster.personas.map((p) => p.displayName).sort()).toEqual([
    "lead",
    "worker-1",
    "worker-2",
    "worker-3",
  ]);

  // A taken name is explained in the dialog, not hidden behind it.
  await channelsPane(page);
  await page.getByRole("button", { name: "Start a board from a template" }).click();
  await page.locator("#template-channel").fill("launch");
  await dialog.getByRole("button", { name: "Create board" }).click();
  await expect(page.locator("#template-error")).toHaveText(
    "A board with this name already exists. Choose another name.",
  );
  await page.locator("#close-template").click();

  // An agent with the shared channel connection cannot create boards, so it sees no picker.
  const shared = await (
    await request.get(`${t.path}/channels/launch/board/connection`, { headers: t.headers })
  ).json();
  await channelsPane(page);
  await page.getByRole("button", { name: "Disconnect" }).click();
  await page
    .locator("#connection-file")
    .setInputFiles(file({ tenant: t.tenant, token: shared.token, username: "worker-1", reader: "worker-1" }));
  await expect(page.locator("#workspace")).toBeVisible();
  await channelsPane(page);
  await expect(page.getByRole("button", { name: "Start a board from a template" })).toBeHidden();
});

test("a template board whose persona setup fails still shows how to finish it", async ({ page, request }) => {
  const t = await provision(request, { username: "human" });
  await page.goto("/");
  await page.locator("#connection-file").setInputFiles({
    name: "account.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        url: new URL(page.url()).origin,
        tenant: t.tenant,
        token: t.token,
        username: "human",
      }),
    ),
  });
  await expect(page.locator("#workspace")).toBeVisible();
  let personas = 0;
  await page.route("**/channels/half/personas/*", (route) =>
    ++personas === 2
      ? route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: { code: "unavailable", message: "Try again later." } }),
        })
      : route.continue(),
  );
  await page.getByRole("button", { name: "Start a board from a template" }).click();
  await page.locator("#template-channel").fill("half");
  await page.locator("#template-dialog").getByRole("button", { name: "Create board" }).click();
  await expect(page.locator("#template-ready")).toHaveText("# half is ready with 2 agents");
  await expect(page.locator("#template-partial")).toHaveText(
    "Some agents were not added yet (Try again later.). The connect commands below add them.",
  );
  await expect(page.locator("#template-commands")).toContainText(
    "msn board connect half --name reviewer --save-as half-reviewer",
  );
  const roster = await (await request.get(`${t.path}/channels/half/personas`, { headers: t.headers })).json();
  expect(roster.personas.map((p) => p.displayName)).toEqual(["lead"]);
});

test("human and CLI agent exchange messages live; poll, reread and admin deletion work", async ({
  page,
  request,
  baseURL,
}, testInfo) => {
  const t = await provision(request);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.screenshot({ path: testInfo.outputPath("welcome.png"), fullPage: true });
  await connect(page, t);
  await page.getByLabel("New channel name").fill("general");
  await page.getByRole("button", { name: "Create channel" }).click();
  await expect(page.locator("#channel-title")).toHaveText("# general");
  await page.getByLabel("Message", { exact: true }).fill("Hello agent");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.locator(".message p")).toHaveText("Hello agent");
  const agentEnv = {
    ...process.env,
    MSN_URL: baseURL,
    MSN_TENANT: t.tenant,
    MSN_TOKEN: t.token,
    MSN_WORKSPACE_TENANT: t.tenant,
    MSN_WORKSPACE_TOKEN: t.token,
    MSN_USERNAME: "planner-agent",
  };
  const received = await promisify(execFile)(process.execPath, [cli, "poll", "general"], { env: agentEnv });
  const history = JSON.parse(received.stdout);
  expect(history.messages[0]).toMatchObject({
    username: "Tomas",
    channel: "general",
    tenant: t.tenant,
    text: "Hello agent",
  });
  await promisify(execFile)(
    process.execPath,
    [cli, "send", "general", "--text", "Hello human", "--key", "agent-reply"],
    { env: agentEnv },
  );
  await expect(page.locator(".message p")).toHaveText(["Hello agent", "Hello human"]);
  await expect(page.locator(".message time").first()).toHaveAttribute("datetime", /T.*Z$/);
  // An agent command message on the same channel as the human-readable lines.
  await promisify(execFile)(
    process.execPath,
    [cli, "send", "general", "--json", '{"op":"ping","task":42}', "--key", "agent-cmd"],
    { env: agentEnv },
  );
  await expect(page.locator(".message pre")).toHaveText('{\n  "op": "ping",\n  "task": 42\n}');
  await expect(page.locator(".message-kind")).toHaveText("application/json");
  const typed = await promisify(execFile)(process.execPath, [cli, "poll", "general"], { env: agentEnv });
  expect(JSON.parse(typed.stdout).messages.map((m) => m.contentType)).toEqual([
    "text/plain",
    "text/plain",
    "application/json",
  ]);
  const invalid = await promisify(execFile)(process.execPath, [cli, "send", "general", "--json", '{"op":'], {
    env: agentEnv,
  }).catch((error) => error);
  expect(invalid.code).toBe(2);
  await page.getByLabel("Live", { exact: true }).uncheck();
  await request.post(`${t.path}/channels/general/messages`, {
    headers: t.headers,
    data: { username: "other", text: "manual poll" },
  });
  await page.getByRole("button", { name: "Poll once" }).click();
  await expect(page.locator(".message p")).toHaveText(["Hello agent", "Hello human", "manual poll"]);
  await page.getByRole("button", { name: "Reread" }).click();
  await expect(page.locator(".message")).toHaveCount(4);
  await request.delete(`/api/admin/tenants/${t.tenant}/channels/general/messages/${history.messages[0].id}`, {
    headers: { Authorization: `Bearer ${ADMIN}` },
  });
  await page.getByRole("button", { name: "Reread" }).click();
  await expect(page.locator(".message p")).toHaveText(["Hello human", "manual poll"]);
  await page.screenshot({ path: testInfo.outputPath("conversation.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  await disconnect(page);
  await expect(page.locator("#token")).toHaveValue("");
  await expect(page.locator(".message")).toHaveCount(0);
  expect(await stored(page)).toEqual([0, 0]);
});

test("untrusted content is plain text; channel switches ignore late polls; keys persist only when asked", async ({
  page,
  request,
}) => {
  const t = await provision(request);
  const attack = '<img src=x onerror="window.pwned=true">';
  await request.post(`${t.path}/channels/alpha/messages`, {
    headers: t.headers,
    data: { username: "<script>alert(1)</script>", text: attack, to: attack },
  });
  const structuredAttack = JSON.stringify({
    op: "notify",
    html: attack,
    script: "<script>alert(1)</script>",
  });
  await request.post(`${t.path}/channels/alpha/messages`, {
    headers: t.headers,
    data: { username: "agent", text: structuredAttack, contentType: "application/json" },
  });
  await request.post(`${t.path}/channels/beta/messages`, {
    headers: t.headers,
    data: { username: "agent", text: "beta only" },
  });
  await connect(page, t, "Tomas", { remember: false });
  await expect(page.locator(".message p")).toHaveText(attack);
  await expect(page.locator(".message-annotation").first()).toHaveText(`To: ${attack}`);
  await expect(page.locator(".message pre")).toHaveText(
    JSON.stringify(JSON.parse(structuredAttack), null, 2),
  );
  await expect(page.locator(".message img, .message script")).toHaveCount(0);
  expect(await page.evaluate(() => window.pwned)).toBeUndefined();
  expect(await page.evaluate(() => document.querySelector(".message pre").children.length)).toBe(0);
  await openChannel(page, "beta");
  await request.post(`${t.path}/channels/alpha/messages`, {
    headers: t.headers,
    data: { username: "agent", text: "late alpha" },
  });
  await expect(page.locator(".message p")).toHaveText("beta only");
  expect(await stored(page)).toEqual([0, 0]);
  await page.reload();
  await expect(page.locator("#welcome")).toBeVisible();
  await expect(page.locator("#token")).toHaveValue("");
  await expect(page.locator("#workspace")).toBeHidden();
});

test("remembered credentials reconnect on reload, restore the last channel, and are forgotten on disconnect or rejection", async ({
  page,
  request,
}) => {
  const t = await provision(request);
  await request.put(`${t.path}/channels/alpha`, { headers: t.headers });
  await request.put(`${t.path}/channels/beta`, { headers: t.headers });
  await connect(page, t, "Tomas");
  await expect(page.locator("#channel-title")).toHaveText("# alpha");
  await openChannel(page, "beta");
  await page.reload();
  await expect(page.locator("#workspace")).toBeVisible();
  await expect(page.locator("#welcome")).toBeHidden();
  await expect(page.locator("#channel-title")).toHaveText("# beta");
  await expect(page.locator("#display-name")).toHaveText("Tomas");
  await expect(page.locator("#token")).toHaveValue("");
  await page.getByLabel("Message", { exact: true }).fill("still me");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.locator(".message p")).toHaveText(["still me"]);
  const history = await request.get(`${t.path}/channels/beta/messages`, { headers: t.headers });
  expect((await history.json()).messages[0]).toMatchObject({ username: "Tomas", text: "still me" });
  // Pause live so this specifically exercises rejection during remembered reconnect.
  await page.getByLabel("Live", { exact: true }).uncheck();
  // A rotated key invalidates what the browser remembered: show the form, prefilled except for the key.
  const rotated = await request.post(`/api/admin/tenants/${t.tenant}/token`, {
    headers: { Authorization: `Bearer ${ADMIN}` },
  });
  expect(rotated.status()).toBe(200);
  await page.reload();
  await expect(page.locator("#welcome")).toBeVisible();
  await expect(page.locator("#status")).toContainText("invalid access key");
  await expect(page.getByLabel("Workspace", { exact: true })).toHaveValue(t.tenant);
  await expect(page.getByLabel("Your display name")).toHaveValue("Tomas");
  expect(await stored(page)).toEqual([0, 0]);
  await page.reload();
  await expect(page.locator("#welcome")).toBeVisible();
  await expect(page.getByLabel("Workspace", { exact: true })).toHaveValue("");
  const { token } = await rotated.json();
  await connect(page, { ...t, token }, "Tomas");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("msn.session")))).toEqual({
    tenant: t.tenant,
    token,
    username: "Tomas",
  });
  await disconnect(page);
  expect(await stored(page)).toEqual([0, 0]);
  await page.reload();
  await expect(page.locator("#welcome")).toBeVisible();
  await expect(page.locator("#workspace")).toBeHidden();
});

test("network-uncertain sends preserve drafts and reuse idempotency keys", async ({ page, request }) => {
  const t = await provision(request);
  await request.put(`${t.path}/channels/general`, { headers: t.headers });
  await connect(page, t);
  let first = true;
  const keys = [];
  const recipients = [];
  await page.route("**/channels/general/messages", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    keys.push(route.request().headers()["idempotency-key"]);
    recipients.push(route.request().postDataJSON().to);
    if (first) {
      first = false;
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await page.getByLabel("To", { exact: true }).fill("review-agent");
  await page.getByLabel("Message", { exact: true }).fill("uncertain");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.locator("#status")).toContainText("draft is preserved");
  await expect(page.locator("#message")).toHaveValue("uncertain");
  await expect(page.locator("#recipient")).toHaveValue("review-agent");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.locator("#message")).toHaveValue("");
  await expect(page.locator("#recipient")).toHaveValue("");
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  expect(recipients).toEqual(["review-agent", "review-agent"]);
  const result = await request.get(`${t.path}/channels/general/messages`, { headers: t.headers });
  expect((await result.json()).messages).toMatchObject([{ to: "review-agent" }]);
});

test("editing an uncertain recipient creates a new logical send and retry key", async ({ page, request }) => {
  const t = await provision(request);
  await request.put(`${t.path}/channels/general`, { headers: t.headers });
  await connect(page, t);
  const keys = [];
  let first = true;
  await page.route("**/channels/general/messages", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    keys.push(route.request().headers()["idempotency-key"]);
    if (first) {
      first = false;
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await page.getByLabel("To", { exact: true }).fill(" agent-one ");
  await page.getByLabel("Message", { exact: true }).fill("same text");
  await page.getByRole("button", { name: "Send message" }).click();
  // A concurrent long-poll can replace transient status text. Assert the actual preserved
  // draft after the failed send settles; the test below verifies the new idempotency key.
  await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("same text");
  await expect(page.getByLabel("To", { exact: true })).toHaveValue(" agent-one ");
  await page.getByLabel("To", { exact: true }).fill("agent-two");
  await page.getByRole("button", { name: "Send message" }).click();
  // Wait for the second send to finish (the draft clears on success) before reading the server.
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("To", { exact: true })).toHaveValue("");
  expect(keys).toHaveLength(2);
  expect(keys[1]).not.toBe(keys[0]);
  const result = await request.get(`${t.path}/channels/general/messages`, { headers: t.headers });
  expect((await result.json()).messages.map((message) => message.to)).toEqual([" agent-one ", "agent-two"]);
});

for (const editedField of ["message", "recipient"]) {
  test(`editing only ${editedField} during a send preserves the complete draft`, async ({
    page,
    request,
  }) => {
    const t = await provision(request);
    await request.put(`${t.path}/channels/general`, { headers: t.headers });
    await connect(page, t);
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    let started;
    const sent = new Promise((resolve) => {
      started = resolve;
    });
    await page.route("**/channels/general/messages", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const response = await route.fetch();
      started();
      await held;
      await route.fulfill({ response });
    });
    await page.getByLabel("To", { exact: true }).fill("first-agent");
    await page.getByLabel("Message", { exact: true }).fill("first draft");
    await page.getByRole("button", { name: "Send message" }).click();
    await sent;
    await page.locator(`#${editedField}`).fill(editedField === "message" ? "next draft" : "next-agent");
    release();
    // Wait for the completed request, then assert the unchanged half was preserved too.
    await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();
    await expect(page.locator("#recipient")).toHaveValue(
      editedField === "recipient" ? "next-agent" : "first-agent",
    );
    await expect(page.locator("#message")).toHaveValue(
      editedField === "message" ? "next draft" : "first draft",
    );
  });
}

test("channel-scoped drafts and retry keys survive navigation; late sends cannot clear another draft", async ({
  page,
  request,
}) => {
  const t = await provision(request);
  await request.put(`${t.path}/channels/alpha`, { headers: t.headers });
  await request.put(`${t.path}/channels/beta`, { headers: t.headers });
  await connect(page, t);
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let intercepted;
  const started = new Promise((resolve) => {
    intercepted = resolve;
  });
  const keys = [];
  let first = true;
  await page.route("**/channels/alpha/messages", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    keys.push(route.request().headers()["idempotency-key"]);
    if (first) {
      first = false;
      await route.fetch();
      intercepted();
      await held;
      await route.abort("failed");
    } else await route.continue();
  });
  await page.getByLabel("To", { exact: true }).fill("alpha-agent");
  await page.getByLabel("Message", { exact: true }).fill("alpha uncertain");
  await page.getByRole("button", { name: "Send message" }).click();
  await started;
  await openChannel(page, "beta");
  await expect(page.locator("#message")).toHaveValue("");
  await expect(page.locator("#recipient")).toHaveValue("");
  await page.getByLabel("To", { exact: true }).fill("beta-agent");
  await page.getByLabel("Message", { exact: true }).fill("beta draft");
  release();
  await expect(page.locator("#message")).toHaveValue("beta draft");
  await expect(page.locator("#recipient")).toHaveValue("beta-agent");
  await openChannel(page, "alpha");
  await expect(page.locator("#message")).toHaveValue("alpha uncertain");
  await expect(page.locator("#recipient")).toHaveValue("alpha-agent");
  await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.locator("#message")).toHaveValue("");
  await expect(page.locator("#recipient")).toHaveValue("");
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  await openChannel(page, "beta");
  await expect(page.locator("#message")).toHaveValue("beta draft");
  await expect(page.locator("#recipient")).toHaveValue("beta-agent");
  const history = await request.get(`${t.path}/channels/alpha/messages`, { headers: t.headers });
  expect((await history.json()).messages).toHaveLength(1);
});

test("a bound access key locks the display name; a prefix key rejects other names before connecting", async ({
  page,
  request,
}) => {
  const bound = await provision(request, { username: "thehuman" });
  await request.put(`${bound.path}/channels/general`, { headers: bound.headers });
  await connect(page, bound, "impostor");
  await expect(page.locator("#display-name")).toHaveText("thehuman");
  await expect(page.locator("#identity-note")).toHaveText("Display name · bound to your access key");
  await page.getByLabel("Message", { exact: true }).fill("sent under my bound name");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.locator(".message strong")).toHaveText(["thehuman"]);
  // Disconnect lives in the channels pane, which a phone hides while a conversation is open.
  await disconnect(page);
  await expect(page.locator("#username")).toHaveValue("thehuman");
  const prefixed = await provision(request, { usernamePrefix: "agent-" });
  await page.getByLabel("Workspace", { exact: true }).fill(prefixed.tenant);
  await page.getByLabel("Access key").fill(prefixed.token);
  await page.getByLabel("Your display name").fill("human");
  await page.getByRole("button", { name: "Connect", exact: false }).click();
  await expect(page.locator("#status")).toContainText("starting with “agent-”");
  await expect(page.locator("#welcome")).toBeVisible();
  await page.getByLabel("Your display name").fill("agent-7");
  await page.getByRole("button", { name: "Connect", exact: false }).click();
  await expect(page.locator("#workspace")).toBeVisible();
  await expect(page.locator("#identity-note")).toContainText("requires the prefix “agent-”");
  const denied = await request.post(`${prefixed.path}/channels/general/messages`, {
    headers: prefixed.headers,
    data: { username: "human", text: "spoof" },
  });
  expect(denied.status()).toBe(403);
  expect((await denied.json()).error.code).toBe("username_bound");
});

test("invalid credentials show actionable errors and public agent guide is available", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Workspace", { exact: true }).fill("unknown");
  await page.getByLabel("Access key").fill("wrong-key-000000000000000000000000000");
  await page.getByLabel("Your display name").fill("human");
  await page.getByRole("button", { name: "Connect", exact: false }).click();
  await expect(page.locator("#status")).toContainText("invalid access key");
  await page.getByRole("link", { name: "API & agent quickstart" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("One channel. Every participant.");
});

async function populatedWorkspace(request) {
  const t = await provision(request);
  for (const name of ["alpha", "beta"]) {
    await request.post(`${t.path}/channels/${name}/messages`, {
      headers: t.headers,
      data: { username: "agent", text: `${name} private history` },
    });
  }
  return t;
}

async function expectEndedSession(page) {
  await expect(page.locator("#welcome")).toBeVisible();
  await expect(page.locator("#workspace")).toBeHidden();
  await expect(page.locator("#status")).toContainText("Enter a valid access key to reconnect");
  await expect(page.locator("#token")).toHaveValue("");
  await expect(page.locator("#message")).toHaveValue("");
  await expect(page.locator("#new-channel")).toHaveValue("");
  await expect(page.locator(".message, #channels button")).toHaveCount(0);
  await expect(page.locator("#display-name")).toBeEmpty();
  await expect(page.locator("#cursor")).toHaveText("Cursor 0");
  await expect(page.locator("#live")).not.toBeChecked();
  expect(await stored(page)).toEqual([0, 0]);
}

test("revocation while connected clears history, drafts and remembered credentials without a reload", async ({
  page,
  request,
}) => {
  const t = await populatedWorkspace(request);
  await connect(page, t);
  await expect(page.locator(".message p")).toHaveText("alpha private history");
  await page.locator("#message").fill("private alpha draft");
  await openChannel(page, "beta");
  await expect(page.locator(".message p")).toHaveText("beta private history");
  await page.locator("#message").fill("private beta draft");
  await page.getByLabel("Live", { exact: true }).uncheck();
  const rotated = await request.post(`/api/admin/tenants/${t.tenant}/token`, {
    headers: { Authorization: `Bearer ${ADMIN}` },
  });
  expect(rotated.status()).toBe(200);
  // Start a fresh live request with the revoked key; no reload is needed.
  await page.getByLabel("Live", { exact: true }).check();
  await expectEndedSession(page);
  const { token } = await rotated.json();
  await page.locator("#token").fill(token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator("#workspace")).toBeVisible();
  await expect(page.locator("#message")).toHaveValue("");
  await openChannel(page, "beta");
  await expect(page.locator("#message")).toHaveValue("");
});

for (const action of ["poll", "refresh", "create", "send"]) {
  test(`a non-JSON 401 from active ${action} immediately ends the whole session`, async ({
    page,
    request,
  }) => {
    const t = await populatedWorkspace(request);
    await connect(page, t);
    await expect(page.locator(".message p")).toHaveText("alpha private history");
    await page.locator("#message").fill("private draft");
    let denied = 0;
    await page.route("**/api/tenants/**", async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const matches =
        (action === "poll" && url.searchParams.get("wait") === "0") ||
        (action === "refresh" && url.pathname.endsWith("/channels")) ||
        (action === "create" && req.method() === "PUT") ||
        (action === "send" && req.method() === "POST");
      if (!matches) return route.continue();
      denied++;
      await route.fulfill({ status: 401, contentType: "text/plain", body: "no JSON" });
    });
    if (action === "poll") await page.getByRole("button", { name: "Poll once" }).click();
    if (action === "send") await page.getByRole("button", { name: "Send message" }).click();
    if (action === "refresh" || action === "create") {
      await channelsPane(page);
      if (action === "refresh") await page.getByRole("button", { name: "Refresh channels" }).click();
      else {
        await page.locator("#new-channel").fill("private-channel");
        await page.getByRole("button", { name: "Create channel" }).click();
      }
    }
    await expectEndedSession(page);
    expect(denied).toBe(1);
  });
}

for (const reconnect of [false, true]) {
  test(`a delayed send 401 ${reconnect ? "cannot invalidate a newer connection" : "invalidates the same connection after channel navigation"}`, async ({
    page,
    request,
  }) => {
    const t = await populatedWorkspace(request);
    await connect(page, t);
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    let intercepted;
    const started = new Promise((resolve) => {
      intercepted = resolve;
    });
    await page.route("**/channels/alpha/messages", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      intercepted();
      await held;
      await route.fulfill({ status: 401, json: { error: { message: "old invalid access key" } } });
    });
    await page.locator("#message").fill("old send");
    await page.getByRole("button", { name: "Send message" }).click();
    await started;
    if (reconnect) {
      await disconnect(page);
      await page.locator("#token").fill(t.token);
      await page.getByRole("button", { name: "Connect", exact: true }).click();
      await expect(page.locator("#workspace")).toBeVisible();
    }
    await openChannel(page, "beta");
    await expect(page.locator(".message p")).toHaveText("beta private history");
    await page.locator("#message").fill("new draft");
    const response = page.waitForResponse((r) => r.request().method() === "POST" && r.status() === 401);
    release();
    await response;
    if (reconnect) {
      // Flush the response body / fetch continuation before checking the new connection.
      await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)));
      await expect(page.locator("#workspace")).toBeVisible();
      await expect(page.locator("#message")).toHaveValue("new draft");
      await expect(page.locator(".message p")).toHaveText("beta private history");
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem("msn.session")).token)).toBe(t.token);
      await expect(page.locator("#status")).not.toContainText("invalid access key");
    } else await expectEndedSession(page);
  });
}

test("username_bound preserves the connected session, draft and safe retry; origin rejection only pauses live", async ({
  page,
  request,
}) => {
  const t = await populatedWorkspace(request);
  await connect(page, t);
  await expect(page.locator(".message p")).toHaveText("alpha private history");
  const keys = [];
  await page.route("**/channels/alpha/messages", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    keys.push(route.request().headers()["idempotency-key"]);
    if (keys.length > 1) return route.continue();
    await route.fulfill({
      status: 403,
      json: { error: { code: "username_bound", message: "This access key may only send as agent." } },
    });
  });
  await page.locator("#message").fill("preserved bound draft");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.locator("#status")).toContainText("draft is preserved");
  await expect(page.locator("#workspace")).toBeVisible();
  await expect(page.locator("#live")).toBeChecked();
  await expect(page.locator("#message")).toHaveValue("preserved bound draft");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("msn.session")).token)).toBe(t.token);
  await openChannel(page, "beta");
  await openChannel(page, "alpha");
  await expect(page.locator("#message")).toHaveValue("preserved bound draft");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.locator("#message")).toHaveValue("");
  expect(keys).toHaveLength(2);
  expect(keys[1]).toBe(keys[0]);
  await page.locator("#message").fill("origin draft");
  await page.route("**/channels/alpha/messages?**", (route) =>
    route.fulfill({
      status: 403,
      json: { error: { code: "origin_forbidden", message: "Use a same-origin browser client." } },
    }),
  );
  await page.getByRole("button", { name: "Poll once" }).click();
  await expect(page.locator("#status")).toContainText("same-origin");
  await expect(page.locator("#workspace")).toBeVisible();
  await expect(page.locator("#message")).toHaveValue("origin draft");
  await expect(page.locator("#live")).not.toBeChecked();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("msn.session")).token)).toBe(t.token);
});

function messageRows(channel, count, start = 1) {
  return Array.from({ length: count }, (_, index) => ({
    id: start + index,
    channel,
    username: "agent",
    text: `${channel} row ${start + index}\nMessage body for reading and scrolling.`,
    contentType: "text/plain",
    createdAt: "2026-09-16T10:00:00.000Z",
  }));
}

async function mockHistory(page, t, rows, requests) {
  await page.route(`**${t.path}/channels/*/messages?**`, (route) => {
    const url = new URL(route.request().url());
    const name = url.pathname.split("/").at(-2);
    const after = Number(url.searchParams.get("after"));
    requests.push({ name, after });
    const available = rows[name].filter((m) => m.id > after);
    const messages = available.slice(0, 100);
    return route.fulfill({
      json: { messages, nextCursor: messages.at(-1)?.id ?? after, hasMore: available.length > 100 },
    });
  });
}

const scrollTop = (page) => page.locator("#messages").evaluate((box) => box.scrollTop);
const bottomGap = (page) =>
  page.locator("#messages").evaluate((box) => box.scrollHeight - box.clientHeight - box.scrollTop);

test("channels resume cached messages, cursor and scroll; reread resets only the selected channel", async ({
  page,
  request,
}) => {
  const t = await populatedWorkspace(request);
  const rows = { alpha: messageRows("alpha", 80), beta: messageRows("beta", 60, 101) };
  const requests = [];
  await mockHistory(page, t, rows, requests);
  // Disable live before connecting so every request has an explicit cause.
  await connect(page, t, "Tomas", { live: false });
  await expect(page.locator(".message")).toHaveCount(80);
  await expect.poll(() => bottomGap(page)).toBeLessThan(2);
  await page.locator("#messages").evaluate((box) => {
    box.scrollTop = 150;
  });
  await expect.poll(() => scrollTop(page)).toBe(150);
  await openChannel(page, "beta");
  await expect(page.locator(".message")).toHaveCount(60);
  await page.locator("#messages").evaluate((box) => {
    box.scrollTop = 220;
  });
  await openChannel(page, "alpha");
  await expect(page.locator("#status")).toHaveText("Polled #alpha · 0 new");
  await expect(page.locator(".message")).toHaveCount(80);
  await expect.poll(() => scrollTop(page)).toBe(150);
  expect(requests.at(-1)).toEqual({ name: "alpha", after: 80 });
  rows.alpha.push(...messageRows("alpha", 2, 81));
  await page.getByRole("button", { name: "Poll once" }).click();
  await expect(page.locator(".message")).toHaveCount(82);
  await expect.poll(() => scrollTop(page)).toBe(150);
  await expect(page.locator("#jump")).toBeVisible();
  await page.locator("#jump").click();
  await expect.poll(() => bottomGap(page)).toBeLessThan(2);
  await expect(page.locator("#jump")).toBeHidden();
  rows.alpha.push(...messageRows("alpha", 1, 83));
  await page.getByRole("button", { name: "Poll once" }).click();
  await expect(page.locator(".message")).toHaveCount(83);
  await expect.poll(() => bottomGap(page)).toBeLessThan(2);
  await page.getByRole("button", { name: "Reread", exact: true }).click();
  await expect(page.locator("#status")).toHaveText("Polled #alpha · 83 new");
  expect(requests.at(-1)).toEqual({ name: "alpha", after: 0 });
  await openChannel(page, "beta");
  await expect(page.locator("#status")).toHaveText("Polled #beta · 0 new");
  await expect(page.locator(".message")).toHaveCount(60);
  await expect.poll(() => scrollTop(page)).toBe(220);
  expect(requests.at(-1)).toEqual({ name: "beta", after: 160 });
  const disk = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(disk).not.toContain("Message body");
  expect(disk).not.toContain("row 1");
});

test("channel history is bounded to 1000 rows and pruning preserves the visible message", async ({
  page,
  request,
}) => {
  const t = await populatedWorkspace(request);
  const rows = { alpha: messageRows("alpha", 1100), beta: [] };
  const requests = [];
  await mockHistory(page, t, rows, requests);
  await connect(page, t, "Tomas", { live: false });
  for (let cursor = 100; cursor <= 1000; cursor += 100) {
    await expect(page.locator("#cursor")).toHaveText(`Cursor ${cursor}`);
    if (cursor < 1000) await page.getByRole("button", { name: "Load next page" }).click();
  }
  await page.locator('.message[data-id="500"]').evaluate((node) => {
    node.parentElement.scrollTop = node.offsetTop - node.parentElement.offsetTop;
  });
  const before = await page.locator('.message[data-id="500"]').boundingBox();
  await page.getByRole("button", { name: "Load next page" }).click();
  await expect(page.locator("#cursor")).toHaveText("Cursor 1100");
  await expect(page.locator(".message")).toHaveCount(1000);
  await expect(page.locator(".message").first()).toHaveAttribute("data-id", "101");
  const after = await page.locator('.message[data-id="500"]').boundingBox();
  expect(Math.abs(after.y - before.y)).toBeLessThan(2);
  await openChannel(page, "beta");
  await openChannel(page, "alpha");
  await expect(page.locator("#status")).toHaveText("Polled #alpha · 0 new");
  await expect(page.locator(".message")).toHaveCount(1000);
  expect(requests.at(-1)).toEqual({ name: "alpha", after: 1100 });
  const resumed = await page.locator('.message[data-id="500"]').boundingBox();
  expect(Math.abs(resumed.y - after.y)).toBeLessThan(2);
  // A poll can complete while a phone shows the channel list. Pruning must still
  // preserve the message anchor, not reuse an offset into the now-shorter history.
  rows.alpha.push(...messageRows("alpha", 100, 1101));
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let intercepted;
  const started = new Promise((resolve) => {
    intercepted = resolve;
  });
  await page.route(`**${t.path}/channels/alpha/messages?after=1100&**`, async (route) => {
    intercepted();
    await held;
    await route.fallback();
  });
  await page.getByRole("button", { name: "Poll once" }).click();
  await started;
  await channelsPane(page);
  release();
  await expect(page.locator("#cursor")).toHaveText("Cursor 1200");
  await openChannel(page, "alpha");
  await expect(page.locator("#status")).toHaveText("Polled #alpha · 0 new");
  const afterHiddenPoll = await page.locator('.message[data-id="500"]').boundingBox();
  expect(Math.abs(afterHiddenPoll.y - resumed.y)).toBeLessThan(2);
});

test("reply and correlation annotations are plain text, not threads or read receipts", async ({
  page,
  request,
}) => {
  const t = await provision(request);
  const first = await request.post(`${t.path}/channels/general/messages`, {
    headers: t.headers,
    data: { username: "human", text: "task" },
  });
  expect(first.status()).toBe(201);
  const {
    message: { id },
  } = await first.json();
  const attack = '<img src=x onerror="window.pwned=true">';
  const reply = await request.post(`${t.path}/channels/general/messages`, {
    headers: t.headers,
    data: {
      username: "agent",
      text: '{"ok":true}',
      contentType: "application/json",
      replyTo: id,
      correlationId: attack,
    },
  });
  expect(reply.status()).toBe(201);
  await connect(page, t);
  await expect(page.locator(".message-annotation")).toHaveText([
    `Reply to: #${id}`,
    `Correlation: ${attack}`,
  ]);
  await expect(page.locator(".message-annotation img, .message-annotation script")).toHaveCount(0);
  expect(await page.evaluate(() => window.pwned)).toBeUndefined();
  await expect(page.locator("#channel-note")).toContainText("not a read acknowledgment");
  await expect(page.locator(".message")).toHaveCount(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

for (const budget of ["channel count", "total messages"]) {
  test(`memory cache evicts the least-recently-used channel at the ${budget} bound`, async ({
    page,
    request,
  }) => {
    const t = await provision(request);
    const names = ["alpha", "beta", "delta", "epsilon", "gamma", "zeta"];
    const rows = {};
    for (const name of names) {
      await request.put(`${t.path}/channels/${name}`, { headers: t.headers });
      rows[name] = messageRows(
        name,
        budget === "total messages" && ["alpha", "beta"].includes(name) ? 1000 : 1,
      );
    }
    const requests = [];
    await mockHistory(page, t, rows, requests);
    await connect(page, t, "Tomas", { live: false });
    if (budget === "total messages") {
      for (const name of ["alpha", "beta"]) {
        if (name === "beta") await openChannel(page, name);
        for (let cursor = 100; cursor <= 1000; cursor += 100) {
          await expect(page.locator("#cursor")).toHaveText(`Cursor ${cursor}`);
          if (cursor < 1000) await page.getByRole("button", { name: "Load next page" }).click();
        }
      }
      await openChannel(page, "gamma"); // 2001 cached rows evicts inactive alpha.
      await expect(page.locator("#cursor")).toHaveText("Cursor 1");
      await openChannel(page, "beta");
      await expect(page.locator("#status")).toHaveText("Polled #beta · 0 new");
      expect(requests.at(-1)).toEqual({ name: "beta", after: 1000 });
      await openChannel(page, "alpha");
      await expect(page.locator("#status")).toHaveText("Polled #alpha · 100 new");
      expect(requests.at(-1)).toEqual({ name: "alpha", after: 0 });
    } else {
      for (const name of names.slice(1, 5)) {
        await openChannel(page, name);
        await expect(page.locator("#cursor")).toHaveText("Cursor 1");
      }
      await openChannel(page, "alpha"); // Make alpha newer than beta.
      await expect(page.locator("#status")).toHaveText("Polled #alpha · 0 new");
      await openChannel(page, "zeta"); // Sixth channel evicts beta, not alpha.
      await expect(page.locator("#cursor")).toHaveText("Cursor 1");
      await openChannel(page, "alpha");
      await expect(page.locator("#status")).toHaveText("Polled #alpha · 0 new");
      expect(requests.at(-1)).toEqual({ name: "alpha", after: 1 });
      await openChannel(page, "beta");
      await expect(page.locator("#status")).toHaveText("Polled #beta · 1 new");
      expect(requests.at(-1)).toEqual({ name: "beta", after: 0 });
    }
  });
}

async function snapshotFixture(request, t, channel = "general", tail = 22) {
  const sent = await request.post(`${t.path}/channels/${channel}/messages`, {
    headers: t.headers,
    data: { username: "planner", text: "Original decision: use checkpoints." },
  });
  const first = (await sent.json()).message;
  const text = '## Objective\nResume safely.\n<img src=x onerror="window.pwned=true">';
  const published = await request.post(`${t.path}/channels/${channel}/snapshots`, {
    headers: { ...t.headers, "Idempotency-Key": "browser-checkpoint" },
    data: { username: "planner", text, coversThrough: first.id, baseVersion: 0, historyRevision: 0 },
  });
  expect(published.status()).toBe(201);
  for (let i = 0; i < tail; i++) {
    await request.post(`${t.path}/channels/${channel}/messages`, {
      headers: t.headers,
      data: { username: "reviewer", text: `Follow-up ${i}`, to: "planner" },
    });
  }
  return { first, text };
}

test("catch-up separates safe authored snapshot from bounded tail, preserves drafts, and resumes exactly", async ({
  page,
  request,
}) => {
  const t = await provision(request);
  const { text } = await snapshotFixture(request, t);
  await connect(page, t, "Tomas", { live: false });
  await expect(page.locator(".message")).toHaveCount(23);
  await page.getByLabel("Message", { exact: true }).fill("My unfinished thought");
  await page.getByLabel("To", { exact: true }).fill("reviewer");
  await page.getByRole("button", { name: "Catch up", exact: true }).click();
  await expect(page.locator("#checkpoint")).toBeVisible();
  await expect(page.locator("#checkpoint-title")).toContainText("Snapshot v1");
  await page.locator("#checkpoint-title").click();
  await expect(page.locator("#checkpoint-text")).toHaveText(text);
  await expect(page.locator("#checkpoint img, #checkpoint script")).toHaveCount(0);
  expect(await page.evaluate(() => window.pwned)).toBeUndefined();
  await expect(page.locator(".message")).toHaveCount(20);
  await expect(page.locator(".message p").first()).toHaveText("Follow-up 0");
  await expect(page.locator("#catchup-note")).toContainText("More messages remain");
  await expect(page.getByLabel("Live", { exact: true })).not.toBeChecked();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("My unfinished thought");
  await expect(page.getByLabel("To", { exact: true })).toHaveValue("reviewer");
  await page.getByRole("button", { name: "Load next page" }).click();
  await expect(page.locator(".message")).toHaveCount(22);
  await expect(page.locator(".message p").last()).toHaveText("Follow-up 21");
  await expect(page.locator("#checkpoint-title")).toContainText("Snapshot v1");
  await expect(page.locator("#catchup-note")).toContainText("Caught up at this request");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Reread", exact: true }).click();
  await expect(page.locator("#checkpoint")).toBeHidden();
  await expect(page.locator("#checkpoint-text")).toHaveText("");
  await expect(page.locator(".message")).toHaveCount(23);
  await disconnect(page);
  await expect(page.locator("#checkpoint-text")).toHaveText("");
});

test("catch-up continuation notices redaction and discards stale snapshot and cached messages", async ({
  page,
  request,
}) => {
  const t = await provision(request);
  const { first } = await snapshotFixture(request, t);
  await connect(page, t, "Tomas", { live: false });
  await page.getByRole("button", { name: "Catch up", exact: true }).click();
  await expect(page.locator(".message")).toHaveCount(20);
  await request.delete(`/api/admin/tenants/${t.tenant}/channels/general/messages/${first.id}`, {
    headers: { Authorization: `Bearer ${ADMIN}` },
  });
  await page.getByRole("button", { name: "Load next page" }).click();
  await expect(page.locator("#status")).toContainText("Channel history changed");
  await expect(page.locator("#checkpoint-text")).toHaveText("");
  await expect(page.locator(".message")).toHaveCount(0);
  await page.getByRole("button", { name: "Catch up", exact: true }).click();
  await expect(page.locator("#catchup-note")).toContainText("No snapshot loaded");
  await expect(page.locator(".message")).toHaveCount(20);
  await expect(page.locator("#checkpoint-text")).toHaveText("");
});

test("late catch-up response cannot display another channel's snapshot", async ({ page, request }) => {
  const t = await provision(request);
  await snapshotFixture(request, t, "alpha", 1);
  await request.post(`${t.path}/channels/beta/messages`, {
    headers: t.headers,
    data: { username: "planner", text: "Beta only" },
  });
  let release;
  let captured;
  const started = new Promise((resolve) => {
    captured = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route(`**${t.path}/channels/alpha/catchup?*`, async (route) => {
    const response = await route.fetch();
    captured();
    await gate;
    await route.fulfill({ response }).catch(() => {});
  });
  await connect(page, t, "Tomas", { live: false });
  await page.getByRole("button", { name: "Catch up", exact: true }).click();
  await started;
  await openChannel(page, "beta");
  release();
  await expect(page.locator(".message p")).toHaveText("Beta only");
  await expect(page.locator("#checkpoint")).toBeHidden();
  await expect(page.locator("#checkpoint-text")).toHaveText("");
});

for (const transition of ["Poll once", "Live", "channel return"]) {
  test(`leaving catch-up via ${transition} clears an unvalidated cached snapshot`, async ({
    page,
    request,
  }) => {
    const t = await provision(request);
    const { first } = await snapshotFixture(request, t, "alpha", 1);
    await request.put(`${t.path}/channels/beta`, { headers: t.headers });
    await connect(page, t, "Tomas", { live: false });
    await page.getByRole("button", { name: "Catch up", exact: true }).click();
    await expect(page.locator("#checkpoint")).toBeVisible();
    await expect(page.locator("#checkpoint-text")).not.toHaveText("");
    await request.delete(`/api/admin/tenants/${t.tenant}/channels/alpha/messages/${first.id}`, {
      headers: { Authorization: `Bearer ${ADMIN}` },
    });
    if (transition === "channel return") {
      await openChannel(page, "beta");
      await openChannel(page, "alpha");
    } else if (transition === "Live") {
      await page.getByLabel("Live", { exact: true }).check();
    } else {
      await page.getByRole("button", { name: "Poll once", exact: true }).click();
    }
    await expect(page.locator("#checkpoint")).toBeHidden();
    await expect(page.locator("#checkpoint-text")).toHaveText("");
  });
}

test("self-service web creation invites a CLI lead who can invite another web participant", async ({
  page,
  baseURL,
}, testInfo) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = await mkdtemp(join(tmpdir(), "msn-invite-browser-"));
  const binary = fileURLToPath(new URL("../cli/target/debug/msn", import.meta.url));
  const run = async (args) => {
    const { stdout } = await promisify(execFile)(binary, args, {
      env: { HOME: home, XDG_CONFIG_HOME: join(home, "config"), MSN_URL: baseURL },
    });
    return JSON.parse(stdout);
  };
  await page.addInitScript(() => {
    window.savedPasswords = [];
    window.PasswordCredential = class {
      constructor(data) {
        Object.assign(this, data);
      }
    };
    Object.defineProperty(navigator, "credentials", {
      value: {
        store: async (credential) => {
          window.savedPasswords.push(credential);
        },
      },
    });
  });
  try {
    const tenant = `web-${crypto.randomUUID()}`;
    await page.goto("/");
    await page.getByLabel("Get started").selectOption("create");
    await page.getByLabel("Workspace", { exact: true }).fill(tenant);
    await page.getByLabel("Your display name").fill("Tomas");
    await page.getByRole("button", { name: "Create workspace", exact: true }).click();
    await expect(page.locator("#channel-title")).toHaveText("# general");
    await expect.poll(() => page.evaluate(() => window.savedPasswords.length)).toBe(1);
    const credential = await page.evaluate(() => window.savedPasswords[0]);
    expect(credential.id).toBe(`${tenant}/Tomas`);
    expect(credential.password).toHaveLength(64);
    await page.getByRole("button", { name: "Invite", exact: true }).click();
    await page.getByLabel("Recipients", { exact: true }).fill("2");
    await page.getByRole("button", { name: "Create invitation", exact: true }).click();
    await expect(page.locator("#invite-result")).toBeVisible();
    const link = await page.getByLabel("Invitation link", { exact: true }).inputValue();
    expect(link).not.toContain(credential.password);
    await page.screenshot({ path: testInfo.outputPath("invitation.png") });
    const lead = await run(["join", link, "--username", "lead-agent", "--save-as", "lead"]);
    expect(lead.activity.channels.map((channel) => channel.name)).toEqual(["general"]);
    const delegated = await run(["--profile", "lead", "invite", "general", "--uses", "1"]);
    await run(["--profile", "lead", "send", "general", "--text", "Lead is ready"]);
    const summary = await run(["workspace", "list"]);
    expect(summary.workspaces[0].activity.channels[0].messageCount).toBe(1);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.getByText("Lead is ready", { exact: true })).toBeVisible();
    // Incoming links must take priority over the owner's remembered browser session.
    await page.goto(delegated.url);
    await expect(page.locator("#entry-mode")).toHaveValue("join");
    expect(new URL(page.url()).hash).toBe("");
    await page.getByLabel("Your display name").fill("worker-agent");
    await page.getByRole("button", { name: "Join workspace", exact: true }).click();
    await expect(page.locator("#channel-title")).toHaveText("# general");
    await page.getByLabel("Message", { exact: true }).fill("Worker is ready");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByText("Worker is ready", { exact: true })).toBeVisible();
    await channelsPane(page);
    await expect(page.locator("#channel-form")).toBeHidden();
    await expect(page.locator("#invite-workspace")).toBeHidden();
    await page.reload();
    await expect(page.locator("#display-name")).toHaveText("worker-agent");
    const cached = await run(["workspace", "list", "--offline"]);
    expect(cached.workspaces[0].status).toBe("cached");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("CLI creates a workspace and a web recipient joins by code when password saving is unavailable", async ({
  page,
  baseURL,
}) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = await mkdtemp(join(tmpdir(), "msn-create-browser-"));
  const binary = fileURLToPath(new URL("../cli/target/debug/msn", import.meta.url));
  const run = async (args) =>
    JSON.parse(
      (
        await promisify(execFile)(binary, args, {
          env: { HOME: home, XDG_CONFIG_HOME: join(home, "config"), MSN_URL: baseURL },
        })
      ).stdout,
    );
  await page.addInitScript(() => {
    window.PasswordCredential = undefined;
  });
  try {
    const tenant = `cli-${crypto.randomUUID()}`;
    await run(["workspace", "create", tenant, "--username", "owner", "--save-as", "owner"]);
    const invite = await run(["--profile", "owner", "invite", "--uses", "2"]);
    await page.goto("/");
    await page.getByLabel("Get started").selectOption("join");
    await page.getByLabel("Invitation link or code").fill(invite.code);
    await page.getByLabel("Your display name").fill("human");
    await page.getByRole("button", { name: "Join workspace", exact: true }).click();
    await expect(page.locator("#workspace")).toBeVisible();
    await channelsPane(page);
    await page.getByLabel("New channel name").fill("planning");
    await page.getByRole("button", { name: "Create channel", exact: true }).click();
    await expect(page.locator("#channel-title")).toHaveText("# planning");
    await channelsPane(page);
    await page.getByText("Your access details", { exact: true }).click();
    await page.getByRole("button", { name: "Save to password manager" }).click();
    await expect(page.locator("#status")).toContainText("Automatic saving is unavailable");
    await page.getByRole("button", { name: "Invite to workspace" }).click();
    await page.getByRole("button", { name: "Create invitation", exact: true }).click();
    await expect(page.locator("#invite-result")).toBeVisible();
    const issued = await page.getByLabel("Invitation link", { exact: true }).inputValue();
    await page.getByRole("button", { name: "Revoke invitation", exact: true }).click();
    await expect(page.locator("#invite-dialog")).not.toBeVisible();
    await page.goto(issued);
    await page.getByLabel("Your display name").fill("late-agent");
    await page.getByRole("button", { name: "Join workspace", exact: true }).click();
    await expect(page.locator("#status")).toContainText("expired, revoked or fully used");
    await expect(page.locator("#welcome")).toBeVisible();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("password-manager usernames restore the workspace and preserve names containing slashes", async ({
  page,
  request,
}) => {
  const t = await provision(request, { username: "agent/reviewer" });
  await connect(page, t, "agent/reviewer", { live: false });
  await expect(page.locator("#display-name")).toHaveText("agent/reviewer");
  await disconnect(page);
  await page.getByLabel("Workspace", { exact: true }).fill("");
  await page.getByLabel("Your display name").fill(`${t.tenant}/agent/reviewer`);
  await page.getByLabel("Access key", { exact: true }).fill(t.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator("#workspace-name")).toHaveText(t.tenant);
  await expect(page.locator("#display-name")).toHaveText("agent/reviewer");
});

// A phone is the primary target: nothing may scroll sideways, focusing a field must not zoom
// the page away from the layout, and an open keyboard must not cover the composer.
test("the interface fits a phone, refuses zoom, and stays usable behind the keyboard", async ({
  page,
  request,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "phone viewport only");
  const t = await provision(request);
  await request.put(`${t.path}/channels/general`, { headers: t.headers });
  const token = "unbreakable-token-0123456789abcdefghijklmnopqrstuvwxyz-0123456789abcdefghij";
  for (const text of [`a link ${token}${token}`, "short"]) {
    await request.post(`${t.path}/channels/general/messages`, {
      headers: t.headers,
      data: { username: `agent-${token}`, text, to: token, correlationId: token },
    });
  }
  await connect(page, t);
  await openChannel(page, "general");
  await expect(page.locator(".message")).toHaveCount(2);

  // Zoom is refused at the document level, so a stray pinch or double tap cannot strand the layout.
  expect(await page.locator('meta[name="viewport"]').getAttribute("content")).toContain("user-scalable=no");
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).touchAction)).toBe(
    "pan-x pan-y",
  );

  // iOS Safari zooms instead when a focused control is under 16px, whatever the meta tag says.
  const small = await page.evaluate(() =>
    [...document.querySelectorAll("input:not([type=checkbox]), select, textarea")]
      .filter((el) => el.offsetParent !== null)
      .filter((el) => Number.parseFloat(getComputedStyle(el).fontSize) < 16)
      .map((el) => el.id),
  );
  expect(small).toEqual([]);

  const sideways = () =>
    page.evaluate(() => {
      const wide = [...document.querySelectorAll("body *")].filter((el) => {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return false;
        if (rect.right <= window.innerWidth + 0.5) return false;
        // An element inside a scroller (the toolbar strip) is reachable, not overflowing.
        for (let p = el.parentElement; p; p = p.parentElement)
          if (getComputedStyle(p).overflowX !== "visible") return false;
        return true;
      });
      return {
        docWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        wide: wide.map((el) => el.tagName + (el.id ? `#${el.id}` : "")),
      };
    });
  let box = await sideways();
  expect(box.wide).toEqual([]);
  expect(box.docWidth).toBeLessThanOrEqual(box.innerWidth);

  // The keyboard takes the bottom of the visual viewport; the shell follows it.
  const resizeViewport = (height) =>
    page.evaluate((value) => {
      Object.defineProperty(window.visualViewport, "height", { value, configurable: true });
      window.visualViewport.dispatchEvent(new Event("resize"));
    }, height);
  const full = await page.evaluate(() => window.innerHeight);
  const visible = Math.round(full * 0.55);
  await resizeViewport(visible);
  await expect
    .poll(() => page.evaluate(() => Math.round(document.body.getBoundingClientRect().height)))
    .toBe(visible);
  const behindKeyboard = await page.evaluate(() => ({
    compose: Math.round(document.querySelector(".compose").getBoundingClientRect().bottom),
    status: Math.round(document.querySelector("#status").getBoundingClientRect().bottom),
    log: Math.round(document.querySelector("#messages").getBoundingClientRect().height),
    atBottom: (() => {
      const m = document.querySelector("#messages");
      return m.scrollHeight - m.clientHeight - m.scrollTop < 2;
    })(),
  }));
  expect(behindKeyboard.compose).toBeLessThanOrEqual(visible);
  expect(behindKeyboard.status).toBeLessThanOrEqual(visible);
  expect(behindKeyboard.log).toBeGreaterThan(0);
  // Shrinking the log is not the reader scrolling away from the newest message.
  expect(behindKeyboard.atBottom).toBe(true);
  box = await sideways();
  expect(box.wide).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("keyboard-open.png") });

  await resizeViewport(full);
  await expect
    .poll(() => page.evaluate(() => Math.round(document.body.getBoundingClientRect().height)))
    .toBe(full);

  // The channels pane and the dialogs are phone-sized too.
  await channelsPane(page);
  await page.getByRole("button", { name: "Invite to workspace" }).click();
  await page.getByRole("button", { name: "Create invitation" }).click();
  await expect(page.locator("#invite-link")).not.toHaveValue("");
  box = await sideways();
  expect(box.wide).toEqual([]);
  expect(box.docWidth).toBeLessThanOrEqual(box.innerWidth);
  await page.getByRole("button", { name: "Close" }).click();

  await page.goto("/guide.html");
  box = await sideways();
  expect(box.wide).toEqual([]);
  expect(box.docWidth).toBeLessThanOrEqual(box.innerWidth);
});

// The shell is pinned to the visual viewport, so any region that can grow past a short screen
// needs its own scroll. Landscape is where that bites first.
test("every control stays reachable on a landscape phone", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "phone viewport only");
  const t = await provision(request);
  for (const name of ["general", "alpha", "beta", "gamma", "delta"])
    await request.put(`${t.path}/channels/${name}`, { headers: t.headers });
  await page.setViewportSize({ width: 667, height: 375 });

  // The connect form is taller than a landscape phone before anything is even typed.
  await page.goto("/");
  await page.getByLabel("Workspace", { exact: true }).fill(t.tenant);
  await page.getByLabel("Access key").fill(t.token);
  await page.getByLabel("Your display name").fill("Tomas");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator("#workspace")).toBeVisible();

  await channelsPane(page);
  // The access disclosure is the region that grows; everything below it must still be usable.
  await page.getByText("Your access details").click();
  await expect(page.locator("#copy-access")).toBeVisible();
  const onScreen = async (selector) => {
    await page.locator(selector).scrollIntoViewIfNeeded();
    return page.evaluate((sel) => {
      const rect = document.querySelector(sel).getBoundingClientRect();
      return rect.top >= -0.5 && rect.bottom <= window.innerHeight + 0.5 && rect.height > 0;
    }, selector);
  };
  for (const selector of ["#invite-workspace", "#copy-access", "#new-channel", "#disconnect"])
    expect(await onScreen(selector), `${selector} is reachable`).toBe(true);
  // The channel list keeps a usable height rather than collapsing to make room.
  expect(await page.evaluate(() => document.querySelector("#channels").clientHeight)).toBeGreaterThan(80);
  await page.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.locator("#welcome")).toBeVisible();
  expect(await onScreen("#entry-submit")).toBe(true);
});

test("the Agents list shows which board personas are listening and when each last acted", async ({
  page,
  request,
}, testInfo) => {
  const t = await provision(request, { username: "human" });
  const credential = crypto.randomUUID().replaceAll("-", "").repeat(2);
  expect(
    (
      await request.put(`${t.path}/channels/work/board`, {
        headers: t.headers,
        data: { credential, goal: "Ship the presence list" },
      })
    ).status(),
  ).toBe(201);
  expect((await request.put(`${t.path}/channels/plain`, { headers: t.headers })).status()).toBe(201);
  const shared = { Authorization: `Bearer ${credential}` };
  for (const [id, displayName] of [
    ["builder", "builder"],
    ["reviewer", "reviewer"],
  ])
    await request.put(`${t.path}/channels/work/personas/${id}`, { headers: shared, data: { displayName } });
  await request.post(`${t.path}/channels/work/messages`, {
    headers: shared,
    data: { username: "reviewer", text: "Review notes posted" },
  });
  const head = await (await request.get(`${t.path}/events?wait=0`, { headers: shared })).json();
  // The builder's runner holds its long poll open, tagged with its persona.
  const poll = request.get(`${t.path}/events?wait=20&after=${head.nextCursor}&listener=builder`, {
    headers: shared,
  });
  await expect
    .poll(
      async () =>
        (await (await request.get(`${t.path}/channels/work/personas`, { headers: shared })).json())
          .personas[0].listening,
    )
    .toBe(true);
  await connect(page, t, "human");
  await openChannel(page, "work");
  await page.locator("#agents").click();
  await expect(page.locator("#agents-title")).toHaveText("Agents in # work");
  const rows = page.locator("#agents-list li");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveClass("listening");
  await expect(rows.nth(0)).toContainText("builder");
  await expect(rows.nth(0)).toContainText("Listening · no messages yet");
  await expect(rows.nth(1)).toHaveClass("idle");
  await expect(rows.nth(1)).toContainText("Never listened · last acted just now");
  await page.screenshot({ path: testInfo.outputPath("agents-listening.png") });
  await page.locator("#close-agents").click();
  await expect(page.locator("#agents-dialog")).not.toBeVisible();
  // A channel without a board has no personas; the list explains that instead of opening empty.
  await openChannel(page, "plain");
  await page.locator("#agents").click();
  await expect(page.locator("#status")).toHaveText(
    "This channel is not a board, so it has no agent personas.",
  );
  await expect(page.locator("#agents-dialog")).not.toBeVisible();
  await request.post(`${t.path}/channels/work/messages`, {
    headers: shared,
    data: { username: "builder", text: "wake" },
  });
  expect((await poll).status()).toBe(200);
});

test("the owner turns notifications on and off; disconnecting turns them off", async ({
  page,
  context,
  request,
}) => {
  // Headless browsers have no push service. Stand in for the browser's PushManager only; the
  // subscription still goes through the real app, service worker registration and Worker API.
  await context.grantPermissions(["notifications"]);
  await page.addInitScript(() => {
    let current = null;
    const b64 = (bytes) =>
      btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
    PushManager.prototype.getSubscription = async () => current;
    PushManager.prototype.subscribe = async (options) => {
      const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
        "deriveBits",
      ]);
      const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
      const auth = crypto.getRandomValues(new Uint8Array(16));
      window.applicationServerKey = b64(new Uint8Array(options.applicationServerKey));
      current = {
        endpoint: "https://fcm.googleapis.com/fcm/send/browser-test",
        toJSON() {
          return { endpoint: this.endpoint, keys: { p256dh: b64(raw), auth: b64(auth) } };
        },
        unsubscribe: async () => {
          current = null;
          return true;
        },
      };
      return current;
    };
  });
  const t = await provision(request, { username: "human" });
  const devices = async () =>
    (await (await request.get(`${t.path}/push`, { headers: t.headers })).json()).devices;
  await connect(page, t, "human");
  await channelsPane(page);
  const notify = page.locator("#notify");
  await expect(notify).toHaveText("Notify me when agents need me");
  await notify.click();
  await expect(page.locator("#status")).toContainText("Notifications are on");
  await expect(notify).toHaveText("Notifications on · turn off");
  await expect(notify).toHaveAttribute("aria-pressed", "true");
  expect(await devices()).toBe(1);
  const { publicKey } = await (await request.get(`${t.path}/push`, { headers: t.headers })).json();
  expect(await page.evaluate(() => window.applicationServerKey)).toBe(publicKey);
  expect(
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration("/"))?.active?.scriptURL),
  ).toMatch(/\/sw\.js$/);

  await notify.click();
  await expect(page.locator("#status")).toContainText("Notifications are off");
  await expect(notify).toHaveText("Notify me when agents need me");
  expect(await devices()).toBe(0);

  await notify.click();
  await expect(notify).toHaveText("Notifications on · turn off");
  expect(await devices()).toBe(1);
  await disconnect(page);
  await expect.poll(devices).toBe(0);
  await expect(page.locator("#notify")).toBeHidden();
});

test("only the owner account is offered notifications", async ({ page, request }) => {
  const t = await provision(request);
  const key = await request.put(`/api/admin/tenants/${t.tenant}/keys/agent`, {
    headers: { Authorization: `Bearer ${ADMIN}` },
    data: { username: "agent" },
  });
  await connect(page, { tenant: t.tenant, token: (await key.json()).token }, "agent");
  await channelsPane(page);
  await expect(page.locator("#notify")).toBeHidden();
});
