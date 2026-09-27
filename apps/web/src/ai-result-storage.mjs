import { ALLOW_TEST_AI, canUseTestData, createIdeaSegments, parseCompletionResult, parseReviewResult } from './ai-client.mjs';

const LEGACY_KEY = 'algoflow.ai-results.v1';
const NORMAL_KEY = 'algoflow.ai-results.v2.normal';
const TEST_KEY = 'algoflow.ai-results.v2.test';
const SEGMENTS_KEY = 'algoflow.ai-idea-segments.v1';

export class BrowserAIResultRepository {
  /** @param {{storage?: Pick<Storage, 'getItem' | 'setItem'>, allowTestData?: boolean}} [options] */
  constructor({ storage, allowTestData = ALLOW_TEST_AI } = {}) {
    this.storage = storage;
    this.allowTestData = canUseTestData(allowTestData);
  }

  /** @returns {import('./types').AIResultRecord[]} */
  load() {
    const records = this.#partition(false);
    if (this.allowTestData) records.push(...this.#partition(true));
    return records;
  }

  /** @param {import('./types').AIResultRecord} record */
  save(record) {
    if (record.isTestData && !this.allowTestData) throw new Error('当前配置禁止保存测试数据');
    const records = this.#partition(record.isTestData).filter(item => !sameSlot(item, record));
    records.push(decodeRecord(record));
    this.#write(record.isTestData ? TEST_KEY : NORMAL_KEY, records);
  }

  /** @param {import('./types').AIResultRecord} record */
  update(record) {
    if (record.isTestData && !this.allowTestData) throw new Error('当前配置禁止保存测试数据');
    const records = this.#partition(record.isTestData);
    // Hiding an older chat message must never resurrect it as the latest result.
    if (!records.some(item => item.id === record.id && sameSlot(item, record))) return;
    this.#write(record.isTestData ? TEST_KEY : NORMAL_KEY,
      records.map(item => item.id === record.id && sameSlot(item, record) ? decodeRecord(record) : item));
  }

  /** @param {string} draftId @param {import('./types').Mode} [mode] */
  listForDraft(draftId, mode = 'faithful_transform') {
    const records = this.load().filter(item => item.draftId === draftId && item.mode === mode)
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
    return records.filter((record, index) => !records.slice(index + 1).some(item => sameSlot(item, record)));
  }

  /** @param {string} draftId @param {string} idea @param {import('./types').IdeaSegment[]} [fallback] */
  reconcileSegments(draftId, idea, fallback = []) {
    const rows = this.#read(SEGMENTS_KEY) ?? [];
    const typed = rows.map(value => {
      const row = asObject(value);
      if (typeof row.draftId !== 'string' || !validSegments(row.segments)) throw cacheError();
      return { draftId: row.draftId, segments: row.segments };
    });
    const previous = fallback.length ? fallback : typed.find(row => row.draftId === draftId)?.segments ?? [];
    const segments = createIdeaSegments(idea, previous);
    if (JSON.stringify(typed.find(row => row.draftId === draftId)?.segments) !== JSON.stringify(segments)) {
      this.#write(SEGMENTS_KEY, [...typed.filter(row => row.draftId !== draftId), { draftId, segments }]);
    }
    return segments;
  }

  /** @param {string} draftId */
  removeDraft(draftId) {
    for (const isTestData of this.allowTestData ? [false, true] : [false]) {
      this.#write(isTestData ? TEST_KEY : NORMAL_KEY, this.#partition(isTestData).filter(item => item.draftId !== draftId));
    }
    const rows = this.#read(SEGMENTS_KEY);
    if (rows) this.#write(SEGMENTS_KEY, rows.filter(row => asObject(row).draftId !== draftId));
  }

  /** @param {boolean} isTestData */
  #partition(isTestData) {
    const rows = this.#read(isTestData ? TEST_KEY : NORMAL_KEY);
    if (rows) return rows.map(value => decodeRecord(value)).filter(record => record.isTestData === isTestData);
    // Non-destructive migration: v1 remains available for recovery. Unverifiable
    // legacy proposals are read-only. Normal mode never reads legacy test data.
    return (this.#read(LEGACY_KEY) ?? []).filter(value => asObject(value).isTestData === isTestData)
      .map(value => decodeRecord(value, true));
  }

