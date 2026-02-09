# Domain-Driven Design: Domain Model

**Service:** Agentics Execution Engine
**Date:** 2026-02-09
**References:** bounded-contexts.md, SPARC-specification.md

---

## Aggregate Map

```
┌─────────────────────────────────────────────────────────────────────┐
│                         AGGREGATES                                  │
│                                                                     │
│  ┌─────────────────┐    ┌─────────────────┐    ┌────────────────┐  │
│  │  ExecutionRun    │    │  CoreRegistry   │    │ ExecutionTrace │  │
│  │  (Aggregate Root)│    │ (Aggregate Root)│    │(Aggregate Root)│  │
│  │                 │    │                 │    │                │  │
│  │  execution_id   │    │  cache          │    │  execution_id  │  │
│  │  intent         │    │  retry_policy   │    │  events[]      │  │
│  │  status         │    │  http_client    │    │  status        │  │
│  │  resolved_cores │    │                 │    │                │  │
│  │  core_results   │    │  resolveCore()  │    │  appendEvent() │  │
│  │  trace ─────────┼────┼─────────────────┼───►│  toNodes()     │  │
│  │  evidence ──────┼──┐ │  dispatch()     │    │  toEdges()     │  │
│  │  graph          │  │ │  validateShape()│    │  seal()        │  │
│  └─────────────────┘  │ └─────────────────┘    └────────────────┘  │
│                       │                                             │
│                       │ ┌─────────────────────┐                    │
│                       │ │  EvidenceValidator   │                    │
│                       │ │  (Domain Service)    │                    │
│                       │ │                     │                    │
│                       └►│  validate()          │                    │
│                         │  isWellFormed()      │                    │
│                         └─────────────────────┘                    │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Value Object Catalog

All domain objects below are immutable after construction. They carry no identity — equality is structural.

### Intent Domain

```
ExecutionIntent
├── intent_id:         string
├── requested_by:      string
├── cores_required:    CoreRequirement[]
├── parameters:        Record<string, unknown>
├── evidence_policy:   EvidencePolicy
├── timeout_ms:        number
└── metadata?:         Record<string, unknown>

CoreRequirement
├── core_name:         string
├── version_constraint: string
├── inputs:            Record<string, unknown>
└── evidence_required: string[]

EvidencePolicy
├── fail_on_missing:          boolean  (default: true)
├── required_evidence_types:  string[]
└── minimum_evidence_count:   number
```

### Core Domain

```
ResolvedCore
├── name:              string
├── version:           string
├── endpoint:          string  (HTTPS only)
├── capabilities:      string[]
└── contract_hash:     string  (SHA-256)

CoreExecutionResult
├── core_name:         string
├── core_version:      string
├── status:            "success" | "partial" | "failed"
├── agents_executed:   AgentRecord[]
├── repos_touched:     RepoRecord[]
├── artifacts_generated: ArtifactRecord[]
├── evidence_refs:     EvidenceRef[]
├── duration_ms:       number
└── error?:            ExecutionError

AgentRecord
├── agent_id:          string
├── agent_type:        string
├── task_description:  string
├── status:            "completed" | "failed" | "skipped"
└── duration_ms:       number

RepoRecord
├── repo_uri:          string
├── branch:            string
├── commits:           string[]
└── files_changed:     string[]

ArtifactRecord
├── artifact_id:       string
├── artifact_type:     string
├── uri:               string
├── checksum:          string  (SHA-256)
└── size_bytes:        number
```

### Evidence Domain

```
EvidenceRef
├── evidence_type:     string
├── evidence_id:       string
├── uri:               string
├── produced_by:       string
├── timestamp:         string  (ISO 8601)
└── verifiable:        boolean

EvidenceSummary
├── total_required:    number
├── total_provided:    number
├── total_missing:     number
├── missing_evidence:  MissingEvidence[]
└── all_satisfied:     boolean

MissingEvidence
├── core_name:         string
├── evidence_type:     string
└── reason:            string
```

### Graph Domain

```
ExecutionGraph
├── execution_id:      string
├── intent_id:         string
├── status:            "completed" | "partial_failure" | "failed"
├── started_at:        string  (ISO 8601)
├── completed_at:      string  (ISO 8601)
├── total_duration_ms: number
├── nodes:             ExecutionNode[]
├── edges:             ExecutionEdge[]
├── core_results:      CoreExecutionResult[]
└── evidence_summary:  EvidenceSummary

ExecutionNode
├── node_id:           string
├── node_type:         "core_dispatch" | "evidence_validation" | "intent_resolution" | "aggregation"
├── core_name?:        string
├── status:            "pending" | "running" | "completed" | "failed"
├── started_at?:       string
├── completed_at?:     string
└── duration_ms?:      number

