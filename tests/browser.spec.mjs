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
async function connect(page, t, name = "Tomas", { remember = true } = {}) {
  await page.goto("/");
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
