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
  // Readable (ADR 0066): no URL-encoded JSON, the key stays in the fragment.
  expect(link).toMatch(
    new RegExp(`^${new URL(page.url()).origin}/#board=${t.tenant}/work&key=[0-9a-f]{64}$`),
  );
  expect(link).not.toContain("%");
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

test("a board link from before readable links still joins, and a broken one is refused", async ({
  page,
  request,
}) => {
  const t = await provision(request, { username: "human" });
  const created = await request.put(`${t.path}/channels/work/board`, {
    headers: t.headers,
    data: { credential: crypto.randomUUID().replaceAll("-", "").repeat(2), goal: "Goal" },
  });
  expect(created.status()).toBe(201);
  const shared = await (
    await request.get(`${t.path}/channels/work/board/connection`, { headers: t.headers })
  ).json();
  await page.goto("/");
  const origin = new URL(page.url()).origin;
  // The old Invite dialog put URL-encoded JSON in the fragment (ADR 0066 keeps it working).
  await page.goto(`${origin}/#board=${encodeURIComponent(JSON.stringify({ ...shared, url: origin }))}`);
  await expect(page.locator("#status")).toHaveText("Choose a display name to join this message board.");
  await expect(page.locator("#tenant")).toHaveValue(t.tenant);
  await page.locator("#username").fill("legacy");
  await page.locator("#entry-submit").click();
  await expect(page.locator("#workspace")).toBeVisible();
  await expect(page.locator("#identity-note")).toHaveText("Persona · shared channel access");
  await page.evaluate(() => localStorage.clear());
  for (const hash of [
    `#board=${t.tenant}/work&key=`,
    `#board=${t.tenant}&key=${shared.token}`,
    "#board=%7Bnope",
  ]) {
    await page.goto(`${origin}/?r=${Math.random()}${hash}`);
    await expect(page.locator("#status")).toHaveText("Invalid channel connection.");
    expect(new URL(page.url()).hash).toBe("");
  }
  // A message link never carries a key.
  await page.goto(`${origin}/?r=mixed#board=${t.tenant}/work&msg=1&key=${shared.token}`);
  await expect(page.locator("#status")).toHaveText("Invalid message link.");
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

test("an owner saves a board as a template and starts a new board from it", async ({
  page,
  request,
}, testInfo) => {
  const t = await provision(request, { username: "human" });
  const goal =
    "Ship the docs\n\nTeam (Lead and reviewer):\n- lead: Writes the docs.\n- reviewer: Checks every page.";
  await request.put(`${t.path}/channels/docs/board`, {
    headers: t.headers,
    data: { credential: "a".repeat(64), goal },
  });
  for (const name of ["lead", "reviewer"])
    await request.put(`${t.path}/channels/docs/personas/p-${name}`, {
      headers: { Authorization: `Bearer ${"a".repeat(64)}` },
      data: { displayName: name },
    });
  await connect(page, t, "human");
  await openChannel(page, "docs");
  await page.locator("#board-settings").click();
  const row = page.locator("#save-template-row");
  await expect(row).toBeVisible();
  await page.locator("#template-name").fill("docs-team");
  await row.getByRole("button", { name: "Save as template" }).click();
  await expect(page.locator("#save-template-note")).toHaveText(
    "Saved as docs-team. Choose it under Start a board from a template.",
  );
  // Saving the same name again asks before it overwrites.
  await row.getByRole("button", { name: "Save as template" }).click();
  await expect(page.locator("#save-template-note")).toContainText(
    "You already have a template named docs-team",
  );
  await row.getByRole("button", { name: "Replace template" }).click();
  await expect(page.locator("#save-template-note")).toHaveText(/^Saved as docs-team/);
  await row.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("save-template.png") });
  await page.locator("#close-board").click();

  // The saved template sits after the built-ins and starts a board in one step.
  await channelsPane(page);
  await page.getByRole("button", { name: "Start a board from a template" }).click();
  const dialog = page.locator("#template-dialog");
  await expect(dialog.locator(".template-choice")).toHaveCount(4);
  const mine = dialog.locator(".template-choice").nth(3);
  await expect(mine).toContainText("docs-team Yours");
  await expect(mine).toContainText("Saved from board docs.");
  await expect(mine).toContainText("lead · reviewer");
  await dialog.getByRole("radio", { name: /docs-team/ }).check();
  await expect(page.locator("#template-goal")).toHaveAttribute("placeholder", "Ship the docs");
  await page.locator("#template-channel").fill("docs2");
  await page.screenshot({ path: testInfo.outputPath("saved-template-picker.png") });
  await dialog.getByRole("button", { name: "Create board" }).click();
  await expect(page.locator("#template-ready")).toHaveText("# docs2 is ready with 2 agents");
  await page.locator("#close-template").click();
  const created = await (await request.get(`${t.path}/channels/docs2/board`, { headers: t.headers })).json();
  expect(created.board.goal).toBe(
    "Ship the docs\n\nTeam (docs-team):\n- lead: Writes the docs.\n- reviewer: Checks every page.",
  );

  // Delete removes it from the picker; the board made from it keeps its goal.
  await channelsPane(page);
  await page.getByRole("button", { name: "Start a board from a template" }).click();
  await dialog.getByRole("button", { name: "Delete template docs-team" }).click();
  await expect(dialog.locator(".template-choice")).toHaveCount(3);
  await expect(dialog.getByRole("radio", { name: /Lead and reviewer/ })).toBeChecked();
  await page.locator("#close-template").click();
  const list = await (await request.get(`${t.path}/templates`, { headers: t.headers })).json();
  expect(list.templates).toEqual([]);

  // A shared board connection is not the owner: no save row in Goal & status.
  await disconnect(page);
  await connect(page, { ...t, token: "a".repeat(64) }, "lead");
  await openChannel(page, "docs");
  await page.locator("#board-settings").click();
  await expect(page.locator("#save-template-row")).toBeHidden();
});

test("a saved template that shares a built-in name never shows a second radio", async ({ page, request }) => {
  const t = await provision(request, { username: "human" });
  // The Worker reserves built-in names today; a built-in added later could still match an older save.
  await page.route(/\/templates$/, (route) =>
    route.fulfill({
      json: {
        templates: [
          {
            id: "solo",
            title: "solo",
            summary: "Saved from board old.",
            goal: "Old",
            personas: [],
            own: true,
          },
        ],
        max: 20,
      },
    }),
  );
  await connect(page, t, "human");
  await channelsPane(page);
  await page.getByRole("button", { name: "Start a board from a template" }).click();
  const dialog = page.locator("#template-dialog");
  await expect(dialog.locator(".template-choice")).toHaveCount(3);
  await expect(dialog.locator('input[value="solo"]')).toHaveCount(1);
  await expect(dialog).not.toContainText("Yours");
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

test("message text renders as safe Markdown built from DOM nodes (ADR 0043)", async ({ page, request }) => {
  const t = await provision(request);
  const formatted = [
    "## Plan",
    "Ship **bold**, *italic*, ~~old~~ and `inline` with [docs](https://example.com/docs).",
    "",
    "- first",
    "- second",
    "",
    "1. one",
    "2. two",
    "",
    "> quoted",
    "",
    "```js",
    `const line = "${"x".repeat(300)}";`,
    "```",
    "",
    "| Name | Score |",
    "|:-----|------:|",
    "| ann | 1 |",
  ].join("\n");
  const hostile = [
    "[click](javascript:window.pwned=true)",
    "[data](data:text/html,<script>window.pwned=true</script>)",
    '<a href="javascript:window.pwned=true">raw</a>',
    '<img src=x onerror="window.pwned=true">',
    "![x](javascript:window.pwned=true)",
    "<javascript:window.pwned=true>",
    "**<script>window.pwned=true</script>**",
    "`<img src=x onerror=window.pwned=true>`",
  ].join("\n");
  for (const text of ["plain words stay a paragraph", formatted, hostile])
    await request.post(`${t.path}/channels/alpha/messages`, {
      headers: t.headers,
      data: { username: "agent", text },
    });
  await connect(page, t, "Tomas", { remember: false });
  const rows = page.locator("#messages > article");
  await expect(rows).toHaveCount(3);
  // Plain text is still exactly one <p> with the raw text.
  await expect(rows.nth(0).locator("p")).toHaveText("plain words stay a paragraph");
  await expect(rows.nth(0).locator(".md")).toHaveCount(0);
  const md = rows.nth(1).locator(".md");
  await expect(md.locator('[role="heading"][aria-level="4"]')).toHaveText("Plan");
  await expect(md.locator("strong")).toHaveText("bold");
  await expect(md.locator("em")).toHaveText("italic");
  await expect(md.locator("del")).toHaveText("old");
  await expect(md.locator("p code")).toHaveText("inline");
  const link = md.locator("a");
  await expect(link).toHaveText("docs");
  await expect(link).toHaveAttribute("href", "https://example.com/docs");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer nofollow");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(md.locator("ul > li")).toHaveText(["first", "second"]);
  await expect(md.locator("ol > li")).toHaveText(["one", "two"]);
  await expect(md.locator("blockquote")).toHaveText("quoted");
  await expect(md.locator("th")).toHaveText(["Name", "Score"]);
  await expect(md.locator("td")).toHaveText(["ann", "1"]);
  // A long code line scrolls inside its block instead of widening the page.
  const code = md.locator("pre.md-code");
  await expect(code).toHaveCSS("white-space", "pre");
  const sizes = await code.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  expect(sizes.scroll).toBeGreaterThan(sizes.client);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  // Hostile input: no link other than https, no raw HTML elements, nothing executed.
  const bad = rows.nth(2);
  await expect(bad.locator("a")).toHaveCount(0);
  await expect(bad.locator("img, script, iframe")).toHaveCount(0);
  await expect(bad).toContainText("[click](javascript:window.pwned=true)");
  await expect(bad).toContainText('<img src=x onerror="window.pwned=true">');
  await expect(bad.locator("p strong")).toHaveText("<script>window.pwned=true</script>");
  const hrefs = await page
    .locator("#messages a[href]")
    .evaluateAll((all) => all.map((a) => a.getAttribute("href")));
  for (const href of hrefs) expect(href).toMatch(/^https?:\/\//);
  expect(await page.evaluate(() => window.pwned)).toBeUndefined();
});

test("a fenced code block has a Copy button that copies the raw code without the fence (ADR 0058)", async ({
  page,
  request,
}, testInfo) => {
  const t = await provision(request);
  await request.put(`${t.path}/channels/alpha`, { headers: t.headers });
  const script = ["msn join general", 'echo "<b>$HOME</b>" | tr a-z A-Z', "", "  indented `tick`"].join("\n");
  const text = ["Run this:", "", "```sh", script, "```", "", "Then:", "", "```", "msn listen", "```"].join(
    "\n",
  );
  await request.post(`${t.path}/channels/alpha/messages`, {
    headers: t.headers,
    data: { username: "agent", text },
  });
  // Record copies instead of touching the real clipboard; the second write fails.
  await page.addInitScript(() => {
    window.copied = [];
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (value) => {
          if (window.failCopy) throw new Error("denied");
          window.copied.push(value);
        },
      },
    });
  });
  // A long language tag is the sender's text: the button's name keeps only its first 32 characters.
  await request.post(`${t.path}/channels/alpha/messages`, {
    headers: t.headers,
    data: { username: "agent", text: [`\`\`\`${"l".repeat(40)}`, "x", "```"].join("\n") },
  });
  await connect(page, t, "Tomas", { remember: false });
  const blocks = page.locator("#messages article .md-codeblock");
  await expect(blocks).toHaveCount(3);
  await expect(blocks.nth(2).locator(".copy-code")).toHaveAttribute(
    "aria-label",
    `Copy ${"l".repeat(32)} code`,
  );
  // Selecting a message's text never picks up the button's label.
  await expect(blocks.nth(0).locator(".copy-code")).toHaveCSS("user-select", "none");
  // The <pre> still holds only the code: the button sits beside it, not inside it.
  await expect(blocks.nth(0).locator("pre.md-code")).toHaveText(script, { useInnerText: false });
  const first = blocks.nth(0).getByRole("button", { name: "Copy sh code" });
  const second = blocks.nth(1).getByRole("button", { name: "Copy code" });
  const mobile = testInfo.project.name === "mobile";
  if (mobile) {
    // Touch has no hover: the button always shows, at least 44px, and stays inside its block.
    await expect(second).toHaveCSS("opacity", "1");
    for (const [button, block] of [
      [first, blocks.nth(0)],
      [second, blocks.nth(1)],
    ]) {
      const box = await button.boundingBox();
      const outer = await block.boundingBox();
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.y + box.height).toBeLessThanOrEqual(outer.y + outer.height);
    }
  } else {
    // A mouse sees it on hover only, so it never covers code nobody is pointing at.
    await expect(first).toHaveCSS("opacity", "0");
    await blocks.nth(0).hover();
    await expect(first).toHaveCSS("opacity", "1");
  }
  await page.screenshot({ path: testInfo.outputPath("copy-code.png") });
  await first.click();
  await expect(first).toHaveText("Copied");
  await expect(page.locator("#status")).toHaveText("Code copied.");
  await second.click();
  expect(await page.evaluate(() => window.copied)).toEqual([script, "msn listen"]);
  // The label returns to Copy after a moment.
  await expect(first).toHaveText("Copy", { timeout: 5000 });
  // A blocked clipboard says so instead of claiming a copy.
  await page.evaluate(() => {
    window.failCopy = true;
  });
  await second.click();
  await expect(page.locator("#status")).toHaveText(
    "Clipboard unavailable. The code is selected: copy it manually.",
  );
  expect(await page.evaluate(() => getSelection().toString())).toBe("msn listen");
  await expect(page.locator("#status")).toHaveClass(/error/);
  expect(await page.evaluate(() => window.copied)).toHaveLength(2);
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

test("drafts survive a reload per board and clear on send and Disconnect (ADR 0057)", async ({
  page,
  request,
}, testInfo) => {
  const t = await provision(request);
  await request.put(`${t.path}/channels/ops`, { headers: t.headers });
  const posted = await request.post(`${t.path}/channels/general/messages`, {
    headers: t.headers,
    data: { username: "lead", text: "Who takes the release notes?" },
  });
  const { message } = await posted.json();
  await connect(page, t);
  await openChannel(page, "general");
  await page.getByRole("button", { name: `Reply to message #${message.id}` }).click();
  await page.getByLabel("To", { exact: true }).fill("lead");
  await page.getByLabel("Message", { exact: true }).fill("I can, after the deploy");
  await openChannel(page, "ops");
  await page.getByLabel("Message", { exact: true }).fill("ops note\nsecond line");
  await page.reload();
  await expect(page.locator("#channel-title")).toHaveText("# ops");
  await expect(page.locator("#message")).toHaveValue("ops note\nsecond line");
  await openChannel(page, "general");
  await expect(page.locator("#message")).toHaveValue("I can, after the deploy");
  await expect(page.locator("#recipient")).toHaveValue("lead");
  await expect(page.locator("#reply-note-text")).toHaveText(`Replying to #${message.id} · lead`);
  await page.screenshot({ path: testInfo.outputPath("drafts-restored.png") });
  // Only the drafts are stored for them: never the access key.
  const kept = await page.evaluate((tenant) => localStorage.getItem(`msn.drafts.${tenant}`), t.tenant);
  expect(kept).toContain("I can, after the deploy");
  expect(kept).not.toContain(t.token);
  // Sending removes the draft; the other board's draft stays.
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.locator("#message")).toHaveValue("");
  await expect(page.locator("#reply-note")).toBeHidden();
  await page.reload();
  await expect(page.locator("#channel-title")).toHaveText("# general");
  await expect(page.locator("#message")).toHaveValue("");
  await expect(page.locator("#recipient")).toHaveValue("");
  await expect(page.locator("#reply-note")).toBeHidden();
  await openChannel(page, "ops");
  await expect(page.locator("#message")).toHaveValue("ops note\nsecond line");
  // Clearing the field removes the draft too.
  await page.getByLabel("Message", { exact: true }).fill("");
  await expect
    .poll(() => page.evaluate((tenant) => localStorage.getItem(`msn.drafts.${tenant}`), t.tenant))
    .toBeNull();
  await page.getByLabel("Message", { exact: true }).fill("left behind");
  await disconnect(page);
  expect(await stored(page)).toEqual([0, 0]);
});

test("drafts stay in memory only without Stay signed in (ADR 0057)", async ({ page, request }) => {
  const t = await provision(request);
  await request.put(`${t.path}/channels/general`, { headers: t.headers });
  await connect(page, t, "Tomas", { remember: false });
  await page.getByLabel("Message", { exact: true }).fill("not on disk");
  await page.getByLabel("To", { exact: true }).fill("lead");
  await page.waitForTimeout(600);
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  expect(await stored(page)).toEqual([0, 0]);
});

