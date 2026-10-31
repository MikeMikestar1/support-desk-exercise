const event = { tenantId: 'alpha', ticketId: 101, eventId: process.argv[2] || 'event-demo-1',
  body: 'I lost my place in the practice exam. Can a person help me?' };
const r = await fetch((process.env.DESK_URL || 'http://127.0.0.1:4300') + '/webhooks/ghl', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Demo-Webhook-Secret': 'fictional-webhook-secret' },
  body: JSON.stringify(event)
});
console.log(r.status, await r.text());
if (!r.ok) process.exitCode = 1;
