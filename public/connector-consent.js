// Owner credentials never leave this origin. The registered client receives only a code.
const el = (id) => document.getElementById(id);
let selectedFile = null,
  session = null,
  readyId = null,
  revision = 0,
  submitting = false;
function clear() {
  readyId = null;
  el("approve").disabled = true;
  el("channels").replaceChildren();
}
async function get(c, path) {
  const res = await fetch(`/api/tenants/${c.tenant}/agents${path}`, {
    headers: { Authorization: `Bearer ${c.token}` },
    redirect: "error",
    cache: "no-store",
  });
  if (!res.ok) throw new Error("Sign in as the workspace owner, then reload choices.");
  return res.json();
}
async function select() {
  const turn = ++revision,
    c = session,
    id = el("user").value;
  clear();
  if (!c || !id || submitting) return;
  try {
    const { channels } = await get(c, `/${encodeURIComponent(id)}`);
    if (turn !== revision) return;
    for (const m of channels) {
      const li = document.createElement("li");
      li.textContent = `${m.tenant} / #${m.channel} · ${m.watchOnly ? "watch only" : "read and reply"}`;
      el("channels").append(li);
    }
    if (!channels.length) el("channels").textContent = "No channels yet.";
    readyId = id;
    el("approve").disabled = false;
    el("status").textContent = "Check the host, agent user, and channels before you authorize.";
  } catch (e) {
    if (turn === revision) el("status").textContent = e.message;
  }
}
async function load() {
  if (submitting) return;
  const turn = ++revision;
  clear();
  session = null;
  el("user").replaceChildren();
  el("account").textContent = "";
  try {
    const c = selectedFile ?? JSON.parse(localStorage.getItem("msn.session"));
    if (!c?.token || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(c.tenant))
      throw new Error("Sign in to MSN in the other tab or open an owner connection file.");
    const { agents } = await get(c, "");
    if (turn !== revision) return;
    if (agents.length > 1) el("user").add(new Option("Choose an agent user", ""));
    for (const u of agents) el("user").add(new Option(`${u.name} · ${u.id}`, u.id));
    el("account").textContent = `Workspace: ${c.tenant}`;
    session = c;
    if (agents.length === 1) await select();
    else if (agents.length > 1) el("status").textContent = "Select the agent this host should act as.";
    else el("status").textContent = "Create an agent user in MSN → Agent connectors, then reload choices.";
  } catch (e) {
    if (turn === revision) el("status").textContent = e.message;
  }
}
async function submit(action) {
  if (submitting || (action === "approve" && (!readyId || readyId !== el("user").value || !session))) return;
  submitting = true;
  ++revision;
  for (const id of ["approve", "deny", "reload", "file", "user"]) el(id).disabled = true;
  try {
    const r = await fetch("/oauth/authorize", {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        ...(action === "approve" ? { Authorization: `Bearer ${session.token}` } : {}),
      },
      body: JSON.stringify({
        action,
        handle: el("consent").dataset.handle,
        ...(action === "approve" ? { tenant: session.tenant, agent: readyId } : {}),
      }),
    });
    if (!r.ok) throw new Error("Sign-in did not complete. Restart from the host’s connector settings.");
    const { redirectTo } = await r.json();
    location.assign(redirectTo);
  } catch (e) {
    el("status").textContent = e.message;
  }
}
el("file").onchange = async () => {
  const f = el("file").files?.[0];
  if (!f || submitting) return;
  const turn = ++revision;
  selectedFile = null;
  session = null;
  clear();
  el("user").replaceChildren();
  el("account").textContent = "";
  try {
    if (f.size > 32768) throw new Error("Use a small MSN owner connection file.");
    const c = JSON.parse(await f.text());
    if (turn !== revision) return;
    if (!c.url || new URL(c.url).origin !== location.origin)
      throw new Error("Choose a connection file for this MSN server.");
    selectedFile = c;
    await load();
  } catch (e) {
    if (turn === revision) el("status").textContent = e.message;
  }
  el("file").value = "";
};
el("reload").onclick = load;
el("user").onchange = select;
el("approve").onclick = () => submit("approve");
el("deny").onclick = () => submit("deny");
void load();
