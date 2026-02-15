import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ExecutionDispatcher } from './execution_dispatcher.js';
import { CoreAdapter, type ContractRegistry, type ContractEntry, type HttpClient, type HttpResponse } from './core_adapter.js';
import { EvidenceValidator } from './evidence_validator.js';
import type { ExecutionIntent } from './types/intent.js';
import { RuvectorClient } from './ruvector_client.js';
import { ExecutionListener } from './execution_listener.js';

const PORT = parseInt(process.env.PORT ?? '8080', 10);
const HMAC_SECRET = process.env.EXECUTION_HMAC_SECRET ?? '';
const PLATFORM_API_KEY = process.env.PLATFORM_API_KEY ?? '';
const RESULTS_INDEX_URL = process.env.RESULTS_INDEX_URL ?? '';
const AGENTICS_MODE = process.env.AGENTICS_MODE ?? '';
const AGENTICS_ROLE = process.env.AGENTICS_ROLE ?? '';

console.log('[BOOT] execution-engine mode:', AGENTICS_MODE);

// --- ContractRegistry backed by platform API ---

class PlatformContractRegistry implements ContractRegistry {
  constructor(
    private readonly platformApiKey: string,
    private readonly resultsIndexUrl: string,
  ) {}

  async lookup(coreName: string): Promise<ContractEntry | null> {
    if (!this.resultsIndexUrl) return null;
    const url = `${this.resultsIndexUrl}/contracts/${encodeURIComponent(coreName)}`;
    try {
      const res = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${this.platformApiKey}`,
          'Accept': 'application/json',
        },
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Registry returned ${res.status}`);
      return (await res.json()) as ContractEntry;
    } catch {
      return null;
    }
  }
}

// --- HttpClient using native fetch ---

class FetchHttpClient implements HttpClient {
  async post(
    url: string,
    body: unknown,
    options: { timeout: number; headers?: Record<string, string> },
  ): Promise<HttpResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeout);
    try {
      const res = await fetch(url, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: {
          'Content-Type': 'application/json',
          ...options.headers,
        },
        signal: controller.signal,
      });
      const responseBody = await res.json().catch(() => null);
      return { status: res.status, body: responseBody };
    } finally {
      clearTimeout(timer);
    }
  }
}

// --- HMAC verification ---

function verifyHmac(payload: string, signature: string | undefined): boolean {
  if (!HMAC_SECRET) return true; // skip if no secret configured
  if (!signature) return false;
  const expected = createHmac('sha256', HMAC_SECRET).update(payload).digest('hex');
  const sig = signature.replace(/^sha256=/, '');
  if (sig.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
}

// --- Request helpers ---

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

// --- Bootstrap dispatcher ---

const registry = new PlatformContractRegistry(PLATFORM_API_KEY, RESULTS_INDEX_URL);
const httpClient = new FetchHttpClient();
const coreAdapter = new CoreAdapter(registry, httpClient);
const evidenceValidator = new EvidenceValidator();
const dispatcher = new ExecutionDispatcher({ coreAdapter, evidenceValidator });

// --- HTTP server ---

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  // Health check
  if (url.pathname === '/health' && req.method === 'GET') {
    return json(res, 200, { status: 'ok', service: 'agentics-execution-engine', timestamp: new Date().toISOString() });
  }

  // Ready check
  if (url.pathname === '/ready' && req.method === 'GET') {
    return json(res, 200, { ready: true });
  }

  // Execute intent
  if (url.pathname === '/v1/execute' && req.method === 'POST') {
    try {
      const body = await readBody(req);

      // HMAC verification
      if (!verifyHmac(body, req.headers['x-signature'] as string | undefined)) {
        return json(res, 401, { error: 'Invalid HMAC signature' });
      }

      const intent: ExecutionIntent = JSON.parse(body);
      const graph = await dispatcher.dispatchExecution(intent);
      return json(res, 200, graph);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Internal error';
      return json(res, 500, { error: message });
    }
  }

  // 404
  json(res, 404, { error: 'Not found' });
});

// --- Execution listener for AGENTICS_MODE=execution or AGENTICS_ROLE=execution ---

async function startExecutionListener(): Promise<void> {
  console.log('[execution] starting listener…');

  const ruvectorClient = new RuvectorClient({
    serviceUrl: process.env.RUVECTOR_SERVICE_URL!,
    apiKey: process.env.RUVECTOR_API_KEY!,
    clientId: 'execution-engine',
  });

  await ruvectorClient.connect();

  console.log('[execution] connected to ruvector');

  const listener = new ExecutionListener({
    ruvectorClient,
    dispatcher,
  });

  listener.start();

  console.log('[execution] listener started');
}

// --- Boot ---

server.listen(PORT, '0.0.0.0', () => {
  console.log(`agentics-execution-engine listening on port ${PORT}`);
});

(async () => {
  if (AGENTICS_MODE === 'execution' || AGENTICS_ROLE === 'execution') {
    try {
      await startExecutionListener();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[execution] listener failed to start (non-fatal):', message);
    }
  }
})();
