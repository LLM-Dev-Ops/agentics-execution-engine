# Domain-Driven Design: Context Interactions

**Service:** Agentics Execution Engine
**Date:** 2026-02-09
**References:** bounded-contexts.md, domain-model.md

---

## Execution Sequence

This document details the exact interaction sequence between bounded contexts during a single execution.

### Full Lifecycle Sequence

```
Caller
  │
  │  ExecutionIntent
  ▼
┌─────────────────────────────────────────────────────────────────────┐
│ EXECUTION CONTEXT (ExecutionDispatcher)                             │
│                                                                     │
│  Phase 1: VALIDATE INTENT                                          │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │ validateIntent(intent)                                       │   │
│  │   - Check intent_id present                                  │   │
│  │   - Check cores_required non-empty                           │   │
│  │   - Check no duplicate core_names                            │   │
│  │   - Check evidence_policy well-formed                        │   │
│  │   - Check timeout_ms > 0                                     │   │
│  │                                                               │   │
│  │ ON FAILURE: return failedGraph(ValidationError)              │   │
│  └─────────────────────────────────────────────────────────────┘   │
│         │                                                           │
│         │ valid                                                     │
│         ▼                                                           │
│  Phase 2: RESOLVE CORES                                            │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │ FOR EACH requirement IN intent.cores_required:               │   │
│  │                                                               │   │
│  │   ┌──── CORE RESOLUTION CONTEXT ────┐                       │   │
│  │   │ coreAdapter.resolveCore(         │                       │   │
│  │   │   requirement.core_name,         │                       │   │
│  │   │   requirement.version_constraint │                       │   │
│  │   │ )                                │                       │   │
│  │   │                                  │                       │   │
│  │   │ 1. Check cache                   │                       │   │
│  │   │ 2. If miss → query registry      │                       │   │
│  │   │ 3. Validate HTTPS endpoint       │                       │   │
│  │   │ 4. Return ResolvedCore | null    │                       │   │
│  │   └──────────────────────────────────┘                       │   │
│  │                                                               │   │
│  │ ON NULL: return failedGraph(CORE_NOT_FOUND)                  │   │
│  └─────────────────────────────────────────────────────────────┘   │
│         │                                                           │
│         │ all resolved                                              │
│         ▼                                                           │
│  Phase 3: BUILD DEPENDENCY GRAPH                                   │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │ dependencyGraph = buildDependencyGraph(resolvedCores)        │   │
│  │ executionOrder  = topologicalSort(dependencyGraph)           │   │
│  │                                                               │   │
│  │ ON CYCLE: return failedGraph(CYCLE_DETECTED)                 │   │
│  └─────────────────────────────────────────────────────────────┘   │
│         │                                                           │
│         │ batches ready                                             │
│         ▼                                                           │
│  Phase 4: DISPATCH BATCHES                                         │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                                                               │   │
│  │ ┌── TRACING CONTEXT ──┐                                     │   │
│  │ │ trace = Trace.create │                                     │   │
│  │ └─────────────────────┘                                     │   │
│  │                                                               │   │
│  │ FOR EACH batch IN executionOrder.batches:                    │   │
│  │                                                               │   │
│  │   PARALLEL FOR EACH core IN batch:                           │   │
│  │     │                                                         │   │
│  │     │ ┌── TRACING ──────────────────┐                       │   │
│  │     │ │ trace.recordDispatch(core)   │                       │   │
│  │     │ └─────────────────────────────┘                       │   │
│  │     │                                                         │   │
│  │     │ ┌── CORE RESOLUTION ──────────┐                       │   │
│  │     │ │ result = coreAdapter.dispatch│                       │   │
│  │     │ │   (core, inputs, timeout)   │                       │   │
│  │     │ │                              │                       │   │
│  │     │ │ 1. Build HTTP request        │                       │   │
│  │     │ │ 2. POST to core.endpoint     │                       │   │
│  │     │ │ 3. Validate response shape   │                       │   │
│  │     │ │ 4. Retry on transient error  │                       │   │
│  │     │ │ 5. Return CoreExecResult     │                       │   │
│  │     │ └──────────────────────────────┘                       │   │
│  │     │                                                         │   │
│  │     │ ┌── TRACING ──────────────────┐                       │   │
│  │     │ │ trace.recordResult(core, r)  │                       │   │
│  │     │ └─────────────────────────────┘                       │   │
│  │     ▼                                                         │   │
│  │   Store result in coreResults map                            │   │
│  │   If failed + unrecoverable → stop future dependent batches  │   │
│  │                                                               │   │
│  └─────────────────────────────────────────────────────────────┘   │
│         │                                                           │
│         │ all batches done                                          │
│         ▼                                                           │
│  Phase 5: VALIDATE EVIDENCE                                        │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                                                               │   │
│  │   ┌── EVIDENCE CONTEXT ──────────────────────┐              │   │
│  │   │ summary = evidenceValidator.validate(      │              │   │
│  │   │   intent, coreResults                      │              │   │
│  │   │ )                                          │              │   │
│  │   │                                            │              │   │
│  │   │ 1. Check per-Core evidence_required        │              │   │
│  │   │ 2. Check well-formedness of each ref       │              │   │
│  │   │ 3. Check global minimum_evidence_count     │              │   │
│  │   │ 4. Return EvidenceSummary                  │              │   │
│  │   └────────────────────────────────────────────┘              │   │
│  │                                                               │   │
│  │   ┌── TRACING ──────────────────────────────┐               │   │
│  │   │ trace.recordEvidenceValidation(summary)  │               │   │
│  │   └─────────────────────────────────────────┘               │   │
│  │                                                               │   │
│  │   IF fail_on_missing AND NOT all_satisfied:                  │   │
│  │     trace.markFailed("Missing required evidence")            │   │
│  │                                                               │   │
│  └─────────────────────────────────────────────────────────────┘   │
│         │                                                           │
│         ▼                                                           │
│  Phase 6: BUILD GRAPH                                              │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                                                               │   │
│  │   ┌── TRACING ─────────────┐                                │   │
│  │   │ nodes = trace.toNodes() │                                │   │
│  │   │ edges = trace.toEdges() │                                │   │
│  │   │ trace.seal()            │                                │   │
│  │   └─────────────────────────┘                                │   │
│  │                                                               │   │
│  │   graph = ExecutionGraph {                                   │   │
│  │     execution_id, intent_id, status,                         │   │
│  │     started_at, completed_at, total_duration_ms,             │   │
│  │     nodes, edges, core_results, evidence_summary             │   │
│  │   }                                                          │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
  │
  │  ExecutionGraph
  ▼
Caller
```

