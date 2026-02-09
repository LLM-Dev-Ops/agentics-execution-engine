# ADR-008: HTTPS-Only Transport with Contract Hash Verification

**Status:** Accepted
**Date:** 2026-02-09
**Deciders:** Reuven Cohen
**References:** SPARC-specification.md Section 4.3

---

## Context

The engine dispatches HTTP requests to Core service endpoints resolved from the contract registry. The transport layer must prevent:

- **Eavesdropping** — sensitive intent data or execution results intercepted in transit.
- **Tampering** — a Core endpoint substituted by a malicious actor.
- **Replay** — a stale or captured response replayed as a fresh result.

## Decision

**Enforce HTTPS-only for all Core dispatch. Verify contract hashes before dispatch.**

### HTTPS Enforcement

The `CoreAdapter` MUST reject any resolved endpoint that does not use the `https://` scheme. This is enforced at resolution time, not dispatch time.

```
FUNCTION resolveCore(coreName, versionConstraint):
  resolved = registry.lookup(coreName)
  IF NOT resolved.endpoint.startsWith("https://") THEN
    THROW SecurityError("Core endpoint must use HTTPS: " + resolved.endpoint)
```

No configuration flag to disable this. No `allowHttp` escape hatch. HTTPS is mandatory.

### Contract Hash Verification

When a Core is resolved, the registry returns a `contract_hash` (SHA-256 of the Core's contract definition). Before dispatching to the Core, the engine MUST:

1. Include the `contract_hash` in the dispatch request header (`X-Contract-Hash`).
2. The Core is expected to validate this hash against its own contract and reject requests with mismatched hashes.

This provides bidirectional verification:
- **Engine verifies Core** — the endpoint came from a registry entry with a specific hash.
- **Core verifies Engine** — the request includes the hash the engine resolved, which the Core can check against its own contract.

### Input Sanitization

Before dispatching, the engine sanitizes all string values in the `inputs` payload:
- Strip control characters.
- Validate string lengths against configurable maximums.
- Reject inputs containing embedded URIs to unexpected hosts (if injection detection is enabled).

This does NOT attempt deep semantic validation of inputs — that's the Core's responsibility. The engine provides a first layer of defense.

### Evidence URI Validation

Evidence URIs returned by Cores are validated as syntactically well-formed but are NOT fetched or dereferenced by the engine. The engine is a reference recorder, not a content fetcher.

```
FUNCTION isWellFormedUri(uri: string): boolean
  RETURN uri matches RFC 3986 URI syntax
     AND uri scheme is one of: https, s3, gs, artifact
```

## Consequences

### Positive

- **No plaintext traffic.** Prevents eavesdropping on intent data and execution results.
- **Tamper detection.** Hash mismatch reveals stale cache or substituted endpoint.
- **Defense in depth.** Input sanitization + HTTPS + hash verification layer protections.

### Negative

- **No local development over HTTP.** Developers must use self-signed certificates or a local HTTPS proxy. Mitigated by supporting a `NODE_TLS_REJECT_UNAUTHORIZED=0` environment variable in development mode only (never in production).
- **Hash verification requires Core cooperation.** If a Core doesn't validate the `X-Contract-Hash` header, the bidirectional check is one-sided. The engine-side check (verifying the hash from the registry) still provides protection.

## Compliance

- **Section 4.3**: "Core endpoints must be HTTPS only."
- **Section 4.3**: "Intent validation must sanitize all string inputs."
- **Section 4.3**: "Evidence URIs must be validated as well-formed URIs but NOT fetched."
- **Section 4.3**: "Contract hashes should be verified before dispatch."
