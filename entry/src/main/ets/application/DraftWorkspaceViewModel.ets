import { DraftRepository } from '../domain/DraftRepository';
import { AIArtifact, AIErrorCode, AIMode, AIOutputKind, AIRequest, AIRequestSegment, AIResult,
  AIVisibility, Draft, IdeaSegment, SyncStatus } from '../domain/Models';
import { AIProvider } from '../domain/AIProvider';
import { SyncRepository } from '../domain/SyncRepository';
import { PhoneSyncService, SyncRunResult } from '../platform/PhoneSyncService';
import { HttpAIProvider } from '../platform/HttpAIProvider';
import { IDEAISession } from './IDEAISession';
import { AIResultRepository, IDEContext } from '../domain/IDEAIModels';

const RULE_VERSION = '1.0.0';

export class DraftWorkspaceViewModel {
  aiSession: IDEAISession | null = null;
  private aiFile: string = 'main.cpp';
  private aiDraft: string = '';
  private syncing: boolean = false;
  private repository: DraftRepository;
  private syncRepository?: SyncRepository;
  private aiProvider: AIProvider;
  private aiBaseUrl: string = 'http://127.0.0.1:8788';
  private allowTestData: boolean = false;
  private aiRequestInFlight: boolean = false;
  private aiRequestGeneration: number = 0;
  private sequence: number = 1;
  private segmentSequence: number = 1;

  constructor(repository: DraftRepository, syncRepository?: SyncRepository, aiProvider?: AIProvider) {
    this.repository = repository;
    this.syncRepository = syncRepository;
    this.aiProvider = aiProvider ?? new HttpAIProvider(this.aiBaseUrl);
  }

  async initialize(): Promise<void> {
    await this.repository.initialize();
    this.aiBaseUrl = this.repository.getAIBaseUrl();
    this.aiProvider = new HttpAIProvider(this.aiBaseUrl, 0, 10000, this.allowTestData);
  }

  configureAI(repository: AIResultRepository, allowTestData: boolean): void {
    this.allowTestData = allowTestData;
    this.aiSession?.dispose();
    const provider = new HttpAIProvider(this.aiBaseUrl, 0, 10000, allowTestData);
    this.aiProvider = provider;
    this.aiSession = new IDEAISession(provider, repository);
  }

  selectAIContext(id: string, file: string): void {
    this.aiDraft = id; this.aiFile = file;
    const draft = this.repository.get(id);
    if (draft === undefined) { void this.aiSession?.removeDraft(id); return; }
    const context = new IDEContext(); context.draftId = draft.id; context.version = draft.version;
    context.file = file; context.mode = draft.aiMode; context.code = draft.code; context.idea = draft.idea;
    context.problemContext = draft.title || '当前草稿';
    context.segments = draft.ideaSegments.map(segment => new AIRequestSegment(segment.id, segment.content));
    this.aiSession?.setContext(context);
  }

  async synchronize(): Promise<SyncRunResult | undefined> {
    if (this.syncRepository === undefined || this.syncRepository.listPendingOperations === undefined) return undefined;
    if (this.syncing) return undefined;
    this.syncing = true;
    this.cancelAI();
    try {
      await this.repository.flush();
      const result = await new PhoneSyncService(this.syncRepository).synchronize();
      await this.repository.flush();
      this.selectAIContext(this.aiDraft, this.aiFile);
      return result;
    } finally { this.syncing = false; }
  }

  getSyncBaseUrl(): string {
    return this.syncRepository?.getBaseUrl() ?? '';
  }

  setSyncBaseUrl(baseUrl: string): void {
    this.syncRepository?.setBaseUrl(baseUrl);
  }

  setAIBaseUrl(baseUrl: string, allowTestData: boolean = false): void {
    this.aiRequestGeneration += 1;
    this.aiRequestInFlight = false;
    this.aiProvider.cancel();
    this.aiBaseUrl = baseUrl;
    this.allowTestData = allowTestData;
    const provider = new HttpAIProvider(baseUrl, 0, 10000, allowTestData);
    this.aiProvider = provider;
    this.repository.setAIBaseUrl(baseUrl);
    this.aiSession?.setProvider(provider);
  }

  getAIBaseUrl(): string {
    return this.aiBaseUrl;
  }

  isAIRequestInFlight(): boolean {
    return this.aiRequestInFlight;
  }

  cancelAI(): void {
    this.aiRequestGeneration += 1;
    this.aiRequestInFlight = false;
    this.aiProvider.cancel();
    this.aiSession?.cancel();
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
    const requestGeneration = ++this.aiRequestGeneration;
    this.aiRequestInFlight = true;
    try {
      const result = await IDEAISession.requestTransform(this.aiProvider, request);
      if (requestGeneration !== this.aiRequestGeneration) {
        return AIResult.failure(AIErrorCode.CANCELLED, 'AI 请求已取消');
      }
      return result;
    } finally {
      if (requestGeneration === this.aiRequestGeneration) this.aiRequestInFlight = false;
    }
  }

  setArtifactHidden(id: string, hidden: boolean): void {
    const draft = this.repository.get(id);
    if (draft === undefined) return;
    draft.artifactHidden = hidden;
    this.repository.save(draft);
  }

  getArtifact(id: string, mode: AIMode): AIArtifact | undefined {
    const draft = this.repository.get(id);
    if (draft === undefined) return undefined;
    return draft.artifactForMode(mode);
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
    this.cancelAI();
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
    this.selectAIContext(id, this.aiFile);
  }

  private buildIdeaSegments(draft: Draft, idea: string): IdeaSegment[] {
    const contents = idea.split('\n').map((item: string) => item.trim())
      .filter((item: string) => item.length > 0);
    const used: string[] = [];
    const matches = contents.map((content: string) => {
      const found = draft.ideaSegments.find(item => item.content.trim() === content && !used.includes(item.id));
      if (found !== undefined) used.push(found.id);
      return found;
    });
    const segments: IdeaSegment[] = [];
    contents.forEach((content: string, position: number) => {
      const sameContent = matches[position];
      const samePosition = contents.length === draft.ideaSegments.length ? draft.ideaSegments.find((item: IdeaSegment) =>
        item.position === position && !used.includes(item.id)) : undefined;
      const matched = sameContent === undefined ? samePosition : sameContent;
      if (matched !== undefined && !used.includes(matched.id)) used.push(matched.id);
      const id = matched === undefined ? `idea_segment_${Date.now()}_${this.segmentSequence++}` : matched.id;
      segments.push(new IdeaSegment(id, content, position));
    });
    return segments;
  }

  setMode(id: string, mode: AIMode): void {
    this.cancelAI();
    const draft = this.repository.get(id);
    if (draft === undefined) return;
    draft.aiMode = mode;
    draft.updatedAt = new Date().toISOString();
    draft.syncStatus = SyncStatus.LOCAL_ONLY;
    this.repository.save(draft);
    this.selectAIContext(id, this.aiFile);
  }

  toggleArtifact(id: string): void {
    this.aiSession?.records.forEach(record => this.aiSession?.setHidden(record.id, !record.hidden));
  }

  deleteDraft(id: string): string {
    this.cancelAI();
    this.aiSession?.removeDraft(id);
    this.repository.delete(id);
    const remaining = this.repository.list();
    return remaining.length > 0 ? remaining[0].id : this.createDraft();
  }
}

function buildProblemContext(draft: Draft): string {
  return draft.title || '当前草稿';
}
