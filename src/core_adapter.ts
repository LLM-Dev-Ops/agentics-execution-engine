import type { ResolvedCore, CoreExecutionResult } from './types/core.js';
import type { ExecutionError } from './types/errors.js';
import { makeError } from './types/errors.js';
import { validateResultShape } from './utils/validation.js';

export interface ContractRegistry {
  lookup(coreName: string): Promise<ContractEntry | null>;
}

export interface ContractEntry {
  readonly core_name: string;
  readonly versions: readonly ContractVersion[];
}

export interface ContractVersion {
  readonly version: string;
  readonly service_endpoint: string;
  readonly capabilities: readonly string[];
  readonly contract_hash: string;
}

export interface HttpClient {
  post(
    url: string,
    body: unknown,
    options: { timeout: number; headers?: Record<string, string> },
  ): Promise<HttpResponse>;
}

export interface HttpResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface RetryPolicy {
  readonly max_attempts: number;
  readonly base_delay_ms: number;
  readonly max_delay_ms: number;
  readonly backoff_factor: number;
  readonly retryable_codes: readonly string[];
}

interface CachedResolution {
  readonly resolved_core: ResolvedCore;
  readonly cached_at: number;
  readonly ttl_ms: number;
}

const DEFAULT_RETRY_POLICY: RetryPolicy = {
  max_attempts: 3,
  base_delay_ms: 200,
  max_delay_ms: 2000,
  backoff_factor: 2.0,
  retryable_codes: ['REGISTRY_UNAVAILABLE', 'CONNECTION_FAILED'],
};

const DEFAULT_CACHE_TTL_MS = 60_000;

function satisfiesVersion(
  available: string,
  constraint: string,
): boolean {
  try {
    // Dynamic import not ideal in sync context; use a simple prefix check
    // for semver satisfaction. Full semver is used at runtime.
    const semver = require('semver') as typeof import('semver');
    return semver.satisfies(available, constraint);
  } catch {
    return available === constraint;
  }
}

export class CoreAdapter {
  private readonly cache = new Map<string, CachedResolution>();

  constructor(
    private readonly registry: ContractRegistry,
    private readonly httpClient: HttpClient,
    private readonly retryPolicy: RetryPolicy = DEFAULT_RETRY_POLICY,
    private readonly cacheTtlMs: number = DEFAULT_CACHE_TTL_MS,
  ) {}

  async resolveCore(
    coreName: string,
    versionConstraint: string,
  ): Promise<ResolvedCore | null> {
    const cacheKey = `${coreName}:${versionConstraint}`;
    const cached = this.cache.get(cacheKey);

    if (cached && Date.now() - cached.cached_at < cached.ttl_ms) {
      return cached.resolved_core;
    }

    const contract = await this.registry.lookup(coreName);
    if (!contract) return null;

    const matchingVersion = contract.versions.find((v) =>
      satisfiesVersion(v.version, versionConstraint),
    );
    if (!matchingVersion) return null;

    if (!matchingVersion.service_endpoint.startsWith('https://')) {
      throw new Error(`Core endpoint must use HTTPS: ${matchingVersion.service_endpoint}`);
    }

    const resolved: ResolvedCore = {
      name: coreName,
      version: matchingVersion.version,
      endpoint: matchingVersion.service_endpoint,
      capabilities: [...matchingVersion.capabilities],
      contract_hash: matchingVersion.contract_hash,
    };

    this.cache.set(cacheKey, {
      resolved_core: resolved,
      cached_at: Date.now(),
      ttl_ms: this.cacheTtlMs,
    });

    return resolved;
  }

  evictCache(coreName: string, versionConstraint: string): void {
    this.cache.delete(`${coreName}:${versionConstraint}`);
  }

  async dispatch(
    core: ResolvedCore,
    inputs: Readonly<Record<string, unknown>>,
    timeoutMs: number,
  ): Promise<CoreExecutionResult> {
    const url = `${core.endpoint}/execute`;
    const body = {
      core_name: core.name,
      core_version: core.version,
      inputs,
    };
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Contract-Hash': core.contract_hash,
    };

    const startTime = Date.now();

    for (let attempt = 1; attempt <= this.retryPolicy.max_attempts; attempt++) {
      try {
        const response = await this.httpClient.post(url, body, {
          timeout: timeoutMs,
          headers,
        });

        if (!validateResultShape(response.body)) {
          return failedResult(core, startTime, 'INVALID_RESPONSE', 'Core returned non-conforming response');
        }

        return response.body as CoreExecutionResult;
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        const errorCode = classifyDispatchError(err);

        if (
          errorCode === 'CONNECTION_FAILED' &&
          this.retryPolicy.retryable_codes.includes(errorCode) &&
          attempt < this.retryPolicy.max_attempts
        ) {
          const delay = Math.min(
            this.retryPolicy.base_delay_ms * Math.pow(this.retryPolicy.backoff_factor, attempt - 1),
            this.retryPolicy.max_delay_ms,
          );
          await sleep(delay);
          continue;
        }

        return failedResult(core, startTime, errorCode, errorMessage);
      }
    }

    return failedResult(core, startTime, 'CONNECTION_FAILED', 'All retry attempts exhausted');
  }
}

function failedResult(
  core: ResolvedCore,
  startTime: number,
  code: ExecutionError['code'],
  message: string,
): CoreExecutionResult {
  return {
    core_name: core.name,
    core_version: core.version,
    status: 'failed',
    agents_executed: [],
    repos_touched: [],
    artifacts_generated: [],
    evidence_refs: [],
    duration_ms: Date.now() - startTime,
    error: makeError(code, message, code === 'CONNECTION_FAILED'),
  };
}

function classifyDispatchError(err: unknown): ExecutionError['code'] {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('abort')) {
      return 'TIMEOUT';
    }
    if (msg.includes('econnrefused') || msg.includes('enotfound') || msg.includes('fetch failed') || msg.includes('network')) {
      return 'CONNECTION_FAILED';
    }
  }
  return 'CONNECTION_FAILED';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