ExecutionEdge
├── from_node:         string
├── to_node:           string
└── edge_type:         "depends_on" | "produces" | "validates" | "triggers"
```

### Error Domain

```
ExecutionError
├── code:              ErrorCode  (see ADR-007 taxonomy)
├── message:           string
├── recoverable:       boolean
└── context?:          Record<string, unknown>
```

### Trace Domain

```
TraceEvent
├── event_id:          string
├── execution_id:      string
├── event_type:        TraceEventType
├── timestamp:         string  (ISO 8601)
└── data:              Readonly<Record<string, unknown>>  (deep frozen)
```

---

## Lifecycle State Machine

### ExecutionRun States

```
                    ┌──────────┐
                    │ PENDING  │
                    └────┬─────┘
                         │ intent validated
                         ▼
                    ┌──────────┐
        ┌───────── │ RUNNING  │ ─────────┐
        │          └────┬─────┘          │
        │               │               │
        ▼               ▼               ▼
  ┌──────────┐   ┌───────────┐   ┌──────────┐
  │ FAILED   │   │ PARTIAL   │   │COMPLETED │
  │          │   │ _FAILURE  │   │          │
  └──────────┘   └───────────┘   └──────────┘

Transitions:
  PENDING   → RUNNING          (always, after validation)
  RUNNING   → COMPLETED        (all cores succeed, all evidence present)
  RUNNING   → PARTIAL_FAILURE  (some cores failed, but evidence policy satisfied)
  RUNNING   → FAILED           (validation error, core not found, cycle, evidence missing)

No backward transitions. Terminal states: COMPLETED, PARTIAL_FAILURE, FAILED.
```

### ExecutionTrace States

```
  ┌──────┐        ┌────────┐
  │ OPEN │───────►│ SEALED │
  └──────┘        └────────┘

  OPEN:    Accepts appendEvent() calls.
  SEALED:  Rejects appendEvent(). Graph has been built.
```

---

## Domain Service Contracts

### ExecutionDispatcher (Application Service)

```
INTERFACE ExecutionDispatcher:
  dispatchExecution(intent: ExecutionIntent): Promise<ExecutionGraph>
```

Orchestrates the full lifecycle. This is an **application service**, not a domain service — it coordinates across bounded contexts.

### CoreAdapter (Domain Service in Core Resolution Context)

```
INTERFACE CoreAdapter:
  resolveCore(coreName: string, versionConstraint: string): Promise<ResolvedCore | null>
  dispatch(core: ResolvedCore, inputs: Record<string, unknown>, timeoutMs: number): Promise<CoreExecutionResult>
```

### EvidenceValidator (Domain Service in Evidence Context)

```
INTERFACE EvidenceValidator:
  validate(intent: ExecutionIntent, results: Map<string, CoreExecutionResult>): EvidenceSummary
```

Pure function. No I/O, no side effects. Synchronous.

### DependencyGraphBuilder (Domain Service in Execution Context)

```
INTERFACE DependencyGraphBuilder:
  buildDependencyGraph(cores: Array<{ requirement: CoreRequirement, resolved: ResolvedCore }>): DependencyGraph
  topologicalSort(graph: DependencyGraph): BatchedExecutionOrder

INTERFACE BatchedExecutionOrder:
  batches: Array<Array<{ requirement: CoreRequirement, resolved: ResolvedCore }>>
  hasCycle: boolean
```

---

## Dependency Injection Points

The Execution Context is the composition root. Dependencies are injected, not constructed internally.

```
ExecutionDispatcher
├── Injected: CoreAdapter           (interface, not concrete class)
├── Injected: EvidenceValidator     (interface, not concrete class)
├── Injected: DependencyGraphBuilder (interface, not concrete class)
├── Injected: IdGenerator           (interface, for execution_id and event_id)
└── Injected: Clock                 (interface, for timestamps — enables testing)
```

This enables:
- **Unit testing** with mock CoreAdapter (no real HTTP), mock Clock (deterministic timestamps).
- **Integration testing** with a real CoreAdapter but mock Core service endpoints.
- **Substitution** of the contract registry, HTTP client, or ID generation without modifying the dispatcher.

---

## Module-to-Context Mapping

| Source File | Bounded Context | Role |
|------------|----------------|------|
| `src/execution_dispatcher.ts` | Execution Context | Application service (composition root) |
| `src/core_adapter.ts` | Core Resolution Context | Domain service + anti-corruption layer |
| `src/execution_trace.ts` | Tracing Context | Aggregate root |
| `src/evidence_validator.ts` | Evidence Context | Stateless domain service |
| `src/types/intent.ts` | Shared Kernel | Value objects |
| `src/types/core.ts` | Shared Kernel | Value objects |
| `src/types/evidence.ts` | Shared Kernel | Value objects |
| `src/types/graph.ts` | Shared Kernel | Value objects |
| `src/types/errors.ts` | Shared Kernel | Value objects |
| `src/utils/dependency_graph.ts` | Execution Context | Domain service |
| `src/utils/validation.ts` | Execution Context | Domain service |
