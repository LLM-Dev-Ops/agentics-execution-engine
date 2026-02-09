# Agentics Execution Engine — Design Documents

## SPARC Specification

- [SPARC-specification.md](./SPARC-specification.md) — Full specification, pseudocode, architecture, refinement, and completion criteria.

## Architecture Decision Records (ADRs)

| ADR | Title | Status |
|-----|-------|--------|
| [ADR-001](./adr/ADR-001-core-resolution-via-contracts.md) | Core Resolution Exclusively via agentics-contracts | Accepted |
| [ADR-002](./adr/ADR-002-topological-batch-dispatch.md) | Topological Batch Dispatch Strategy | Accepted |
| [ADR-003](./adr/ADR-003-core-resolution-caching.md) | Core Resolution Caching with TTL | Accepted |
| [ADR-004](./adr/ADR-004-append-only-execution-trace.md) | Append-Only Execution Trace | Accepted |
| [ADR-005](./adr/ADR-005-mandatory-evidence-validation.md) | Mandatory Evidence Validation with Fail-by-Default | Accepted |
| [ADR-006](./adr/ADR-006-execution-graph-always-produced.md) | Execution Graph Always Produced | Accepted |
| [ADR-007](./adr/ADR-007-error-handling-and-recovery.md) | Error Handling and Recovery Strategy | Accepted |
| [ADR-008](./adr/ADR-008-transport-and-security.md) | HTTPS-Only Transport with Contract Hash Verification | Accepted |

## Domain-Driven Design (DDD)

| Document | Contents |
|----------|----------|
| [Bounded Contexts](./ddd/bounded-contexts.md) | Four bounded contexts, aggregate roots, value objects, domain events, invariants, context map, ubiquitous language |
| [Domain Model](./ddd/domain-model.md) | Aggregate map, value object catalog, lifecycle state machines, service contracts, dependency injection points |
| [Context Interactions](./ddd/context-interactions.md) | Full execution sequence diagram, cross-context data flow, error propagation, inter-context contracts |

## ADR → SPARC Traceability

| ADR | SPARC References |
|-----|-----------------|
| ADR-001 | FR-2, Section 1.5, Section 3.4 |
| ADR-002 | FR-3, Section 3.4, Section 4.1, Section 4.2 |
| ADR-003 | NFR-2, NFR-3, Section 4.2 |
| ADR-004 | NFR-5, NFR-7, Section 3.4, CLAUDE.md (event sourcing) |
| ADR-005 | FR-5, Section 1.5, Section 4.1 |
| ADR-006 | FR-6, NFR-4, NFR-7, Section 3.4 |
| ADR-007 | FR-3, Section 3.5, Section 4.1 |
| ADR-008 | Section 4.3 |
