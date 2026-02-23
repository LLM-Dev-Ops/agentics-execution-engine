import { z } from 'zod';

// ---------------------------------------------------------------------------
// Pipeline contract types — imported by core/ modules
// ---------------------------------------------------------------------------

/** Logical service name → resolved HTTP endpoint */
export type ServiceEndpointMap = Readonly<Record<string, string>>;

/** Status of an overall pipeline run */
export type PipelineRunStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed';

/** One step inside a pipeline definition */
export interface StepDefinition {
  readonly stepId: string;
  readonly name: string;
  readonly targetService: string;
  readonly inputSchema: z.ZodType;
  readonly outputSchema: z.ZodType;
  readonly dependsOn: readonly string[];
}

/** Captured output of a single step execution */
export interface StepOutput {
  readonly stepId: string;
  readonly output: unknown;
  readonly durationMs: number;
  readonly completedAt: string;
}

/** Ordered list of steps forming a pipeline */
export interface PipelineDefinition {
  readonly pipelineId: string;
  readonly name: string;
  readonly version: string;
  readonly steps: readonly StepDefinition[];
}

/** Final decision produced by the MVP reference pipeline */
export interface DecisionPacket {
  readonly decision_id: string;
  readonly run_id: string;
  readonly recommendation: string;
  readonly confidence: number;
  readonly reasoning: string;
  readonly supporting_evidence: readonly string[];
  readonly risk_assessment: {
    readonly score: number;
    readonly factors: readonly string[];
  };
  readonly generated_at: string;
}

/** Structured error emitted when a pipeline run fails */
export interface ExecutionFailure {
  readonly run_id: string;
  readonly step_id: string;
  readonly error_code: ExecutionFailureCode;
  readonly message: string;
  readonly timestamp: string;
  readonly context?: Readonly<Record<string, unknown>>;
}

export type ExecutionFailureCode =
  | 'INPUT_VALIDATION_FAILED'
  | 'OUTPUT_VALIDATION_FAILED'
  | 'SERVICE_CALL_FAILED'
  | 'SERVICE_TIMEOUT'
  | 'RETRY_EXHAUSTED'
  | 'PIPELINE_ABORTED'
  | 'STATE_PERSISTENCE_FAILED';

// ---------------------------------------------------------------------------
// Zod schemas for each step of the MVP reference pipeline
// ---------------------------------------------------------------------------

/** Step 1: Intent Classification — input */
export const IntentClassificationInputSchema = z.object({
  text: z.string().min(1),
});

/** Step 1: Intent Classification — output */
export const IntentClassificationOutputSchema = z.object({
  intent_type: z.string().min(1),
  confidence: z.number().min(0).max(1),
  entities: z.record(z.string(), z.string()),
});

/** Step 2: Data Retrieval — input */
export const DataRetrievalInputSchema = z.object({
  intent_type: z.string().min(1),
  entities: z.record(z.string(), z.string()),
});

/** Step 2: Data Retrieval — output */
export const DataRetrievalOutputSchema = z.object({
  data_points: z.array(
    z.object({
      key: z.string(),
      value: z.unknown(),
      source: z.string(),
    }),
  ),
});

/** Step 3: Analysis — input */
export const AnalysisInputSchema = z.object({
  intent_type: z.string().min(1),
  data_points: z.array(
    z.object({
      key: z.string(),
      value: z.unknown(),
      source: z.string(),
    }),
  ),
});

/** Step 3: Analysis — output */
export const AnalysisOutputSchema = z.object({
  findings: z.array(
    z.object({
      finding: z.string(),
      confidence: z.number().min(0).max(1),
      supporting_data: z.array(z.string()),
    }),
  ),
  risk_score: z.number().min(0).max(1),
});

/** Step 4: Decision Synthesis — input */
export const DecisionSynthesisInputSchema = z.object({
  intent_type: z.string().min(1),
  findings: z.array(
    z.object({
      finding: z.string(),
      confidence: z.number().min(0).max(1),
      supporting_data: z.array(z.string()),
    }),
  ),
  risk_score: z.number().min(0).max(1),
  original_request: z.string().min(1),
});

/** Step 4: Decision Synthesis — output (DecisionPacket) */
export const DecisionPacketSchema = z.object({
  decision_id: z.string().min(1),
  run_id: z.string().min(1),
  recommendation: z.string().min(1),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  supporting_evidence: z.array(z.string()),
  risk_assessment: z.object({
    score: z.number().min(0).max(1),
    factors: z.array(z.string()),
  }),
  generated_at: z.string().min(1),
});
