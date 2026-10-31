import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class DeskError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Attempt states. SENDING = claimed and handed to the provider, outcome not yet known.
// UNKNOWN = the provider may or may not have accepted it; only provider evidence resolves it.
export const UNRESOLVED = ['SENDING', 'UNKNOWN'];

export function openStore(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS tickets (
      id INTEGER PRIMARY KEY, tenant_id TEXT NOT NULL, contact TEXT NOT NULL,
      subject TEXT NOT NULL, owner TEXT NOT NULL DEFAULT 'automation',
      draft TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 0,
      approved_version INTEGER, send_state TEXT NOT NULL DEFAULT 'DRAFT'
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL, event_id TEXT NOT NULL,
      body TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL, action TEXT NOT NULL,
      detail TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS attempts (
      id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL, version INTEGER NOT NULL,
      client_ref TEXT NOT NULL UNIQUE, body TEXT NOT NULL,
      state TEXT NOT NULL, provider_id TEXT,
      UNIQUE(ticket_id, version)
    );
    -- Webhook idempotency: one row per (organization, event). Written in the same
    -- transaction as the message it produces, so a replay can never add a second one.
    CREATE TABLE IF NOT EXISTS inbound_events (
      tenant_id TEXT NOT NULL, event_id TEXT NOT NULL, ticket_id INTEGER NOT NULL,
      received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (tenant_id, event_id)
    );
    INSERT OR IGNORE INTO tickets(id, tenant_id, contact, subject) VALUES
      (101, 'alpha', 'Jordan Demo', 'Cannot resume my practice exam'),
      (202, 'beta', 'Casey Example', 'Course completion is missing');
  `);
  return db;
}

// Runs fn inside a write transaction; any throw rolls back every write it made.
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function record(db, id, action, detail) {
  db.prepare('INSERT INTO audit(ticket_id, action, detail) VALUES (?, ?, ?)')
    .run(id, action, detail);
}

export function nextAction(t, attempts) {
  const last = attempts.at(-1);
  if (last?.state === 'UNKNOWN')
    return `Delivery is UNKNOWN for reference ${last.client_ref}. Click "Check delivery". Do not resend or rewrite the reply: ` +
      'the customer may already have it. If the provider keeps answering not_found, confirm with the customer in the CRM before doing anything else.';
  if (last?.state === 'SENDING')
    return `A send is in progress (reference ${last.client_ref}). Wait, then click "Check delivery". Do not resend.`;
  if (!t.draft) return 'Write a reply draft and save it.';
  const current = attempts.find(a => a.version === t.version);
  if (current?.state === 'SENT') return 'This reply was delivered. Save a new draft for any follow-up.';
  if (t.approved_version !== t.version) return 'Review the saved draft and approve it before it can be sent.';
  if (current?.state === 'FAILED')
    return 'The provider explicitly rejected this reply; nothing was delivered. It is safe to click "Send manually" again.';
  return t.owner === 'human' ? 'Approved. A human owns this ticket: click "Send manually" when ready.'
    : 'Approved and ready to send. Click "Send manually", or "Take over" to stop automation.';
}

export function ticketView(db, row) {
  const attempts = db.prepare('SELECT * FROM attempts WHERE ticket_id = ? ORDER BY id').all(row.id);
  return {
    ...row,
    approved: row.approved_version != null && row.approved_version === row.version,
    next_action: nextAction(row, attempts),
    messages: db.prepare('SELECT * FROM messages WHERE ticket_id = ? ORDER BY id').all(row.id),
    audit: db.prepare('SELECT * FROM audit WHERE ticket_id = ? ORDER BY id').all(row.id),
    attempts
  };
}

// Synthetic identities only. Treat server-side identity as authoritative.
export const actors = {
  'demo-alpha-token': { id: 'agent-alpha', tenantId: 'alpha' },
  'demo-beta-token': { id: 'agent-beta', tenantId: 'beta' }
};
