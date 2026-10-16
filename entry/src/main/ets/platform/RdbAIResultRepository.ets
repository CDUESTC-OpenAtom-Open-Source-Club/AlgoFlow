import { relationalStore } from '@kit.ArkData';
import { AIMode } from '../domain/Models';
import { AIResultRepository, IDECapability, IDERecord, IDEState } from '../domain/IDEAIModels';
import { parseIDEResult } from '../domain/IDEAIContract';
import { DEBUG } from 'BuildProfile';

export class RdbAIResultRepository implements AIResultRepository {
  private store: relationalStore.RdbStore;
  private allowTestData: boolean;
  private onLatest?: (record: IDERecord) => void;
  constructor(store: relationalStore.RdbStore, allowTestData: boolean, onLatest?: (record: IDERecord) => void) {
    this.store = store; this.allowTestData = DEBUG && allowTestData; this.onLatest = onLatest;
  }
  async list(draftId: string, mode: AIMode): Promise<IDERecord[]> {
    const records: IDERecord[] = [];
    await this.readRows('SELECT record_json FROM ai_results WHERE draft_id = ? AND mode = ? AND (is_test = 0 OR ? = 1) ORDER BY is_test ASC, updated_at',
      [draftId, mode, this.allowTestData ? 1 : 0], records);
    await this.readRows('SELECT record_json FROM ai_result_history WHERE draft_id = ? AND mode = ? AND (is_test = 0 OR ? = 1) ORDER BY is_test ASC, updated_at',
      [draftId, mode, this.allowTestData ? 1 : 0], records);
    const unique = new Map<string, IDERecord>();
    records.forEach((record: IDERecord) => {
      if (record.isTestData && !this.allowTestData) return;
      if (record.context.draftId !== draftId || record.context.mode !== mode) throw new Error('AI 缓存来源不匹配');
      const existing = unique.get(record.id);
      if (existing === undefined || (!record.isTestData && existing.isTestData)) unique.set(record.id, record);
    });
    return Array.from(unique.values()).sort(compareRecords).map((record: IDERecord) => {
      record.stale = true;
      if (record.state === IDEState.LOADING) { record.state = IDEState.CANCELLED; record.message = '上次请求已结束，请重新发起'; }
      return record;
    });
  }
  async save(record: IDERecord, latest: boolean): Promise<void> {
    if (record.isTestData && !this.allowTestData) throw new Error('当前配置禁止保存测试数据');
    const normalized = normalizeRecordForStorage(record);
    const json = JSON.stringify(normalized); decodeAIRecord(json);
    const slot = resultSlot(record);
    const transactional = typeof this.store.beginTransaction === 'function';
    let draftExists = true;
    if (transactional) this.store.beginTransaction();
    try {
      if (latest) {
        if (typeof this.store.querySql === 'function') {
          const existingDraft = await this.store.querySql('SELECT id FROM drafts WHERE id = ? AND deleted = 0', [record.context.draftId]);
          try { draftExists = existingDraft.goToFirstRow(); } finally { existingDraft.close(); }
        }
        if (draftExists) {
          await this.store.executeSql('INSERT OR IGNORE INTO ai_result_history (draft_id, mode, slot, is_test, result_id, updated_at, record_json) ' +
            'SELECT draft_id, mode, slot, is_test, result_id, updated_at, record_json FROM ai_results WHERE draft_id = ? AND mode = ? AND slot = ? AND is_test = ?',
            [record.context.draftId, record.context.mode, slot, record.isTestData ? 1 : 0]);
          await this.store.executeSql('INSERT OR REPLACE INTO ai_results (draft_id, mode, slot, is_test, result_id, updated_at, record_json) SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM drafts WHERE id = ? AND deleted = 0)',
            [record.context.draftId, record.context.mode, slot, record.isTestData ? 1 : 0, record.id, record.updatedAt, json, record.context.draftId]);
        }
      } else {
        await this.store.executeSql('UPDATE ai_results SET record_json = ? WHERE draft_id = ? AND mode = ? AND slot = ? AND is_test = ? AND result_id = ?',
          [json, record.context.draftId, record.context.mode, slot, record.isTestData ? 1 : 0, record.id]);
        await this.store.executeSql('UPDATE ai_result_history SET record_json = ?, updated_at = ? WHERE result_id = ?',
          [json, record.updatedAt, record.id]);
      }
      if (transactional) this.store.commit();
    } catch (error) {
      if (transactional) this.store.rollBack();
      throw new Error(error instanceof Error ? error.message : 'AI 结果写入失败');
    }
    if (!draftExists) return;
    if (latest && !record.restored && record.state === IDEState.SUCCESS && (record.capability === IDECapability.REVIEW || record.capability === IDECapability.TRANSFORM)) {
      this.onLatest?.(record);
    }
  }
  async removeDraft(draftId: string): Promise<void> {
    const transactional = typeof this.store.beginTransaction === 'function';
    if (transactional) this.store.beginTransaction();
    try {
      await this.store.executeSql('DELETE FROM ai_results WHERE draft_id = ?', [draftId]);
      await this.store.executeSql('DELETE FROM ai_result_history WHERE draft_id = ?', [draftId]);
      if (transactional) this.store.commit();
    } catch (error) {
      if (transactional) this.store.rollBack();
      throw new Error(error instanceof Error ? error.message : 'AI 结果清理失败');
    }
  }
  private async readRows(sql: string, args: Array<string | number>, records: IDERecord[]): Promise<void> {
    const rows = await this.store.querySql(sql, args);
    try {
      if (rows.goToFirstRow()) do { records.push(decodeAIRecord(rows.getString(0))); } while (rows.goToNextRow());
    } finally { rows.close(); }
  }
}
function normalizeRecordForStorage(source: IDERecord): IDERecord {
  const record = JSON.parse(JSON.stringify(source)) as IDERecord;
  if (record.serverVersion === undefined) record.serverVersion = 0;
  if (record.serverSequence === undefined) record.serverSequence = 0;
  if (record.createdAt === undefined || record.createdAt.length === 0) record.createdAt = record.updatedAt;
  if (record.syncEntityType === undefined) record.syncEntityType = '';
  if (record.restored === undefined) record.restored = false;
  if (record.context.syncStatus === undefined) record.context.syncStatus = 'synced';
  return record;
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
function compareRecords(left: IDERecord, right: IDERecord): number {
  return Number(left.isTestData) - Number(right.isTestData) || left.context.version - right.context.version ||
    left.createdAt.localeCompare(right.createdAt) || left.serverSequence - right.serverSequence ||
    left.serverVersion - right.serverVersion || left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id);
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
  if (record.serverVersion === undefined) record.serverVersion = 0;
  if (record.serverSequence === undefined) record.serverSequence = 0;
  if (record.createdAt === undefined) record.createdAt = record.updatedAt;
  if (record.syncEntityType === undefined) record.syncEntityType = '';
  if (record.restored === undefined) record.restored = false;
  if (record.context.syncStatus === undefined) record.context.syncStatus = 'synced';
  return record;
}
