import { DraftRepository } from '../domain/DraftRepository';
import { AIArtifact, AIVisibility, AIMode, Draft, IdeaSegment, SyncStatus } from '../domain/Models';
import { SyncRepository } from '../domain/SyncRepository';
import { PhoneSyncService, SyncRunResult } from '../platform/PhoneSyncService';
import { HttpAIClient, AIRequestInput, AIRequestIdeaSegment } from '../platform/HttpAIClient';
import { gatewayPayloadToArtifact } from '../domain/AIArtifactCodec';
import { util } from '@kit.ArkTS';

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
    return await new PhoneSyncService(this.syncRepository).synchronize();
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
  getDraft(id: string): Draft | undefined { return this.repository.get(id); }

  listArtifacts(): AIArtifact[] { return this.syncRepository?.listArtifacts() ?? []; }

  getArtifact(id: string): AIArtifact | undefined { return this.syncRepository?.getArtifact(id); }

  saveArtifact(artifact: AIArtifact): void { this.syncRepository?.saveArtifact(artifact); }

  async generateFaithfulArtifact(id: string, baseUrl: string): Promise<AIArtifact> {
    if (this.syncRepository === undefined) throw new Error('AI_SYNC_REPOSITORY_REQUIRED');
    const draft = this.repository.get(id);
    if (draft === undefined) throw new Error('DRAFT_NOT_FOUND');
    if (draft.ideaSegments.length === 0) throw new Error('AI_IDEA_REQUIRED');
    const request = new AIRequestInput();
    request.mode = AIMode.FAITHFUL_TRANSFORM;
    request.draft_id = draft.id;
    request.draft_version = draft.version;
    request.problem_context = draft.idea.length > 0 ? draft.idea : draft.title;
    request.idea_segments = draft.ideaSegments.map((segment: IdeaSegment) =>
      new AIRequestIdeaSegment(segment.id, segment.content));
    const response = await new HttpAIClient(baseUrl).generate(request);
    if (response.mode !== request.mode || response.source_draft_version !== request.draft_version ||
      response.rule_version !== request.rule_version || response.output_kind !== request.output_kind ||
      response.visibility !== request.visibility) throw new Error('INVALID_AI_ARTIFACT');
    const artifact = gatewayPayloadToArtifact(response, util.generateRandomUUID(), draft.id, draft.version,
      this.syncRepository.getClientId(), draft.ideaSegments.map((segment: IdeaSegment) => segment.id));
    if (artifact === undefined) throw new Error('INVALID_AI_ARTIFACT');
    this.syncRepository.saveArtifact(artifact);
    return artifact;
  }

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
    const artifact = this.syncRepository?.listArtifacts().find((item: AIArtifact) =>
      item.draftId === id && item.mode === draft.aiMode);
    if (artifact === undefined) return;
    artifact.visibility = artifact.visibility === AIVisibility.HIDDEN ? AIVisibility.VISIBLE : AIVisibility.HIDDEN;
    this.syncRepository?.saveArtifact(artifact);
  }

  deleteDraft(id: string): string {
    this.repository.delete(id);
    const remaining = this.repository.list();
    return remaining.length > 0 ? remaining[0].id : this.createDraft();
  }
}
