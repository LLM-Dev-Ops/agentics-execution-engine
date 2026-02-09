# SPARC Specification: Agentics Execution Engine

**Author:** Reuven Cohen
**Date:** 2026-02-09
**Status:** Draft
**Version:** 0.1.0

---

## Table of Contents

1. [Specification](#1-specification)
2. [Pseudocode](#2-pseudocode)
3. [Architecture](#3-architecture)
4. [Refinement](#4-refinement)
5. [Completion](#5-completion)

---

## 1. Specification

### 1.1 Purpose

The Agentics Execution Engine is the execution spine of the Agentics platform. It accepts declarative execution intents, resolves the required Cores from `agentics-contracts`, dispatches work to Core services, collects structured results with mandatory evidence, and produces a full execution graph tracing every action taken.

### 1.2 Definitions

| Term | Definition |
|------|-----------|
| **Execution Intent** | A declarative object describing what should be executed, which Cores are needed, and what outcomes are expected. |
| **Core** | A registered service that implements a specific capability (e.g., code generation, testing, deployment). Cores are resolved from `agentics-contracts`, NOT raw repositories. |
| **Evidence** | A verifiable artifact or reference proving that a claimed action was performed. Every Core must produce evidence for its work. |
| **Execution Graph** | A directed acyclic graph (DAG) recording every dispatch, result, dependency, and evidence chain for a single execution run. |
| **Execution Trace** | The immutable, append-only log of all events that occurred during execution. |

### 1.3 Functional Requirements

#### FR-1: Accept Execution Intent

The engine MUST accept an execution intent object conforming to this shape:

```typescript
interface ExecutionIntent {
  intent_id: string;               // Unique identifier
  requested_by: string;            // Caller identity
  cores_required: CoreRequirement[];
  parameters: Record<string, unknown>;
  evidence_policy: EvidencePolicy;
  timeout_ms: number;
  metadata?: Record<string, unknown>;
}

interface CoreRequirement {
  core_name: string;               // Resolved from agentics-contracts
  version_constraint: string;      // Semver range
  inputs: Record<string, unknown>;
  evidence_required: string[];     // Evidence types this Core MUST return
}

interface EvidencePolicy {
  fail_on_missing: boolean;        // MUST default to true
  required_evidence_types: string[];
  minimum_evidence_count: number;
}
```

#### FR-2: Resolve Cores from agentics-contracts

The engine MUST:
- Resolve each `core_name` against the `agentics-contracts` registry.
- Validate that the resolved Core satisfies the `version_constraint`.
- Fail fast if any required Core is not found or version is incompatible.
- NEVER dispatch to raw repositories directly.

#### FR-3: Dispatch Execution to Core Services

The engine MUST:
- Dispatch execution requests to resolved Core service endpoints.
- Support parallel dispatch when Cores have no interdependencies.
- Support sequential dispatch when Cores declare dependencies on other Core outputs.
- Enforce per-Core timeouts derived from the intent's `timeout_ms`.
- Retry transient failures according to a configurable retry policy.

#### FR-4: Require Structured Core Results

Every Core MUST return a result conforming to:

```typescript
interface CoreExecutionResult {
  core_name: string;
  core_version: string;
  status: "success" | "partial" | "failed";
  agents_executed: AgentRecord[];
  repos_touched: RepoRecord[];
  artifacts_generated: ArtifactRecord[];
  evidence_refs: EvidenceRef[];
  duration_ms: number;
  error?: ExecutionError;
}

interface AgentRecord {
  agent_id: string;
  agent_type: string;
  task_description: string;
  status: "completed" | "failed" | "skipped";
  duration_ms: number;
}

interface RepoRecord {
  repo_uri: string;
  branch: string;
  commits: string[];        // Commit SHAs
  files_changed: string[];
}

interface ArtifactRecord {
  artifact_id: string;
  artifact_type: string;    // e.g., "binary", "config", "report", "image"
  uri: string;
  checksum: string;         // SHA-256
  size_bytes: number;
}

interface EvidenceRef {
  evidence_type: string;
  evidence_id: string;
  uri: string;
  produced_by: string;      // Core or agent that produced it
  timestamp: string;        // ISO 8601
  verifiable: boolean;
}

interface ExecutionError {
  code: string;
  message: string;
  recoverable: boolean;
  context?: Record<string, unknown>;
}
```

#### FR-5: Fail on Missing Evidence

The engine MUST:
- After all Cores complete, validate that every `evidence_required` entry in each `CoreRequirement` has a corresponding `EvidenceRef` in the result.
- If `evidence_policy.fail_on_missing` is `true` (the default), mark the entire execution as FAILED if any required evidence is absent.
- Record which specific evidence items are missing in the execution trace.

#### FR-6: Produce Execution Graph

The execution output MUST include a full execution graph:

```typescript
interface ExecutionGraph {
  execution_id: string;
  intent_id: string;
  status: "completed" | "partial_failure" | "failed";
  started_at: string;
  completed_at: string;
  total_duration_ms: number;
  nodes: ExecutionNode[];
  edges: ExecutionEdge[];
  core_results: CoreExecutionResult[];
  evidence_summary: EvidenceSummary;
}

interface ExecutionNode {
  node_id: string;
  node_type: "core_dispatch" | "evidence_validation" | "intent_resolution" | "aggregation";
  core_name?: string;
  status: "pending" | "running" | "completed" | "failed";
  started_at?: string;
  completed_at?: string;
  duration_ms?: number;
}

interface ExecutionEdge {
  from_node: string;
  to_node: string;
  edge_type: "depends_on" | "produces" | "validates" | "triggers";
}

interface EvidenceSummary {
  total_required: number;
  total_provided: number;
  total_missing: number;
  missing_evidence: MissingEvidence[];
  all_satisfied: boolean;
}

interface MissingEvidence {
  core_name: string;
  evidence_type: string;
  reason: string;
}
```

### 1.4 Non-Functional Requirements

| ID | Requirement | Target |
|----|-------------|--------|
| NFR-1 | Execution intent acceptance latency | < 50ms |
| NFR-2 | Core resolution latency | < 200ms per Core |
| NFR-3 | End-to-end execution (excluding Core work) | < 500ms overhead |
| NFR-4 | Execution graph must be serializable to JSON | Always |
| NFR-5 | All traces must be immutable and append-only | Always |
| NFR-6 | Engine must handle ≥ 50 concurrent executions | Under load |
| NFR-7 | Failed executions must retain full trace | Always |

### 1.5 Constraints

- Cores are resolved exclusively from `agentics-contracts`. No direct repo references.
- Evidence validation is mandatory by default. Callers may opt out only by explicitly setting `fail_on_missing: false`.
- The execution graph is always produced, even on failure.
- No execution side effects may occur before intent validation passes.

### 1.6 Out of Scope

- Core implementation (Cores are external services).
- User authentication/authorization (handled upstream).
- Artifact storage (artifacts are referenced by URI, not stored by the engine).
- Scheduling/queueing of intents (handled by an orchestration layer above).

---

## 2. Pseudocode

### 2.1 execution_dispatcher.ts

```
FUNCTION dispatchExecution(intent: ExecutionIntent): ExecutionGraph

  // Phase 1: Validate intent
  validationResult = validateIntent(intent)
  IF validationResult.hasErrors THEN
    RETURN failedGraph(intent, validationResult.errors)

  // Phase 2: Resolve cores
  resolvedCores = []
  FOR EACH requirement IN intent.cores_required DO
    resolved = coreAdapter.resolveCore(requirement.core_name, requirement.version_constraint)
    IF resolved IS NULL THEN
      RETURN failedGraph(intent, [CoreNotFoundError(requirement.core_name)])
    resolvedCores.APPEND({ requirement, resolved })

  // Phase 3: Build dependency graph
  dependencyGraph = buildDependencyGraph(resolvedCores)
  executionOrder = topologicalSort(dependencyGraph)

  // Phase 4: Dispatch in dependency order
  trace = ExecutionTrace.create(intent)
  coreResults = Map<string, CoreExecutionResult>

  FOR EACH batch IN executionOrder.batches DO
    // Cores within a batch have no interdependencies — dispatch in parallel
    batchResults = PARALLEL FOR EACH core IN batch DO
      trace.recordDispatch(core)
      result = coreAdapter.dispatch(core.resolved, core.requirement.inputs, intent.timeout_ms)
      trace.recordResult(core, result)
      RETURN result

    FOR EACH (core, result) IN ZIP(batch, batchResults) DO
      coreResults.SET(core.requirement.core_name, result)
      IF result.status == "failed" AND NOT isRecoverable(result.error) THEN
        BREAK executionOrder  // Stop dispatching further batches

  // Phase 5: Validate evidence
  evidenceResult = evidenceValidator.validate(intent, coreResults)
  trace.recordEvidenceValidation(evidenceResult)

  IF intent.evidence_policy.fail_on_missing AND NOT evidenceResult.all_satisfied THEN
    trace.markFailed("Missing required evidence")

  // Phase 6: Build and return execution graph
  graph = buildExecutionGraph(intent, trace, coreResults, evidenceResult)
  RETURN graph
```

### 2.2 core_adapter.ts

```
CLASS CoreAdapter

  PRIVATE registry: ContractRegistry  // Connection to agentics-contracts

  FUNCTION resolveCore(coreName: string, versionConstraint: string): ResolvedCore | NULL
    contract = registry.lookup(coreName)
    IF contract IS NULL THEN RETURN NULL

    matchingVersion = contract.versions.findSatisfying(versionConstraint)
    IF matchingVersion IS NULL THEN RETURN NULL

    RETURN ResolvedCore {
      name: coreName,
      version: matchingVersion.version,
      endpoint: matchingVersion.service_endpoint,
      capabilities: matchingVersion.capabilities,
      contract_hash: matchingVersion.contract_hash
    }

  FUNCTION dispatch(core: ResolvedCore, inputs: Record, timeoutMs: number): CoreExecutionResult
    request = buildCoreRequest(core, inputs)

    TRY
      response = httpClient.post(core.endpoint + "/execute", request, { timeout: timeoutMs })
      result = parseCoreResponse(response)
      validateResultShape(result)  // Ensure all required fields present
      RETURN result
    CATCH TimeoutError
      RETURN failedResult(core, "TIMEOUT", "Core execution exceeded timeout")
    CATCH ConnectionError AS e
      IF retryPolicy.shouldRetry(e) THEN
        RETURN dispatch(core, inputs, timeoutMs)  // Retry with backoff
      RETURN failedResult(core, "CONNECTION_FAILED", e.message)
    CATCH ValidationError AS e
      RETURN failedResult(core, "INVALID_RESPONSE", e.message)

  FUNCTION validateResultShape(result: CoreExecutionResult): void
    ASSERT result.agents_executed IS Array
    ASSERT result.repos_touched IS Array
    ASSERT result.artifacts_generated IS Array
    ASSERT result.evidence_refs IS Array
    FOR EACH artifact IN result.artifacts_generated DO
      ASSERT artifact.checksum IS NOT EMPTY
    FOR EACH evidence IN result.evidence_refs DO
      ASSERT evidence.evidence_id IS NOT EMPTY
      ASSERT evidence.uri IS NOT EMPTY
```

### 2.3 execution_trace.ts

```
CLASS ExecutionTrace

  PRIVATE events: TraceEvent[]  // Append-only
  PRIVATE executionId: string
  PRIVATE intentId: string

  STATIC FUNCTION create(intent: ExecutionIntent): ExecutionTrace
    trace = NEW ExecutionTrace()
    trace.executionId = generateId()
    trace.intentId = intent.intent_id
    trace.appendEvent("EXECUTION_STARTED", { intent })
    RETURN trace

  FUNCTION recordDispatch(core: ResolvedCore): void
    appendEvent("CORE_DISPATCHED", {
      core_name: core.name,
      core_version: core.version,
      endpoint: core.endpoint
    })

  FUNCTION recordResult(core: ResolvedCore, result: CoreExecutionResult): void
    appendEvent("CORE_COMPLETED", {
      core_name: core.name,
      status: result.status,
      agents_count: result.agents_executed.length,
      repos_count: result.repos_touched.length,
      artifacts_count: result.artifacts_generated.length,
      evidence_count: result.evidence_refs.length,
      duration_ms: result.duration_ms
    })

  FUNCTION recordEvidenceValidation(result: EvidenceSummary): void
    appendEvent("EVIDENCE_VALIDATED", {
      total_required: result.total_required,
      total_provided: result.total_provided,
      total_missing: result.total_missing,
      all_satisfied: result.all_satisfied,
      missing: result.missing_evidence
    })

  FUNCTION markFailed(reason: string): void
    appendEvent("EXECUTION_FAILED", { reason })

  FUNCTION toNodes(): ExecutionNode[]
    // Convert trace events into graph nodes
    RETURN events.MAP(event => nodeFromEvent(event))

  FUNCTION toEdges(): ExecutionEdge[]
    // Derive edges from event ordering and causal relationships
    edges = []
    FOR EACH pair (prev, curr) IN consecutivePairs(events) DO
      IF causallyRelated(prev, curr) THEN
        edges.APPEND(edgeFromPair(prev, curr))
    RETURN edges

  PRIVATE FUNCTION appendEvent(type: string, data: Record): void
    event = TraceEvent {
      event_id: generateId(),
      execution_id: executionId,
      event_type: type,
      timestamp: now(),       // ISO 8601
      data: freeze(data)      // Immutable snapshot
    }
    events.APPEND(event)       // Append-only, never mutate
```

### 2.4 evidence_validator.ts

```
CLASS EvidenceValidator

  FUNCTION validate(intent: ExecutionIntent, results: Map<string, CoreExecutionResult>): EvidenceSummary
    totalRequired = 0
    totalProvided = 0
    missingEvidence = []

    FOR EACH requirement IN intent.cores_required DO
      coreResult = results.GET(requirement.core_name)

      IF coreResult IS NULL OR coreResult.status == "failed" THEN
        // Core didn't execute — all its evidence is missing
        FOR EACH evidenceType IN requirement.evidence_required DO
          totalRequired += 1
          missingEvidence.APPEND({
            core_name: requirement.core_name,
            evidence_type: evidenceType,
            reason: "Core did not execute or failed"
          })
        CONTINUE

      providedTypes = SET(coreResult.evidence_refs.MAP(e => e.evidence_type))

      FOR EACH evidenceType IN requirement.evidence_required DO
        totalRequired += 1
        IF evidenceType IN providedTypes THEN
          totalProvided += 1
          // Verify the evidence ref is well-formed
          matchingRef = coreResult.evidence_refs.FIND(e => e.evidence_type == evidenceType)
          IF NOT isWellFormedEvidence(matchingRef) THEN
            totalProvided -= 1
            missingEvidence.APPEND({
              core_name: requirement.core_name,
              evidence_type: evidenceType,
              reason: "Evidence ref is malformed: " + describeDefect(matchingRef)
            })
        ELSE
          missingEvidence.APPEND({
            core_name: requirement.core_name,
            evidence_type: evidenceType,
            reason: "Core completed but did not provide this evidence type"
          })

    // Also check global evidence policy
    IF intent.evidence_policy.minimum_evidence_count > totalProvided THEN
      missingEvidence.APPEND({
        core_name: "_global",
        evidence_type: "_minimum_count",
        reason: FORMAT("Policy requires at least %d evidence items, got %d",
                       intent.evidence_policy.minimum_evidence_count, totalProvided)
      })

    RETURN EvidenceSummary {
      total_required: totalRequired,
      total_provided: totalProvided,
      total_missing: missingEvidence.length,
      missing_evidence: missingEvidence,
      all_satisfied: missingEvidence.length == 0
    }

  PRIVATE FUNCTION isWellFormedEvidence(ref: EvidenceRef): boolean
    RETURN ref.evidence_id IS NOT EMPTY
       AND ref.uri IS NOT EMPTY
       AND ref.produced_by IS NOT EMPTY
       AND ref.timestamp IS VALID ISO 8601
```

---

## 3. Architecture

### 3.1 System Context

```
                    ┌──────────────────────┐
                    │   Calling Service     │
                    │  (Orchestration Layer)│
                    └──────────┬───────────┘
                               │ ExecutionIntent
                               ▼
                    ┌──────────────────────┐
                    │  Agentics Execution  │
                    │       Engine         │
                    │                      │
                    │  ┌────────────────┐  │
                    │  │  Dispatcher    │  │
                    │  └───────┬────────┘  │
                    │          │            │
                    │  ┌───────▼────────┐  │
                    │  │ Core Adapter   │──┼──────► agentics-contracts
                    │  └───────┬────────┘  │        (Contract Registry)
                    │          │            │
                    │    ┌─────┴─────┐     │
                    │    │           │     │
                    │    ▼           ▼     │
                    │  ┌────┐    ┌────┐   │
                    │  │Core│    │Core│   │
                    │  │ A  │    │ B  │   │       ┌────────────────┐
                    │  └──┬─┘    └──┬─┘   │       │                │
                    │     │         │      │       │  Core Service  │
                    │     └────┬────┘      │◄──────│   Endpoints    │
                    │          │           │       │                │
                    │  ┌───────▼────────┐  │       └────────────────┘
                    │  │   Evidence     │  │
                    │  │   Validator    │  │
                    │  └───────┬────────┘  │
                    │          │           │
                    │  ┌───────▼────────┐  │
                    │  │ Execution Trace│  │
                    │  │  & Graph Build │  │
                    │  └────────────────┘  │
                    └──────────┬───────────┘
                               │ ExecutionGraph
                               ▼
                    ┌──────────────────────┐
                    │      Caller          │
                    └──────────────────────┘
```

### 3.2 Module Decomposition

```
src/
├── execution_dispatcher.ts    # Entry point. Orchestrates the full execution lifecycle.
├── core_adapter.ts            # Resolves Cores from agentics-contracts, dispatches to Core endpoints.
├── execution_trace.ts         # Immutable, append-only trace of all execution events.
├── evidence_validator.ts      # Validates that all required evidence was produced.
├── types/
│   ├── intent.ts              # ExecutionIntent, CoreRequirement, EvidencePolicy
│   ├── core.ts                # ResolvedCore, CoreExecutionResult, AgentRecord, RepoRecord, ArtifactRecord
│   ├── evidence.ts            # EvidenceRef, EvidenceSummary, MissingEvidence
│   ├── graph.ts               # ExecutionGraph, ExecutionNode, ExecutionEdge
│   └── errors.ts              # ExecutionError, typed error codes
└── utils/
    ├── dependency_graph.ts    # Topological sort, batch computation for parallel dispatch
    └── validation.ts          # Intent validation, result shape validation
```

### 3.3 Data Flow

```
ExecutionIntent
      │
      ▼
┌─────────────┐
│  Validate    │──── FAIL ──► FailedGraph (with validation errors)
│  Intent      │
└──────┬──────┘
       │ valid
       ▼
┌─────────────┐
│  Resolve     │──── FAIL ──► FailedGraph (core not found / version mismatch)
│  Cores       │
└──────┬──────┘
       │ all resolved
       ▼
┌─────────────┐
│  Build Dep   │
│  Graph       │
└──────┬──────┘
       │ execution batches
       ▼
┌─────────────┐     ┌──────────────┐
│  Dispatch    │────►│ Core Service │──── CoreExecutionResult
│  Batch N     │     │  (parallel)  │     { agents_executed, repos_touched,
└──────┬──────┘     └──────────────┘       artifacts_generated, evidence_refs }
       │ all batches done
       ▼
┌─────────────┐
│  Validate    │──── evidence missing? ──► Mark FAILED (if policy requires)
│  Evidence    │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  Build       │
│  Exec Graph  │
└──────┬──────┘
       │
       ▼
  ExecutionGraph
  (nodes, edges, core_results, evidence_summary)
```

### 3.4 Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Core resolution | Via `agentics-contracts` only | Ensures all Cores are registered, versioned, and contract-compliant. Prevents bypassing the contract layer. |
| Dispatch strategy | Topological batching | Enables parallelism where possible while respecting Core dependencies. |
| Evidence validation | Post-execution, mandatory by default | Evidence is the proof that work was done. Making it mandatory ensures accountability. |
| Trace model | Append-only event log | Immutability guarantees auditability. Events are never modified after recording. |
| Graph output | Always produced | Even failed executions need a graph for debugging and accountability. |
| Retry policy | Configurable, transient-only | Only retry on transient errors (network, timeout). Never retry on logic failures. |

### 3.5 Error Handling Strategy

```
Error Category          │ Behavior
────────────────────────┼──────────────────────────────────────
Intent validation fail  │ Immediate reject. No dispatch occurs.
Core not found          │ Immediate reject. No dispatch occurs.
Core version mismatch   │ Immediate reject. No dispatch occurs.
Core timeout            │ Record as failed. Continue other Cores if independent.
Core connection error   │ Retry with exponential backoff (max 3 attempts).
Core returns bad shape  │ Record as failed with INVALID_RESPONSE.
Core returns failed     │ Record. Stop dependent Cores. Continue independents.
Evidence missing        │ Mark execution FAILED (unless policy overrides).
```

---

## 4. Refinement

### 4.1 Edge Cases

| Case | Handling |
|------|----------|
| Empty `cores_required` array | Reject intent with validation error. At least one Core is required. |
| Core returns `partial` status | Treat as success for dispatch continuation but flag in evidence validation. Partial results may have incomplete evidence. |
| Circular Core dependencies | Detected during topological sort. Reject with dependency cycle error before any dispatch. |
| Duplicate Core names in intent | Reject. Each Core may appear at most once per intent. |
| Core returns extra evidence not required | Accept and include in graph. Only validate that *required* evidence is present. |
| Timeout during evidence validation | Evidence validation is local (no I/O). Should not timeout. If it does, this is a bug — fail loudly. |
| All Cores succeed but global `minimum_evidence_count` not met | Execution FAILS. The global policy is a safety net beyond per-Core requirements. |
| Core endpoint returns non-JSON | Treat as `INVALID_RESPONSE`. Record raw response in trace for debugging. |

### 4.2 Performance Considerations

- **Parallel dispatch** within batches is critical. Cores in the same batch MUST be dispatched concurrently.
- **Trace events** should use pre-allocated buffers. Under high concurrency (50+ executions), append-only logs must not contend.
- **Core resolution** results should be cached with TTL matching the contract registry's cache policy. Avoid resolving the same Core on every execution.
- **Execution graph construction** is a pure transformation of the trace. It should add < 10ms overhead.

### 4.3 Security Considerations

- **Intent validation** must sanitize all string inputs to prevent injection into downstream Core requests.
- **Core endpoints** must be HTTPS only. No plaintext HTTP dispatch.
- **Evidence URIs** must be validated as well-formed URIs but NOT fetched by the engine. The engine records references, not content.
- **Execution traces** may contain sensitive data. Access must be scoped to the `requested_by` identity.
- **Contract hashes** from `agentics-contracts` should be verified before dispatch to prevent tampering.

### 4.4 Observability

The engine MUST emit:
- **Metrics**: execution count, latency (p50/p95/p99), core dispatch count, evidence pass/fail rate, error rate by category.
- **Structured logs**: one log line per trace event, correlation via `execution_id`.
- **Execution graph**: the primary observability artifact. Must be queryable after execution completes.

### 4.5 Testing Strategy

| Layer | Approach |
|-------|----------|
| `execution_dispatcher.ts` | Integration tests with mocked Core Adapter. Verify full lifecycle: intent → graph. |
| `core_adapter.ts` | Unit tests with mocked HTTP client and contract registry. Verify resolution, dispatch, retry, timeout. |
| `execution_trace.ts` | Unit tests. Verify append-only invariant, event ordering, node/edge derivation. |
| `evidence_validator.ts` | Unit tests with various combinations: all present, some missing, malformed, partial Core results. |
| End-to-end | Spin up mock Core services. Submit intents. Verify complete execution graphs. |

---

## 5. Completion

### 5.1 Deliverables

| File | Purpose | Lines (est.) |
|------|---------|-------------|
| `src/execution_dispatcher.ts` | Main orchestrator. Accepts intent, coordinates resolution/dispatch/validation, returns graph. | 150-200 |
| `src/core_adapter.ts` | Resolves Cores from `agentics-contracts`. Dispatches HTTP requests to Core endpoints. Handles retries. | 120-160 |
| `src/execution_trace.ts` | Append-only event log. Converts trace into graph nodes and edges. | 100-140 |
| `src/evidence_validator.ts` | Validates all required evidence is present and well-formed. | 80-120 |
| `src/types/intent.ts` | Type definitions for ExecutionIntent, CoreRequirement, EvidencePolicy. | 40-60 |
| `src/types/core.ts` | Type definitions for ResolvedCore, CoreExecutionResult, AgentRecord, RepoRecord, ArtifactRecord. | 60-80 |
| `src/types/evidence.ts` | Type definitions for EvidenceRef, EvidenceSummary, MissingEvidence. | 30-40 |
| `src/types/graph.ts` | Type definitions for ExecutionGraph, ExecutionNode, ExecutionEdge. | 40-60 |
| `src/types/errors.ts` | Typed error codes and ExecutionError. | 30-40 |
| `src/utils/dependency_graph.ts` | Topological sort and batch computation. | 60-80 |
| `src/utils/validation.ts` | Intent and result shape validation. | 50-70 |

### 5.2 Acceptance Criteria

1. **Intent accepted**: Engine accepts a valid `ExecutionIntent` and returns an `ExecutionGraph`.
2. **Core resolution**: All Cores resolved exclusively from `agentics-contracts`. Direct repo dispatch is impossible.
3. **Parallel dispatch**: Independent Cores are dispatched concurrently within batches.
4. **Structured results**: Every `CoreExecutionResult` includes `agents_executed[]`, `repos_touched[]`, `artifacts_generated[]`, `evidence_refs[]`.
5. **Evidence enforcement**: Execution FAILS when required evidence is missing (default behavior).
6. **Full graph**: Output always includes a complete `ExecutionGraph` with nodes, edges, core results, and evidence summary.
7. **Immutable trace**: Trace events are append-only and never modified after creation.
8. **Error resilience**: Failed Cores do not crash the engine. Independent Cores continue. Graph always produced.
9. **All tests pass**: Unit tests for each module. Integration test for full lifecycle.

### 5.3 Definition of Done

- [ ] All four source files implemented and passing lint
- [ ] All type definitions in `src/types/` are complete
- [ ] Unit tests for every module with > 90% coverage
- [ ] Integration test: submit intent → receive graph with evidence
- [ ] Negative test: missing evidence → execution marked FAILED
- [ ] Negative test: Core not found → immediate rejection with error graph
- [ ] Negative test: circular dependency → rejection before dispatch
- [ ] Build passes (`npm run build`)
- [ ] Lint passes (`npm run lint`)
- [ ] No hardcoded endpoints, secrets, or credentials

### 5.4 Dependency Summary

| Dependency | Purpose |
|------------|---------|
| `agentics-contracts` | Core registry and contract resolution |
| HTTP client (e.g., `fetch`, `undici`) | Dispatch to Core service endpoints |
| UUID generator | Execution IDs, event IDs |
| Semver library | Version constraint matching |

---

*End of SPARC Specification*
