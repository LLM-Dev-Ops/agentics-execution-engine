import { describe, it, expect } from 'vitest';
import { ExecutionTrace, type IdGenerator, type Clock } from '../src/execution_trace.js';
import type { ExecutionIntent } from '../src/types/intent.js';
import type { ResolvedCore, CoreExecutionResult } from '../src/types/core.js';

let idCounter = 0;
const mockIdGen: IdGenerator = { generate: () => `id-${++idCounter}` };
const mockClock: Clock = { now: () => '2026-02-09T12:00:00.000Z' };

function makeIntent(): ExecutionIntent {
  return {
    intent_id: 'intent-1',
    requested_by: 'user-1',
    cores_required: [],
    parameters: {},
    evidence_policy: { fail_on_missing: true, required_evidence_types: [], minimum_evidence_count: 0 },
    timeout_ms: 30000,
  };
}

function makeCore(): ResolvedCore {
  return {
    name: 'test-core',
    version: '1.0.0',
    endpoint: 'https://core.example.com',
    capabilities: [],
    contract_hash: 'hash123',
  };
}

function makeResult(): CoreExecutionResult {
  return {
    core_name: 'test-core',
    core_version: '1.0.0',
    status: 'success',
    agents_executed: [{ agent_id: 'a1', agent_type: 'coder', task_description: 'test', status: 'completed', duration_ms: 100 }],
    repos_touched: [],
    artifacts_generated: [],
    evidence_refs: [{ evidence_type: 'report', evidence_id: 'e1', uri: 'https://ev.example.com', produced_by: 'test-core', timestamp: '2026-02-09T12:00:00.000Z', verifiable: true }],
    duration_ms: 500,
  };
}

describe('ExecutionTrace', () => {
  beforeEach(() => { idCounter = 0; });

  it('creates a trace with EXECUTION_STARTED event', () => {
    const trace = ExecutionTrace.create(makeIntent(), mockIdGen, mockClock);
    expect(trace.execution_id).toBe('id-1');
    expect(trace.status).toBe('open');

    const events = trace.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe('EXECUTION_STARTED');
  });

  it('records dispatch and result events', () => {
    const trace = ExecutionTrace.create(makeIntent(), mockIdGen, mockClock);
    trace.recordDispatch(makeCore());
    trace.recordResult(makeCore(), makeResult());

    const events = trace.getEvents();
    expect(events).toHaveLength(3);
    expect(events[1].event_type).toBe('CORE_DISPATCHED');
    expect(events[2].event_type).toBe('CORE_COMPLETED');
  });

  it('records evidence validation', () => {
    const trace = ExecutionTrace.create(makeIntent(), mockIdGen, mockClock);
    trace.recordEvidenceValidation({
      total_required: 1,
      total_provided: 1,
      total_missing: 0,
      missing_evidence: [],
      all_satisfied: true,
    });

    const events = trace.getEvents();
    expect(events[1].event_type).toBe('EVIDENCE_VALIDATED');
  });

  it('produces graph nodes from events', () => {
    const trace = ExecutionTrace.create(makeIntent(), mockIdGen, mockClock);
    trace.recordDispatch(makeCore());
    trace.recordResult(makeCore(), makeResult());
    trace.recordEvidenceValidation({
      total_required: 1, total_provided: 1, total_missing: 0, missing_evidence: [], all_satisfied: true,
    });
    trace.markCompleted();

    const nodes = trace.toNodes();
    expect(nodes.length).toBeGreaterThanOrEqual(4);
    expect(nodes[0].node_type).toBe('intent_resolution');
    expect(nodes.some((n) => n.node_type === 'core_dispatch')).toBe(true);
    expect(nodes.some((n) => n.node_type === 'evidence_validation')).toBe(true);
    expect(nodes.some((n) => n.node_type === 'aggregation')).toBe(true);
  });

  it('produces edges between nodes', () => {
    const trace = ExecutionTrace.create(makeIntent(), mockIdGen, mockClock);
    trace.recordDispatch(makeCore());
    trace.recordResult(makeCore(), makeResult());
    trace.recordEvidenceValidation({
      total_required: 0, total_provided: 0, total_missing: 0, missing_evidence: [], all_satisfied: true,
    });
    trace.markCompleted();

    const edges = trace.toEdges();
    expect(edges.length).toBeGreaterThan(0);
    expect(edges.some((e) => e.edge_type === 'triggers')).toBe(true);
  });

  it('prevents appending after seal', () => {
    const trace = ExecutionTrace.create(makeIntent(), mockIdGen, mockClock);
    trace.seal();
    expect(trace.status).toBe('sealed');

    expect(() => trace.recordDispatch(makeCore())).toThrow('sealed');
  });

  it('event data is frozen', () => {
    const trace = ExecutionTrace.create(makeIntent(), mockIdGen, mockClock);
    const events = trace.getEvents();
    expect(Object.isFrozen(events[0].data)).toBe(true);
  });
});
