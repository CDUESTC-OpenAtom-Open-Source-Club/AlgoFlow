import { AIMode } from './Models';
import { IDECapability, IDEDiagnostic, IDERecord, IDEResult, SourceRange } from './IDEAIModels';

// Parse without defaults: missing fields and wrong types never become valid artifacts.
export function parseIDEResult(body: string, record: IDERecord): IDEResult {
  const value = object(JSON.parse(body) as Object);
  const result = new IDEResult();
  const legacy = record.capability === IDECapability.TRANSFORM;
  const shared = ['mode', 'source_draft_version', 'model_id', 'rule_version', 'output_kind', 'visibility'];
  exact(value, legacy ? shared.concat(['pseudocode', 'code_snippet', 'code_mappings', 'assumptions', 'missing_information', 'risk_flags', 'added_algorithm_steps', 'template_id']) :
    shared.concat(record.capability === IDECapability.REVIEW ? ['draft_id', 'review_kind', 'diagnostics'] : ['draft_id', 'replaced_range', 'suggestion_text', 'source_refs']));
  requireValue(text(value['mode']) === record.context.mode && record.context.mode === AIMode.FAITHFUL_TRANSFORM);
  requireValue(integer(value['source_draft_version'], 0) === record.context.version);
  requireValue(text(value['rule_version']) === '1.0.0' && text(value['visibility']) === 'visible');
  requireValue(text(value['output_kind']) === (legacy ? 'pseudocode' : record.capability));
  result.modelId = text(value['model_id']);
  const ids = record.context.segments.map(segment => segment.id);
  if (legacy) {
    requireValue(value['code_snippet'] === null && array(value['code_mappings']).length === 0 && array(value['added_algorithm_steps']).length === 0);
    requireValue(value['template_id'] === null || typeof value['template_id'] === 'string');
    const stepIds: string[] = [];
    const steps = array(value['pseudocode']).map(item => {
      const step = object(item); exact(step, ['id', 'step', 'source_refs']);
      const id = text(step['id']); requireValue(!stepIds.includes(id)); stepIds.push(id);
      const refs = strings(step['source_refs']); requireValue(refs.length > 0 && refs.every(ref => ids.includes(ref)));
      return `${text(step['step'])}\n来源：${refs.join(', ')}`;
    });
    for (const key of ['assumptions', 'missing_information', 'risk_flags']) strings(value[key]);
    result.transformText = steps.join('\n\n') || '（无伪代码步骤）'; return result;
  }
  requireValue(text(value['draft_id']) === record.context.draftId);
  if (record.capability === IDECapability.REVIEW) {
    requireValue(text(value['review_kind']) === record.reviewKind);
    const seen: string[] = [];
    result.diagnostics = array(value['diagnostics']).map(item => {
      const entry = object(item); exact(entry, ['id', 'level', 'range', 'problem', 'basis', 'suggestion']);
      const diagnostic = new IDEDiagnostic(); diagnostic.id = text(entry['id']);
      requireValue(!seen.includes(diagnostic.id)); seen.push(diagnostic.id);
      diagnostic.level = text(entry['level']); requireValue(['info', 'warning', 'error'].includes(diagnostic.level));
      diagnostic.problem = text(entry['problem']); diagnostic.basis = text(entry['basis']); diagnostic.suggestion = text(entry['suggestion']);
      diagnostic.range = entry['range'] === null ? null : range(entry['range']);
      if (diagnostic.range !== null) rangeOffsets(record.context.code, diagnostic.range);
      return diagnostic;
    });
  } else {
    result.range = range(value['replaced_range']); result.suggestion = text(value['suggestion_text']);
    requireValue(result.suggestion.length <= 500 && safeFragment(result.suggestion));
    result.sourceRefs = strings(value['source_refs']); requireValue(result.sourceRefs.length > 0 && result.sourceRefs.every(ref => ids.includes(ref)));
    const offsets = rangeOffsets(record.context.code, result.range);
    const cursor = new SourceRange(); cursor.start_line = record.cursor.line; cursor.end_line = record.cursor.line;
    cursor.start_char = record.cursor.char; cursor.end_char = record.cursor.char;
    const at = rangeOffsets(record.context.code, cursor)[0];
    requireValue(offsets[0] <= at && offsets[1] >= at && !(offsets[0] === 0 && offsets[1] === record.context.code.length));
    requireValue(result.range.start_line >= record.cursor.line - 3 && result.range.end_line <= record.cursor.line + 3);
  }
  return result;
}
function object(value: Object): Record<string, Object> {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, Object>;
}
function array(value: Object): Object[] { requireValue(Array.isArray(value)); return value as Object[]; }
function text(value: Object): string { requireValue(typeof value === 'string' && (value as string).length > 0); return value as string; }
function strings(value: Object): string[] { return array(value).map(item => { requireValue(typeof item === 'string'); return item as string; }); }
function integer(value: Object, minimum: number): number { requireValue(typeof value === 'number' && Number.isInteger(value) && (value as number) >= minimum); return value as number; }
function exact(value: Record<string, Object>, keys: string[]): void { requireValue(Object.keys(value).length === keys.length && keys.every(key => Object.keys(value).includes(key))); }
function requireValue(valid: boolean): void { if (!valid) throw new Error('INVALID_AI_ARTIFACT'); }
function range(value: Object): SourceRange {
  const entry = object(value); exact(entry, ['start_line', 'start_char', 'end_line', 'end_char']);
  const result = new SourceRange(); result.start_line = integer(entry['start_line'], 1); result.end_line = integer(entry['end_line'], 1);
  result.start_char = integer(entry['start_char'], 0); result.end_char = integer(entry['end_char'], 0);
  requireValue(result.end_line > result.start_line || (result.end_line === result.start_line && result.end_char >= result.start_char)); return result;
}
export function rangeOffsets(code: string, value: SourceRange): number[] {
  const lines = code.split(/\r?\n/); const starts: number[] = [0];
  let index = 0;
  while (index < code.length) { if (code[index] === '\n') starts.push(index + 1); index++; }
  requireValue(Number.isInteger(value.start_line) && Number.isInteger(value.end_line) && Number.isInteger(value.start_char) && Number.isInteger(value.end_char));
  requireValue(value.start_line >= 1 && value.end_line >= value.start_line && value.end_line <= lines.length);
  requireValue(value.start_char >= 0 && value.start_char <= lines[value.start_line - 1].length && value.end_char >= 0 && value.end_char <= lines[value.end_line - 1].length);
  const start = starts[value.start_line - 1] + value.start_char; const end = starts[value.end_line - 1] + value.end_char;
  requireValue(end >= start); return [start, end];
}

