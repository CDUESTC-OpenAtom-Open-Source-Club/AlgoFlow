import { ConflictRecord, Draft } from './Models';

/**
 * 草稿仓储端口（领域层，不依赖任何平台实现）。
 * UI/ViewModel 只依赖此端口；具体持久化由 platform 层适配器实现。
 */
export interface DraftRepository {
  list(): Draft[];
  get(id: string): Draft | undefined;
  save(draft: Draft): void;
  /** 墓碑删除：软删除并参与同步，不物理移除。 */
  delete(id: string): void;
  saveConflictRecord(record: ConflictRecord): void;
  listConflictRecords(draftId: string): ConflictRecord[];
}