  /** @param {string} key @returns {unknown[] | null} */
  #read(key) {
    try {
      const raw = (this.storage ?? globalThis.localStorage).getItem(key);
      if (raw === null) return null;
      const value = JSON.parse(raw);
      if (!Array.isArray(value)) throw cacheError();
      return value;
    } catch { throw cacheError(); }
  }

  /** @param {string} key @param {unknown[]} value */
  #write(key, value) {
    try { (this.storage ?? globalThis.localStorage).setItem(key, JSON.stringify(value)); }
    catch { throw new Error('AI 结果未能写入本地存储，请检查浏览器存储权限或剩余空间；当前工作区未清空'); }
  }
}

/** @param {import('./types').AIResultRecord} left @param {import('./types').AIResultRecord} right */
function sameSlot(left, right) {
  return left.draftId === right.draftId && left.mode === right.mode && left.capability === right.capability && left.reviewKind === right.reviewKind;
}

/** @param {unknown} value @param {boolean} [legacy] @returns {import('./types').AIResultRecord} */
function decodeRecord(value, legacy = false) {
  const record = asObject(value);
  for (const key of ['id', 'draftId', 'sourceCode', 'sourceIdea', 'updatedAt']) if (typeof record[key] !== 'string') throw cacheError();
  for (const key of ['requestGeneration', 'sourceDraftVersion']) if (!Number.isInteger(record[key]) || Number(record[key]) < 0) throw cacheError();
  for (const key of ['isTestData', 'hidden', 'stale']) if (typeof record[key] !== 'boolean') throw cacheError();
  if (!['main.cpp', 'idea.md', 'cases.txt'].includes(String(record.sourceFile))) throw cacheError();
  const review = record.capability === 'review';
  if ((!review && record.capability !== 'completion') || (review && !['explanation', 'risk', 'complexity'].includes(String(record.reviewKind)))) throw cacheError();
  const result = record.result === null ? null : review ? parseReviewResult(record.result) : parseCompletionResult(record.result);
  const mode = record.mode ?? (legacy ? result?.mode ?? 'faithful_transform' : null);
  if (!['faithful_transform', 'feasibility_analysis', 'progressive_hint', 'full_solution'].includes(String(mode))) throw cacheError();
  const state = legacy && ['hidden', 'stale'].includes(String(record.state)) ? (result ? 'success' : 'cancelled') : record.state;
  if (!['loading', 'success', 'unavailable', 'error', 'cancelled', 'accepted', 'rejected'].includes(String(state))) throw cacheError();
  const segments = legacy ? [] : record.sourceSegments;
  if (!validSegments(segments)) throw cacheError();
  const cursor = legacy ? null : record.sourceCursor;
  if (cursor !== null) {
    const position = asObject(cursor);
    if (!Number.isInteger(position.line) || Number(position.line) < 1 || !Number.isInteger(position.char) || Number(position.char) < 0) throw cacheError();
  }
  if (!legacy && typeof record.sourceProblemContext !== 'string') throw cacheError();
  for (const key of ['errorCode', 'errorMessage']) if (record[key] !== undefined && typeof record[key] !== 'string') throw cacheError();
  if (result && (result.draft_id !== record.draftId || result.mode !== mode || result.source_draft_version !== record.sourceDraftVersion ||
      (result.output_kind === 'review' && result.review_kind !== record.reviewKind))) throw cacheError();
  return /** @type {import('./types').AIResultRecord} */ (/** @type {unknown} */ ({
    ...record, mode, result, state: state === 'loading' ? 'cancelled' : state,
    stale: legacy || record.stale || state === 'loading', sourceSegments: segments, sourceCursor: cursor,
    sourceProblemContext: legacy ? '' : record.sourceProblemContext,
  }));
}

/** @param {unknown} value @returns {value is import('./types').IdeaSegment[]} */
function validSegments(value) {
  if (!Array.isArray(value)) return false;
  const ids = new Set();
  return value.every(item => {
    if (!item || typeof item.id !== 'string' || !item.id || typeof item.content !== 'string' || ids.has(item.id)) return false;
    ids.add(item.id);
    return true;
  });
}

/** @param {unknown} value @returns {Record<string, unknown>} */
function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw cacheError();
  return /** @type {Record<string, unknown>} */ (value);
}

function cacheError() { return new Error('AI 本地缓存不可读取，请检查存储权限或备份损坏的 AI 缓存后重试；未清空工作区'); }
