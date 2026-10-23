// Step-level comparison between an AI code_snippet and the user's rewrite.cpp.
// Mirrors apps/web/src/rewrite-compare.mjs; both are checked against
// packages/contracts/vectors/rewrite-compare.json. Field names follow that JSON.
// Rewrite mappings are local-only and never enter Draft or a SyncOperation.

export enum RewriteDiffOp { SAME = 'same', AI_ONLY = 'ai_only', REWRITE_ONLY = 'rewrite_only' }
export enum RewriteStepStatus { SAME = 'same', DIFFERENT = 'different', MISSING = 'missing', NO_AI_CODE = 'no_ai_code' }
export enum RewriteMappingStatus { EMPTY = 'empty', CURRENT = 'current', OUTDATED = 'outdated' }

export class RewriteLineMapping {
  step_id: string;
  start_line: number;
  end_line: number;

  constructor(stepId: string, startLine: number, endLine: number) {
    this.step_id = stepId;
    this.start_line = startLine;
    this.end_line = endLine;
  }
}

export class RewriteCompareStep {
  id: string;
  step: string;

  constructor(id: string, step: string) {
    this.id = id;
    this.step = step;
  }
}

export class RewriteCompareSource {
  steps: RewriteCompareStep[] = [];
  code_snippet: string = '';
  code_mappings: RewriteLineMapping[] = [];
}

export class RewriteDiffLine {
  op: RewriteDiffOp;
  ai_line: number | null;
  rewrite_line: number | null;
  text: string;

  constructor(op: RewriteDiffOp, aiLine: number | null, rewriteLine: number | null, text: string) {
    this.op = op;
    this.ai_line = aiLine;
    this.rewrite_line = rewriteLine;
    this.text = text;
  }
}

export class RewriteStepComparison {
  step_id: string = '';
  index: number = 0;
  status: RewriteStepStatus = RewriteStepStatus.NO_AI_CODE;
  ai_lines: number[] = [];
  rewrite_lines: number[] = [];
  diff: RewriteDiffLine[] = [];
}

export class RewriteCodeLine {
  line: number;
  text: string;

  constructor(line: number, text: string) {
    this.line = line;
    this.text = text;
  }
}

export class RewriteSummary {
  same: number = 0;
  different: number = 0;
  missing: number = 0;
  no_ai_code: number = 0;
}

export class RewriteComparison {
  steps: RewriteStepComparison[] = [];
  ai_unmapped: RewriteCodeLine[] = [];
  rewrite_extra: RewriteCodeLine[] = [];
  summary: RewriteSummary = new RewriteSummary();
}

export class RewriteMappingRecord {
  draft_id: string = '';
  artifact_id: string = '';
  rewrite_fingerprint: string = '';
  mappings: RewriteLineMapping[] = [];
  updated_at: string = '';
}

export class RewriteMappingState {
  status: RewriteMappingStatus = RewriteMappingStatus.EMPTY;
  mappings: RewriteLineMapping[] = [];
}

export class RewriteLineRange {
  start_line: number;
  end_line: number;

  constructor(startLine: number, endLine: number) {
    this.start_line = startLine;
    this.end_line = endLine;
  }
}

// Port for the device-local partition store.
export interface RewriteMappingRepository {
  load(draftId: string): Promise<RewriteMappingRecord | null>;
  save(record: RewriteMappingRecord): Promise<void>;
  removeDraft(draftId: string): Promise<void>;
}

export function splitRewriteLines(text: string): string[] {
  return text.split(/\r\n|\n|\r/);
}

// A line may belong to several AI steps; a rewrite line belongs to the last
// mapping that claims it. Out-of-range lines and unknown steps are ignored.
function ownedLines(mappings: RewriteLineMapping[], stepIds: string[], lineCount: number, exclusive: boolean): Map<string, number[]> {
  const owned = new Map<string, number[]>();
  const owner = new Map<number, string>();
  const add = (stepId: string, line: number): void => {
    const lines = owned.get(stepId) ?? [];
    if (!lines.includes(line)) lines.push(line);
    owned.set(stepId, lines);
  };
  mappings.forEach((mapping: RewriteLineMapping) => {
    if (!stepIds.includes(mapping.step_id)) return;
    const end = Math.min(lineCount, mapping.end_line);
    for (let line = Math.max(1, mapping.start_line); line <= end; line++) {
      if (exclusive) owner.set(line, mapping.step_id);
      else add(mapping.step_id, line);
    }
  });
  if (exclusive) {
    const lines = Array.from(owner.keys()).sort((left: number, right: number) => left - right);
    lines.forEach((line: number) => add(owner.get(line) as string, line));
  }
  owned.forEach((lines: number[]) => { lines.sort((left: number, right: number) => left - right); });
  return owned;
}

function lineText(lines: string[], line: number): string {
  return line >= 1 && line <= lines.length ? lines[line - 1] : '';
}

