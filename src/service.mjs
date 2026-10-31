import { randomUUID } from 'node:crypto';
import { openStore, record, ticketView, transaction, DeskError, UNRESOLVED } from './store.mjs';

// Every write that must be all-or-nothing runs inside transaction(). node:sqlite is
// synchronous, so each transaction also completes without interleaving with other
// requests in this process; UNIQUE constraints cover restarts and other processes.
export class DeskService {
  constructor({ databasePath = ':memory:', provider }) {
    this.db = openStore(databasePath);
    this.provider = provider;
    this.recoverInterruptedSends();
  }
  close() { this.db.close(); }

  // A SENDING attempt found at startup belonged to a process that died mid-send.
  // The provider may have accepted it, so it becomes UNKNOWN and is never resent.
  recoverInterruptedSends() {
    transaction(this.db, () => {
      for (const a of this.db.prepare("SELECT * FROM attempts WHERE state = 'SENDING'").all()) {
        this.db.prepare("UPDATE attempts SET state = 'UNKNOWN' WHERE id = ?").run(a.id);
        this.db.prepare("UPDATE tickets SET send_state = 'UNKNOWN' WHERE id = ?").run(a.ticket_id);
        record(this.db, a.ticket_id, 'delivery_unknown',
          `Application restarted while ref ${a.client_ref} (v${a.version}) was in flight. Outcome unknown; it was NOT resent. Use Check delivery.`);
      }
    });
  }

  listTickets(actor) {
    return this.db.prepare('SELECT * FROM tickets WHERE tenant_id = ? ORDER BY id').all(actor.tenantId);
  }
  // The only way to load a ticket for an agent: scoped to the server-resolved organization.
  row(actor, id) {
    const row = this.db.prepare('SELECT * FROM tickets WHERE id = ? AND tenant_id = ?').get(id, actor.tenantId);
    if (!row) throw new DeskError(404, 'Ticket not found');
    return row;
  }
  getTicket(actor, id) { return ticketView(this.db, this.row(actor, id)); }
  unresolved(id) {
    return this.db.prepare(`SELECT * FROM attempts WHERE ticket_id = ? AND state IN (${UNRESOLVED.map(() => '?').join()})
      ORDER BY id DESC LIMIT 1`).get(id, ...UNRESOLVED);
  }

  receiveWebhook(event) {
    const { tenantId, eventId, body } = event ?? {};
    const ticketId = Number(event?.ticketId);
    if (typeof tenantId !== 'string' || !Number.isInteger(ticketId) || typeof eventId !== 'string' || !eventId ||
        typeof body !== 'string') throw new DeskError(400, 'Invalid event');
    return transaction(this.db, () => {
      const t = this.db.prepare('SELECT * FROM tickets WHERE id = ? AND tenant_id = ?').get(ticketId, tenantId);
      if (!t) throw new DeskError(400, 'Invalid event');
      const fresh = this.db.prepare('INSERT OR IGNORE INTO inbound_events(tenant_id, event_id, ticket_id) VALUES (?, ?, ?)')
        .run(tenantId, eventId, t.id);
      if (fresh.changes === 0) return { accepted: true, duplicate: true };
      this.db.prepare('INSERT INTO messages(ticket_id, event_id, body) VALUES (?, ?, ?)').run(t.id, eventId, body);
      record(this.db, t.id, 'inbound', eventId);
      return { accepted: true, duplicate: false };
    });
  }

  updateDraft(actor, id, body) {
    transaction(this.db, () => {
      const t = this.row(actor, id);
      if (typeof body !== 'string' || !body.trim()) throw new DeskError(400, 'A reply is required');
      const pending = this.unresolved(id);
      if (pending) throw new DeskError(409, `Delivery ${pending.client_ref} is ${pending.state}. Check delivery before changing the reply.`);
      this.db.prepare("UPDATE tickets SET draft = ?, version = version + 1, approved_version = NULL, send_state = 'DRAFT' WHERE id = ?")
        .run(body, id);
      record(this.db, id, 'draft_updated', `${actor.id} saved v${t.version + 1}` +
        (t.approved_version === t.version ? `; approval of v${t.version} no longer applies` : ''));
    });
    return this.getTicket(actor, id);
  }

  // expectedVersion is optional: when given, approval only applies if it is still the saved version.
  approveDraft(actor, id, expectedVersion) {
    transaction(this.db, () => {
      const t = this.row(actor, id);
      if (!t.draft) throw new DeskError(400, 'No draft');
      if (expectedVersion != null && Number(expectedVersion) !== t.version)
        throw new DeskError(409, `The draft changed (now v${t.version}). Review it again before approving.`);
      if (t.approved_version === t.version) return;
      this.db.prepare('UPDATE tickets SET approved_version = version WHERE id = ?').run(id);
      record(this.db, id, 'approved', `${actor.id} approved the exact text of v${t.version}`);
    });
    return this.getTicket(actor, id);
  }

  handoff(actor, id) {
    transaction(this.db, () => {
      const t = this.row(actor, id);
      if (t.owner === 'human') return;
      this.db.prepare("UPDATE tickets SET owner = 'human' WHERE id = ?").run(id);
      record(this.db, id, 'human_handoff', `${actor.id} took over; automation can no longer send`);
    });
    return this.getTicket(actor, id);
  }

