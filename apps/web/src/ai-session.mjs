import { AIClientError, createIdeaSegments, parseCompletionResult, parseReviewResult, rangeToOffsets } from './ai-client.mjs';

/** UI-independent application use case; no workspace/sync repository is available here. */
export class AISession {
  /** @type {import('./types').AISessionState} */
  state = { reviews: [], completion: null, completionHistory: [], segments: [], storageError: '' };
  /** @type {import('./types').AIContext | null} */
  context = null;
  generation = 0;
  /** @type {Set<string>} Records whose cache partition has been confirmed. */
  confirmedRecords = new Set();
  /** @type {{controller: AbortController, generation: number} | null} */
  active = null;
  /** @type {Set<() => void>} */
  listeners = new Set();
  /** @type {(record: import('./types').AIResultRecord) => void} */
  onPersistedResult = () => {};

  /** @param {import('./types').AIClientPort} client @param {import('./types').AIResultRepository} repository */
  constructor(client, repository) {
    this.client = client;
    this.repository = repository;
  }

  getSnapshot = () => this.state;

  /** @param {() => void} listener */
  subscribe = (listener) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** @param {import('./types').AIContext} next */
  setContext(next) {
    if (this.context && sameContext(this.context, next)) return;
    const previous = this.context;
    this.#invalidate(true);
    this.context = { ...next };
    const newSession = !previous || previous.draftId !== next.draftId || previous.mode !== next.mode;
    if (newSession) {
      /** @type {import('./types').AIResultRecord[]} */
      let records = [];
      try { records = this.repository.listForDraft(next.draftId, next.mode); }
      catch (error) { this.#storageFailure(error); }
      records = restoreRecords(records, next);
      this.confirmedRecords = new Set(records.map(record => record.id));
      const completionHistory = records.filter(record => record.capability === 'completion');
      this.state = { ...this.state, reviews: records.filter(record => record.capability === 'review'),
        completion: latestRecord(completionHistory) ?? null, completionHistory, segments: [] };
    } else {
      const restored = restoreRecords(this.#records(), next);
      this.state = { ...this.state, reviews: restored.filter(record => record.capability === 'review'),
        completion: latestRecord(restored.filter(record => record.capability === 'completion')) ?? null,
        completionHistory: restored.filter(record => record.capability === 'completion') };
    }
    if (newSession || previous?.idea !== next.idea) this.#refreshSegments();
    this.#emit();
  }

  cancel() {
    this.#invalidate(true);
    this.#emit();
  }

  dispose() {
    this.cancel();
    this.context = null;
  }

  /** @param {import('./types').ReviewKind} kind */
  requestReview(kind) { return this.#request(kind, null); }

  /** @param {import('./types').AICursor} cursor */
  requestCompletion(cursor) { return this.#request('completion', cursor); }

  /** @param {(record: import('./types').AIResultRecord) => void} handler */
  setPersistedResultHandler(handler) { this.onPersistedResult = handler; }

  /** @param {import('./types').AIResultRecord[]} records */
  importRecords(records) {
    try {
      for (const record of records) this.repository.save(record);
      if (!this.context) return;
      const loaded = this.repository.listForDraft(this.context.draftId, this.context.mode);
      const restored = restoreRecords(loaded, this.context);
      this.confirmedRecords = new Set(restored.map(record => record.id));
      this.state = { ...this.state, reviews: restored.filter(record => record.capability === 'review'),
        completion: latestRecord(restored.filter(record => record.capability === 'completion')) ?? null,
        completionHistory: restored.filter(record => record.capability === 'completion') };
      this.#emit();
    } catch (error) { this.#storageFailure(error); }
  }

  /** @param {string} id @param {boolean} hidden */
  setHidden(id, hidden) {
    const record = this.#records().find(item => item.id === id);
    if (!record) return;
    const updated = { ...record, hidden };
    this.#replace(updated);
    this.#persist(updated);
    this.#emit();
  }

  rejectCompletion() {
    const record = this.state.completion;
    if (!record?.result || record.state !== 'success' || record.stale) return;
    const updated = { ...record, state: /** @type {const} */ ('rejected'), stale: true };
    this.#replace(updated);
    this.#persist(updated);
    this.#emit();
  }

  canAcceptCompletion() {
    const record = this.state.completion;
    const context = this.context;
    return !!(record && context && record.result?.output_kind === 'completion' && record.state === 'success' &&
      !record.hidden && !record.stale && !record.restored && record.requestGeneration === this.generation &&
      record.draftId === context.draftId && record.mode === context.mode &&
      record.sourceFile === 'main.cpp' && context.fileId === 'main.cpp' && record.sourceDraftVersion === context.draftVersion &&
      record.sourceCode === context.code && record.sourceIdea === context.idea && record.sourceProblemContext === context.problemContext &&
      (context.syncStatus === undefined || context.syncStatus === 'synced'));
  }

  /** Apply synchronously through the editor's checked, undoable transaction. @param {import('./types').ApplyAIEditorChange} apply */
  acceptCompletion(apply) {
    const record = this.state.completion;
    if (!record || !this.canAcceptCompletion() || !record.sourceCursor) return false;
    try {
      const result = parseCompletionResult(record.result, {
        ...sourceRequest(record), output_kind: 'completion', cursor: record.sourceCursor,
      });
      if (!apply({ id: record.id, sourceCode: record.sourceCode, range: result.replaced_range, insert: result.suggestion_text })) {
        throw new Error('编辑器内容已变化，请重新请求补全');
      }
      // onChange may already have invalidated the old source; the accepted
      // record remains read-only and cannot be applied a second time.
      const updated = { ...record, state: /** @type {const} */ ('accepted'), stale: true };
      this.#replace(updated);
      this.#persist(updated);
      this.#emit();
      return true;
    } catch {
      const updated = { ...record, stale: true, errorMessage: '补全范围或编辑器内容已变化，请重新请求' };
      this.#replace(updated);
      this.#persist(updated);
      this.#emit();
      return false;
    }
  }

  /** @param {string} draftId */
  removeDraft(draftId) {
    try { this.repository.removeDraft(draftId); }
    catch (error) { this.#storageFailure(error); }
    if (this.context?.draftId === draftId) {
      this.#invalidate(true);
      this.context = null;
      this.state = { ...this.state, reviews: [], completion: null, completionHistory: [], segments: [] };
    }
    this.#emit();
  }

  retryStorage() {
    this.state = { ...this.state, storageError: '' };
    this.#refreshSegments();
    const records = this.#records();
    for (const record of records) {
      if (record.state === 'loading' || record.state === 'cancelled') continue;
      this.#persist(record, true);
    }
    this.#emit();
  }

  /** @param {import('./types').ReviewKind | 'completion'} kind @param {import('./types').AICursor | null} cursor */
  async #request(kind, cursor) {
    const context = this.context;
    if (!context) return;
    this.#invalidate(false);
    const active = { controller: new AbortController(), generation: this.generation };
    this.active = active;
    /** @type {import('./types').AIResultRecord} */
    const record = {
      id: crypto.randomUUID(), draftId: context.draftId, mode: context.mode,
      capability: kind === 'completion' ? 'completion' : 'review',
      ...(kind === 'completion' ? {} : { reviewKind: kind }), state: 'loading', result: null,
      isTestData: false, hidden: false, stale: false, restored: false, requestGeneration: active.generation,
      sourceDraftVersion: context.draftVersion, sourceFile: context.fileId, sourceCode: context.code,
      sourceIdea: context.idea, sourceProblemContext: context.problemContext,
      sourceSegments: this.state.segments.map(segment => ({ ...segment })), sourceCursor: cursor ? { ...cursor } : null,
      updatedAt: new Date().toISOString(),
    };
    this.state = kind === 'completion'
      ? { ...this.state, completion: record, completionHistory: [...this.state.completionHistory, record] }
      : { ...this.state, reviews: [...this.state.reviews, record] };
    this.#emit();
    let isTestData = false;
    let responseReceived = false;
    try {
      if (context.mode !== 'faithful_transform') throw new AIClientError('AI_MODE_NOT_AVAILABLE', '当前模式尚未接入，请选择忠实转换', 409);
      if (context.syncStatus !== undefined && context.syncStatus !== 'synced') {
        throw new AIClientError('AI_DRAFT_NOT_SYNCED', '草稿尚未可靠同步，请先保存并同步后再请求 AI', 409);
      }
      if (!record.sourceSegments.length || !context.code.trim() || !context.problemContext.trim()) {
        throw new AIClientError('INVALID_REQUEST', '请先填写 main.cpp 和 idea.md，再请求 AI', 400);
      }
      if (context.fileId !== 'main.cpp') throw new AIClientError('INVALID_REQUEST', '请切换到 main.cpp 再请求 AI', 400);
      const base = sourceRequest(record);
      let result;
      if (kind === 'completion') {
        if (!cursor) throw new AIClientError('INVALID_REQUEST', '请先选择代码光标位置', 400);
        rangeToOffsets(base.code, { start_line: cursor.line, start_char: cursor.char, end_line: cursor.line, end_char: cursor.char });
        const request = { ...base, output_kind: /** @type {const} */ ('completion'), cursor };
        const response = await this.client.requestCompletion(request, { signal: active.controller.signal });
        responseReceived = true;
        isTestData = response.isTestData;
        result = parseCompletionResult(response.result, request);
      } else {
        const request = { ...base, output_kind: /** @type {const} */ ('review'), review_kind: kind };
        const response = await this.client.requestReview(request, { signal: active.controller.signal });
        responseReceived = true;
        isTestData = response.isTestData;
        result = parseReviewResult(response.result, request);
      }
      if (!this.#isCurrent(active)) return;
      const updated = { ...record, state: /** @type {const} */ ('success'), result, isTestData, updatedAt: new Date().toISOString() };
      this.#replace(updated);
      this.#markHistorical(updated);
      this.confirmedRecords.add(record.id);
      this.#persist(updated, true);
      this.onPersistedResult(updated);
    } catch (error) {
      if (!this.#isCurrent(active)) return;
      const code = error instanceof AIClientError ? error.code : 'NETWORK_ERROR';
      const updated = { ...record,
        state: /** @type {import('./types').AIRequestState} */ (['AI_NOT_ENABLED', 'AI_MODE_NOT_AVAILABLE'].includes(code) ? 'unavailable' : 'error'),
        errorCode: code, errorMessage: error instanceof AIClientError ? error.message : 'AI 请求失败，请检查网络后重试',
        isTestData: isTestData || (error instanceof AIClientError && error.isTestData), updatedAt: new Date().toISOString(),
      };
      this.#replace(updated);
      if (responseReceived || (error instanceof AIClientError && error.isTestData && code !== 'AI_NOT_ENABLED')) {
        this.confirmedRecords.add(record.id);
        this.#persist(updated, true);
      }
    } finally {
      if (this.active === active) {
        this.active = null;
        this.#emit();
      }
    }
  }

  /** @param {{controller: AbortController, generation: number}} active */
  #isCurrent(active) {
    return this.active === active && active.generation === this.generation && !active.controller.signal.aborted;
  }

  /** @param {boolean} markResults */
  #invalidate(markResults) {
    this.generation += 1;
    this.active?.controller.abort();
    this.active = null;
    for (const record of this.#records()) {
      if (record.stale && record.state !== 'loading') continue;
      if (!markResults && record.state !== 'loading') continue;
      const updated = { ...record, stale: true,
        state: record.state === 'loading' ? /** @type {const} */ ('cancelled') : record.state,
        ...(record.state === 'loading' ? { errorCode: 'CANCELLED', errorMessage: '请求已取消，可重新发起' } : {}),
      };
      this.#replace(updated);
      if (this.confirmedRecords.has(record.id)) this.#persist(updated);
    }
  }

  #refreshSegments() {
    if (!this.context) return;
    try {
      const segments = this.repository.reconcileSegments(this.context.draftId, this.context.idea, this.state.segments);
      this.state = { ...this.state, segments };
    } catch (error) {
      this.state = { ...this.state, segments: createIdeaSegments(this.context.idea, this.state.segments) };
      this.#storageFailure(error);
    }
  }

  #records() { return [...this.state.reviews, ...this.state.completionHistory]; }

  /** @param {import('./types').AIResultRecord} record */
  #replace(record) {
    this.state = record.capability === 'review'
      ? { ...this.state, reviews: this.state.reviews.map(item => item.id === record.id ? record : item) }
      : { ...this.state, completion: this.state.completion?.id === record.id ? record : this.state.completion,
        completionHistory: this.state.completionHistory.map(item => item.id === record.id ? record : item) };
  }

  /** @param {import('./types').AIResultRecord} current */
  #markHistorical(current) {
    const slot = resultSlot(current);
    for (const record of this.#records()) {
      if (record.id === current.id || resultSlot(record) !== slot || record.stale) continue;
      this.#replace({ ...record, stale: true });
      if (this.confirmedRecords.has(record.id)) this.#persist({ ...record, stale: true });
    }
  }

  /** @param {import('./types').AIResultRecord} record @param {boolean} [latest] */
  #persist(record, latest = false) {
    try { if (latest) this.repository.save(record); else this.repository.update(record); }
    catch (error) { this.#storageFailure(error); }
  }

  /** @param {unknown} error */
  #storageFailure(error) {
    this.state = { ...this.state, storageError: error instanceof Error ? error.message : 'AI 本地存储不可用，当前结果仍可查看' };
  }

  #emit() { for (const listener of this.listeners) listener(); }
}

/** @param {import('./types').AIContext} left @param {import('./types').AIContext} right */
function sameContext(left, right) {
  return left.draftId === right.draftId && left.draftVersion === right.draftVersion && left.fileId === right.fileId &&
    left.mode === right.mode && left.code === right.code && left.idea === right.idea && left.problemContext === right.problemContext &&
    left.syncStatus === right.syncStatus;
}

/** @param {import('./types').AIResultRecord[]} records @param {import('./types').AIContext} context */
function restoreRecords(records, context) {
  const sourceCurrent = records.filter((record) => record.capability === 'review' && record.state === 'success' && record.result !== null && recordIsCurrent(record, context));
  const winners = new Map();
  for (const record of sourceCurrent) {
    const slot = resultSlot(record);
    const previous = winners.get(slot);
    if (!previous || compareRecords(record, previous) > 0) winners.set(slot, record);
  }
  return records.map((record) => ({ ...record,
    // A restored completion is always read-only until a new request is made.
    stale: record.capability === 'completion' ? !recordIsCurrent(record, context) : winners.get(resultSlot(record))?.id !== record.id || !recordIsCurrent(record, context),
    restored: true,
  }));
}

/** @param {import('./types').AIResultRecord[]} records */
function latestRecord(records) {
  const successful = records.filter((record) => record.state === 'success' && record.result !== null);
  return [...(successful.length > 0 ? successful : records)].sort((left, right) =>
    Number(left.isTestData) - Number(right.isTestData) || compareRecords(right, left))[0] ?? null;
}

/** @param {import('./types').AIResultRecord} record @param {import('./types').AIContext} context */
function recordIsCurrent(record, context) {
  return record.draftId === context.draftId && record.mode === context.mode && record.sourceFile === context.fileId &&
    record.sourceDraftVersion === context.draftVersion && record.sourceCode === context.code &&
    record.sourceIdea === context.idea && record.sourceProblemContext === context.problemContext &&
    (context.syncStatus === undefined || context.syncStatus === 'synced');
}

/** @param {import('./types').AIResultRecord} record */
function resultSlot(record) {
  return `${record.draftId}/${record.mode}/${record.capability}/${record.reviewKind ?? ''}/${record.isTestData ? 'test' : 'normal'}`;
}

/** @param {import('./types').AIResultRecord} left @param {import('./types').AIResultRecord} right */
function compareRecords(left, right) {
  return left.sourceDraftVersion - right.sourceDraftVersion || left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id);
}

/** @param {import('./types').AIResultRecord} record @returns {import('./types').AISourceRequest} */
function sourceRequest(record) {
  return { mode: record.mode, draft_id: record.draftId, draft_version: record.sourceDraftVersion,
    language: 'cpp', rule_version: '1.0.0', problem_context: record.sourceProblemContext,
    idea_segments: record.sourceSegments, code: record.sourceCode, visibility: 'visible' };
}
