const RESULTS_KEY = 'algoflow.ai-results.v1';

export class BrowserAIResultRepository {
  load() {
    try {
      const value = JSON.parse(localStorage.getItem(RESULTS_KEY) ?? '[]');
      return Array.isArray(value) ? value.map((record) => ({ ...record, state: record.state === 'loading' ? 'stale' : record.state, stale: record.stale || record.state === 'loading' })) : [];
    } catch { return []; }
  }

  /** @param {import('./types').AIResultRecord} record */
  save(record) {
    const records = this.load().filter((item) => !sameSlot(item, record));
    records.push(record);
    localStorage.setItem(RESULTS_KEY, JSON.stringify(records));
  }

  /** @param {import('./types').AIResultRecord} record */
  setHidden(record) { this.save({ ...record, hidden: true, state: 'hidden' }); }

  /** @param {string} draftId @param {string} code @param {string} idea */
  invalidateSource(draftId, code, idea) {
    const records = this.load().map((record) => record.draftId === draftId && (record.sourceCode !== code || record.sourceIdea !== idea)
      ? { ...record, stale: true, state: record.state === 'loading' ? 'stale' : record.state }
      : record);
    localStorage.setItem(RESULTS_KEY, JSON.stringify(records));
    return records.filter((record) => record.draftId === draftId);
  }

  /** @param {import('./types').AIResultRecord} record */
  update(record) { this.save(record); }

  /** @param {string} draftId */
  listForDraft(draftId) { return this.load().filter((item) => item.draftId === draftId); }

  /** @param {string} draftId */
  removeDraft(draftId) {
    localStorage.setItem(RESULTS_KEY, JSON.stringify(this.load().filter((item) => item.draftId !== draftId)));
  }
}

/** @param {import('./types').AIResultRecord} left @param {import('./types').AIResultRecord} right */
function sameSlot(left, right) {
  return left.draftId === right.draftId && left.capability === right.capability && left.reviewKind === right.reviewKind;
}
