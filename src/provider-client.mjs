export class ProviderClient {
  constructor(baseUrl = 'http://127.0.0.1:4301') { this.baseUrl = baseUrl; }
  async send(payload) {
    const response = await fetch(`${this.baseUrl}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    if (!response.ok) {
      const error = new Error('Provider did not confirm delivery');
      error.kind = response.status === 503 ? 'not_accepted' : 'unknown';
      throw error;
    }
    return response.json();
  }
  async lookup(clientRef) {
    const r = await fetch(`${this.baseUrl}/messages?clientRef=${encodeURIComponent(clientRef)}`);
    if (!r.ok) throw new Error('Lookup unavailable');
    return r.json();
  }
}
