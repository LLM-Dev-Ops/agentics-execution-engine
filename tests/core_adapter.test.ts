import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CoreAdapter, type ContractRegistry, type HttpClient, type HttpResponse } from '../src/core_adapter.js';

function makeRegistry(entries: Record<string, { version: string; endpoint: string; hash: string }[]>): ContractRegistry {
  return {
    async lookup(coreName: string) {
      const versions = entries[coreName];
      if (!versions) return null;
      return {
        core_name: coreName,
        versions: versions.map((v) => ({
          version: v.version,
          service_endpoint: v.endpoint,
          capabilities: ['execute'],
          contract_hash: v.hash,
        })),
      };
    },
  };
}

function makeHttpClient(response: HttpResponse): HttpClient {
  return {
    post: vi.fn().mockResolvedValue(response),
  };
}

function makeSuccessResponse(coreName = 'test-core'): HttpResponse {
  return {
    status: 200,
    body: {
      core_name: coreName,
      core_version: '1.0.0',
      status: 'success',
      agents_executed: [{ agent_id: 'a1', agent_type: 'coder', task_description: 'test', status: 'completed', duration_ms: 100 }],
      repos_touched: [],
      artifacts_generated: [],
      evidence_refs: [{ evidence_type: 'report', evidence_id: 'e1', uri: 'https://example.com', produced_by: coreName, timestamp: '2026-02-09T12:00:00.000Z', verifiable: true }],
      duration_ms: 500,
    },
  };
}

describe('CoreAdapter.resolveCore', () => {
  it('resolves a core from registry', async () => {
    const registry = makeRegistry({
      'code-gen': [{ version: '1.0.0', endpoint: 'https://code-gen.example.com', hash: 'abc' }],
    });
    const adapter = new CoreAdapter(registry, makeHttpClient(makeSuccessResponse()));

    const resolved = await adapter.resolveCore('code-gen', '1.0.0');
    expect(resolved).not.toBeNull();
    expect(resolved!.name).toBe('code-gen');
    expect(resolved!.endpoint).toBe('https://code-gen.example.com');
    expect(resolved!.contract_hash).toBe('abc');
  });

  it('returns null for unknown core', async () => {
    const registry = makeRegistry({});
    const adapter = new CoreAdapter(registry, makeHttpClient(makeSuccessResponse()));

    const resolved = await adapter.resolveCore('unknown', '^1.0.0');
    expect(resolved).toBeNull();
  });

  it('enforces HTTPS endpoints', async () => {
    const registry = makeRegistry({
      'insecure': [{ version: '1.0.0', endpoint: 'http://insecure.example.com', hash: 'abc' }],
    });
    const adapter = new CoreAdapter(registry, makeHttpClient(makeSuccessResponse()));

    await expect(adapter.resolveCore('insecure', '1.0.0')).rejects.toThrow('HTTPS');
  });

  it('caches resolved cores', async () => {
    const lookupSpy = vi.fn().mockResolvedValue({
      core_name: 'cached',
      versions: [{ version: '1.0.0', service_endpoint: 'https://cached.example.com', capabilities: [], contract_hash: 'hash1' }],
    });
    const registry: ContractRegistry = { lookup: lookupSpy };
    const adapter = new CoreAdapter(registry, makeHttpClient(makeSuccessResponse()));

    await adapter.resolveCore('cached', '1.0.0');
    await adapter.resolveCore('cached', '1.0.0');

    expect(lookupSpy).toHaveBeenCalledTimes(1);
  });
});

describe('CoreAdapter.dispatch', () => {
  it('dispatches to core endpoint and returns result', async () => {
    const httpClient = makeHttpClient(makeSuccessResponse('test-core'));
    const registry = makeRegistry({});
    const adapter = new CoreAdapter(registry, httpClient);

    const core = {
      name: 'test-core',
      version: '1.0.0',
      endpoint: 'https://test.example.com',
      capabilities: [],
      contract_hash: 'hash',
    };

    const result = await adapter.dispatch(core, { input: 'data' }, 30000);
    expect(result.status).toBe('success');
    expect(result.core_name).toBe('test-core');
    expect(httpClient.post).toHaveBeenCalledWith(
      'https://test.example.com/execute',
      expect.objectContaining({ core_name: 'test-core' }),
      expect.objectContaining({ headers: expect.objectContaining({ 'X-Contract-Hash': 'hash' }) }),
    );
  });

  it('returns failed result on invalid response shape', async () => {
    const httpClient = makeHttpClient({ status: 200, body: { bad: 'shape' } });
    const adapter = new CoreAdapter(makeRegistry({}), httpClient);

    const core = {
      name: 'test-core', version: '1.0.0', endpoint: 'https://test.example.com',
      capabilities: [], contract_hash: 'hash',
    };

    const result = await adapter.dispatch(core, {}, 30000);
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('INVALID_RESPONSE');
  });

  it('returns failed result on timeout', async () => {
    const httpClient: HttpClient = {
      post: vi.fn().mockRejectedValue(new Error('request timed out')),
    };
    const adapter = new CoreAdapter(makeRegistry({}), httpClient, {
      max_attempts: 1, base_delay_ms: 0, max_delay_ms: 0, backoff_factor: 1,
      retryable_codes: ['CONNECTION_FAILED'],
    });

    const core = {
      name: 'test-core', version: '1.0.0', endpoint: 'https://test.example.com',
      capabilities: [], contract_hash: 'hash',
    };

    const result = await adapter.dispatch(core, {}, 1000);
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('TIMEOUT');
  });

  it('retries on connection failure', async () => {
    const postFn = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(makeSuccessResponse('test-core'));
    const httpClient: HttpClient = { post: postFn };
    const adapter = new CoreAdapter(makeRegistry({}), httpClient, {
      max_attempts: 3, base_delay_ms: 1, max_delay_ms: 10, backoff_factor: 1,
      retryable_codes: ['CONNECTION_FAILED'],
    });

    const core = {
      name: 'test-core', version: '1.0.0', endpoint: 'https://test.example.com',
      capabilities: [], contract_hash: 'hash',
    };

    const result = await adapter.dispatch(core, {}, 30000);
    expect(result.status).toBe('success');
    expect(postFn).toHaveBeenCalledTimes(2);
  });
});
