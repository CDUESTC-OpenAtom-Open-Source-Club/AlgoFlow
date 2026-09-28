import { AIClientError, createIdeaSegments, parseCompletionResult, parseReviewResult, rangeToOffsets } from './ai-client.mjs';

/** UI-independent application use case; no workspace/sync repository is available here. */
export class AISession {
  /** @type {import('./types').AISessionState} */
  state = { reviews: [], completion: null, segments: [], storageError: '' };
  /** @type {import('./types').AIContext | null} */
  context = null;
  generation = 0;
  /** @type {Set<string>} Records whose cache partition has been confirmed. */
  confirmedRecords = new Set();
  /** @type {{controller: AbortController, generation: number} | null} */
  active = null;
  /** @type {Set<() => void>} */
  listeners = new Set();

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
    this.#invalidate();
    this.context = { ...next };
    const newSession = !previous || previous.draftId !== next.draftId || previous.mode !== next.mode;
    if (newSession) {
      /** @type {import('./types').AIResultRecord[]} */
      let records = [];
      try { records = this.repository.listForDraft(next.draftId, next.mode); }
      catch (error) { this.#storageFailure(error); }
      // A recovered request belongs to an earlier session/generation. Keep its
      // result and hidden state, but never silently re-arm an old code edit.
      records = records.map(record => ({ ...record, stale: true }));
      this.confirmedRecords = new Set(records.map(record => record.id));
      this.state = { ...this.state, reviews: records.filter(record => record.capability === 'review'),
        completion: records.find(record => record.capability === 'completion') ?? null, segments: [] };
    }
    if (newSession || previous?.idea !== next.idea) this.#refreshSegments();
    this.#emit();
  }

  cancel() {
    this.#invalidate();
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
    if (!record?.result || record.state !== 'success') return;
    const updated = { ...record, state: /** @type {const} */ ('rejected') };
    this.#replace(updated);
    this.#persist(updated);
    this.#emit();
  }

  canAcceptCompletion() {
    const record = this.state.completion;
    const context = this.context;
    return !!(record && context && record.result?.output_kind === 'completion' && record.state === 'success' &&
      !record.hidden && !record.stale && record.requestGeneration === this.generation &&
      record.draftId === context.draftId && record.mode === context.mode &&
      record.sourceFile === 'main.cpp' && context.fileId === 'main.cpp' && record.sourceDraftVersion === context.draftVersion &&
      record.sourceCode === context.code && record.sourceIdea === context.idea && record.sourceProblemContext === context.problemContext);
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
      this.#invalidate();
      this.context = null;
      this.state = { ...this.state, reviews: [], completion: null, segments: [] };
    }
    this.#emit();
  }

  retryStorage() {
    this.state = { ...this.state, storageError: '' };
    this.#refreshSegments();
    const records = this.#records();
    for (const [index, record] of records.entries()) {
      if (record.state === 'loading' || record.state === 'cancelled') continue;
      if (records.slice(index + 1).some(item => item.capability === record.capability && item.reviewKind === record.reviewKind)) continue;
      this.#persist(record, true);
    }
    this.#emit();
  }

  /** @param {import('./types').ReviewKind | 'completion'} kind @param {import('./types').AICursor | null} cursor */
  async #request(kind, cursor) {
    const context = this.context;
    if (!context) return;
    this.#invalidate();
    const active = { controller: new AbortController(), generation: this.generation };
    this.active = active;
    /** @type {import('./types').AIResultRecord} */
    const record = {
      id: crypto.randomUUID(), draftId: context.draftId, mode: context.mode,
      capability: kind === 'completion' ? 'completion' : 'review',
      ...(kind === 'completion' ? {} : { reviewKind: kind }), state: 'loading', result: null,
      isTestData: false, hidden: false, stale: false, requestGeneration: active.generation,
      sourceDraftVersion: context.draftVersion, sourceFile: context.fileId, sourceCode: context.code,
      sourceIdea: context.idea, sourceProblemContext: context.problemContext,
      sourceSegments: this.state.segments.map(segment => ({ ...segment })), sourceCursor: cursor ? { ...cursor } : null,
      updatedAt: new Date().toISOString(),
    };
    this.state = kind === 'completion' ? { ...this.state, completion: record } : { ...this.state, reviews: [...this.state.reviews, record] };
    this.#emit();
    let isTestData = false;
    let responseReceived = false;
    try {
      if (context.mode !== 'faithful_transform') throw new AIClientError('AI_MODE_NOT_AVAILABLE', '当前模式尚未接入，请选择忠实转换', 409);
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
      this.confirmedRecords.add(record.id);
      this.#persist(updated, true);
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

  #invalidate() {
    this.generation += 1;
    this.active?.controller.abort();
    this.active = null;
    for (const record of this.#records()) {
      if (record.stale && record.state !== 'loading') continue;
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

  #records() { return [...this.state.reviews, ...(this.state.completion ? [this.state.completion] : [])]; }

  /** @param {import('./types').AIResultRecord} record */
  #replace(record) {
    this.state = record.capability === 'review'
      ? { ...this.state, reviews: this.state.reviews.map(item => item.id === record.id ? record : item) }
      : { ...this.state, completion: this.state.completion?.id === record.id ? record : this.state.completion };
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
    left.mode === right.mode && left.code === right.code && left.idea === right.idea && left.problemContext === right.problemContext;
}

/** @param {import('./types').AIResultRecord} record @returns {import('./types').AISourceRequest} */
function sourceRequest(record) {
  return { mode: record.mode, draft_id: record.draftId, draft_version: record.sourceDraftVersion,
    language: 'cpp', rule_version: '1.0.0', problem_context: record.sourceProblemContext,
    idea_segments: record.sourceSegments, code: record.sourceCode, visibility: 'visible' };
}
