export type EventHandler = (payload: unknown) => void;

export interface CursorStore {
  read(): Promise<string | null>;
  write(cursor: string): Promise<void>;
}

export interface RuvectorClientOptions {
  serviceUrl: string;
  apiKey: string;
  clientId: string;
  pollIntervalMs?: number;
  maxBackoffMs?: number;
  cursorStore?: CursorStore;
}

interface RuvectorEvent {
  readonly event_id?: string;
  readonly type?: string;
  readonly [key: string]: unknown;
}

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;

export class RuvectorClient {
  private readonly serviceUrl: string;
  private readonly apiKey: string;
  private readonly clientId: string;
  private readonly pollIntervalMs: number;
  private readonly maxBackoffMs: number;
  private readonly cursorStore: CursorStore | undefined;
  private readonly handlers = new Map<string, EventHandler[]>();
  private connected = false;

  private polling = false;
  private pollLoop: Promise<void> | undefined;
  private lastEventId: string | undefined;
  private cursorLoaded = false;
  private consecutiveFailures = 0;
  private wakeUp: (() => void) | undefined;

  constructor(options: RuvectorClientOptions) {
    this.serviceUrl = options.serviceUrl;
    this.apiKey = options.apiKey;
    this.clientId = options.clientId;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.cursorStore = options.cursorStore;
  }

  async connect(): Promise<void> {
    const url = `${this.serviceUrl}/v1/connect`;
    const res = await fetch(url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ client_id: this.clientId }),
    });
    if (!res.ok) {
      throw new Error(`Ruvector connect failed: ${res.status} ${res.statusText}`);
    }
    this.connected = true;
  }

  isConnected(): boolean {
    return this.connected;
  }

  isPolling(): boolean {
    return this.polling;
  }

  async subscribe(event: string, handler: EventHandler): Promise<void> {
    const existing = this.handlers.get(event);
    if (existing) {
      existing.push(handler);
    } else {
      this.handlers.set(event, [handler]);
    }

    // Server-side bookkeeping only — delivery happens over the poll loop below.
    const url = `${this.serviceUrl}/v1/subscribe`;
    const res = await fetch(url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ client_id: this.clientId, event }),
    });
    if (!res.ok) {
      throw new Error(`Ruvector subscribe failed: ${res.status} ${res.statusText}`);
    }

    this.startPolling();
  }

  async publish(event: string, payload: unknown): Promise<void> {
    const url = `${this.serviceUrl}/v1/publish`;
    const res = await fetch(url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ client_id: this.clientId, event, payload }),
    });
    if (!res.ok) {
      throw new Error(`Ruvector publish failed: ${res.status} ${res.statusText}`);
    }
  }

  async stop(): Promise<void> {
    this.polling = false;
    this.wakeUp?.();
    const loop = this.pollLoop;
    this.pollLoop = undefined;
    if (loop) await loop;
  }

  async disconnect(): Promise<void> {
    await this.stop();
    if (!this.connected) return;
    const url = `${this.serviceUrl}/v1/disconnect`;
    await fetch(url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ client_id: this.clientId }),
    }).catch(() => {});
    this.connected = false;
  }

  private startPolling(): void {
    if (this.polling) return;
    this.polling = true;
    this.pollLoop = this.runPollLoop();
  }

  private async runPollLoop(): Promise<void> {
    while (this.polling) {
      try {
        const events = await this.fetchEvents();
        if (!this.polling) break;

        for (const event of events) {
          this.deliver(event);
          if (event.event_id) await this.commitCursor(event.event_id);
        }
        this.consecutiveFailures = 0;
      } catch (err: unknown) {
        this.consecutiveFailures += 1;
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[ruvector] poll failed (attempt ${this.consecutiveFailures}):`, message);
      }

      if (!this.polling) break;
      await this.delay(this.nextDelayMs());
    }
  }

  private async fetchEvents(): Promise<RuvectorEvent[]> {
    await this.loadCursor();

    const url = new URL(`${this.serviceUrl}/events/decisions`);
    if (this.lastEventId) url.searchParams.set('after', this.lastEventId);
    url.searchParams.set('types', [...this.handlers.keys()].join(','));
    url.searchParams.set('client_id', this.clientId);

    const res = await fetch(url.toString(), { method: 'GET', headers: this.headers() });
    if (!res.ok) {
      throw new Error(`Ruvector event fetch failed: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as { events?: RuvectorEvent[] };
    return data.events ?? [];
  }

  private deliver(event: RuvectorEvent): void {
    const handlers = event.type ? this.handlers.get(event.type) : undefined;
    if (!handlers) return;

    for (const handler of handlers) {
      try {
        handler(event);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[ruvector] handler for ${event.type} threw:`, message);
      }
    }
  }

  private async loadCursor(): Promise<void> {
    if (this.cursorLoaded || !this.cursorStore) return;
    this.cursorLoaded = true;
    try {
      this.lastEventId = (await this.cursorStore.read()) ?? undefined;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[ruvector] failed to read poll cursor, starting from head:', message);
    }
  }

  private async commitCursor(eventId: string): Promise<void> {
    this.lastEventId = eventId;
    if (!this.cursorStore) return;
    try {
      await this.cursorStore.write(eventId);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[ruvector] failed to persist poll cursor:', message);
    }
  }

  private nextDelayMs(): number {
    if (this.consecutiveFailures === 0) return this.pollIntervalMs;
    const backoff = this.pollIntervalMs * 2 ** this.consecutiveFailures;
    return Math.min(backoff, this.maxBackoffMs);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wakeUp = undefined;
        resolve();
      }, ms);
      timer.unref?.();
      this.wakeUp = () => {
        clearTimeout(timer);
        this.wakeUp = undefined;
        resolve();
      };
    });
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
    };
  }
}
