import { describe, it, expect, vi } from 'vitest';
import { MvpPipelineExecutor, MVP_REFERENCE_PIPELINE } from '../src/core/MvpPipelineExecutor.js';
import { StepExecutionError } from '../src/core/StepRunner.js';
import type { HttpClient, HttpResponse } from '../src/core_adapter.js';
import type { ServiceEndpointMap } from '../src/types/pipeline.js';
import type { RuvectorClient } from '../src/ruvector_client.js';

// ---------------------------------------------------------------------------
// Fixtures — deterministic service responses for each step
// ---------------------------------------------------------------------------

const ENDPOINT_MAP: ServiceEndpointMap = {
  'intent-classifier': 'https://intent.example.com',
  'data-retriever': 'https://data.example.com',
  'analyzer': 'https://analyzer.example.com',
  'decision-synthesizer': 'https://decision.example.com',
};

function makeClassificationResponse() {
  return {
    intent_type: 'purchase_order',
    confidence: 0.92,
    entities: { product: 'widget', quantity: '100' },
  };
}

function makeDataRetrievalResponse() {
  return {
    data_points: [
      { key: 'inventory', value: 500, source: 'erp-system' },
      { key: 'unit_price', value: 12.5, source: 'pricing-service' },
    ],
  };
}

function makeAnalysisResponse() {
  return {
    findings: [
      {
        finding: 'Sufficient inventory available',
        confidence: 0.95,
        supporting_data: ['inventory:500', 'requested:100'],
      },
    ],
    risk_score: 0.12,
  };
}

function makeDecisionResponse(runId: string) {
  return {
    decision_id: 'dec-001',
    run_id: runId,
    recommendation: 'Approve purchase order',
    confidence: 0.91,
    reasoning: 'Inventory sufficient, pricing within budget',
    supporting_evidence: ['inventory check', 'price validation'],
    risk_assessment: {
      score: 0.12,
      factors: ['supply chain delay'],
    },
    generated_at: '2026-02-23T10:00:00.000Z',
  };
}

