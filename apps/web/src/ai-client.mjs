import domainSchema from '../../../packages/contracts/schemas/domain.schema.json' with { type: 'json' };
import aiSchema from '../../../packages/contracts/schemas/ai.schema.json' with { type: 'json' };
import { validateCompletionFragment } from '../../../packages/contracts/cpp-fragment.mjs';

const TEST_DATA_HEADER = 'X-AlgoFlow-Test-Data';
export const ALLOW_TEST_AI = import.meta.env?.DEV === true && import.meta.env?.VITE_AI_ALLOW_TEST_DATA === 'true';

/** @type {Record<number, [string, string]>} */
const HTTP_ERRORS = {
  400: ['INVALID_REQUEST', '请求参数无效，请检查思路和代码内容'],
  409: ['AI_MODE_NOT_AVAILABLE', '当前模式尚未接入，请选择忠实转换'],
  422: ['INVALID_AI_ARTIFACT', 'AI 产物不符合契约，已拒绝使用'],
  502: ['AI_PROVIDER_ERROR', 'AI 服务异常或超时，请稍后重试'],
  503: ['AI_NOT_ENABLED', 'AI 不可用 / 未配置模型'],
};

export class AIClientError extends Error {
  /** @param {string} code @param {string} message @param {number} status @param {boolean} [isTestData] */
  constructor(code, message, status, isTestData = false) {
    super(message);
    this.name = 'AIClientError';
    this.code = code;
    this.status = status;
    this.isTestData = isTestData;
  }
}

export class WebAIClient {
  /** @param {string} [baseUrl] @param {{fetchImpl?: typeof fetch, allowTestData?: boolean}} [options] */
  constructor(baseUrl = import.meta.env?.VITE_AI_GATEWAY_BASE || '/ai-api', { fetchImpl = globalThis.fetch, allowTestData = ALLOW_TEST_AI } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
    this.allowTestData = allowTestData;
  }

  /** @param {import('./types').AIReviewRequest} request @param {{signal?: AbortSignal}} [options] */
  async requestReview(request, options = {}) {
    const response = await this.#request('/reviews', request, options);
    try { return { result: parseReviewResult(response.result, request), isTestData: response.isTestData }; }
    catch (error) { if (error instanceof AIClientError) error.isTestData = response.isTestData; throw error; }
  }

  /** @param {import('./types').AICompletionRequest} request @param {{signal?: AbortSignal}} [options] */
  async requestCompletion(request, options = {}) {
    const response = await this.#request('/completions', request, options);
    try { return { result: parseCompletionResult(response.result, request), isTestData: response.isTestData }; }
    catch (error) { if (error instanceof AIClientError) error.isTestData = response.isTestData; throw error; }
  }

  /** @param {Record<string, unknown>} request @param {{signal?: AbortSignal}} [options] */
  requestTransform(request, options = {}) {
    return this.#request('/requests', request, options);
  }

