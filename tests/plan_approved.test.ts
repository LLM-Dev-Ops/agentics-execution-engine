import { describe, it, expect } from 'vitest';
import {
  parsePlanApprovedEvent,
  toExecutionIntent,
  PlanApprovedValidationError,
} from '../src/types/plan_approved.js';
import { CANONICAL_PLAN_APPROVED } from './fixtures/plan_approved.js';

function issuePaths(input: unknown): string[] {
  try {
    parsePlanApprovedEvent(input);
  } catch (err) {
    if (err instanceof PlanApprovedValidationError) return err.issues.map((i) => i.path);
    throw err;
  }
  throw new Error('expected the event to be rejected, but it was accepted');
}

describe('canonical plan_approved envelope', () => {
  it('accepts the canonical fixture', () => {
    const event = parsePlanApprovedEvent(CANONICAL_PLAN_APPROVED);
    expect(event.execution_id).toBe('exec-ruvector-minted-1');
    expect(event.intent_id).toBe('intent-1');
  });

  it('tolerates extra transport fields such as event_id', () => {
    expect(() => parsePlanApprovedEvent({ ...CANONICAL_PLAN_APPROVED, source: 'ruvector' })).not.toThrow();
  });

  it('maps the envelope onto an ExecutionIntent keyed on the envelope intent_id', () => {
    const intent = toExecutionIntent(parsePlanApprovedEvent(CANONICAL_PLAN_APPROVED));

    expect(intent.intent_id).toBe('intent-1');
    expect(intent.requested_by).toBe('policy:policy-engine');
    expect(intent.cores_required).toHaveLength(1);
    expect(intent.cores_required[0].core_name).toBe('security-core');
    expect(intent.timeout_ms).toBe(30_000);
    // execution_id stays on the envelope side; it is never read off the intent root.
    expect(intent.metadata?.execution_id).toBe('exec-ruvector-minted-1');
    expect((intent as Record<string, unknown>).execution_id).toBeUndefined();
  });
});

// ADR-009 Verification 4: each of the three pre-ADR shapes is rejected with a
// field-level error rather than being silently skipped.
describe('legacy plan_approved shapes are rejected', () => {
  it('rejects the orchestration-engine {type, runId, source, timestamp, payload} envelope', () => {
    const legacy = {
      type: 'plan_approved',
      runId: 'run-1753622400000-ab12cd',
      source: 'orchestration',
      timestamp: '2026-07-27T12:00:00.000Z',
      payload: { some: 'body' },
    };

    const paths = issuePaths(legacy);
    expect(paths).toContain('execution_id');
    expect(paths).toContain('plan_id');
    expect(paths).toContain('simulation_id');
    expect(paths).toContain('intent_id');
    expect(paths).toContain('execution_profile');
    expect(paths).toContain('approver');
  });

  it('rejects the simulation_id-keyed PlanApprovedEvent', () => {
    const legacy = {
      event_id: 'evt-1',
      type: 'plan_approved',
      plan_id: 'plan-1',
      simulation_id: 'sim-1',
      execution_profile: { tier: 'tier1', mode: 'execute' },
      timestamp: '2026-07-27T12:00:00.000Z',
    };

    const paths = issuePaths(legacy);
    expect(paths).toContain('execution_id');
    expect(paths).toContain('intent_id');
    expect(paths).toContain('approver');
    // its execution_profile carries routing hints, not the execution details
    expect(paths).toContain('execution_profile.cores_required');
    expect(paths).toContain('execution_profile.evidence_policy');
    expect(paths).toContain('execution_profile.timeout_ms');
  });

  it('rejects a bare ExecutionIntent', () => {
    const legacy = {
      intent_id: 'intent-1',
      requested_by: 'tester',
      cores_required: [{ core_name: 'security-core', version_constraint: '^1.0.0', inputs: {}, evidence_required: [] }],
      parameters: {},
      evidence_policy: { fail_on_missing: true, required_evidence_types: [], minimum_evidence_count: 0 },
      timeout_ms: 1000,
    };

    const paths = issuePaths(legacy);
    expect(paths).toContain('type');
    expect(paths).toContain('execution_id');
    expect(paths).toContain('execution_profile');
  });

  it('names the offending field in the error message', () => {
    const { execution_id, ...missingExecutionId } = CANONICAL_PLAN_APPROVED;
    expect(() => parsePlanApprovedEvent(missingExecutionId)).toThrow(/execution_id/);
  });

  it('rejects an empty execution_id rather than treating it as present', () => {
    expect(issuePaths({ ...CANONICAL_PLAN_APPROVED, execution_id: '' })).toContain('execution_id');
  });

  it('rejects an execution_profile with no cores to dispatch', () => {
    const paths = issuePaths({
      ...CANONICAL_PLAN_APPROVED,
      execution_profile: { ...CANONICAL_PLAN_APPROVED.execution_profile, cores_required: [] },
    });
    expect(paths).toContain('execution_profile.cores_required');
  });

  it('rejects a non-ISO timestamp', () => {
    expect(issuePaths({ ...CANONICAL_PLAN_APPROVED, timestamp: 'yesterday' })).toContain('timestamp');
  });

  it('rejects null and non-object payloads', () => {
    expect(issuePaths(null)).toContain('<root>');
    expect(issuePaths('plan_approved')).toContain('<root>');
  });
});
