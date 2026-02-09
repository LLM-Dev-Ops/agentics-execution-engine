# ADR-001: Core Resolution Exclusively via agentics-contracts

**Status:** Accepted
**Date:** 2026-02-09
**Deciders:** Reuven Cohen
**References:** SPARC-specification.md FR-2, Section 3.4

---

## Context

The Agentics Execution Engine must dispatch work to Core services. Cores could theoretically be addressed in multiple ways:

1. **Direct repository references** — caller provides a Git URL or package name, and the engine clones/invokes it.
2. **Service discovery** — engine queries a runtime service mesh (e.g., Consul, Kubernetes DNS) to find Core endpoints.
3. **Contract registry** — engine resolves Cores exclusively through `agentics-contracts`, a versioned registry of Core contracts that maps logical Core names to service endpoints.

The choice has significant implications for security, versioning, auditability, and the ability to enforce behavioral contracts on Cores.

## Decision

**All Core resolution MUST go through `agentics-contracts`.** The engine will never accept or dispatch to raw repository URLs, package names, or arbitrary endpoints.

### Resolution Flow

```
CoreRequirement { core_name, version_constraint }
        │
        ▼
┌─────────────────────┐
│  agentics-contracts  │
│  Contract Registry   │
│                     │
│  lookup(core_name)  │──► Contract { versions[], capabilities, contract_hash }
│                     │
│  findSatisfying(    │──► { version, service_endpoint, contract_hash }
│    version_constraint│
│  )                  │
└─────────────────────┘
        │
        ▼
ResolvedCore { name, version, endpoint, capabilities, contract_hash }
```

### Contract Verification

Before dispatching to a resolved Core, the engine MUST verify the `contract_hash` matches the expected hash from the registry. This prevents man-in-the-middle substitution of Core endpoints.

## Consequences

### Positive

- **No bypass possible.** Callers cannot sidestep the contract layer by passing arbitrary URLs.
- **Version governance.** Every Core dispatch is against a known, semver-constrained version.
- **Auditability.** Every execution can be traced back to a specific contract version and hash.
- **Behavioral contracts.** The registry can enforce that Cores implement the required result shape (`agents_executed[]`, `repos_touched[]`, etc.) before registration.
- **Centralized deprecation.** A Core version can be removed from the registry, and all engines will stop dispatching to it immediately.

### Negative

- **Registry is a single point of failure.** If `agentics-contracts` is down, no Core resolution occurs. Mitigated by caching resolved Cores with a TTL (see ADR-003).
- **Development friction.** Developers cannot test against unregistered Cores directly through the engine. They must register a development version in the contract registry first (or use a local mock registry).
- **Latency.** Every execution adds a registry lookup. Mitigated by caching.

### Neutral

- The engine has no opinion on how Cores are *implemented* (container, serverless, bare metal). It only knows the endpoint from the registry.

## Alternatives Considered

### Direct Repository References

Rejected. Allows callers to bypass versioning and behavioral contracts. No way to enforce result shape. No auditability of which version was invoked. Security risk from executing arbitrary code.

### Runtime Service Discovery

Rejected as the *primary* mechanism. Service discovery finds *instances* but doesn't enforce *contracts*. Could be used as a complementary layer beneath the contract registry (i.e., the registry endpoint itself could use service discovery), but the engine must not resolve Cores through service discovery directly.

## Compliance

- **FR-2**: "Resolve each `core_name` against the `agentics-contracts` registry."
- **FR-2**: "NEVER dispatch to raw repositories directly."
- **Section 1.5**: "Cores are resolved exclusively from `agentics-contracts`."
