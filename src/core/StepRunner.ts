import type { z } from 'zod';
import type {
  StepDefinition,
  StepOutput,
  ExecutionFailure,
  ServiceEndpointMap,
} from '../types/pipeline.js';
import type { HttpClient } from '../core_adapter.js';
import type { RuvectorClient } from '../ruvector_client.js';
import { ExecutionContext } from './ExecutionContext.js';

// ---------------------------------------------------------------------------
// StepRunner — executes one StepDefinition against a target service
// ---------------------------------------------------------------------------

export interface StepRunnerDeps {
  readonly httpClient: HttpClient;
  readonly ruvectorClient: RuvectorClient | null;
  readonly endpointMap: ServiceEndpointMap;
  readonly timeoutMs: number;
}

export class StepRunner {
  private readonly httpClient: HttpClient;
  private readonly ruvectorClient: RuvectorClient | null;
  private readonly endpointMap: ServiceEndpointMap;
  private readonly timeoutMs: number;

  constructor(deps: StepRunnerDeps) {
    this.httpClient = deps.httpClient;
    this.ruvectorClient = deps.ruvectorClient;
    this.endpointMap = deps.endpointMap;
    this.timeoutMs = deps.timeoutMs;
  }

  /**
   * Execute a single pipeline step:
   *  1. Validate input against the step's inputSchema
   *  2. Resolve the target service endpoint
   *  3. POST to the service
   *  4. Validate the response against the step's outputSchema
   *  5. Record the output in ExecutionContext
   *  6. Persist state to ruvector
   */
  async run(
    step: StepDefinition,
    input: unknown,
    context: ExecutionContext,
  ): Promise<StepOutput> {
    // --- 1. Validate input schema ---
    const inputResult = step.inputSchema.safeParse(input);
    if (!inputResult.success) {
      const failure = this.buildFailure(
        context.runId,
        step.stepId,
        'INPUT_VALIDATION_FAILED',
        `Input validation failed for step "${step.name}": ${formatZodError(inputResult.error)}`,
      );
      context.markFailed(failure);
      await this.persistState(context);
      throw new StepExecutionError(failure);
    }

    // --- 2. Resolve endpoint ---
    const baseUrl = this.endpointMap[step.targetService];
    if (!baseUrl) {
      const failure = this.buildFailure(
        context.runId,
        step.stepId,
        'SERVICE_CALL_FAILED',
        `No endpoint configured for service "${step.targetService}"`,
      );
      context.markFailed(failure);
      await this.persistState(context);
      throw new StepExecutionError(failure);
    }

    const url = `${baseUrl}/execute`;

    // --- 3. Call target service ---
    context.recordStepStart(step.stepId);
    const startMs = Date.now();

    let responseBody: unknown;
    try {
      const response = await this.httpClient.post(
        url,
        { step_id: step.stepId, input: inputResult.data },
        { timeout: this.timeoutMs },
      );

      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Service responded with status ${response.status}`);
      }

      responseBody = response.body;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const code = classifyServiceError(err);
      const failure = this.buildFailure(
        context.runId,
        step.stepId,
        code,
        `Service call failed for step "${step.name}": ${message}`,
      );
      context.markFailed(failure);
      await this.persistState(context);
      throw new StepExecutionError(failure);
    }

    const durationMs = Date.now() - startMs;

    // --- 4. Validate output schema ---
    const outputResult = step.outputSchema.safeParse(responseBody);
    if (!outputResult.success) {
      const failure = this.buildFailure(
        context.runId,
        step.stepId,
        'OUTPUT_VALIDATION_FAILED',
        `Output validation failed for step "${step.name}": ${formatZodError(outputResult.error)}`,
      );
      context.markFailed(failure);
      await this.persistState(context);
      throw new StepExecutionError(failure);
    }

    // --- 5. Record output ---
    const stepOutput: StepOutput = {
      stepId: step.stepId,
      output: outputResult.data,
      durationMs,
      completedAt: new Date().toISOString(),
    };

    context.recordStepOutput(stepOutput);

    // --- 6. Persist state ---
    await this.persistState(context);

    return stepOutput;
  }

  /** Persist the current ExecutionContext to ruvector-service */
  private async persistState(context: ExecutionContext): Promise<void> {
    if (!this.ruvectorClient) return;
    try {
      await this.ruvectorClient.publish('execution_state', context.toJSON());
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[StepRunner] Failed to persist state for run ${context.runId}: ${message}`,
      );
      // State persistence failure is logged but does not abort the pipeline.
      // The pipeline can still complete; state will be persisted on the next step.
    }
  }

  private buildFailure(
    runId: string,
    stepId: string,
    errorCode: ExecutionFailure['error_code'],
    message: string,
  ): ExecutionFailure {
    return {
      run_id: runId,
      step_id: stepId,
      error_code: errorCode,
      message,
      timestamp: new Date().toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------
// StepExecutionError — wraps ExecutionFailure for throw/catch control flow
// ---------------------------------------------------------------------------

export class StepExecutionError extends Error {
  readonly failure: ExecutionFailure;

  constructor(failure: ExecutionFailure) {
    super(failure.message);
    this.name = 'StepExecutionError';
    this.failure = failure;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join('; ');
}

function classifyServiceError(
  err: unknown,
): ExecutionFailure['error_code'] {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('abort')) {
      return 'SERVICE_TIMEOUT';
    }
  }
  return 'SERVICE_CALL_FAILED';
}
