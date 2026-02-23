import type {
  PipelineDefinition,
  StepDefinition,
  DecisionPacket,
  ServiceEndpointMap,
  ExecutionFailure,
} from '../types/pipeline.js';
import {
  IntentClassificationInputSchema,
  IntentClassificationOutputSchema,
  DataRetrievalInputSchema,
  DataRetrievalOutputSchema,
  AnalysisInputSchema,
  AnalysisOutputSchema,
  DecisionSynthesisInputSchema,
  DecisionPacketSchema,
} from '../types/pipeline.js';
import type { HttpClient } from '../core_adapter.js';
import type { RuvectorClient } from '../ruvector_client.js';
import { ExecutionContext } from './ExecutionContext.js';
import { StepRunner, StepExecutionError } from './StepRunner.js';

// ---------------------------------------------------------------------------
// MVP Reference Pipeline — static, deterministic, no dynamic discovery
// ---------------------------------------------------------------------------

export const MVP_REFERENCE_PIPELINE: PipelineDefinition = {
  pipelineId: 'mvp-reference-pipeline-v1',
  name: 'MVP Reference Pipeline',
  version: '1.0.0',
  steps: [
    {
      stepId: 'step-1-intent-classification',
      name: 'Intent Classification',
      targetService: 'intent-classifier',
      inputSchema: IntentClassificationInputSchema,
      outputSchema: IntentClassificationOutputSchema,
      dependsOn: [],
    },
    {
      stepId: 'step-2-data-retrieval',
      name: 'Data Retrieval',
      targetService: 'data-retriever',
      inputSchema: DataRetrievalInputSchema,
      outputSchema: DataRetrievalOutputSchema,
      dependsOn: ['step-1-intent-classification'],
    },
    {
      stepId: 'step-3-analysis',
      name: 'Analysis',
      targetService: 'analyzer',
      inputSchema: AnalysisInputSchema,
      outputSchema: AnalysisOutputSchema,
      dependsOn: ['step-2-data-retrieval'],
    },
    {
      stepId: 'step-4-decision-synthesis',
      name: 'Decision Synthesis',
      targetService: 'decision-synthesizer',
      inputSchema: DecisionSynthesisInputSchema,
      outputSchema: DecisionPacketSchema,
      dependsOn: ['step-3-analysis'],
    },
  ],
};

// ---------------------------------------------------------------------------
// Executor configuration
// ---------------------------------------------------------------------------

export interface MvpPipelineExecutorDeps {
  readonly httpClient: HttpClient;
  readonly ruvectorClient: RuvectorClient | null;
  readonly endpointMap: ServiceEndpointMap;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 1;

// ---------------------------------------------------------------------------
// MvpPipelineExecutor — strictly sequential, deterministic execution
// ---------------------------------------------------------------------------

export class MvpPipelineExecutor {
  private readonly stepRunner: StepRunner;
  private readonly pipeline: PipelineDefinition;

  constructor(deps: MvpPipelineExecutorDeps) {
    this.stepRunner = new StepRunner({
      httpClient: deps.httpClient,
      ruvectorClient: deps.ruvectorClient,
      endpointMap: deps.endpointMap,
      timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    this.pipeline = MVP_REFERENCE_PIPELINE;
  }

  /**
   * Execute the MVP reference pipeline end-to-end.
   *
   * 1. Instantiate ExecutionContext with UUIDv7 runId
   * 2. Walk each step sequentially
   * 3. Build step input from prior step outputs
   * 4. Retry once on service failure (not on schema validation failure)
   * 5. Return the final DecisionPacket
   */
  async execute(naturalLanguageInput: string): Promise<DecisionPacket> {
    const context = ExecutionContext.create(naturalLanguageInput);
    context.markRunning();

    for (const step of this.pipeline.steps) {
      const input = this.buildStepInput(step, context);

      let lastError: StepExecutionError | undefined;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          await this.stepRunner.run(step, input, context);
          lastError = undefined;
          break;
        } catch (err: unknown) {
          if (!(err instanceof StepExecutionError)) throw err;

          // Fail hard on schema validation — no retry
          if (
            err.failure.error_code === 'INPUT_VALIDATION_FAILED' ||
            err.failure.error_code === 'OUTPUT_VALIDATION_FAILED'
          ) {
            throw err;
          }

          lastError = err;

          if (attempt < MAX_RETRIES) {
            // Reset context status for retry — the step will re-record
            context.status = 'running';
            context.failure = undefined;
          }
        }
      }

      if (lastError) {
        // Retries exhausted — wrap as RETRY_EXHAUSTED
        const exhaustedFailure: ExecutionFailure = {
          run_id: context.runId,
          step_id: step.stepId,
          error_code: 'RETRY_EXHAUSTED',
          message: `Step "${step.name}" failed after ${MAX_RETRIES + 1} attempts: ${lastError.failure.message}`,
          timestamp: new Date().toISOString(),
        };
        context.markFailed(exhaustedFailure);
        throw new StepExecutionError(exhaustedFailure);
      }
    }

    // All steps completed — extract the DecisionPacket from the final step
    context.markCompleted();

    const finalStepId =
      this.pipeline.steps[this.pipeline.steps.length - 1].stepId;
    const finalOutput = context.stepOutputs.get(finalStepId);

    if (!finalOutput) {
      const failure: ExecutionFailure = {
        run_id: context.runId,
        step_id: finalStepId,
        error_code: 'PIPELINE_ABORTED',
        message: 'Final step output missing after successful pipeline run',
        timestamp: new Date().toISOString(),
      };
      throw new StepExecutionError(failure);
    }

    return finalOutput.output as DecisionPacket;
  }

  /**
   * Build the input payload for a step by assembling outputs from its
   * dependencies. The first step receives the raw natural language text.
   */
  private buildStepInput(
    step: StepDefinition,
    context: ExecutionContext,
  ): unknown {
    switch (step.stepId) {
      case 'step-1-intent-classification':
        return { text: context.originalRequest };

      case 'step-2-data-retrieval': {
        const prev = context.stepOutputs.get('step-1-intent-classification');
        const output = prev?.output as {
          intent_type: string;
          entities: Record<string, string>;
        };
        return {
          intent_type: output.intent_type,
          entities: output.entities,
        };
      }

      case 'step-3-analysis': {
        const classOut = context.stepOutputs.get(
          'step-1-intent-classification',
        );
        const dataOut = context.stepOutputs.get('step-2-data-retrieval');
        const classified = classOut?.output as { intent_type: string };
        const retrieved = dataOut?.output as {
          data_points: Array<{ key: string; value: unknown; source: string }>;
        };
        return {
          intent_type: classified.intent_type,
          data_points: retrieved.data_points,
        };
      }

      case 'step-4-decision-synthesis': {
        const classOut = context.stepOutputs.get(
          'step-1-intent-classification',
        );
        const analysisOut = context.stepOutputs.get('step-3-analysis');
        const classified = classOut?.output as { intent_type: string };
        const analysed = analysisOut?.output as {
          findings: Array<{
            finding: string;
            confidence: number;
            supporting_data: string[];
          }>;
          risk_score: number;
        };
        return {
          intent_type: classified.intent_type,
          findings: analysed.findings,
          risk_score: analysed.risk_score,
          original_request: context.originalRequest,
        };
      }

      default:
        throw new Error(`Unknown step: ${step.stepId}`);
    }
  }
}
