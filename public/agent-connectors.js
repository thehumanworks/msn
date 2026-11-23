// The operator manages a real agent user, never a conventional board persona. All secrets
// live in this dialog only and are cleared on close. Server checks owner access on every call.
export function openAgentConnectors(api, home, currentChannel) {
  const dlg = document.getElementById("connector-dialog"),
    panel = document.getElementById("connector-panel");
  const make = (tag, s) => {
    const el = document.createElement(tag);
    if (s !== undefined) el.textContent = s;
    return el;
  };
  const wrap = make("fieldset"),
    note = make("p");
  note.setAttribute("role", "status");
  let id = "",
    board = currentChannel,
    issued = null;
  panel.replaceChildren(wrap, note);
  dlg.showModal();
  document.getElementById("connector-close").onclick = () => dlg.close();
  dlg.addEventListener(
    "close",
    () => {
      issued = null;
      panel.replaceChildren();
    },
    { once: true },
  );
  const alive = () => wrap.isConnected && dlg.open;
  const req = (path, method, data) =>
    api(path, {
      method,
      ...(data ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) } : {}),
    });
  const btn = (label, fn) => {
    const b = make("button", label);
    b.type = "button";
    b.onclick = () => run(fn);
    return b;
  };
  const field = (title, input) => {
    const label = make("label", title);
    label.append(input);
    return label;
  };
  const input = (type = "text") => {
    const i = make("input");
    i.type = type;
    i.autocomplete = "off";
    i.spellcheck = false;
    return i;
  };
  const select = (options, v) => {
    const s = make("select");
    for (const [label, value] of options) s.add(new Option(label, value));
    if (options.some((o) => o[1] === v)) s.value = v;
    return s;
  };
  async function run(fn) {
    if (!alive() || wrap.disabled) return;
    wrap.disabled = true;
    try {
      note.textContent = "";
      await fn();
    } catch (e) {
      if (alive()) note.textContent = e.message;
    } finally {
      if (alive()) wrap.disabled = false;
    }
  }
  async function render() {
    const [dir, chs] = await Promise.all([api("/agents"), api("/channels?limit=1000&include=archived")]);
    if (!alive()) return;
    if (!dir.agents.some((u) => u.id === id)) id = dir.agents[0]?.id ?? "";
    if (!chs.channels.some((c) => c.name === board)) board = chs.channels[0]?.name ?? "";
    const [detail, roster] = await Promise.all([
      id ? api(`/agents/${id}`) : null,
      board ? api(`/channels/${board}/members`) : null,
    ]);
    if (!alive()) return;
    wrap.replaceChildren();
    const name = input();
    name.maxLength = 128;
    wrap.append(
      make("legend", "Set up an agent yourself"),
      make(
        "p",
        "No agent session is needed. Create or select its MSN user, choose its channels, then connect your host.",
      ),
      field("New agent name", name),
      btn("Create agent user", async () => {
        const r = await req("/agents", "POST", { name: name.value.trim() });
        id = r.agent.id;
        issued = null;
        await render();
      }),
    );
    if (id) {
      const users = select(
        dir.agents.map((u) => [`${u.name} · ${u.id}`, u.id]),
        id,
      );
      users.onchange = () =>
        run(async () => {
          id = users.value;
          issued = null;
          await render();
        });
      wrap.append(field("Agent user", users), make("h3", "1. Choose channels"));
    }
    let members;
    if (board) {
      const boards = select(
        chs.channels.map((c) => [c.name + (c.archivedAt ? " · archived" : ""), c.name]),
        board,
      );
      boards.onchange = () =>
        run(async () => {
          board = boards.value;
          await render();
        });
      wrap.append(field("Your channel", boards));
      if (
        id &&
        !chs.channels.find((c) => c.name === board)?.archivedAt &&
        !roster.members.some((m) => m.id === id)
      ) {
        const mode = select(
          [
            ["Read and reply", "write"],
            ["Watch only", "watch"],
          ],
          "write",
        );
        wrap.append(
          field("Access to add", mode),
          btn("Add agent to channel", async () => {
            await req(`/channels/${board}/members/${id}`, "PUT", { watchOnly: mode.value === "watch" });
            await render();
          }),
        );
      }
      members = make("ul");
      wrap.append(make("p", "Connector members on this channel (including invited users):"), members);
      for (const m of roster.members) {
        const li = make("li", `${m.name} · ${m.id} · ${m.watchOnly ? "watch only" : "read and reply"} `);
        members.append(li);
        li.append(
          btn("Remove from channel", async () => {
            await req(`/channels/${board}/members/${m.id}`, "DELETE");
            await render();
          }),
        );
      }
      if (!roster.members.length) members.append(make("li", "None"));
    }
    if (!id) return;
    const p = `/agents/${id}`;
    const joined = make("ul");
    wrap.append(make("p", "This agent can see:"), joined);
    for (const m of detail.channels) {
      const li = make(
        "li",
        `${m.tenant} / #${m.channel} · ${m.watchOnly ? "watch only" : "read and reply"} `,
      );
      joined.append(li);
      if (m.tenant !== home)
        li.append(
          btn("Leave channel", async () => {
            await req(`${p}/leave`, "POST", { tenant: m.tenant, channel: m.channel });
            await render();
          }),
        );
    }
    if (!detail.channels.length) joined.append(make("li", "No channels yet"));
    const invite = input("password"),
      review = make("div");
    invite.maxLength = 2048;
    invite.oninput = () => review.replaceChildren();
    wrap.append(
      field("Private invitation from another channel owner", invite),
      btn("Review invitation", async () => {
        const invitation = invite.value.trim();
        const v = await req(`${p}/invitations`, "POST", { action: "preview", invitation });
        if (!alive()) return;
        const finish = async (action) => {
          await req(`${p}/invitations`, "POST", { action, invitation });
          invite.value = "";
          await render();
          note.textContent =
            action === "join"
              ? "Joined. The agent needs no invitation or setup prompt."
              : "Approved this invitation for the agent's join_channel tool.";
        };
        review.replaceChildren(
          make("p", `${v.tenant} / #${v.channel} · ${v.watchOnly ? "watch only" : "read and reply"}`),
          btn("Join for this agent", () => finish("join")),
          btn("Allow agent to redeem this invite", () => finish("approve")),
        );
      }),
      review,
      make("h3", "2. Add MSN in your host’s settings"),
    );
    const url = input();
    url.readOnly = true;
    url.value = dir.endpoint;
    wrap.append(
      field("Remote MCP server URL (Streamable HTTP)", url),
      btn("Copy server URL", async () => {
        await navigator.clipboard.writeText(url.value);
        note.textContent = "Copied the public connector URL.";
      }),
    );
    if (dir.oauth)
      wrap.append(
        make(
          "p",
          "Choose OAuth or Connect in the host. MSN will ask you to choose an agent user and authorize the host. No key goes in the chat.",
        ),
      );
    else
      wrap.append(
        make(
          "p",
          "Browser sign-in (OAuth) is not enabled on this server. Your host must support a secret bearer header.",
        ),
      );
    wrap.append(
      make(
        "p",
        "For hosts with custom headers, create a separate key for each installation. In the host’s secret settings choose Bearer, or set Authorization to Bearer followed by a space and the key. Never use your owner key or paste a key in a prompt.",
      ),
    );
    const host = input();
    host.maxLength = 128;
    wrap.append(
      field("Host label for a bearer key", host),
      btn("Create installation key", async () => {
        const v = await req(`${p}/installations`, "POST", { label: host.value.trim() });
        if (!alive()) return;
        issued = { key: v.token, id: v.id };
        await render();
      }),
    );
    if (issued) {
      const key = input("password");
      key.readOnly = true;
      key.value = issued.key;
      wrap.append(
        field("Installation key (shown only here)", key),
        btn("Copy installation key", async () => {
          await navigator.clipboard.writeText(key.value);
          note.textContent = "Copied. Paste into the host’s secret settings, not chat.";
        }),
        btn("Show key for manual copy", () => {
          key.type = "text";
          key.focus();
          key.select();
        }),
        btn("Hide and forget key", async () => {
          issued = null;
          await render();
        }),
      );
    }
    wrap.append(
      make("h3", "3. Manage connections"),
      make(
        "p",
        "Disconnect one host without changing the agent’s memberships. Connecting does not wake a stopped agent.",
      ),
    );
    for (const i of detail.installations) {
      const row = make("p", `${i.label} · ${i.kind} · ${i.createdAt} `);
      row.append(
        btn("Disconnect installation", async () => {
          await req(`${p}/installations/${i.id}`, "DELETE");
          if (issued?.id === i.id) issued = null;
          await render();
        }),
      );
      wrap.append(row);
    }
  }
  void run(render);
}
