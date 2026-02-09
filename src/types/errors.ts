export type ErrorCode =
  // Phase 1: Validation
  | 'INVALID_INTENT'
  | 'EMPTY_CORES'
  | 'DUPLICATE_CORE'
  | 'INVALID_EVIDENCE_POLICY'
  // Phase 2: Resolution
  | 'CORE_NOT_FOUND'
  | 'VERSION_MISMATCH'
  | 'REGISTRY_UNAVAILABLE'
  | 'CONTRACT_HASH_MISMATCH'
  // Phase 3: Dependency
  | 'CYCLE_DETECTED'
  // Phase 4: Dispatch
  | 'TIMEOUT'
  | 'CONNECTION_FAILED'
  | 'INVALID_RESPONSE'
  | 'CORE_EXECUTION_FAILED'
  | 'DEPENDENCY_FAILED'
  // Phase 5: Evidence
  | 'MISSING_EVIDENCE'
  | 'MALFORMED_EVIDENCE'
  | 'INSUFFICIENT_COUNT';

export interface ExecutionError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly recoverable: boolean;
  readonly context?: Readonly<Record<string, unknown>>;
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: readonly ExecutionError[];
}

export function makeError(
  code: ErrorCode,
  message: string,
  recoverable = false,
  context?: Record<string, unknown>,
): ExecutionError {
  return { code, message, recoverable, context };
}
