import { describe, beforeAll, beforeEach, afterEach, afterAll, it, expect } from '@ohos/hypium';
import http from '@ohos.net.http';
import { AIArtifact, AIMode, Draft, ReviewFreshness, ReviewKind, ReviewResult, SyncStatus } from '../main/ets/domain/Models';
import { AIArtifactPayload } from '../main/ets/domain/AIArtifactCodec';
import { AIGatewayReviewPayload, ConflictRecord, DraftPayload, PullChange, PullResult, PushResult, ReviewDiagnosticPayload, ReviewResultPayload, SourceRangePayload,
  SyncOperation, payloadToReview, reviewSourceMatchesDraft } from '../main/ets/domain/SyncModels';
import { DraftRepository } from '../main/ets/domain/DraftRepository';
import { SyncRepository } from '../main/ets/domain/SyncRepository';
import { PhoneSyncService, SyncRunStatus, SyncTransport } from '../main/ets/platform/PhoneSyncService';
import { DraftWorkspaceViewModel, ReviewGateway } from '../main/ets/application/DraftWorkspaceViewModel';
import { AIHttpRequestHandle, HttpAIClient, ReviewRequestInput } from '../main/ets/platform/HttpAIClient';
import { gatewayPayloadToReview } from '../main/ets/domain/SyncModels';

