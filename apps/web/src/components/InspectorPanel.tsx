import { Icon } from './Icon';
import type { ReviewIssue } from '../code-review';
import { rangeToOffsets } from '../ai-client.mjs';
import type { AIResultRecord, AISessionState, FileId, IdeaSegment, Mode, ReviewKind } from '../types';

interface InspectorPanelProps {
  hidden: boolean;
  onHide: () => void;
  onShow: () => void;
  issues: ReviewIssue[];
  onJumpToLine: (line: number) => void;
  aiState: AISessionState;
  mode: Mode;
  activeFile: FileId;
  canAcceptCompletion: boolean;
  onReview: (kind: ReviewKind) => void;
  onCompletion: () => void;
  onAcceptCompletion: () => void;
  onRejectCompletion: () => void;
  onCancel: () => void;
  onToggleResult: (id: string, hidden: boolean) => void;
  onRetryStorage: () => void;
}

export function InspectorPanel({
  hidden, onHide, onShow, issues, onJumpToLine, aiState, mode, activeFile, canAcceptCompletion,
  onReview, onCompletion, onAcceptCompletion, onRejectCompletion, onCancel, onToggleResult, onRetryStorage,
}: InspectorPanelProps) {
  const errors = issues.filter((issue) => issue.severity === 'error').length;
  const canRequest = mode === 'faithful_transform' && activeFile === 'main.cpp';
  const loading = aiState.reviews.some(record => record.state === 'loading') || aiState.completion?.state === 'loading';
  const completion = aiState.completion;
  return (
    <>
      <aside className={hidden ? 'inspector hidden' : 'inspector'} aria-label="AI 检查侧栏">
        <div className="inspector-heading">
          <div>
            <span className="eyebrow">INSPECTOR</span>
            <h2>思路检查</h2>
          </div>
          <button type="button" className="quiet-button" aria-label="收起思路检查" onClick={onHide}>
            <Icon name="cross" />
          </button>
        </div>
        <div className="check-state">
          <span className={errors ? 'check-symbol warning' : 'check-symbol'}>{errors ? '!' : '✓'}</span>
          <div>
            <strong>{errors ? `${errors} 个基础问题` : '基础检查通过'}</strong>
            <p>{issues.length ? issues.map((issue) => <button key={`${issue.line}-${issue.message}`} type="button" className="issue-link" onClick={() => onJumpToLine(issue.line)}>第 {issue.line} 行：{issue.message}</button>) : '未发现括号、入口或头文件基础问题。'}</p>
          </div>
        </div>
        <SourceTrack segments={aiState.segments} />
        {aiState.storageError && (
          <div className="ai-error" role="alert">
            <p>{aiState.storageError}</p>
            <button type="button" className="outline-button" onClick={onRetryStorage}>重试本地存储</button>
          </div>
        )}
        <section className="inspect-section ai-review-chat">
          <div className="inspect-title"><span>AI 审查会话</span><span>仅本地</span></div>
          <p className="ai-help">只分析当前代码和思路，不写入代码。会话追加消息；刷新后每类仅恢复最近结果。</p>
          {!canRequest && <p role="status" className="ai-help">{mode !== 'faithful_transform' ? '当前模式尚未接入，请选择忠实转换。' : '请切换到 main.cpp 再请求 AI。'}</p>}
          <div className="review-actions">
            {(['explanation', 'risk', 'complexity'] as ReviewKind[]).map((kind) => (
              <button key={kind} type="button" className="outline-button" onClick={() => onReview(kind)} disabled={!canRequest}>
                {reviewLabel(kind)}审查
              </button>
            ))}
            {loading && <button type="button" className="outline-button" onClick={onCancel}>取消 AI 请求</button>}
          </div>
          <div className="ai-chat-log" role="log" aria-label="审查消息" aria-live="polite">
            {aiState.reviews.map(record => (
              <article className={record.stale ? 'ai-result stale' : 'ai-result'} key={record.id} aria-label={`${reviewLabel(record.reviewKind ?? 'explanation')}审查消息`}>
                <ResultHeading record={record} title={`${reviewLabel(record.reviewKind ?? 'explanation')}审查`} onToggle={onToggleResult} />
                {!record.hidden && <>
                  <ResultStatus record={record} />
                  {record.result?.output_kind === 'review' && (
                    record.result.diagnostics.length === 0 ? <p>本次返回空诊断，不代表算法已验证正确。</p> :
                      record.result.diagnostics.map(diagnostic => (
                        <div className="ai-diagnostic" key={diagnostic.id}>
                          <strong>{levelLabel(diagnostic.level)} · {diagnostic.problem}</strong>
                          <p>依据：{diagnostic.basis}</p>
                          <p>建议：{diagnostic.suggestion}</p>
                          {diagnostic.range ? (
                            <button type="button" className="issue-link" disabled={record.stale || activeFile !== 'main.cpp'}
                              onClick={() => onJumpToLine(diagnostic.range?.start_line ?? 1)}>
                              第 {diagnostic.range.start_line} 行，第 {diagnostic.range.start_char + 1} 列
                            </button>
                          ) : <small>全局建议</small>}
                        </div>
                      ))
                  )}
                </>}
              </article>
            ))}
          </div>
        </section>
        <section className="inspect-section completion-section">
          <div className="inspect-title"><span>忠实模式局部补全</span><span>预览后写入</span></div>
          <p className="ai-help">仅补充当前思路。接受后仍需保存，不自动上传。</p>
          <button type="button" className="outline-button" onClick={onCompletion} disabled={!canRequest}>请求局部补全</button>
          {completion && (
            <article className={completion.stale ? 'ai-result stale' : 'ai-result'} aria-label="补全结果">
              <ResultHeading record={completion} title="补全预览" onToggle={onToggleResult} />
              {!completion.hidden && <>
                <ResultStatus record={completion} />
                {completion.result?.output_kind === 'completion' && <>
                  <p>替换范围：{completion.result.replaced_range.start_line}:{completion.result.replaced_range.start_char + 1}
                    {' → '}{completion.result.replaced_range.end_line}:{completion.result.replaced_range.end_char + 1}（列从 1 开始）</p>
                  <p>替换前</p>
                  <pre aria-label="替换前代码">{originalFragment(completion) || '（光标处插入，不删除原文）'}</pre>
                  <p>建议片段</p>
                  <pre aria-label="建议代码">{completion.result.suggestion_text}</pre>
                  <div className="review-actions">
                    <button type="button" className="outline-button" disabled={!canAcceptCompletion} onClick={onAcceptCompletion}>接受并写入 main.cpp</button>
                    <button type="button" className="outline-button" disabled={completion.state !== 'success'} onClick={onRejectCompletion}>拒绝补全</button>
                  </div>
                </>}
              </>}
            </article>
          )}
        </section>
      </aside>
      {hidden && (
        <button
          className="restore-inspector"
          type="button"
          aria-label="显示思路检查侧栏"
          aria-expanded="false"
          onClick={onShow}
        >
          显示检查侧栏
        </button>
      )}
    </>
  );
}

