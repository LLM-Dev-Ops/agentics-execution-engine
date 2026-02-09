import { describe, it, expect } from 'vitest';
import { validateIntent, isWellFormedEvidence, isValidIso8601, describeEvidenceDefect } from '../src/utils/validation.js';
import type { ExecutionIntent } from '../src/types/intent.js';
import type { EvidenceRef } from '../src/types/core.js';

function makeValidIntent(overrides: Partial<ExecutionIntent> = {}): ExecutionIntent {
  return {
    intent_id: 'test-intent-1',
    requested_by: 'test-user',
    cores_required: [
      {
        core_name: 'code-gen',
        version_constraint: '^1.0.0',
        inputs: {},
        evidence_required: ['test_report'],
      },
    ],
    parameters: {},
    evidence_policy: {
      fail_on_missing: true,
      required_evidence_types: [],
      minimum_evidence_count: 0,
    },
    timeout_ms: 30000,
    ...overrides,
  };
}

describe('validateIntent', () => {
  it('accepts a valid intent', () => {
    const result = validateIntent(makeValidIntent());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects empty intent_id', () => {
    const result = validateIntent(makeValidIntent({ intent_id: '' }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === 'INVALID_INTENT')).toBe(true);
  });

  it('rejects empty cores_required', () => {
    const result = validateIntent(makeValidIntent({ cores_required: [] }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === 'EMPTY_CORES')).toBe(true);
  });

  it('rejects duplicate core names', () => {
    const result = validateIntent(
      makeValidIntent({
        cores_required: [
          { core_name: 'dup', version_constraint: '^1.0.0', inputs: {}, evidence_required: [] },
          { core_name: 'dup', version_constraint: '^2.0.0', inputs: {}, evidence_required: [] },
        ],
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === 'DUPLICATE_CORE')).toBe(true);
  });

  it('rejects non-positive timeout_ms', () => {
    const result = validateIntent(makeValidIntent({ timeout_ms: 0 }));
    expect(result.valid).toBe(false);
  });

  it('rejects negative minimum_evidence_count', () => {
    const result = validateIntent(
      makeValidIntent({
        evidence_policy: {
          fail_on_missing: true,
          required_evidence_types: [],
          minimum_evidence_count: -1,
        },
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === 'INVALID_EVIDENCE_POLICY')).toBe(true);
  });
});

describe('isValidIso8601', () => {
  it('accepts valid ISO 8601 timestamps', () => {
    expect(isValidIso8601('2026-02-09T12:00:00.000Z')).toBe(true);
    expect(isValidIso8601('2026-02-09T12:00:00Z')).toBe(true);
    expect(isValidIso8601('2026-02-09T12:00:00+05:30')).toBe(true);
  });

  it('rejects invalid timestamps', () => {
    expect(isValidIso8601('not-a-date')).toBe(false);
    expect(isValidIso8601('')).toBe(false);
    expect(isValidIso8601('2026-02-09')).toBe(false);
  });
});

describe('isWellFormedEvidence', () => {
  const validRef: EvidenceRef = {
    evidence_type: 'test_report',
    evidence_id: 'ev-1',
    uri: 'https://example.com/report',
    produced_by: 'test-core',
    timestamp: '2026-02-09T12:00:00.000Z',
    verifiable: true,
  };

  it('accepts well-formed evidence', () => {
    expect(isWellFormedEvidence(validRef)).toBe(true);
  });

  it('rejects missing evidence_id', () => {
    expect(isWellFormedEvidence({ ...validRef, evidence_id: '' })).toBe(false);
  });

  it('rejects missing uri', () => {
    expect(isWellFormedEvidence({ ...validRef, uri: '' })).toBe(false);
  });

  it('rejects missing produced_by', () => {
    expect(isWellFormedEvidence({ ...validRef, produced_by: '' })).toBe(false);
  });

  it('rejects invalid timestamp', () => {
    expect(isWellFormedEvidence({ ...validRef, timestamp: 'bad' })).toBe(false);
  });
});

describe('describeEvidenceDefect', () => {
  it('lists all defects', () => {
    const ref: EvidenceRef = {
      evidence_type: 'test',
      evidence_id: '',
      uri: '',
      produced_by: '',
      timestamp: 'bad',
      verifiable: false,
    };
    const desc = describeEvidenceDefect(ref);
    expect(desc).toContain('missing evidence_id');
    expect(desc).toContain('missing uri');
    expect(desc).toContain('missing produced_by');
    expect(desc).toContain('invalid timestamp');
  });
});
