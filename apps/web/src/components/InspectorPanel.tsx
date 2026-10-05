import { Icon } from './Icon';
import type { ReviewIssue } from '../code-review';
import type { AIArtifact, ReviewKind, ReviewResult } from '../types';

interface InspectorPanelProps {
  hidden: boolean;
  onHide: () => void;
  onShow: () => void;
  issues: ReviewIssue[];
  onJumpToLine: (line: number) => void;
  artifact?: AIArtifact;
  onToggleArtifact: () => void;
  review?: ReviewResult;
  reviewSourceAvailable: boolean;
  reviewStale: boolean;
  reviewHistory: ReviewResult[];
  onReviewSelect: (id: string) => void;
  reviewKind: ReviewKind;
  reviewBusy: boolean;
  aiRequestBusy: boolean;
  onReviewKindChange: (kind: ReviewKind) => void;
  onSaveReview: () => void;
  onCancelAI: () => void;
  onToggleReview: () => void;
}

const reviewKinds: Array<{ id: ReviewKind; label: string }> = [
  { id: 'explanation', label: '说明' },
  { id: 'risk', label: '风险' },
  { id: 'complexity', label: '复杂度' },
];

export function InspectorPanel({ hidden, onHide, onShow, issues, onJumpToLine, artifact, onToggleArtifact, review, reviewSourceAvailable, reviewStale, reviewHistory, onReviewSelect, reviewKind, reviewBusy, aiRequestBusy, onReviewKindChange, onSaveReview, onCancelAI, onToggleReview }: InspectorPanelProps) {
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
        <section className="inspect-section ai-artifact-result">
          <div className="inspect-title"><span>{reviewKindLabel(reviewKind)}审查结果</span><span>{review ? `v${review.version}` : '暂无'}</span></div>
          <div className="review-kind-selector" aria-label="审查类型">
            {reviewKinds.map((kind) => <button key={kind.id} type="button" className={kind.id === reviewKind ? 'review-kind active' : 'review-kind'} aria-pressed={kind.id === reviewKind} onClick={() => onReviewKindChange(kind.id)}>{kind.label}</button>)}
          </div>
          {reviewHistory.length > 1 && (
            <select className="review-history-select" aria-label="审查历史" value={review?.id ?? ''} onChange={(event) => onReviewSelect(event.target.value)}>
              {reviewHistory.map((item) => <option key={item.id} value={item.id}>草稿 v{item.source_draft_version}{item.freshness === 'stale' ? ' · 已过期' : ''} · {item.updated_at.slice(0, 10)}</option>)}
            </select>
          )}
          {review && reviewStale && <p className="warning-text">该结果来自草稿 v{review.source_draft_version}，当前草稿已变化；结果已过期，仅作为只读历史记录。</p>}
          {review && !reviewSourceAvailable && <p className="warning-text">草稿 v{review.source_draft_version} 的本地源码快照不可用，无法定位诊断行。</p>}
          {review ? reviewStale ? review.diagnostics.length ? <ol>{review.diagnostics.map((item) => <li key={item.id}><strong>{item.level}</strong> <span>{formatRange(item.range)}</span> {item.problem}<small>依据：{item.basis} 建议：{item.suggestion}</small></li>)}</ol> : <p>该历史版本未发现规则问题。</p> : review.visibility === 'hidden' ? <p>审查结果已隐藏。<button type="button" className="quiet-button" disabled={!reviewSourceAvailable} onClick={onToggleReview}>显示</button></p> : review.diagnostics.length ? <ol>{review.diagnostics.map((item) => <li key={item.id}><strong>{item.level}</strong> <span>{formatRange(item.range)}</span> {item.problem}<small>依据：{item.basis} 建议：{item.suggestion}</small></li>)}</ol> : <p>当前代码未发现规则问题。</p> : <p>尚未保存独立审查结果。</p>}
          <button type="button" className="outline-button" disabled={aiRequestBusy} onClick={onSaveReview}>{reviewBusy ? 'AI 正在审查…' : '请求 AI 审查'}</button>
          {aiRequestBusy && <button type="button" className="quiet-button" onClick={onCancelAI}>取消 AI 请求</button>}
          {review && !reviewStale && review.visibility === 'visible' && <button type="button" className="quiet-button" disabled={!reviewSourceAvailable} onClick={onToggleReview}>隐藏结果</button>}
        </section>
        <section className="inspect-section ai-artifact-result">
          <div className="inspect-title"><span>忠实转换结果</span><span>{artifact ? `v${artifact.version}` : '暂无'}</span></div>
          {artifact ? (
            artifact.visibility === 'hidden' ? <p>结果已隐藏，记录仍已保存并同步。<button type="button" className="quiet-button" onClick={onToggleArtifact}>显示</button></p> : (
              <ol>{artifact.pseudocode.map((step) => <li key={step.id}>{step.step}<small>{step.source_refs.join(', ')}</small></li>)}</ol>
            )
          ) : <p>当前草稿暂无已保存的忠实转换结果。</p>}
          {artifact && artifact.visibility === 'visible' && <button type="button" className="quiet-button" onClick={onToggleArtifact}>隐藏结果</button>}
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

function reviewKindLabel(kind: ReviewKind): string {
  if (kind === 'explanation') return '说明';
  if (kind === 'complexity') return '复杂度';
  return '风险';
}

function formatRange(range: ReviewResult['diagnostics'][number]['range']): string {
  if (range === null) return '全局';
  return `第 ${range.start_line}:${range.start_char}-${range.end_line}:${range.end_char} 行`;
}
