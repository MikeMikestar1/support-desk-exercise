// Focused tests through the injectable DeskService adapter (see CONTRACT.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeskService } from '../src/service.mjs';

const alpha = { id: 'agent-alpha', tenantId: 'alpha' };
const beta = { id: 'agent-beta', tenantId: 'beta' };
const event = (eventId, extra = {}) => ({ tenantId: 'alpha', ticketId: 101, eventId, body: 'Please help', ...extra });

// A fake provider that records every send and can be told how to answer.
function fakeProvider() {
  const p = {
    sent: [],
    mode: 'normal',
    lookupResult: null,
    async send(payload) {
      if (p.mode === 'reject') { const e = new Error('rejected'); e.kind = 'not_accepted'; throw e; }
      p.sent.push(payload);
      if (p.mode === 'timeout') { const e = new Error('timeout'); e.kind = 'unknown'; throw e; }
      if (p.mode === 'slow') await new Promise(r => setTimeout(r, 30));
      if (p.mode === 'hang') return new Promise(() => {});
      return { providerMessageId: 'pm-' + p.sent.length };
    },
    async lookup(clientRef) {
      if (p.lookupResult === 'error') throw new Error('Lookup unavailable');
      if (p.lookupResult === 'not_found') return { state: 'not_found' };
      const hits = p.sent.filter(m => m.clientRef === clientRef);
      return hits.length ? { state: 'delivered', providerMessageId: 'pm-lookup', count: hits.length } : { state: 'not_found' };
    }
  };
  return p;
}

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'desk-test-'));
  return { path: join(dir, 'desk.sqlite'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function rejectsWith(promiseOrFn, status) {
  await assert.rejects(async () => (typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn),
    e => { assert.equal(e.status, status, `expected ${status}, got ${e.status}: ${e.message}`); return true; });
}

function approved(s, body = 'A human will help.') {
  s.updateDraft(alpha, 101, body);
  s.approveDraft(alpha, 101);
}

// ---------- 1. Safe inbound delivery ----------

test('webhook replay creates exactly one customer message', () => {
  const s = new DeskService({ provider: fakeProvider() });
  try {
    s.receiveWebhook(event('event-1'));
    s.receiveWebhook(event('event-1'));
    assert.equal(s.getTicket(alpha, 101).messages.length, 1);
    assert.equal(s.getTicket(alpha, 101).audit.filter(a => a.action === 'inbound').length, 1);
  } finally { s.close(); }
});

test('event identity is scoped per organization', () => {
  const s = new DeskService({ provider: fakeProvider() });
  try {
    s.receiveWebhook(event('event-1'));
    s.receiveWebhook({ tenantId: 'beta', ticketId: 202, eventId: 'event-1', body: 'Beta needs help' });
    assert.equal(s.getTicket(alpha, 101).messages.length, 1);
    assert.equal(s.getTicket(beta, 202).messages.length, 1);
  } finally { s.close(); }
});

test('webhook replay after an application restart is still ignored', () => {
  const db = tempDb();
  try {
    const a = new DeskService({ databasePath: db.path, provider: fakeProvider() });
    a.receiveWebhook(event('event-restart'));
    a.close();
    const b = new DeskService({ databasePath: db.path, provider: fakeProvider() });
    b.receiveWebhook(event('event-restart'));
    assert.equal(b.getTicket(alpha, 101).messages.length, 1);
    b.close();
  } finally { db.cleanup(); }
});

test('event record and its message commit or roll back together', () => {
  const s = new DeskService({ provider: fakeProvider() });
  try {
    // Make the final write of the business change fail.
    s.db.exec("CREATE TRIGGER boom BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;");
    assert.throws(() => s.receiveWebhook(event('event-atomic')));
    s.db.exec('DROP TRIGGER boom');
    assert.equal(s.getTicket(alpha, 101).messages.length, 0, 'no half-written message');
    // Because nothing was committed, the provider's retry must now succeed exactly once.
    s.receiveWebhook(event('event-atomic'));
    s.receiveWebhook(event('event-atomic'));
    assert.equal(s.getTicket(alpha, 101).messages.length, 1);
  } finally { s.close(); }
});

test('webhook for a ticket in another organization is rejected', () => {
  const s = new DeskService({ provider: fakeProvider() });
  try {
    assert.throws(() => s.receiveWebhook({ tenantId: 'alpha', ticketId: 202, eventId: 'x', body: 'hi' }), e => e.status === 400);
    assert.equal(s.getTicket(beta, 202).messages.length, 0);
  } finally { s.close(); }
});

// ---------- 2. Customer isolation ----------

test('an agent cannot read or change another organization\'s ticket', async () => {
  const p = fakeProvider();
  const s = new DeskService({ provider: p });
  try {
    s.updateDraft(beta, 202, 'Beta draft'); s.approveDraft(beta, 202);
    const before = JSON.stringify(s.getTicket(beta, 202));
    assert.throws(() => s.getTicket(alpha, 202), e => e.status === 404);
    assert.throws(() => s.updateDraft(alpha, 202, 'hijack'), e => e.status === 404);
    assert.throws(() => s.approveDraft(alpha, 202), e => e.status === 404);
    assert.throws(() => s.handoff(alpha, 202), e => e.status === 404);
    await rejectsWith(() => s.sendReply(alpha, 202), 404);
    await rejectsWith(() => s.sendReply(alpha, 202, { automatic: true }), 404);
    await rejectsWith(() => s.reconcile(alpha, 202), 404);
    assert.equal(p.sent.length, 0);
    assert.equal(JSON.stringify(s.getTicket(beta, 202)), before, 'beta ticket unchanged');
    // A tenantId smuggled into the actor-independent path does not help either.
    assert.deepEqual(s.listTickets(alpha).map(t => t.id), [101]);
  } finally { s.close(); }
});

// ---------- 3. Exact approval ----------

test('a draft cannot be sent before approval', async () => {
  const p = fakeProvider();
  const s = new DeskService({ provider: p });
  try {
    s.updateDraft(alpha, 101, 'Not approved yet');
    await rejectsWith(() => s.sendReply(alpha, 101), 409);
    assert.equal(p.sent.length, 0);
  } finally { s.close(); }
});

test('editing an approved draft invalidates the approval', async () => {
  const p = fakeProvider();
  const s = new DeskService({ provider: p });
  try {
    approved(s, 'Approved text');
    s.updateDraft(alpha, 101, 'Edited text nobody approved');
    assert.equal(s.getTicket(alpha, 101).approved, false);
    await rejectsWith(() => s.sendReply(alpha, 101), 409);
    await rejectsWith(() => s.sendReply(alpha, 101, { automatic: true }), 409);
    assert.equal(p.sent.length, 0);
    s.approveDraft(alpha, 101);
    await s.sendReply(alpha, 101);
    assert.deepEqual(p.sent.map(m => m.body), ['Edited text nobody approved']);
  } finally { s.close(); }
});

test('approval of a stale version is refused', () => {
  const s = new DeskService({ provider: fakeProvider() });
  try {
    const v1 = s.updateDraft(alpha, 101, 'first').version;
    s.updateDraft(alpha, 101, 'second');
    assert.throws(() => s.approveDraft(alpha, 101, v1), e => e.status === 409);
    assert.equal(s.getTicket(alpha, 101).approved_version, null);
  } finally { s.close(); }
});

test('overlapping send requests deliver the approved version once', async () => {
  const p = fakeProvider(); p.mode = 'slow';
  const s = new DeskService({ provider: p });
  try {
    approved(s);
    const results = await Promise.allSettled([s.sendReply(alpha, 101), s.sendReply(alpha, 101), s.sendReply(alpha, 101, { automatic: true })]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.ok(results.filter(r => r.status === 'rejected').every(r => r.reason.status === 409));
    assert.equal(p.sent.length, 1);
    // A later repeated click is refused as well.
    await rejectsWith(() => s.sendReply(alpha, 101), 409);
    assert.equal(p.sent.length, 1);
    assert.equal(s.getTicket(alpha, 101).send_state, 'SENT');
  } finally { s.close(); }
});

// ---------- 4. Honest delivery and recovery ----------

test('a provider timeout is recorded as UNKNOWN and never auto-resent', async () => {
  const p = fakeProvider(); p.mode = 'timeout';
  const s = new DeskService({ provider: p });
  try {
    approved(s);
    await rejectsWith(() => s.sendReply(alpha, 101), 502);
    const t = s.getTicket(alpha, 101);
    assert.equal(p.sent.length, 1, 'no automatic retry');
    assert.equal(t.send_state, 'UNKNOWN');
    assert.equal(t.attempts.length, 1);
    assert.equal(t.attempts[0].state, 'UNKNOWN');
    assert.equal(t.attempts[0].client_ref, p.sent[0].clientRef, 'reference that can be reconciled');
    p.mode = 'normal';
    await rejectsWith(() => s.sendReply(alpha, 101), 409);
    await rejectsWith(() => s.sendReply(alpha, 101, { automatic: true }), 409);
    assert.equal(p.sent.length, 1);
  } finally { s.close(); }
});

test('reconcile: not_found and lookup failures stay UNKNOWN; delivered resolves without resending', async () => {
  const p = fakeProvider(); p.mode = 'timeout';
  const s = new DeskService({ provider: p });
  try {
    approved(s);
    await rejectsWith(() => s.sendReply(alpha, 101), 502);
    p.mode = 'normal';
    p.lookupResult = 'not_found';
    let t = await s.reconcile(alpha, 101);
    assert.equal(t.send_state, 'UNKNOWN');
    p.lookupResult = 'error';
    await rejectsWith(() => s.reconcile(alpha, 101), 502);
    assert.equal(s.getTicket(alpha, 101).send_state, 'UNKNOWN');
    await rejectsWith(() => s.sendReply(alpha, 101), 409);
    p.lookupResult = null; // real evidence: same clientRef was delivered
    t = await s.reconcile(alpha, 101);
    assert.equal(t.send_state, 'SENT');
    assert.equal(t.attempts[0].state, 'SENT');
    assert.equal(t.attempts[0].provider_id, 'pm-lookup');
    assert.equal(p.sent.length, 1, 'reconcile never sends');
    assert.ok(t.audit.some(a => a.action === 'reconcile_inconclusive'));
  } finally { s.close(); }
});

test('an explicit rejection is a safe failure that can be retried', async () => {
  const p = fakeProvider(); p.mode = 'reject';
  const s = new DeskService({ provider: p });
  try {
    approved(s);
    await rejectsWith(() => s.sendReply(alpha, 101), 502);
    assert.equal(s.getTicket(alpha, 101).send_state, 'FAILED');
    p.mode = 'normal';
    const t = await s.sendReply(alpha, 101);
    assert.equal(t.send_state, 'SENT');
    assert.equal(p.sent.length, 1);
  } finally { s.close(); }
});

test('restart while a send is in flight does not send again', async () => {
  const db = tempDb();
  try {
    const p = fakeProvider(); p.mode = 'hang';
    const a = new DeskService({ databasePath: db.path, provider: p });
    approved(a);
    a.sendReply(alpha, 101).catch(() => {}); // process "dies" while the provider holds the request
    await new Promise(r => setImmediate(r));
    assert.equal(p.sent.length, 1);
    a.close();

    p.mode = 'normal';
    const b = new DeskService({ databasePath: db.path, provider: p });
    try {
      assert.equal(b.getTicket(alpha, 101).send_state, 'UNKNOWN');
      await rejectsWith(() => b.sendReply(alpha, 101), 409);
      await rejectsWith(() => b.sendReply(alpha, 101, { automatic: true }), 409);
      assert.equal(p.sent.length, 1);
      const t = await b.reconcile(alpha, 101);
      assert.equal(t.send_state, 'SENT');
      assert.equal(p.sent.length, 1);
    } finally { b.close(); }
  } finally { db.cleanup(); }
});

// ---------- 5. Human takeover ----------

test('after takeover, automation is refused but an approved human reply is sent', async () => {
  const p = fakeProvider();
  const s = new DeskService({ provider: p });
  try {
    approved(s);
    s.handoff(alpha, 101);
    await rejectsWith(() => s.sendReply(alpha, 101, { automatic: true }), 409);
    assert.equal(p.sent.length, 0);
    const refused = s.getTicket(alpha, 101).audit.find(a => a.action === 'automation_refused');
    assert.ok(refused, 'refusal is visible in the audit trail');
    const t = await s.sendReply(alpha, 101);
    assert.equal(t.send_state, 'SENT');
    assert.equal(p.sent.length, 1);
  } finally { s.close(); }
});

test('automation also requires approval', async () => {
  const p = fakeProvider();
  const s = new DeskService({ provider: p });
  try {
    s.updateDraft(alpha, 101, 'AI-looking text has no authority');
    await rejectsWith(() => s.sendReply(alpha, 101, { automatic: true }), 409);
    assert.equal(p.sent.length, 0);
  } finally { s.close(); }
});

// ---------- 6. Usable handoff ----------

test('ticket view tells the operator the next safe action', async () => {
  const p = fakeProvider(); p.mode = 'timeout';
  const s = new DeskService({ provider: p });
  try {
    assert.match(s.getTicket(alpha, 101).next_action, /draft/i);
    approved(s);
    assert.match(s.getTicket(alpha, 101).next_action, /send/i);
    await rejectsWith(() => s.sendReply(alpha, 101), 502);
    assert.match(s.getTicket(alpha, 101).next_action, /check delivery/i);
  } finally { s.close(); }
});
