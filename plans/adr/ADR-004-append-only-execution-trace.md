# ADR-004: Append-Only Execution Trace

**Status:** Accepted
**Date:** 2026-02-09
**Deciders:** Reuven Cohen
**References:** SPARC-specification.md NFR-5, NFR-7, Section 3.4

---

## Context

The engine must record everything that happens during an execution for debugging, auditing, and graph construction. The recording mechanism must satisfy two hard requirements:

- **NFR-5**: All traces must be immutable and append-only.
- **NFR-7**: Failed executions must retain full trace.

Several models were considered:

1. **Mutable state object** — a single `ExecutionState` struct that is updated as phases complete.
2. **Event sourcing** — an append-only log of immutable events from which state is derived.
3. **Write-ahead log** — events written to persistent storage before being applied.

## Decision

**Use an in-memory, append-only event log (event sourcing pattern).** The `ExecutionTrace` class maintains a `TraceEvent[]` array that is only ever appended to. No event is ever modified or deleted after creation.

### Event Structure

```
TraceEvent {
  event_id:      string       // Unique, generated at creation
  execution_id:  string       // Correlates all events in one execution
  event_type:    string       // Enumerated type (see below)
  timestamp:     string       // ISO 8601, captured at creation
  data:          frozen object // Deep-frozen snapshot, never mutated
}
```

### Event Types

| Event Type | Emitted When | Data Contents |
|------------|-------------|---------------|
| `EXECUTION_STARTED` | Intent accepted, trace created | Full intent snapshot |
| `CORE_DISPATCHED` | Core dispatch initiated | core_name, version, endpoint |
| `CORE_COMPLETED` | Core returns result (any status) | core_name, status, counts, duration |
| `CORE_FAILED` | Core fails or times out | core_name, error code, message |
| `EVIDENCE_VALIDATED` | Evidence validation complete | required/provided/missing counts |
| `EXECUTION_COMPLETED` | Graph built, execution done | final status |
| `EXECUTION_FAILED` | Execution marked as failed | reason |

### Immutability Enforcement

- The `data` field of every event is `Object.freeze()`'d at creation time (deep freeze).
- The `events` array is encapsulated as `private readonly`. The class exposes no method to modify or remove events.
- The `toNodes()` and `toEdges()` methods produce new arrays derived from events — they never modify the source.

### Graph Derivation

The execution graph is a **pure projection** of the trace:

```
TraceEvent[]  ──► toNodes() ──► ExecutionNode[]
TraceEvent[]  ──► toEdges() ──► ExecutionEdge[]
```

This means the graph is always consistent with the trace. There is no separate graph state that could diverge.

## Consequences

### Positive

- **Immutability guarantee.** No code path can alter historical events. Satisfies NFR-5.
- **Full trace on failure.** Since events are never deleted, a failed execution retains every event up to the failure point. Satisfies NFR-7.
- **Debuggability.** The event log is a complete, ordered narrative of what happened.
- **Graph consistency.** The graph is derived from the trace, not maintained separately. No divergence possible.
- **Concurrency safe.** Append-only arrays are inherently safe for single-writer scenarios. For multi-writer (parallel dispatch), events are appended with timestamps and sorted during graph construction.

### Negative

- **Memory growth.** The event array grows linearly with execution complexity. For typical executions (< 100 events), this is negligible. For pathological cases (thousands of Cores), memory usage should be monitored.
- **No streaming.** The graph is built after all events are collected, not incrementally. Acceptable for v1 given the < 10ms graph construction target.

### Neutral

- Events are in-memory only for v1. Persistence to a durable store (for post-mortem analysis) is out of scope but the append-only design makes it trivial to add a persistence sink later.

## Alternatives Considered

### Mutable State Object

Rejected. Mutation makes it impossible to guarantee that the trace at time T is still accurate at time T+1. Debugging becomes harder when state is overwritten rather than accumulated. Violates NFR-5.

### Write-Ahead Log (Persistent)

Considered for future. Adds I/O to the critical path, which conflicts with the < 500ms overhead target (NFR-3). The in-memory approach achieves the same logical guarantees without persistence overhead. Persistence can be layered on top via an event sink.

## Compliance

- **NFR-5**: "All traces must be immutable and append-only." — enforced by deep freeze and private encapsulation.
- **NFR-7**: "Failed executions must retain full trace." — append-only means nothing is lost on failure.
- **CLAUDE.md**: "Use event sourcing for state changes." — trace events are the source of truth; graph is derived.
