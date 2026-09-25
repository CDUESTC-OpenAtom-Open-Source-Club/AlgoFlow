import { Icon } from './Icon';
import type { ReviewIssue } from '../code-review';
import type { AICompletionResult, AIRequestState, AIReviewDiagnostic, ReviewKind } from '../types';

interface InspectorPanelProps {
  hidden: boolean;
  onHide: () => void;
  onShow: () => void;
  issues: ReviewIssue[];
  onJumpToLine: (line: number) => void;
  reviewState: Record<ReviewKind, AIRequestState>;
  reviewMessages: Array<{ kind: ReviewKind; diagnostics: AIReviewDiagnostic[]; isTestData: boolean; stale: boolean }>;
  completion: { result: AICompletionResult; isTestData: boolean; stale: boolean } | null;
  completionState: AIRequestState;
  onReview: (kind: ReviewKind) => void;
  onCompletion: () => void;
  onAcceptCompletion: () => void;
  onHideAI: (kind: ReviewKind) => void;
  errorMessages: string[];
}

export function InspectorPanel({ hidden, onHide, onShow, issues, onJumpToLine, reviewState, reviewMessages, completion, completionState, onReview, onCompletion, onAcceptCompletion, onHideAI, errorMessages }: InspectorPanelProps) {
  const errors = issues.filter((issue) => issue.severity === 'error').length;
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
        <SourceTrack />
        <section className="inspect-section ai-review-chat">
          <div className="inspect-title"><span>AI 审查会话</span><span>仅本地</span></div>
          <div className="review-actions">
            {(['explanation', 'risk', 'complexity'] as ReviewKind[]).map((kind) => (
              <button key={kind} type="button" className="outline-button" onClick={() => onReview(kind)} disabled={reviewState[kind] === 'loading'}>
                {reviewLabel(kind)}{reviewState[kind] === 'loading' ? '…' : ''}
              </button>
            ))}
          </div>
          {errorMessages.map((message, index) => <div className="ai-error" role="status" key={`${index}-${message}`}>{message}</div>)}
          {reviewMessages.map((message) => (
            <div className={message.stale ? 'ai-result stale' : 'ai-result'} key={message.kind}>
              <div className="ai-result-heading"><strong>{reviewLabel(message.kind)}</strong>{message.isTestData && <span className="test-data-badge">测试数据</span>}<button type="button" className="quiet-button" onClick={() => onHideAI(message.kind)}>隐藏</button></div>
              {message.stale && <small>来源已过期，仅供查看</small>}
              {message.diagnostics.length === 0 ? <p>未返回诊断。</p> : message.diagnostics.map((diagnostic) => <div className="ai-diagnostic" key={diagnostic.id}><strong>{diagnostic.problem}</strong><p>{diagnostic.basis}</p><p>{diagnostic.suggestion}</p>{diagnostic.range ? <button type="button" className="issue-link" onClick={() => onJumpToLine(diagnostic.range?.start_line ?? 1)}>跳转到第 {diagnostic.range.start_line} 行</button> : <small>全局建议</small>}</div>)}
            </div>
          ))}
        </section>
        <section className="inspect-section completion-section">
          <div className="inspect-title"><span>局部补全</span><span>预览后写入</span></div>
          <button type="button" className="outline-button" onClick={onCompletion} disabled={completionState === 'loading'}>请求局部补全{completionState === 'loading' ? '…' : ''}</button>
          {completion && <div className={completion.stale ? 'ai-result stale' : 'ai-result'}><div className="ai-result-heading"><strong>补全预览</strong>{completion.isTestData && <span className="test-data-badge">测试数据</span>}</div><p>范围：第 {completion.result.replaced_range.start_line} 行至第 {completion.result.replaced_range.end_line} 行</p><pre>{completion.result.suggestion_text}</pre>{completion.stale ? <small>来源已过期，不能接受</small> : <button type="button" className="outline-button" onClick={onAcceptCompletion}>接受并写入 main.cpp</button>}</div>}
        </section>
        <section className="inspect-section">
          <div className="inspect-title">
            <span>待补信息</span>
            <span className="warning-text">1 项</span>
          </div>
          <div className="warning-card">
            <strong>相等端点如何处理？</strong>
            <p>在 `interval.first &gt;= lastEnd` 中已暂按闭区间处理。</p>
          </div>
        </section>
        <section className="inspect-section rewrite-card">
          <div className="inspect-title">
            <span>我的独立复写</span>
            <button type="button" className="quiet-button">打开</button>
          </div>
          <p>隐藏 AI 结果后，在独立版本中继续验证。</p>
          <button type="button" className="outline-button">进入复写</button>
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

function SourceTrack() {
  return (
    <section className="inspect-section">
      <div className="inspect-title">
        <span>来源轨道</span>
        <span>2 片段</span>
      </div>
      <div className="track">
        <div><span>01</span><p>按右端点排序</p></div>
        <div><span>02</span><p>选择不冲突区间</p></div>
      </div>
    </section>
  );
}
