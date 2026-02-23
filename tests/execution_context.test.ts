import { describe, it, expect } from 'vitest';
import { ExecutionContext } from '../src/core/ExecutionContext.js';
import type { ExecutionFailure } from '../src/types/pipeline.js';

describe('ExecutionContext', () => {
  it('creates with a UUIDv7 runId', () => {
    const ctx = ExecutionContext.create('hello world');
    // UUIDv7 format: 8-4-4-4-12 hex, version nibble = 7
    expect(ctx.runId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(ctx.originalRequest).toBe('hello world');
    expect(ctx.status).toBe('pending');
    expect(ctx.stepOutputs.size).toBe(0);
    expect(ctx.artifacts).toHaveLength(0);
  });

  it('createWithId uses the supplied runId', () => {
    const ctx = ExecutionContext.createWithId(
      'aaaaaaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee',
      'test request',
      '2026-01-01T00:00:00.000Z',
    );
    expect(ctx.runId).toBe('aaaaaaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee');
    expect(ctx.timestamps.startedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('transitions through statuses', () => {
    const ctx = ExecutionContext.create('test');
    expect(ctx.status).toBe('pending');

    ctx.markRunning();
    expect(ctx.status).toBe('running');

    ctx.markCompleted();
    expect(ctx.status).toBe('completed');
    expect(ctx.timestamps.completedAt).toBeDefined();
  });

  it('records step outputs', () => {
    const ctx = ExecutionContext.create('test');
    ctx.recordStepStart('step-1');
    ctx.recordStepOutput({
      stepId: 'step-1',
      output: { intent_type: 'purchase' },
      durationMs: 42,
      completedAt: '2026-01-01T00:00:01.000Z',
    });

    expect(ctx.stepOutputs.size).toBe(1);
    expect(ctx.stepOutputs.get('step-1')?.output).toEqual({ intent_type: 'purchase' });

    const stepTs = ctx.timestamps.steps.find((s) => s.stepId === 'step-1');
    expect(stepTs?.completedAt).toBe('2026-01-01T00:00:01.000Z');
  });

  it('markFailed stores the failure and sets completedAt', () => {
    const ctx = ExecutionContext.create('test');
    const failure: ExecutionFailure = {
      run_id: ctx.runId,
      step_id: 'step-2',
      error_code: 'SERVICE_CALL_FAILED',
      message: 'connection refused',
      timestamp: '2026-01-01T00:00:02.000Z',
    };

    ctx.markFailed(failure);
    expect(ctx.status).toBe('failed');
    expect(ctx.failure).toEqual(failure);
    expect(ctx.timestamps.completedAt).toBeDefined();
  });

  it('serialises to JSON', () => {
    const ctx = ExecutionContext.createWithId('test-run', 'test', '2026-01-01T00:00:00.000Z');
    ctx.markRunning();
    ctx.recordStepStart('s1');
    ctx.recordStepOutput({
      stepId: 's1',
      output: { result: 'ok' },
      durationMs: 10,
      completedAt: '2026-01-01T00:00:01.000Z',
    });

    const json = ctx.toJSON();
    expect(json.runId).toBe('test-run');
    expect(json.status).toBe('running');
    expect((json.stepOutputs as Record<string, unknown>)['s1']).toBeDefined();
  });

  it('generates unique UUIDv7 runIds with correct version and variant', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const ctx = ExecutionContext.create('test');
      // Each must be unique
      expect(ids.has(ctx.runId)).toBe(false);
      ids.add(ctx.runId);
      // Each must be valid UUIDv7 (version=7, variant=10xx)
      expect(ctx.runId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
    expect(ids.size).toBe(10);
  });
});
