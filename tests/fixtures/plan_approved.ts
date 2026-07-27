/** Canonical `plan_approved` envelope per agentics-enforcement ADR-011 Decision 6. */
export const CANONICAL_PLAN_APPROVED = {
  event_id: 'evt-1',
  type: 'plan_approved',
  execution_id: 'exec-ruvector-minted-1',
  plan_id: 'plan-1',
  simulation_id: 'sim-1',
  intent_id: 'intent-1',
  execution_profile: {
    cores_required: [
      {
        core_name: 'security-core',
        version_constraint: '^1.0.0',
        inputs: { scan: 'full' },
        evidence_required: ['scan_report'],
      },
    ],
    parameters: { region: 'us-east-1' },
    evidence_policy: {
      fail_on_missing: true,
      required_evidence_types: ['scan_report'],
      minimum_evidence_count: 1,
    },
    timeout_ms: 30_000,
  },
  approver: { id: 'policy-engine', type: 'policy' as const },
  timestamp: '2026-07-27T12:00:00.000Z',
  correlation_id: 'corr-1',
};
