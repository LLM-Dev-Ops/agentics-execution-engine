# Domain-Driven Design: Bounded Contexts

**Service:** Agentics Execution Engine
**Date:** 2026-02-09
**References:** SPARC-specification.md, ADR-001 through ADR-008

---

## Overview

The Agentics Execution Engine is decomposed into four bounded contexts, each owning a distinct slice of the domain. Contexts communicate through well-defined interfaces and shared value objects.

```
┌─────────────────────────────────────────────────────────┐
│                  Execution Engine                        │
│                                                         │
│  ┌──────────────┐   ┌──────────────┐                   │
│  │  Execution    │   │    Core      │                   │
│  │  Context      │──►│  Resolution  │                   │
│  │              │   │  Context     │                   │
│  └──────┬───────┘   └──────────────┘                   │
│         │                                               │
│         ▼                                               │
│  ┌──────────────┐   ┌──────────────┐                   │
│  │  Tracing      │   │  Evidence    │                   │
│  │  Context      │◄──│  Context     │                   │
│  └──────────────┘   └──────────────┘                   │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## Context 1: Execution Context

**Responsibility:** Owns the lifecycle of an execution from intent acceptance to graph output.

**Module:** `execution_dispatcher.ts`

### Aggregate Root

**ExecutionRun** — the central aggregate. One ExecutionRun exists per intent. It orchestrates phases, coordinates with other contexts, and produces the final ExecutionGraph.

```
ExecutionRun (Aggregate Root)
├── execution_id:    string           [Identity]
├── intent:          ExecutionIntent   [Value Object, immutable]
├── status:          ExecutionStatus   [Enum: pending, running, completed, partial_failure, failed]
├── resolved_cores:  ResolvedCore[]    [from Core Resolution Context]
├── core_results:    Map<string, CoreExecutionResult>
├── trace:           ExecutionTrace    [from Tracing Context]
├── evidence_summary: EvidenceSummary  [from Evidence Context]
└── graph:           ExecutionGraph    [produced at end of lifecycle]
```

### Entities

None. The ExecutionRun is the only entity. All other objects within this context are value objects.

### Value Objects

| Value Object | Description | Immutable |
|-------------|-------------|-----------|
| `ExecutionIntent` | The declarative input. Never modified after acceptance. | Yes |
| `CoreRequirement` | A single Core requirement within the intent. | Yes |
| `EvidencePolicy` | The caller's evidence enforcement preferences. | Yes |
| `ExecutionGraph` | The final output DAG. Produced once, never modified. | Yes |
| `ExecutionNode` | A node in the graph. | Yes |
| `ExecutionEdge` | An edge in the graph. | Yes |

### Domain Events

| Event | Trigger | Payload |
|-------|---------|---------|
| `ExecutionStarted` | Intent validated and accepted | `{ execution_id, intent }` |
| `ExecutionCompleted` | Graph produced, all phases done | `{ execution_id, status, graph }` |
| `ExecutionFailed` | Unrecoverable error or evidence failure | `{ execution_id, reason, graph }` |

### Invariants

1. An ExecutionRun MUST have exactly one intent.
2. No dispatch may occur before intent validation passes.
3. The execution graph MUST be produced regardless of outcome.
4. Status transitions: `pending → running → {completed | partial_failure | failed}`. No backward transitions.

### Dependencies on Other Contexts

- **Core Resolution Context** — to resolve and dispatch to Cores.
- **Tracing Context** — to record events and derive the graph.
- **Evidence Context** — to validate evidence after dispatch.

---

## Context 2: Core Resolution Context

**Responsibility:** Resolves Core names to service endpoints via `agentics-contracts`. Dispatches HTTP requests to resolved Cores. Owns the Core resolution cache.

**Module:** `core_adapter.ts`

### Aggregate Root

**CoreRegistry** — a singleton adapter to the `agentics-contracts` registry. Owns the resolution cache and dispatch logic.

```
CoreRegistry (Aggregate Root / Service)
├── registry_endpoint: string
├── cache:             Map<string, CachedResolution>
├── retry_policy:      RetryPolicy
└── http_client:       HttpClient
```

### Entities

**CachedResolution** — a cache entry with TTL.

```
CachedResolution (Entity)
├── cache_key:     string          [Identity: "${core_name}:${version_constraint}"]
├── resolved_core: ResolvedCore
├── cached_at:     timestamp
├── ttl_ms:        number
└── is_expired():  boolean
```

### Value Objects

| Value Object | Description | Immutable |
|-------------|-------------|-----------|
| `ResolvedCore` | The result of resolving a Core: name, version, endpoint, capabilities, contract_hash. | Yes |
| `CoreRequest` | The HTTP request payload sent to a Core endpoint. | Yes |
| `RetryPolicy` | Configuration for retry behavior. | Yes |

### Domain Events

| Event | Trigger | Payload |
|-------|---------|---------|
| `CoreResolved` | Core successfully resolved from registry | `{ core_name, version, endpoint }` |
| `CoreResolutionFailed` | Core not found or version mismatch | `{ core_name, version_constraint, reason }` |
| `CoreDispatched` | HTTP request sent to Core | `{ core_name, endpoint }` |
| `CoreResponseReceived` | Core returned a result | `{ core_name, status, duration_ms }` |
| `CoreDispatchRetried` | Transient failure, retrying | `{ core_name, attempt, delay_ms }` |
| `CacheHit` | Resolved from cache | `{ core_name, cached_at }` |
| `CacheEvicted` | Entry evicted (TTL or hash mismatch) | `{ core_name, reason }` |

### Invariants

1. Resolution MUST go through `agentics-contracts`. No direct endpoint construction.
2. Resolved endpoints MUST use HTTPS.
3. Contract hash MUST be present on every ResolvedCore.
4. Retries apply ONLY to transient errors (`REGISTRY_UNAVAILABLE`, `CONNECTION_FAILED`).
5. Cache entries are evicted on TTL expiry or contract hash mismatch.

### Anti-Corruption Layer

The `CoreAdapter` serves as the anti-corruption layer between the Execution Context and external Core services. It:

- Translates internal `CoreRequirement` into HTTP requests.
- Translates HTTP responses into `CoreExecutionResult` value objects.
- Validates response shape before passing results upstream.
- Isolates the Execution Context from transport-level concerns (timeouts, retries, connection management).

---

## Context 3: Tracing Context

**Responsibility:** Records an immutable, append-only log of all events during execution. Derives graph nodes and edges from the event stream.

**Module:** `execution_trace.ts`

### Aggregate Root

**ExecutionTrace** — an append-only event log scoped to a single execution.

```
ExecutionTrace (Aggregate Root)
├── execution_id:  string        [Identity]
├── intent_id:     string        [Correlation]
├── events:        TraceEvent[]  [Append-only, never modified]
├── status:        TraceStatus   [open | sealed]
└── sealed_at:     timestamp?    [Set when graph is built]
```

### Entities

None. TraceEvents are value objects, not entities. They have IDs for correlation but are immutable after creation.

### Value Objects

| Value Object | Description | Immutable |
|-------------|-------------|-----------|
| `TraceEvent` | A single recorded event: { event_id, execution_id, event_type, timestamp, data }. | Yes (deep frozen) |

### Domain Events

The Tracing Context *records* events from other contexts but does not emit its own domain events externally. It is a pure recording mechanism.

Internally, the act of appending a TraceEvent IS the event. The trace is its own event store.

### Invariants

1. Events are append-only. No modification or deletion after creation.
2. Event data is deep-frozen at creation time.
3. Events are ordered by timestamp within a single trace.
4. A trace transitions from `open` to `sealed` exactly once, when the execution graph is built.
5. A sealed trace cannot accept new events.
6. `toNodes()` and `toEdges()` are pure projections — they produce new arrays without modifying the trace.

### Graph Derivation Rules

```
TraceEvent.event_type    →  ExecutionNode.node_type
─────────────────────────────────────────────────────
EXECUTION_STARTED        →  intent_resolution
CORE_DISPATCHED          →  core_dispatch (status: running)
CORE_COMPLETED           →  core_dispatch (status: completed | failed)
EVIDENCE_VALIDATED       →  evidence_validation
EXECUTION_COMPLETED      →  aggregation
EXECUTION_FAILED         →  aggregation (status: failed)
```

```
Edge Derivation:
─────────────────────────────────────────────────────
intent_resolution  ──triggers──►  core_dispatch (first batch)
core_dispatch (batch N) ──triggers──► core_dispatch (batch N+1, if dependency)
core_dispatch ──produces──► evidence_validation
evidence_validation ──validates──► aggregation
```

---

## Context 4: Evidence Context

**Responsibility:** Validates that all required evidence was produced by Cores and is well-formed. Produces the `EvidenceSummary`.

**Module:** `evidence_validator.ts`

### Aggregate Root

None. The Evidence Context is a stateless validation service. It receives inputs, produces a result, and holds no state.

### Service

**EvidenceValidator** — a stateless domain service.

```
EvidenceValidator (Domain Service)
└── validate(intent, coreResults): EvidenceSummary
```

### Value Objects

| Value Object | Description | Immutable |
|-------------|-------------|-----------|
| `EvidenceRef` | A reference to evidence produced by a Core. | Yes |
| `EvidenceSummary` | Validation result: totals, missing items, pass/fail. | Yes |
| `MissingEvidence` | A single evidence gap: { core_name, evidence_type, reason }. | Yes |

### Domain Events

| Event | Trigger | Payload |
|-------|---------|---------|
| `EvidenceValidationPassed` | All required evidence present and well-formed | `{ total_required, total_provided }` |
| `EvidenceValidationFailed` | One or more evidence items missing or malformed | `{ missing_evidence[] }` |

### Invariants

1. Every `evidence_required` entry in every `CoreRequirement` MUST have a corresponding `EvidenceRef`.
2. Every `EvidenceRef` MUST pass the well-formedness check (non-empty id, uri, produced_by; valid timestamp).
3. Global `minimum_evidence_count` is checked after per-Core validation.
4. Malformed evidence is treated as missing, not as partial.
5. The validator MUST NOT fetch or dereference evidence URIs.

### Validation Algorithm

```
FOR EACH CoreRequirement:
  ├── Core didn't run?        → All its evidence_required marked missing
  ├── Core failed?            → All its evidence_required marked missing
  └── Core succeeded/partial? → FOR EACH evidence_required:
                                   ├── Type found in evidence_refs?
                                   │   ├── Well-formed? → Count as provided
                                   │   └── Malformed?   → Count as missing (with defect reason)
                                   └── Type not found?  → Count as missing

