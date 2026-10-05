import { DraftRepository } from '../domain/DraftRepository';
import { AIArtifact, AIVisibility, AIMode, Draft, IdeaSegment, ReviewFreshness, ReviewKind, ReviewResult, SyncStatus } from '../domain/Models';
import { SyncRepository } from '../domain/SyncRepository';
import { PhoneSyncService, SyncRunResult } from '../platform/PhoneSyncService';
import { AIGatewayReviewPayload, ConflictRecord, SyncEntityType, reviewSourceMatchesDraft, reviewToPayload } from '../domain/SyncModels';
import { HttpAIClient, AIRequestInput, AIRequestIdeaSegment, ReviewRequestInput } from '../platform/HttpAIClient';
import { gatewayPayloadToArtifact } from '../domain/AIArtifactCodec';
import { gatewayPayloadToReview } from '../domain/SyncModels';
import { util } from '@kit.ArkTS';

export type ReviewGateway = (baseUrl: string, request: ReviewRequestInput, client?: HttpAIClient) => Promise<AIGatewayReviewPayload>;

export class DraftWorkspaceViewModel {
  private repository: DraftRepository;
  private syncRepository?: SyncRepository;
  private reviewGateway: ReviewGateway;
  private createReviewId: () => string;
  private activeAIClient: HttpAIClient | undefined = undefined;
  private sequence: number = 1;
  private segmentSequence: number = 1;

  constructor(repository: DraftRepository, syncRepository?: SyncRepository, reviewGateway?: ReviewGateway,
    createReviewId: () => string = () => util.generateRandomUUID()) {
    this.repository = repository;
    this.syncRepository = syncRepository;
    this.reviewGateway = reviewGateway ?? ((baseUrl: string, request: ReviewRequestInput, client?: HttpAIClient) =>
      (client ?? new HttpAIClient(baseUrl)).review(request));
    this.createReviewId = createReviewId;
  }

  async initialize(): Promise<void> {
    await this.repository.initialize();
  }

  async synchronize(): Promise<SyncRunResult | undefined> {
    if (this.syncRepository === undefined || this.syncRepository.listPendingOperations === undefined) return undefined;
    await this.repository.flush();
    const result = await new PhoneSyncService(this.syncRepository).synchronize();
    await this.repository.flush();
    return result;
  }

  getSyncBaseUrl(): string {
    return this.syncRepository?.getBaseUrl() ?? '';
  }

  setSyncBaseUrl(baseUrl: string): void {
    this.syncRepository?.setBaseUrl(baseUrl);
  }

