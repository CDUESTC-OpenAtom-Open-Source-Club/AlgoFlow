const TEST_DATA_HEADER = 'X-AlgoFlow-Test-Data';

export class AIClientError extends Error {
  /** @param {string} code @param {string} message @param {number} status */
  constructor(code, message, status) {
    super(message);
    this.name = 'AIClientError';
    this.code = code;
    this.status = status;
  }
}

export class WebAIClient {
  /** @param {string} [baseUrl] */
  constructor(baseUrl = import.meta.env?.VITE_AI_GATEWAY_BASE ?? 'http://127.0.0.1:8788') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  /** @param {Record<string, unknown>} request @param {{signal?: AbortSignal}} [options] */
  requestReview(request, options = {}) {
    return this.#request('/reviews', request, options);
  }

  /** @param {Record<string, unknown>} request @param {{signal?: AbortSignal}} [options] */
  requestCompletion(request, options = {}) {
    return this.#request('/completions', request, options);
  }

  /** @param {Record<string, unknown>} request @param {{signal?: AbortSignal}} [options] */
  requestTransform(request, options = {}) {
    return this.#request('/requests', request, options);
  }

  /** @param {string} path @param {Record<string, unknown>} body @param {{signal?: AbortSignal}} [options] */
  async #request(path, body, { signal } = {}) {
    let response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal
      });
    } catch (/** @type {unknown} */ error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new AIClientError('AI_PROVIDER_ERROR', '无法连接 AI 服务', 502);
    }
    let payload = null;
    try { payload = await response.json(); } catch { /* handled as a protocol error below */ }
    if (!response.ok) {
      const code = payload?.code ?? (response.status === 503 ? 'AI_NOT_ENABLED' : 'AI_PROVIDER_ERROR');
      const message = code === 'AI_NOT_ENABLED' ? 'AI 不可用 / 未配置模型' : (payload?.errors?.[0] ?? code);
      throw new AIClientError(code, message, response.status);
    }
    if (!payload || typeof payload !== 'object') throw new AIClientError('INVALID_AI_ARTIFACT', 'AI 返回格式无效', 422);
    return { result: payload, isTestData: response.headers.get(TEST_DATA_HEADER)?.toLowerCase() === 'true' };
  }
}

/** @param {unknown} idea */
export function createIdeaSegments(idea) {
  return String(idea ?? '').split(/\r?\n/).map((content, index) => ({ id: `idea_segment_${index + 1}`, content })).filter((item) => item.content.trim());
}

/** @param {number} line @param {number} column */
export function toCursor(line, column) {
  return { line: Math.max(1, line), char: Math.max(0, column - 1) };
}

/** @param {string} source @param {{start_line: number, start_char: number, end_line: number, end_char: number}} range */
export function rangeToOffsets(source, range) {
  const lines = String(source).split(/\r?\n/);
  /** @param {number} line @param {number} char */
  const offset = (line, char) => lines.slice(0, line - 1).reduce((total, item) => total + item.length + 1, 0) + char;
  return { from: offset(range.start_line, range.start_char), to: offset(range.end_line, range.end_char) };
}
