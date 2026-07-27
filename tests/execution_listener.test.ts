import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RuvectorClient } from '../src/ruvector_client.js';
import { ExecutionListener } from '../src/execution_listener.js';
import { ExecutionDispatcher } from '../src/execution_dispatcher.js';
import { EvidenceValidator } from '../src/evidence_validator.js';
import { CoreAdapter, type ContractRegistry, type HttpClient } from '../src/core_adapter.js';
import type { IdGenerator, Clock } from '../src/execution_trace.js';
import { CANONICAL_PLAN_APPROVED } from './fixtures/plan_approved.js';

let idCounter = 0;
const mockIdGen: IdGenerator = { generate: () => `id-${++idCounter}` };
const mockClock: Clock = { now: () => '2026-07-27T12:00:00.000Z' };

const registry: ContractRegistry = {
  async lookup(coreName: string) {
    return {
      core_name: coreName,
      versions: [{
        version: '1.0.0',
        service_endpoint: `https://${coreName}.test`,
        capabilities: ['execute'],
        contract_hash: `hash-${coreName}`,
      }],
    };
  },
};

function makeHttpClient(): HttpClient {
  return {
    post: vi.fn(async (_url: string, body: unknown) => ({
      status: 200,
      body: {
        core_name: (body as { core_name: string }).core_name,
        core_version: '1.0.0',
        status: 'success',
        agents_executed: [],
        repos_touched: [],
        artifacts_generated: [],
        evidence_refs: [{
          evidence_type: 'scan_report',
          evidence_id: 'ev-1',
          uri: 'https://evidence.test/scan_report',
          produced_by: 'security-core',
          timestamp: '2026-07-27T12:00:00.000Z',
          verifiable: true,
        }],
        duration_ms: 10,
      },
    })),
  };
}

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, statusText: 'OK', json: async () => body };
}

function makeRuvectorFetch(pages: Array<{ events?: unknown[] }>) {
  const published: Array<{ event: string; payload: unknown }> = [];
  const subscribed: string[] = [];
  let pollIndex = 0;

  const impl = vi.fn(async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = String(input);

    if (url.includes('/events/decisions')) {
      const page = pages[Math.min(pollIndex, pages.length - 1)];
      pollIndex += 1;
      return jsonResponse(page);
    }
    if (url.includes('/v1/subscribe')) {
      subscribed.push(JSON.parse(init?.body ?? '{}').event);
      return jsonResponse({ ok: true });
    }
    if (url.includes('/v1/publish')) {
      const parsed = JSON.parse(init?.body ?? '{}');
      published.push({ event: parsed.event, payload: parsed.payload });
      return jsonResponse({ ok: true });
    }
    return jsonResponse({ ok: true });
  });

  return { impl, published, subscribed };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function buildStack(pages: Array<{ events?: unknown[] }>) {
  const ruvector = makeRuvectorFetch(pages);
  vi.stubGlobal('fetch', ruvector.impl);

  const httpClient = makeHttpClient();
  const dispatcher = new ExecutionDispatcher({
    coreAdapter: new CoreAdapter(registry, httpClient),
    evidenceValidator: new EvidenceValidator(),
    idGenerator: mockIdGen,
    clock: mockClock,
  });
  const dispatchSpy = vi.spyOn(dispatcher, 'dispatchExecution');

  const client = new RuvectorClient({
    serviceUrl: 'https://ruvector.test',
    apiKey: 'test-key',
    clientId: 'execution-engine',
    pollIntervalMs: 5,
  });

  const listener = new ExecutionListener({ ruvectorClient: client, dispatcher });
  return { ...ruvector, dispatcher, dispatchSpy, httpClient, client, listener };
}

