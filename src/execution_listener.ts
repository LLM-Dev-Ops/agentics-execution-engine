import type { RuvectorClient } from './ruvector_client.js';
import type { ExecutionDispatcher } from './execution_dispatcher.js';
import type { ExecutionIntent } from './types/intent.js';

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

    this.ruvectorClient.subscribe('execution_started', (payload: unknown) => {
      this.handleExecutionStarted(payload);
    }).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[execution] failed to subscribe to execution_started:', message);
    });
  }

  stop(): void {
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }

  private handlePlanApproved(payload: unknown): void {
    console.log('[execution] received plan_approved event:', JSON.stringify(payload));

    const intent = payload as ExecutionIntent;
    if (!intent || !intent.intent_id) {
      console.error('[execution] plan_approved payload missing intent_id, skipping');
      return;
    }

    this.ruvectorClient.publish('execution_started', {
      intent_id: intent.intent_id,
      started_at: new Date().toISOString(),
    }).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[execution] failed to publish execution_started:', message);
    });

    this.dispatcher.dispatchExecution(intent).then((graph) => {
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

  private handleExecutionStarted(payload: unknown): void {
    console.log('[execution] received execution_started event:', JSON.stringify(payload));
  }
}
