// Real Worker acceptance trial for the actual iOS API/session/channel controllers.
// Requires root dependencies: bun install --frozen-lockfile. Uses no deployed service or real keys.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { SessionController } from '../src/core/sessionController.ts';
import { ChannelController } from '../src/core/channelController.ts';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const dir = await mkdtemp(join(tmpdir(), 'msn-ios-worker-'));
const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const tenant = 'ios-acceptance';
const admin = 'isolated-ios-worker-acceptance-admin';
const worker = spawn(join(root, 'node_modules/.bin/wrangler'), ['dev', '--ip', '127.0.0.1', '--port', String(port), '--persist-to', join(dir, 'worker')], {
  cwd: root, env: { ...process.env, ADMIN_TOKEN: admin, WRANGLER_SEND_METRICS: 'false' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
worker.on('error', error => { log += `Worker process failed: ${error.message}`; });
for (const stream of [worker.stdout, worker.stderr]) stream.on('data', chunk => { log = (log + chunk).slice(-8000); });
let session, channel;
async function waitFor(predicate, label, timeout = 8000) {
  const start = Date.now();
  while (!predicate()) { if (Date.now() - start > timeout) throw Error(`Timed out: ${label}`); await delay(20); }
}
async function api(path, token, method = 'GET', body, key) {
  const r = await fetch(origin + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000) });
  const result = await r.json(); assert.ok(r.ok, `HTTP ${r.status} for ${path}: ${JSON.stringify(result)}`); return result;
}
try {
  let ready = false;
  for (let i = 0; i < 150; i++) {
    try { ready = (await fetch(origin + '/api/health', { signal: AbortSignal.timeout(1000) })).ok; } catch {}
    if (ready) break; await delay(100);
  }
  assert.ok(ready, `Fixture Worker failed to start: ${log.slice(-1000)}`);
  const credentials = await api(`/api/admin/tenants/${tenant}`, admin, 'PUT', { username: 'ios-observer' });
  const workerKey = await api(`/api/admin/tenants/${tenant}/keys/worker`, admin, 'PUT', { username: 'worker' });
  let expired = 0;
  session = new SessionController({ origin, tenant, token: credentials.token, username: 'ios-observer', usernamePrefix: null }, { fetchImpl: globalThis.fetch, stream: { waitSeconds: 1 }, onAuthExpired: () => { expired++; } });
  await session.start(); assert.equal(session.state.get().kind, 'live');
  await session.api.createChannel('work', session.signal);
  const channels = await session.api.listChannels(undefined, 100, session.signal);
  assert.ok(channels.channels.some(c => c.name === 'work'));
  channel = new ChannelController(session, 'work'); channel.start();
  await waitFor(() => channel.state.get().phase === 'ready', 'initial canonical channel read');
  const draft = { text: 'iOS controller directed-message acceptance', to: 'worker' };
  assert.equal(channel.send(draft).ok, true);
  const pending = structuredClone(channel.state.get().outbox[0]); assert.ok(pending.key);
  await waitFor(() => channel.state.get().outbox.length === 0 && channel.state.get().messages.some(m => m.text === draft.text), 'canonical send confirmation');
  const sent = channel.state.get().messages.find(m => m.text === draft.text); assert.equal(sent.to, 'worker');
  const replay = await session.api.sendMessage('work', pending.input, pending.key, session.signal);
  assert.equal(replay.replayed, true); assert.equal(replay.message.id, sent.id);
  const cursor = session.cursor;
  session.pause(); assert.equal(session.state.get().kind, 'paused'); assert.equal(session.signal.aborted, true);
  const received = await api(`/api/tenants/${tenant}/channels/work/messages`, workerKey.token, 'POST', { username: 'worker', to: 'ios-observer', text: 'Work completed while the app was backgrounded.' }, 'backgrounded-result');
  await delay(150); assert.equal(channel.state.get().messages.some(m => m.id === received.message.id), false);
  session.resume();
  await waitFor(() => channel.state.get().messages.some(m => m.id === received.message.id), 'foreground replay');
  await waitFor(() => session.cursor > cursor, 'event cursor advances after dispatch');
  const messages = channel.state.get().messages;
  assert.equal(new Set(messages.map(m => m.id)).size, messages.length);
  assert.equal(messages.length, 2, 'Retry or resume duplicated a message');
  // Rotate only this isolated fixture's workspace key. Pending readers must stop on auth loss.
  await api(`/api/admin/tenants/${tenant}/token`, admin, 'POST', {});
  await waitFor(() => session.state.get().kind === 'expired', 'key rotation terminates the session');
  assert.equal(expired, 1);
  console.log(JSON.stringify({ ok: true, realWorker: true, namedChannels: true, directedSend: true, sameKeyReplay: true, backgroundPause: true, foregroundReplay: true, duplicateMessages: 0, authRotationStops: true, messageCount: messages.length }));
} finally {
  channel?.dispose(); session?.dispose();
  if (worker.exitCode === null) {
    const exit = once(worker, 'exit');
    try { process.kill(-worker.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    await exit;
  }
}