describe('ExecutionListener event-driven dispatch', () => {
  let stack: ReturnType<typeof buildStack> | undefined;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    await stack?.listener.stop();
    stack = undefined;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // ADR-009 Verification 2
  it('dispatches and produces an execution graph from one canonical event', async () => {
    stack = buildStack([{ events: [CANONICAL_PLAN_APPROVED] }, { events: [] }]);
    stack.listener.start();

    await waitFor(() => stack!.published.some((p) => p.event === 'execution_completed'));

    expect(stack.dispatchSpy).toHaveBeenCalledTimes(1);
    const completed = stack.published.find((p) => p.event === 'execution_completed')!
      .payload as Record<string, unknown>;

    // execution_id is the ruvector-minted one, consumed not re-minted (ADR-004)
    expect(completed.execution_id).toBe('exec-ruvector-minted-1');
    expect(completed.intent_id).toBe('intent-1');
    expect(completed.status).toBe('completed');
  });

  it('publishes execution_started keyed on the ruvector execution_id', async () => {
    stack = buildStack([{ events: [CANONICAL_PLAN_APPROVED] }, { events: [] }]);
    stack.listener.start();

    await waitFor(() => stack!.published.some((p) => p.event === 'execution_started'));
    const started = stack.published.find((p) => p.event === 'execution_started')!
      .payload as Record<string, unknown>;

    expect(started.execution_id).toBe('exec-ruvector-minted-1');
    expect(started.intent_id).toBe('intent-1');
  });

  // ADR-009 Verification 3: long-poll is at-least-once
  it('dispatches once when the same execution_id is delivered twice', async () => {
    stack = buildStack([
      { events: [CANONICAL_PLAN_APPROVED] },
      { events: [CANONICAL_PLAN_APPROVED] },
      { events: [] },
    ]);
    stack.listener.start();

    await waitFor(() => stack!.published.filter((p) => p.event === 'execution_completed').length >= 2);

    // The listener is invoked twice, but the dispatcher collapses onto one execution.
    expect(stack.dispatchSpy).toHaveBeenCalledTimes(2);
    const graphs = await Promise.all(stack.dispatchSpy.mock.results.map((r) => r.value));
    expect(graphs[0]).toBe(graphs[1]);
    expect(new Set(graphs.map((g) => g.execution_id)).size).toBe(1);

    // The core was contacted once — the redelivery replayed the cached graph.
    expect(stack.httpClient.post).toHaveBeenCalledTimes(1);
  });

  // ADR-009 Verification 6 / Implementation Plan step 8
  it('subscribes only to plan_approved, never to its own execution_started output', async () => {
    stack = buildStack([{ events: [] }]);
    stack.listener.start();

    await waitFor(() => stack!.subscribed.length > 0);
    await new Promise((r) => setTimeout(r, 40));

    expect(stack.subscribed).toEqual(['plan_approved']);
  });

  it('rejects a non-conforming event loudly and does not dispatch', async () => {
    const legacy = {
      event_id: 'evt-legacy',
      type: 'plan_approved',
      runId: 'run-1',
      source: 'orchestration',
      timestamp: '2026-07-27T12:00:00.000Z',
      payload: {},
    };
    stack = buildStack([{ events: [legacy] }, { events: [] }]);
    stack.listener.start();

    await waitFor(() => (console.error as ReturnType<typeof vi.fn>).mock.calls.length > 0);

    expect(stack.dispatchSpy).not.toHaveBeenCalled();
    expect(stack.published).toEqual([]);
    expect(console.error).toHaveBeenCalledWith(
      '[execution] rejected plan_approved event —',
      expect.stringContaining('execution_id'),
    );
  });

  it('keeps polling after rejecting a malformed event', async () => {
    stack = buildStack([
      { events: [{ event_id: 'evt-bad', type: 'plan_approved', payload: {} }] },
      { events: [CANONICAL_PLAN_APPROVED] },
      { events: [] },
    ]);
    stack.listener.start();

    await waitFor(() => stack!.published.some((p) => p.event === 'execution_completed'));
    expect(stack.dispatchSpy).toHaveBeenCalledTimes(1);
  });

  // ADR-009 Verification 7
  it('stop() halts the poll loop', async () => {
    stack = buildStack([{ events: [] }]);
    stack.listener.start();
    await waitFor(() => stack!.impl.mock.calls.length >= 2);

    await stack.listener.stop();
    expect(stack.listener.isRunning()).toBe(false);
    expect(stack.client.isPolling()).toBe(false);

    const callsAtStop = stack.impl.mock.calls.length;
    await new Promise((r) => setTimeout(r, 60));
    expect(stack.impl.mock.calls.length).toBe(callsAtStop);
  });
});
