// End-to-end checks against the real HTTP server and the real mock provider,
// each started as a child process with its own temporary data directory.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'desk-http-'));
const freePort = () => new Promise(res => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
let appPort, providerPort, app, provider;
const APP = () => `http://127.0.0.1:${appPort}`;
const PROVIDER = () => `http://127.0.0.1:${providerPort}`;

async function waitFor(url) {
  for (let i = 0; i < 100; i++) {
    try { await fetch(url); return; } catch { await new Promise(r => setTimeout(r, 50)); }
  }
  throw new Error('Timed out waiting for ' + url);
}
function startProvider() {
  provider = spawn(process.execPath, ['src/mock-provider.mjs'], { cwd: root, stdio: 'ignore',
    env: { ...process.env, PROVIDER_PORT: String(providerPort), PROVIDER_DB: join(dir, 'provider.sqlite') } });
  return waitFor(PROVIDER() + '/deliveries');
}
function startApp() {
  app = spawn(process.execPath, ['src/server.mjs'], { cwd: root, stdio: 'ignore',
    env: { ...process.env, PORT: String(appPort), DESK_DB: join(dir, 'desk.sqlite'), PROVIDER_URL: PROVIDER() } });
  return waitFor(APP() + '/');
}
function stop(child) {
  return new Promise(res => { if (child.exitCode !== null) return res(); child.once('exit', res); child.kill('SIGKILL'); });
}

const auth = who => ({ Authorization: `Bearer demo-${who}-token`, 'Content-Type': 'application/json' });
async function call(path, { method = 'GET', who = 'alpha', body, headers } = {}) {
  const r = await fetch(APP() + path, { method, headers: headers || auth(who), body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
const post = (path, body = {}, who = 'alpha') => call(path, { method: 'POST', body, who });
const setMode = mode => fetch(PROVIDER() + '/control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) });
const deliveries = async () => (await fetch(PROVIDER() + '/deliveries')).json();
const webhook = (body, secret = 'fictional-webhook-secret') => fetch(APP() + '/webhooks/ghl', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Demo-Webhook-Secret': secret }, body: JSON.stringify(body) });

before(async () => {
  [appPort, providerPort] = await Promise.all([freePort(), freePort()]);
  await startProvider();
  await startApp();
});
after(async () => {
  await Promise.all([stop(app), stop(provider)]);
  rmSync(dir, { recursive: true, force: true });
});

test('webhook authentication is enforced', async () => {
  assert.equal((await webhook({ tenantId: 'alpha', ticketId: 101, eventId: 'bad', body: 'x' }, 'wrong')).status, 401);
  const r = await fetch(APP() + '/webhooks/ghl', { method: 'POST', body: '{}' });
  assert.equal(r.status, 401);
});

test('overlapping webhook replays store one message per organization-scoped event', async () => {
  const ev = { tenantId: 'alpha', ticketId: 101, eventId: 'event-1', body: '<img src=x onerror=alert(1)> Please help' };
  const results = await Promise.all(Array.from({ length: 8 }, () => webhook(ev)));
  assert.ok(results.every(r => r.status === 200));
  assert.equal((await webhook({ tenantId: 'beta', ticketId: 202, eventId: 'event-1', body: 'Beta help' })).status, 200);
  const t = (await call('/api/tickets/101')).body;
  assert.equal(t.messages.filter(m => m.event_id === 'event-1').length, 1);
  assert.equal(t.messages[0].body, ev.body, 'untrusted text stored verbatim; UI renders it with textContent');
  assert.equal((await call('/api/tickets/202', { who: 'beta' })).body.messages.length, 1);
});

test('cross-organization access is refused even with a forged tenantId', async () => {
  assert.equal((await call('/api/tickets/202')).status, 404);
  assert.equal((await post('/api/tickets/202/draft', { body: 'hijack', tenantId: 'beta' })).status, 404);
  assert.equal((await post('/api/tickets/202/approve', { tenantId: 'beta' })).status, 404);
  assert.equal((await post('/api/tickets/202/handoff', { tenantId: 'beta' })).status, 404);
  assert.equal((await post('/api/tickets/202/send', { tenantId: 'beta' })).status, 404);
  assert.equal((await post('/api/tickets/202/reconcile', { tenantId: 'beta' })).status, 404);
  assert.deepEqual((await call('/api/tickets?tenantId=beta')).body.map(t => t.id), [101]);
  assert.equal((await call('/api/tickets/202', { who: 'beta' })).body.draft, '');
});

test('provider timeout -> UNKNOWN, no resend, reconcile confirms the same attempt', async () => {
  const start = (await deliveries()).length;
  await post('/api/tickets/101/draft', { body: 'Timeout reply' });
  await post('/api/tickets/101/approve');
  await setMode('accept_then_timeout');
  const sent = await post('/api/tickets/101/send');
  assert.equal(sent.status, 502);
  await setMode('normal');
  let t = (await call('/api/tickets/101')).body;
  assert.equal(t.send_state, 'UNKNOWN');
  assert.equal((await post('/api/tickets/101/send')).status, 409, 'repeated click refused');
  assert.equal((await post('/api/tickets/101/automation')).status, 409);
  assert.equal((await deliveries()).length, start + 1, 'customer received it exactly once');
  t = (await post('/api/tickets/101/reconcile')).body;
  assert.equal(t.send_state, 'SENT');
  const last = t.attempts.at(-1);
  assert.equal(last.provider_id, (await deliveries()).at(-1).id);
  assert.equal((await deliveries()).length, start + 1);
});

test('application restart during an accepted-but-unanswered send does not resend', async () => {
  const start = (await deliveries()).length;
  await post('/api/tickets/101/draft', { body: 'Restart reply' });
  await post('/api/tickets/101/approve');
  await setMode('accept_then_delay');
  const pending = post('/api/tickets/101/send').catch(() => 'connection lost');
  for (let i = 0; i < 100 && (await deliveries()).length === start; i++) await new Promise(r => setTimeout(r, 20));
  assert.equal((await deliveries()).length, start + 1, 'provider accepted the message');
  await stop(app); // crash mid-send
  await pending;
  await setMode('normal');
  await startApp();
  let t = (await call('/api/tickets/101')).body;
  assert.equal(t.send_state, 'UNKNOWN');
  assert.equal((await post('/api/tickets/101/send')).status, 409);
  assert.equal((await post('/api/tickets/101/automation')).status, 409);
  t = (await post('/api/tickets/101/reconcile')).body;
  assert.equal(t.send_state, 'SENT');
  assert.equal((await deliveries()).length, start + 1);
});

test('prototype keys are not valid bearer tokens', async () => {
  for (const token of ['constructor', '__proto__', 'toString', ''])
    assert.equal((await call('/api/tickets', { headers: { Authorization: 'Bearer ' + token } })).status, 401);
});

test('explicit provider rejection is shown as a safe failure and can be sent again', async () => {
  const start = (await deliveries()).length;
  await post('/api/tickets/101/draft', { body: 'Rejected first time' });
  await post('/api/tickets/101/approve');
  await setMode('reject_before_accept');
  assert.equal((await post('/api/tickets/101/send')).status, 502);
  await setMode('normal');
  assert.equal((await call('/api/tickets/101')).body.send_state, 'FAILED');
  assert.equal((await deliveries()).length, start);
  const r = await post('/api/tickets/101/send');
  assert.equal(r.status, 200);
  assert.equal(r.body.send_state, 'SENT');
  assert.equal((await deliveries()).length, start + 1);
});

test('connection loss is UNKNOWN; a not_found lookup does not authorize a resend', async () => {
  const start = (await deliveries()).length;
  await post('/api/tickets/101/draft', { body: 'Provider is down' });
  await post('/api/tickets/101/approve');
  await stop(provider);
  assert.equal((await post('/api/tickets/101/send')).status, 502);
  assert.equal((await post('/api/tickets/101/reconcile')).status, 502, 'failed lookup is inconclusive');
  await startProvider();
  const t = (await post('/api/tickets/101/reconcile')).body;
  assert.equal(t.send_state, 'UNKNOWN', 'not_found keeps the attempt UNKNOWN');
  assert.match(t.next_action, /Check delivery/);
  assert.equal((await post('/api/tickets/101/send')).status, 409);
  assert.equal((await deliveries()).length, start);
});

test('overlapping send requests reach the provider once; takeover blocks automation', async () => {
  const start = (await deliveries()).length;
  await post('/api/tickets/202/draft', { body: 'Beta reply' }, 'beta');
  await post('/api/tickets/202/approve', {}, 'beta');
  await post('/api/tickets/202/handoff', {}, 'beta');
  assert.equal((await post('/api/tickets/202/automation', {}, 'beta')).status, 409);
  const results = await Promise.all(Array.from({ length: 5 }, () => post('/api/tickets/202/send', {}, 'beta')));
  assert.equal(results.filter(r => r.status === 200).length, 1);
  assert.ok(results.filter(r => r.status !== 200).every(r => r.status === 409));
  assert.equal((await deliveries()).length, start + 1);
});