  /** @param {string} path @param {object} body @param {{signal?: AbortSignal}} [options] */
  async #request(path, body, { signal } = {}) {
    let response;
    try {
      response = await this.fetchImpl.call(globalThis, `${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
        cache: 'no-store',
      });
    } catch (/** @type {unknown} */ error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
      throw new AIClientError('NETWORK_ERROR', '无法连接 AI 服务，请检查服务地址和网络', 0);
    }
    const isTestData = response.headers.get(TEST_DATA_HEADER)?.trim().toLowerCase() === 'true';
    if (isTestData && !this.allowTestData) {
      throw new AIClientError('AI_NOT_ENABLED', 'AI 不可用：当前配置不允许测试数据，请检查服务配置', 503);
    }
    if (!response.ok) {
      const [code, message] = HTTP_ERRORS[response.status] ?? ['AI_HTTP_ERROR', `AI 服务请求失败（HTTP ${response.status}）`];
      throw new AIClientError(code, message, response.status, isTestData);
    }
    /** @type {unknown} */
    let payload = null;
    try { payload = await response.json(); } catch (error) {
      if (signal?.aborted) throw error;
      throw invalidArtifact();
    }
    return { result: objectValue(payload), isTestData };
  }
}

/**
 * Preserve unchanged lines first, including moves and duplicate occurrences.
 * Only an unambiguous same-position edit reuses an unmatched identity.
 * @param {string} idea
 * @param {import('./types').IdeaSegment[]} [previous]
 * @param {() => string} [createId]
 * @returns {import('./types').IdeaSegment[]}
 */
export function createIdeaSegments(idea, previous = [], createId = () => `idea-${crypto.randomUUID()}`) {
  const contents = idea.split(/\r\n|\n|\r/).filter(content => content.trim());
  const used = new Set();
  const matches = contents.map(content => {
    const match = previous.find(segment => !used.has(segment.id) && segment.content.trim() === content.trim());
    if (match) used.add(match.id);
    return match;
  });
  return contents.map((content, index) => {
    let match = matches[index];
    const atPosition = previous[index];
    if (!match && previous.length === contents.length && atPosition && !used.has(atPosition.id)) {
      match = atPosition;
      used.add(match.id);
    }
    return { id: match?.id ?? createId(), content };
  });
}

/** @param {number} line @param {number} column */
export function toCursor(line, column) {
  if (!Number.isInteger(line) || !Number.isInteger(column) || line < 1 || column < 1) throw invalidArtifact();
  return { line, char: column - 1 };
}

/** @param {string} source @param {{start_line: number, start_char: number, end_line: number, end_char: number}} range */
export function rangeToOffsets(source, range) {
  checkRange(range);
  const lines = source.split(/\r?\n/);
  const starts = [0];
  for (const match of source.matchAll(/\r?\n/g)) starts.push(match.index + match[0].length);
  /** @param {number} line @param {number} char */
  const offset = (line, char) => {
    const text = lines[line - 1];
    const start = starts[line - 1];
    if (text === undefined || start === undefined || char > text.length) throw invalidArtifact();
    return start + char;
  };
  return { from: offset(range.start_line, range.start_char), to: offset(range.end_line, range.end_char) };
}

/** @param {unknown} value @param {import('./types').AIReviewRequest} [request] @returns {import('./types').AIReviewResult} */
export function parseReviewResult(value, request) {
  const result = objectValue(value);
  exactKeys(result, aiSchema.$defs.reviewResult.required);
  checkMetadata(result, request);
  if (result.output_kind !== 'review' || !domainSchema.$defs.reviewKind.enum.includes(String(result.review_kind)) || !Array.isArray(result.diagnostics)) throw invalidArtifact();
  const ids = new Set();
  for (const item of result.diagnostics) {
    const diagnostic = objectValue(item);
    exactKeys(diagnostic, aiSchema.$defs.reviewResult.properties.diagnostics.items.required);
    for (const key of ['id', 'problem', 'basis', 'suggestion']) nonempty(diagnostic[key]);
    if (ids.has(diagnostic.id) || !domainSchema.$defs.diagnosticLevel.enum.includes(String(diagnostic.level))) throw invalidArtifact();
    ids.add(diagnostic.id);
    if (diagnostic.range !== null) {
      const range = checkRange(diagnostic.range);
      if (request) rangeToOffsets(request.code, range);
    }
  }
  if (request && result.review_kind !== request.review_kind) throw invalidArtifact();
  return /** @type {import('./types').AIReviewResult} */ (/** @type {unknown} */ (result));
}

/** @param {unknown} value @param {import('./types').AICompletionRequest} [request] @returns {import('./types').AICompletionResult} */
export function parseCompletionResult(value, request) {
  const result = objectValue(value);
  exactKeys(result, aiSchema.$defs.completionResult.required);
  checkMetadata(result, request);
  const range = checkRange(result.replaced_range);
  nonempty(result.suggestion_text);
  if (result.output_kind !== 'completion' || typeof result.suggestion_text !== 'string' ||
      result.suggestion_text.length > aiSchema.$defs.completionResult.properties.suggestion_text.maxLength ||
      validateCompletionFragment(result.suggestion_text).length || !Array.isArray(result.source_refs) || !result.source_refs.length) throw invalidArtifact();
  for (const ref of result.source_refs) nonempty(ref);
  if (request) {
    const { from, to } = rangeToOffsets(request.code, range);
    const { line, char } = request.cursor;
    const cursor = rangeToOffsets(request.code, { start_line: line, end_line: line, start_char: char, end_char: char }).from;
    const ids = new Set(request.idea_segments.map(segment => segment.id));
    if (from > cursor || to < cursor || range.start_line < line - 3 || range.end_line > line + 3 ||
        (from === 0 && to === request.code.length) || result.source_refs.some(ref => !ids.has(ref))) throw invalidArtifact();
  }
  return /** @type {import('./types').AICompletionResult} */ (/** @type {unknown} */ (result));
}

/** @param {Record<string, unknown>} result @param {import('./types').AIReviewRequest | import('./types').AICompletionRequest} [request] */
function checkMetadata(result, request) {
  for (const key of ['draft_id', 'model_id', 'rule_version']) nonempty(result[key]);
  if (!domainSchema.$defs.aiMode.enum.includes(String(result.mode)) || !domainSchema.$defs.aiVisibility.enum.includes(String(result.visibility)) ||
      !Number.isInteger(result.source_draft_version) || Number(result.source_draft_version) < 0) throw invalidArtifact();
  if (request && (result.mode !== request.mode || result.draft_id !== request.draft_id || result.source_draft_version !== request.draft_version ||
      result.rule_version !== request.rule_version || result.visibility !== request.visibility || result.output_kind !== request.output_kind)) throw invalidArtifact();
}

/** @param {unknown} value @returns {import('./types').AIRange} */
function checkRange(value) {
  const range = objectValue(value);
  exactKeys(range, aiSchema.$defs.sourceRange.required);
  for (const key of ['start_line', 'end_line', 'start_char', 'end_char']) {
    if (!Number.isInteger(range[key]) || Number(range[key]) < (key.endsWith('line') ? 1 : 0)) throw invalidArtifact();
  }
  const typed = /** @type {import('./types').AIRange} */ (/** @type {unknown} */ (range));
  if (typed.end_line < typed.start_line || (typed.end_line === typed.start_line && typed.end_char < typed.start_char)) throw invalidArtifact();
  return typed;
}

/** @param {unknown} value @returns {Record<string, unknown>} */
function objectValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidArtifact();
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {Record<string, unknown>} value @param {string[]} keys */
function exactKeys(value, keys) {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw invalidArtifact();
}

/** @param {unknown} value */
function nonempty(value) {
  if (typeof value !== 'string' || value.length === 0) throw invalidArtifact();
}

function invalidArtifact() { return new AIClientError('INVALID_AI_ARTIFACT', 'AI 产物格式、来源或范围无效，已拒绝使用', 422); }