export default function localUnitTest() {
  describe('localUnitTest', () => {
    // Defines a test suite. Two parameters are supported: test suite name and test suite function.
    beforeAll(() => {
      // Presets an action, which is performed only once before all test cases of the test suite start.
      // This API supports only one parameter: preset action function.
    });
    beforeEach(() => {
      // Presets an action, which is performed before each unit test case starts.
      // The number of execution times is the same as the number of test cases defined by **it**.
      // This API supports only one parameter: preset action function.
    });
    afterEach(() => {
      // Presets a clear action, which is performed after each unit test case ends.
      // The number of execution times is the same as the number of test cases defined by **it**.
      // This API supports only one parameter: clear action function.
    });
    afterAll(() => {
      // Presets a clear action, which is performed after all test cases of the test suite end.
      // This API supports only one parameter: clear action function.
    });
    it('assertContain', 0, () => {
      // Defines a test case. This API supports three parameters: test case name, filter parameter, and test case function.
      let a = 'abc';
      let b = 'b';
      // Defines a variety of assertion methods, which are used to declare expected boolean conditions.
      expect(a).assertContain(b);
      expect(a).assertEqual(a);
    });
    it('rejects invalid review diagnostic ranges', 0, () => {
      const payload = validReviewPayload();
      const range = payload.diagnostics[0].range;
      if (range !== null) {
        range.start_line = 4;
        range.end_line = 2;
      }
      expect(payloadToReview(payload) === undefined).assertTrue();
    });
    it('accepts only the three review kinds defined by the shared contract', 0, () => {
      const payload = validReviewPayload();
      const kinds: string[] = ['explanation', 'risk', 'complexity'];
      for (const kind of kinds) {
        payload.review_kind = kind;
        const review = payloadToReview(payload);
        expect(review !== undefined).assertTrue();
        expect(review?.reviewKind).assertEqual(kind);
      }
      payload.review_kind = 'solution';
      expect(payloadToReview(payload) === undefined).assertTrue();
    });
    it('maps current and stale review freshness values in the shared review entity', 0, () => {
      const payload = validReviewPayload();
      payload.freshness = ReviewFreshness.STALE;
      const staleReview = payloadToReview(payload);
      expect(staleReview?.freshness).assertEqual(ReviewFreshness.STALE);
      payload.freshness = 'expired';
      expect(payloadToReview(payload) === undefined).assertTrue();
    });
    it('caps phone AI request retries at one retry', 0, async () => {
      let attempts = 0;
      const client = new HttpAIClient('http://gateway', () => new FakeAIHttpRequest(async () => {
        attempts += 1;
        throw new Error('network');
      }, () => {}));
      let errorCode = '';
      try {
        await client.review(new ReviewRequestInput());
      } catch (error) {
        errorCode = error instanceof Error ? error.message : 'unknown';
      }
      expect(attempts).assertEqual(2);
      expect(errorCode).assertEqual('AI_NETWORK_ERROR');
    });
    it('cancels a pending phone AI request through HttpRequest.destroy', 0, async () => {
      let rejectRequest: ((error: Error) => void) | undefined = undefined;
      let destroyCount = 0;
      const client = new HttpAIClient('http://gateway', () => new FakeAIHttpRequest(
        () => new Promise<http.HttpResponse>((_resolve, reject) => { rejectRequest = reject; }),
        () => { destroyCount += 1; rejectRequest?.(new Error('destroyed')); }
      ));
      const request = client.review(new ReviewRequestInput());
      client.cancel();
      let errorCode = '';
      try {
        await request;
      } catch (error) {
        errorCode = error instanceof Error ? error.message : 'unknown';
      }
      expect(destroyCount).assertEqual(1);
      expect(errorCode).assertEqual('AI_REQUEST_CANCELLED');
    });
    it('maps a valid Gateway response into the shared review entity contract', 0, () => {
      const request = new ReviewRequestInput();
      request.mode = AIMode.FAITHFUL_TRANSFORM;
      request.draft_id = 'draft-gateway-review';
      request.draft_version = 2;
      request.review_kind = ReviewKind.RISK;
      const result = gatewayPayloadToReview(gatewayReview(request), 'review-gateway', request.draft_id,
        request.draft_version, 'phone-test');
      expect(result !== undefined).assertTrue();
      expect(result?.sourceDraftVersion).assertEqual(2);
      expect(result?.reviewKind).assertEqual(ReviewKind.RISK);
    });
    it('marks a review stale when its Draft advances and prevents visibility changes', 0, async () => {
      const draft = new Draft('draft-review-stale', 'Review');
      draft.version = 2;
      draft.code = 'x';
      draft.idea = 'Check x';
      draft.syncStatus = SyncStatus.SYNCED;
      const repository = new ReviewSyncTestRepository(draft);
      const gateway: ReviewGateway = async (baseUrl: string, request: ReviewRequestInput) => gatewayReview(request);
      const viewModel = new DraftWorkspaceViewModel(repository, repository, gateway, () => 'review-stale-test');
      const review = await viewModel.generateReview(draft.id, 'http://gateway', AIMode.FAITHFUL_TRANSFORM, ReviewKind.RISK);
      expect(review.freshness).assertEqual(ReviewFreshness.CURRENT);
      draft.version = 3;
      draft.code = 'changed';
      expect(viewModel.listReviews()[0].freshness).assertEqual(ReviewFreshness.STALE);
      let rejected = false;
      try {
        await viewModel.toggleReview(review.id);
      } catch (error) {
        rejected = error instanceof Error && error.message === 'REVIEW_RESULT_STALE';
      }
      expect(rejected).assertTrue();
      expect(repository.getReview(review.id)?.visibility).assertEqual('visible');
    });
    it('requires a locally available review source version', 0, () => {
      const draft = new Draft('draft-review', 'Review');
      draft.version = 2;
      draft.code = 'x';
      const payload = validReviewPayload();
      payload.draft_id = draft.id;
      payload.source_draft_version = 2;
      expect(reviewSourceMatchesDraft(payload, draft)).assertTrue();
      payload.source_draft_version = 1;
      expect(reviewSourceMatchesDraft(payload, draft, 'x')).assertTrue();
      expect(reviewSourceMatchesDraft(payload, draft)).assertFalse();
      payload.source_draft_version = 3;
      expect(reviewSourceMatchesDraft(payload, draft)).assertFalse();
    });
    it('rejects a review range outside the current source code', 0, () => {
      const draft = new Draft('draft-review', 'Review');
      draft.version = 2;
      draft.code = 'x';
      const payload = validReviewPayload();
      payload.draft_id = draft.id;
      const range = new SourceRangePayload();
      range.start_line = 1;
      range.start_char = 0;
      range.end_line = 1;
      range.end_char = 2;
      payload.diagnostics[0].range = range;
      expect(reviewSourceMatchesDraft(payload, draft)).assertFalse();
    });
    it('keeps the cursor on invalid review pull and recovers on retry', 0, async () => {
      const draft = new Draft('draft-review', 'Review');
      draft.version = 2;
      draft.code = 'x';
      const repository = new ReviewSyncTestRepository(draft);
      const payload = validReviewPayload();
      payload.draft_id = draft.id;
      payload.source_draft_version = 3;
      payload.last_modified_client_id = 'web-b';
      const transport = new ReviewSyncTestTransport(reviewPull(payload));
      const service = new PhoneSyncService(repository, transport);
      const first = await service.synchronize();
      expect(first.status === SyncRunStatus.FAILED).assertTrue();
      expect(repository.getCursor()).assertEqual('4');
      expect(repository.listReviews().length).assertEqual(0);

      payload.source_draft_version = 2;
      transport.nextPull = reviewPull(payload);
      const retry = await service.synchronize();
      expect(retry.status === SyncRunStatus.SYNCED).assertTrue();
      expect(repository.getCursor()).assertEqual('5');
      expect(repository.listReviews().length).assertEqual(1);
    });
    it('keeps the cursor when persisting a pulled review fails and recovers by replaying the batch', 0, async () => {
      const draft = new Draft('draft-review-persist', 'Review');
      draft.version = 2;
      draft.code = 'x';
      const repository = new ReviewSyncTestRepository(draft);
      repository.failNextFlush = true;
      const payload = validReviewPayload();
      payload.draft_id = draft.id;
      payload.last_modified_client_id = 'web-b';
      const transport = new ReviewSyncTestTransport(reviewPull(payload));
      const service = new PhoneSyncService(repository, transport);

      const first = await service.synchronize();
      expect(first.status === SyncRunStatus.FAILED).assertTrue();
      expect(repository.getCursor()).assertEqual('4');
      expect(repository.listReviews().length).assertEqual(1);

      const retry = await service.synchronize();
      expect(retry.status === SyncRunStatus.SYNCED).assertTrue();
      expect(repository.getCursor()).assertEqual('5');
      expect(repository.listReviews().length).assertEqual(1);
    });
    it('creates an independent review through the ViewModel and awaits local persistence', 0, async () => {
      const draft = new Draft('draft-view-model-review', 'Review');
      draft.version = 2;
      draft.code = 'x';
      draft.idea = 'Inspect x';
      draft.syncStatus = SyncStatus.SYNCED;
      const repository = new ReviewSyncTestRepository(draft);
      const gateway: ReviewGateway = async (baseUrl: string, request: ReviewRequestInput) => gatewayReview(request);
      const viewModel = new DraftWorkspaceViewModel(repository, repository, gateway, () => 'review-test-id');
      const review = await viewModel.generateReview(draft.id, 'http://gateway', AIMode.FAITHFUL_TRANSFORM, ReviewKind.RISK);
      expect(review.sourceDraftVersion).assertEqual(2);
      expect(repository.draftWriteCount).assertEqual(0);
      expect(repository.flushCount).assertEqual(1);
      expect(repository.listReviews().length).assertEqual(1);
      expect(repository.getDraft(draft.id)?.version).assertEqual(2);
    });
    it('rejects review creation when a Draft is unsynchronized', 0, async () => {
      const draft = new Draft('draft-view-model-unsynced', 'Review');
      draft.version = 2;
      draft.code = 'x';
      draft.syncStatus = SyncStatus.LOCAL_ONLY;
      const repository = new ReviewSyncTestRepository(draft);
      let gatewayCalls = 0;
      const gateway: ReviewGateway = async (baseUrl: string, request: ReviewRequestInput) => {
        gatewayCalls += 1;
        return gatewayReview(request);
      };
      const viewModel = new DraftWorkspaceViewModel(repository, repository, gateway, () => 'review-test-id');
      let rejected = false;
      try {
        await viewModel.generateReview(draft.id, 'http://gateway', AIMode.FAITHFUL_TRANSFORM, ReviewKind.RISK);
      } catch (error) {
        rejected = error instanceof Error && error.message === 'REVIEW_DRAFT_NOT_SYNCED';
      }
      expect(rejected).assertTrue();
      expect(gatewayCalls).assertEqual(0);
      expect(repository.listReviews().length).assertEqual(0);
    });
    it('does not save a review if its Draft changes while Gateway review is running', 0, async () => {
      const draft = new Draft('draft-view-model-race', 'Review');
      draft.version = 2;
      draft.code = 'x';
      draft.syncStatus = SyncStatus.SYNCED;
      const repository = new ReviewSyncTestRepository(draft);
      const gateway: ReviewGateway = async (baseUrl: string, request: ReviewRequestInput) => {
        draft.code = 'changed';
        draft.syncStatus = SyncStatus.LOCAL_ONLY;
        return gatewayReview(request);
      };
      const viewModel = new DraftWorkspaceViewModel(repository, repository, gateway, () => 'review-test-id');
      let rejected = false;
      try {
        await viewModel.generateReview(draft.id, 'http://gateway', AIMode.FAITHFUL_TRANSFORM, ReviewKind.RISK);
      } catch (error) {
        rejected = error instanceof Error && error.message === 'DRAFT_CHANGED_RETRY_REVIEW';
      }
      expect(rejected).assertTrue();
      expect(repository.listReviews().length).assertEqual(0);
      expect(repository.draftWriteCount).assertEqual(0);
    });
    it('reports a local persistence failure and allows a later flush retry', 0, async () => {
      const draft = new Draft('draft-view-model-persist-retry', 'Review');
      draft.version = 2;
      draft.code = 'x';
      draft.syncStatus = SyncStatus.SYNCED;
      const repository = new ReviewSyncTestRepository(draft);
      repository.failNextFlush = true;
      const gateway: ReviewGateway = async (baseUrl: string, request: ReviewRequestInput) => gatewayReview(request);
      const viewModel = new DraftWorkspaceViewModel(repository, repository, gateway, () => 'review-test-id');
      let rejected = false;
      try {
        await viewModel.generateReview(draft.id, 'http://gateway', AIMode.FAITHFUL_TRANSFORM, ReviewKind.RISK);
      } catch (error) {
        rejected = error instanceof Error && error.message === 'RDB_WRITE_FAILED';
      }
      expect(rejected).assertTrue();
      expect(repository.listReviews().length).assertEqual(1);
      await repository.flush();
      expect(repository.flushCount).assertEqual(2);
    });
  });
}