THEN check global minimum_evidence_count
THEN produce EvidenceSummary
```

---

## Context Map

### Relationships Between Contexts

```
Execution Context ──[calls]──► Core Resolution Context
    │                              │
    │                              │ returns ResolvedCore, CoreExecutionResult
    │                              │
    ├──[records into]──► Tracing Context
    │                        │
    │                        │ derives ExecutionNode[], ExecutionEdge[]
    │                        │
    └──[delegates to]──► Evidence Context
                             │
                             │ returns EvidenceSummary
```

### Integration Patterns

| From → To | Pattern | Notes |
|-----------|---------|-------|
| Execution → Core Resolution | **Direct call** (in-process) | CoreAdapter injected as dependency. |
| Execution → Tracing | **Direct call** (in-process) | Trace created and passed through phases. |
| Execution → Evidence | **Direct call** (in-process) | Stateless service, called once after dispatch. |
| Core Resolution → agentics-contracts | **HTTP/RPC** (out-of-process) | Anti-corruption layer in CoreAdapter. |
| Core Resolution → Core Services | **HTTP** (out-of-process) | HTTPS-only. Contract hash verified. |

### Shared Kernel

The following types are shared across contexts via `src/types/`:

```
Shared across all contexts:
├── ExecutionIntent, CoreRequirement, EvidencePolicy    (types/intent.ts)
├── ResolvedCore, CoreExecutionResult                   (types/core.ts)
├── AgentRecord, RepoRecord, ArtifactRecord             (types/core.ts)
├── EvidenceRef, EvidenceSummary, MissingEvidence        (types/evidence.ts)
├── ExecutionGraph, ExecutionNode, ExecutionEdge         (types/graph.ts)
└── ExecutionError                                       (types/errors.ts)
```

These types form a **shared kernel** — they are owned collectively and changes require agreement across all contexts. This is acceptable because the engine is a single deployable service, not a distributed system of microservices. The shared types are all value objects (immutable, no behavior), minimizing coupling risk.

---

## Ubiquitous Language

| Term | Definition | Used In |
|------|-----------|---------|
| **Intent** | The declarative input describing what to execute. | Execution, Core Resolution |
| **Core** | A registered service implementing a capability. Never a raw repo. | All contexts |
| **Resolve** | Look up a Core name in agentics-contracts and return its endpoint. | Core Resolution |
| **Dispatch** | Send an execution request to a resolved Core endpoint. | Core Resolution, Execution |
| **Batch** | A set of Cores with no mutual dependencies, dispatched in parallel. | Execution |
| **Trace** | The immutable event log recording everything that happened. | Tracing |
| **Evidence** | Proof that a Core performed claimed work. | Evidence, Execution |
| **Graph** | The DAG output showing nodes, edges, results, and evidence. | Execution, Tracing |
| **Seal** | Finalize a trace so no more events can be appended. | Tracing |
| **Well-formed** | An evidence ref that passes structural validation. | Evidence |
| **Gap** | A required evidence item that was not provided or is malformed. | Evidence |
