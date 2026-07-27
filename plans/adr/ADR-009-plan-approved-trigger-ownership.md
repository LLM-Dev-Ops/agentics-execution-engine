# ADR-009: Plan-Approved Trigger Ownership and Working Event Subscription

**Status:** Proposed
**Date:** 2026-07-27
**Deciders:** Agentics Platform Team
**Scope:** agentics-execution-engine
**SPARC Phase:** Phase 4

> See **ADR-011: Layer-4 Execution Spine Reconnection** in `agentics-enforcement`
> (`plans/adr/ADR-011-layer-4-execution-spine-reconnection.md`) for the platform-wide
> decision this ADR implements. This document covers only this repository's actions.

---

## Context

This engine's event-driven trigger path cannot fire. Two independent defects, plus an
unresolved ownership conflict with `agentics-orchestration-engine`.

### `subscribe()` discards the handler

`src/ruvector_client.ts:39-52`:

```ts
async subscribe(event: string, handler: (payload: unknown) => void): Promise<void> {
  const url = `${this.serviceUrl}/v1/subscribe`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { /* ... */ },
    body: JSON.stringify({ client_id: this.clientId, event }),
  });
  if (!res.ok) {
    throw new Error(`Ruvector subscribe failed: ${res.status} ${res.statusText}`);
  }
}
```

The `handler` parameter is **never stored, never registered, and never invoked**. The class
has no handler map — its only fields are `serviceUrl`, `apiKey`, `clientId` and `connected`
(`:8-11`). There is no polling loop, no SSE reader, and no inbound HTTP route anywhere in the
repo. The POST body does not even carry a callback URL, so Ruvector has no way to reach back.

The call is a fire-and-forget HTTP POST whose response is checked and then dropped.

### Therefore the entire dispatch path is unreachable

`src/execution_listener.ts:24-29` registers `handlePlanApproved` for `plan_approved`. Because
`subscribe()` never invokes handlers, `handlePlanApproved` (`:47`) never runs — and with it
`this.dispatcher.dispatchExecution(intent)` (`:64`), the publication of `execution_started`
(`:56`) and `execution_completed` (`:67`), and every downstream core dispatch.

This engine's charter — ADR-002 (topological batch dispatch) and ADR-006 (execution graph
always produced) — is never exercised via the event path.

### Payload shape mismatch would break it even if subscription worked

`src/execution_listener.ts:50-52` casts the payload directly to `ExecutionIntent` and keys on
`intent.intent_id`. But `agentics-orchestration-engine/src/server.ts:737-743` publishes the
envelope `{ type, runId, source, timestamp, payload }` — no `intent_id` at the top level. Every
event would fall into the `plan_approved payload missing intent_id, skipping` branch at `:52`.

A third shape exists: `agentics-orchestration-engine/src/ruvector/types.ts:104-116` defines
`PlanApprovedEvent` keyed on `simulation_id`, with a type guard at `:265-269`. Three
incompatible shapes share one event name.

### Duplicate subscription with no arbitration

Both engines subscribe to `plan_approved`:

- here — `src/execution_listener.ts:24`
- `agentics-orchestration-engine/src/ruvector/client.ts:420-421` — `url.searchParams.set('types', 'plan_approved')`, consumed by its `src/ruvector/execution-listener.ts:230` and deployed as its own service (its `README.md:93`)

Nothing documents which one is authoritative. Today the conflict is masked because this
engine's subscription is dead — repairing it without resolving ownership would create
**double dispatch** of every approved plan.

### Self-subscription

`src/execution_listener.ts:31-36` subscribes to `execution_started`, which this same class
publishes at `:56`. The service listens to its own output; `handleExecutionStarted` (`:83`)
only logs.

## Decision

**`agentics-execution-engine` is the sole subscriber to `plan_approved`.**
`agentics-orchestration-engine` will neither publish nor subscribe to it (ADR-011 Decision 5).

This engine owns the trigger because `plan_approved` means "produce an execution graph and
dispatch it" — precisely this repo's chartered role under ADR-002 and ADR-006.
orchestration-engine is currently the event's *publisher*, so it cannot also be its
subscriber without a self-trigger loop; its remaining role is synchronous `/v1/simulate` core
delegation, which needs no subscription.

**`subscribe()` is reimplemented as authenticated long-poll** (ADR-011 Decision 7), mirroring
the pattern already working in `agentics-orchestration-engine/src/ruvector/client.ts:412-435`
(`GET /events/decisions` with an `after` cursor and a `types` filter). Long-poll needs no
inbound ingress on this service and no new Ruvector callback-registration API — both of which
a webhook approach would require.

**Payloads are validated against the canonical envelope** `events/v1/plan-approved.schema.json`
(owned by `agentics-contracts`, ADR-011 Decision 6) instead of being cast to `ExecutionIntent`.
Correlation keys on the Ruvector-minted `execution_id` per `agentics-enforcement` ADR-004.

## Consequences

### Easier

