const API_BASE = 'http://127.0.0.1:8787';
const TIMEOUT_MS = 5000;

async function request(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export class LocalSyncClient {
  async push(operation) {
    const response = await request(`${API_BASE}/v1/sync/operations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(operation)
    });
    const result = await response.json();
    // 业务状态（applied / duplicate / conflict / rejected）返回给上层处理；
    // 仅服务端异常（5xx / 网络失败 / 非 JSON）抛出异常，进入“失败重试”路径。
    if (response.status >= 500) throw new Error(result.code ?? 'SYNC_FAILED');
    return result;
  }

  async pull(cursor) {
    const response = await request(`${API_BASE}/v1/sync/changes?after=${encodeURIComponent(cursor)}`);
    if (!response.ok) throw new Error('SYNC_FAILED');
    return response.json();
  }
}
