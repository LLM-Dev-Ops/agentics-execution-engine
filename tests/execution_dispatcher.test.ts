import { describe, it, expect, vi } from 'vitest';
import { ExecutionDispatcher } from '../src/execution_dispatcher.js';
import { EvidenceValidator } from '../src/evidence_validator.js';
import { CoreAdapter, type ContractRegistry, type HttpClient } from '../src/core_adapter.js';
import type { ExecutionIntent } from '../src/types/intent.js';
import type { IdGenerator, Clock } from '../src/execution_trace.js';

let idCounter = 0;
const mockIdGen: IdGenerator = { generate: () => `id-${++idCounter}` };
const mockClock: Clock = { now: () => '2026-02-09T12:00:00.000Z' };

function makeRegistry(cores: Record<string, string>): ContractRegistry {
  return {
    async lookup(coreName: string) {
      const endpoint = cores[coreName];
      if (!endpoint) return null;
      return {
        core_name: coreName,
        versions: [{
          version: '1.0.0',
          service_endpoint: endpoint,
          capabilities: ['execute'],
          contract_hash: 'hash-' + coreName,
        }],
      };
    },
  };
}

function makeHttpClient(results: Record<string, unknown>): HttpClient {
  return {
    post: vi.fn().mockImplementation(async (url: string, body: unknown) => {
      const reqBody = body as Record<string, unknown>;
      const coreName = reqBody?.core_name as string;
      if (coreName && results[coreName]) return { status: 200, body: results[coreName] };
      // Fallback: match on URL
      const urlMatch = Object.keys(results).find((k) => url.toLowerCase().includes(k.toLowerCase()));
      if (urlMatch) return { status: 200, body: results[urlMatch] };
      return { status: 200, body: results['_default'] ?? { bad: 'shape' } };
    }),
  };
}

function makeCoreResult(coreName: string, evidenceTypes: string[] = []) {
  return {
    core_name: coreName,
    core_version: '1.0.0',
    status: 'success',
    agents_executed: [{ agent_id: 'a1', agent_type: 'coder', task_description: 'work', status: 'completed', duration_ms: 100 }],
    repos_touched: [{ repo_uri: 'https://github.com/test', branch: 'main', commits: ['abc'], files_changed: ['file.ts'] }],
    artifacts_generated: [],
    evidence_refs: evidenceTypes.map((t, i) => ({
      evidence_type: t,
      evidence_id: `ev-${i}`,
      uri: `https://evidence.example.com/${t}`,
      produced_by: coreName,
      timestamp: '2026-02-09T12:00:00.000Z',
      verifiable: true,
    })),
    duration_ms: 500,
  };
}

function makeIntent(overrides: Partial<ExecutionIntent> = {}): ExecutionIntent {
  return {
    intent_id: 'intent-1',
    requested_by: 'user-1',
    cores_required: [
      {
        core_name: 'code-gen',
        version_constraint: '1.0.0',
        inputs: { language: 'typescript' },
        evidence_required: ['test_report'],
      },
    ],
    parameters: {},
    evidence_policy: {
      fail_on_missing: true,
      required_evidence_types: [],
      minimum_evidence_count: 0,
    },
    timeout_ms: 30000,
    ...overrides,
  };
}

function makeDispatcher(
  registryCores: Record<string, string>,
  httpResults: Record<string, unknown>,
) {
  const registry = makeRegistry(registryCores);
  const httpClient = makeHttpClient(httpResults);
  const coreAdapter = new CoreAdapter(registry, httpClient, {
    max_attempts: 1, base_delay_ms: 0, max_delay_ms: 0, backoff_factor: 1, retryable_codes: [],
  });
  const evidenceValidator = new EvidenceValidator();

  return new ExecutionDispatcher({
    coreAdapter,
    evidenceValidator,
    idGenerator: mockIdGen,
    clock: mockClock,
  });
}

