# ADR-006: Execution Graph Always Produced

**Status:** Accepted
**Date:** 2026-02-09
**Deciders:** Reuven Cohen
**References:** SPARC-specification.md FR-6, NFR-4, NFR-7, Section 3.4

---

## Context

The execution graph is the primary output of the engine — a DAG recording every dispatch, result, dependency, and evidence chain. The question is whether the graph should be produced only on success, or unconditionally.

## Decision

**The execution graph is always produced, regardless of execution outcome.** This includes:

- Successful executions (status: `"completed"`)
- Partial failures (status: `"partial_failure"`)
- Complete failures (status: `"failed"`)
- Validation rejections (intent invalid, Core not found, cycle detected)

### Graph Completeness by Failure Point

| Failure Point | Graph Contains |
|---------------|---------------|
| Intent validation fails | `intent_resolution` node marked failed. No dispatch nodes. Evidence summary shows 0/0. |
| Core not found | `intent_resolution` node succeeded. `core_dispatch` node for missing Core marked failed. No further dispatch nodes. |
| Cycle detected | `intent_resolution` node succeeded. Aggregation node with cycle error. No dispatch nodes. |
| Core times out | All prior dispatch nodes. The timed-out Core node marked failed. Subsequent dependent nodes skipped. |
| Evidence validation fails | All dispatch nodes present. `evidence_validation` node marked failed with summary. |
| Full success | All nodes completed. Evidence validation passed. |

### Rationale

The graph is the **single source of truth** for what happened during an execution. If it's missing on failure, operators lose the primary debugging tool exactly when they need it most. The graph should answer: "What happened, in what order, and where did it go wrong?"

### Serialization

The graph MUST be JSON-serializable (NFR-4). All fields use primitive types, arrays, or nested objects. No circular references, no functions, no class instances in the serialized output.

```typescript
// Always valid:
JSON.stringify(executionGraph)  // Never throws
```

## Consequences

### Positive

- **Debugging.** Operators always have a graph to inspect, even for crashes.
- **Monitoring.** Dashboards and alerting systems can consume failed graphs just like successful ones.
- **Consistency.** The return type of `dispatchExecution()` is always `ExecutionGraph`. No `null`, no exceptions for the caller to handle differently.
- **Accountability.** Even rejected intents produce a record.

### Negative

- **Graph construction on failure path.** The engine spends time building a graph even when the execution failed early. This is negligible (< 10ms per the performance target) and the debugging value far outweighs the cost.

## Compliance

- **FR-6**: "Execution output MUST include a full execution graph."
- **NFR-4**: "Execution graph must be serializable to JSON."
- **NFR-7**: "Failed executions must retain full trace."
- **Section 3.4**: "Even failed executions need a graph for debugging and accountability."