test("a draft's files are not kept; the draft says so after a reload (ADR 0057)", async ({
  page,
  request,
}) => {
  const t = await provision(request);
  await request.put(`${t.path}/channels/general`, { headers: t.headers });
  await connect(page, t);
  await page.locator("#attach-input").setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("secret file body"),
  });
  await page.getByLabel("Message", { exact: true }).fill("see attached");
  await page.reload();
  await expect(page.locator("#message")).toHaveValue("see attached");
  await expect(page.locator(".attach-missing")).toHaveText(
    "1 file was not kept after the reload · attach again",
  );
  const kept = await page.evaluate((tenant) => localStorage.getItem(`msn.drafts.${tenant}`), t.tenant);
  expect(kept).not.toContain("notes.txt");
  expect(kept).not.toContain("secret file body");
  await page.locator("#attach-input").setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("secret file body"),
  });
  await expect(page.locator(".attach-missing")).toHaveCount(0);
  await expect(page.locator("#attach-list button")).toContainText("notes.txt");
});

test("an uncertain send retried after a reload reuses its key and posts once (ADR 0057)", async ({
  page,
  request,
}) => {
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
      // The server stores the message; the browser never learns it did.
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await page.getByLabel("To", { exact: true }).fill("review-agent");
  await page.getByLabel("Message", { exact: true }).fill("uncertain then reload");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.locator("#status")).toContainText("draft is preserved");
  await page.reload();
  await expect(page.locator("#channel-title")).toHaveText("# general");
  await expect(page.locator("#message")).toHaveValue("uncertain then reload");
  await expect(page.locator("#recipient")).toHaveValue("review-agent");
  await expect(page.locator("#status")).toContainText("may not have gone through");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.locator("#message")).toHaveValue("");
  expect(keys).toHaveLength(2);
  expect(keys[1]).toBe(keys[0]);
  const result = await request.get(`${t.path}/channels/general/messages`, { headers: t.headers });
  expect((await result.json()).messages.map((m) => m.text)).toEqual(["uncertain then reload"]);
  // Nothing is left to retry once the send is confirmed.
  expect(await page.evaluate((tenant) => localStorage.getItem(`msn.drafts.${tenant}`), t.tenant)).toBeNull();
});

test("an uncertain send with a file, retried after a reload, posts once with the file (ADR 0057)", async ({
  page,
  request,
}) => {
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
  await page.locator("#attach-input").setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("file body"),
  });
  await page.getByLabel("Message", { exact: true }).fill("with a file");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.locator("#status")).toContainText("draft is preserved");
  await page.reload();
  await expect(page.locator("#channel-title")).toHaveText("# general");
  await expect(page.locator("#message")).toHaveValue("with a file");
  await expect(page.locator(".attach-missing")).toContainText("Send retries this message with its 1 file");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.locator("#message")).toHaveValue("");
  await expect(page.locator(".attach-missing")).toHaveCount(0);
  expect(keys).toHaveLength(2);
  expect(keys[1]).toBe(keys[0]);
  const result = await request.get(`${t.path}/channels/general/messages`, { headers: t.headers });
  const messages = (await result.json()).messages;
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({ text: "with a file", attachments: [{ name: "notes.txt" }] });
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

test("pruning a thread root returns its replies to the log in id order", async ({ page, request }) => {
  const t = await populatedWorkspace(request);
  const rows = { alpha: messageRows("alpha", 1000), beta: [] };
  const replyTo = (id, parent) => Object.assign(rows.alpha[id - 1], { replyTo: parent });
  replyTo(150, 50);
  replyTo(160, 50);
  replyTo(170, 150);
  await mockHistory(page, t, rows, []);
  await connect(page, t, "Tomas", { live: false });
  for (let cursor = 100; cursor <= 1000; cursor += 100) {
    await expect(page.locator("#cursor")).toHaveText(`Cursor ${cursor}`);
    if (cursor < 1000) await page.getByRole("button", { name: "Load next page" }).click();
  }
  const log = page.locator("#messages");
  const top = (id) => log.locator(`:scope > article[data-id="${id}"]`);
  await expect(log.locator('article[data-id="50"] > .thread-toggle')).toHaveText(/^Show 3 replies/);
  await expect(log.locator(":scope > article")).toHaveCount(997);
  // Fifty new rows trim rows 1 to 50, root 50 among them.
  rows.alpha.push(...messageRows("alpha", 50, 1001));
  await page.getByRole("button", { name: "Poll once" }).click();
  await expect(page.locator("#cursor")).toHaveText("Cursor 1050");
  await expect(page.locator(".message")).toHaveCount(1000);
  await expect(page.locator('.message[data-id="50"]')).toHaveCount(0);
  // 150 and 160 lost their parent and stand in the log at their own place; 170 still folds under 150.
  await expect(top(150)).toHaveCount(1);
  await expect(top(160)).toHaveCount(1);
  await expect(top(170)).toHaveCount(0);
  await expect(log.locator('article[data-id="150"] > .thread-toggle')).toHaveText("Show 1 reply");
  await expect(log.locator('article[data-id="160"] > .thread-toggle')).toHaveCount(0);
  const order = await log.evaluate((box) => [...box.children].map((node) => Number(node.dataset.id)));
  expect(order).toEqual([...order].sort((x, y) => x - y));
  expect(order).toHaveLength(999);
});

test("a reply whose parent was deleted (410) or never existed (404) says the parent is gone", async ({
  page,
  request,
}) => {
  const t = await populatedWorkspace(request);
  const rows = { alpha: messageRows("alpha", 2, 10), beta: [] };
  rows.alpha[0].replyTo = 3;
  rows.alpha[1].replyTo = 4;
  await mockHistory(page, t, rows, []);
  for (const [id, status, code] of [
    [3, 410, "message_deleted"],
    [4, 404, "message_not_found"],
  ])
    await page.route(`**${t.path}/channels/alpha/messages/${id}`, (route) =>
      route.fulfill({ status, json: { error: { code, message: "Gone." } } }),
    );
  await connect(page, t, "Tomas", { live: false });
  await openChannel(page, "alpha");
  for (const [id, parent] of [
    [10, 3],
    [11, 4],
  ]) {
    await page.locator(`article[data-id="${id}"] .reply-link`).click();
    await expect(page.locator(`article[data-id="${id}"] > .reply-parent`)).toHaveText(
      `Message #${parent} is no longer available.`,
    );
  }
  await expect(page.locator("#status")).not.toHaveClass(/error/);
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

test("reply and correlation annotations are plain text and never read receipts", async ({
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

test("replies fold under the message they answer, and a reply to an unloaded message fetches it", async ({
  page,
  request,
}, testInfo) => {
  const t = await provision(request);
  const send = async (username, text, replyTo) => {
    const response = await request.post(`${t.path}/channels/general/messages`, {
      headers: t.headers,
      data: { username, text, ...(replyTo ? { replyTo } : {}) },
    });
    expect(response.status()).toBe(201);
    return (await response.json()).message;
  };
  const root = await send("planner", "Plan the release");
  const snapshot = await request.post(`${t.path}/channels/general/snapshots`, {
    headers: { ...t.headers, "Idempotency-Key": "threads-checkpoint" },
    data: {
      username: "planner",
      text: "Plan agreed",
      coversThrough: root.id,
      baseVersion: 0,
      historyRevision: 0,
    },
  });
  expect(snapshot.status()).toBe(201);
  const first = await send("reviewer", "Tests first", root.id);
  const nested = await send("planner", "Agreed, tests first", first.id);
  const other = await send("agent", "Unrelated status");
  await connect(page, t);
  const log = page.locator("#messages");
  // Two rows in the log, in id order; both replies live in the root's folded thread.
  await expect(log.locator(":scope > article")).toHaveCount(2);
  await expect(log.locator(":scope > article").nth(0)).toHaveAttribute("data-id", String(root.id));
  await expect(log.locator(":scope > article").nth(1)).toHaveAttribute("data-id", String(other.id));
  await expect(page.locator(".message")).toHaveCount(4);
  const toggle = log.locator(`article[data-id="${root.id}"] > .thread-toggle`);
  await expect(toggle).toHaveText("Show 2 replies");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(`[data-id="${first.id}"]`)).toBeHidden();
  // A reply that arrives while the thread is folded counts as new on the toggle.
  const late = await send("reviewer", "Release notes drafted", root.id);
  await expect(toggle).toHaveText("Show 3 replies · 1 new");
  await expect(log.locator(":scope > article")).toHaveCount(2);
  await expect(page.locator("#thread-jump")).toHaveText(`New reply in thread #${root.id} · Show`);
  await expect(page.locator("#jump")).toBeHidden();
  // A newer row in the log is seen, but the read mark waits below the folded reply.
  const after = await send("agent", "Status after the reply");
  await expect(log.locator(":scope > article")).toHaveCount(3);
  const readMark = () =>
    page.evaluate(
      (tenant) => Object.values(JSON.parse(localStorage.getItem(`msn.read.${tenant}`) ?? "{}")),
      t.tenant,
    );
  await expect.poll(readMark).toEqual([late.id - 1]);
  // The pointer opens the thread and shows the reply; then the mark can pass it.
  await page.locator("#thread-jump").click();
  await expect(page.locator("#thread-jump")).toBeHidden();
  await expect(toggle).toHaveText("Hide 3 replies");
  await expect(log.locator(`article[data-id="${late.id}"]`)).toBeVisible();
  await page.locator("#messages").evaluate((box) => {
    box.scrollTop = box.scrollHeight;
  });
  await page.locator("#messages").dispatchEvent("scroll");
  await expect.poll(readMark).toEqual([after.id]);
  await toggle.click();
  await expect(toggle).toHaveText("Show 3 replies");
  await toggle.click();
  await expect(toggle).toHaveText("Hide 3 replies");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(log.locator(`article[data-id="${root.id}"] > .thread > article`)).toHaveText([
    /Tests first/,
    /Agreed, tests first/,
    /Release notes drafted/,
  ]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("threads-open.png") });
  // The parent link in a folded reply jumps to the parent in the log.
  await log.locator(`article[data-id="${late.id}"] .reply-link`).click();
  await expect(log.locator(`article[data-id="${root.id}"]`)).toHaveClass(/flash/);
  // Catch-up starts after the snapshot, so the first reply's parent is not loaded: it stays in
  // the log at its own place, keeps the reply under it, and its link fetches the parent.
  await page.getByRole("button", { name: "Catch up", exact: true }).click();
  await expect(page.locator("#checkpoint")).toBeVisible();
  await expect(log.locator(":scope > article")).toHaveCount(4);
  await expect(log.locator(":scope > article").nth(0)).toHaveAttribute("data-id", String(first.id));
  await expect(log.locator(`article[data-id="${first.id}"] > .thread-toggle`)).toHaveText("Show 1 reply");
  await expect(log.locator(`article[data-id="${first.id}"] > .thread > article`)).toHaveAttribute(
    "data-id",
    String(nested.id),
  );
  await expect(page.locator(".reply-parent")).toHaveCount(0);
  await log.locator(`article[data-id="${first.id}"] > .message-annotation .reply-link`).click();
  await expect(log.locator(`article[data-id="${first.id}"] > .reply-parent`)).toHaveText(
    "planner: Plan the release",
  );
  await expect(page.locator(".message")).toHaveCount(5);
});

test("label chips are plain text and list the channel's messages with that label now", async ({
  page,
  request,
}, testInfo) => {
  const t = await provision(request);
  const send = async (text, labels) => {
    const response = await request.post(`${t.path}/channels/general/messages`, {
      headers: t.headers,
      data: { username: "agent", text, ...(labels ? { labels } : {}) },
    });
    expect(response.status()).toBe(201);
    return (await response.json()).message;
  };
  const attack = '<img src=x onerror="window.pwned=true">';
  const parser = await send("fix the parser", { state: "open", area: attack });
  await send("ship the docs", { state: "done" });
  await send("no labels");
  await connect(page, t);
  await expect(page.locator("#messages .message")).toHaveCount(3);
  await expect(page.locator("#messages .label-chip")).toHaveText([
    `area=${attack}`,
    "state=open",
    "state=done",
  ]);
  await expect(page.locator(".label-chip img")).toHaveCount(0);
  // A label changed after the page loaded: the filter asks the server, so it is current.
  const closed = await request.post(`${t.path}/channels/general/messages/${parser.id}/labels`, {
    headers: t.headers,
    data: { set: { state: "done" } },
  });
  expect(closed.status()).toBe(200);
  await page.locator("#messages .label-chip", { hasText: "state=done" }).click();
  await expect(page.locator("#label-filter-title")).toHaveText("2 messages with state=done");
  await expect(page.locator("#label-results .message p")).toHaveText(["fix the parser", "ship the docs"]);
  await page.screenshot({ path: testInfo.outputPath("labels.png") });
  await page.getByRole("button", { name: "Clear" }).click();
  await expect(page.locator("#label-filter")).toBeHidden();
  expect(await page.evaluate(() => window.pwned)).toBeUndefined();
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

// iOS does not shrink the page for the keyboard: it pans the visible area down inside the layout
// viewport until the focused field clears the keyboard. A shell pinned to the top of the layout
// viewport then sits above the screen, and the person sees an empty page over the keyboard.
test("an iOS keyboard pan keeps every field and dialog in the visible area", async ({
  page,
  request,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "phone viewport only");
  const t = await provision(request);
  await request.put(`${t.path}/channels/general/board`, {
    headers: t.headers,
    data: { credential: "b".repeat(64), goal: "Ship it" },
  });
  for (const name of ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"])
    await request.put(`${t.path}/channels/${name}`, { headers: t.headers });
  for (let i = 0; i < 12; i++)
    await request.post(`${t.path}/channels/general/messages`, {
      headers: t.headers,
      data: { username: "agent", text: `message ${i}` },
    });
  await connect(page, t);
  await channelsPane(page);

  // Keyboard shortcuts need a keyboard; a touch-only phone does not list them.
  await expect(page.locator("#show-keys")).toBeHidden();

  const full = await page.evaluate(() => window.innerHeight);
  const visible = Math.round(full * 0.55);
  const pan = full - visible;
  const keyboard = (height, offsetTop) =>
    page.evaluate(
      ([height, offsetTop]) => {
        const viewport = window.visualViewport;
        Object.defineProperty(viewport, "height", { value: height, configurable: true });
        Object.defineProperty(viewport, "offsetTop", { value: offsetTop, configurable: true });
        viewport.dispatchEvent(new Event("resize"));
        viewport.dispatchEvent(new Event("scroll"));
      },
      [height, offsetTop],
    );
  const inView = (selector, top = pan, bottom = full) =>
    page.evaluate(
      ([selector, top, bottom]) => {
        const rect = document.querySelector(selector).getBoundingClientRect();
        return rect.height > 0 && rect.top >= top - 1 && rect.bottom <= bottom + 1;
      },
      [selector, top, bottom],
    );

  // The board list: naming a new channel at the foot of the list, as in the report. A phone
  // keyboard capitalises and spaces; the name is typed the way it will be saved.
  await page.locator("#new-channel").pressSequentially("MSN chat");
  await expect(page.locator("#new-channel")).toHaveValue("msn-chat");
  await page.locator("#new-channel").focus();
  await keyboard(visible, pan);
  await expect
    .poll(() => page.evaluate(() => Math.round(document.body.getBoundingClientRect().top)))
    .toBe(pan);
  await expect.poll(() => inView("#new-channel")).toBe(true);
  expect(await inView(".pane-channels .bar")).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("board-list-keyboard.png") });

  // Moving to another field with the keyboard still up changes no height; that field is
  // revealed too. The access details sit well above the new-channel field.
  await page.getByText("Your access details").click();
  await page.locator(".pane-channels").evaluate((pane) => pane.scrollTo(0, pane.scrollHeight));
  expect(await inView("#credential-name")).toBe(false);
  await page.locator("#credential-name").evaluate((field) => field.focus({ preventScroll: true }));
  await expect.poll(() => inView("#credential-name")).toBe(true);
  await page.locator("#credential-name").blur();
  await page.getByText("Your access details").click();
  await keyboard(full, 0);

  // Dialog fields on the board list: the workspace invitation and a board from a template.
  for (const [opener, field, dialog, close] of [
    ["#invite-workspace", "#invite-uses", "#invite-dialog", "#close-invite"],
    ["#start-template", "#template-channel", "#template-dialog", "#close-template"],
  ]) {
    await page.locator(opener).click();
    await page.locator(field).focus();
    await keyboard(visible, pan);
    await expect.poll(() => inView(field)).toBe(true);
    expect(await inView(dialog)).toBe(true);
    await keyboard(full, 0);
    await page.locator(close).click();
  }
  await expect.poll(() => page.evaluate(() => Math.round(document.body.getBoundingClientRect().top))).toBe(0);

  // The composer: while writing, the board's toolbar steps aside for the conversation.
  await openChannel(page, "general");
  await expect(page.locator(".message")).toHaveCount(12);
  await page.locator("#message").focus();
  await keyboard(visible, pan);
  await expect(page.locator(".toolbar")).toBeHidden();
  await expect(page.locator("#search")).toBeHidden();
  await expect.poll(() => inView("#message")).toBe(true);
  expect(await inView("#channel-title")).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("composer-keyboard.png") });
  // Searching keeps the search field (and its toolbar) above the keyboard.
  await page.locator("#message").blur();
  await page.locator("#search").evaluate((field) => field.focus({ preventScroll: true }));
  await expect(page.locator(".toolbar")).toBeVisible();
  await expect.poll(() => inView("#search")).toBe(true);
  await page.locator("#search").blur();
  await keyboard(full, 0);

  // A dialog field: the dialog centres in what the keyboard leaves, not behind it.
  await page.locator("#board-settings").click();
  await page.locator("#board-goal").focus();
  await keyboard(visible, pan);
  await expect.poll(() => inView("#board-dialog")).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("dialog-keyboard.png") });
  await keyboard(full, 0);
  await page.locator("#close-board").click();

  // A board with no personas says so on one line, not one word per line.
  await page.locator("#agents").click();
  const empty = page.locator("#agents-list .agents-empty");
  await expect(empty).toHaveText("No personas on this board yet.");
  expect(await empty.evaluate((el) => el.getBoundingClientRect().height)).toBeLessThan(60);
  await page.locator("#close-agents").click();

  // Rotating with the keyboard up: the shell follows the new visible area.
  const size = page.viewportSize();
  await page.setViewportSize({ width: size.height, height: size.width });
  const wide = await page.evaluate(() => window.innerHeight);
  await keyboard(wide, 0);
  await page.locator("#message").focus();
  const short = Math.round(wide * 0.45);
  await keyboard(short, wide - short);
  await expect
    .poll(() => page.evaluate(() => Math.round(document.body.getBoundingClientRect().height)))
    .toBe(short);
  await page.screenshot({ path: testInfo.outputPath("landscape-keyboard.png") });
  await expect.poll(() => inView("#message", wide - short, wide)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.locator("#message").blur();
  await page.setViewportSize(size);
  await keyboard(full, 0);

  // The welcome form's create and join modes end in fields that open the keyboard too.
  await disconnect(page);
  for (const [mode, field] of [
    ["create", "#username"],
    ["join", "#join-code"],
  ]) {
    await page.locator("#entry-mode").selectOption(mode);
    await page.locator(field).focus();
    await keyboard(visible, pan);
    await expect.poll(() => inView(field)).toBe(true);
    await page.locator(field).blur();
    await keyboard(full, 0);
  }
});

// A finger needs about 44px. Inline controls in a message row may keep a smaller look when an
// invisible hit area (a positioned ::after) makes up the difference.
test("every control on a phone has a 44px touch target", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "phone viewport only");
  const t = await provision(request);
  await request.put(`${t.path}/channels/general/board`, {
    headers: t.headers,
    data: { credential: "c".repeat(64), goal: "Ship it" },
  });
  await request.post(`${t.path}/channels/general/messages`, {
    headers: t.headers,
    data: { username: "agent", text: "labelled", labels: { phase: "build" } },
  });
  await request.post(`${t.path}/channels/general/messages`, {
    headers: t.headers,
    data: { username: "agent", text: Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n") },
  });
  // A reply that quotes the first message (ADR 0059).
  await request.post(`${t.path}/channels/general/messages`, {
    headers: t.headers,
    data: { username: "agent", text: "on it", replyTo: 1, quote: "labelled" },
  });
  // A question with buttons for this person (ADR 0065).
  await request.post(`${t.path}/channels/general/messages`, {
    headers: t.headers,
    data: { username: "agent", text: "Ship it?", to: "Tomas", choices: ["yes", "no"] },
  });
  // An agent status strip (ADR 0064) with its summary.
  expect(
    (
      await request.put(`${t.path}/channels/general/status`, {
        headers: t.headers,
        data: { username: "agent", text: "checking touch targets" },
      })
    ).status(),
  ).toBe(200);
  const small = () =>
    page.evaluate(() => {
      const out = [];
      const controls = document.querySelectorAll(
        "button, input:not([type=checkbox]):not([type=radio]):not([type=file]), select, textarea, summary, label.check, label.show-archived, label.live-toggle",
      );
      for (const el of controls) {
        const rect = el.getBoundingClientRect();
        if (!rect.width || !rect.height || getComputedStyle(el).visibility === "hidden") continue;
        const after = getComputedStyle(el, "::after");
        const grow =
          after.content !== "none" && after.position === "absolute" ? -2 * Number.parseFloat(after.top) : 0;
        if (rect.height + grow < 43.5)
          out.push(`${el.tagName.toLowerCase()}#${el.id}.${el.className} ${Math.round(rect.height)}+${grow}`);
      }
      return out;
    });
  await connect(page, t);
  await channelsPane(page);
  await page.getByText("Your access details").click();
  expect(await small()).toEqual([]);
  await openChannel(page, "general");
  await expect(page.locator(".message")).toHaveCount(4);
  await expect(page.locator(".label-chip")).toHaveCount(1);
  await expect(page.locator(".choice-button")).toHaveCount(2);
  await expect(page.locator("#statuses")).toBeVisible();
  expect(await small()).toEqual([]);
  // An open thread with a quoted reply, and a composer replying with a quote (ADR 0059).
  await page.locator(".thread-toggle").first().click();
  await expect(page.locator(".message-quote")).toBeVisible();
  await page.getByRole("button", { name: "Quote message #1 in a reply" }).click();
  await expect(page.locator("#quote-note")).toBeVisible();
  expect(await small()).toEqual([]);
  await page.locator("#reply-cancel").click();
  // Each dialog opens only after its data loads. Measure once it is open and filled in, or the
  // check races the open and sees no dialog controls at all.
  for (const [opener, dialog, ready, close] of [
    ["#board-settings", "#board-dialog", "#board-goal", "#close-board"],
    ["#invite-channel", "#invite-dialog", "#copy-invite", "#close-invite"],
    ["#agents", "#agents-dialog", "#agents-list li", "#close-agents"],
  ]) {
    await page.locator(opener).click();
    await expect(page.locator(dialog)).toHaveJSProperty("open", true);
    await expect(page.locator(ready).first()).toBeVisible();
    await expect(page.locator(close)).toBeVisible();
    expect(await small()).toEqual([]);
    await page.locator(close).click();
    await expect(page.locator(dialog)).toHaveJSProperty("open", false);
  }
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

test("each agent's status shows on the board and in Agents with its age, as plain text (ADR 0064)", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(90_000);
  const t = await provision(request, { username: "human" });
  const credential = crypto.randomUUID().replaceAll("-", "").repeat(2);
  expect(
    (
      await request.put(`${t.path}/channels/work/board`, {
        headers: t.headers,
        data: { credential, goal: "Ship agent status" },
      })
    ).status(),
  ).toBe(201);
  const shared = { Authorization: `Bearer ${credential}` };
  for (const name of ["builder", "reviewer"])
    await request.put(`${t.path}/channels/work/personas/${name}`, {
      headers: shared,
      data: { displayName: name },
    });
  const say = (username, text) =>
    request.put(`${t.path}/channels/work/status`, { headers: shared, data: { username, text } });
  expect((await say("builder", "running tests on PR 54")).status()).toBe(200);
  await request.post(`${t.path}/channels/work/messages`, {
    headers: shared,
    data: { username: "reviewer", text: "Looking now" },
  });
  await connect(page, t, "human");
  await openChannel(page, "work");
  const strip = page.locator("#statuses");
  await expect(strip).toBeVisible();
  await expect(page.locator("#statuses-title")).toHaveText("Agent status · 1");
  const row = page.locator("#statuses-list li");
  await expect(row).toHaveCount(1);
  await expect(row.locator("strong")).toHaveText("builder");
  await expect(row.locator(".status-text")).toHaveText("running tests on PR 54");
  await expect(row.locator("time")).toHaveText("just now");
  // Silence is never a status: the reviewer posted but said nothing about what it is doing.
  await expect(strip).not.toContainText("reviewer");
  // Markup in a status is shown as text, never parsed.
  expect((await say("reviewer", "<img src=x onerror=alert(1)> reviewing")).status()).toBe(200);
  // Returning to the page reads statuses at once, so the check does not wait on the 15 s timer.
  const refresh = () => page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await refresh();
  await expect(page.locator("#statuses-list li")).toHaveCount(2, { timeout: 30_000 });
  await expect(page.locator("#statuses-list")).toContainText("<img src=x onerror=alert(1)> reviewing");
  expect(await page.locator("#statuses-list img").count()).toBe(0);
  await page.screenshot({ path: testInfo.outputPath("status-strip.png") });
  await page.locator("#agents").click();
  const rows = page.locator("#agents-list li");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator(".agents-status .status-text")).toHaveText("running tests on PR 54");
  await expect(rows.nth(1).locator(".agents-status")).toContainText("just now");
  await page.screenshot({ path: testInfo.outputPath("status-agents.png") });
  await page.locator("#close-agents").click();
  // Clearing removes the line; with none left, the strip hides.
  await say("builder", null);
  await say("reviewer", null);
  await refresh();
  await expect(strip).toBeHidden({ timeout: 30_000 });
});

