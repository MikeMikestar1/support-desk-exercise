import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class DeskError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

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
    INSERT OR IGNORE INTO tickets(id, tenant_id, contact, subject) VALUES
      (101, 'alpha', 'Jordan Demo', 'Cannot resume my practice exam'),
      (202, 'beta', 'Casey Example', 'Course completion is missing');
  `);
  return db;
}

export function record(db, id, action, detail) {
  db.prepare('INSERT INTO audit(ticket_id, action, detail) VALUES (?, ?, ?)')
    .run(id, action, detail);
}

export function ticketView(db, row) {
  return {
    ...row,
    messages: db.prepare('SELECT * FROM messages WHERE ticket_id = ? ORDER BY id').all(row.id),
    audit: db.prepare('SELECT * FROM audit WHERE ticket_id = ? ORDER BY id').all(row.id),
    attempts: db.prepare('SELECT * FROM attempts WHERE ticket_id = ? ORDER BY id').all(row.id)
  };
}

// Synthetic identities only. Treat server-side identity as authoritative.
export const actors = {
  'demo-alpha-token': { id: 'agent-alpha', tenantId: 'alpha' },
  'demo-beta-token': { id: 'agent-beta', tenantId: 'beta' }
};
