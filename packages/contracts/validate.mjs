import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const domain = JSON.parse(readFileSync(fileURLToPath(new URL('./schemas/domain.schema.json', import.meta.url)), 'utf8'));
const modes = new Set(domain.$defs.aiMode.enum);
const outputKinds = new Set(domain.$defs.aiOutputKind.enum);
const visibilities = new Set(domain.$defs.aiVisibility.enum);
const artifactFields = ['mode', 'pseudocode', 'code_snippet', 'code_mappings', 'assumptions', 'missing_information', 'risk_flags', 'added_algorithm_steps', 'source_draft_version', 'model_id', 'rule_version', 'output_kind', 'visibility', 'template_id'];
const entityFields = new Set(['id', 'version', 'server_sequence', 'created_at', 'updated_at', 'deleted', 'last_modified_client_id', 'draft_id', ...artifactFields]);
const reviewKinds = new Set(domain.$defs.reviewKind.enum);
const diagnosticLevels = new Set(domain.$defs.diagnosticLevel.enum);
const reviewEntityFields = new Set(['id', 'version', 'server_sequence', 'created_at', 'updated_at', 'deleted', 'last_modified_client_id', 'draft_id', 'mode', 'source_draft_version', 'model_id', 'rule_version', 'review_kind', 'diagnostics', 'visibility', 'freshness']);

export function validateReviewResultEntity(entity, sourceDraft = undefined) {
  const errors = [];
  if (!isObject(entity)) return ['review_result payload must be an object'];
  for (const key of Object.keys(entity)) if (!reviewEntityFields.has(key)) errors.push(`${key} is not allowed`);
  for (const field of ['id', 'draft_id', 'last_modified_client_id', 'model_id', 'rule_version']) {
    if (typeof entity[field] !== 'string' || entity[field].length === 0) errors.push(`${field} is required`);
  }
  for (const field of ['version', 'server_sequence', 'source_draft_version']) {
    if (!Number.isInteger(entity[field]) || entity[field] < 0) errors.push(`${field} is invalid`);
  }
  for (const field of ['created_at', 'updated_at']) {
    if (typeof entity[field] !== 'string' || !entity[field].endsWith('Z') || Number.isNaN(Date.parse(entity[field]))) errors.push(`${field} is invalid`);
  }
  if (typeof entity.deleted !== 'boolean') errors.push('deleted is invalid');
  if (!modes.has(entity.mode)) errors.push('mode is invalid');
  if (!reviewKinds.has(entity.review_kind)) errors.push('review_kind is invalid');
  if (!visibilities.has(entity.visibility)) errors.push('visibility is invalid');
  if (!['current', 'stale'].includes(entity.freshness)) errors.push('freshness is invalid');
  if (!Array.isArray(entity.diagnostics)) errors.push('diagnostics is invalid');
  else {
    const ids = new Set();
    entity.diagnostics.forEach((item, index) => {
      if (!isObject(item)) { errors.push(`diagnostics[${index}] is invalid`); return; }
      for (const field of ['id', 'problem', 'basis', 'suggestion']) {
        if (typeof item[field] !== 'string' || item[field].length === 0) errors.push(`diagnostics[${index}].${field} is invalid`);
      }
      if (ids.has(item.id)) errors.push(`diagnostics[${index}].id must be unique`);
      ids.add(item.id);
      if (!diagnosticLevels.has(item.level)) errors.push(`diagnostics[${index}].level is invalid`);
      if (item.range !== null && !isSourceRange(item.range)) errors.push(`diagnostics[${index}].range is invalid`);
      else if (item.range && (item.range.end_line < item.range.start_line ||
        (item.range.end_line === item.range.start_line && item.range.end_char < item.range.start_char))) {
        errors.push(`diagnostics[${index}].range is inverted`);
      }
      if (item.range && sourceDraft && !isRangeWithinCode(item.range, sourceDraft.code)) {
        errors.push(`diagnostics[${index}].range is outside the source code`);
      }
      if (Object.keys(item).some((key) => !['id', 'level', 'range', 'problem', 'basis', 'suggestion'].includes(key))) {
        errors.push(`diagnostics[${index}] contains unsupported fields`);
      }
    });
  }
  return errors;
}