test("the owner sets a persona's wake-up webhook in Agents; the secret shows once (ADR 0062)", async ({
  page,
  request,
}, testInfo) => {
  const t = await provision(request, { username: "human" });
  const credential = crypto.randomUUID().replaceAll("-", "").repeat(2);
  await request.put(`${t.path}/channels/work/board`, {
    headers: t.headers,
    data: { credential, goal: "Wake the reviewer" },
  });
  const shared = { Authorization: `Bearer ${credential}` };
  await request.put(`${t.path}/channels/work/personas/reviewer`, {
    headers: shared,
    data: { displayName: "reviewer" },
  });
  await connect(page, t, "human");
  await openChannel(page, "work");
  await page.locator("#agents").click();
  const row = page.locator("#agents-list li").first();
  await expect(row).toContainText("No webhook: its agent wakes only when it listens.");
  await row.getByRole("button", { name: "Add webhook for reviewer" }).click();
  await expect(page.locator("#webhook-title")).toHaveText("Wake reviewer with a webhook");
  // A private address is refused with the server's reason.
  await page.locator("#webhook-url").fill("https://127.0.0.1/wake");
  await page.locator("#webhook-save").click();
  await expect(page.locator("#webhook-state")).toContainText("must point at a public host");
  await expect(page.locator("#webhook-secret-row")).toBeHidden();
  await page.locator("#webhook-url").fill("https://agent.example.com/wake");
  await page.locator("#webhook-save").click();
  await expect(page.locator("#webhook-state")).toHaveText(
    "Saved. Copy the secret now: it is not shown again.",
  );
  await expect(page.locator("#webhook-secret")).toHaveText(/^whsec_[0-9a-f]{64}$/);
  const secret = await page.locator("#webhook-secret").textContent();
  await expect(page.locator("#webhook-test")).toBeVisible();
  await expect(page.locator("#webhook-save")).toHaveText("Save and make a new secret");
  if (testInfo.project.name === "mobile")
    for (const id of [
      "#webhook-save",
      "#webhook-test",
      "#webhook-remove",
      "#copy-webhook-secret",
      "#close-webhook",
    ])
      expect((await page.locator(id).boundingBox()).height, id).toBeGreaterThanOrEqual(43.5);
  await page.screenshot({ path: testInfo.outputPath("webhook-secret.png") });
  // The Agents list behind the dialog now says where the persona wakes.
  await expect(row).toContainText("Wakes agent.example.com");
  await page.locator("#close-webhook").click();
  await expect(page.locator("#webhook-dialog")).toHaveJSProperty("open", false);
  // Reopening never shows the secret again, and the server never returns it.
  await row.getByRole("button", { name: "Webhook for reviewer" }).click();
  await expect(page.locator("#webhook-url")).toHaveValue("https://agent.example.com/wake");
  await expect(page.locator("#webhook-secret-row")).toBeHidden();
  const read = await (
    await request.get(`${t.path}/channels/work/personas/reviewer/webhook`, { headers: t.headers })
  ).text();
  expect(read).not.toContain(secret);
  // The shared board key cannot read or change it.
  expect((await request.get(`${t.path}/channels/work/webhooks`, { headers: shared })).status()).toBe(403);
  await page.locator("#webhook-test").click();
  await expect(page.locator("#webhook-state")).toContainText("Test notice queued");
  await expect(page.locator("#webhook-state")).toContainText("Wakes agent.example.com", { timeout: 10000 });
  await page.locator("#webhook-remove").click();
  await expect(page.locator("#webhook-state")).toHaveText("Webhook removed. Waiting notices were dropped.");
  await expect(page.locator("#webhook-test")).toBeHidden();
  await page.locator("#close-webhook").click();
  await expect(row).toContainText("No webhook");
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

test("the owner mutes a board for an hour, forever, and turns it back on", async ({
  page,
  request,
}, testInfo) => {
  const t = await provision(request, { username: "human" });
  for (const name of ["work", "other"])
    expect((await request.put(`${t.path}/channels/${name}`, { headers: t.headers })).status()).toBe(201);
  const mutes = async () =>
    (await (await request.get(`${t.path}/push/mutes`, { headers: t.headers })).json()).mutes;
  await connect(page, t, "human");
  await openChannel(page, "work");
  const button = page.locator("#mute");
  await expect(button).toHaveText("Mute");
  await expect(button).toHaveAttribute("aria-pressed", "false");
  await button.click();
  await expect(page.locator("#mute-title")).toHaveText("Mute # work");
  await expect(page.locator("#mute-clear")).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath("mute-dialog.png") });
  await page.locator("#mute-save").click();
  await expect(page.locator("#mute-dialog")).not.toBeVisible();
  await expect(button).toHaveText(/^Muted until /);
  await expect(button).toHaveAttribute("aria-pressed", "true");
  const [hour] = await mutes();
  expect(hour).toMatchObject({ channel: "work", everything: false });
  expect(Date.parse(hour.until) - Date.now()).toBeGreaterThan(50 * 60_000);
  await page.screenshot({ path: testInfo.outputPath("muted-board.png") });

  // The mute belongs to the board: another board is not muted.
  await openChannel(page, "other");
  await expect(button).toHaveText("Mute");
  await openChannel(page, "work");
  await expect(button).toHaveText(/^Muted until /);

  await button.click();
  await expect(page.locator("#mute-note")).toContainText("Messages addressed to you still notify.");
  await page.getByLabel("Until I turn it back on").check();
  await page.locator("#mute-everything").check();
  await page.locator("#mute-save").click();
  await expect(button).toHaveText("Muted");
  expect(await mutes()).toEqual([{ channel: "work", until: null, everything: true }]);

  // A mute set elsewhere (the CLI, another device) shows after a reload.
  await request.put(`${t.path}/push/mutes/other`, { headers: t.headers, data: { for: "1d" } });
  await page.reload();
  // The remembered board reopens first; on a phone that swaps to the chat pane.
  await expect(page.locator("#channel-title")).toHaveText("# work");
  await openChannel(page, "other");
  await expect(button).toHaveText(/^Muted until /);
  await button.click();
  await expect(page.getByLabel("1 day")).toBeChecked();
  await page.locator("#close-mute").click();

  await openChannel(page, "work");
  await button.click();
  await page.locator("#mute-clear").click();
  await expect(page.locator("#status")).toHaveText("Notifications are back on for # work.");
  await expect(button).toHaveText("Mute");
  expect((await mutes()).map((m) => m.channel)).toEqual(["other"]);
});

test("only the owner account is offered notifications", async ({ page, request }) => {
  const t = await provision(request);
  const key = await request.put(`/api/admin/tenants/${t.tenant}/keys/agent`, {
    headers: { Authorization: `Bearer ${ADMIN}` },
    data: { username: "agent" },
  });
  await request.put(`${t.path}/channels/work`, { headers: t.headers });
  await connect(page, { tenant: t.tenant, token: (await key.json()).token }, "agent");
  await channelsPane(page);
  await expect(page.locator("#notify")).toBeHidden();
  await openChannel(page, "work");
  await expect(page.locator("#mute")).toBeHidden();
});

test("the board list shows unread counts from this device's read marks", async ({
  page,
  request,
}, testInfo) => {
  const t = await provision(request);
  const post = async (channel, username, text, extra = {}) => {
    const response = await request.post(`${t.path}/channels/${channel}/messages`, {
      headers: t.headers,
      data: { username, text, ...extra },
    });
    expect(response.status()).toBe(201);
  };
  await post("alpha", "lead", "Plan is up");
  await post("beta", "lead", "Other board");
  await post("gamma", "lead", "Never opened here");
  await connect(page, t, "Tomas");
  await expect(page.locator("#channel-title")).toHaveText("# alpha");
  await openChannel(page, "beta");
  await expect(page.locator(".message")).toHaveCount(1);
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), `msn.read.${t.tenant}`))
    .toContain('"Tomas\\nbeta"');

  // While the reader is on beta, alpha moves on: two messages, one addressed to them.
  await post("alpha", "worker", "Started the login fix");
  await post("alpha", "worker", "Which region?", { to: "tomas" });
  await post("alpha", "Tomas", "My own note from another device");
  await post("gamma", "lead", "Still never opened");
  await channelsPane(page);
  await page.getByRole("button", { name: "Refresh channels" }).click();
  const alpha = page.locator('#channels button[data-channel="alpha"]');
  await expect(alpha.locator(".unread-count")).toHaveText("2");
  await expect(alpha.locator(".unread-mine")).toHaveText("@1");
  await expect(alpha).toHaveAccessibleName("# alpha");
  await expect(alpha).toHaveAccessibleDescription("2 unread messages, 1 to you");
  // A board never read on this device has no mark, so no count; the open board shows none.
  await expect(page.locator('#channels button[data-channel="gamma"] .unread')).toBeHidden();
  if (await page.locator("#messages").isVisible())
    await expect(page.locator('#channels button[data-channel="beta"] .unread')).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath("unread-counts.png") });

  // Reading alpha clears its count.
  await openChannel(page, "alpha");
  await expect(page.locator(".message")).toHaveCount(4);
  await page.locator("#messages").evaluate((box) => {
    box.scrollTop = box.scrollHeight;
  });
  await openChannel(page, "beta");
  await channelsPane(page);
  await page.getByRole("button", { name: "Refresh channels" }).click();
  await expect(alpha.locator(".unread")).toBeHidden();
  await expect(alpha).not.toHaveAttribute("aria-describedby");
});

