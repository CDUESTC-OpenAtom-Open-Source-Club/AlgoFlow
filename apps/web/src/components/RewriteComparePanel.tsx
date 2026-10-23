import { useMemo } from 'react';
import { compareRewrite, compareSourceFromArtifact } from '../rewrite-compare.mjs';
import type { AIArtifact, RewriteDiffLine, RewriteLineMapping, RewriteMappingState, RewriteStepStatus } from '../types';

interface RewriteComparePanelProps {
  /** Newest code_snippet artifact of the current draft and mode, or null. */
  artifact: AIArtifact | null;
  draftVersion: number;
  rewrite: string;
  mapping: RewriteMappingState;
  selection: { start: number; end: number };
  /** The user chose to look at a hidden AI result; session-only, never synced. */
  revealed: boolean;
  onReveal: () => void;
  onAssign: (stepId: string | null) => void;
  onConfirm: () => void;
  onClear: () => void;
  onClose: () => void;
}

const statusLabels: Record<RewriteStepStatus, string> = {
  same: '一致',
  different: '有差异',
  missing: '遗漏',
  no_ai_code: 'AI 无代码',
};

export function RewriteComparePanel({
  artifact, draftVersion, rewrite, mapping, selection, revealed,
  onReveal, onAssign, onConfirm, onClear, onClose,
}: RewriteComparePanelProps) {
  const source = useMemo(() => artifact ? compareSourceFromArtifact(artifact) : null, [artifact]);
  const hidden = artifact?.visibility === 'hidden' && !revealed;
  const outdated = mapping.status === 'outdated';
  const comparison = useMemo(() => source && !hidden && !outdated ? compareRewrite(source, rewrite, mapping.mappings) : null,
    [source, hidden, outdated, rewrite, mapping.mappings]);

  return (
    <aside className="rewrite-compare" aria-label="复写对比">
      <div className="rewrite-compare-heading">
        <strong>复写对比</strong>
        <button type="button" className="quiet-button" onClick={onClose}>关闭</button>
      </div>
      {!artifact || !source ? (
        <p className="rewrite-compare-note">
          当前模式还没有 AI 代码片段。在检查侧栏把输出切到“代码片段”，请求忠实转换后再来对比。伪代码结果不参与对比。
        </p>
      ) : <>
        <p className="rewrite-compare-note">
          AI 片段基于草稿 v{artifact.source_draft_version}{artifact.source_draft_version !== draftVersion && `（当前 v${draftVersion}）`}
          {' · '}{artifact.mode}
        </p>
        <p className="rewrite-compare-note">划分只保存在本机，不同步到其他设备。</p>
        {outdated && (
          <div className="rewrite-compare-warning" role="status">
            <p>rewrite.cpp 在划分后改过，原有行号可能错位。核对下面的行范围后确认，或清空重新划分。</p>
            <div className="rewrite-compare-actions">
              <button type="button" className="outline-button" onClick={onConfirm}>划分仍然有效</button>
              <button type="button" className="outline-button" onClick={onClear}>清空划分</button>
            </div>
          </div>
        )}
        <section className="rewrite-compare-assign" aria-label="划分复写行">
          <p>选中复写的第 {selection.start}{selection.end !== selection.start && `–${selection.end}`} 行，归到：</p>
          <div className="rewrite-compare-actions">
            {source.steps.map((step, index) => (
              <button key={step.id} type="button" className="outline-button" disabled={outdated}
                title={hidden ? undefined : step.step} onClick={() => onAssign(step.id)}>
                步骤 {index + 1}
              </button>
            ))}
            <button type="button" className="outline-button" disabled={outdated} onClick={() => onAssign(null)}>移出步骤</button>
          </div>
        </section>
        {hidden ? (
          <div className="rewrite-compare-hidden">
            <p>AI 结果已隐藏。划分时只显示步骤编号，不显示步骤内容和 AI 代码。</p>
            <ol>
              {source.steps.map((step, index) => (
                <li key={step.id}>步骤 {index + 1}：复写 {rangeText(mapping.mappings, step.id)}</li>
              ))}
            </ol>
            <button type="button" className="outline-button" onClick={onReveal}>开始对比</button>
            <p className="rewrite-compare-note">开始对比只在本页显示 AI 内容，不会改变结果的隐藏状态。</p>
          </div>
        ) : outdated ? (
          <ol className="rewrite-compare-hidden">
            {source.steps.map((step, index) => (
              <li key={step.id}>步骤 {index + 1}：{step.step} · 复写 {rangeText(mapping.mappings, step.id)}</li>
            ))}
          </ol>
        ) : comparison && <>
          <p className="rewrite-compare-summary" role="status">
            {(Object.keys(statusLabels) as RewriteStepStatus[]).map(status => `${statusLabels[status]} ${comparison.summary[status]}`).join(' · ')}
          </p>
          {comparison.steps.map(step => (
            <article key={step.step_id} className={`rewrite-step ${step.status}`}>
              <div className="rewrite-step-heading">
                <strong>步骤 {step.index}</strong>
                <span className="rewrite-step-status">{statusLabels[step.status]}</span>
              </div>
              <p>{source.steps[step.index - 1]?.step}</p>
              <p className="rewrite-compare-note">AI {linesText(step.ai_lines)} · 复写 {linesText(step.rewrite_lines)}</p>
              {step.diff.length > 0 && <DiffBlock lines={step.diff} />}
            </article>
          ))}
          {comparison.ai_unmapped.length > 0 && (
            <section className="rewrite-extra">
              <strong>AI 片段中未映射到步骤的行</strong>
              <DiffBlock lines={comparison.ai_unmapped.map(line => ({ op: 'ai_only', ai_line: line.line, rewrite_line: null, text: line.text }))} />
            </section>
          )}
          {comparison.rewrite_extra.length > 0 && (
            <section className="rewrite-extra">
              <strong>复写新增（未划分到步骤）</strong>
              <DiffBlock lines={comparison.rewrite_extra.map(line => ({ op: 'rewrite_only', ai_line: null, rewrite_line: line.line, text: line.text }))} />
            </section>
          )}
        </>}
      </>}
    </aside>
  );
}

function DiffBlock({ lines }: { lines: RewriteDiffLine[] }) {
  return (
    <pre className="rewrite-diff">
      {lines.map((line, index) => (
        <span key={index} className={`rewrite-diff-line ${line.op}`}>
          <span className="rewrite-diff-tag">{line.op === 'same' ? '  ' : line.op === 'ai_only' ? 'AI' : '复写'}</span>
          <span className="rewrite-diff-number">{line.ai_line ?? ''}</span>
          <span className="rewrite-diff-number">{line.rewrite_line ?? ''}</span>
          {line.text}
          {'\n'}
        </span>
      ))}
    </pre>
  );
}

function rangeText(mappings: RewriteLineMapping[], stepId: string): string {
  const ranges = mappings.filter(mapping => mapping.step_id === stepId)
    .map(mapping => mapping.start_line === mapping.end_line ? `${mapping.start_line}` : `${mapping.start_line}–${mapping.end_line}`);
  return ranges.length > 0 ? `第 ${ranges.join('、')} 行` : '未划分';
}

function linesText(lines: number[]): string {
  if (lines.length === 0) return '无';
  const ranges: string[] = [];
  let start = lines[0] ?? 0;
  let previous = start;
  for (const line of lines.slice(1).concat([Number.NaN])) {
    if (line === previous + 1) { previous = line; continue; }
    ranges.push(start === previous ? `${start}` : `${start}–${previous}`);
    start = line; previous = line;
  }
  return `第 ${ranges.join('、')} 行`;
}
