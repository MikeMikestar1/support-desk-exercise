# Handoff

Node.js 24+ is required (verified on 26.13.0). There are no dependencies. `npm test` runs all 28 tests, about 1 s, from a clean checkout. To run the app: `npm run provider`, then `npm start`, then open http://127.0.0.1:4300. Both processes store their data in `data/`, which git ignores.

## Changes and ownership (all completed; nothing here is only proposed)

| # | Defect found in the starter | Fix |
|---|---|---|
| 1 | A webhook replay added another message every time (8 parallel replays gave 8 messages). There was no transaction. | New `inbound_events` table with `PRIMARY KEY (tenant_id, event_id)`. The event row, the message and the audit row are written in one `BEGIN IMMEDIATE` transaction. A replay returns `200 {duplicate:true}` and changes nothing. Webhook secret is compared in constant time. |
| 2 | `row()` ignored the organization, so Alpha could read, edit, approve, send or take over ticket 202. | Every ticket lookup is `WHERE id = ? AND tenant_id = actor.tenantId` (404 otherwise). The organization comes only from the server-side token. A `tenantId` in the body or query is ignored. Tokens such as `Bearer constructor` no longer resolve to a prototype object (`Object.hasOwn`). |
| 3 | Editing an approved draft kept the approval. Send only checked `approved_version != null`. | Saving a draft clears `approved_version`. Send requires `approved_version === version`. `approve` accepts an optional `{version}` and returns 409 if the draft changed since the operator read it, and the UI sends that version. Automation needs the same approval. |
| 4 | Double click or overlapping sends delivered twice. A failure was **retried automatically with a new clientRef** (a timeout became two customer messages), then shown as `SENT` without evidence. `reconcile` returned 501. | Send is claim, then call, then settle. The claim (one transaction, before any network I/O) checks approval, takeover and unresolved attempts, and inserts the `attempts` row (`UNIQUE(ticket_id, version)`) as `SENDING` with a new `clientRef`. One provider call, never retried. Outcomes: `SENT` (with provider id), `FAILED` (HTTP 503 only, can be sent again), or `UNKNOWN` (504, timeout, connection loss, missing id). On startup, `SENDING` rows left by a crashed process become `UNKNOWN`, never resent. `reconcile` looks up the clientRef. Only `delivered` resolves it to `SENT`. `not_found` and lookup errors leave it `UNKNOWN` and are audited. Send and draft edits return 409 while an attempt is unresolved. |
| 5 | Takeover had no effect on automation. | Inside the claim transaction, automatic dispatch on a `human`-owned ticket is refused (409 plus an `automation_refused` audit entry). An approved human reply still sends. |
| 6 | The UI showed raw JSON and gave no guidance. | The server computes `approved` and `next_action`. The UI shows owner, draft/approval version, delivery state, an inbound/outbound conversation, attempts with clientRef, and a readable audit trail. All server text goes in via `textContent` (tested with an `<img onerror>` payload). Approve is refused while the text box has unsaved edits. |

Also: provider calls time out (send 15 s, lookup 5 s), which gives `UNKNOWN`. Unexpected errors return a generic 500 instead of internal messages. The server shuts down cleanly on SIGINT. Every schema change adds a new table, so existing `data/` databases still open.

## Verification

