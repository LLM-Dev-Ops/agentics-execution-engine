import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { StepRunner, StepExecutionError } from '../src/core/StepRunner.js';
import { ExecutionContext } from '../src/core/ExecutionContext.js';
import type { HttpClient, HttpResponse } from '../src/core_adapter.js';
import type { StepDefinition, ServiceEndpointMap } from '../src/types/pipeline.js';
import type { RuvectorClient } from '../src/ruvector_client.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const inputSchema = z.object({ text: z.string().min(1) });
const outputSchema = z.object({ intent_type: z.string(), confidence: z.number() });

const step: StepDefinition = {
  stepId: 'test-step',
  name: 'Test Step',
  targetService: 'test-service',
  inputSchema,
  outputSchema,
  dependsOn: [],
};

const endpointMap: ServiceEndpointMap = {
  'test-service': 'https://test.example.com',
};

function makeHttpClient(
  impl: (url: string, body: unknown) => Promise<HttpResponse>,
): HttpClient {
  return { post: vi.fn().mockImplementation(impl) };
}

function makeMockRuvector(): RuvectorClient {
  return {
    publish: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn().mockResolvedValue(undefined),
    isConnected: () => true,
    subscribe: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  } as unknown as RuvectorClient;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StepRunner', () => {
  it('executes a step and records output in context', async () => {
    const httpClient = makeHttpClient(async () => ({
      status: 200,
      body: { intent_type: 'purchase', confidence: 0.95 },
    }));
    const ruvector = makeMockRuvector();
    const runner = new StepRunner({
      httpClient,
      ruvectorClient: ruvector,
      endpointMap,
      timeoutMs: 5000,
    });
    const ctx = ExecutionContext.createWithId('run-1', 'buy something');

    const result = await runner.run(step, { text: 'buy something' }, ctx);

    expect(result.stepId).toBe('test-step');
    expect(result.output).toEqual({ intent_type: 'purchase', confidence: 0.95 });
    expect(ctx.stepOutputs.has('test-step')).toBe(true);
    expect(httpClient.post).toHaveBeenCalledOnce();
    expect(ruvector.publish).toHaveBeenCalled();
  });

  it('fails hard on input validation error', async () => {
    const httpClient = makeHttpClient(async () => ({
      status: 200,
      body: { intent_type: 'x', confidence: 0.5 },
    }));
    const runner = new StepRunner({
      httpClient,
      ruvectorClient: null,
      endpointMap,
      timeoutMs: 5000,
    });
    const ctx = ExecutionContext.createWithId('run-2', 'test');

    await expect(runner.run(step, { text: '' }, ctx)).rejects.toThrow(StepExecutionError);
    expect(ctx.status).toBe('failed');
    expect(ctx.failure?.error_code).toBe('INPUT_VALIDATION_FAILED');
    expect(httpClient.post).not.toHaveBeenCalled();
  });

  it('fails hard on output validation error', async () => {
    const httpClient = makeHttpClient(async () => ({
      status: 200,
      body: { bad: 'response' },
    }));
    const runner = new StepRunner({
      httpClient,
      ruvectorClient: null,
      endpointMap,
      timeoutMs: 5000,
    });
    const ctx = ExecutionContext.createWithId('run-3', 'test');

    await expect(runner.run(step, { text: 'hello' }, ctx)).rejects.toThrow(StepExecutionError);
    expect(ctx.status).toBe('failed');
    expect(ctx.failure?.error_code).toBe('OUTPUT_VALIDATION_FAILED');
  });

  it('fails when endpoint is not in the map', async () => {
    const httpClient = makeHttpClient(async () => ({ status: 200, body: {} }));
    const runner = new StepRunner({
      httpClient,
      ruvectorClient: null,
      endpointMap: {},
      timeoutMs: 5000,
    });
    const ctx = ExecutionContext.createWithId('run-4', 'test');

    await expect(runner.run(step, { text: 'hello' }, ctx)).rejects.toThrow(StepExecutionError);
    expect(ctx.failure?.error_code).toBe('SERVICE_CALL_FAILED');
  });

  it('fails on non-2xx status', async () => {
    const httpClient = makeHttpClient(async () => ({
      status: 500,
      body: { error: 'internal' },
    }));
    const runner = new StepRunner({
      httpClient,
      ruvectorClient: null,
      endpointMap,
      timeoutMs: 5000,
    });
    const ctx = ExecutionContext.createWithId('run-5', 'test');

    await expect(runner.run(step, { text: 'hello' }, ctx)).rejects.toThrow(StepExecutionError);
    expect(ctx.failure?.error_code).toBe('SERVICE_CALL_FAILED');
  });

  it('classifies timeout errors', async () => {
    const httpClient = makeHttpClient(async () => {
      throw new Error('Request timed out');
    });
    const runner = new StepRunner({
      httpClient,
      ruvectorClient: null,
      endpointMap,
      timeoutMs: 5000,
    });
    const ctx = ExecutionContext.createWithId('run-6', 'test');

    await expect(runner.run(step, { text: 'hello' }, ctx)).rejects.toThrow(StepExecutionError);
    expect(ctx.failure?.error_code).toBe('SERVICE_TIMEOUT');
  });

  it('calls the correct URL with step payload', async () => {
    const httpClient = makeHttpClient(async () => ({
      status: 200,
      body: { intent_type: 'query', confidence: 0.8 },
    }));
    const runner = new StepRunner({
      httpClient,
      ruvectorClient: null,
      endpointMap,
      timeoutMs: 5000,
    });
    const ctx = ExecutionContext.createWithId('run-7', 'test');

    await runner.run(step, { text: 'what is the weather' }, ctx);

    expect(httpClient.post).toHaveBeenCalledWith(
      'https://test.example.com/execute',
      { step_id: 'test-step', input: { text: 'what is the weather' } },
      { timeout: 5000 },
    );
  });

  it('tolerates ruvector publish failure without aborting', async () => {
    const httpClient = makeHttpClient(async () => ({
      status: 200,
      body: { intent_type: 'query', confidence: 0.7 },
    }));
    const ruvector = makeMockRuvector();
    (ruvector.publish as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ruvector down'));
    const runner = new StepRunner({
      httpClient,
      ruvectorClient: ruvector,
      endpointMap,
      timeoutMs: 5000,
    });
    const ctx = ExecutionContext.createWithId('run-8', 'test');

    // Should NOT throw even though ruvector fails
    const result = await runner.run(step, { text: 'hello' }, ctx);
    expect(result.output).toEqual({ intent_type: 'query', confidence: 0.7 });
  });
});
