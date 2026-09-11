import { DraftRepository } from '../domain/DraftRepository';
import { AIArtifact, AIErrorCode, AIMode, AIOutputKind, AIRequest, AIRequestSegment, AIResult,
  AIResultStatus, AIVisibility, Draft, IdeaSegment, SyncStatus } from '../domain/Models';
import { AIProvider } from '../domain/AIProvider';
import { SyncRepository } from '../domain/SyncRepository';
import { PhoneSyncService, SyncRunResult } from '../platform/PhoneSyncService';
import { HttpAIProvider } from '../platform/HttpAIProvider';

const RULE_VERSION = '1.0.0';

export class DraftWorkspaceViewModel {
  private repository: DraftRepository;
  private syncRepository?: SyncRepository;
  private aiProvider: AIProvider;
  private aiBaseUrl: string = 'http://127.0.0.1:8788';
  private aiRequestInFlight: boolean = false;
  private sequence: number = 1;
  private segmentSequence: number = 1;

  constructor(repository: DraftRepository, syncRepository?: SyncRepository, aiProvider?: AIProvider) {
    this.repository = repository;
    this.syncRepository = syncRepository;
    this.aiProvider = aiProvider ?? new HttpAIProvider(this.aiBaseUrl);
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

  setAIBaseUrl(baseUrl: string): void {
    this.aiBaseUrl = baseUrl;
    this.aiProvider = new HttpAIProvider(baseUrl);
  }

  getAIBaseUrl(): string {
    return this.aiBaseUrl;
  }

  isAIRequestInFlight(): boolean {
    return this.aiRequestInFlight;
  }

  cancelAI(): void {
    if (this.aiProvider instanceof HttpAIProvider) {
      (this.aiProvider as HttpAIProvider).cancel();
    }
  }

  async requestAI(id: string, mode: AIMode): Promise<AIResult> {
    const draft = this.repository.get(id);
    if (draft === undefined) {
      return AIResult.failure(AIErrorCode.INVALID_REQUEST, '草稿不存在');
    }
    if (draft.ideaSegments.length === 0) {
      return AIResult.failure(AIErrorCode.INVALID_REQUEST, '请先在 idea.md 中填写思路片段');
    }
    const problemContext = buildProblemContext(draft);
    if (problemContext.length === 0) {
      return AIResult.failure(AIErrorCode.INVALID_REQUEST, '请先填写草稿标题或思路内容');
    }
    const segments = draft.ideaSegments.map((segment: IdeaSegment) =>
      new AIRequestSegment(segment.id, segment.content));
    const request = new AIRequest(mode, draft.id, draft.version, 'cpp', RULE_VERSION,
      problemContext, segments, AIOutputKind.PSEUDOCODE,
      draft.artifactHidden ? AIVisibility.HIDDEN : AIVisibility.VISIBLE);
    this.aiRequestInFlight = true;
    try {
      const result = await this.aiProvider.generate(request);
      if (result.status === AIResultStatus.SUCCESS && result.artifact !== null) {
        this.saveArtifact(id, result.artifact);
      }
      return result;
    } finally {
      this.aiRequestInFlight = false;
    }
  }

  getArtifact(id: string, mode: AIMode): AIArtifact | undefined {
    const draft = this.repository.get(id);
    if (draft === undefined) return undefined;
    return draft.artifactForMode(mode);
  }

  private saveArtifact(id: string, artifact: AIArtifact): void {
    const draft = this.repository.get(id);
    if (draft === undefined) return;
    const others = draft.aiArtifacts.filter((item: AIArtifact) => item.mode !== artifact.mode);
    draft.aiArtifacts = others.concat([artifact.clone()]);
    draft.updatedAt = new Date().toISOString();
    draft.syncStatus = SyncStatus.LOCAL_ONLY;
    this.repository.save(draft);
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

function buildProblemContext(draft: Draft): string {
  if (draft.title.length > 0 && draft.title !== '未命名思路') return draft.title;
  return draft.idea.trim();
}