  async sendReply(actor, id, { automatic = false } = {}) {
    const who = automatic ? 'automation' : actor.id;
    // 1. Claim: check every precondition and record the attempt before calling the provider.
    //    The UNIQUE(ticket_id, version) row is the guard against double sends.
    const claim = transaction(this.db, () => {
      const t = this.row(actor, id);
      if (automatic && t.owner === 'human') {
        record(this.db, id, 'automation_refused', 'Automation dispatch refused: a human has taken over this ticket');
        return { refused: true };
      }
      if (!t.draft || t.approved_version !== t.version) throw new DeskError(409, 'Approve the current saved draft first');
      const pending = this.unresolved(id);
      if (pending) throw new DeskError(409, `Delivery ${pending.client_ref} is ${pending.state}. Check delivery instead of resending.`);
      const previous = this.db.prepare('SELECT * FROM attempts WHERE ticket_id = ? AND version = ?').get(id, t.version);
      if (previous && previous.state !== 'FAILED') throw new DeskError(409, `v${t.version} was already sent`);
      const clientRef = randomUUID();
      if (previous) {
        // Only an explicit provider rejection (nothing accepted) lets the same version be tried again.
        this.db.prepare("UPDATE attempts SET client_ref = ?, state = 'SENDING', provider_id = NULL WHERE id = ?").run(clientRef, previous.id);
      } else {
        this.db.prepare("INSERT INTO attempts(ticket_id, version, client_ref, body, state) VALUES (?, ?, ?, ?, 'SENDING')")
          .run(id, t.version, clientRef, t.draft);
      }
      this.db.prepare("UPDATE tickets SET send_state = 'SENDING' WHERE id = ?").run(id);
      record(this.db, id, 'send_started', `${who} dispatched v${t.version} with ref ${clientRef}`);
      return { clientRef, body: t.draft, version: t.version };
    });
    if (claim.refused) throw new DeskError(409, 'A human has taken over this ticket; automation may not send');

    // 2. Exactly one provider call per claim. No automatic retry: a retry after an
    //    uncertain failure could deliver the same reply twice.
    let result;
    try {
      result = await this.provider.send({ clientRef: claim.clientRef, ticketId: id, body: claim.body });
    } catch (error) {
      if (error?.kind === 'not_accepted') {
        this.settle(id, claim.clientRef, 'FAILED', null, 'send_rejected',
          `Provider explicitly rejected ref ${claim.clientRef} before accepting it. Nothing was delivered; safe to send again.`);
        throw new DeskError(502, 'The provider rejected the reply; nothing was delivered. It is safe to send again.');
      }
      this.settle(id, claim.clientRef, 'UNKNOWN', null, 'delivery_unknown',
        `Provider did not confirm ref ${claim.clientRef} (${error?.message || 'no response'}). It may have been delivered. Not resent.`);
      throw new DeskError(502, 'The provider did not confirm delivery. Status is UNKNOWN: use Check delivery and do not resend.');
    }
    if (!result?.providerMessageId) {
      this.settle(id, claim.clientRef, 'UNKNOWN', null, 'delivery_unknown',
        `Provider answered ref ${claim.clientRef} without a message id. Not resent.`);
      throw new DeskError(502, 'The provider gave no delivery evidence. Status is UNKNOWN: use Check delivery.');
    }
    // 3. Record evidence.
    this.settle(id, claim.clientRef, 'SENT', result.providerMessageId, 'sent',
      `${who}: ref ${claim.clientRef} accepted as ${result.providerMessageId}`);
    return this.getTicket(actor, id);
  }

  // Moves an unresolved attempt to its final state. A no-op if something else (for
  // example a reconcile) already resolved it, so late answers cannot overwrite evidence.
  settle(id, clientRef, state, providerId, action, detail) {
    transaction(this.db, () => {
      const changed = this.db.prepare(`UPDATE attempts SET state = ?, provider_id = COALESCE(?, provider_id)
        WHERE client_ref = ? AND state IN ('SENDING', 'UNKNOWN')`).run(state, providerId, clientRef).changes;
      if (!changed) return;
      this.db.prepare('UPDATE tickets SET send_state = ? WHERE id = ?').run(state, id);
      record(this.db, id, action, detail);
    });
  }

  // Resolves the last pending/uncertain attempt using provider evidence only. Never sends.
  async reconcile(actor, id) {
    this.row(actor, id);
    const attempt = this.unresolved(id);
    if (!attempt) throw new DeskError(409, 'There is no pending or uncertain delivery to check');
    let evidence;
    try {
      evidence = await this.provider.lookup(attempt.client_ref);
    } catch (error) {
      record(this.db, id, 'reconcile_failed', `${actor.id} could not check ref ${attempt.client_ref}: ${error?.message || 'lookup failed'}. Status remains ${attempt.state}.`);
      throw new DeskError(502, `Delivery lookup failed. Status remains ${attempt.state}; do not resend.`);
    }
    if (evidence?.state === 'delivered' && evidence.providerMessageId) {
      this.settle(id, attempt.client_ref, 'SENT', evidence.providerMessageId, 'delivery_confirmed',
        `${actor.id} checked ref ${attempt.client_ref}: provider confirms delivery as ${evidence.providerMessageId}` +
        (evidence.count > 1 ? ` (WARNING: provider reports ${evidence.count} deliveries for this reference)` : ''));
    } else {
      record(this.db, id, 'reconcile_inconclusive', `${actor.id} checked ref ${attempt.client_ref}: provider answered ` +
        `${evidence?.state || 'nothing'}. That does not prove it was not delivered. Status remains ${attempt.state}; nothing was resent.`);
    }
    return this.getTicket(actor, id);
  }
}
