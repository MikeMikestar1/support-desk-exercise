import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const path = process.env.PROVIDER_DB || resolve('data/provider.sqlite');
mkdirSync(dirname(path), { recursive: true });
const db = new DatabaseSync(path);
db.exec(`CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY, client_ref TEXT NOT NULL, ticket_id INTEGER NOT NULL, body TEXT NOT NULL
);`);
let mode = 'normal';
const read = async req => { let b = ''; for await (const c of req) b += c; return b ? JSON.parse(b) : {}; };
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/control') {
      const b = await read(req);
      if (!['normal', 'accept_then_timeout', 'reject_before_accept', 'accept_then_delay'].includes(b.mode))
        return json(res, 400, { error: 'Unknown mode' });
      mode = b.mode; return json(res, 200, { mode });
    }
    if (req.method === 'GET' && url.pathname === '/deliveries')
      return json(res, 200, db.prepare('SELECT * FROM deliveries ORDER BY rowid').all());
    if (req.method === 'GET' && url.pathname === '/messages') {
      const matches = db.prepare('SELECT * FROM deliveries WHERE client_ref = ?').all(url.searchParams.get('clientRef'));
      return json(res, 200, matches.length ? { state: 'delivered', providerMessageId: matches[0].id, count: matches.length }
        : { state: 'not_found' });
    }
    if (req.method === 'POST' && url.pathname === '/messages') {
      const b = await read(req);
      if (!b.clientRef || !b.ticketId || !b.body) return json(res, 400, { error: 'Missing fields' });
      if (mode === 'reject_before_accept') return json(res, 503, { error: 'Explicitly not accepted' });
      const id = randomUUID();
      db.prepare('INSERT INTO deliveries VALUES (?, ?, ?, ?)').run(id, b.clientRef, b.ticketId, b.body);
      if (mode === 'accept_then_timeout') return json(res, 504, { error: 'Delivery result unavailable' });
      if (mode === 'accept_then_delay') await new Promise(r => setTimeout(r, 10000));
      return json(res, 200, { providerMessageId: id });
    }
    json(res, 404, { error: 'Not found' });
  } catch { json(res, 400, { error: 'Invalid request' }); }
});
server.listen(Number(process.env.PROVIDER_PORT || 4301), '127.0.0.1', () => console.log('Mock provider listening on loopback'));
