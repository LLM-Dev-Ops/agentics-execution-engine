import { describe, it, expect } from 'vitest';
import { EvidenceValidator } from '../src/evidence_validator.js';
import type { ExecutionIntent } from '../src/types/intent.js';
import type { CoreExecutionResult } from '../src/types/core.js';

function makeIntent(overrides: Partial<ExecutionIntent> = {}): ExecutionIntent {
  return {
    intent_id: 'intent-1',
    requested_by: 'user-1',
    cores_required: [
      {
        core_name: 'code-gen',
        version_constraint: '^1.0.0',
        inputs: {},
        evidence_required: ['test_report', 'coverage_report'],
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

function makeResult(overrides: Partial<CoreExecutionResult> = {}): CoreExecutionResult {
  return {
    core_name: 'code-gen',
    core_version: '1.0.0',
    status: 'success',
    agents_executed: [],
    repos_touched: [],
    artifacts_generated: [],
    evidence_refs: [
      {
        evidence_type: 'test_report',
        evidence_id: 'ev-1',
        uri: 'https://example.com/test',
        produced_by: 'code-gen',
        timestamp: '2026-02-09T12:00:00.000Z',
        verifiable: true,
      },
      {
        evidence_type: 'coverage_report',
        evidence_id: 'ev-2',
        uri: 'https://example.com/coverage',
        produced_by: 'code-gen',
        timestamp: '2026-02-09T12:00:00.000Z',
        verifiable: true,
      },
    ],
    duration_ms: 1000,
    ...overrides,
  };
}

describe('EvidenceValidator', () => {
  const validator = new EvidenceValidator();

  it('passes when all evidence is present and well-formed', () => {
    const results = new Map([['code-gen', makeResult()]]);
    const summary = validator.validate(makeIntent(), results);

    expect(summary.all_satisfied).toBe(true);
    expect(summary.total_required).toBe(2);
    expect(summary.total_provided).toBe(2);
    expect(summary.total_missing).toBe(0);
  });

  it('reports missing evidence type', () => {
    const result = makeResult({
      evidence_refs: [
        {
          evidence_type: 'test_report',
          evidence_id: 'ev-1',
          uri: 'https://example.com/test',
          produced_by: 'code-gen',
          timestamp: '2026-02-09T12:00:00.000Z',
          verifiable: true,
        },
        // coverage_report missing
      ],
    });
    const results = new Map([['code-gen', result]]);
    const summary = validator.validate(makeIntent(), results);

    expect(summary.all_satisfied).toBe(false);
    expect(summary.total_missing).toBe(1);
    expect(summary.missing_evidence[0].evidence_type).toBe('coverage_report');
    expect(summary.missing_evidence[0].reason).toContain('did not provide');
  });

  it('treats failed core evidence as all missing', () => {
    const result = makeResult({ status: 'failed', evidence_refs: [] });
    const results = new Map([['code-gen', result]]);
    const summary = validator.validate(makeIntent(), results);

    expect(summary.all_satisfied).toBe(false);
    expect(summary.total_missing).toBe(2);
    expect(summary.missing_evidence[0].reason).toContain('did not execute or failed');
  });

  it('treats absent core result as all missing', () => {
    const results = new Map<string, CoreExecutionResult>();
    const summary = validator.validate(makeIntent(), results);

    expect(summary.all_satisfied).toBe(false);
    expect(summary.total_missing).toBe(2);
  });

  it('detects malformed evidence', () => {
    const result = makeResult({
      evidence_refs: [
        {
          evidence_type: 'test_report',
          evidence_id: '',  // malformed: empty id
          uri: 'https://example.com/test',
          produced_by: 'code-gen',
          timestamp: '2026-02-09T12:00:00.000Z',
          verifiable: true,
        },
        {
          evidence_type: 'coverage_report',
          evidence_id: 'ev-2',
          uri: 'https://example.com/coverage',
          produced_by: 'code-gen',
          timestamp: '2026-02-09T12:00:00.000Z',
          verifiable: true,
        },
      ],
    });
    const results = new Map([['code-gen', result]]);
    const summary = validator.validate(makeIntent(), results);

    expect(summary.all_satisfied).toBe(false);
    expect(summary.total_provided).toBe(1);
    expect(summary.missing_evidence[0].reason).toContain('malformed');
  });

  it('enforces global minimum_evidence_count', () => {
    const intent = makeIntent({
      cores_required: [
        { core_name: 'code-gen', version_constraint: '^1.0.0', inputs: {}, evidence_required: [] },
      ],
      evidence_policy: {
        fail_on_missing: true,
        required_evidence_types: [],
        minimum_evidence_count: 5,
      },
    });
    const results = new Map([['code-gen', makeResult({ evidence_refs: [] })]]);
    const summary = validator.validate(intent, results);

    expect(summary.all_satisfied).toBe(false);
    expect(summary.missing_evidence.some((m) => m.evidence_type === '_minimum_count')).toBe(true);
  });

  it('passes with partial status if evidence is present', () => {
    const result = makeResult({ status: 'partial' });
    const results = new Map([['code-gen', result]]);
    const summary = validator.validate(makeIntent(), results);

    expect(summary.all_satisfied).toBe(true);
    expect(summary.total_provided).toBe(2);
  });
});