test("a board shows what changed since you last looked, with a marker where you stopped", async ({
  page,
  request,
}, testInfo) => {
  const t = await provision(request);
  const post = async (username, text, extra = {}) => {
    const response = await request.post(`${t.path}/channels/work/messages`, {
      headers: t.headers,
      data: { username, text, ...extra },
    });
    expect(response.status()).toBe(201);
    return (await response.json()).message.id;
  };
  const typed = (username, data) => post(username, JSON.stringify(data), { contentType: "application/json" });
  await post("lead", "Plan is up");
  await connect(page, t, "Tomas");
  await expect(page.locator(".message")).toHaveCount(1);
  // The first visit only records where you are; there is nothing to summarise yet.
  await expect(page.locator("#since")).toBeHidden();
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), `msn.read.${t.tenant}`))
    .toContain('"Tomas\\nwork"');

  // While the reader is away, the board moves on.
  await page.goto("about:blank");
  const first = await typed("lead", {
    schema: "msn.task.v1",
    action: "open",
    task: "login",
    title: "Fix <b>login</b>",
    reviewer: "Tomas",
  });
  await typed("worker", { schema: "msn.task.v1", action: "claim", task: "login" });
  await post("worker", "Which region should I deploy to?", { to: "Tomas" });
  await typed("worker", { schema: "msn.task.v1", action: "block", task: "login", reason: "needs a key" });
  await post("worker", "chatter");

  await page.goto("/");
  await expect(page.locator("#channel-title")).toHaveText("# work");
  await expect(page.locator(".message")).toHaveCount(6);
  const since = page.locator("#since");
  await expect(since).toBeVisible();
  await expect(page.locator("#since-title")).toHaveText(
    "Since you last looked: 5 new messages from lead and worker",
  );
  await expect(page.locator("#since-list li")).toHaveText([
    "worker to you: “Which region should I deploy to?”",
    "worker blocked Fix <b>login</b>: needs a key",
    "lead opened Fix <b>login</b>",
    "worker claimed Fix <b>login</b>",
  ]);
  await expect(page.locator("#since-list b")).toHaveCount(0);
  await expect(page.locator(".message.since-start")).toHaveCount(1);
  await expect(page.locator(".message.since-start")).toHaveAttribute("data-id", String(first));
  await page.screenshot({ path: testInfo.outputPath("since-you-left.png") });
  await page.getByRole("button", { name: "Where I stopped" }).click();
  await expect(page.locator(".message.since-start")).toBeInViewport();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(since).toBeHidden();
  await expect(page.locator(".message.since-start")).toHaveCount(0);

  // Having read to the end, the next visit has nothing new.
  await page.locator("#messages").evaluate((box) => {
    box.scrollTop = box.scrollHeight;
  });
  await page.reload();
  await expect(page.locator(".message")).toHaveCount(6);
  await post("lead", "One more thing");
  await expect(page.locator(".message")).toHaveCount(7);
  await page.reload();
  await expect(page.locator(".message")).toHaveCount(7);
  await expect(since).toBeHidden();

  // Switching tabs: what arrives while the page is hidden is listed on return.
  const visibility = (state) =>
    page.evaluate((value) => {
      Object.defineProperty(document, "visibilityState", { value, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    }, state);
  await visibility("hidden");
  await post("worker", "Ready for review?", { to: "Tomas" });
  await expect(page.locator(".message")).toHaveCount(8);
  await expect(since).toBeHidden();
  await visibility("visible");
  await expect(page.locator("#since-title")).toHaveText("Since you last looked: 1 new message from worker");
  await expect(page.locator("#since-list li")).toHaveText(["worker to you: “Ready for review?”"]);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.reload();
  await expect(page.locator(".message")).toHaveCount(8);
  await expect(since).toBeHidden();
  const disk = await page.evaluate(() => JSON.stringify({ ...localStorage }));
  expect(disk).not.toContain("region");
  await disconnect(page);
  expect(await stored(page)).toEqual([0, 0]);
});

test("with more than 300 unread, opening a board does not mark the rest as read", async ({
  page,
  request,
}) => {
  const t = await provision(request);
  const post = async (text) => {
    const response = await request.post(`${t.path}/channels/work/messages`, {
      headers: t.headers,
      data: { username: "worker", text },
    });
    expect(response.status()).toBe(201);
    return (await response.json()).message.id;
  };
  const start = await post("start");
  await connect(page, t, "Tomas");
  await expect(page.locator(".message")).toHaveCount(1);
  const mark = () =>
    page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key) ?? "{}")["Tomas\nwork"],
      `msn.read.${t.tenant}`,
    );
  await expect.poll(mark).toBe(start);
  await page.goto("about:blank");
  for (let i = 0; i < 320; i += 40)
    await Promise.all(Array.from({ length: 40 }, (_, j) => post(`update ${i + j}`)));
  await page.goto("/");
  await expect(page.locator("#since-title")).toHaveText(
    "Since you last looked: 300+ new messages from worker",
  );
  await expect(page.locator(".message")).toHaveCount(321);
  await expect.poll(() => bottomGap(page)).toBeLessThan(2);
  // Live followed to the newest message, but the mark stops at the last summarised one.
  const covered = await page.evaluate(
    (first) =>
      [...document.querySelectorAll(".message")]
        .map((n) => Number(n.dataset.id))
        .filter((id) => id > first)[299],
    start,
  );
  await expect.poll(mark).toBe(covered);
  await page.reload();
  await expect(page.locator("#since-title")).toHaveText("Since you last looked: 20 new messages from worker");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  // The reload renders history page by page; read the newest id only once every row is back.
  await expect(page.locator(".message")).toHaveCount(321);
  const newest = await page.locator(".message").last().getAttribute("data-id");
  await expect.poll(mark).toBe(Number(newest));
});

test("files attached to messages show as chips and previews, and a person can attach files", async ({
  page,
  request,
}, testInfo) => {
  const t = await provision(request);
  await request.put(`${t.path}/channels/general`, { headers: t.headers });
  // A 1×1 PNG, and a log whose name tries to inject markup.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  );
  const upload = async (data) => {
    const response = await request.post(`${t.path}/channels/general/attachments`, {
      headers: { ...t.headers, "Content-Type": "application/octet-stream" },
      data,
    });
    expect(response.ok()).toBe(true);
    return (await response.json()).attachment.id;
  };
  const attack = '<img src=x onerror="window.pwned=true">.log';
  const sent = await request.post(`${t.path}/channels/general/messages`, {
    headers: t.headers,
    data: {
      username: "agent",
      text: "build failed, screenshot and log attached",
      attachments: [
        { id: await upload(png), name: "screen.png" },
        { id: await upload("step 2 FAILED\n"), name: attack },
      ],
    },
  });
  expect(sent.status()).toBe(201);
  await connect(page, t);
  await expect(page.locator(".attachment")).toHaveText(["screen.png · 70 B", `${attack} · 14 B`]);
  await expect(page.locator(".attachment-preview")).toHaveJSProperty("complete", true);
  await expect
    .poll(() => page.locator(".attachment-preview").evaluate((image) => image.naturalWidth))
    .toBe(1);
  expect(await page.evaluate(() => window.pwned)).toBeUndefined();
  const download = page.waitForEvent("download");
  await page.locator(".attachment").nth(1).click();
  expect((await download).suggestedFilename()).toContain("onerror");

  // A person attaches a patch from the composer; it reaches the board with the message.
  await page.locator("#attach-input").setInputFiles({
    name: "fix.patch",
    mimeType: "text/x-diff",
    buffer: Buffer.from("--- a\n+++ b\n"),
  });
  await expect(page.locator("#attach-list")).toContainText("fix.patch");
  await page.getByLabel("Message", { exact: true }).fill("here is the fix");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.locator(".attachment")).toHaveCount(3);
  await expect(page.locator("#attach-list")).toBeHidden();
  const history = await (
    await request.get(`${t.path}/channels/general/messages`, { headers: t.headers })
  ).json();
  expect(history.messages.at(-1).attachments).toEqual([
    expect.objectContaining({ index: 0, name: "fix.patch", mediaType: "text/x-diff", bytes: 12 }),
  ]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("attachments.png") });
});

test("the owner pins messages to the top of a board; agents see the pins but cannot change them", async ({
  page,
  browser,
  request,
}, testInfo) => {
  const t = await provision(request, { username: "human" });
  const credential = crypto.randomUUID().replaceAll("-", "").repeat(2);
  expect(
    (
      await request.put(`${t.path}/channels/work/board`, {
        headers: t.headers,
        data: { credential, goal: "Ship" },
      })
    ).status(),
  ).toBe(201);
  const shared = { Authorization: `Bearer ${credential}` };
  await request.put(`${t.path}/channels/work/personas/lead`, {
    headers: shared,
    data: { displayName: "lead" },
  });
  const ids = [];
  for (const text of [
    "Rules: one task per agent. <img src=x onerror=alert(1)>",
    "Decision: use SQLite",
    "chatter",
  ]) {
    const sent = await request.post(`${t.path}/channels/work/messages`, {
      headers: shared,
      data: { username: "lead", text },
    });
    ids.push((await sent.json()).message.id);
  }
  await connect(page, t, "human");
  await openChannel(page, "work");
  await expect(page.locator("#pins")).toBeHidden();
  const row = (id) => page.locator(`#messages [data-id="${id}"]`);
  await row(ids[1]).getByRole("button", { name: "Pin" }).click();
  await row(ids[0]).getByRole("button", { name: "Pin" }).click();
  await expect(page.locator("#pins-title")).toHaveText("Pinned · 2");
  const pins = page.locator("#pins-list li");
  // Message order, not pin order; untrusted text stays plain text.
  await expect(pins.nth(0)).toContainText("lead: Rules: one task per agent. <img src=x onerror=alert(1)>");
  await expect(pins.nth(1)).toContainText("Decision: use SQLite");
  await expect(row(ids[0]).getByRole("button", { name: "Unpin" })).toBeVisible();
  // Pinning sends nothing: the log still has the same three messages.
  await expect(page.locator("#messages .message")).toHaveCount(3);
  await page.screenshot({ path: testInfo.outputPath("pins.png") });

  // An agent on the shared credential sees the same pins and has no pin controls.
  const agentContext = await browser.newContext({ viewport: page.viewportSize() ?? undefined });
  const agent = await agentContext.newPage();
  await connect(agent, { tenant: t.tenant, token: credential }, "lead");
  await openChannel(agent, "work");
  await expect(agent.locator("#pins-title")).toHaveText("Pinned · 2");
  await expect(agent.locator("#pins-list .pin-remove")).toHaveCount(0);
  await expect(agent.locator("#messages .pin-toggle")).toHaveCount(0);
  const denied = await request.put(`${t.path}/channels/work/pins/${ids[2]}`, { headers: shared });
  expect(denied.status()).toBe(403);
  await agentContext.close();

  await pins.nth(0).getByRole("button", { name: "Unpin" }).click();
  await expect(page.locator("#pins-title")).toHaveText("Pinned · 1");
  await expect(row(ids[0]).getByRole("button", { name: "Pin" })).toBeVisible();
  await row(ids[1]).getByRole("button", { name: "Unpin" }).click();
  await expect(page.locator("#pins")).toBeHidden();
});

