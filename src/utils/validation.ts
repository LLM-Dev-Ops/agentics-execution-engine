import type { ExecutionIntent } from '../types/intent.js';
import type { CoreExecutionResult, EvidenceRef } from '../types/core.js';
import type { ValidationResult, ExecutionError } from '../types/errors.js';
import { makeError } from '../types/errors.js';

export function validateIntent(intent: ExecutionIntent): ValidationResult {
  const errors: ExecutionError[] = [];

  if (!intent.intent_id || typeof intent.intent_id !== 'string') {
    errors.push(makeError('INVALID_INTENT', 'intent_id is required and must be a non-empty string'));
  }

  if (!intent.requested_by || typeof intent.requested_by !== 'string') {
    errors.push(makeError('INVALID_INTENT', 'requested_by is required and must be a non-empty string'));
  }

  if (!Array.isArray(intent.cores_required) || intent.cores_required.length === 0) {
    errors.push(makeError('EMPTY_CORES', 'cores_required must be a non-empty array'));
  } else {
    const coreNames = new Set<string>();
    for (const req of intent.cores_required) {
      if (!req.core_name || typeof req.core_name !== 'string') {
        errors.push(makeError('INVALID_INTENT', 'Each core requirement must have a non-empty core_name'));
      }
      if (coreNames.has(req.core_name)) {
        errors.push(makeError('DUPLICATE_CORE', `Duplicate core_name: ${req.core_name}`));
      }
      coreNames.add(req.core_name);

      if (!req.version_constraint || typeof req.version_constraint !== 'string') {
        errors.push(makeError('INVALID_INTENT', `Core ${req.core_name}: version_constraint is required`));
      }
    }
  }

  if (!intent.evidence_policy) {
    errors.push(makeError('INVALID_EVIDENCE_POLICY', 'evidence_policy is required'));
  } else {
    if (typeof intent.evidence_policy.fail_on_missing !== 'boolean') {
      errors.push(makeError('INVALID_EVIDENCE_POLICY', 'evidence_policy.fail_on_missing must be a boolean'));
    }
    if (typeof intent.evidence_policy.minimum_evidence_count !== 'number' || intent.evidence_policy.minimum_evidence_count < 0) {
      errors.push(makeError('INVALID_EVIDENCE_POLICY', 'evidence_policy.minimum_evidence_count must be a non-negative number'));
    }
  }

  if (typeof intent.timeout_ms !== 'number' || intent.timeout_ms <= 0) {
    errors.push(makeError('INVALID_INTENT', 'timeout_ms must be a positive number'));
  }

  return { valid: errors.length === 0, errors };
}

export function validateResultShape(result: unknown): result is CoreExecutionResult {
  if (typeof result !== 'object' || result === null) return false;
  const r = result as Record<string, unknown>;

  if (typeof r.core_name !== 'string') return false;
  if (typeof r.core_version !== 'string') return false;
  if (!['success', 'partial', 'failed'].includes(r.status as string)) return false;
  if (!Array.isArray(r.agents_executed)) return false;
  if (!Array.isArray(r.repos_touched)) return false;
  if (!Array.isArray(r.artifacts_generated)) return false;
  if (!Array.isArray(r.evidence_refs)) return false;
  if (typeof r.duration_ms !== 'number') return false;

  for (const artifact of r.artifacts_generated as Array<Record<string, unknown>>) {
    if (!artifact.checksum || typeof artifact.checksum !== 'string') return false;
  }

  for (const evidence of r.evidence_refs as Array<Record<string, unknown>>) {
    if (!evidence.evidence_id || typeof evidence.evidence_id !== 'string') return false;
    if (!evidence.uri || typeof evidence.uri !== 'string') return false;
  }

  return true;
}

const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

export function isValidIso8601(value: string): boolean {
  return ISO_8601_RE.test(value) && !isNaN(Date.parse(value));
}

export function isWellFormedEvidence(ref: EvidenceRef): boolean {
  return (
    !!ref.evidence_id &&
    !!ref.uri &&
    !!ref.produced_by &&
    isValidIso8601(ref.timestamp)
  );
}

export function describeEvidenceDefect(ref: EvidenceRef): string {
  const defects: string[] = [];
  if (!ref.evidence_id) defects.push('missing evidence_id');
  if (!ref.uri) defects.push('missing uri');
  if (!ref.produced_by) defects.push('missing produced_by');
  if (!isValidIso8601(ref.timestamp)) defects.push('invalid timestamp');
  return defects.join(', ');
}
