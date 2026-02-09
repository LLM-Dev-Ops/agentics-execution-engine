import type { ExecutionIntent } from './types/intent.js';
import type { CoreExecutionResult } from './types/core.js';
import type { EvidenceSummary, MissingEvidence } from './types/evidence.js';
import { isWellFormedEvidence, describeEvidenceDefect } from './utils/validation.js';

export class EvidenceValidator {
  validate(
    intent: ExecutionIntent,
    results: Map<string, CoreExecutionResult>,
  ): EvidenceSummary {
    let totalRequired = 0;
    let totalProvided = 0;
    const missingEvidence: MissingEvidence[] = [];

    for (const requirement of intent.cores_required) {
      const coreResult = results.get(requirement.core_name);

      if (!coreResult || coreResult.status === 'failed') {
        for (const evidenceType of requirement.evidence_required) {
          totalRequired++;
          missingEvidence.push({
            core_name: requirement.core_name,
            evidence_type: evidenceType,
            reason: 'Core did not execute or failed',
          });
        }
        continue;
      }

      const providedTypes = new Set(
        coreResult.evidence_refs.map((e) => e.evidence_type),
      );

      for (const evidenceType of requirement.evidence_required) {
        totalRequired++;

        if (providedTypes.has(evidenceType)) {
          const matchingRef = coreResult.evidence_refs.find(
            (e) => e.evidence_type === evidenceType,
          );

          if (matchingRef && isWellFormedEvidence(matchingRef)) {
            totalProvided++;
          } else {
            missingEvidence.push({
              core_name: requirement.core_name,
              evidence_type: evidenceType,
              reason: matchingRef
                ? `Evidence ref is malformed: ${describeEvidenceDefect(matchingRef)}`
                : 'Evidence ref not found',
            });
          }
        } else {
          missingEvidence.push({
            core_name: requirement.core_name,
            evidence_type: evidenceType,
            reason: 'Core completed but did not provide this evidence type',
          });
        }
      }
    }

    if (intent.evidence_policy.minimum_evidence_count > totalProvided) {
      missingEvidence.push({
        core_name: '_global',
        evidence_type: '_minimum_count',
        reason: `Policy requires at least ${intent.evidence_policy.minimum_evidence_count} evidence items, got ${totalProvided}`,
      });
    }

    return {
      total_required: totalRequired,
      total_provided: totalProvided,
      total_missing: missingEvidence.length,
      missing_evidence: missingEvidence,
      all_satisfied: missingEvidence.length === 0,
    };
  }
}
