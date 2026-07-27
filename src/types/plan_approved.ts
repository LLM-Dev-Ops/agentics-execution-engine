import { z } from 'zod';
import type { ExecutionIntent } from './intent.js';

// Mirrors the canonical `events/v1/plan-approved.schema.json` envelope defined by
// agentics-enforcement ADR-011 Decision 6. The schema package has not published the
// file yet, so the shape is asserted here; swap for the published schema once it lands.

const nonEmpty = z.string().min(1);

const isoTimestamp = nonEmpty.refine((v) => !Number.isNaN(Date.parse(v)), {
  message: 'must be an ISO-8601 timestamp',
});

const coreRequirementSchema = z.object({
  core_name: nonEmpty,
  version_constraint: nonEmpty,
  inputs: z.record(z.string(), z.unknown()).default({}),
  evidence_required: z.array(z.string()).default([]),
});

const evidencePolicySchema = z.object({
  fail_on_missing: z.boolean(),
  required_evidence_types: z.array(z.string()),
  minimum_evidence_count: z.number().int().min(0),
});

const executionProfileSchema = z.object({
  cores_required: z.array(coreRequirementSchema).min(1),
  parameters: z.record(z.string(), z.unknown()).default({}),
  evidence_policy: evidencePolicySchema,
  timeout_ms: z.number().positive(),
});

export const planApprovedEventSchema = z.object({
  type: z.literal('plan_approved'),
  execution_id: nonEmpty,
  plan_id: nonEmpty,
  simulation_id: nonEmpty,
  intent_id: nonEmpty,
  execution_profile: executionProfileSchema,
  approver: z.object({
    id: nonEmpty,
    type: z.enum(['user', 'system', 'policy']),
    name: z.string().optional(),
  }),
  timestamp: isoTimestamp,
  correlation_id: z.string().optional(),
});

export type PlanApprovedEvent = z.infer<typeof planApprovedEventSchema>;

export interface PlanApprovedIssue {
  readonly path: string;
  readonly message: string;
}

export class PlanApprovedValidationError extends Error {
  readonly issues: readonly PlanApprovedIssue[];

  constructor(issues: readonly PlanApprovedIssue[]) {
    const detail = issues.map((i) => `${i.path}: ${i.message}`).join('; ');
    super(`plan_approved event does not conform to events/v1/plan-approved.schema.json — ${detail}`);
    this.name = 'PlanApprovedValidationError';
    this.issues = issues;
  }
}

export function parsePlanApprovedEvent(input: unknown): PlanApprovedEvent {
  const result = planApprovedEventSchema.safeParse(input);
  if (result.success) return result.data;

  throw new PlanApprovedValidationError(
    result.error.issues.map((issue) => ({
      path: issue.path.length > 0 ? issue.path.join('.') : '<root>',
      message: issue.message,
    })),
  );
}

export function toExecutionIntent(event: PlanApprovedEvent): ExecutionIntent {
  const profile = event.execution_profile;
  return {
    intent_id: event.intent_id,
    requested_by: `${event.approver.type}:${event.approver.id}`,
    cores_required: profile.cores_required,
    parameters: profile.parameters,
    evidence_policy: profile.evidence_policy,
    timeout_ms: profile.timeout_ms,
    metadata: {
      execution_id: event.execution_id,
      plan_id: event.plan_id,
      simulation_id: event.simulation_id,
      correlation_id: event.correlation_id,
      approved_at: event.timestamp,
    },
  };
}