export function validateAIArtifactEntity(entity, sourceSegmentIds = undefined) {
  const errors = [];
  if (!isObject(entity)) return ['ai_artifact payload must be an object'];
  for (const key of Object.keys(entity)) if (!entityFields.has(key)) errors.push(`${key} is not allowed`);
  for (const field of ['id', 'draft_id', 'last_modified_client_id', 'model_id', 'rule_version']) {
    if (typeof entity[field] !== 'string' || entity[field].length === 0) errors.push(`${field} is required`);
  }
  for (const field of ['version', 'server_sequence', 'source_draft_version']) {
    if (!Number.isInteger(entity[field]) || entity[field] < 0) errors.push(`${field} is invalid`);
  }
  for (const field of ['created_at', 'updated_at']) {
    if (typeof entity[field] !== 'string' || !entity[field].endsWith('Z') || Number.isNaN(Date.parse(entity[field]))) errors.push(`${field} is invalid`);
  }
  if (typeof entity.deleted !== 'boolean') errors.push('deleted is invalid');
  if (!modes.has(entity.mode)) errors.push('mode is invalid');
  if (!outputKinds.has(entity.output_kind)) errors.push('output_kind is invalid');
  if (!visibilities.has(entity.visibility)) errors.push('visibility is invalid');
  if (!Array.isArray(entity.pseudocode)) errors.push('pseudocode is invalid');
  else {
    const ids = new Set();
    entity.pseudocode.forEach((step, index) => {
      if (!isObject(step) || typeof step.id !== 'string' || step.id.length === 0 ||
        typeof step.step !== 'string' || step.step.length === 0 || !Array.isArray(step.source_refs) ||
        step.source_refs.length === 0 || step.source_refs.some((ref) => typeof ref !== 'string' || ref.length === 0)) {
        errors.push(`pseudocode[${index}] is invalid`);
      }
      if (sourceSegmentIds instanceof Set && Array.isArray(step?.source_refs)) {
        for (const ref of step.source_refs) if (!sourceSegmentIds.has(ref)) errors.push(`pseudocode[${index}] references unknown source_ref`);
      }
      if (ids.has(step?.id)) errors.push(`pseudocode[${index}].id must be unique`);
      ids.add(step?.id);
    });
  }
  if (entity.code_snippet !== null && typeof entity.code_snippet !== 'string') errors.push('code_snippet is invalid');
  if (typeof entity.code_snippet === 'string' && entity.code_snippet.length > 4000) errors.push('code_snippet is too long');
  if (!Array.isArray(entity.code_mappings)) errors.push('code_mappings is invalid');
  else {
    const stepIds = new Set(entity.pseudocode?.map((step) => step?.id) ?? []);
    entity.code_mappings.forEach((mapping, index) => {
    if (!isObject(mapping) || typeof mapping.step_id !== 'string' || mapping.step_id.length === 0 ||
      !Number.isInteger(mapping.start_line) || mapping.start_line < 1 || !Number.isInteger(mapping.end_line) ||
      mapping.end_line < mapping.start_line || !stepIds.has(mapping.step_id)) errors.push(`code_mappings[${index}] is invalid`);
    });
  }
  for (const field of ['assumptions', 'missing_information', 'risk_flags', 'added_algorithm_steps']) {
    if (!Array.isArray(entity[field]) || entity[field].some((item) => typeof item !== 'string')) errors.push(`${field} is invalid`);
  }
  if (entity.template_id !== null && (typeof entity.template_id !== 'string' || entity.template_id.length === 0)) errors.push('template_id is invalid');
  if (entity.mode === 'faithful_transform' && Array.isArray(entity.added_algorithm_steps) && entity.added_algorithm_steps.length > 0) {
    errors.push('faithful_transform cannot add algorithm steps');
  }
  if (entity.output_kind === 'pseudocode' && (entity.code_snippet !== null || !Array.isArray(entity.code_mappings) || entity.code_mappings.length > 0)) {
    errors.push('pseudocode output cannot contain code');
  }
  if (entity.output_kind === 'code_snippet' && (typeof entity.code_snippet !== 'string' || entity.code_snippet.length === 0 || !Array.isArray(entity.code_mappings) || entity.code_mappings.length === 0)) {
    errors.push('code_snippet output requires mapped code');
  }
  if (typeof entity.code_snippet === 'string' && /\b(?:int|signed|auto|void)\s+main\s*\(/.test(entity.code_snippet)) {
    errors.push('code_snippet cannot contain main');
  }
  return errors;
}

function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

function isSourceRange(value) {
  return isObject(value) && Number.isInteger(value.start_line) && value.start_line >= 1 &&
    Number.isInteger(value.start_char) && value.start_char >= 0 && Number.isInteger(value.end_line) &&
    value.end_line >= 1 && Number.isInteger(value.end_char) && value.end_char >= 0 &&
    Object.keys(value).every((key) => ['start_line', 'start_char', 'end_line', 'end_char'].includes(key));
}

function isRangeWithinCode(range, code) {
  if (typeof code !== 'string') return false;
  const lines = code.split('\n');
  return range.start_line <= lines.length && range.end_line <= lines.length &&
    range.start_char <= lines[range.start_line - 1].length && range.end_char <= lines[range.end_line - 1].length;
}