describe('ExecutionDispatcher', () => {
  beforeEach(() => { idCounter = 0; });

  it('produces a complete execution graph on success', async () => {
    const dispatcher = makeDispatcher(
      { 'code-gen': 'https://code-gen.example.com' },
      { 'code-gen': makeCoreResult('code-gen', ['test_report']) },
    );

    const graph = await dispatcher.dispatchExecution(makeIntent());

    expect(graph.status).toBe('completed');
    expect(graph.intent_id).toBe('intent-1');
    expect(graph.execution_id).toBeTruthy();
    expect(graph.nodes.length).toBeGreaterThan(0);
    expect(graph.edges.length).toBeGreaterThan(0);
    expect(graph.core_results).toHaveLength(1);
    expect(graph.core_results[0].core_name).toBe('code-gen');
    expect(graph.core_results[0].agents_executed).toHaveLength(1);
    expect(graph.core_results[0].repos_touched).toHaveLength(1);
    expect(graph.evidence_summary.all_satisfied).toBe(true);
  });

  it('returns failed graph when intent validation fails', async () => {
    const dispatcher = makeDispatcher({}, {});

    const graph = await dispatcher.dispatchExecution(
      makeIntent({ intent_id: '', cores_required: [] }),
    );

    expect(graph.status).toBe('failed');
    expect(graph.nodes.some((n) => n.node_type === 'intent_resolution' && n.status === 'failed')).toBe(true);
    expect(graph.core_results).toHaveLength(0);
  });

  it('returns failed graph when core is not found', async () => {
    const dispatcher = makeDispatcher({}, {}); // empty registry

    const graph = await dispatcher.dispatchExecution(makeIntent());

    expect(graph.status).toBe('failed');
    expect(graph.evidence_summary.missing_evidence.some((m) => m.evidence_type === 'CORE_NOT_FOUND')).toBe(true);
  });

  it('returns failed graph on circular dependency', async () => {
    const dispatcher = makeDispatcher(
      { 'A': 'https://a.example.com', 'B': 'https://b.example.com' },
      { 'A': makeCoreResult('A'), 'B': makeCoreResult('B') },
    );

    const graph = await dispatcher.dispatchExecution(
      makeIntent({
        cores_required: [
          { core_name: 'A', version_constraint: '1.0.0', inputs: { dep: { from_core: 'B', output_key: 'x' } }, evidence_required: [] },
          { core_name: 'B', version_constraint: '1.0.0', inputs: { dep: { from_core: 'A', output_key: 'y' } }, evidence_required: [] },
        ],
      }),
    );

    expect(graph.status).toBe('failed');
    expect(graph.evidence_summary.missing_evidence.some((m) => m.evidence_type === 'CYCLE_DETECTED')).toBe(true);
  });

  it('fails execution when required evidence is missing', async () => {
    const dispatcher = makeDispatcher(
      { 'code-gen': 'https://code-gen.example.com' },
      { 'code-gen': makeCoreResult('code-gen', []) }, // no evidence
    );

    const graph = await dispatcher.dispatchExecution(makeIntent());

    expect(graph.status).toBe('failed');
    expect(graph.evidence_summary.all_satisfied).toBe(false);
    expect(graph.evidence_summary.missing_evidence.length).toBeGreaterThan(0);
  });

  it('allows missing evidence when fail_on_missing is false', async () => {
    const dispatcher = makeDispatcher(
      { 'code-gen': 'https://code-gen.example.com' },
      { 'code-gen': makeCoreResult('code-gen', []) }, // no evidence
    );

    const graph = await dispatcher.dispatchExecution(
      makeIntent({
        evidence_policy: {
          fail_on_missing: false,
          required_evidence_types: [],
          minimum_evidence_count: 0,
        },
      }),
    );

    expect(graph.status).toBe('partial_failure');
    expect(graph.evidence_summary.all_satisfied).toBe(false);
    // Graph still produced with full data
    expect(graph.core_results).toHaveLength(1);
    expect(graph.nodes.length).toBeGreaterThan(0);
  });

  it('dispatches multiple independent cores in parallel', async () => {
    const dispatcher = makeDispatcher(
      { 'A': 'https://a.example.com', 'B': 'https://b.example.com' },
      {
        'A': makeCoreResult('A', ['report_a']),
        'B': makeCoreResult('B', ['report_b']),
      },
    );

    const graph = await dispatcher.dispatchExecution(
      makeIntent({
        cores_required: [
          { core_name: 'A', version_constraint: '1.0.0', inputs: {}, evidence_required: ['report_a'] },
          { core_name: 'B', version_constraint: '1.0.0', inputs: {}, evidence_required: ['report_b'] },
        ],
      }),
    );

    expect(graph.status).toBe('completed');
    expect(graph.core_results).toHaveLength(2);
    expect(graph.evidence_summary.all_satisfied).toBe(true);
  });

  it('always produces a graph even on failure', async () => {
    const dispatcher = makeDispatcher({}, {});

    const graph = await dispatcher.dispatchExecution(
      makeIntent({ cores_required: [] }),
    );

    expect(graph).toBeDefined();
    expect(graph.execution_id).toBeTruthy();
    expect(graph.intent_id).toBe('intent-1');
    expect(graph.status).toBe('failed');
    expect(graph.started_at).toBeTruthy();
    expect(graph.completed_at).toBeTruthy();
    expect(JSON.stringify(graph)).toBeTruthy(); // NFR-4: JSON serializable
  });

  it('execution graph is JSON serializable', async () => {
    const dispatcher = makeDispatcher(
      { 'code-gen': 'https://code-gen.example.com' },
      { 'code-gen': makeCoreResult('code-gen', ['test_report']) },
    );

    const graph = await dispatcher.dispatchExecution(makeIntent());
    const json = JSON.stringify(graph);
    const parsed = JSON.parse(json);

    expect(parsed.execution_id).toBe(graph.execution_id);
    expect(parsed.nodes).toHaveLength(graph.nodes.length);
    expect(parsed.core_results).toHaveLength(graph.core_results.length);
  });
});
