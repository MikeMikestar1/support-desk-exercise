import { randomUUID } from 'node:crypto';
import { openStore, record, ticketView, DeskError } from './store.mjs';

// This inherited implementation is intentionally incomplete. See README acceptance criteria.
export class DeskService {
  constructor({ databasePath = ':memory:', provider }) {
    this.db = openStore(databasePath);
    this.provider = provider;
  }
  close() { this.db.close(); }
  listTickets(actor) {
    return this.db.prepare('SELECT * FROM tickets WHERE tenant_id = ? ORDER BY id').all(actor.tenantId);
  }
  row(actor, id) {
    const row = this.db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
    if (!row) throw new DeskError(404, 'Ticket not found');
    return row;
  }
  getTicket(actor, id) { return ticketView(this.db, this.row(actor, id)); }
  receiveWebhook(event) {
    const t = this.db.prepare('SELECT * FROM tickets WHERE id = ? AND tenant_id = ?')
      .get(event.ticketId, event.tenantId);
    if (!t || !event.eventId || typeof event.body !== 'string') throw new DeskError(400, 'Invalid event');
    this.db.prepare('INSERT INTO messages(ticket_id, event_id, body) VALUES (?, ?, ?)')
      .run(t.id, event.eventId, event.body);
    record(this.db, t.id, 'inbound', event.eventId);
    return { accepted: true };
  }
  updateDraft(actor, id, body) {
    this.row(actor, id);
    if (typeof body !== 'string' || !body.trim()) throw new DeskError(400, 'A reply is required');
    this.db.prepare("UPDATE tickets SET draft = ?, version = version + 1, send_state = 'DRAFT' WHERE id = ?")
      .run(body, id);
    record(this.db, id, 'draft_updated', actor.id);
    return this.getTicket(actor, id);
  }
  approveDraft(actor, id) {
    const t = this.row(actor, id);
    if (!t.draft) throw new DeskError(400, 'No draft');
    this.db.prepare('UPDATE tickets SET approved_version = version WHERE id = ?').run(id);
    record(this.db, id, 'approved', actor.id);
    return this.getTicket(actor, id);
  }
  handoff(actor, id) {
    this.row(actor, id);
    this.db.prepare("UPDATE tickets SET owner = 'human' WHERE id = ?").run(id);
    record(this.db, id, 'human_handoff', actor.id);
    return this.getTicket(actor, id);
  }
  async sendReply(actor, id, { automatic = false } = {}) {
    const t = this.row(actor, id);
    if (t.approved_version == null) throw new DeskError(409, 'Approve the reply first');
    let result;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        result = await this.provider.send({ clientRef: randomUUID(), ticketId: id, body: t.draft });
        break;
      } catch (error) {
        if (attempt === 1) throw error;
      }
    }
    this.db.prepare("UPDATE tickets SET send_state = 'SENT' WHERE id = ?").run(id);
    record(this.db, id, 'sent', `${automatic ? 'automation' : actor.id}: ${result.providerMessageId}`);
    return this.getTicket(actor, id);
  }
  async reconcile(actor, id) {
    this.row(actor, id);
    throw new DeskError(501, 'Reconciliation has not been implemented');
  }
}
