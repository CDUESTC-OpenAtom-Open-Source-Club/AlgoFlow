import { AIErrorCode, AIRequest, AIResult, AIMode } from '../domain/Models';
import { AIProvider } from '../domain/AIProvider';
import { AIResultRepository, IDECapability, IDEContext, IDEProvider, IDERecord, IDEResult, IDEState,
  ReviewKind, SourceCursor, buildIDERequest } from '../domain/IDEAIModels';
import { parseIDEResult, rangeOffsets } from '../domain/IDEAIContract';

export class IDEAISession {
  records: IDERecord[] = [];
  storageError: string = '';
  onChange: () => void = () => {};
  private provider: IDEProvider;
  private repository: AIResultRepository;
  private context: IDEContext | null = null;
  private generation: number = 0;
  private sequence: number = 0;
  private writes: Promise<void> = Promise.resolve();
  private acceptedBefore: string = '';
  private acceptedAfter: string = '';
  private acceptedContext: string = '';

  constructor(provider: IDEProvider, repository: AIResultRepository) {
    this.provider = provider; this.repository = repository;
  }
  static async requestTransform(provider: AIProvider, request: AIRequest): Promise<AIResult> {
    try {
      return await provider.generate(request);
    } catch (error) {
      return AIResult.failure(AIErrorCode.AI_PROVIDER_ERROR, 'AI 服务异常，请主动重试');
    }
  }
  setProvider(provider: IDEProvider): void { this.cancel(); this.provider = provider; }
  async setContext(context: IDEContext): Promise<void> {
    if (JSON.stringify(context) === JSON.stringify(this.context)) return;
    const previous = this.context;
    this.cancel(); this.context = JSON.parse(JSON.stringify(context)) as IDEContext;
    if (previous === null || previous.draftId !== context.draftId || previous.mode !== context.mode) {
      this.records = []; const generation = this.generation;
      try {
        await this.writes;
        const records = await this.repository.list(context.draftId, context.mode);
        if (generation === this.generation) this.records = records;
      } catch (error) { if (generation === this.generation) this.storageError = 'AI 本地结果读取失败，请重试；工作区未清空'; }
    }
    this.onChange();
  }
  cancel(): void {
    this.generation++; this.provider.cancel(); this.acceptedContext = '';
    this.records.forEach(record => {
      record.stale = true;
      if (record.state === IDEState.LOADING) { record.state = IDEState.CANCELLED; record.message = '请求已取消'; }
      this.persist(record, false);
    }); this.onChange();
  }
  dispose(): void { this.cancel(); this.context = null; this.onChange = () => {}; }
  async request(capability: IDECapability, kind: ReviewKind = ReviewKind.EXPLANATION, cursor: SourceCursor = new SourceCursor()): Promise<void> {
    if (this.context === null) return;
    this.cancel();
    const record = new IDERecord(); record.id = `ai-${Date.now()}-${++this.sequence}`;
    record.context = JSON.parse(JSON.stringify(this.context)) as IDEContext;
    record.capability = capability; record.reviewKind = kind; record.cursor = cursor;
    record.generation = this.generation; record.updatedAt = new Date().toISOString();
    this.records = capability === IDECapability.REVIEW ? this.records.concat([record]) : this.records.filter(item => item.capability !== capability).concat([record]);
    this.persist(record, true);
    this.onChange();
    try {
      if (record.context.mode !== AIMode.FAITHFUL_TRANSFORM) throw new Error('AI_MODE_NOT_AVAILABLE');
      if (record.context.segments.length === 0 || record.context.problemContext.trim().length === 0 ||
        (capability !== IDECapability.TRANSFORM && (record.context.file !== 'main.cpp' || record.context.code.trim().length === 0))) throw new Error('INVALID_REQUEST');
      const reply = await this.provider.request(buildIDERequest(record), capability);
      if (record.generation !== this.generation || this.context === null) return;
      record.isTestData = reply.isTestData;
      if (reply.errorCode.length > 0) { record.errorCode = reply.errorCode; record.message = reply.message; record.state = IDEState.ERROR; }
      else {
        try { parseIDEResult(reply.body, record); }
        catch (error) { throw new Error('INVALID_AI_ARTIFACT'); }
        record.body = reply.body; record.state = IDEState.SUCCESS;
      }
    } catch (error) {
      if (record.generation !== this.generation) return;
      const reason = error instanceof Error ? error.message : '';
      record.errorCode = ['AI_MODE_NOT_AVAILABLE', 'INVALID_REQUEST', 'INVALID_AI_ARTIFACT'].includes(reason) ? reason : 'AI_PROVIDER_ERROR';
      record.message = record.errorCode === 'AI_MODE_NOT_AVAILABLE' ? '当前模式尚未接入' :
        record.errorCode === 'INVALID_REQUEST' ? '请填写思路和代码，并切换到 main.cpp' : record.errorCode === 'AI_PROVIDER_ERROR' ? 'AI 服务异常，请主动重试' : 'AI 产物格式、来源或范围无效，已拒绝使用';
      record.state = IDEState.ERROR;
    }
    if (record.generation === this.generation) {
      record.updatedAt = new Date().toISOString(); this.persist(record, true); this.onChange();
    }
  }
  result(record: IDERecord): IDEResult | null {
    try { return record.body.length > 0 ? parseIDEResult(record.body, record) : null; } catch (error) { return null; }
  }
  setHidden(id: string, hidden: boolean): void {
    const record = this.records.find(item => item.id === id); if (record === undefined) return;
    record.hidden = hidden; this.persist(record, false); this.onChange();
  }
  reject(id: string): void {
    const record = this.records.find(item => item.id === id);
    if (record === undefined || record.state !== IDEState.SUCCESS || record.capability !== IDECapability.COMPLETION) return;
    record.state = IDEState.REJECTED; this.persist(record, false); this.onChange();
  }
  canAccept(record: IDERecord): boolean {
    return record.capability === IDECapability.COMPLETION && record.state === IDEState.SUCCESS && !record.stale && !record.hidden &&
      record.generation === this.generation && record.context.file === 'main.cpp' && JSON.stringify(record.context) === JSON.stringify(this.context);
  }
  accept(id: string, apply: (code: string) => void): boolean {
    const record = this.records.find(item => item.id === id);
    if (record === undefined || !this.canAccept(record)) return false;
    const result = this.result(record); if (result === null) return false;
    const offsets = rangeOffsets(record.context.code, result.range);
    const separator = record.context.code.includes('\r\n') ? '\r\n' : '\n';
    const insert = result.suggestion.split(/\r\n|\n|\r/).join(separator);
    const next = record.context.code.substring(0, offsets[0]) + insert + record.context.code.substring(offsets[1]);
    apply(next); // ordinary edit updates context and invalidates pending AI synchronously
    record.state = IDEState.ACCEPTED; record.stale = true;
    this.acceptedBefore = record.context.code; this.acceptedAfter = next;
    this.acceptedContext = JSON.stringify(this.context);
    this.persist(record, false); this.onChange(); return true;
  }
  canWithdraw(): boolean { return this.acceptedContext.length > 0 && this.acceptedContext === JSON.stringify(this.context) && this.context?.code === this.acceptedAfter; }
  withdraw(apply: (code: string) => void): boolean {
    if (!this.canWithdraw()) return false;
    const before = this.acceptedBefore; this.acceptedContext = ''; apply(before); this.onChange(); return true;
  }
  async removeDraft(id: string): Promise<void> {
    if (this.context?.draftId === id) { this.cancel(); this.context = null; this.records = []; }
    await this.writes;
    try { await this.repository.removeDraft(id); } catch (error) { this.storageError = 'AI 结果清理失败，可重试'; }
    this.onChange();
  }
  async retryStorage(): Promise<void> {
    this.storageError = '';
    if (this.context === null) return;
    if (this.records.length === 0) {
      const generation = this.generation;
      try {
        const records = await this.repository.list(this.context.draftId, this.context.mode);
        if (generation !== this.generation) return;
        this.records = records;
      }
      catch (error) { this.storageError = 'AI 缓存仍不可读取，请保留原数据'; }
    }
    for (let index = 0; index < this.records.length; index++) {
      const record = this.records[index];
      if ([IDEState.LOADING, IDEState.CANCELLED].includes(record.state)) continue;
      if (this.records.slice(index + 1).some(item => item.capability === record.capability && item.reviewKind === record.reviewKind && item.isTestData === record.isTestData)) continue;
      this.persist(record, true);
    }
    await this.writes; this.onChange();
  }
  private persist(record: IDERecord, latest: boolean): void {
    const copy = JSON.parse(JSON.stringify(record)) as IDERecord;
    this.writes = this.writes.then(async () => {
      try { await this.repository.save(copy, latest); }
      catch (error) { this.storageError = 'AI 本地结果保存失败，请检查空间后重试；源文件未清空'; this.onChange(); }
    });
  }
}
