export class ProviderClient {
  // A hung provider call becomes an uncertain (UNKNOWN) result instead of blocking forever.
  constructor(baseUrl = 'http://127.0.0.1:4301', { sendTimeoutMs = 15000, lookupTimeoutMs = 5000 } = {}) {
    this.baseUrl = baseUrl; this.sendTimeoutMs = sendTimeoutMs; this.lookupTimeoutMs = lookupTimeoutMs;
  }
  // Only HTTP 503 means "definitely not accepted". 504, other errors, timeouts and
  // connection loss are uncertain: the provider may have accepted the message.
  async send(payload) {
    const response = await fetch(`${this.baseUrl}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.sendTimeoutMs)
    });
    if (!response.ok) {
      const error = new Error(`Provider did not confirm delivery (HTTP ${response.status})`);
      error.kind = response.status === 503 ? 'not_accepted' : 'unknown';
      throw error;
    }
    return response.json();
  }
  async lookup(clientRef) {
    const r = await fetch(`${this.baseUrl}/messages?clientRef=${encodeURIComponent(clientRef)}`,
      { signal: AbortSignal.timeout(this.lookupTimeoutMs) });
    if (!r.ok) throw new Error(`Lookup unavailable (HTTP ${r.status})`);
    return r.json();
  }
}