test("people react to a message with a fixed set; reactions toggle and never add to the log", async ({
  page,
  request,
}, testInfo) => {
  const t = await provision(request, { username: "human" });
  const credential = crypto.randomUUID().replaceAll("-", "").repeat(2);
  expect(
    (
      await request.put(`${t.path}/channels/work/board`, {
        headers: t.headers,
        data: { credential, goal: "Ship" },
      })
    ).status(),
  ).toBe(201);
  const shared = { Authorization: `Bearer ${credential}` };
  for (const name of ["lead", "dev <b>x</b>"])
    await request.put(`${t.path}/channels/work/personas/${encodeURIComponent(name.split(" ")[0])}`, {
      headers: shared,
      data: { displayName: name },
    });
  const ids = [];
  for (const text of ["Deploy the worker", "Review the PR"]) {
    const sent = await request.post(`${t.path}/channels/work/messages`, {
      headers: shared,
      data: { username: "lead", text },
    });
    ids.push((await sent.json()).message.id);
  }
  for (const [username, kind] of [
    ["lead", "done"],
    ["dev <b>x</b>", "done"],
    ["dev <b>x</b>", "seen"],
  ])
    expect(
      (
        await request.post(`${t.path}/channels/work/messages/${ids[0]}/reactions`, {
          headers: shared,
          data: { username, kind },
        })
      ).status(),
    ).toBe(200);
  await connect(page, t, "human");
  await openChannel(page, "work");
  const row = (id) => page.locator(`#messages [data-id="${id}"] > .message-reactions`);
  const done = row(ids[0]).getByRole("button", { name: /^Done, 2/ });
  await expect(done).toHaveText("✓ 2");
  // Names are untrusted and only ever shown as text.
  await expect(done).toHaveAttribute("title", /Done: lead, dev <b>x<\/b>/);
  await expect(row(ids[0]).getByRole("button", { name: /^Seen, 1/ })).toHaveText("👀 1");

  await done.click();
  await expect(row(ids[0]).getByRole("button", { name: /^Done, 3/ })).toHaveAttribute("aria-pressed", "true");
  await row(ids[1]).getByRole("button", { name: "React yes" }).click();
  const yes = row(ids[1]).getByRole("button", { name: /^Yes, 1: human/ });
  await expect(yes).toHaveText("👍 1");
  await expect(yes).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({ path: testInfo.outputPath("reactions.png") });
  await yes.click();
  await expect(row(ids[1]).getByRole("button", { name: "React yes" })).toBeAttached();
  await expect(row(ids[1]).locator(".reaction-chip:not(.reaction-add)")).toHaveCount(0);
  // Reacting sends nothing: the log still has the same two messages and the cursor did not move.
  await expect(page.locator("#messages .message")).toHaveCount(2);
  const history = await (
    await request.get(`${t.path}/channels/work/messages`, { headers: t.headers })
  ).json();
  expect(history.messages.map((m) => m.id)).toEqual(ids);
  expect(history.messages[0].reactions).toEqual({
    done: ["lead", "dev <b>x</b>", "human"],
    seen: ["dev <b>x</b>"],
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  // An archived board shows the counts but offers no way to change them.
  await page.locator("#board-settings").click();
  await page.getByRole("button", { name: "Archive board" }).click();
  await expect(page.locator("#archived-note")).toBeVisible();
  await expect(row(ids[0]).getByRole("button", { name: /^Done, 3/ })).toBeVisible();
  for (const add of await page.locator("#messages .reaction-add").all()) await expect(add).toBeHidden();
});

test("people edit their own messages in place; others see the edit and nothing moves", async ({
  page,
  request,
}, testInfo) => {
  const t = await provision(request, { username: "human" });
  const credential = crypto.randomUUID().replaceAll("-", "").repeat(2);
  expect(
    (
      await request.put(`${t.path}/channels/work/board`, {
        headers: t.headers,
        data: { credential, goal: "Ship" },
      })
    ).status(),
  ).toBe(201);
  const shared = { Authorization: `Bearer ${credential}` };
  await request.put(`${t.path}/channels/work/personas/lead`, {
    headers: shared,
    data: { displayName: "lead" },
  });
  await request.put(`${t.path}/channels/other`, { headers: t.headers });
  const send = async (headers, username, text) =>
    (
      await (
        await request.post(`${t.path}/channels/work/messages`, { headers, data: { username, text } })
      ).json()
    ).message.id;
  const mine = await send(t.headers, "human", "Ship it on **mondya**");
  const theirs = await send(shared, "lead", "I will take the <b>deploy</b>");
  await connect(page, t, "human");
  await openChannel(page, "work");
  const article = (id) => page.locator(`#messages article[data-id="${id}"]`);
  // Only your own messages offer Edit.
  await expect(article(theirs).locator(".message-edit")).toHaveCount(0);
  await article(mine)
    .getByRole("button", { name: `Edit message #${mine}` })
    .click();
  const box = article(mine).getByRole("textbox", { name: `New text for message #${mine}` });
  await expect(box).toHaveValue("Ship it on **mondya**");
  // Escape cancels without a change.
  await box.press("Escape");
  await expect(box).toHaveCount(0);
  await expect(article(mine).locator(".message-body strong")).toHaveText("mondya");
  await article(mine)
    .getByRole("button", { name: `Edit message #${mine}` })
    .click();
  await box.fill("Ship it on **monday**");
  await page.screenshot({ path: testInfo.outputPath("edit-form.png") });
  await box.press("Control+Enter");
  await expect(article(mine).locator(".message-body strong")).toHaveText("monday");
  await expect(article(mine).locator(".message-edited")).toHaveText("edited");
  await expect(page.locator("#messages > article")).toHaveCount(2);

  // Another participant's edit shows when the board is read again; text stays plain.
  expect(
    (
      await request.patch(`${t.path}/channels/work/messages/${theirs}`, {
        headers: shared,
        data: { username: "lead", text: "I will take the <i>deploy</i> and the rollback" },
      })
    ).status(),
  ).toBe(200);
  await openChannel(page, "other");
  await openChannel(page, "work");
  await expect(article(theirs).locator(".message-body")).toHaveText(
    "I will take the <i>deploy</i> and the rollback",
  );
  await expect(article(theirs).locator(".message-edited")).toBeVisible();
  await expect(article(theirs).locator("i")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("edited.png") });

  // Nothing moved: same ids, same order, no new message.
  const history = await (
    await request.get(`${t.path}/channels/work/messages`, { headers: t.headers })
  ).json();
  expect(history.messages.map((m) => [m.id, m.text])).toEqual([
    [mine, "Ship it on **monday**"],
    [theirs, "I will take the <i>deploy</i> and the rollback"],
  ]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  // Two editors: a save that started before another device's edit is refused, the editor stays
  // open with the user's text, and a second Save replaces the newer version on purpose.
  await article(mine)
    .getByRole("button", { name: `Edit message #${mine}` })
    .click();
  expect(
    (
      await request.patch(`${t.path}/channels/work/messages/${mine}`, {
        headers: t.headers,
        data: { username: "human", text: "Ship it on monday, from my phone" },
      })
    ).status(),
  ).toBe(200);
  await box.fill("Ship it on **tuesday**");
  await box.press("Control+Enter");
  await expect(page.locator("#status")).toContainText("changed while you were editing");
  await expect(box).toHaveValue("Ship it on **tuesday**");
  await box.press("Control+Enter");
  await expect(box).toHaveCount(0);
  await expect(article(mine).locator(".message-body strong")).toHaveText("tuesday");

  // An archived board offers no Edit.
  await page.locator("#board-settings").click();
  await page.getByRole("button", { name: "Archive board" }).click();
  await expect(page.locator("#archived-note")).toBeVisible();
  await expect(article(mine).locator(".message-edit")).toBeHidden();
});

test("a watch-only invitation lets someone read a board live without posting", async ({
  page,
  request,
  browser,
}, testInfo) => {
  const t = await provision(request, { username: "human" });
  const shared = crypto.randomUUID().replaceAll("-", "").repeat(2);
  expect(
    (
      await request.put(`${t.path}/channels/work/board`, {
        headers: t.headers,
        data: { credential: shared, goal: "Ship the release" },
      })
    ).status(),
  ).toBe(201);
  const agent = { Authorization: `Bearer ${shared}` };
  await request.put(`${t.path}/channels/work/personas/lead`, {
    headers: agent,
    data: { displayName: "lead" },
  });
  const say = (text) =>
    request.post(`${t.path}/channels/work/messages`, { headers: agent, data: { username: "lead", text } });
  await say("Release branch cut");
  await connect(page, t, "human");
  await openChannel(page, "work");
  await page.locator("#invite-channel").click();
  await expect(page.locator("#invite-title")).toHaveText("Shared access to # work");
  await page.getByRole("button", { name: "Create a watch-only link instead" }).click();
  await expect(page.locator("#invite-title")).toHaveText("Invite to # work");
  await expect(page.locator("#invite-watch")).toBeChecked();
  await page.getByRole("button", { name: "Create invitation", exact: true }).click();
  await expect(page.locator("#invite-expiry")).toContainText("Watch only");
  const link = await page.getByLabel("Invitation link", { exact: true }).inputValue();
  await page.locator("#close-invite").click();
  const guest = await browser.newContext(
    testInfo.project.name === "mobile" ? { viewport: { width: 390, height: 844 } } : {},
  );
  try {
    const watcher = await guest.newPage();
    await watcher.goto(link);
    await watcher.getByLabel("Your display name").fill("stakeholder");
    await watcher.getByRole("button", { name: "Join workspace", exact: true }).click();
    await expect(watcher.locator("#workspace")).toBeVisible();
    await expect(watcher.locator("#identity-note")).toHaveText(
      "Watch only · you can read along but not post",
    );
    await expect(watcher.locator("#messages")).toContainText("Release branch cut");
    await expect(watcher.locator("#watch-note")).toBeVisible();
    for (const control of ["#send-form", "#invite-channel", "#board-settings"])
      await expect(watcher.locator(control), control).toBeHidden();
    await say("Tests green, deploying");
    await expect(watcher.locator("#messages")).toContainText("Tests green, deploying");
    // Shortcuts (ADR 0054): j and k still move, but a watcher has no Reply and r starts nothing.
    await watcher.evaluate(() => document.activeElement?.blur());
    await watcher.keyboard.press("k");
    await expect(watcher.locator("#messages > article").last()).toBeFocused();
    await expect(watcher.locator("#messages > article").last()).toHaveAttribute(
      "aria-label",
      /^Message #\d+ from lead$/,
    );
    for (const reply of await watcher.locator("#messages .reply-button").all())
      await expect(reply).toBeHidden();
    await watcher.keyboard.press("r");
    await expect(watcher.locator("#reply-note")).toBeHidden();
    await expect(watcher.locator("#message")).not.toBeFocused();
    await expect(watcher.locator("#status")).not.toContainText("Choose a message");
    await watcher.screenshot({ path: testInfo.outputPath("watch-only.png") });
  } finally {
    await guest.close();
  }
});

test("the search box finds a board's messages by words and sender, newest first, with older pages", async ({
  page,
  request,
}, testInfo) => {
  const t = await provision(request);
  const send = async (text, username = "agent") => {
    const response = await request.post(`${t.path}/channels/general/messages`, {
      headers: t.headers,
      data: { username, text },
    });
    expect(response.status()).toBe(201);
  };
  const attack = '<img src=x onerror="window.pwned=true"> deploy';
  await send("We decided to deploy on Friday", "lead");
  await send("Lunch at noon");
  await send(attack);
  for (let i = 0; i < 20; i++) await send(`deploy check ${i}`, "bot");
  await connect(page, t);
  await page.locator("#search").fill("deploy from:lead");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.locator("#search-title")).toHaveText(
    "1 message matching “deploy” from lead, newest first",
  );
  await expect(page.locator("#search-results .message p")).toHaveText(["We decided to deploy on Friday"]);
  await page.locator("#search").fill("deplo");
  await page.locator("#search").press("Enter");
  await expect(page.locator("#search-title")).toHaveText("20+ messages matching “deplo”, newest first");
  await expect(page.locator("#search-results .message p").first()).toHaveText("deploy check 19");
  await page.getByRole("button", { name: "Older matches" }).click();
  await expect(page.locator("#search-title")).toHaveText("22 messages matching “deplo”, newest first");
  await expect(page.locator("#search-results .message p").last()).toHaveText(
    "We decided to deploy on Friday",
  );
  await expect(page.locator("#search-results img")).toHaveCount(0);
  await expect(page.locator("#search-older")).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath("search.png") });
  await page.locator("#search-clear").click();
  await expect(page.locator("#search-panel")).toBeHidden();
  expect(await page.evaluate(() => window.pwned)).toBeUndefined();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("each message shows which personas committed past it, from explicit commits only", async ({
  page,
  request,
}, testInfo) => {
  const t = await provision(request, { username: "human" });
  const credential = "d".repeat(64);
  const board = { Authorization: `Bearer ${credential}` };
  expect(
    (
      await request.put(`${t.path}/channels/work/board`, {
        headers: t.headers,
        data: { credential, goal: "Review the release" },
      })
    ).status(),
  ).toBe(201);
  for (const [id, displayName] of [
    ["p1", "reviewer"],
    ["p2", "worker-2"],
    ["p3", "silent"],
  ])
    await request.put(`${t.path}/channels/work/personas/${id}`, { headers: board, data: { displayName } });
  for (const text of ["first task", "second task"])
    expect(
      (
        await request.post(`${t.path}/channels/work/messages`, {
          headers: t.headers,
          data: { username: "human", text },
        })
      ).status(),
    ).toBe(201);
  // The reviewer's own reply never lists the reviewer.
  expect(
    (
      await request.post(`${t.path}/channels/work/messages`, {
        headers: board,
        data: { username: "reviewer", personaId: "p1", text: "looking" },
      })
    ).status(),
  ).toBe(201);
  const reader = `${t.path}/channels/work/processing/p1`;
  const claim = await request.post(`${reader}/claim`, { headers: board, data: { expectGeneration: 0 } });
  expect(claim.status()).toBe(201);
  expect(
    (
      await request.post(`${reader}/commit`, { headers: board, data: { generation: 1, through: 1 } })
    ).status(),
  ).toBe(200);
  // worker-2 has a server cursor at 0; silent never committed, so it is never listed.
  expect(
    (
      await request.post(`${t.path}/channels/work/processing/p2/claim`, {
        headers: board,
        data: { expectGeneration: 0 },
      })
    ).status(),
  ).toBe(201);

  await connect(page, t, "human", { live: false });
  await openChannel(page, "work");
  const receipts = page.locator("#messages .message-receipts");
  await expect(receipts).toHaveText([
    "Processed by reviewer · not yet: worker-2",
    "Not yet processed by reviewer, worker-2",
    "Not yet processed by worker-2",
  ]);
  await expect(receipts.first()).toHaveAttribute(
    "title",
    /processing commits sent to the server.*--local keeps them off.*never commit to the server are not listed/,
  );
  await page.screenshot({ path: testInfo.outputPath("receipts.png") });

  // A later commit shows on the next poll; nothing changes from silence or presence.
  expect(
    (
      await request.post(`${reader}/commit`, { headers: board, data: { generation: 1, through: 2 } })
    ).status(),
  ).toBe(200);
  await page.locator("#poll").click();
  await expect(receipts).toHaveText([
    "Processed by reviewer · not yet: worker-2",
    "Processed by reviewer · not yet: worker-2",
    "Not yet processed by worker-2",
  ]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("a message link opens its board on that message, opens its thread, and says when the message is gone", async ({
  page,
  request,
}, testInfo) => {
  const t = await provision(request);
  const send = async (channel, text, replyTo, labels) => {
    const response = await request.post(`${t.path}/channels/${channel}/messages`, {
      headers: t.headers,
      data: { username: "planner", text, ...(replyTo ? { replyTo } : {}), ...(labels ? { labels } : {}) },
    });
    expect(response.status()).toBe(201);
    return (await response.json()).message;
  };
  const root = await send("general", "Plan the release");
  const decision = await send("general", "Decision: ship on Friday", root.id, { kind: "decision" });
  await send("general", "Unrelated status");
  const gone = await send("general", "Typo, ignore");
  await request.delete(`/api/admin/tenants/${t.tenant}/channels/general/messages/${gone.id}`, {
    headers: { Authorization: `Bearer ${ADMIN}` },
  });
  await send("other", "Another board");
  const link = (channel, id) => `/#board=${t.tenant}/${channel}&msg=${id}`;
  // Record copies instead of touching the real clipboard.
  await page.addInitScript(() => {
    window.copied = [];
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async (text) => window.copied.push(text) },
    });
  });
  await connect(page, t);
  await openChannel(page, "other");
  // Following a link while connected switches board, opens the folded thread and highlights.
  await page.goto(link("general", decision.id));
  await expect(page.locator("#channel-title")).toHaveText("# general");
  const target = page.locator(`article[data-id="${decision.id}"]`);
  await expect(target).toBeVisible();
  await expect(target).toHaveClass(/linked/);
  await expect(page.locator(`article[data-id="${root.id}"] > .thread-toggle`)).toHaveText("Hide 1 reply");
  await expect(page.locator("#status")).toHaveText(`Showing message #${decision.id} in #general.`);
  expect(new URL(page.url()).hash).toBe("");
  await page.screenshot({ path: testInfo.outputPath("message-link.png") });
  // The Link button copies the same link; it names the message, never a credential.
  await target.getByRole("button", { name: `Copy link to message #${decision.id}` }).click();
  await expect(page.locator("#status")).toHaveText(`Link to message #${decision.id} copied.`);
  const copied = await page.evaluate(() => window.copied);
  expect(copied).toEqual([`${new URL(page.url()).origin}${link("general", decision.id)}`]);
  expect(copied[0]).not.toContain(t.token);
  // Search and label results offer the same Link.
  await page.getByLabel("Search this board").getByRole("searchbox").fill("Friday");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page
    .locator("#search-results")
    .getByRole("button", { name: `Copy link to message #${decision.id}` })
    .click();
  await page.getByRole("button", { name: "Clear" }).first().click();
  await target.getByRole("button", { name: "kind=decision" }).click();
  await page
    .locator("#label-results")
    .getByRole("button", { name: `Copy link to message #${decision.id}` })
    .click();
  expect(await page.evaluate(() => window.copied)).toEqual([copied[0], copied[0], copied[0]]);
  await page.locator("#label-filter-clear").click();
  // Deleted (410) and missing (404) messages leave a clear note.
  await page.goto(link("general", gone.id));
  await expect(page.locator("#link-note-text")).toHaveText(`Message #${gone.id} was deleted from #general.`);
  await page.goto(link("general", 999999));
  await expect(page.locator("#link-note-text")).toHaveText(
    "Message #999999 is not on #general. Check the link.",
  );
  await page.getByRole("button", { name: "Dismiss" }).click();
  await expect(page.locator("#link-note")).toBeHidden();
  await page.goto(link("missing-board", 1));
  await expect(page.locator("#status")).toHaveText(
    "Board #missing-board is not in this workspace, or your access key cannot read it.",
  );
  // Opened in a new tab, a remembered connection reconnects and then shows the message.
  await page.goto("about:blank");
  await page.goto(link("general", decision.id));
  await expect(page.locator(`article[data-id="${decision.id}"]`)).toHaveClass(/linked/);
  await expect(page.locator(`article[data-id="${decision.id}"]`)).toBeVisible();
  // Not connected at all: the form names the workspace, and connecting opens the message.
  await disconnect(page);
  await page.goto("about:blank");
  await page.goto(link("general", decision.id));
  await expect(page.locator("#status")).toHaveText(
    `Connect to workspace “${t.tenant}” to open message #${decision.id}.`,
  );
  await expect(page.getByLabel("Workspace", { exact: true })).toHaveValue(t.tenant);
  await page.getByLabel("Access key").fill(t.token);
  await page.getByLabel("Your display name").fill("Tomas");
  await page.getByRole("button", { name: "Connect", exact: false }).click();
  await expect(page.locator(`article[data-id="${decision.id}"]`)).toHaveClass(/linked/);
  await page.goto("/#board=not a link&msg=1");
  await expect(page.locator("#status")).toHaveText("Invalid message link.");
});

test("a link to a message outside the loaded log reads forward, or shows the board from that message", async ({
  page,
  request,
}) => {
  const t = await populatedWorkspace(request);
  const rows = { alpha: messageRows("alpha", 1000), beta: [] };
  rows.alpha[899].replyTo = 20;
  const requests = [];
  await mockHistory(page, t, rows, requests);
  await page.route(new RegExp(`${t.path}/channels/alpha/messages/(\\d+)$`), (route) => {
    const id = Number(new URL(route.request().url()).pathname.split("/").at(-1));
    return route.fulfill({ json: { message: rows.alpha[id - 1], historyRevision: 0 } });
  });
  await connect(page, t, "Tomas", { live: false });
  await expect(page.locator("#channel-title")).toHaveText("# alpha");
  await expect(page.locator("#cursor")).toHaveText("Cursor 100");
  const readMark = () =>
    page.evaluate(
      (tenant) => Object.values(JSON.parse(localStorage.getItem(`msn.read.${tenant}`) ?? "{}")),
      t.tenant,
    );
  await expect.poll(readMark).toEqual([100]);
  // Just ahead of the log: read forward page by page, as "Load next page" would.
  await page.goto(`/#board=${t.tenant}/alpha&msg=250`);
  await expect(page.locator('article[data-id="250"]')).toHaveClass(/linked/);
  await expect(page.locator("#cursor")).toHaveText("Cursor 300");
  await expect(page.locator('article[data-id="1"]')).toHaveCount(1);
  await expect(page.locator("#link-note")).toBeHidden();
  // Far ahead: after three pages the board is shown from the message onward instead.
  await page.goto(`/#board=${t.tenant}/alpha&msg=900`);
  await expect(page.locator('article[data-id="900"]')).toHaveClass(/linked/);
  await expect(page.locator("#link-note-text")).toHaveText(
    "Showing #alpha from message #900. Earlier messages are not loaded.",
  );
  await expect(page.locator("#messages > article").first()).toHaveAttribute("data-id", "900");
  expect(requests.at(-1)).toEqual({ name: "alpha", after: 899 });
  // Following links is not reading what they skip: the read mark has not moved.
  expect(await readMark()).toEqual([100]);
  // Its parent is not loaded, so the reply quotes it.
  await expect(page.locator('article[data-id="900"] > .reply-parent')).toHaveText(/^agent: alpha row 20/);
  // Older than the log: the same.
  await page.goto(`/#board=${t.tenant}/alpha&msg=5`);
  await expect(page.locator("#messages > article").first()).toHaveAttribute("data-id", "5");
  await expect(page.locator('article[data-id="5"]')).toHaveClass(/linked/);
  expect(await readMark()).toEqual([100]);
  const sent = requests.length;
  await page.getByRole("button", { name: "Load from the start" }).click();
  await expect(page.locator("#link-note")).toBeHidden();
  await expect(page.locator("#messages > article").first()).toHaveAttribute("data-id", "1");
  expect(requests.slice(sent)).toContainEqual({ name: "alpha", after: 0 });
  // The skipped messages are still news: the summary starts after the held mark.
  await expect.poll(() => requests.slice(sent)).toContainEqual({ name: "alpha", after: 100 });
  await expect(page.locator("#since")).toBeVisible();
});

test("a link for another workspace waits through Disconnect and opens after connecting there", async ({
  page,
  request,
}) => {
  const first = await provision(request);
  const second = await provision(request);
  const response = await request.post(`${second.path}/channels/release/messages`, {
    headers: second.headers,
    data: { username: "planner", text: "Release on Friday" },
  });
  const { message } = await response.json();
  await connect(page, first);
  await page.goto(`/#board=${second.tenant}/release&msg=${message.id}`);
  await expect(page.locator("#status")).toHaveText(
    `This link is for workspace “${second.tenant}”. Disconnect, then connect to it to open message #${message.id}.`,
  );
  await disconnect(page);
  await page.getByLabel("Workspace", { exact: true }).fill(second.tenant);
  await page.getByLabel("Access key").fill(second.token);
  await page.getByLabel("Your display name").fill("Tomas");
  await page.getByRole("button", { name: "Connect", exact: false }).click();
  await expect(page.locator(`article[data-id="${message.id}"]`)).toHaveClass(/linked/);
  await expect(page.locator("#channel-title")).toHaveText("# release");
  await page.goto("/#invite=abc&msg=1");
  await expect(page.locator("#status")).toHaveText("Invalid message link.");
});

test("the owner archives a finished board: it leaves the list, reads but takes no posts, and comes back", async ({
  page,
  request,
}, testInfo) => {
  const t = await provision(request, { username: "human" });
  const shared = crypto.randomUUID().replaceAll("-", "").repeat(2);
  expect(
    (
      await request.put(`${t.path}/channels/work/board`, {
        headers: t.headers,
        data: { credential: shared, goal: "Ship the release" },
      })
    ).status(),
  ).toBe(201);
  const agent = { Authorization: `Bearer ${shared}` };
  await request.put(`${t.path}/channels/work/personas/lead`, {
    headers: agent,
    data: { displayName: "lead" },
  });
  await request.post(`${t.path}/channels/work/messages`, {
    headers: agent,
    data: { username: "lead", text: "Release shipped" },
  });
  await connect(page, t, "human");
  await openChannel(page, "work");
  await expect(page.locator("#archived-note")).toBeHidden();
  await page.locator("#board-settings").click();
  await page.getByRole("button", { name: "Archive board" }).click();
  await expect(page.locator("#archived-note")).toBeVisible();
  for (const control of ["#send-form", "#invite-channel", "#board-settings"])
    await expect(page.locator(control), control).toBeHidden();
  await expect(page.locator("#messages")).toContainText("Release shipped");
  await expect(page.locator("#messages .pin-toggle")).toBeHidden();
  await expect(page.locator("#status")).toContainText("is archived");
  await page.screenshot({ path: testInfo.outputPath("archived-board.png") });
  const refused = await request.post(`${t.path}/channels/work/messages`, {
    headers: agent,
    data: { username: "lead", text: "One more" },
  });
  expect(refused.status()).toBe(409);

  await channelsPane(page);
  await expect(page.getByRole("button", { name: "# work", exact: true })).toHaveCount(0);
  await page.getByLabel("Show archived").check();
  await page.getByRole("button", { name: "# work · archived" }).click();
  await expect(page.locator("#archived-note")).toBeVisible();
  await page.getByRole("button", { name: "Unarchive" }).click();
  await expect(page.locator("#archived-note")).toBeHidden();
  await expect(page.locator("#send-form")).toBeVisible();
  await channelsPane(page);
  await expect(page.getByRole("button", { name: "# work", exact: true })).toBeVisible();
});

// Every text element the board shows, with the background it is painted on, must meet WCAG AA.
async function lowContrast(page) {
  return page.evaluate(() => {
    const parse = (value) => {
      const n = value.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 0];
      return [n[0], n[1], n[2], n.length > 3 ? n[3] : 1];
    };
    const over = (top, under) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat(1);
    const lum = ([r, g, b]) => {
      const ch = (c) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
      return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
    };
    const backdrop = (element) => {
      const layers = [];
      for (let node = element; node; node = node.parentElement) {
        const fill = parse(getComputedStyle(node).backgroundColor);
        if (fill[3] > 0) layers.push(fill);
        if (fill[3] === 1) break;
      }
      let colour = [255, 255, 255, 1];
      if (!layers.length || layers.at(-1)[3] < 1)
        colour = parse(getComputedStyle(document.documentElement).backgroundColor);
      for (const layer of layers.reverse()) colour = over(layer, colour);
      return colour;
    };
    const selectors = [
      "#channel-title",
      "nav button",
      ".theme-pick",
      ".toolbar button:not(:disabled)",
      ".message-meta strong",
      ".message-meta span",
      ".message p",
      ".message .md",
      ".message code",
      ".message pre",
      ".message a[href]",
      ".message .md blockquote",
      ".label-chip",
      ".message-receipts",
      ".pins summary",
      ".pins .pin-text",
      ".pins .pin-remove",
      ".unread-count",
      "#status",
    ];
    const failures = [];
    const seen = new Set();
    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        if (!element.getClientRects().length || !element.textContent.trim()) continue;
        seen.add(selector);
        const under = backdrop(element);
        const text = over(parse(getComputedStyle(element).color), under);
        const [hi, lo] = [lum(text), lum(under)].sort((a, b) => b - a);
        const ratio = (hi + 0.05) / (lo + 0.05);
        if (ratio < 4.5)
          failures.push(`${selector} "${element.textContent.trim().slice(0, 20)}": ${ratio.toFixed(2)}`);
      }
    }
    return { failures, seen: [...seen] };
  });
}

