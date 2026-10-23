import { rewriteFingerprint } from './rewrite-compare.mjs';

// Local-only rewrite partitions, one per draft. They never enter Draft,
// DraftPayload or the sync queue; another device keeps its own partition.
const KEY = 'algoflow.rewrite-mappings.v1';

export class BrowserRewriteMappingRepository {
  /** @param {{storage?: Pick<Storage, 'getItem' | 'setItem'>}} [options] */
  constructor({ storage } = {}) {
    this.storage = storage;
  }

  /** @param {string} draftId @returns {import('./types').RewriteMappingRecord | null} */
  load(draftId) {
    return this.#read().find(record => record.draft_id === draftId) ?? null;
  }

  /**
   * Stores the partition for the current rewrite text, replacing any earlier
   * partition of the same draft (including one made for an older artifact).
   * @param {string} draftId @param {string} artifactId @param {string} rewrite
   * @param {import('./types').RewriteLineMapping[]} mappings
   * @returns {import('./types').RewriteMappingRecord}
   */
  save(draftId, artifactId, rewrite, mappings) {
    /** @type {import('./types').RewriteMappingRecord} */
    const record = {
      draft_id: draftId, artifact_id: artifactId, rewrite_fingerprint: rewriteFingerprint(rewrite),
      mappings: mappings.map(mapping => ({ ...mapping })), updated_at: new Date().toISOString(),
    };
    this.#write([...this.#read().filter(item => item.draft_id !== draftId), record]);
    return record;
  }

  /** @param {string} draftId */
  removeDraft(draftId) {
    const records = this.#read();
    if (records.some(record => record.draft_id === draftId)) this.#write(records.filter(record => record.draft_id !== draftId));
  }

  /** @returns {import('./types').RewriteMappingRecord[]} */
  #read() {
    let value;
    try { value = JSON.parse(this.#storage().getItem(KEY) ?? '[]'); } catch { return []; }
    // A damaged entry is dropped instead of blocking the editor; the user can
    // partition again and the rewrite text itself is untouched.
    return Array.isArray(value) ? value.filter(validRecord) : [];
  }

  /** @param {import('./types').RewriteMappingRecord[]} records */
  #write(records) {
    this.#storage().setItem(KEY, JSON.stringify(records));
  }

  #storage() {
    return this.storage ?? globalThis.localStorage;
  }
}

/** @param {unknown} value @returns {value is import('./types').RewriteMappingRecord} */
function validRecord(value) {
  if (!value || typeof value !== 'object') return false;
  const record = /** @type {Record<string, unknown>} */ (value);
  return typeof record.draft_id === 'string' && record.draft_id.length > 0 &&
    typeof record.artifact_id === 'string' && record.artifact_id.length > 0 &&
    typeof record.rewrite_fingerprint === 'string' && typeof record.updated_at === 'string' &&
    Array.isArray(record.mappings) && record.mappings.every(validMapping);
}

/** @param {unknown} value */
function validMapping(value) {
  if (!value || typeof value !== 'object') return false;
  const mapping = /** @type {Record<string, unknown>} */ (value);
  return typeof mapping.step_id === 'string' && mapping.step_id.length > 0 &&
    Number.isInteger(mapping.start_line) && Number(mapping.start_line) >= 1 &&
    Number.isInteger(mapping.end_line) && Number(mapping.end_line) >= Number(mapping.start_line);
}