  cancelAIRequest(): void {
    this.activeAIClient?.cancel();
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
  listReviews(): ReviewResult[] {
    const reviews = this.syncRepository?.listReviews() ?? [];
    return reviews.map((review: ReviewResult) => {
      review.freshness = this.isReviewCurrent(review.id) ? ReviewFreshness.CURRENT : ReviewFreshness.STALE;
      return review;
    });
  }
  hasReviewSource(id: string): boolean {
    const review = this.syncRepository?.getReview(id);
    if (review === undefined || this.syncRepository === undefined) return false;
    const payload = reviewToPayload(review);
    return reviewSourceMatchesDraft(payload, this.syncRepository.getDraft(review.draftId),
      this.syncRepository.getDraftSourceCode(review.draftId, review.sourceDraftVersion));
  }

  isReviewCurrent(id: string): boolean {
    const review = this.syncRepository?.getReview(id);
    const draft = review === undefined ? undefined : this.syncRepository?.getDraft(review.draftId);
    if (review === undefined || draft === undefined || draft.deleted || draft.version !== review.sourceDraftVersion ||
      this.syncRepository?.hasPendingOperation(SyncEntityType.DRAFT, draft.id)) return false;
    const snapshotCode = this.syncRepository?.getDraftSourceCode(review.draftId, review.sourceDraftVersion);
    return snapshotCode === undefined || snapshotCode === draft.code;
  }

  saveReview(review: ReviewResult): void {
    const draft = this.syncRepository?.getDraft(review.draftId);
    review.freshness = draft !== undefined && draft.version === review.sourceDraftVersion &&
      !this.syncRepository?.hasPendingOperation(SyncEntityType.DRAFT, draft.id) ? ReviewFreshness.CURRENT : ReviewFreshness.STALE;
    this.syncRepository?.saveReview(review);
  }

  async toggleReview(id: string): Promise<void> {
    const review = this.syncRepository?.getReview(id);
    if (review === undefined) return;
    if (!this.isReviewCurrent(id) || !this.hasReviewSource(id)) throw new Error('REVIEW_RESULT_STALE');
    review.visibility = review.visibility === AIVisibility.HIDDEN ? AIVisibility.VISIBLE : AIVisibility.HIDDEN;
    review.freshness = ReviewFreshness.CURRENT;
    this.syncRepository?.saveReview(review);
    await this.repository.flush();
  }

  listConflicts(): ConflictRecord[] { return this.syncRepository?.listConflicts() ?? []; }

  async resolveReviewConflict(conflictId: string, resolution: 'keep_local' | 'use_server'): Promise<void> {
    if (this.syncRepository === undefined) throw new Error('AI_SYNC_REPOSITORY_REQUIRED');
    this.syncRepository.resolveReviewConflict(conflictId, resolution);
    await this.repository.flush();
  }

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
    const client = new HttpAIClient(baseUrl);
    this.activeAIClient = client;
    try {
      const response = await client.generate(request);
      if (client.wasCancelled()) throw new Error('AI_REQUEST_CANCELLED');
      if (response.mode !== request.mode || response.source_draft_version !== request.draft_version ||
        response.rule_version !== request.rule_version || response.output_kind !== request.output_kind ||
        response.visibility !== request.visibility) throw new Error('INVALID_AI_ARTIFACT');
      const artifact = gatewayPayloadToArtifact(response, util.generateRandomUUID(), draft.id, draft.version,
        this.syncRepository.getClientId(), draft.ideaSegments.map((segment: IdeaSegment) => segment.id));
      if (artifact === undefined) throw new Error('INVALID_AI_ARTIFACT');
      this.syncRepository.saveArtifact(artifact);
      return artifact;
    } finally {
      if (this.activeAIClient === client) this.activeAIClient = undefined;
    }
  }

  async generateReview(id: string, baseUrl: string, mode: AIMode, reviewKind: ReviewKind): Promise<ReviewResult> {
    if (this.syncRepository === undefined) throw new Error('AI_SYNC_REPOSITORY_REQUIRED');
    const draft = this.repository.get(id);
    if (draft === undefined) throw new Error('DRAFT_NOT_FOUND');
    if (draft.version < 1 || draft.syncStatus !== SyncStatus.SYNCED ||
      this.syncRepository.hasPendingOperation(SyncEntityType.DRAFT, draft.id)) throw new Error('REVIEW_DRAFT_NOT_SYNCED');
    const sourceVersion = draft.version;
    const sourceCode = draft.code;
    const sourceIdea = draft.idea;
    const request = new ReviewRequestInput();
    request.mode = mode;
    request.draft_id = draft.id;
    request.draft_version = sourceVersion;
    request.code = sourceCode;
    request.idea = sourceIdea;
    request.review_kind = reviewKind;
    const client = new HttpAIClient(baseUrl);
    this.activeAIClient = client;
    try {
      const response = await this.reviewGateway(baseUrl, request, client);
      if (client.wasCancelled()) throw new Error('AI_REQUEST_CANCELLED');
      if (response.mode !== request.mode || response.source_draft_version !== request.draft_version ||
        response.rule_version !== request.rule_version || response.review_kind !== request.review_kind ||
        response.visibility !== request.visibility) throw new Error('INVALID_REVIEW_RESULT');
      const latestDraft = this.repository.get(id);
      if (latestDraft === undefined || latestDraft.version !== sourceVersion || latestDraft.code !== sourceCode ||
        latestDraft.idea !== sourceIdea || latestDraft.syncStatus !== SyncStatus.SYNCED ||
        this.syncRepository.hasPendingOperation(SyncEntityType.DRAFT, id)) throw new Error('DRAFT_CHANGED_RETRY_REVIEW');
      const review = gatewayPayloadToReview(response, this.createReviewId(), draft.id, sourceVersion,
        this.syncRepository.getClientId());
      if (review === undefined || review.mode !== mode || review.reviewKind !== reviewKind ||
        review.sourceDraftVersion !== sourceVersion) throw new Error('INVALID_REVIEW_RESULT');
      this.syncRepository.saveReview(review);
      await this.repository.flush();
      return review;
    } finally {
      if (this.activeAIClient === client) this.activeAIClient = undefined;
    }
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
