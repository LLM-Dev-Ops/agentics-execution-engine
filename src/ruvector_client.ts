export interface RuvectorClientOptions {
  serviceUrl: string;
  apiKey: string;
  clientId: string;
}

export class RuvectorClient {
  private readonly serviceUrl: string;
  private readonly apiKey: string;
  private readonly clientId: string;
  private connected = false;

  constructor(options: RuvectorClientOptions) {
    this.serviceUrl = options.serviceUrl;
    this.apiKey = options.apiKey;
    this.clientId = options.clientId;
  }

  async connect(): Promise<void> {
    const url = `${this.serviceUrl}/v1/connect`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
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

  async subscribe(event: string, handler: (payload: unknown) => void): Promise<void> {
    const url = `${this.serviceUrl}/v1/subscribe`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ client_id: this.clientId, event }),
    });
    if (!res.ok) {
      throw new Error(`Ruvector subscribe failed: ${res.status} ${res.statusText}`);
    }
  }

  async publish(event: string, payload: unknown): Promise<void> {
    const url = `${this.serviceUrl}/v1/publish`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ client_id: this.clientId, event, payload }),
    });
    if (!res.ok) {
      throw new Error(`Ruvector publish failed: ${res.status} ${res.statusText}`);
    }
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    const url = `${this.serviceUrl}/v1/disconnect`;
    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ client_id: this.clientId }),
    }).catch(() => {});
    this.connected = false;
  }
}