---

## Cross-Context Data Flow

### What Flows Between Contexts

| From | To | Data | Direction |
|------|----|------|-----------|
| Execution | Core Resolution | `CoreRequirement` | Request |
| Core Resolution | Execution | `ResolvedCore` | Response |
| Execution | Core Resolution | `ResolvedCore` + `inputs` + `timeout` | Request (dispatch) |
| Core Resolution | Execution | `CoreExecutionResult` | Response |
| Execution | Tracing | `TraceEvent` data | Write |
| Tracing | Execution | `ExecutionNode[]`, `ExecutionEdge[]` | Read (graph derivation) |
| Execution | Evidence | `ExecutionIntent` + `Map<CoreExecutionResult>` | Request |
| Evidence | Execution | `EvidenceSummary` | Response |

### What Does NOT Flow Between Contexts

- **Raw HTTP responses** do not leave Core Resolution. The adapter translates them into `CoreExecutionResult` before returning.
- **Cache state** is internal to Core Resolution. Execution Context does not know whether a Core was resolved from cache or registry.
- **Trace events** are internal to Tracing. Execution Context appends events via the Trace API but does not read individual events (only derived nodes/edges).
- **Validation logic** does not leave Evidence Context. Execution Context receives the summary, not the algorithm.

---

## Error Propagation Across Contexts

### Core Resolution Errors → Execution Context

```
CoreAdapter throws/returns    │  Execution Context handles
──────────────────────────────┼──────────────────────────────
resolveCore() returns null    │  Immediate failedGraph(CORE_NOT_FOUND)
resolveCore() throws          │  Immediate failedGraph(REGISTRY_UNAVAILABLE)
dispatch() returns failed     │  Store result, skip dependents, continue independents
dispatch() throws timeout     │  Store failed result with TIMEOUT code
dispatch() throws connection  │  Retry (per policy), then store failed result
```

### Evidence Errors → Execution Context

```
EvidenceValidator returns         │  Execution Context handles
──────────────────────────────────┼──────────────────────────────
summary.all_satisfied = true      │  Proceed to graph. Status: completed.
summary.all_satisfied = false     │  If fail_on_missing: status = failed.
                                  │  If !fail_on_missing: status = partial_failure.
                                  │  Graph always produced either way.
```

### Tracing Errors → Execution Context

The Tracing Context should never throw. It is an in-memory append-only log. If it does throw (bug), the Execution Context catches the error, attempts to build a minimal error graph without trace data, and includes the tracing error in the graph's error field. This is a last-resort safety net, not an expected code path.

---

## Contract Between Contexts

### Core Resolution Context Contract

```
PRECONDITIONS:
  - core_name is a non-empty string
  - version_constraint is a valid semver range
  - inputs is a Record (possibly empty)
  - timeoutMs > 0

POSTCONDITIONS (resolveCore):
  - Returns ResolvedCore with HTTPS endpoint, OR null
  - Never returns a ResolvedCore with an HTTP endpoint
  - contract_hash is always present

POSTCONDITIONS (dispatch):
  - Returns CoreExecutionResult with all required arrays present (possibly empty)
  - status is one of: "success", "partial", "failed"
  - If status is "failed", error field is present
  - duration_ms reflects actual elapsed time
```

### Evidence Context Contract

```
PRECONDITIONS:
  - intent has non-empty cores_required
  - results map may be empty (if all Cores failed before dispatch)

POSTCONDITIONS:
  - Returns EvidenceSummary
  - total_required >= 0
  - total_provided >= 0 and <= total_required
  - total_missing = missing_evidence.length
  - all_satisfied = (missing_evidence.length == 0)
  - No I/O performed. No URIs fetched. Pure computation.
```

### Tracing Context Contract

```
PRECONDITIONS:
  - Trace is in OPEN state for appendEvent()
  - Event type is a known TraceEventType
  - Data is a serializable object

POSTCONDITIONS (appendEvent):
  - Event is appended to internal array
  - Event data is deep-frozen
  - Events are never reordered or removed

POSTCONDITIONS (toNodes/toEdges):
  - Returns new arrays (not internal state)
  - Internal events array is unchanged

POSTCONDITIONS (seal):
  - Trace transitions to SEALED
  - Subsequent appendEvent() calls throw
```
