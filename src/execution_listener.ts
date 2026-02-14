import type { RuvectorClient } from './ruvector_client.js';

export interface ExecutionListenerOptions {
  ruvectorClient: RuvectorClient;
}

export class ExecutionListener {
  private readonly ruvectorClient: RuvectorClient;
  private running = false;

  constructor(options: ExecutionListenerOptions) {
    this.ruvectorClient = options.ruvectorClient;
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

  stop(): void {
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }

  private handlePlanApproved(payload: unknown): void {
    console.log('[execution] received plan_approved event:', JSON.stringify(payload));
  }
}