// Mirrors the shared bounded C++ lexical gate; tested with shared contract vectors.
export function safeFragment(source: string): boolean {
  let text = ''; const offsets: number[] = [];
  for (let i = 0; i < source.length;) {
    const splice = /^\\[ \t\v\f]*(?:\r\n|\n|\r)/.exec(source.substring(i));
    if (splice !== null) { i += splice[0].length; continue; }
    offsets.push(i); text += source[i++];
  }
  let i = 0;
  while (i < text.length) {
    if (/\s/.test(text[i])) { i++; continue; }
    if (text.substring(i, i + 2) === '//') { const end = text.substring(i + 2).search(/[\r\n]/); i = end < 0 ? text.length : i + 2 + end; continue; }
    if (text.substring(i, i + 2) === '/*') { const end = text.indexOf('*/', i + 2); if (end < 0) return false; i = end + 2; continue; }
    const raw = /^(?:u8|u|U|L)?R"/.exec(text.substring(i));
    if (raw !== null) {
      const quote = offsets[i + raw[0].length - 1];
      const delimiter = /^([^ ()\\\t\v\f\r\n]{0,16})\(/.exec(source.substring(quote + 1));
      if (delimiter === null) return false;
      const endToken = `)${delimiter[1]}"`; const end = source.indexOf(endToken, quote + 1 + delimiter[0].length);
      if (end < 0) return false;
      while (i < text.length && offsets[i] < end + endToken.length) i++; continue;
    }
    if (text[i] === '"' || text[i] === "'") {
      const quote = text[i++]; let closed = false;
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i++] === quote) { closed = true; break; }
      }
      if (!closed) return false; continue;
    }
    if (/[0-9]/.test(text[i]) || (text[i] === '.' && /[0-9]/.test(text[i + 1] ?? ''))) {
      i++; while (i < text.length) {
        if (/[a-zA-Z0-9_.]/.test(text[i])) { i++; continue; }
        if (text[i] === "'" && /[a-zA-Z0-9_]/.test(text[i + 1] ?? '')) { i += 2; continue; }
        if (/[+-]/.test(text[i]) && /[eEpP]/.test(text[i - 1])) { i++; continue; } break;
      } continue;
    }
    const identifier = /^[\p{ID_Start}_$][\p{ID_Continue}$]*/u.exec(text.substring(i));
    if (identifier !== null) { if (identifier[0] === 'main') return false; i += identifier[0].length; continue; }
    if (text[i] === '#' || text[i] === '\\' || text.substring(i, i + 2) === '%:' || text.substring(i, i + 3) === '??=' || text.substring(i, i + 3) === '??/') return false;
    i++;
  }
  return true;
}
