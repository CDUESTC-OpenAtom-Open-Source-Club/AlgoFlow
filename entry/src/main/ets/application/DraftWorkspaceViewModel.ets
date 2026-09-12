import { DraftRepository } from '../domain/DraftRepository';
import { AIMode, Draft, DraftVersion, IdeaSegment, Notification, NotificationKind, SyncStatus } from '../domain/Models';
import { SyncRepository } from '../domain/SyncRepository';
import { PhoneSyncService, SyncRunResult, SyncRunStatus } from '../platform/PhoneSyncService';

export class DraftWorkspaceViewModel {
  private repository: DraftRepository;
  private syncRepository?: SyncRepository;
  private sequence: number = 1;
  private segmentSequence: number = 1;

  constructor(repository: DraftRepository, syncRepository?: SyncRepository) {
    this.repository = repository;
    this.syncRepository = syncRepository;
  }

  async initialize(): Promise<void> {
    await this.repository.initialize();
  }

  async synchronize(): Promise<SyncRunResult | undefined> {
    if (this.syncRepository === undefined || this.syncRepository.listPendingOperations === undefined) return undefined;
    await this.repository.flush();
    const result = await new PhoneSyncService(this.syncRepository).synchronize();
    if (result.status === SyncRunStatus.FAILED) {
      this.repository.recordNotification(NotificationKind.SYNC_FAILED, '同步失败', result.message);
    } else if (result.status === SyncRunStatus.CONFLICT) {
      this.repository.recordNotification(NotificationKind.CONFLICT, '发现冲突', result.message);
    }
    return result;
  }

  getSyncBaseUrl(): string {
    return this.syncRepository?.getBaseUrl() ?? '';
  }

  setSyncBaseUrl(baseUrl: string): void {
    this.syncRepository?.setBaseUrl(baseUrl);
  }

  ensureStarterDraft(): string {
    const existing = this.repository.list();
    if (existing.length > 0) return existing[0].id;
    return this.createDraft();
  }

  createDraft(): string {
    const id = this.repository.list().length === 0
      ? 'draft-local' : `phone-draft-${Date.now()}-${this.sequence++}`;
    this.repository.save(new Draft(id, '未命名思路'));
    return id;
  }

  listDrafts(): Draft[] { return this.repository.list(); }
  listAllDrafts(): Draft[] { return this.repository.listAll(); }
  listArchivedDrafts(): Draft[] { return this.repository.listArchived(); }
  getDraft(id: string): Draft | undefined { return this.repository.get(id); }

  archiveDraft(id: string): void {
    const draft = this.repository.get(id);
    if (draft === undefined) return;
    draft.archived = true;
    draft.archivedAt = new Date().toISOString();
    draft.updatedAt = draft.archivedAt;
    draft.syncStatus = SyncStatus.LOCAL_ONLY;
    this.repository.save(draft);
  }

  restoreDraft(id: string): void {
    const draft = this.repository.get(id);
    if (draft === undefined) return;
    draft.archived = false;
    draft.archivedAt = '';
    draft.updatedAt = new Date().toISOString();
    draft.syncStatus = SyncStatus.LOCAL_ONLY;
    this.repository.save(draft);
  }

  listVersions(id: string): DraftVersion[] { return this.repository.listVersions(id); }
  allVersions(): DraftVersion[] { return this.repository.listAllVersions(); }
  totalVersionCount(): number { return this.repository.totalVersionCount(); }

  listNotifications(): Notification[] { return this.repository.listNotifications(); }
  unreadNotificationCount(): number { return this.repository.unreadNotificationCount(); }
  markNotificationRead(id: string): void { this.repository.markNotificationRead(id); }
  markAllNotificationsRead(): void { this.repository.markAllNotificationsRead(); }

  update(id: string, title: string, idea: string, code: string, shortCode: string, rewrite: string): void {
    const draft = this.repository.get(id);
    if (draft === undefined) return;
    draft.title = title;
    draft.idea = idea;
    draft.code = code;
    draft.shortCode = shortCode;
    draft.rewrite = rewrite;
    draft.ideaSegments = this.buildIdeaSegments(draft, idea);
    draft.updatedAt = new Date().toISOString();
    draft.syncStatus = SyncStatus.LOCAL_ONLY;
    this.repository.save(draft);
  }

  private buildIdeaSegments(draft: Draft, idea: string): IdeaSegment[] {
    const contents = idea.split('\n').map((item: string) => item.trim())
      .filter((item: string) => item.length > 0);
    const segments: IdeaSegment[] = [];
    contents.forEach((content: string, position: number) => {
      const sameContent = draft.ideaSegments.find((item: IdeaSegment) =>
        item.content === content && segments.find((used: IdeaSegment) => used.id === item.id) === undefined);
      const samePosition = draft.ideaSegments.find((item: IdeaSegment) =>
        item.position === position && segments.find((used: IdeaSegment) => used.id === item.id) === undefined);
      const matched = sameContent === undefined ? samePosition : sameContent;
      const id = matched === undefined ? `idea_segment_${Date.now()}_${this.segmentSequence++}` : matched.id;
      segments.push(new IdeaSegment(id, content, position));
    });
    return segments;
  }

  setMode(id: string, mode: AIMode): void {
    const draft = this.repository.get(id);
    if (draft === undefined) return;
    draft.aiMode = mode;
    draft.updatedAt = new Date().toISOString();
    draft.syncStatus = SyncStatus.LOCAL_ONLY;
    this.repository.save(draft);
  }

  toggleArtifact(id: string): void {
    const draft = this.repository.get(id);
    if (draft === undefined) return;
    draft.artifactHidden = !draft.artifactHidden;
    draft.updatedAt = new Date().toISOString();
    draft.syncStatus = SyncStatus.LOCAL_ONLY;
    this.repository.save(draft);
  }

  deleteDraft(id: string): string {
    this.repository.delete(id);
    const remaining = this.repository.list();
    return remaining.length > 0 ? remaining[0].id : this.createDraft();
  }
}