// Line diff ignoring indentation, trailing whitespace and blank lines. Ties
// prefer the AI side so both clients emit the same order.
function diffBlocks(aiText: string[], aiLines: number[], rewriteText: string[], rewriteLines: number[]): RewriteDiffLine[] {
  const left = aiLines.filter((line: number) => lineText(aiText, line).trim().length > 0);
  const right = rewriteLines.filter((line: number) => lineText(rewriteText, line).trim().length > 0);
  const leftKeys = left.map((line: number) => lineText(aiText, line).trim());
  const rightKeys = right.map((line: number) => lineText(rewriteText, line).trim());
  const table: number[][] = [];
  for (let i = 0; i <= left.length; i++) table.push(new Array<number>(right.length + 1).fill(0));
  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      table[i][j] = leftKeys[i] === rightKeys[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const diff: RewriteDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && leftKeys[i] === rightKeys[j]) {
      diff.push(new RewriteDiffLine(RewriteDiffOp.SAME, left[i], right[j], trimEnd(lineText(aiText, left[i]))));
      i++; j++;
    } else if (i < left.length && (j >= right.length || table[i + 1][j] >= table[i][j + 1])) {
      diff.push(new RewriteDiffLine(RewriteDiffOp.AI_ONLY, left[i], null, trimEnd(lineText(aiText, left[i]))));
      i++;
    } else {
      diff.push(new RewriteDiffLine(RewriteDiffOp.REWRITE_ONLY, null, right[j], trimEnd(lineText(rewriteText, right[j]))));
      j++;
    }
  }
  return diff;
}

function trimEnd(text: string): string {
  return text.replace(/\s+$/, '');
}

function uncoveredLines(text: string[], owned: Map<string, number[]>): RewriteCodeLine[] {
  const covered: number[] = [];
  owned.forEach((lines: number[]) => { lines.forEach((line: number) => { covered.push(line); }); });
  const result: RewriteCodeLine[] = [];
  text.forEach((value: string, index: number) => {
    if (value.trim().length > 0 && !covered.includes(index + 1)) result.push(new RewriteCodeLine(index + 1, trimEnd(value)));
  });
  return result;
}

export function compareRewrite(source: RewriteCompareSource, rewrite: string, rewriteMappings: RewriteLineMapping[]): RewriteComparison {
  const aiText = splitRewriteLines(source.code_snippet);
  const rewriteText = splitRewriteLines(rewrite);
  const stepIds = source.steps.map((step: RewriteCompareStep) => step.id);
  const aiOwned = ownedLines(source.code_mappings, stepIds, aiText.length, false);
  const rewriteOwned = ownedLines(rewriteMappings, stepIds, rewriteText.length, true);
  const comparison = new RewriteComparison();
  source.steps.forEach((step: RewriteCompareStep, index: number) => {
    const item = new RewriteStepComparison();
    item.step_id = step.id;
    item.index = index + 1;
    item.ai_lines = aiOwned.get(step.id) ?? [];
    item.rewrite_lines = rewriteOwned.get(step.id) ?? [];
    item.diff = diffBlocks(aiText, item.ai_lines, rewriteText, item.rewrite_lines);
    const hasAI = item.diff.some((line: RewriteDiffLine) => line.ai_line !== null);
    const hasRewrite = item.diff.some((line: RewriteDiffLine) => line.rewrite_line !== null);
    item.status = !hasAI ? RewriteStepStatus.NO_AI_CODE : !hasRewrite ? RewriteStepStatus.MISSING :
      item.diff.every((line: RewriteDiffLine) => line.op === RewriteDiffOp.SAME) ? RewriteStepStatus.SAME : RewriteStepStatus.DIFFERENT;
    if (item.status === RewriteStepStatus.SAME) comparison.summary.same++;
    else if (item.status === RewriteStepStatus.DIFFERENT) comparison.summary.different++;
    else if (item.status === RewriteStepStatus.MISSING) comparison.summary.missing++;
    else comparison.summary.no_ai_code++;
    comparison.steps.push(item);
  });
  comparison.ai_unmapped = uncoveredLines(aiText, aiOwned);
  comparison.rewrite_extra = uncoveredLines(rewriteText, rewriteOwned);
  return comparison;
}

// Reassigns lines start..end to stepId (or clears them for null). Other steps
// keep their remaining lines; adjacent ranges of one step are merged.
export function assignRewriteLines(mappings: RewriteLineMapping[], start: number, end: number, stepId: string | null): RewriteLineMapping[] {
  const from = Math.max(1, Math.min(start, end));
  const to = Math.max(start, end);
  let last = to;
  mappings.forEach((mapping: RewriteLineMapping) => { last = Math.max(last, mapping.end_line); });
  const owner: (string | null)[] = new Array<string | null>(last + 1).fill(null);
  mappings.forEach((mapping: RewriteLineMapping) => {
    for (let line = Math.max(1, mapping.start_line); line <= mapping.end_line; line++) owner[line] = mapping.step_id;
  });
  for (let line = from; line <= to; line++) owner[line] = stepId;
  const result: RewriteLineMapping[] = [];
  for (let line = 1; line <= last; line++) {
    const current = owner[line];
    if (current === null) continue;
    const previous = result.length > 0 ? result[result.length - 1] : undefined;
    if (previous !== undefined && previous.step_id === current && previous.end_line === line - 1) previous.end_line = line;
    else result.push(new RewriteLineMapping(current, line, line));
  }
  return result;
}