test("the board follows the system light or dark setting, and this device can force either", async ({
  page,
  request,
}, testInfo) => {
  const t = await provision(request, { username: "human" });
  const shared = "e".repeat(64);
  const board = { Authorization: `Bearer ${shared}` };
  expect(
    (
      await request.put(`${t.path}/channels/work/board`, {
        headers: t.headers,
        data: { credential: shared, goal: "Ship the light theme" },
      })
    ).status(),
  ).toBe(201);
  await request.put(`${t.path}/channels/work/personas/p1`, {
    headers: board,
    data: { displayName: "reviewer" },
  });
  const post = async (headers, data) => {
    const response = await request.post(`${t.path}/channels/work/messages`, { headers, data });
    expect(response.status()).toBe(201);
    return (await response.json()).message.id;
  };
  const decision = await post(t.headers, {
    username: "human",
    text: "Decision: tokens only, no server change",
  });
  await post(board, {
    username: "reviewer",
    personaId: "p1",
    text: "Checked `style.css` in **both** themes:\n\n```\nbun run check\n```\n\n> contrast is AA\n\nSee [ADR 0049](https://example.com/adr).",
  });
  await post(t.headers, { username: "human", text: "Ship it", labels: { state: "open", area: "web" } });
  const reader = `${t.path}/channels/work/processing/p1`;
  expect(
    (await request.post(`${reader}/claim`, { headers: board, data: { expectGeneration: 0 } })).status(),
  ).toBe(201);
  expect(
    (
      await request.post(`${reader}/commit`, { headers: board, data: { generation: 1, through: 1 } })
    ).status(),
  ).toBe(200);

  const background = () => page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
  const audit = async () => {
    const { failures, seen } = await lowContrast(page);
    expect(failures).toEqual([]);
    for (const required of [
      ".message-meta strong",
      ".message code",
      ".message pre",
      ".label-chip",
      ".message-receipts",
      ".pins summary",
      ".pins .pin-text",
    ])
      expect(seen).toContain(required);
  };

  // No choice saved: the page follows the system setting, live.
  await page.emulateMedia({ colorScheme: "light" });
  await connect(page, t, "human", { live: false });
  await openChannel(page, "work");
  await page.locator(`#messages [data-id="${decision}"]`).getByRole("button", { name: "Pin" }).click();
  await expect(page.locator("#pins-title")).toHaveText("Pinned · 1");
  await expect(page.locator("#messages .message-receipts").first()).toBeVisible();
  await expect(page.locator("html")).not.toHaveAttribute("data-theme");
  expect(await background()).toBe("rgb(247, 247, 249)");
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#f7f7f9");
  await audit();
  await page.screenshot({ path: testInfo.outputPath("theme-light.png") });
  await page.emulateMedia({ colorScheme: "dark" });
  expect(await background()).toBe("rgb(11, 11, 14)");
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#0b0b0e");
  await audit();
  await page.screenshot({ path: testInfo.outputPath("theme-dark.png") });

  // Forcing light on a dark system holds across a reload and a disconnect; Match system undoes it.
  await channelsPane(page);
  await expect(page.getByLabel("Theme on this device")).toHaveValue("");
  await page.getByLabel("Theme on this device").selectOption("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await background()).toBe("rgb(247, 247, 249)");
  await page.reload();
  await expect(page.locator("#channel-title")).toHaveText("# work");
  expect(await background()).toBe("rgb(247, 247, 249)");
  await channelsPane(page);
  await expect(page.getByLabel("Theme on this device")).toHaveValue("light");
  await page.getByLabel("Theme on this device").selectOption("dark");
  await page.emulateMedia({ colorScheme: "light" });
  expect(await background()).toBe("rgb(11, 11, 14)");
  await disconnect(page);
  expect(await background()).toBe("rgb(11, 11, 14)");
  expect(await page.evaluate(() => localStorage.getItem("msn.theme"))).toBe("dark");
  await page.goto("/guide.html");
  expect(await background()).toBe("rgb(11, 11, 14)");
  await connect(page, t, "human", { live: false });
  await channelsPane(page);
  await page.getByLabel("Theme on this device").selectOption("");
  await expect(page.locator("html")).not.toHaveAttribute("data-theme");
  expect(await background()).toBe("rgb(247, 247, 249)");
  expect(await page.evaluate(() => localStorage.getItem("msn.theme"))).toBeNull();
});

test("Download saves the board as a Markdown transcript with escaped, fenced message text", async ({
  page,
  request,
}, testInfo) => {
  const t = await provision(request);
  await request.put(`${t.path}/channels/general`, { headers: t.headers });
  await request.put(`${t.path}/channels/other`, { headers: t.headers });
  const post = async (data, channel = "general") => {
    const response = await request.post(`${t.path}/channels/${channel}/messages`, {
      headers: t.headers,
      data,
    });
    expect(response.status()).toBe(201);
    return (await response.json()).message.id;
  };
  const first = await post({ username: "planner-agent", text: "Plan:\n1. build\n2. ship" });
  await post({ username: "noise", text: "elsewhere" }, "other");
  const hostile = "```\n# not a heading\n<script>window.pwned=true</script>";
  const reply = await post({ username: "bob <b>", text: hostile, replyTo: first, to: "planner-agent" });
  await request.post(`${t.path}/channels/general/messages/${reply}/labels`, {
    headers: t.headers,
    data: { set: { status: "done" } },
  });
  await connect(page, t);
  await openChannel(page, "general");
  await expect(page.locator("#download")).toBeEnabled();
  const download = page.waitForEvent("download");
  await page.locator("#download").click();
  const file = await download;
  expect(file.suggestedFilename()).toBe(`${t.tenant}-general-transcript.md`);
  const text = await (await import("node:fs/promises")).readFile(await file.path(), "utf8");
  expect(text).toContain("# Transcript of #general");
  expect(text).toContain("- Messages: 2,");
  expect(text).not.toContain("elsewhere");
  expect(text).toMatch(
    new RegExp(`### #${first} · \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d UTC · planner-agent\\n`),
  );
  expect(text).toMatch(new RegExp(`### #${reply} · .* UTC · bob \\\\<b\\\\>\\n`));
  expect(text).toContain(`- Reply to: [#${first}](#msg-${first})`);
  expect(text).toContain("- To: planner-agent");
  expect(text).toContain("- Labels: status=done");
  // The hostile text sits inside a fence longer than its own backtick run.
  expect(text).toContain(`\`\`\`\`text\n${hostile}\n\`\`\`\``);
  await expect(page.locator("#status")).toContainText("Downloaded #general as a transcript · 2 messages");
  expect(await page.evaluate(() => window.pwned)).toBeUndefined();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("transcript.png") });
});

test("long messages fold behind Show more; links, jumps and search hits show them whole (ADR 0050)", async ({
  page,
  request,
}, testInfo) => {
  const t = await provision(request);
  const send = async (text, replyTo) => {
    const response = await request.post(`${t.path}/channels/general/messages`, {
      headers: t.headers,
      data: { username: "planner", text, ...(replyTo ? { replyTo } : {}) },
    });
    expect(response.status()).toBe(201);
    return (await response.json()).message;
  };
  const lines = (prefix, count) =>
    Array.from({ length: count }, (_, i) => `${prefix} line ${i + 1}`).join("\n");
  const short = await send(lines("Short", 12));
  const long = await send(`${lines("Report", 40)}\nlast words: zebracrossing`);
  // A code block that runs across the fold stays one whole block; CSS clips it, nothing cuts it.
  const code = await send(
    ["## Log", "", "```", lines("output", 30), "```", "", "Done **ok** after the block."].join("\n"),
  );
  const reply = await send(lines("Reply", 30), long.id);
  await connect(page, t, "Tomas", { remember: false });
  const row = (id) => page.locator(`#messages article[data-id="${id}"]`);
  const toggle = (id) => row(id).locator(":scope > .fold-toggle");
  const body = (id) => row(id).locator(":scope > .message-body");
  await expect(row(code.id)).toBeVisible();

  // Short messages have no control; long ones show their first lines and Show more.
  await expect(toggle(short.id)).toBeHidden();
  await expect(body(short.id)).not.toHaveClass(/folded/);
  await expect(body(long.id)).toHaveClass(/folded/);
  await expect(toggle(long.id)).toHaveText("Show more");
  await expect(toggle(long.id)).toHaveAttribute("aria-expanded", "false");
  const folded = await body(long.id).evaluate((el) => ({ shown: el.clientHeight, full: el.scrollHeight }));
  expect(folded.shown).toBeLessThan(folded.full / 2);
  // Display only: the whole text is still in the page.
  await expect(body(long.id)).toContainText("last words: zebracrossing");
  const pre = body(code.id).locator("pre.md-code");
  await expect(body(code.id)).toHaveClass(/folded/);
  await expect(pre).toHaveCount(1);
  expect((await pre.textContent()).trim().split("\n")).toHaveLength(30);
  await expect(body(code.id).locator("strong")).toHaveText("ok");
  await page.screenshot({ path: testInfo.outputPath("folded.png") });
  // Light theme (ADR 0049): the control uses the light accent, and the fold still clips.
  await page.emulateMedia({ colorScheme: "light" });
  await expect(toggle(long.id)).toHaveCSS("color", "rgb(179, 0, 143)");
  await expect(body(long.id)).toHaveClass(/folded/);
  await page.screenshot({ path: testInfo.outputPath("folded-light.png") });
  await page.emulateMedia({ colorScheme: "dark" });

  // Show more opens it, Show less folds it again.
  await toggle(long.id).click();
  await expect(body(long.id)).not.toHaveClass(/folded/);
  await expect(toggle(long.id)).toHaveText("Show less");
  await expect(toggle(long.id)).toHaveAttribute("aria-expanded", "true");
  expect(await body(long.id).evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
  await toggle(long.id).click();
  await expect(body(long.id)).toHaveClass(/folded/);

  // A long reply folds inside its thread once the thread opens.
  await row(long.id).locator(":scope > .thread-toggle").click();
  await expect(row(reply.id)).toBeVisible();
  await expect(body(reply.id)).toHaveClass(/folded/);
  await expect(toggle(reply.id)).toHaveText("Show more");

  // A search hit shows in full: the match is below the fold.
  await page.getByLabel("Search this board").getByRole("searchbox").fill("zebracrossing");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const hit = page.locator(`#search-results article[data-id="${long.id}"]`);
  await expect(hit).toBeVisible();
  await expect(hit.locator(".fold-toggle")).toHaveCount(0);
  await expect(hit.getByText("last words: zebracrossing")).toBeVisible();
  await page.getByRole("button", { name: "Clear" }).first().click();

  // A message link opens the message unfolded and highlighted.
  await page.goto(`/#board=${t.tenant}/general&msg=${code.id}`);
  await expect(row(code.id)).toHaveClass(/linked/);
  await expect(body(code.id)).not.toHaveClass(/folded/);
  await expect(toggle(code.id)).toHaveText("Show less");
  await expect(row(code.id)).toBeInViewport();
  expect(await body(code.id).evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("linked-unfolded.png") });
});