- The event-driven path works for the first time; `dispatchExecution` becomes reachable, so ADR-002 and ADR-006 are exercised in production rather than only in tests.
- Sole ownership removes the double-dispatch race that repairing the subscription would otherwise introduce.
- Schema validation turns silent skips into loud, diagnosable rejections. The `skipping` log at `src/execution_listener.ts:52` currently swallows every malformed event indistinguishably from an empty queue.
- Keying on `execution_id` aligns the trace tree with ADR-004 and this repo's ADR-004 (append-only execution trace).

### Harder

- **Load appears where there was none.** This engine has never dispatched a real event-driven execution. Expect the first real traffic to surface latent bugs in `ExecutionDispatcher` and in core resolution (ADR-001, ADR-003).
- Long-poll adds sustained request volume against ruvector-service and requires cursor persistence, backoff, and lifecycle management that fire-and-forget did not.
- At-least-once delivery becomes possible on cursor loss or retry, so `dispatchExecution` must be idempotent on `execution_id` — it is not today.
- This repo gains a hard dependency on the `agentics-contracts` schema package.
- Coordinated release: orchestration-engine must stop publishing the ad-hoc envelope in the same window this engine starts validating the canonical one.

## Implementation Plan

1. In `src/ruvector_client.ts`, add a `private handlers = new Map<string, Array<(payload: unknown) => void>>()` field alongside the existing `serviceUrl` / `apiKey` / `clientId` / `connected` fields (`:8-11`).
2. Rewrite `subscribe()` (`:39-52`) to register the handler in that map and start the poll loop on first subscription. Keep the `POST /v1/subscribe` registration call for server-side bookkeeping, but stop treating it as the delivery mechanism.
3. Implement the poll loop: `GET ${serviceUrl}/events/decisions` with `after=<lastEventId>`, `types=<subscribed events>` and `client_id`, modelled on `agentics-orchestration-engine/src/ruvector/client.ts:412-435`. Persist the cursor so a restart does not replay from the beginning.
4. Add exponential backoff on poll failure and a `stop()` method to cancel the loop; wire `stop()` into `ExecutionListener.stop()` (`src/execution_listener.ts:39-41`), which currently only flips the `running` flag without cancelling anything.
5. In `src/execution_listener.ts:47-54`, replace the `payload as ExecutionIntent` cast with validation against `events/v1/plan-approved.schema.json`. Reject non-conforming events with an explicit error naming the offending field, rather than the generic `skipping` log at `:52`.
6. Key correlation on `execution_id` from the canonical envelope and map `intent_id` from it; do not read `intent_id` from the payload root.
7. Make `ExecutionDispatcher.dispatchExecution` idempotent on `execution_id` — return the existing graph on a repeat rather than re-dispatching. Required because long-poll is at-least-once.
8. Remove the `execution_started` self-subscription at `src/execution_listener.ts:31-36` and the now-unused `handleExecutionStarted` (`:83-85`). This service publishes that event at `:56`; it should not consume it.
9. Add a startup assertion that `RUVECTOR_SERVICE_URL` and the API key are configured; fail closed rather than starting a listener that can never receive.

## Verification

1. **Handlers are actually invoked.** Unit test: call `subscribe('plan_approved', handler)` against a fake Ruvector returning one event; assert `handler` is invoked within one poll interval. **The current implementation never invokes it, so this test fails today** — it is the regression test for this ADR.
2. **Dispatch is reachable.** Integration test: feed one canonical `plan_approved` event and assert `ExecutionDispatcher.dispatchExecution` was called and an execution graph was produced (ADR-006).
3. **Idempotency.** Deliver the same `execution_id` twice; assert exactly one dispatch and one execution graph.
4. **Schema conformance.** The canonical fixture is accepted. Each of the three legacy shapes — the `{type, runId, source, timestamp, payload}` envelope from `agentics-orchestration-engine/src/server.ts:737-743`, the `simulation_id`-keyed `PlanApprovedEvent`, and a bare `ExecutionIntent` — is rejected with an explicit field-level error.
5. **Sole subscriber.** `grep -rn "plan_approved" --exclude-dir=node_modules /workspace/agentics-dev` shows subscription only in this repo and publication only from ruvector-service; no hits under `agentics-orchestration-engine/src/`.
6. **No self-subscription.** `grep -n "subscribe('execution_started'" src/execution_listener.ts` returns nothing.
7. **Clean shutdown.** `ExecutionListener.stop()` terminates the poll loop; assert no outbound requests after `stop()` resolves.
8. **Trace continuity.** An end-to-end `agentics simulate` run yields one Ruvector-minted `execution_id` whose span tree includes this engine's dispatch spans and at least one real Layer-3 core span, satisfying `agentics-enforcement` ADR-009 and this repo's ADR-005 (mandatory evidence validation).

## Compliance

- **ADR-002** (topological batch dispatch) — becomes reachable via the event path for the first time.
- **ADR-004** (append-only execution trace) — trace entries key on the Ruvector-minted `execution_id`.
- **ADR-005** (mandatory evidence validation) — dispatch is triggered by a schema-validated event, not an unchecked cast.
- **ADR-006** (execution graph always produced) — enforced for event-triggered executions, previously unreachable.
- **ADR-008** (transport and security) — long-poll reuses the authenticated transport already defined here.
- **agentics-enforcement ADR-004** (execution ID minting authority) — this engine consumes, never mints, `execution_id`.
