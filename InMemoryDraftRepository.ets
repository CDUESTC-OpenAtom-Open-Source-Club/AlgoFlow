import { DraftRepository } from '../domain/DraftRepository';
import { ConflictRecord, Draft } from '../domain/Models';

/**
 * 内存草稿仓储（占位适配器）。
 *
 * 仅用于单端闭环演示与契约校验，不提供持久化：应用重启后数据丢失。
 * 若实现 API 20 RDB 持久化，必须先编写首次建库脚本、版本迁移脚本与回滚方案，
 * 并在提交时明确本地/云手机的验证环境。当前不得声称已完成数据库持久化。
 */
export class InMemoryDraftRepository implements DraftRepository {
  private drafts: Draft[] = [];
  private conflictRecords: ConflictRecord[] = [];

  list(): Draft[] {
    return this.drafts.filter((draft: Draft): boolean => !draft.deleted);
  }

  get(id: string): Draft | undefined {
    return this.drafts.find((draft: Draft): boolean => draft.id === id && !draft.deleted);
  }

  save(draft: Draft): void {
    const index = this.drafts.findIndex((item: Draft): boolean => item.id === draft.id);
    if (index >= 0) {
      this.drafts[index] = draft;
    } else {
      this.drafts.push(draft);
    }
  }

  delete(id: string): void {
    const draft = this.get(id);
    if (draft !== undefined) {
      draft.deleted = true;
      draft.updatedAt = new Date().toISOString();
    }
  }

  saveConflictRecord(record: ConflictRecord): void {
    this.conflictRecords.push(record);
  }

  listConflictRecords(draftId: string): ConflictRecord[] {
    return this.conflictRecords.filter((record: ConflictRecord): boolean => record.entityId === draftId);
  }
}
