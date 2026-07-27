import type { RuvectorClient } from './ruvector_client.js';
import type { ExecutionDispatcher } from './execution_dispatcher.js';
import {
  parsePlanApprovedEvent,
  toExecutionIntent,
  PlanApprovedValidationError,
} from './types/plan_approved.js';

export interface ExecutionListenerOptions {
  ruvectorClient: RuvectorClient;
  dispatcher: ExecutionDispatcher;
}

export class ExecutionListener {
  private readonly ruvectorClient: RuvectorClient;
  private readonly dispatcher: ExecutionDispatcher;
  private running = false;

  constructor(options: ExecutionListenerOptions) {
    this.ruvectorClient = options.ruvectorClient;
    this.dispatcher = options.dispatcher;
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    this.ruvectorClient.subscribe('plan_approved', (payload: unknown) => {
      this.handlePlanApproved(payload);
    }).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[execution] failed to subscribe to plan_approved:', message);
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.ruvectorClient.stop();
  }

  isRunning(): boolean {
    return this.running;
  }

  private handlePlanApproved(payload: unknown): void {
    let event;
    try {
      event = parsePlanApprovedEvent(payload);
    } catch (err: unknown) {
      if (err instanceof PlanApprovedValidationError) {
        console.error('[execution] rejected plan_approved event —', err.message);
        return;
      }
      throw err;
    }

    const executionId = event.execution_id;
    const intent = toExecutionIntent(event);

    console.log('[execution] accepted plan_approved event:', executionId);

    this.ruvectorClient.publish('execution_started', {
      execution_id: executionId,
      intent_id: intent.intent_id,
      started_at: new Date().toISOString(),
    }).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[execution] failed to publish execution_started:', message);
    });

    this.dispatcher.dispatchExecution(intent, { executionId }).then((graph) => {
      console.log('[execution] execution completed:', graph.execution_id, 'status:', graph.status);

      this.ruvectorClient.publish('execution_completed', {
        execution_id: graph.execution_id,
        intent_id: graph.intent_id,
        status: graph.status,
        completed_at: graph.completed_at,
        total_duration_ms: graph.total_duration_ms,
      }).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[execution] failed to publish execution_completed:', message);
      });
    }).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[execution] dispatch failed after plan_approved:', message);
    });
  }
}
