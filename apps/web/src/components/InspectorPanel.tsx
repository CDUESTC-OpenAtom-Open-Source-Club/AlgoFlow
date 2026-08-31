import { Icon } from './Icon';
import type { ReviewIssue } from '../code-review';

interface InspectorPanelProps {
  hidden: boolean;
  onHide: () => void;
  onShow: () => void;
  issues: ReviewIssue[];
  onJumpToLine: (line: number) => void;
}

export function InspectorPanel({ hidden, onHide, onShow, issues, onJumpToLine }: InspectorPanelProps) {
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
