export interface ExecutionIntent {
  readonly intent_id: string;
  readonly requested_by: string;
  readonly cores_required: readonly CoreRequirement[];
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly evidence_policy: EvidencePolicy;
  readonly timeout_ms: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface CoreRequirement {
  readonly core_name: string;
  readonly version_constraint: string;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly evidence_required: readonly string[];
}

export interface EvidencePolicy {
  readonly fail_on_missing: boolean;
  readonly required_evidence_types: readonly string[];
  readonly minimum_evidence_count: number;
}
