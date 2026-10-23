import { common } from '@kit.AbilityKit';
import preferences from '@ohos.data.preferences';
import { decodeRewriteMappingRecord, RewriteMappingRecord, RewriteMappingRepository } from '../domain/RewriteCompare';

// Device-local rewrite partitions, one per draft. Kept out of the RDB draft
// tables and the sync queue on purpose: another device keeps its own partition.
const STORE_NAME = 'algoflow_rewrite_mappings';
const KEY_PREFIX = 'draft:';

export class PreferencesRewriteMappingStore implements RewriteMappingRepository {
  private context: common.Context;

  constructor(context: common.Context) {
    this.context = context;
  }

  async load(draftId: string): Promise<RewriteMappingRecord | null> {
    const store = await preferences.getPreferences(this.context, STORE_NAME);
    const json = await store.get(`${KEY_PREFIX}${draftId}`, '') as string;
    if (json.length === 0) return null;
    const record = decodeRewriteMappingRecord(json);
    return record !== null && record.draft_id === draftId ? record : null;
  }

  async save(record: RewriteMappingRecord): Promise<void> {
    const store = await preferences.getPreferences(this.context, STORE_NAME);
    await store.put(`${KEY_PREFIX}${record.draft_id}`, JSON.stringify(record));
    await store.flush();
  }

  async removeDraft(draftId: string): Promise<void> {
    const store = await preferences.getPreferences(this.context, STORE_NAME);
    await store.delete(`${KEY_PREFIX}${draftId}`);
    await store.flush();
  }
}
