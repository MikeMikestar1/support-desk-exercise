# JustInsurance support-desk work sample

You are inheriting a small, unfinished support inbox. Make one customer-support workflow safe and usable. This is fictional assessment software. It uses synthetic data and is not work on our production system.

## Format and time limit

- Up to **3 hours of implementation**. Candidates selected to advance will have a **45-minute live walkthrough and change**. Stop at the limit and explain remaining work; do not hide extra hours. If setup blocks you, tell us before spending more than 20 minutes on it; setup assistance does not count against implementation time.
- **This assessment is unpaid.** Confirm that you are comfortable with these terms before starting. Participation does not guarantee an interview or a job offer. If you previously received a paid invitation, resolve those earlier terms with the recruiter before starting or continuing; this document does not silently replace an accepted paid arrangement.
- AI assistants, documentation, search, and your usual editor are allowed throughout. You may ask AI to generate, review, or debug code. You must understand and be able to change everything you submit. Do not delegate the assessment to another person.
- No paid AI subscription, real customer data, production credentials, HighLevel account, cloud deployment, or external message delivery is required.
- Same starter, requirements, time allowance, and core evaluation for every candidate. Clarifications that change the specification will be shared with everyone.

## Business context

JustInsurance needs a support desk connected to a CRM before its later exam, SCORM, and tutoring projects. Support agents must see their own customers' conversations, prepare replies, approve the exact text, and understand whether a message was actually delivered. Once a person takes over a conversation, automation must stop sending new replies.

This sample uses two fictional customer organizations, Alpha and Beta. They must never access each other's tickets. The mock provider is **GHL-like, not a specification or implementation of HighLevel's real API**. Judge behavior against the contract in `CONTRACT.md`, not assumptions about an external service.

## Run the starter

Use Node.js **24 or newer** (built-in SQLite). No npm dependencies or installation are needed. From this directory:

1. Terminal A: `npm run provider`
2. Terminal B: `npm start`
3. Open `http://127.0.0.1:4300`.
4. Terminal C: `npm run event` — run it twice to replay the same inbound event.
5. Run the two baseline tests with `npm test`.

The starter intentionally passes only simple smoke tests. **Green baseline tests do not mean the application meets the requirements.** You are expected to change application code and add meaningful tests. You may edit any application file. Preserve the public HTTP contract and provider semantics. You may use TypeScript or an alternative backend language if you prefer; document an equally simple run command and keep the same observable behavior. Framework migration and visual polish earn no extra credit.

SQLite files persist in `data/`. Stopping and starting the app must retain state. For a fresh local fixture, stop both processes, remove only this exercise's `data/` directory, then restart. Do not reset state to demonstrate restart recovery.

## Required behavior

1. **Safe inbound delivery.** A webhook replay must not create a second customer message or repeat its business effect, including overlapping requests and application restarts. Event identity is scoped to the organization: Alpha and Beta may both receive an event called `event-1`. The event write and its business change must succeed or fail together. Reject invalid webhook authentication.
2. **Customer isolation.** The authenticated server-side identity controls organization access. Guessing another ticket ID or adding a different `tenantId` to a request must not allow reading or changing that ticket, its messages, audit history, approval, ownership, or delivery. Do not fix this only by hiding UI controls.
3. **Exact approval.** A saved draft needs explicit human approval before it can be sent. Editing it invalidates that approval. A repeated click or overlapping send request must not send the same approved version twice. AI-generated text has no special authority.
4. **Honest delivery and recovery.** The provider may accept a message but return a timeout. Do not automatically resend an uncertain delivery or call it sent without evidence. Persist an operator-visible `UNKNOWN` (or equivalent) state and a reference that can be reconciled. A restart after recording an attempt must not cause a second send. Allow the operator to check delivery; when the provider confirms the same attempt was delivered, resolve it without resending. A provider `not_found` response is inconclusive and must not authorize a blind retry. A documented, explicit rejection before acceptance can be shown as a safe failure; a sophisticated retry scheduler is not required.
5. **Human takeover.** Once takeover commits, a new automation dispatch must be refused by server-side code. The human agent can still send a properly approved reply. You do not need to recall a message already dispatched before takeover.
6. **Usable handoff.** The supplied inbox must show conversation, owner, current draft/approval, delivery status, and an audit trail that explains significant actions and unresolved failures. A support agent should know the next safe action. Keep untrusted customer text rendered as text, not executable HTML.

All behavior above is in scope for evaluation. We may vary IDs, timing, event bodies and request order; there are no undisclosed feature requirements. If you cannot finish, submit working progress and explicitly identify the risk and next fix. A smaller honest implementation is preferable to unsupported claims of production readiness.

## Submission

Return a source ZIP or private repository with:

- Your changes and tests, with commands to start and test from a clean checkout. Exclude `data/`, real secrets and dependency folders.
- `HANDOFF.md`, at most two pages: what you fixed; exact checks run and results; remaining limitations; how an operator handles uncertain delivery; and how you would verify the real GHL integration before rollout.
- A short AI-use note: which tools you used, one suggestion you accepted or changed, and how you verified it. If there was no rejected suggestion, say so. We do not require private prompt history, account access, or AI-detector scores.
- Your approximate time spent. Commit history is welcome but not proof of authorship.

The live session includes showing a failure before a fix, tracing code and database state, and implementing one small change to the same workflow with AI allowed. We assess reasoning, verification, communication, and ownership—not typing speed or memorized syntax.

## What is not required

Do not build a full CRM, actual GHL OAuth, production authentication, a real LLM integration, SCORM, an avatar tutor, billing, analytics, or a cloud deployment. Explain any production limitations rather than trying to solve the entire roadmap in three hours.