function makeSuccessHttpClient(): HttpClient {
  return {
    post: vi.fn().mockImplementation(async (url: string, body: unknown) => {
      const payload = body as { step_id: string; input: unknown };

      if (url.includes('intent.example.com')) {
        return { status: 200, body: makeClassificationResponse() };
      }
      if (url.includes('data.example.com')) {
        return { status: 200, body: makeDataRetrievalResponse() };
      }
      if (url.includes('analyzer.example.com')) {
        return { status: 200, body: makeAnalysisResponse() };
      }
      if (url.includes('decision.example.com')) {
        // The run_id in the response doesn't matter for validation —
        // the DecisionPacket schema just requires a non-empty string.
        return { status: 200, body: makeDecisionResponse('run-placeholder') };
      }

      return { status: 404, body: { error: 'unknown service' } };
    }),
  };
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

describe('MvpPipelineExecutor', () => {
  it('executes the full pipeline and returns a DecisionPacket', async () => {
    const httpClient = makeSuccessHttpClient();
    const executor = new MvpPipelineExecutor({
      httpClient,
      ruvectorClient: null,
      endpointMap: ENDPOINT_MAP,
    });

    const result = await executor.execute('Purchase 100 widgets');

    expect(result.decision_id).toBe('dec-001');
    expect(result.recommendation).toBe('Approve purchase order');
    expect(result.confidence).toBe(0.91);
    expect(result.risk_assessment.score).toBe(0.12);

    // All 4 steps should have been called
    expect(httpClient.post).toHaveBeenCalledTimes(4);
  });

  it('calls services in sequential order', async () => {
    const callOrder: string[] = [];
    const httpClient: HttpClient = {
      post: vi.fn().mockImplementation(async (url: string) => {
        callOrder.push(url);
        if (url.includes('intent')) return { status: 200, body: makeClassificationResponse() };
        if (url.includes('data')) return { status: 200, body: makeDataRetrievalResponse() };
        if (url.includes('analyzer')) return { status: 200, body: makeAnalysisResponse() };
        if (url.includes('decision')) return { status: 200, body: makeDecisionResponse('x') };
        return { status: 404, body: {} };
      }),
    };

    const executor = new MvpPipelineExecutor({
      httpClient,
      ruvectorClient: null,
      endpointMap: ENDPOINT_MAP,
    });

    await executor.execute('test input');

    expect(callOrder).toEqual([
      'https://intent.example.com/execute',
      'https://data.example.com/execute',
      'https://analyzer.example.com/execute',
      'https://decision.example.com/execute',
    ]);
  });

  it('fails hard on schema validation failure (no retry)', async () => {
    const httpClient: HttpClient = {
      post: vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('intent')) {
          // Return invalid output — missing required fields
          return { status: 200, body: { bad: 'data' } };
        }
        return { status: 200, body: {} };
      }),
    };

    const executor = new MvpPipelineExecutor({
      httpClient,
      ruvectorClient: null,
      endpointMap: ENDPOINT_MAP,
    });

    await expect(executor.execute('test')).rejects.toThrow(StepExecutionError);

    // Should only have called intent-classifier once (no retry on validation failure)
    expect(httpClient.post).toHaveBeenCalledTimes(1);
  });

  it('retries once on service failure then succeeds', async () => {
    let intentCallCount = 0;
    const httpClient: HttpClient = {
      post: vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('intent')) {
          intentCallCount++;
          if (intentCallCount === 1) {
            throw new Error('Connection refused');
          }
          return { status: 200, body: makeClassificationResponse() };
        }
        if (url.includes('data')) return { status: 200, body: makeDataRetrievalResponse() };
        if (url.includes('analyzer')) return { status: 200, body: makeAnalysisResponse() };
        if (url.includes('decision')) return { status: 200, body: makeDecisionResponse('x') };
        return { status: 404, body: {} };
      }),
    };

    const executor = new MvpPipelineExecutor({
      httpClient,
      ruvectorClient: null,
      endpointMap: ENDPOINT_MAP,
    });

    const result = await executor.execute('test');

    expect(result.decision_id).toBe('dec-001');
    // intent-classifier called twice (1 fail + 1 success), rest called once each
    expect(httpClient.post).toHaveBeenCalledTimes(5);
  });

  it('throws RETRY_EXHAUSTED after two consecutive failures', async () => {
    const httpClient: HttpClient = {
      post: vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('intent')) {
          throw new Error('Connection refused');
        }
        return { status: 200, body: {} };
      }),
    };

    const executor = new MvpPipelineExecutor({
      httpClient,
      ruvectorClient: null,
      endpointMap: ENDPOINT_MAP,
    });

    try {
      await executor.execute('test');
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(StepExecutionError);
      const failure = (err as StepExecutionError).failure;
      expect(failure.error_code).toBe('RETRY_EXHAUSTED');
      expect(failure.step_id).toBe('step-1-intent-classification');
    }
  });

  it('persists state to ruvector after each step', async () => {
    const ruvector = makeMockRuvector();
    const httpClient = makeSuccessHttpClient();
    const executor = new MvpPipelineExecutor({
      httpClient,
      ruvectorClient: ruvector,
      endpointMap: ENDPOINT_MAP,
    });

    await executor.execute('test');

    // 4 steps = 4 publish calls
    expect(ruvector.publish).toHaveBeenCalledTimes(4);
    for (const call of (ruvector.publish as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[0]).toBe('execution_state');
      expect(call[1]).toHaveProperty('runId');
    }
  });

  it('passes correct input to step 2 from step 1 output', async () => {
    const httpClient: HttpClient = {
      post: vi.fn().mockImplementation(async (url: string, body: unknown) => {
        const payload = body as { step_id: string; input: Record<string, unknown> };
        if (url.includes('intent')) return { status: 200, body: makeClassificationResponse() };
        if (url.includes('data')) {
          // Verify the data retrieval step receives correct input
          expect(payload.input.intent_type).toBe('purchase_order');
          expect(payload.input.entities).toEqual({ product: 'widget', quantity: '100' });
          return { status: 200, body: makeDataRetrievalResponse() };
        }
        if (url.includes('analyzer')) return { status: 200, body: makeAnalysisResponse() };
        if (url.includes('decision')) return { status: 200, body: makeDecisionResponse('x') };
        return { status: 404, body: {} };
      }),
    };

    const executor = new MvpPipelineExecutor({
      httpClient,
      ruvectorClient: null,
      endpointMap: ENDPOINT_MAP,
    });

    await executor.execute('test');
  });

  it('MVP_REFERENCE_PIPELINE has 4 sequential steps', () => {
    const steps = MVP_REFERENCE_PIPELINE.steps;
    expect(steps).toHaveLength(4);
    expect(steps[0].stepId).toBe('step-1-intent-classification');
    expect(steps[1].stepId).toBe('step-2-data-retrieval');
    expect(steps[2].stepId).toBe('step-3-analysis');
    expect(steps[3].stepId).toBe('step-4-decision-synthesis');

    // Verify dependency chain
    expect(steps[0].dependsOn).toEqual([]);
    expect(steps[1].dependsOn).toEqual(['step-1-intent-classification']);
    expect(steps[2].dependsOn).toEqual(['step-2-data-retrieval']);
    expect(steps[3].dependsOn).toEqual(['step-3-analysis']);
  });

  it('rejects empty input', async () => {
    const httpClient = makeSuccessHttpClient();
    const executor = new MvpPipelineExecutor({
      httpClient,
      ruvectorClient: null,
      endpointMap: ENDPOINT_MAP,
    });

    await expect(executor.execute('')).rejects.toThrow(StepExecutionError);
    expect(httpClient.post).not.toHaveBeenCalled();
  });
});
