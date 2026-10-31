# Exercise contract

## Identities and fixtures

The application listens on loopback port 4300. The mock provider listens on loopback port 4301. Both are local fixtures; do not expose them to the public internet.

- `Authorization: Bearer demo-alpha-token`: agent-alpha, organization `alpha`, ticket `101`.
- `Authorization: Bearer demo-beta-token`: agent-beta, organization `beta`, ticket `202`.
- `X-Demo-Webhook-Secret: fictional-webhook-secret`: trusted mock webhook ingress.

These published values are deliberate fixture credentials, not production secrets. Do not spend the exercise replacing this authentication scheme. Scope authorization to the actor resolved on the server, not a tenant supplied by the browser. Ticket contact identity is immutable in this exercise.

## Application HTTP routes

- `GET /api/tickets`: organization's ticket list.
- `GET /api/tickets/:id`: ticket including `messages`, `attempts`, and `audit`.
- `POST /api/tickets/:id/draft` with `{ "body": "Reply text" }`: save/update draft.
- `POST /api/tickets/:id/approve` with `{}`: explicitly approve the current saved version.
- `POST /api/tickets/:id/send` with `{}`: manual dispatch of approved reply.
- `POST /api/tickets/:id/handoff` with `{}`: assign to a human.
- `POST /api/tickets/:id/automation` with `{}`: test-only trigger for a background automation dispatch. This route sets `automatic: true` server-side; it is not an LLM authorization API. It needs approval too and must respect takeover.
- `POST /api/tickets/:id/reconcile` with `{}`: resolve the last pending/uncertain attempt using provider evidence.
- `POST /webhooks/ghl` with the mock webhook secret and `{ "tenantId": "alpha", "ticketId": 101, "eventId": "event-1", "body": "Please help" }`.

Use 4xx responses for rejected actions; 403 or 404 are both acceptable for cross-organization access. Preserve routes and fixture identities. You may extend response fields or use equivalent status names if documented. Do not weaken the mock provider or bypass it to make tests pass.

## Mock provider semantics

- `POST /messages` receives `{clientRef, ticketId, body}`. A normal result is `{providerMessageId}`. Each accepted call creates a delivery. **A clientRef is a correlation value, not a provider-side deduplication guarantee.**
- HTTP 503 from this mock means **definitely not accepted**. HTTP 504 means **unknown**, even though the provider may have accepted it. A connection loss has an unknown result too.
- `GET /messages?clientRef=...` returns `{state:"delivered", providerMessageId, count}` or `{state:"not_found"}`. The latter does not prove no delivery occurred. A failed lookup is inconclusive.
- `GET /deliveries` exposes the provider's actual ledger for testing. This is a test inspection endpoint, not an application integration endpoint. It lets you distinguish the UI's claim from what the customer actually received.
- `POST /control` sets a mode: `{ "mode": "normal" }`, `accept_then_timeout`, `reject_before_accept`, or `accept_then_delay`. Delay accepts and stores the delivery first, then waits 10 seconds before responding. Use it to kill/restart the application during a send. Modes reset to normal when the provider restarts; deliveries persist.

Example to switch modes, using any HTTP client or:

```sh
curl -X POST http://127.0.0.1:4301/control -H 'Content-Type: application/json' -d '{"mode":"accept_then_timeout"}'
```

## Service adapter for the supplied Node starter

`DeskService` exposes `listTickets`, `getTicket`, `receiveWebhook`, `updateDraft`, `approveDraft`, `handoff`, `sendReply`, `reconcile`, and `close`. It accepts `{databasePath, provider}`. A provider has async `send(payload)` and `lookup(clientRef)` methods. A `send` exception may have `kind: 'not_accepted'`; any other exception is uncertain. This injectable adapter makes focused tests possible. The HTTP behavior remains the evaluation contract if you choose a different implementation.

## Simplifications to explain, not solve

Single local application process with overlapping requests; process restart; SQLite; no distributed database deployment. Initial fixture tickets already exist. No file attachments or customer-profile updates. No real model; the UI suggestion is fixed text. The reviewer will ask how these choices change for production.
