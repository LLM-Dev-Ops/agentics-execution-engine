# ADR-002: Topological Batch Dispatch Strategy

**Status:** Accepted
**Date:** 2026-02-09
**Deciders:** Reuven Cohen
**References:** SPARC-specification.md FR-3, Section 3.4, Section 4.2

---

## Context

An execution intent may require multiple Cores. These Cores may have dependencies on one another (e.g., Core B needs the output of Core A), or they may be fully independent. The engine must determine the order in which to dispatch Cores and maximize parallelism where safe.

Three strategies were considered:

1. **Sequential dispatch** — execute Cores one at a time in the order listed in the intent.
2. **Fully parallel dispatch** — fire all Cores simultaneously, let them sort out dependencies.
3. **Topological batch dispatch** — build a dependency DAG, topologically sort into batches, dispatch each batch in parallel.

## Decision

**Use topological batch dispatch.** The engine will:

1. Construct a directed acyclic graph (DAG) from Core dependency declarations.
2. Perform a topological sort to produce an ordered list of batches.
3. Dispatch all Cores within a batch concurrently (they have no mutual dependencies).
4. Wait for the entire batch to complete before dispatching the next batch.
5. If a cycle is detected during topological sort, reject the intent immediately before any dispatch.

### Batch Formation

```
Given Cores: A, B, C, D, E
Dependencies: B→A, C→A, D→B, D→C, E (independent)

DAG:
  A ──► B ──► D
  A ──► C ──┘
  E (no edges)

Topological Batches:
  Batch 0: [A, E]     ← dispatched in parallel
  Batch 1: [B, C]     ← dispatched in parallel after Batch 0 completes
  Batch 2: [D]         ← dispatched after Batch 1 completes
```

### Dependency Declaration

Core dependencies are declared in the `CoreRequirement` through input references. If Core B's `inputs` reference the output of Core A by name, the engine infers the edge `B depends_on A`.

```
CoreRequirement {
  core_name: "code-generator",
  inputs: {
    spec: { from_core: "spec-analyzer", output_key: "parsed_spec" }
  }
}
```

The `from_core` field creates the dependency edge.

### Failure Propagation

When a Core in batch N fails with an unrecoverable error:
- All Cores in batch N that are already running continue to completion (they were dispatched in parallel).
- Cores in batch N+1 that depend on the failed Core are skipped and marked as `DEPENDENCY_FAILED`.
- Cores in batch N+1 that do NOT depend on the failed Core still execute.

## Consequences

### Positive

- **Maximum safe parallelism.** Independent Cores always run concurrently.
- **Correct ordering.** Dependent Cores never execute before their dependencies.
- **Cycle detection.** Caught before any dispatch, preventing deadlocks.
- **Predictable execution.** The batch model makes the execution graph easy to reason about and visualize.
- **Partial progress.** Independent Cores complete even when others fail.

### Negative

- **Batch granularity.** A batch must fully complete before the next starts. If one Core in a batch is slow, it blocks the next batch even for Cores that don't depend on it. This is a deliberate simplicity tradeoff — fine-grained per-Core readiness tracking adds complexity for marginal gain.
- **Dependency inference.** Requires a convention for how Cores declare dependencies through `inputs`. If inputs don't use `from_core`, the engine cannot infer the edge.

### Neutral

- The topological sort algorithm (Kahn's algorithm) is O(V + E) where V = number of Cores and E = number of dependency edges. For typical intent sizes (< 20 Cores), this is negligible.

## Alternatives Considered

### Sequential Dispatch

Rejected. Leaves parallelism on the table for independent Cores. Execution time equals the sum of all Core execution times rather than the critical path length.

### Fully Parallel Dispatch

Rejected. Cores with dependencies would receive missing inputs, causing failures. Would require Cores to implement their own waiting/retry logic, violating the separation of concerns (the engine manages orchestration, Cores manage execution).

### Fine-Grained Per-Core Readiness

Considered (dispatch a Core as soon as all its specific dependencies complete, rather than waiting for the full batch). Rejected for v1 due to added complexity in tracking per-Core readiness states. Can be revisited if batch granularity becomes a bottleneck.

## Compliance

- **FR-3**: "Support parallel dispatch when Cores have no interdependencies."
- **FR-3**: "Support sequential dispatch when Cores declare dependencies on other Core outputs."
- **Refinement 4.1**: "Circular Core dependencies: Detected during topological sort."
