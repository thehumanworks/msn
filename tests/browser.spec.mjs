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
    data: { username: "<script>alert(1)</script>", text: attack },
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
  await page.route("**/channels/general/messages", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    keys.push(route.request().headers()["idempotency-key"]);
    if (first) {
      first = false;
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await page.getByLabel("Message", { exact: true }).fill("uncertain");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.locator("#status")).toContainText("draft is preserved");
  await expect(page.locator("#message")).toHaveValue("uncertain");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.locator("#message")).toHaveValue("");
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  const result = await request.get(`${t.path}/channels/general/messages`, { headers: t.headers });
  expect((await result.json()).messages).toHaveLength(1);
});

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
  await page.getByLabel("Message", { exact: true }).fill("alpha uncertain");
  await page.getByRole("button", { name: "Send message" }).click();
  await started;
  await openChannel(page, "beta");
  await expect(page.locator("#message")).toHaveValue("");
  await page.getByLabel("Message", { exact: true }).fill("beta draft");
  release();
  await expect(page.locator("#message")).toHaveValue("beta draft");
  await openChannel(page, "alpha");
  await expect(page.locator("#message")).toHaveValue("alpha uncertain");
  await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.locator("#message")).toHaveValue("");
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  await openChannel(page, "beta");
  await expect(page.locator("#message")).toHaveValue("beta draft");
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
