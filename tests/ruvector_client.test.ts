import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RuvectorClient, type CursorStore } from '../src/ruvector_client.js';

interface FetchCall {
  readonly url: string;
  readonly method: string;
}

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, statusText: 'OK', json: async () => body };
}

/**
 * Routes POST /v1/* to a generic ack and GET /events/decisions to successive
 * entries of `pages`, repeating the last page once exhausted.
 */
function makeFetch(pages: Array<{ events?: unknown[] } | Error>) {
  const calls: FetchCall[] = [];
  let pollIndex = 0;

  const impl = vi.fn(async (input: unknown, init?: { method?: string }) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method });

    if (url.includes('/events/decisions')) {
      const page = pages[Math.min(pollIndex, pages.length - 1)];
      pollIndex += 1;
      if (page instanceof Error) throw page;
      return jsonResponse(page);
    }
    return jsonResponse({ ok: true });
  });

  return { impl, calls, pollCount: () => calls.filter((c) => c.url.includes('/events/decisions')).length };
}

function pollUrls(calls: FetchCall[]): string[] {
  return calls.filter((c) => c.url.includes('/events/decisions')).map((c) => c.url);
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const baseOptions = {
  serviceUrl: 'https://ruvector.test',
  apiKey: 'test-key',
  clientId: 'execution-engine',
  pollIntervalMs: 5,
};

describe('RuvectorClient long-poll subscription', () => {
  let client: RuvectorClient | undefined;

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    await client?.stop();
    client = undefined;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // ADR-009 Verification 1: the regression test. The pre-ADR implementation stored
  // the handler nowhere, so it could never be invoked.
  it('invokes a registered handler with an event delivered by the poll loop', async () => {
    const event = { event_id: 'evt-1', type: 'plan_approved', execution_id: 'exec-1' };
    const { impl } = makeFetch([{ events: [event] }, { events: [] }]);
    vi.stubGlobal('fetch', impl);

    client = new RuvectorClient(baseOptions);
    const received: unknown[] = [];
    await client.subscribe('plan_approved', (payload) => received.push(payload));

    await waitFor(() => received.length > 0);
    expect(received).toEqual([event]);
  });

  it('does not invoke handlers for event types it did not subscribe to', async () => {
    const { impl } = makeFetch([
      { events: [{ event_id: 'evt-1', type: 'plan_rejected' }] },
      { events: [] },
    ]);
    vi.stubGlobal('fetch', impl);

    client = new RuvectorClient(baseOptions);
    const received: unknown[] = [];
    await client.subscribe('plan_approved', (payload) => received.push(payload));

    await waitFor(() => impl.mock.calls.length >= 3);
    expect(received).toEqual([]);
  });

  it('sends the subscribed types filter and the client id on each poll', async () => {
    const { impl, calls } = makeFetch([{ events: [] }]);
    vi.stubGlobal('fetch', impl);

    client = new RuvectorClient(baseOptions);
    await client.subscribe('plan_approved', () => {});

    await waitFor(() => pollUrls(calls).length > 0);
    const url = new URL(pollUrls(calls)[0]);
    expect(url.searchParams.get('types')).toBe('plan_approved');
    expect(url.searchParams.get('client_id')).toBe('execution-engine');
    expect(url.searchParams.get('after')).toBeNull();
  });

  it('advances the after cursor past the last delivered event', async () => {
    const { impl, calls } = makeFetch([
      { events: [{ event_id: 'evt-1', type: 'plan_approved' }, { event_id: 'evt-2', type: 'plan_approved' }] },
      { events: [] },
    ]);
    vi.stubGlobal('fetch', impl);

    client = new RuvectorClient(baseOptions);
    await client.subscribe('plan_approved', () => {});

    await waitFor(() => pollUrls(calls).length >= 2);
    expect(new URL(pollUrls(calls)[1]).searchParams.get('after')).toBe('evt-2');
  });

  it('resumes from a persisted cursor instead of replaying from the beginning', async () => {
    const { impl, calls } = makeFetch([{ events: [] }]);
    vi.stubGlobal('fetch', impl);

    const written: string[] = [];
    const store: CursorStore = {
      read: async () => 'evt-99',
      write: async (c) => { written.push(c); },
    };

    client = new RuvectorClient({ ...baseOptions, cursorStore: store });
    await client.subscribe('plan_approved', () => {});

    await waitFor(() => pollUrls(calls).length > 0);
    expect(new URL(pollUrls(calls)[0]).searchParams.get('after')).toBe('evt-99');
  });

  it('persists the cursor for each delivered event', async () => {
    const { impl } = makeFetch([
      { events: [{ event_id: 'evt-1', type: 'plan_approved' }] },
      { events: [] },
    ]);
    vi.stubGlobal('fetch', impl);

    const written: string[] = [];
    const store: CursorStore = {
      read: async () => null,
      write: async (c) => { written.push(c); },
    };

    client = new RuvectorClient({ ...baseOptions, cursorStore: store });
    await client.subscribe('plan_approved', () => {});

    await waitFor(() => written.length > 0);
    expect(written).toEqual(['evt-1']);
  });

  it('survives a failing poll and delivers on the next successful one', async () => {
    const { impl } = makeFetch([
      new Error('ruvector unreachable'),
      { events: [{ event_id: 'evt-1', type: 'plan_approved' }] },
      { events: [] },
    ]);
    vi.stubGlobal('fetch', impl);

    client = new RuvectorClient({ ...baseOptions, maxBackoffMs: 20 });
    const received: unknown[] = [];
    await client.subscribe('plan_approved', (payload) => received.push(payload));

    await waitFor(() => received.length > 0);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('poll failed (attempt 1)'),
      'ruvector unreachable',
    );
  });

  it('backs off exponentially while polls keep failing', async () => {
    const { impl } = makeFetch([new Error('down')]);
    vi.stubGlobal('fetch', impl);

    client = new RuvectorClient({ ...baseOptions, pollIntervalMs: 10, maxBackoffMs: 40 });
    await client.subscribe('plan_approved', () => {});

    // 10ms base: first retry waits 20ms, second 40ms, then capped at 40ms.
    // Without backoff a 10ms interval would produce far more polls in 120ms.
    await new Promise((r) => setTimeout(r, 120));
    const polls = impl.mock.calls.filter((c) => String(c[0]).includes('/events/decisions')).length;
    expect(polls).toBeLessThanOrEqual(6);
    expect(polls).toBeGreaterThanOrEqual(2);
  });

  it('a handler that throws does not kill the poll loop', async () => {
    const { impl } = makeFetch([
      { events: [{ event_id: 'evt-1', type: 'plan_approved' }] },
      { events: [{ event_id: 'evt-2', type: 'plan_approved' }] },
      { events: [] },
    ]);
    vi.stubGlobal('fetch', impl);

    client = new RuvectorClient(baseOptions);
    const received: string[] = [];
    await client.subscribe('plan_approved', (payload) => {
      const id = (payload as { event_id: string }).event_id;
      received.push(id);
      if (id === 'evt-1') throw new Error('handler blew up');
    });

    await waitFor(() => received.length >= 2);
    expect(received).toEqual(['evt-1', 'evt-2']);
  });

  // ADR-009 Verification 7
  it('stop() terminates the loop and no request is issued after it resolves', async () => {
    const { impl } = makeFetch([{ events: [] }]);
    vi.stubGlobal('fetch', impl);

    client = new RuvectorClient(baseOptions);
    await client.subscribe('plan_approved', () => {});
    await waitFor(() => impl.mock.calls.length >= 2);

    await client.stop();
    expect(client.isPolling()).toBe(false);

    const callsAtStop = impl.mock.calls.length;
    await new Promise((r) => setTimeout(r, 60));
    expect(impl.mock.calls.length).toBe(callsAtStop);
  });

  it('propagates a failed subscribe registration', async () => {
    const impl = vi.fn(async () => ({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      json: async () => ({}),
    }));
    vi.stubGlobal('fetch', impl);

    client = new RuvectorClient(baseOptions);
    await expect(client.subscribe('plan_approved', () => {})).rejects.toThrow(
      'Ruvector subscribe failed: 403 Forbidden',
    );
    expect(client.isPolling()).toBe(false);
  });
});