function reviewLabel(kind: ReviewKind): string {
  return ({ explanation: '解释', risk: '风险', complexity: '复杂度' })[kind];
}

function levelLabel(level: 'info' | 'warning' | 'error' | 'hint'): string {
  return { info: '信息', warning: '警告', error: '错误', hint: '提示' }[level];
}

function ResultHeading({ record, title, onToggle }: { record: AIResultRecord; title: string; onToggle: (id: string, hidden: boolean) => void }) {
  return (
    <div className="ai-result-heading">
      <strong>{title}</strong>
      {record.isTestData && <span className="test-data-badge">测试数据</span>}
      {record.state !== 'loading' && <button type="button" className="quiet-button" onClick={() => onToggle(record.id, !record.hidden)}>{record.hidden ? '显示结果' : '隐藏结果'}</button>}
    </div>
  );
}

function ResultStatus({ record }: { record: AIResultRecord }) {
  return (
    <>
      <p className="ai-provenance">草稿 v{record.sourceDraftVersion} · {record.sourceFile} · {record.mode}</p>
      {record.result && <p className="ai-provenance">模型 {record.result.model_id} · 规则 {record.result.rule_version}</p>}
      {record.state === 'loading' && <p role="status">正在请求 AI…</p>}
      {record.errorMessage && <p className="ai-error" role="status">{record.errorMessage}</p>}
      {record.state === 'accepted' ? <p>已接受，可在编辑器中撤销；尚需手动保存。</p> :
        record.state === 'rejected' ? <p>已拒绝，未修改代码。</p> :
          record.stale && record.result && <p>来源或请求代次已过期，仅供查看，不能接受补全。</p>}
    </>
  );
}

function originalFragment(record: AIResultRecord): string {
  if (record.result?.output_kind !== 'completion') return '';
  try {
    const { from, to } = rangeToOffsets(record.sourceCode, record.result.replaced_range);
    return record.sourceCode.slice(from, to);
  } catch { return '旧结果范围不可验证，请重新请求。'; }
}

function SourceTrack({ segments }: { segments: IdeaSegment[] }) {
  return (
    <section className="inspect-section">
      <div className="inspect-title">
        <span>来源轨道</span>
        <span>{segments.length} 片段</span>
      </div>
      <div className="track">
        {segments.map((segment, index) => (
          <div key={segment.id}><span>{index + 1}</span><p>{segment.content}</p><small className="ai-provenance">{segment.id}</small></div>
        ))}
        {segments.length === 0 && <p>请在 idea.md 中填写思路。</p>}
      </div>
    </section>
  );
}