// FNV-1a over UTF-16 code units of the LF-normalized text, plus its length.
export function rewriteFingerprint(text: string): string {
  const normalized = splitRewriteLines(text).join('\n');
  let hash = 0x811c9dc5;
  for (let index = 0; index < normalized.length; index++) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${normalized.length.toString(16)}-${hash.toString(16).padStart(8, '0')}`;
}

export function resolveRewriteMapping(record: RewriteMappingRecord | null, artifactId: string, rewrite: string): RewriteMappingState {
  const state = new RewriteMappingState();
  if (record === null || record.artifact_id !== artifactId || record.mappings.length === 0) return state;
  state.status = record.rewrite_fingerprint === rewriteFingerprint(rewrite) ? RewriteMappingStatus.CURRENT : RewriteMappingStatus.OUTDATED;
  state.mappings = record.mappings;
  return state;
}

export function createRewriteMappingRecord(draftId: string, artifactId: string, rewrite: string, mappings: RewriteLineMapping[]): RewriteMappingRecord {
  const record = new RewriteMappingRecord();
  record.draft_id = draftId;
  record.artifact_id = artifactId;
  record.rewrite_fingerprint = rewriteFingerprint(rewrite);
  record.mappings = mappings.map((mapping: RewriteLineMapping) => new RewriteLineMapping(mapping.step_id, mapping.start_line, mapping.end_line));
  record.updated_at = new Date().toISOString();
  return record;
}

// Restores a stored record; any damaged entry yields null so the user can
// partition again without touching rewrite.cpp.
export function decodeRewriteMappingRecord(json: string): RewriteMappingRecord | null {
  try {
    const value = JSON.parse(json) as RewriteMappingRecord;
    if (value === null || typeof value !== 'object' || typeof value.draft_id !== 'string' || value.draft_id.length === 0 ||
      typeof value.artifact_id !== 'string' || value.artifact_id.length === 0 || typeof value.rewrite_fingerprint !== 'string' ||
      typeof value.updated_at !== 'string' || !Array.isArray(value.mappings)) return null;
    const record = new RewriteMappingRecord();
    record.draft_id = value.draft_id;
    record.artifact_id = value.artifact_id;
    record.rewrite_fingerprint = value.rewrite_fingerprint;
    record.updated_at = value.updated_at;
    for (const mapping of value.mappings) {
      if (mapping === null || typeof mapping !== 'object' || typeof mapping.step_id !== 'string' || mapping.step_id.length === 0 ||
        !Number.isInteger(mapping.start_line) || mapping.start_line < 1 || !Number.isInteger(mapping.end_line) ||
        mapping.end_line < mapping.start_line) return null;
      record.mappings.push(new RewriteLineMapping(mapping.step_id, mapping.start_line, mapping.end_line));
    }
    return record;
  } catch (error) {
    return null;
  }
}

// The comparable part of a stored transform result body; null for pseudocode.
// The body was already validated by parseIDEResult when it was stored.
export function compareSourceFromBody(body: string): RewriteCompareSource | null {
  try {
    const value = JSON.parse(body) as Record<string, Object>;
    if (value['output_kind'] !== 'code_snippet' || typeof value['code_snippet'] !== 'string' ||
      (value['code_snippet'] as string).length === 0 || !Array.isArray(value['pseudocode']) || !Array.isArray(value['code_mappings'])) return null;
    const source = new RewriteCompareSource();
    source.code_snippet = value['code_snippet'] as string;
    (value['pseudocode'] as Object[]).forEach((item: Object) => {
      const step = item as Record<string, Object>;
      source.steps.push(new RewriteCompareStep(String(step['id']), String(step['step'])));
    });
    (value['code_mappings'] as Object[]).forEach((item: Object) => {
      const mapping = item as Record<string, Object>;
      source.code_mappings.push(new RewriteLineMapping(String(mapping['step_id']), Number(mapping['start_line']), Number(mapping['end_line'])));
    });
    return source;
  } catch (error) {
    return null;
  }
}

// 1-based line range of a selection given as character offsets. A selection
// ending right after a line break does not include the next line.
export function selectionLines(text: string, from: number, to: number): RewriteLineRange {
  const start = Math.max(0, Math.min(from, to, text.length));
  let end = Math.max(0, Math.min(Math.max(from, to), text.length));
  if (end > start && text[end - 1] === '\n') end -= end - 1 > start && text[end - 2] === '\r' ? 2 : 1;
  else if (end > start && text[end - 1] === '\r') end -= 1;
  return new RewriteLineRange(splitRewriteLines(text.substring(0, start)).length, splitRewriteLines(text.substring(0, end)).length);
}