test("a link opened on page load lands on its message below many folded ones, and folds survive a board switch (ADR 0050)", async ({
  page,
  request,
}) => {
  const t = await provision(request);
  const send = async (channel, text) => {
    const response = await request.post(`${t.path}/channels/${channel}/messages`, {
      headers: t.headers,
      data: { username: "planner", text },
    });
    expect(response.status()).toBe(201);
    return (await response.json()).message;
  };
  const lines = (prefix, count) =>
    Array.from({ length: count }, (_, i) => `${prefix} line ${i + 1}`).join("\n");
  const long = [];
  for (let n = 1; n <= 20; n++) long.push(await send("general", lines(`Report ${n}`, 40)));
  const target = await send("general", "The target message");
  for (let n = 21; n <= 24; n++) long.push(await send("general", lines(`Report ${n}`, 40)));
  await send("other", "Another board");
  await connect(page, t);
  const row = (id) => page.locator(`#messages article[data-id="${id}"]`);
  const body = (id) => row(id).locator(":scope > .message-body");
  const toggle = (id) => row(id).locator(":scope > .fold-toggle");
  await expect(row(target.id)).toBeVisible();

  // A fresh page load on the link: everything above folds before the scroll, so it lands.
  await page.goto("about:blank");
  await page.goto(`/#board=${t.tenant}/general&msg=${target.id}`);
  await expect(row(target.id)).toHaveClass(/linked/);
  await expect(body(long[0].id)).toHaveClass(/folded/);
  await expect(row(target.id)).toBeInViewport();

  // Show more on one message survives switching board and back; the reading position holds.
  const opened = long[19];
  await toggle(opened.id).click();
  await expect(body(opened.id)).not.toHaveClass(/folded/);
  await row(opened.id).scrollIntoViewIfNeeded();
  const offset = () =>
    row(opened.id).evaluate(
      (el) =>
        el.getBoundingClientRect().top - document.getElementById("messages").getBoundingClientRect().top,
    );
  const before = await offset();
  await openChannel(page, "other");
  await openChannel(page, "general");
  await expect(body(opened.id)).not.toHaveClass(/folded/);
  await expect(toggle(opened.id)).toHaveText("Show less");
  await expect(body(long[18].id)).toHaveClass(/folded/);
  expect(Math.abs((await offset()) - before)).toBeLessThanOrEqual(2);
});