function gatewayReview(request: ReviewRequestInput): AIGatewayReviewPayload {
  const payload = new AIGatewayReviewPayload();
  payload.mode = request.mode;
  payload.source_draft_version = request.draft_version;
  payload.model_id = 'provider-review';
  payload.rule_version = request.rule_version;
  payload.review_kind = request.review_kind;
  payload.visibility = request.visibility;
  return payload;
}

function validReviewPayload(): ReviewResultPayload {
  const payload = new ReviewResultPayload();
  payload.id = 'review-1';
  payload.version = 0;
  payload.server_sequence = 0;
  payload.created_at = '2026-09-15T00:00:00.000Z';
  payload.updated_at = payload.created_at;
  payload.last_modified_client_id = 'phone-test';
  payload.draft_id = 'draft-review';
  payload.source_draft_version = 2;
  payload.model_id = 'provider-review';
  payload.rule_version = '1.0.0';
  const diagnostic = new ReviewDiagnosticPayload();
  diagnostic.id = 'diagnostic-1';
  diagnostic.level = 'warning';
  diagnostic.range = { start_line: 1, start_char: 0, end_line: 1, end_char: 1 };
  diagnostic.problem = 'Potential issue';
  diagnostic.basis = 'Provider review';
  diagnostic.suggestion = 'Check this line';
  payload.diagnostics.push(diagnostic);
  return payload;
}

