# ADR-003: Core Resolution Caching with TTL

**Status:** Accepted
**Date:** 2026-02-09
**Deciders:** Reuven Cohen
**References:** SPARC-specification.md NFR-2, Section 4.2

---

## Context

Per ADR-001, every execution resolves Cores from `agentics-contracts`. Under load (NFR-6: 50+ concurrent executions), repeated resolution of the same Core name + version would create unnecessary registry traffic and add latency. The registry lookup target is < 200ms per Core (NFR-2), and the engine overhead target is < 500ms total (NFR-3).

## Decision

**Cache resolved Core entries in-memory with a configurable TTL.**

### Cache Design

```
Cache Key:    "${core_name}:${version_constraint}"
Cache Value:  ResolvedCore { name, version, endpoint, capabilities, contract_hash }
TTL:          Configurable, default 60 seconds
Eviction:     Time-based expiry. No LRU — cache size is bounded by the number of distinct Cores.
Invalidation: On contract_hash mismatch during dispatch (stale entry detected).
```

### Cache Behavior

| Scenario | Behavior |
|----------|----------|
| Cache hit, TTL valid | Return cached `ResolvedCore`. Skip registry call. |
| Cache miss | Call registry. Store result. Return. |
| Cache hit, TTL expired | Call registry. Update cache. Return. |
| Dispatch detects hash mismatch | Evict cache entry. Re-resolve from registry. Retry dispatch once. |

### Cache Scope

The cache is **per-engine-instance**, not shared across instances. Each engine process maintains its own cache. This avoids the complexity of distributed cache invalidation while still providing the primary benefit (reducing registry calls within a single process under load).

### No Negative Caching

If a Core is not found in the registry, the result is NOT cached. A subsequent request for the same Core will hit the registry again. This prevents a transient registry issue from permanently blocking resolution.

## Consequences

### Positive

- **Reduced registry load.** Identical Core requirements across concurrent executions share a single resolution.
- **Faster execution.** Cached resolution is < 1ms vs. up to 200ms for a registry call.
- **Self-healing.** Hash mismatch triggers re-resolution, preventing stale endpoints from persisting.

### Negative

- **Stale window.** For up to TTL seconds, the engine may dispatch to an outdated Core version. Mitigated by the hash check and a conservative default TTL (60s).
- **Memory usage.** Negligible. Each cache entry is a small struct. Even 1000 distinct Cores would use < 1MB.

## Compliance

- **NFR-2**: Cache makes typical resolution < 1ms after first call.
- **NFR-3**: Reduces overall engine overhead.
- **Section 4.2**: "Core resolution results should be cached with TTL matching the contract registry's cache policy."
