import { DraftRepository } from '../domain/DraftRepository';
import { AIMode, Draft, IdeaSegment, SyncStatus } from '../domain/Models';

export class DraftWorkspaceViewModel {
  private repository: DraftRepository;
  private sequence: number = 1;
  private segmentSequence: number = 1;

  constructor(repository: DraftRepository) {
    this.repository = repository;
  }

  ensureStarterDraft(): string {
    const existing = this.repository.list();
    if (existing.length > 0) return existing[0].id;
    return this.createDraft();
  }

  createDraft(): string {
    const id = `phone-draft-${Date.now()}-${this.sequence++}`;
    this.repository.save(new Draft(id, '未命名思路'));
    return id;
  }

  listDrafts(): Draft[] { return this.repository.list(); }
  getDraft(id: string): Draft | undefined { return this.repository.get(id); }

  update(id: string, title: string, idea: string, code: string, shortCode: string, rewrite: string): void {
    const draft = this.repository.get(id);
    if (draft === undefined) return;
    draft.title = title;
    draft.idea = idea;
    draft.code = code;
    draft.shortCode = shortCode;
    draft.rewrite = rewrite;
    draft.ideaSegments = this.buildIdeaSegments(draft, idea);
    draft.version += 1;
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
    draft.version += 1;
    draft.updatedAt = new Date().toISOString();
    draft.syncStatus = SyncStatus.LOCAL_ONLY;
    this.repository.save(draft);
  }

  toggleArtifact(id: string): void {
    const draft = this.repository.get(id);
    if (draft === undefined) return;
    draft.artifactHidden = !draft.artifactHidden;
    draft.version += 1;
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
