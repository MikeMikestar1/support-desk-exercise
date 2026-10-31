import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeskService } from '../src/service.mjs';
const actor = { id: 'agent-alpha', tenantId: 'alpha' };
test('inbox lists only the signed-in tenant', () => {
  const s = new DeskService({ provider: {} });
  try { assert.deepEqual(s.listTickets(actor).map(t => t.id), [101]); } finally { s.close(); }
});
test('a simple approved reply reaches a healthy provider', async () => {
  const delivered = [];
  const s = new DeskService({ provider: { send: async m => { delivered.push(m); return { providerMessageId: 'demo-1' }; } } });
  try {
    s.updateDraft(actor, 101, 'A human will help.'); s.approveDraft(actor, 101);
    const t = await s.sendReply(actor, 101);
    assert.equal(delivered.length, 1); assert.equal(t.send_state, 'SENT');
  } finally { s.close(); }
});
