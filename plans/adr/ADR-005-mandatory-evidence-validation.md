# ADR-005: Mandatory Evidence Validation with Fail-by-Default Policy

**Status:** Accepted
**Date:** 2026-02-09
**Deciders:** Reuven Cohen
**References:** SPARC-specification.md FR-5, Section 1.5, Section 4.1

---

## Context

The Agentics platform's value proposition depends on verifiable execution. When a Core claims it executed agents, touched repos, and generated artifacts, there must be *proof*. Without mandatory evidence, the platform degrades into a fire-and-forget dispatcher with no accountability.

The question is: how strict should the evidence requirement be?

1. **Advisory** — check evidence, log warnings, but never fail.
2. **Fail-by-default, opt-out available** — fail on missing evidence unless the caller explicitly overrides.
3. **Fail-always** — no override possible. Missing evidence = failed execution.

## Decision

**Fail-by-default with explicit opt-out.** The `EvidencePolicy.fail_on_missing` field defaults to `true`. Callers may set it to `false` for specific use cases (e.g., development, dry-run), but they must do so explicitly.

### Validation Layers

Evidence validation operates at two levels:

#### Per-Core Validation

Each `CoreRequirement` declares `evidence_required: string[]`. After a Core completes, the engine checks that every listed evidence type has a corresponding `EvidenceRef` in the result.

```
CoreRequirement.evidence_required = ["test_report", "coverage_report"]
CoreExecutionResult.evidence_refs  = [{ evidence_type: "test_report", ... }]

Result: MISSING "coverage_report" → evidence gap
```

#### Global Policy Validation

The intent-level `EvidencePolicy` can impose additional constraints:

- `required_evidence_types`: evidence types that must appear across *any* Core result.
- `minimum_evidence_count`: minimum total number of evidence items across all Cores.

### Well-Formedness Check

Even when evidence *exists*, it must be well-formed:

```
A valid EvidenceRef MUST have:
  - evidence_id:  non-empty string
  - uri:          non-empty, well-formed URI
  - produced_by:  non-empty string
  - timestamp:    valid ISO 8601
```

A malformed evidence ref is treated as *missing*. The engine does not silently accept broken evidence.

### Failure Semantics

When evidence validation fails and `fail_on_missing` is `true`:

1. The execution status is set to `"failed"`.
2. The `EvidenceSummary.missing_evidence[]` array lists every gap with its reason.
3. The execution trace records an `EVIDENCE_VALIDATED` event with the full summary.
4. The execution trace records an `EXECUTION_FAILED` event with reason `"Missing required evidence"`.
5. The execution graph is still produced (per ADR-006) — it just shows the failed status.

No Core results are discarded. The caller receives everything: the Core results, the evidence gaps, and the graph. They can inspect what succeeded and what didn't.

## Consequences

### Positive

- **Accountability.** Every execution either proves its work or explicitly fails. No ambiguous middle ground.
- **Trust.** Downstream consumers of execution results can rely on evidence being present.
- **Debuggability.** When evidence is missing, the `MissingEvidence[]` array explains exactly what's missing and why.
- **Flexibility.** The opt-out (`fail_on_missing: false`) exists for legitimate use cases without compromising the default.

### Negative

- **Strictness.** A Core that does valid work but fails to format its evidence correctly will cause the execution to fail. This is intentional — evidence formatting is part of the Core's contract.
- **Core burden.** Every Core must produce well-formed evidence refs. This is additional work for Core developers. Mitigated by providing clear documentation and validation errors that explain exactly what's wrong.

## Alternatives Considered

### Advisory (Warn Only)

Rejected. Warnings are ignored. If evidence is optional, Cores will stop providing it, and the platform loses its verifiability guarantee.

### Fail-Always (No Override)

Considered. Too rigid for development and testing workflows where Cores are being built incrementally. The explicit opt-out preserves strictness as the default while allowing pragmatic exceptions.

## Compliance

- **FR-5**: "Fail execution if any required evidence is missing."
- **Section 1.5**: "Evidence validation is mandatory by default."
- **Section 4.1**: "Core returns `partial` status: Treat as success for dispatch continuation but flag in evidence validation."