test("keyboard shortcuts move between messages, reply, search, open the board list and never fire while typing", async ({
  page,
  request,
}, testInfo) => {
  const t = await provision(request);
  const ids = [];
  for (const [channel, text] of [
    ["notes", "Notes board"],
    ["work", "Deploy the worker"],
    ["work", "Review the PR"],
    ["work", "Ship the release"],
  ]) {
    const sent = await request.post(`${t.path}/channels/${channel}/messages`, {
      headers: t.headers,
      data: { username: "lead", text },
    });
    expect(sent.status()).toBe(201);
    if (channel === "work") ids.push((await sent.json()).message.id);
  }
  await connect(page, t, "human");
  await openChannel(page, "work");
  await expect(page.locator("#messages .message")).toHaveCount(3);
  const row = (id) => page.locator(`#messages article[data-id="${id}"]`);
  const blur = () => page.evaluate(() => document.activeElement?.blur());

  // Typing in a field never fires a shortcut.
  await page.locator("#message").fill("");
  await page.locator("#message").pressSequentially("jk/r?");
  await expect(page.locator("#message")).toHaveValue("jk/r?");
  await expect(page.locator("#message")).toBeFocused();
  await expect(page.locator("#keys-dialog")).not.toBeVisible();
  await page.locator("#message").fill("");
  await blur();

  // ? opens the help sheet; Escape closes it.
  await page.keyboard.press("?");
  await expect(page.locator("#keys-dialog")).toBeVisible();
  await expect(page.locator("#keys-list kbd")).toHaveCount(9);
  await page.screenshot({ path: testInfo.outputPath("keys-help.png") });
  await page.keyboard.press("Escape");
  await expect(page.locator("#keys-dialog")).not.toBeVisible();

  // k starts at the newest message; j and k move and stop at the ends.
  await blur();
  await page.keyboard.press("k");
  await expect(row(ids[2])).toBeFocused();
  await page.keyboard.press("k");
  await expect(row(ids[1])).toBeFocused();
  await page.keyboard.press("k");
  await page.keyboard.press("k");
  await expect(row(ids[0])).toBeFocused();
  await page.keyboard.press("j");
  await expect(row(ids[1])).toBeFocused();
  await expect(row(ids[1])).toHaveCSS("outline-style", "solid");

  // r replies to the selected message; Escape cancels the reply and keeps the draft.
  await page.keyboard.press("r");
  await expect(page.locator("#message")).toBeFocused();
  await expect(page.locator("#reply-note-text")).toHaveText(`Replying to #${ids[1]} · lead`);
  await page.locator("#message").pressSequentially("draft");
  await page.keyboard.press("Escape");
  await expect(page.locator("#reply-note")).toBeHidden();
  await expect(page.locator("#message")).toHaveValue("draft");
  await page.locator("#message").fill("");

  // The Reply button does the same, and the reply is sent with replyTo and shows in its thread.
  await row(ids[1])
    .getByRole("button", { name: `Reply to message #${ids[1]}` })
    .click();
  await expect(page.locator("#reply-note-text")).toHaveText(`Replying to #${ids[1]} · lead`);
  await page.screenshot({ path: testInfo.outputPath("keys-reply.png") });
  await page.locator("#message").fill("On it");
  await page.keyboard.press("Enter");
  await expect(page.locator("#reply-note")).toBeHidden();
  const reply = page.locator(`#thread-${ids[1]} article`).filter({ hasText: "On it" });
  await expect(reply).toBeVisible();
  const history = await (
    await request.get(`${t.path}/channels/work/messages`, { headers: t.headers })
  ).json();
  expect(history.messages.at(-1)).toMatchObject({ text: "On it", replyTo: ids[1], username: "human" });
  // j now walks into the open thread, in reading order.
  await blur();
  await page.keyboard.press("k");
  await expect(row(ids[2])).toBeFocused();
  await page.keyboard.press("k");
  await expect(reply).toBeFocused();

  // r with nothing selected says how to choose a message.
  await blur();
  await page.keyboard.press("r");
  await expect(page.locator("#status")).toHaveText(/Choose a message with j or k first/);
  await expect(page.locator("#reply-note")).toBeHidden();

  // / focuses search without typing a slash; Escape clears the search.
  await page.keyboard.press("/");
  await expect(page.locator("#search")).toBeFocused();
  await expect(page.locator("#search")).toHaveValue("");
  await page.keyboard.type("release");
  await page.keyboard.press("Enter");
  await expect(page.locator("#search-panel")).toBeVisible();
  // With a reply pending, Escape in the search field clears the search first; the next one
  // cancels the reply.
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press("k");
  await page.keyboard.press("r");
  await expect(page.locator("#reply-note")).toBeVisible();
  await page.locator("#search").focus();
  await page.keyboard.press("Escape");
  await expect(page.locator("#search-panel")).toBeHidden();
  await expect(page.locator("#search")).toHaveValue("");
  await expect(page.locator("#reply-note")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#reply-note")).toBeHidden();

  // A reply survives switching boards, and the chip still names the author.
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press("k");
  await page.keyboard.press("r");
  await openChannel(page, "notes");
  await openChannel(page, "work");
  await expect(page.locator("#reply-note-text")).toHaveText(/^Replying to #\d+ · (lead|human)$/);
  await page.locator("#reply-cancel").click();
  await expect(page.locator("#reply-note")).toBeHidden();

  // g then b goes to the board list and focuses the open board.
  await blur();
  await page.keyboard.press("g");
  await page.keyboard.press("b");
  await expect(page.getByRole("button", { name: "# work", exact: true })).toBeFocused();
  await expect(page.locator("#channels")).toBeVisible();
  // A lone b, or g then another key, does nothing.
  await page.keyboard.press("ArrowDown");
  await blur();
  await page.keyboard.press("b");
  await expect(page.locator("body")).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("on an archived board j and k still move but r never starts a reply", async ({ page, request }) => {
  const t = await provision(request, { username: "human" });
  const credential = crypto.randomUUID().replaceAll("-", "").repeat(2);
  await request.put(`${t.path}/channels/work/board`, {
    headers: t.headers,
    data: { credential, goal: "Ship" },
  });
  const sent = await request.post(`${t.path}/channels/work/messages`, {
    headers: t.headers,
    data: { username: "human", text: "Read me" },
  });
  const id = (await sent.json()).message.id;
  await connect(page, t, "human");
  await openChannel(page, "work");
  await page.locator("#board-settings").click();
  await page.getByRole("button", { name: "Archive board" }).click();
  await expect(page.locator("#archived-note")).toBeVisible();
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press("k");
  await expect(page.locator(`#messages article[data-id="${id}"]`)).toBeFocused();
  await expect(page.locator(`#messages article[data-id="${id}"] .reply-button`)).toBeHidden();
  await page.keyboard.press("r");
  await expect(page.locator("#reply-note")).toBeHidden();
  await expect(page.locator("#message")).not.toBeFocused();
  // Nor does Quote (ADR 0059).
  await expect(page.locator(`#messages article[data-id="${id}"] .quote-button`)).toBeHidden();
  await page.keyboard.press("q");
  await expect(page.locator("#reply-note")).toBeHidden();
  await expect(page.locator("#quote-note")).toBeHidden();
});

test("quote the selected part, or all, of a message in a reply; the reply shows it and links back (ADR 0059)", async ({
  page,
  request,
}, testInfo) => {
  const t = await provision(request);
  const sent = await request.post(`${t.path}/channels/work/messages`, {
    headers: t.headers,
    data: { username: "lead", text: "Ship the Worker today.\n\nThen tag the **CLI**." },
  });
  const root = (await sent.json()).message.id;
  await connect(page, t, "human");
  await openChannel(page, "work");
  const row = (id) => page.locator(`#messages article[data-id="${id}"]`);
  await expect(row(root)).toBeVisible();
  // Select the second paragraph as rendered, then press Quote on that message.
  // Select `text` as rendered inside one message's body, across inline elements.
  const select = (id, text) =>
    page.evaluate(
      ([id, text]) => {
        const body = document.querySelector(`#messages article[data-id="${id}"] > .message-body`);
        const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
        const nodes = [];
        let all = "";
        while (walker.nextNode()) {
          nodes.push([walker.currentNode, all.length]);
          all += walker.currentNode.data;
        }
        const from = all.indexOf(text);
        const to = from + text.length;
        const at = (offset) => {
          const [node, base] = nodes.findLast(([, base]) => base <= offset);
          return [node, offset - base];
        };
        const range = document.createRange();
        range.setStart(...at(from));
        range.setEnd(...at(to));
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      },
      [id, text],
    );
  await select(root, "Then tag the CLI.");
  await row(root)
    .getByRole("button", { name: `Quote message #${root} in a reply` })
    .click();
  await expect(page.locator("#reply-note-text")).toHaveText(`Replying to #${root} · lead`);
  await expect(page.locator("#quote-note")).toBeVisible();
  await expect(page.locator("#quote-note-text")).toHaveText("Then tag the CLI.");
  await expect(page.locator("#message")).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath("quote-compose.png") });
  await page.locator("#message").fill("Tagging v0.2 now");
  await page.keyboard.press("Enter");
  await expect(page.locator("#reply-note")).toBeHidden();
  await expect(page.locator("#quote-note")).toBeHidden();
  let history = (await (await request.get(`${t.path}/channels/work/messages`, { headers: t.headers })).json())
    .messages;
  expect(history.at(-1)).toMatchObject({
    text: "Tagging v0.2 now",
    replyTo: root,
    quote: "Then tag the CLI.",
    username: "human",
  });
  const reply = page.locator(`#thread-${root} article`).filter({ hasText: "Tagging v0.2 now" });
  await expect(reply.locator(".message-quote")).toHaveText("Then tag the CLI.");
  await page.screenshot({ path: testInfo.outputPath("quote-reply.png") });
  // The quote links back: pressing it shows and highlights the source message.
  await reply.locator(".quote-source").click();
  await expect(row(root)).toHaveClass(/flash/);

  // With nothing selected, Quote takes the whole message; removing the quote keeps the reply.
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await row(root)
    .getByRole("button", { name: `Quote message #${root} in a reply` })
    .click();
  await expect(page.locator("#quote-note-text")).toHaveText("Ship the Worker today. Then tag the **CLI**.");
  await page.locator("#quote-remove").click();
  await expect(page.locator("#quote-note")).toBeHidden();
  await expect(page.locator("#reply-note")).toBeVisible();

  // A quote is part of the kept draft: it comes back after a reload.
  await select(root, "Ship the Worker today.");
  await row(root)
    .getByRole("button", { name: `Quote message #${root} in a reply` })
    .click();
  await expect(page.locator("#quote-note-text")).toHaveText("Ship the Worker today.");
  await page.waitForTimeout(600);
  await page.reload();
  await expect(page.locator("#channel-title")).toHaveText("# work");
  await openChannel(page, "work");
  await expect(page.locator("#quote-note-text")).toHaveText("Ship the Worker today.");
  // Replying to another message drops the quote, which belonged to the first one.
  await row(root).locator(".thread-toggle").click();
  await reply.getByRole("button", { name: /^Reply to message/ }).click();
  await expect(page.locator("#quote-note")).toBeHidden();
  await page.locator("#reply-cancel").click();

  // q quotes the text selected in a message, without choosing the message first.
  await page.evaluate(() => document.activeElement?.blur());
  await select(root, "Then tag the CLI.");
  await page.keyboard.press("q");
  await expect(page.locator("#reply-note-text")).toHaveText(`Replying to #${root} · lead`);
  await expect(page.locator("#quote-note-text")).toHaveText("Then tag the CLI.");
  await page.keyboard.press("Escape");
  await expect(page.locator("#reply-note")).toBeHidden();
  await expect(page.locator("#quote-note")).toBeHidden();

  // A quote from another client is plain text, never markup.
  const hostile = await request.post(`${t.path}/channels/work/messages`, {
    headers: t.headers,
    data: {
      username: "lead",
      text: "see above",
      replyTo: root,
      quote: '<img src=x onerror="window.pwned=1">',
    },
  });
  expect(hostile.status()).toBe(201);
  const hostileId = (await hostile.json()).message.id;
  await expect(page.locator(`article[data-id="${hostileId}"] .message-quote`)).toHaveText(
    '<img src=x onerror="window.pwned=1">',
  );
  expect(await page.locator(`article[data-id="${hostileId}"] .message-quote img`).count()).toBe(0);
  expect(await page.evaluate(() => window.pwned)).toBeUndefined();
  history = (await (await request.get(`${t.path}/channels/work/messages`, { headers: t.headers })).json())
    .messages;
  expect(history.length).toBe(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("typing @ suggests the board's people; a pick writes @name and fills an empty To (ADR 0055)", async ({
  page,
  request,
}, testInfo) => {
  const t = await provision(request, { username: "human" });
  const credential = "e".repeat(64);
  const board = { Authorization: `Bearer ${credential}` };
  expect(
    (
      await request.put(`${t.path}/channels/work/board`, {
        headers: t.headers,
        data: { credential, goal: "Ship" },
      })
    ).status(),
  ).toBe(201);
  for (const [id, displayName] of [
    ["p1", "lead"],
    ["p2", "reviewer"],
    ["p3", "builder"],
  ])
    await request.put(`${t.path}/channels/work/personas/${id}`, { headers: board, data: { displayName } });
  // Reviewer has not posted yet: it comes after the people who have.
  for (const [personaId, username] of [
    ["p3", "builder"],
    ["p1", "lead"],
  ])
    expect(
      (
        await request.post(`${t.path}/channels/work/messages`, {
          headers: board,
          data: { username, personaId, text: `${username} checking in` },
        })
      ).status(),
    ).toBe(201);
  await connect(page, t, "human");
  await openChannel(page, "work");
  await expect(page.locator("#messages .message")).toHaveCount(2);
  const box = page.locator("#message");
  const list = page.getByRole("listbox", { name: "People to mention" });
  const to = page.getByLabel("To", { exact: true });

  // A reply in progress, so Escape on the list can be shown to leave it alone.
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press("k");
  await page.keyboard.press("r");
  await expect(page.locator("#reply-note")).toBeVisible();

  // A bare @ lists everyone but me: recent senders newest first, then the other personas.
  await box.pressSequentially("Please @");
  await expect(list).toBeVisible();
  await expect(list.getByRole("option")).toHaveText(["@lead", "@builder", "@reviewer"]);
  await expect(box).toHaveAttribute("aria-expanded", "true");
  await page.screenshot({ path: testInfo.outputPath("mention-list.png") });

  // Typing narrows the list; arrows move; Enter picks instead of sending.
  await box.pressSequentially("r");
  await expect(list.getByRole("option")).toHaveText(["@reviewer", "@builder"]);
  await page.keyboard.press("ArrowDown");
  await expect(list.getByRole("option", { name: "@builder" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await expect(box).toHaveValue("Please @reviewer ");
  await expect(to).toHaveValue("reviewer");
  await expect(list).toBeHidden();
  await expect(page.locator("#status")).toContainText("the message goes to reviewer");

  // A second mention only adds @name: the first pick stays the recipient.
  await box.pressSequentially("and @bu");
  await list.getByRole("option", { name: "@builder" }).click();
  await expect(box).toHaveValue("Please @reviewer and @builder ");
  await expect(box).toBeFocused();
  await expect(to).toHaveValue("reviewer");

  // Escape closes only the list (the reply stays), and typing on does not reopen it.
  await box.pressSequentially("@l");
  await expect(list).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(list).toBeHidden();
  await expect(page.locator("#reply-note")).toBeVisible();
  await box.pressSequentially("e");
  await expect(list).toBeHidden();
  // A space closes it too; shortcuts never fire while typing.
  await box.pressSequentially(" @re");
  await expect(list).toBeVisible();
  await box.pressSequentially(" jk");
  await expect(list).toBeHidden();
  await expect(box).toBeFocused();
  await expect(box).toHaveValue("Please @reviewer and @builder @le @re jk");
  await page.screenshot({ path: testInfo.outputPath("mention-picked.png") });

  await page.keyboard.press("Enter");
  await expect(box).toHaveValue("");
  await expect(to).toHaveValue("");
  const result = await request.get(`${t.path}/channels/work/messages`, { headers: t.headers });
  const sent = (await result.json()).messages.at(-1);
  expect(sent).toMatchObject({
    username: "human",
    to: "reviewer",
    text: "Please @reviewer and @builder @le @re jk",
  });
  expect(sent.replyTo).toBeGreaterThan(0);

  // Deleting the picked @name clears the To it filled; a To typed by hand is never cleared.
  await box.pressSequentially("@lea");
  await page.keyboard.press("Tab");
  await expect(to).toHaveValue("lead");
  await box.fill("");
  await box.dispatchEvent("input");
  await expect(to).toHaveValue("");
  await to.fill("ops");
  await box.pressSequentially("@lead");
  await page.keyboard.press("Enter");
  await expect(to).toHaveValue("ops");
  await box.fill("");
  await box.dispatchEvent("input");
  await expect(to).toHaveValue("ops");
  await to.fill("");

  // A list closed with Escape and then sent does not stay closed for the next message's @.
  await box.pressSequentially("@b");
  await expect(list).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(list).toBeHidden();
  await page.keyboard.press("Enter");
  await expect(box).toHaveValue("");
  await box.pressSequentially("@b");
  await expect(list).toBeVisible();

  // An input method still composing owns Enter: it neither picks nor sends.
  await box.evaluate((node) =>
    node.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true }),
    ),
  );
  await expect(box).toHaveValue("@b");
  await expect(list).toBeVisible();
});

test("a failed persona load is not retried on every key after @ (ADR 0055)", async ({ page, request }) => {
  const t = await provision(request, { username: "human" });
  expect(
    (
      await request.put(`${t.path}/channels/work/board`, {
        headers: t.headers,
        data: { credential: "f".repeat(64), goal: "Ship" },
      })
    ).status(),
  ).toBe(201);
  let asked = 0;
  await page.route("**/channels/work/personas", (route) => {
    asked += 1;
    return route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"down"}' });
  });
  await connect(page, t, "human");
  await openChannel(page, "work");
  await page.locator("#message").pressSequentially("@abc");
  await expect.poll(() => asked).toBe(1);
  await page.locator("#message").pressSequentially("def");
  await page.waitForTimeout(300);
  expect(asked).toBe(1);
  await expect(page.locator("#status")).not.toHaveClass(/error/);
});

test("the Invite dialog's curl commands join, read and send with plain curl", async ({ page, request }) => {
  const t = await provision(request, { username: "human" });
  const credential = crypto.randomUUID().replaceAll("-", "").repeat(2);
  expect(
    (
      await request.put(`${t.path}/channels/work/board`, {
        headers: t.headers,
        data: { credential, goal: "Ship the curl quickstart" },
      })
    ).status(),
  ).toBe(201);
  // Record copies instead of touching the real clipboard.
  await page.addInitScript(() => {
    window.copied = [];
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async (text) => window.copied.push(text) },
    });
  });
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
  await openChannel(page, "work");
  await page.locator("#invite-channel").click();
  await expect(page.locator("#invite-title")).toHaveText("Shared access to # work");
  await page.locator("#copy-curl").click();
  await expect.poll(() => page.evaluate(() => window.copied.length)).toBe(1);
  const script = await page.evaluate(() => window.copied[0]);
  // The copied text never holds the key; the agent sets it from the board link.
  expect(script).not.toContain(credential);
  const link = await page.locator("#invite-link").inputValue();
  const key = new URLSearchParams(new URL(link).hash.slice(1)).get("key");
  // Run the copied commands as an agent would, with only bash and curl; N becomes the start.
  const run = (text, env = {}) =>
    promisify(execFile)(
      "bash",
      ["-euc", text.replace("after=N&wait=25", "after=0&wait=1").replace("&after=N", "&after=0")],
      {
        env: { ...process.env, ...env },
      },
    );
  const { stdout } = await run(script, { MSN_KEY: key });
  expect(stdout).toContain('"displayName":"my-agent"');
  expect(stdout).toContain('"reader":"my-agent","name":"my-agent"');
  expect(stdout).toContain("Ship the curl quickstart");
  expect(stdout).toContain('"username":"my-agent","text":"hello"');
  expect(stdout).toContain('"name":"my-agent","text":"reading the board"');
  await expect(page.locator("#messages")).toContainText("hello");
  // A workspace invitation's script redeems a key of its own and runs as a whole; a watch-only
  // one cannot send, so it has none.
  await page.locator("#close-invite").click();
  await channelsPane(page);
  await page.locator("#invite-workspace").click();
  await page.locator("#invite-form").getByRole("button", { name: "Create invitation" }).click();
  await page.locator("#copy-curl").click();
  await expect.poll(() => page.evaluate(() => window.copied.length)).toBe(2);
  const invite = await page.evaluate(() => window.copied[1]);
  expect(invite).toContain("/invites/redeem");
  const joined = await run(
    invite
      .replace("MSN_BOARD='general'", "MSN_BOARD='work'")
      .replace("MSN_NAME='my-agent'", "MSN_NAME='invited'"),
  );
  expect(joined.stdout).toContain('"username":"invited","text":"hello"');
  expect(joined.stdout).toContain('"name":"invited","text":"reading the board"');
  expect(joined.stdout).not.toMatch(/"token"/);
  await page.locator("#close-invite").click();
  await page.locator("#invite-workspace").click();
  await page.locator("#invite-watch").check();
  await page.locator("#invite-form").getByRole("button", { name: "Create invitation" }).click();
  await expect(page.locator("#invite-link")).not.toHaveValue("");
  await expect(page.locator("#copy-curl")).toBeHidden();
});

test("a message scheduled from the composer waits, can be changed and cancelled, and posts on time (ADR 0060)", async ({
  page,
  request,
}, testInfo) => {
  const t = await provision(request);
  await request.put(`${t.path}/channels/general`, { headers: t.headers });
  await connect(page, t);
  await openChannel(page, "general");
  // Nothing to schedule yet: the button asks for the message first.
  await page.getByRole("button", { name: "Send later" }).click();
  await expect(page.locator("#status")).toContainText("Write the message first");
  await expect(page.locator("#schedule-dialog")).not.toBeVisible();
  await page.getByLabel("Message", { exact: true }).fill("Standup notes are due");
  await page.getByRole("button", { name: "Send later" }).click();
  const dialog = page.locator("#schedule-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Tomorrow, 9:00" }).click();
  const tomorrow = await page.evaluate(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T09:00`;
  });
  await expect(dialog.getByLabel("Post at")).toHaveValue(tomorrow);
  if (testInfo.project.name === "mobile") {
    const small = await dialog.locator("button, input, textarea").evaluateAll((els) =>
      els
        .filter((el) => el.getBoundingClientRect().height > 0)
        .filter((el) => el.getBoundingClientRect().height < 43.5)
        .map((el) => el.id || el.textContent),
    );
    expect(small).toEqual([]);
  }
  await page.screenshot({ path: testInfo.outputPath("schedule-dialog.png") });
  await dialog.getByRole("button", { name: "Schedule" }).click();
  await expect(page.locator("#status")).toContainText("Scheduled for tomorrow 09:00");
  // The composer is free again and nothing posted.
  await expect(page.locator("#message")).toHaveValue("");
  await expect(page.locator("#messages .message")).toHaveCount(0);
  const bar = page.locator("#scheduled-open");
  await expect(bar).toHaveText("1 scheduled · show");
  const stored = await (
    await request.get(`${t.path}/channels/general/scheduled`, { headers: t.headers })
  ).json();
  expect(stored.scheduled).toHaveLength(1);
  expect(stored.scheduled[0]).toMatchObject({ text: "Standup notes are due", username: "Tomas" });
  expect(new Date(stored.scheduled[0].sendAt).getTime()).toBe(
    await page.evaluate((value) => new Date(value).getTime(), tomorrow),
  );
  // Change its text from the list.
  await bar.click();
  const list = page.locator("#scheduled-dialog");
  await expect(list.locator("li")).toHaveCount(1);
  await expect(list).toContainText("Posts tomorrow 09:00 · Tomas");
  await page.screenshot({ path: testInfo.outputPath("scheduled-list.png") });
  await list.getByRole("button", { name: "Change" }).click();
  await expect(dialog.getByLabel("Text", { exact: true })).toHaveValue("Standup notes are due");
  await dialog.getByLabel("Text", { exact: true }).fill("Standup notes are due at 10");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(list.locator(".scheduled-text")).toHaveText("Standup notes are due at 10");
  // Cancel it.
  await list.getByRole("button", { name: "Cancel message" }).click();
  await expect(list).toContainText("Nothing scheduled on this board.");
  await list.getByRole("button", { name: "Close" }).click();
  await expect(page.locator("#scheduled-bar")).toBeHidden();
  // One scheduled a few seconds ahead posts as a normal message, without a reload.
  const soon = await request.post(`${t.path}/channels/general/messages`, {
    headers: t.headers,
    data: {
      username: "Tomas",
      text: "Posted by the alarm",
      sendAt: new Date(Date.now() + 2500).toISOString(),
    },
  });
  expect(soon.status()).toBe(201);
  await expect(page.locator("#messages .message")).toHaveCount(1, { timeout: 15000 });
  await expect(page.locator("#messages .message")).toContainText("Posted by the alarm");
  await expect
    .poll(
      async () =>
        (await (await request.get(`${t.path}/channels/general/scheduled`, { headers: t.headers })).json())
          .scheduled,
    )
    .toEqual([]);
});

test("files cannot be scheduled, and a failed scheduled message says why (ADR 0060)", async ({
  page,
  request,
}) => {
  const t = await provision(request);
  await request.put(`${t.path}/channels/general`, { headers: t.headers });
  const scheduled = await request.post(`${t.path}/channels/general/messages`, {
    headers: t.headers,
    data: { username: "Tomas", text: "after archive", sendAt: new Date(Date.now() + 1500).toISOString() },
  });
  expect(scheduled.status()).toBe(201);
  expect((await request.put(`${t.path}/channels/general/archive`, { headers: t.headers })).status()).toBe(
    200,
  );
  await expect
    .poll(
      async () =>
        (await (await request.get(`${t.path}/channels/general/scheduled`, { headers: t.headers })).json())
          .scheduled[0]?.status,
      { timeout: 15000 },
    )
    .toBe("failed");
  await connect(page, t);
  await channelsPane(page);
  await page.getByText("Show archived").click();
  await page.getByRole("button", { name: "# general · archived" }).click();
  await expect(page.locator("#channel-title")).toHaveText("# general");
  await expect(page.locator("#scheduled-open")).toHaveText("1 failed to post · show");
  await page.locator("#scheduled-open").click();
  await expect(page.locator("#scheduled-list")).toContainText("Not posted:");
  await expect(page.locator("#scheduled-list")).toContainText("archived");
  // On an archived board it can only be cancelled.
  await expect(page.locator("#scheduled-list").getByRole("button", { name: "Pick a new time" })).toHaveCount(
    0,
  );
  await page.locator("#scheduled-list").getByRole("button", { name: "Cancel message" }).click();
  await expect(page.locator("#scheduled-list")).toContainText("Nothing scheduled");
  await page.locator("#close-scheduled").click();
  // Unarchive and try to schedule a file.
  expect((await request.delete(`${t.path}/channels/general/archive`, { headers: t.headers })).status()).toBe(
    200,
  );
  await page.reload();
  await expect(page.locator("#channel-title")).toHaveText("# general");
  await page
    .locator("#attach-input")
    .setInputFiles({ name: "a.txt", mimeType: "text/plain", buffer: Buffer.from("hi") });
  await page.getByLabel("Message", { exact: true }).fill("with a file");
  await page.getByRole("button", { name: "Send later" }).click();
  await expect(page.locator("#status")).toContainText("cannot carry files");
  await expect(page.locator("#schedule-dialog")).not.toBeVisible();
});

test("the addressed person answers a question with one tap; the buttons then lock for everyone (ADR 0065)", async ({
  page,
  request,
}, testInfo) => {
  const t = await provision(request);
  const ask = async (data) =>
    (
      await (
        await request.post(`${t.path}/channels/work/messages`, {
          headers: t.headers,
          data: { username: "lead", ...data },
        })
      ).json()
    ).message.id;
  const mine = await ask({ text: "Ship v0.2 now?", to: "human", choices: ["yes", "no <b>wait</b>"] });
  const theirs = await ask({ text: "Merge #66?", to: "reviewer", choices: ["merge", "hold"] });
  const later = await ask({ text: "Tag the CLI?", to: "human", choices: ["tag", "skip"] });
  await connect(page, t, "human");
  await openChannel(page, "work");
  const choices = (id) => page.locator(`#messages article[data-id="${id}"] > .message-choices`);
  // Choice text is untrusted and shows as text, never markup.
  const no = choices(mine).getByRole("button", { name: "no <b>wait</b>" });
  await expect(no).toBeEnabled();
  await expect(choices(mine).locator("b")).toHaveCount(0);
  await expect(choices(mine)).toContainText("Your answer");
  // A question to someone else shows its choices locked, and who is asked.
  await expect(choices(theirs).getByRole("button", { name: "merge" })).toBeDisabled();
  await expect(choices(theirs)).toContainText("Waiting for reviewer");
  await page.screenshot({ path: testInfo.outputPath(`ask-open-${testInfo.project.name}.png`) });

  await no.click();
  await expect(no).toHaveAttribute("aria-pressed", "true");
  await expect(no).toBeDisabled();
  await expect(choices(mine).getByRole("button", { name: "yes" })).toBeDisabled();
  await expect(choices(mine)).toContainText("human answered no <b>wait</b>");
  const history = await (
    await request.get(`${t.path}/channels/work/messages?after=0`, { headers: t.headers })
  ).json();
  const reply = history.messages.find((m) => m.replyTo === mine);
  expect(reply).toMatchObject({ username: "human", text: "no <b>wait</b>", answer: "no <b>wait</b>" });
  expect(history.messages.find((m) => m.id === mine).answered).toMatchObject({
    id: reply.id,
    username: "human",
  });

  // An answer from another device locks the buttons here as it arrives.
  expect(
    (
      await request.post(`${t.path}/channels/work/messages`, {
        headers: t.headers,
        data: { username: "human", replyTo: later, answer: "skip" },
      })
    ).status(),
  ).toBe(201);
  await expect(choices(later).getByRole("button", { name: "skip" })).toHaveAttribute("aria-pressed", "true");
  await expect(choices(later).getByRole("button", { name: "tag" })).toBeDisabled();
  // After a reload the server's record keeps them locked.
  await page.reload();
  await expect(page.locator("#channel-title")).toBeVisible();
  await openChannel(page, "work");
  await expect(choices(mine).getByRole("button", { name: "no <b>wait</b>" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(choices(mine).getByRole("button", { name: "yes" })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath(`ask-answered-${testInfo.project.name}.png`) });
});
