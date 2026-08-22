import { Icon } from './Icon';

interface InspectorPanelProps {
  hidden: boolean;
  onHide: () => void;
  onShow: () => void;
}

export function InspectorPanel({ hidden, onHide, onShow }: InspectorPanelProps) {
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
          <span className="check-symbol">✓</span>
          <div>
            <strong>结构已保留</strong>
            <p>当前代码仍对应你的 2 个思路片段。</p>
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
