import type {
  StepOutput,
  PipelineRunStatus,
  ExecutionFailure,
} from '../types/pipeline.js';
import type { ArtifactRecord } from '../types/core.js';

// ---------------------------------------------------------------------------
// UUIDv7 generator — deterministic timestamp-based, RFC 9562
// ---------------------------------------------------------------------------

function generateUUIDv7(): string {
  const now = Date.now();

  // 48-bit timestamp (ms since epoch)
  const msBytes = new Uint8Array(6);
  let ts = now;
  for (let i = 5; i >= 0; i--) {
    msBytes[i] = ts & 0xff;
    ts = Math.floor(ts / 256);
  }

  // 10 random bytes for rand_a (12 bits) + variant (2 bits) + rand_b (62 bits)
  const randBytes = new Uint8Array(10);
  crypto.getRandomValues(randBytes);

  // Assemble 16-byte UUID
  const bytes = new Uint8Array(16);
  bytes.set(msBytes, 0);
  bytes.set(randBytes, 6);

  // Set version 7: byte[6] high nibble = 0111
  bytes[6] = (bytes[6] & 0x0f) | 0x70;

  // Set variant 10: byte[8] high 2 bits = 10
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  // Format as canonical UUID string
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

// ---------------------------------------------------------------------------
// Timestamp tracking for each step
// ---------------------------------------------------------------------------

export interface StepTimestamp {
  readonly stepId: string;
  readonly startedAt: string;
  readonly completedAt?: string;
}

export interface ExecutionTimestamps {
  readonly startedAt: string;
  completedAt?: string;
  readonly steps: StepTimestamp[];
}

// ---------------------------------------------------------------------------
// ExecutionContext — encapsulates all state for a single pipeline run
// ---------------------------------------------------------------------------

export class ExecutionContext {
  readonly runId: string;
  readonly originalRequest: string;
  readonly stepOutputs: Map<string, StepOutput>;
  readonly artifacts: ArtifactRecord[];
  status: PipelineRunStatus;
  readonly timestamps: ExecutionTimestamps;
  failure?: ExecutionFailure;

  private constructor(
    runId: string,
    originalRequest: string,
    startedAt: string,
  ) {
    this.runId = runId;
    this.originalRequest = originalRequest;
    this.stepOutputs = new Map();
    this.artifacts = [];
    this.status = 'pending';
    this.timestamps = {
      startedAt,
      steps: [],
    };
  }

  /** Create a new ExecutionContext with a UUIDv7 runId */
  static create(originalRequest: string): ExecutionContext {
    const runId = generateUUIDv7();
    const startedAt = new Date().toISOString();
    return new ExecutionContext(runId, originalRequest, startedAt);
  }

  /** Create with an explicit runId (for testing / deterministic replay) */
  static createWithId(
    runId: string,
    originalRequest: string,
    startedAt?: string,
  ): ExecutionContext {
    return new ExecutionContext(
      runId,
      originalRequest,
      startedAt ?? new Date().toISOString(),
    );
  }

  markRunning(): void {
    this.status = 'running';
  }

  markCompleted(): void {
    this.status = 'completed';
    this.timestamps.completedAt = new Date().toISOString();
  }

  markFailed(failure: ExecutionFailure): void {
    this.status = 'failed';
    this.failure = failure;
    this.timestamps.completedAt = new Date().toISOString();
  }

  recordStepStart(stepId: string): void {
    (this.timestamps.steps as StepTimestamp[]).push({
      stepId,
      startedAt: new Date().toISOString(),
    });
  }

  recordStepOutput(output: StepOutput): void {
    this.stepOutputs.set(output.stepId, output);

    // Update the matching step timestamp with completedAt
    const stepTs = this.timestamps.steps.find((s) => s.stepId === output.stepId);
    if (stepTs) {
      (stepTs as { completedAt?: string }).completedAt = output.completedAt;
    }
  }

  addArtifact(artifact: ArtifactRecord): void {
    this.artifacts.push(artifact);
  }

  /** Serialise the context to a plain object for persistence */
  toJSON(): Record<string, unknown> {
    return {
      runId: this.runId,
      originalRequest: this.originalRequest,
      stepOutputs: Object.fromEntries(this.stepOutputs),
      artifacts: this.artifacts,
      status: this.status,
      timestamps: {
        startedAt: this.timestamps.startedAt,
        completedAt: this.timestamps.completedAt,
        steps: this.timestamps.steps,
      },
      failure: this.failure,
    };
  }
}