* `npm test`: **28 passing, 0 failing** (Node 26.13.0, Windows). `test/service.test.mjs` (17) tests the injectable `DeskService` with a fake provider. `test/http.test.mjs` (9) starts the **real server and real mock provider** as child processes on free ports with temporary databases, and checks the provider's `/deliveries` ledger rather than the UI's claim. Plus the 2 original smoke tests.
* **Fails before, passes after:** I committed the starter unchanged (`d01aec3`), then ran the first 25 tests against it: 18 failed (8 parallel replays → 8 messages, 200 instead of 404 across organizations, `DRAFT`/`SENT` instead of `UNKNOWN`, 2 provider calls instead of 1). Output is in `docs/test-run-before-fix.txt`.
* End-to-end cases covered: overlapping replays, the same event ID in both organizations, replay after restart, rollback when a write fails (a trigger forces it), forged `tenantId`, `accept_then_timeout` → reconcile, **killing the app during `accept_then_delay` and restarting it** (state `UNKNOWN`, resend refused, reconcile → `SENT`, ledger = 1), `reject_before_accept` → `FAILED` → safe resend, provider down → `UNKNOWN`, failed lookup and `not_found` both leave it `UNKNOWN` (ledger = 0), and takeover plus 5 parallel sends → 1 delivery.
* **Manual only:** a browser walk-through of ticket 101 (event replayed twice, XSS payload, suggest → save → approve → send in timeout mode → resend refused → Check delivery → `SENT`, provider ledger = 1). I did not test the UI in a second browser or on mobile.

## Operator instructions

* **`UNKNOWN`** means we handed the reply to the provider but have no proof either way. The customer **may already have it**.
* **Do:** click **Check delivery**. If the provider confirms the same reference, the ticket becomes `SENT` with the provider's message id. A notice and the "Next safe action" box always say what to do.
* **Don't:** resend, rewrite the draft, or send the same answer through another channel. The desk enforces this with 409.
* **If it stays `not_found`:** that is not proof it was not delivered (the provider may lag). Wait and check again. Then confirm in the CRM conversation or with the customer. There is **no in-app override yet** (see risks).
* **`FAILED`** means the provider explicitly refused it before accepting it. Nothing was delivered, so it is safe to click Send again.
* **After a restart**, an interrupted send shows as `UNKNOWN` and an audit entry explains it. Nothing is resent automatically.

## Remaining risks and production plan (this is not production-ready)

* **No manual resolution of a permanent `UNKNOWN`.** A ticket whose provider never confirms stays blocked. Next fix: a "mark resolved / not delivered" action that requires a reason and a second approver, is audited, and only then allows a new version to be sent.
* Single process and SQLite. Correctness relies on SQLite constraints plus synchronous transactions. Several app instances on a shared database would need row locks or a queue and a lease on `SENDING` (startup recovery currently assumes a single process).
* Fixture authentication (static bearer tokens, a shared webhook secret, no HMAC or timestamp to stop replayed signatures, no rate limiting). No CSRF protection is needed because the API uses bearer tokens, not cookies. No CSP header. Audit rows are not tamper-evident. Retrying a FAILED attempt reuses its row (the old clientRef remains in the audit trail only).
* Real GHL pilot, first checks: confirm the real API's idempotency and lookup semantics (does it deduplicate on a client reference, how quickly it becomes searchable, which status codes mean "not accepted"). Verify webhook signatures, event-ID uniqueness and tenant (location) mapping. Run the timeout, crash and replay tests in a sandbox location. Monitor counts of `UNKNOWN`, `FAILED` and `automation_refused` and their age, and alert on any `count > 1` for a clientRef. Roll out behind a per-organization flag with automation off. Rollback means turning automation off (human takeover), and the audit trail is the handoff record.

## AI use and time

* **Tools:** Claude Code (Anthropic Claude, in the Claude desktop app) generated the code, tests and this document. I reviewed the changes, and Node's built-in test runner plus a manual browser check verified them.
* **A suggestion I changed:** the first plan let an agent edit the draft while a delivery was `UNKNOWN`. Saving a draft resets `send_state` to `DRAFT`, which would hide the uncertain delivery and allow a second, different reply. I changed it to refuse draft edits (409) until the attempt is resolved. This is covered by the "restart during send" and "connection loss" tests and by `next_action`.
* **A suggestion I rejected:** keeping the starter's two-attempt retry loop with a single reused clientRef. The contract says clientRef is not deduplicated by the provider, so any automatic retry after an uncertain result can double-send.
* **Approximate time spent:** about 1 hour in total on 31 Oct 2026 (Pacific time): about 30 minutes in one AI-assisted session (setup, including installing Node and Git, plus implementation, tests and this handoff), and about 30 minutes of my own reading and review of the code.
