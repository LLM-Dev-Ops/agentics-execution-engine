# ADR-007: Error Handling and Recovery Strategy

**Status:** Accepted
**Date:** 2026-02-09
**Deciders:** Reuven Cohen
**References:** SPARC-specification.md Section 3.5, Section 4.1

---

## Context

The engine interacts with external systems (contract registry, Core service endpoints) that can fail in various ways. A clear, consistent error handling strategy is needed to ensure the engine is resilient without masking real failures.

## Decision

**Categorize errors by phase and recoverability. Apply distinct handling per category. Never retry logic failures.**

### Error Taxonomy

```
ExecutionError
├── ValidationError          (Phase 1: Intent validation)
│   ├── INVALID_INTENT       — malformed intent object
│   ├── EMPTY_CORES          — cores_required is empty
│   ├── DUPLICATE_CORE       — same core_name appears twice
│   └── INVALID_EVIDENCE_POLICY — malformed evidence policy
│
├── ResolutionError          (Phase 2: Core resolution)
│   ├── CORE_NOT_FOUND       — core_name not in registry
│   ├── VERSION_MISMATCH     — no version satisfies constraint
│   ├── REGISTRY_UNAVAILABLE — registry is down (transient)
│   └── CONTRACT_HASH_MISMATCH — cache stale or tampered
│
├── DependencyError          (Phase 3: Dependency graph)
│   └── CYCLE_DETECTED       — circular dependency among Cores
│
├── DispatchError            (Phase 4: Core dispatch)
│   ├── TIMEOUT              — Core exceeded timeout_ms
│   ├── CONNECTION_FAILED    — network error reaching Core
│   ├── INVALID_RESPONSE     — Core returned non-conforming data
│   └── CORE_EXECUTION_FAILED — Core returned status: "failed"
│
└── EvidenceError            (Phase 5: Evidence validation)
    ├── MISSING_EVIDENCE     — required evidence not provided
    ├── MALFORMED_EVIDENCE   — evidence ref fails well-formedness check
    └── INSUFFICIENT_COUNT   — global minimum_evidence_count not met
```

### Handling Rules

| Error Code | Recoverable | Retry | Behavior |
|------------|-------------|-------|----------|
| `INVALID_INTENT` | No | No | Return failed graph immediately. |
| `EMPTY_CORES` | No | No | Return failed graph immediately. |
| `DUPLICATE_CORE` | No | No | Return failed graph immediately. |
| `CORE_NOT_FOUND` | No | No | Return failed graph immediately. |
| `VERSION_MISMATCH` | No | No | Return failed graph immediately. |
| `REGISTRY_UNAVAILABLE` | Yes | Yes (3x) | Retry with exponential backoff. Fail if exhausted. |
| `CONTRACT_HASH_MISMATCH` | Yes | Yes (1x) | Evict cache, re-resolve, retry dispatch once. |
| `CYCLE_DETECTED` | No | No | Return failed graph immediately. |
| `TIMEOUT` | No | No | Record failure. Skip dependents. Continue independents. |
| `CONNECTION_FAILED` | Yes | Yes (3x) | Retry with exponential backoff. |
| `INVALID_RESPONSE` | No | No | Record failure. Skip dependents. Continue independents. |
| `CORE_EXECUTION_FAILED` | Depends | No | Check `error.recoverable`. If false, skip dependents. |
| `MISSING_EVIDENCE` | No | No | Mark execution failed (if policy requires). |
| `MALFORMED_EVIDENCE` | No | No | Treated as missing. |
| `INSUFFICIENT_COUNT` | No | No | Mark execution failed (if policy requires). |

### Retry Policy

```
RetryPolicy {
  max_attempts:     3
  base_delay_ms:    200
  max_delay_ms:     2000
  backoff_factor:   2.0      // exponential: 200ms, 400ms, 800ms
  retryable_codes:  ["REGISTRY_UNAVAILABLE", "CONNECTION_FAILED"]
}
```

Retries apply ONLY to transient errors. The engine never retries:
- Validation failures (caller's input is wrong)
- Logic failures (Core explicitly failed)
- Timeout (the Core had its chance)

### Failure Isolation

A failed Core does NOT crash the engine or abort the entire execution. The principle is:

1. **Dependent Cores are skipped.** If Core B depends on Core A, and Core A fails, Core B is skipped with status `DEPENDENCY_FAILED`.
2. **Independent Cores continue.** If Core C has no dependency on Core A, it dispatches and executes normally.
3. **The graph records everything.** All successes, failures, and skips are visible.

### No Silent Swallowing

The engine MUST NOT silently swallow errors. Every error is:
- Recorded in the execution trace as a `TraceEvent`.
- Included in the corresponding `CoreExecutionResult.error` field.
- Reflected in the execution graph node status.

## Consequences

### Positive

- **Predictable behavior.** Each error code maps to a single, well-defined handling path.
- **No wasted retries.** Logic failures are never retried.
- **Partial progress preserved.** Independent Cores complete even when others fail.
- **Full observability.** Every error is traced, graphed, and surfaced.

### Negative

- **Conservative retries.** Only 3 attempts for transient errors. Some transient issues may need more. Can be tuned via configuration.
- **No circuit breaker.** If a Core endpoint is consistently failing, the engine will retry on every execution. A circuit breaker pattern could be added in a future iteration.

## Compliance

- **Section 3.5**: Error handling strategy table.
- **Section 4.1**: Edge cases for partial status, cycle detection, non-JSON responses.
- **FR-3**: "Retry transient failures according to a configurable retry policy."
