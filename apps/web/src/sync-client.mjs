const API_BASE = 'http://127.0.0.1:8787';

export class LocalSyncClient {
  async push(operation) {
    const response = await fetch(`${API_BASE}/v1/sync/operations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(operation)
    });
    const result = await response.json();
    if (!response.ok && response.status !== 409) throw new Error(result.code ?? 'SYNC_FAILED');
    return result;
  }

  async pull(cursor) {
    const response = await fetch(`${API_BASE}/v1/sync/changes?after=${encodeURIComponent(cursor)}`);
    if (!response.ok) throw new Error('SYNC_FAILED');
    return response.json();
  }
}
