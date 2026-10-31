import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DeskService } from './service.mjs';
import { ProviderClient } from './provider-client.mjs';
import { actors, DeskError } from './store.mjs';

const service = new DeskService({ databasePath: process.env.DESK_DB || resolve('data/desk.sqlite'),
  provider: new ProviderClient(process.env.PROVIDER_URL) });
const read = async req => {
  let body = '';
  for await (const chunk of req) {
    body += chunk; if (body.length > 100000) throw new DeskError(413, 'Body too large');
  }
  try { return body ? JSON.parse(body) : {}; } catch { throw new DeskError(400, 'Invalid JSON'); }
};
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url))));
    }
    if (req.method === 'POST' && url.pathname === '/webhooks/ghl') {
      if (req.headers['x-demo-webhook-secret'] !== 'fictional-webhook-secret') throw new DeskError(401, 'Invalid webhook secret');
      return json(res, 200, service.receiveWebhook(await read(req)));
    }
    const actor = actors[(req.headers.authorization || '').replace(/^Bearer /, '')];
    if (!actor) throw new DeskError(401, 'Sign in using a demo identity');
    if (req.method === 'GET' && url.pathname === '/api/tickets') return json(res, 200, service.listTickets(actor));
    const match = url.pathname.match(/^\/api\/tickets\/(\d+)(?:\/(draft|approve|send|automation|handoff|reconcile))?$/);
    if (!match) throw new DeskError(404, 'Not found');
    const id = Number(match[1]), action = match[2];
    if (req.method === 'GET' && !action) return json(res, 200, service.getTicket(actor, id));
    if (req.method !== 'POST') throw new DeskError(405, 'Method not allowed');
    const b = await read(req);
    let result;
    switch (action) {
      case 'draft': result = service.updateDraft(actor, id, b.body); break;
      case 'approve': result = service.approveDraft(actor, id); break;
      case 'handoff': result = service.handoff(actor, id); break;
      case 'send': result = await service.sendReply(actor, id); break;
      case 'automation': result = await service.sendReply(actor, id, { automatic: true }); break;
      case 'reconcile': result = await service.reconcile(actor, id); break;
      default: throw new DeskError(404, 'Not found');
    }
    json(res, 200, result);
  } catch (e) { json(res, e.status || 502, { error: e.message }); }
});
server.listen(Number(process.env.PORT || 4300), '127.0.0.1', () => console.log('Support desk: http://127.0.0.1:' + (process.env.PORT || 4300)));
process.on('SIGTERM', () => server.close(() => { service.close(); process.exit(); }));
