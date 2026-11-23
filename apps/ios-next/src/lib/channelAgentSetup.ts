import { Store } from "../../../ios/src/core/store.ts";
import type { AgentConnectors, AgentUser, Detail, Directory, IssuedKey } from "./agentConnectors.ts";
import { explain } from "./manage.ts";

type SetupState = {
  directory: Directory | null;
  selected: AgentUser | null;
  detail: Detail | null;
  issued: IssuedKey | null;
  busy: boolean;
  error: string | null;
};
const empty = (): SetupState => ({
  directory: null,
  selected: null,
  detail: null,
  issued: null,
  busy: false,
  error: null,
});

/** One focused, foreground owner screen. Writes are explicit, never replayed. A late response must
 * not restore a secret after a back gesture, sign-out, profile switch or app backgrounding. */
export class ChannelAgentSetup {
  readonly state = new Store<SetupState>(empty());
  private readonly stop = new AbortController();
  private readonly api: AgentConnectors;
  readonly board: string;
  private readonly parent: AbortSignal;
  private readonly expired: () => void;

  constructor(api: AgentConnectors, board: string, parent: AbortSignal, expired: () => void) {
    this.api = api;
    this.board = board;
    this.parent = parent;
    this.expired = expired;
    if (parent.aborted) this.close();
    else parent.addEventListener("abort", this.close, { once: true });
  }

  close = () => {
    this.parent.removeEventListener("abort", this.close);
    this.stop.abort();
    this.state.set(empty());
  };

  private update(patch: Partial<SetupState>) {
    if (!this.stop.signal.aborted) this.state.update(patch);
  }

  private async run(job: (signal: AbortSignal) => Promise<void>, recovery = "") {
    if (this.stop.signal.aborted || this.state.get().busy) return;
    this.update({ busy: true, error: null });
    try {
      await job(this.stop.signal);
    } catch (e) {
      if (this.stop.signal.aborted) return;
      const failure = explain(e, "manage agent connectors");
      if (failure.expired) {
        this.close();
        this.expired();
        return;
      }
      // Require a fresh GET before a subsequent write, especially after an uncertain POST.
      this.update({
        detail: null,
        directory: null,
        issued: null,
        error: [failure.message, recovery].filter(Boolean).join(" "),
      });
    } finally {
      this.update({ busy: false });
    }
  }

  private async readDetail(agent: AgentUser, signal: AbortSignal) {
    if (signal.aborted) return;
    this.update({ selected: agent, detail: null, issued: null });
    this.update({ detail: await this.api.detail(agent.id, signal) });
  }

  users() {
    return this.run(async (s) => {
      this.update({ selected: null, detail: null, directory: null, issued: null });
      this.update({ directory: await this.api.directory(this.board, s) });
    });
  }

  refresh() {
    const agent = this.state.get().selected;
    return agent ? this.run((s) => this.readDetail(agent, s)) : this.users();
  }

  select(id: string) {
    const agent = this.state.get().directory?.users.find((u) => u.id === id);
    if (agent) return this.run((s) => this.readDetail(agent, s));
  }

  create(name: string) {
    if (!this.state.get().directory || this.state.get().selected) return;
    return this.run(async (s) => {
      const agent = await this.api.create(name, s);
      await this.readDetail(agent, s);
    }, "Check the agent list before creating another user.");
  }

  get endpoint() {
    return this.api.endpoint;
  }
  get home() {
    return this.api.home;
  }

  /** Recheck just before handing a secret to the native clipboard. A stale tap is harmless. */
  copyableKey(install: string) {
    const key = this.state.get().issued;
    return !this.stop.signal.aborted && key?.id === install ? key.token : null;
  }

  member() {
    return this.state
      .get()
      .detail?.channels.find((c) => c.tenant === this.api.home && c.channel === this.board);
  }

  add(watchOnly: boolean) {
    const { selected, detail } = this.state.get();
    if (!selected || !detail || this.member()) return;
    return this.run(async (s) => {
      await this.api.add(this.board, selected.id, watchOnly, s);
      await this.readDetail(selected, s);
    });
  }

  remove(id: string) {
    const { selected, directory } = this.state.get();
    if (selected ? selected.id !== id || !this.member() : !directory?.members.some((m) => m.id === id))
      return;
    return this.run(async (s) => {
      await this.api.remove(this.board, id, s);
      if (s.aborted) return;
      if (selected) await this.readDetail(selected, s);
      else this.update({ directory: await this.api.directory(this.board, s) });
    });
  }

  issue(label: string) {
    const { selected, issued } = this.state.get();
    if (!selected || issued || !this.member()) return;
    return this.run(async (s) => {
      this.update({ issued: await this.api.issue(selected.id, label, s) });
    }, "Refresh the installation list. If the host was created without a usable key, disconnect it before creating a replacement.");
  }

  disconnect(id: string) {
    const { selected, detail } = this.state.get();
    if (!selected || !detail?.installations.some((i) => i.id === id)) return;
    return this.run(async (s) => {
      await this.api.disconnect(selected.id, id, s);
      await this.readDetail(selected, s);
    });
  }
}
