// Step-level comparison between an AI code_snippet and the user's rewrite.cpp.
// Pure functions only; the ArkTS mirror is entry/src/main/ets/domain/RewriteCompare.ets
// and both are checked against packages/contracts/vectors/rewrite-compare.json.

/** @typedef {import('./types').RewriteLineMapping} RewriteLineMapping */
/** @typedef {import('./types').RewriteCompareSource} RewriteCompareSource */
/** @typedef {import('./types').RewriteComparison} RewriteComparison */
/** @typedef {import('./types').RewriteDiffLine} RewriteDiffLine */
/** @typedef {import('./types').RewriteCodeLine} RewriteCodeLine */

/** @param {string} text */
export function splitLines(text) {
  return text.split(/\r\n|\n|\r/);
}

/**
 * Lines owned by each step. A line may belong to several AI steps; a rewrite
 * line belongs to the last mapping that claims it. Out-of-range lines are
 * clamped away and mappings for unknown steps are ignored.
 * @param {RewriteLineMapping[]} mappings @param {Set<string>} stepIds @param {number} lineCount @param {boolean} exclusive
 * @returns {Map<string, number[]>}
 */
function ownedLines(mappings, stepIds, lineCount, exclusive) {
  /** @type {Map<string, Set<number>>} */
  const owned = new Map();
  /** @type {Map<number, string>} */
  const owner = new Map();
  for (const mapping of mappings) {
    if (!stepIds.has(mapping.step_id)) continue;
    const start = Math.max(1, mapping.start_line);
    const end = Math.min(lineCount, mapping.end_line);
    for (let line = start; line <= end; line++) {
      if (exclusive) owner.set(line, mapping.step_id);
      else {
        const lines = owned.get(mapping.step_id) ?? new Set();
        lines.add(line);
        owned.set(mapping.step_id, lines);
      }
    }
  }
  if (exclusive) {
    for (const [line, stepId] of owner) {
      const lines = owned.get(stepId) ?? new Set();
      lines.add(line);
      owned.set(stepId, lines);
    }
  }
  /** @type {Map<string, number[]>} */
  const result = new Map();
  for (const [stepId, lines] of owned) result.set(stepId, [...lines].sort((left, right) => left - right));
  return result;
}

/**
 * Line diff of two blocks, ignoring indentation, trailing whitespace and blank
 * lines. Ties prefer the AI side so both clients emit the same order.
 * @param {string[]} aiText @param {number[]} aiLines @param {string[]} rewriteText @param {number[]} rewriteLines
 * @returns {RewriteDiffLine[]}
 */
