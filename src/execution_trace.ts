import { randomUUID } from 'node:crypto';
import type { ResolvedCore, CoreExecutionResult } from './types/core.js';
import type { EvidenceSummary } from './types/evidence.js';
import type { ExecutionIntent } from './types/intent.js';
import type { ExecutionNode, ExecutionEdge, NodeType, NodeStatus, EdgeType } from './types/graph.js';

export type TraceEventType =
  | 'EXECUTION_STARTED'
  | 'CORE_DISPATCHED'
  | 'CORE_COMPLETED'
  | 'EVIDENCE_VALIDATED'
  | 'EXECUTION_COMPLETED'
  | 'EXECUTION_FAILED';

export interface TraceEvent {
  readonly event_id: string;
  readonly execution_id: string;
  readonly event_type: TraceEventType;
  readonly timestamp: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export type TraceStatus = 'open' | 'sealed';

export interface IdGenerator {
  generate(): string;
}

export interface Clock {
  now(): string;
}

const defaultIdGenerator: IdGenerator = { generate: () => randomUUID() };
const defaultClock: Clock = { now: () => new Date().toISOString() };

export class ExecutionTrace {
  private readonly events: TraceEvent[] = [];
  private traceStatus: TraceStatus = 'open';
  private sealedAt: string | undefined;

  readonly execution_id: string;
  readonly intent_id: string;

  private constructor(
    executionId: string,
    intentId: string,
    private readonly idGen: IdGenerator,
    private readonly clock: Clock,
  ) {
    this.execution_id = executionId;
    this.intent_id = intentId;
  }

  static create(
    intent: ExecutionIntent,
    idGen: IdGenerator = defaultIdGenerator,
    clock: Clock = defaultClock,
    executionId?: string,
  ): ExecutionTrace {
    const trace = new ExecutionTrace(executionId ?? idGen.generate(), intent.intent_id, idGen, clock);
    trace.appendEvent('EXECUTION_STARTED', { intent_id: intent.intent_id, requested_by: intent.requested_by });
    return trace;
  }

  get status(): TraceStatus {
    return this.traceStatus;
  }

  get startedAt(): string {
    return this.events[0]?.timestamp ?? this.clock.now();
  }

  recordDispatch(core: ResolvedCore): void {
    this.appendEvent('CORE_DISPATCHED', {
      core_name: core.name,
      core_version: core.version,
      endpoint: core.endpoint,
    });
  }

  recordResult(core: ResolvedCore, result: CoreExecutionResult): void {
    this.appendEvent('CORE_COMPLETED', {
      core_name: core.name,
      status: result.status,
      agents_count: result.agents_executed.length,
      repos_count: result.repos_touched.length,
      artifacts_count: result.artifacts_generated.length,
      evidence_count: result.evidence_refs.length,
      duration_ms: result.duration_ms,
    });
  }

  recordEvidenceValidation(summary: EvidenceSummary): void {
    this.appendEvent('EVIDENCE_VALIDATED', {
      total_required: summary.total_required,
      total_provided: summary.total_provided,
      total_missing: summary.total_missing,
      all_satisfied: summary.all_satisfied,
      missing: summary.missing_evidence,
    });
  }

  markCompleted(): void {
    this.appendEvent('EXECUTION_COMPLETED', {});
  }

  markFailed(reason: string): void {
    this.appendEvent('EXECUTION_FAILED', { reason });
  }

  toNodes(): ExecutionNode[] {
    const nodes: ExecutionNode[] = [];
    const dispatched = new Map<string, { nodeId: string; startedAt: string }>();

    for (const event of this.events) {
      switch (event.event_type) {
        case 'EXECUTION_STARTED':
          nodes.push({
            node_id: event.event_id,
            node_type: 'intent_resolution',
            status: 'completed',
            started_at: event.timestamp,
            completed_at: event.timestamp,
          });
          break;

        case 'CORE_DISPATCHED':
          dispatched.set(event.data.core_name as string, {
            nodeId: event.event_id,
            startedAt: event.timestamp,
          });
          break;

        case 'CORE_COMPLETED': {
          const coreName = event.data.core_name as string;
          const dispatch = dispatched.get(coreName);
          const coreStatus = event.data.status as string;
          nodes.push({
            node_id: dispatch?.nodeId ?? event.event_id,
            node_type: 'core_dispatch',
            core_name: coreName,
            status: coreStatus === 'failed' ? 'failed' : 'completed',
            started_at: dispatch?.startedAt,
            completed_at: event.timestamp,
            duration_ms: event.data.duration_ms as number,
          });
          break;
        }

        case 'EVIDENCE_VALIDATED':
          nodes.push({
            node_id: event.event_id,
            node_type: 'evidence_validation',
            status: (event.data.all_satisfied as boolean) ? 'completed' : 'failed',
            started_at: event.timestamp,
            completed_at: event.timestamp,
          });
          break;

        case 'EXECUTION_COMPLETED':
        case 'EXECUTION_FAILED':
          nodes.push({
            node_id: event.event_id,
            node_type: 'aggregation',
            status: event.event_type === 'EXECUTION_COMPLETED' ? 'completed' : 'failed',
            started_at: event.timestamp,
            completed_at: event.timestamp,
          });
          break;
      }
    }

    return nodes;
  }

  toEdges(): ExecutionEdge[] {
    const edges: ExecutionEdge[] = [];
    const nodeIds: { id: string; type: string }[] = [];

    for (const event of this.events) {
      if (event.event_type === 'EXECUTION_STARTED') {
        nodeIds.push({ id: event.event_id, type: 'intent_resolution' });
      } else if (event.event_type === 'CORE_COMPLETED') {
        nodeIds.push({ id: event.event_id, type: 'core_dispatch' });
      } else if (event.event_type === 'EVIDENCE_VALIDATED') {
        nodeIds.push({ id: event.event_id, type: 'evidence_validation' });
      } else if (
        event.event_type === 'EXECUTION_COMPLETED' ||
        event.event_type === 'EXECUTION_FAILED'
      ) {
        nodeIds.push({ id: event.event_id, type: 'aggregation' });
      }
    }

    for (let i = 1; i < nodeIds.length; i++) {
      const prev = nodeIds[i - 1];
      const curr = nodeIds[i];
      const edgeType = deriveEdgeType(prev.type, curr.type);
      edges.push({ from_node: prev.id, to_node: curr.id, edge_type: edgeType });
    }

    return edges;
  }

  seal(): void {
    if (this.traceStatus === 'sealed') return;
    this.traceStatus = 'sealed';
    this.sealedAt = this.clock.now();
  }

  getEvents(): readonly TraceEvent[] {
    return [...this.events];
  }

  private appendEvent(type: TraceEventType, data: Record<string, unknown>): void {
    if (this.traceStatus === 'sealed') {
      throw new Error('Cannot append to a sealed trace');
    }

    const event: TraceEvent = {
      event_id: this.idGen.generate(),
      execution_id: this.execution_id,
      event_type: type,
      timestamp: this.clock.now(),
      data: Object.freeze({ ...data }),
    };

    this.events.push(event);
  }
}

function deriveEdgeType(fromType: string, toType: string): EdgeType {
  if (fromType === 'intent_resolution' && toType === 'core_dispatch') return 'triggers';
  if (fromType === 'core_dispatch' && toType === 'core_dispatch') return 'triggers';
  if (fromType === 'core_dispatch' && toType === 'evidence_validation') return 'produces';
  if (fromType === 'evidence_validation' && toType === 'aggregation') return 'validates';
  return 'triggers';
}