function reviewPull(payload: ReviewResultPayload): PullResult {
  const result = new PullResult();
  const change = new PullChange();
  change.cursor = '5';
  change.entity_type = 'review_result';
  change.entity = payload;
  result.changes.push(change);
  result.next_cursor = '5';
  return result;
}

class ReviewSyncTestRepository implements DraftRepository, SyncRepository {
  private draft: Draft;
  private cursor: string = '4';
  private reviews: ReviewResult[] = [];
  draftWriteCount: number = 0;
  flushCount: number = 0;
  failNextFlush: boolean = false;

  constructor(draft: Draft) { this.draft = draft; }
  initialize(): Promise<void> { return Promise.resolve(); }
  list(): Draft[] { return [this.draft]; }
  get(id: string): Draft | undefined { return id === this.draft.id ? this.draft : undefined; }
  save(draft: Draft): void { this.draft = draft; this.draftWriteCount += 1; }
  delete(id: string): void {}
  async flush(): Promise<void> {
    this.flushCount += 1;
    if (this.failNextFlush) { this.failNextFlush = false; throw new Error('RDB_WRITE_FAILED'); }
  }
  getClientId(): string { return 'phone-test'; }
  getCursor(): string { return this.cursor; }
  async commitCursor(cursor: string): Promise<void> { await this.flush(); this.cursor = cursor; }
  getBaseUrl(): string { return ''; }
  setBaseUrl(baseUrl: string): void {}
  listPendingOperations(): SyncOperation[] { return []; }
  hasPendingOperation(entityType: string, entityId: string): boolean { return false; }
  removeOperation(operationId: string): void {}
  applyServerDraft(draft: Draft): void { this.draft = draft; }
  saveConflictDraft(draft: Draft, record: ConflictRecord): void {}
  saveConflictArtifact(artifact: AIArtifact, record: ConflictRecord): void {}
  saveConflictReview(review: ReviewResult, record: ConflictRecord): void {}
  listConflicts(): ConflictRecord[] { return []; }
  setDraftSyncStatus(id: string, status: SyncStatus): void {}
  getDraft(id: string): Draft | undefined { return id === this.draft.id ? this.draft : undefined; }
  getDraftSourceCode(draftId: string, version: number): string | undefined {
    return draftId === this.draft.id && version === this.draft.version ? this.draft.code : undefined;
  }
  listArtifacts(): AIArtifact[] { return []; }
  getArtifact(id: string): AIArtifact | undefined { return undefined; }
  saveArtifact(artifact: AIArtifact): void {}
  applyServerArtifact(payload: AIArtifactPayload): void {}
  listReviews(): ReviewResult[] { return this.reviews; }
  getReview(id: string): ReviewResult | undefined { return this.reviews.find((review: ReviewResult) => review.id === id); }
  saveReview(review: ReviewResult): void { this.reviews.push(review); }
  applyServerReview(payload: ReviewResultPayload): void {
    const review = payloadToReview(payload);
    if (review !== undefined) this.reviews = this.reviews.filter((item) => item.id !== review.id).concat(review);
  }
  resolveReviewConflict(conflictId: string, resolution: string): void {}
}

class ReviewSyncTestTransport implements SyncTransport {
  nextPull: PullResult;

  constructor(nextPull: PullResult) { this.nextPull = nextPull; }
  async push(operation: SyncOperation): Promise<PushResult> { throw new Error('unexpected push'); }
  async pull(cursor: string): Promise<PullResult> { return this.nextPull; }
}

class FakeAIHttpRequest implements AIHttpRequestHandle {
  private requestHandler: (url: string, options: http.HttpRequestOptions) => Promise<http.HttpResponse>;
  private destroyHandler: () => void;

  constructor(requestHandler: (url: string, options: http.HttpRequestOptions) => Promise<http.HttpResponse>, destroyHandler: () => void) {
    this.requestHandler = requestHandler;
    this.destroyHandler = destroyHandler;
  }

  request(url: string, options: http.HttpRequestOptions): Promise<http.HttpResponse> {
    return this.requestHandler(url, options);
  }

  destroy(): void {
    this.destroyHandler();
  }
}
