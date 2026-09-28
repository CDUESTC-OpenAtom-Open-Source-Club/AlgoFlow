import { relationalStore } from '@kit.ArkData';
import { AIMode } from '../domain/Models';
import { AIResultRepository, IDECapability, IDERecord, IDEState } from '../domain/IDEAIModels';
import { parseIDEResult } from '../domain/IDEAIContract';
import { DEBUG } from 'BuildProfile';

export class RdbAIResultRepository implements AIResultRepository {
  private store: relationalStore.RdbStore;
  private allowTestData: boolean;
  constructor(store: relationalStore.RdbStore, allowTestData: boolean) {
    this.store = store; this.allowTestData = DEBUG && allowTestData;
  }
  async list(draftId: string, mode: AIMode): Promise<IDERecord[]> {
    const rows = await this.store.querySql('SELECT record_json FROM ai_results WHERE draft_id = ? AND mode = ? AND (is_test = 0 OR ? = 1) ORDER BY is_test ASC, updated_at', [draftId, mode, this.allowTestData ? 1 : 0]);
    const records: IDERecord[] = [];
    try {
      if (rows.goToFirstRow()) do {
        const record = decodeAIRecord(rows.getString(0));
        if (record.isTestData && !this.allowTestData) continue;
        if (record.context.draftId !== draftId || record.context.mode !== mode) throw new Error('AI 缓存来源不匹配');
        const index = records.findIndex(item => displaySlot(item) === displaySlot(record));
        if (index >= 0) {
          if (records[index].isTestData && !record.isTestData) records[index] = record;
          continue;
        }
        record.stale = true;
        if (record.state === IDEState.LOADING) { record.state = IDEState.CANCELLED; record.message = '上次请求已结束，请重新发起'; }
        records.push(record);
      } while (rows.goToNextRow());
    } finally { rows.close(); }
    return records;
  }
  async save(record: IDERecord, latest: boolean): Promise<void> {
    if (record.isTestData && !this.allowTestData) throw new Error('当前配置禁止保存测试数据');
    const json = JSON.stringify(record); decodeAIRecord(json);
    const slot = resultSlot(record);
    if (latest) {
      await this.store.executeSql('INSERT OR REPLACE INTO ai_results (draft_id, mode, slot, is_test, result_id, updated_at, record_json) SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM drafts WHERE id = ? AND deleted = 0)',
        [record.context.draftId, record.context.mode, slot, record.isTestData ? 1 : 0, record.id, record.updatedAt, json, record.context.draftId]);
    } else {
      await this.store.executeSql('UPDATE ai_results SET record_json = ? WHERE draft_id = ? AND mode = ? AND slot = ? AND is_test = ? AND result_id = ?',
        [json, record.context.draftId, record.context.mode, slot, record.isTestData ? 1 : 0, record.id]);
    }
  }
  async removeDraft(draftId: string): Promise<void> {
    await this.store.executeSql('DELETE FROM ai_results WHERE draft_id = ?', [draftId]);
  }
}
export function resultSlot(record: IDERecord): string {
  return record.capability === IDECapability.REVIEW ? `review:${record.reviewKind}` : record.capability;
}
function storageSlot(record: IDERecord): string {
  return `${resultSlot(record)}:${record.isTestData ? 'test' : 'normal'}`;
}
function displaySlot(record: IDERecord): string {
  return record.capability === IDECapability.COMPLETION ? resultSlot(record) : storageSlot(record);
}
export function decodeAIRecord(json: string): IDERecord {
  const record = JSON.parse(json) as IDERecord;
  if (record === null || typeof record.id !== 'string' || record.id.length === 0 || record.context === null ||
    typeof record.context !== 'object' || typeof record.context.draftId !== 'string' || typeof record.context.code !== 'string' ||
    typeof record.context.idea !== 'string' || typeof record.context.problemContext !== 'string' || !Array.isArray(record.context.segments) ||
    typeof record.hidden !== 'boolean' || typeof record.stale !== 'boolean' || typeof record.isTestData !== 'boolean' ||
    typeof record.body !== 'string' || typeof record.updatedAt !== 'string' || typeof record.message !== 'string' ||
    !Number.isInteger(record.generation) || !Number.isInteger(record.context.version) ||
    !['review', 'completion', 'transform'].includes(record.capability) ||
    !['explanation', 'risk', 'complexity'].includes(record.reviewKind) ||
    !['loading', 'success', 'error', 'cancelled', 'accepted', 'rejected'].includes(record.state)) throw new Error('AI 缓存损坏，请保留数据并重试');
  if (record.body.length > 0) parseIDEResult(record.body, record);
  return record;
}