function diffBlocks(aiText, aiLines, rewriteText, rewriteLines) {
  const left = aiLines.filter(line => (aiText[line - 1] ?? '').trim().length > 0);
  const right = rewriteLines.filter(line => (rewriteText[line - 1] ?? '').trim().length > 0);
  const leftKeys = left.map(line => (aiText[line - 1] ?? '').trim());
  const rightKeys = right.map(line => (rewriteText[line - 1] ?? '').trim());
  /** @type {number[][]} */
  const table = [];
  for (let i = 0; i <= left.length; i++) table.push(new Array(right.length + 1).fill(0));
  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      const row = /** @type {number[]} */ (table[i]);
      const below = /** @type {number[]} */ (table[i + 1]);
      row[j] = leftKeys[i] === rightKeys[j] ? (below[j + 1] ?? 0) + 1 : Math.max(below[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  /** @type {RewriteDiffLine[]} */
  const diff = [];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    const aiLine = left[i];
    const rewriteLine = right[j];
    if (aiLine !== undefined && rewriteLine !== undefined && leftKeys[i] === rightKeys[j]) {
      diff.push({ op: 'same', ai_line: aiLine, rewrite_line: rewriteLine, text: (aiText[aiLine - 1] ?? '').trimEnd() });
      i++; j++;
    } else if (aiLine !== undefined && (rewriteLine === undefined || (table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0))) {
      diff.push({ op: 'ai_only', ai_line: aiLine, rewrite_line: null, text: (aiText[aiLine - 1] ?? '').trimEnd() });
      i++;
    } else if (rewriteLine !== undefined) {
      diff.push({ op: 'rewrite_only', ai_line: null, rewrite_line: rewriteLine, text: (rewriteText[rewriteLine - 1] ?? '').trimEnd() });
      j++;
    }
  }
  return diff;
}

/**
 * @param {string[]} text @param {Set<number>} covered
 * @returns {RewriteCodeLine[]}
 */
function uncoveredLines(text, covered) {
  /** @type {RewriteCodeLine[]} */
  const lines = [];
  text.forEach((value, index) => {
    if (value.trim().length > 0 && !covered.has(index + 1)) lines.push({ line: index + 1, text: value.trimEnd() });
  });
  return lines;
}

/**
 * @param {RewriteCompareSource} source
 * @param {string} rewrite
 * @param {RewriteLineMapping[]} rewriteMappings
 * @returns {RewriteComparison}
 */
export function compareRewrite(source, rewrite, rewriteMappings) {
  const aiText = splitLines(source.code_snippet);
  const rewriteText = splitLines(rewrite);
  const stepIds = new Set(source.steps.map(step => step.id));
  const aiOwned = ownedLines(source.code_mappings, stepIds, aiText.length, false);
  const rewriteOwned = ownedLines(rewriteMappings, stepIds, rewriteText.length, true);
  /** @type {RewriteComparison['summary']} */
  const summary = { same: 0, different: 0, missing: 0, no_ai_code: 0 };
  const steps = source.steps.map((step, index) => {
    const aiLines = aiOwned.get(step.id) ?? [];
    const rewriteLines = rewriteOwned.get(step.id) ?? [];
    const diff = diffBlocks(aiText, aiLines, rewriteText, rewriteLines);
    const hasAI = diff.some(line => line.ai_line !== null);
    const hasRewrite = diff.some(line => line.rewrite_line !== null);
    /** @type {import('./types').RewriteStepStatus} */
    const status = !hasAI ? 'no_ai_code' : !hasRewrite ? 'missing' : diff.every(line => line.op === 'same') ? 'same' : 'different';
    summary[status] += 1;
    return { step_id: step.id, index: index + 1, status, ai_lines: aiLines, rewrite_lines: rewriteLines, diff };
  });
  const aiCovered = new Set([...aiOwned.values()].flat());
  const rewriteCovered = new Set([...rewriteOwned.values()].flat());
  return { steps, ai_unmapped: uncoveredLines(aiText, aiCovered), rewrite_extra: uncoveredLines(rewriteText, rewriteCovered), summary };
}

/**
 * Reassigns lines start..end to stepId (or clears them for null). Other steps
 * keep their remaining lines; adjacent ranges of one step are merged.
 * @param {RewriteLineMapping[]} mappings @param {number} start @param {number} end @param {string | null} stepId
 * @returns {RewriteLineMapping[]}
 */
export function assignRewriteLines(mappings, start, end, stepId) {
  const from = Math.max(1, Math.min(start, end));
  const to = Math.max(start, end);
  const last = Math.max(to, ...mappings.map(mapping => mapping.end_line));
  /** @type {(string | null)[]} */
  const owner = new Array(last + 1).fill(null);
  for (const mapping of mappings) {
    for (let line = Math.max(1, mapping.start_line); line <= mapping.end_line; line++) owner[line] = mapping.step_id;
  }
  for (let line = from; line <= to; line++) owner[line] = stepId;
  /** @type {RewriteLineMapping[]} */
  const result = [];
  for (let line = 1; line <= last; line++) {
    const current = owner[line] ?? null;
    if (current === null) continue;
    const previous = result[result.length - 1];
    if (previous !== undefined && previous.step_id === current && previous.end_line === line - 1) previous.end_line = line;
    else result.push({ step_id: current, start_line: line, end_line: line });
  }
  return result;
}

/**
 * FNV-1a over UTF-16 code units of the LF-normalized text, plus its length.
 * Detects that rewrite.cpp changed after it was partitioned.
 * @param {string} text
 */
export function rewriteFingerprint(text) {
  const normalized = splitLines(text).join('\n');
  let hash = 0x811c9dc5;
  for (let index = 0; index < normalized.length; index++) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${normalized.length.toString(16)}-${hash.toString(16).padStart(8, '0')}`;
}

/**
 * The stored partition only applies to the artifact it was made for. A changed
 * rewrite keeps its mappings but marks them outdated until the user confirms.
 * @param {import('./types').RewriteMappingRecord | null | undefined} record
 * @param {string} artifactId @param {string} rewrite
 * @returns {import('./types').RewriteMappingState}
 */
export function resolveRewriteMapping(record, artifactId, rewrite) {
  if (!record || record.artifact_id !== artifactId || record.mappings.length === 0) return { status: 'empty', mappings: [] };
  return { status: record.rewrite_fingerprint === rewriteFingerprint(rewrite) ? 'current' : 'outdated', mappings: record.mappings };
}

/**
 * The comparable part of an AI artifact; null for pseudocode-only results.
 * @param {Pick<import('./types').AIArtifact, 'output_kind' | 'code_snippet' | 'pseudocode' | 'code_mappings'>} artifact
 * @returns {RewriteCompareSource | null}
 */
export function compareSourceFromArtifact(artifact) {
  if (artifact.output_kind !== 'code_snippet' || typeof artifact.code_snippet !== 'string' || artifact.code_snippet.length === 0) return null;
  return {
    steps: artifact.pseudocode.map(step => ({ id: step.id, step: step.step })),
    code_snippet: artifact.code_snippet,
    code_mappings: artifact.code_mappings.map(mapping => ({ ...mapping })),
  };
}

/**
 * 1-based line range of a selection given as character offsets.
 * A selection ending right after a line break does not include the next line.
 * @param {string} text @param {number} from @param {number} to
 */
export function selectionLines(text, from, to) {
  const start = Math.max(0, Math.min(from, to, text.length));
  let end = Math.max(0, Math.min(Math.max(from, to), text.length));
  if (end > start && text[end - 1] === '\n') end -= end - 1 > start && text[end - 2] === '\r' ? 2 : 1;
  else if (end > start && text[end - 1] === '\r') end -= 1;
  const lineAt = (/** @type {number} */ offset) => splitLines(text.slice(0, offset)).length;
  return { start_line: lineAt(start), end_line: lineAt(end) };
}
