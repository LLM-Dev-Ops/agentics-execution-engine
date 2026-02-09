export interface EvidenceSummary {
  readonly total_required: number;
  readonly total_provided: number;
  readonly total_missing: number;
  readonly missing_evidence: readonly MissingEvidence[];
  readonly all_satisfied: boolean;
}

export interface MissingEvidence {
  readonly core_name: string;
  readonly evidence_type: string;
  readonly reason: string;
}
