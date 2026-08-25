import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const schemas = {
  domain: loadSchema('../../../packages/contracts/schemas/domain.schema.json'),
  ai: loadSchema('../../../packages/contracts/schemas/ai.schema.json')
};

export const AI_MODES = new Set(schemas.domain.$defs.aiMode.enum);
export const AI_OUTPUT_KINDS = new Set(schemas.domain.$defs.aiOutputKind.enum);
export const AI_VISIBILITIES = new Set(schemas.domain.$defs.aiVisibility.enum);

export function validateAIRequest(request) {
  const errors = validateSchema(request, schemas.ai.$defs.request, 'request');
  if (Array.isArray(request?.idea_segments)) {
    const ids = new Set();
    request.idea_segments.forEach((segment, index) => {
      if (ids.has(segment?.id)) errors.push(`idea_segments[${index}].id must be unique`);
      ids.add(segment?.id);
    });
  }
  return errors;
}

export function validateAIArtifact(artifact) {
  const errors = validateSchema(artifact, schemas.ai.$defs.artifact, 'artifact');
  if (Array.isArray(artifact?.pseudocode)) {
    const ids = new Set();
    artifact.pseudocode.forEach((step, index) => {
      if (ids.has(step?.id)) errors.push(`pseudocode[${index}].id must be unique`);
      ids.add(step?.id);
    });
  }
  if (Array.isArray(artifact?.code_mappings)) artifact.code_mappings.forEach((mapping, index) => {
    if (Number.isInteger(mapping?.start_line) && Number.isInteger(mapping?.end_line) && mapping.end_line < mapping.start_line) errors.push(`code_mappings[${index}].end_line must not precede start_line`);
  });
  return errors;
}

function validateSchema(value, schema, path) {
  if (!schema) return [];
  if (schema.$ref) return validateSchema(value, resolveReference(schema.$ref), path);
  const errors = [];
  if (schema.const !== undefined && value !== schema.const) errors.push(`${path} must equal ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path} is not an allowed value`);
  if (schema.type && !matchesType(value, schema.type)) {
    errors.push(`${path} has an invalid type`);
    return errors;
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path} is too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path} is too long`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path} does not match the required pattern`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path} is below the minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path} exceeds the maximum`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path} has too few items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path} has too many items`);
    if (schema.items) value.forEach((item, index) => errors.push(...validateSchema(item, schema.items, `${path}[${index}]`)));
  }
  if (isObject(value)) {
    for (const required of schema.required ?? []) if (!(required in value)) errors.push(`${path}.${required} is required`);
    for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) if (key in value) errors.push(...validateSchema(value[key], propertySchema, `${path}.${key}`));
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(value)) if (!allowed.has(key)) errors.push(`${path}.${key} is not allowed`);
    }
  }
  for (const nested of schema.allOf ?? []) errors.push(...validateSchema(value, nested, path));
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((candidate) => validateSchema(value, candidate, path).length === 0).length;
    if (matches !== 1) errors.push(`${path} must match exactly one output shape`);
  }
  if (schema.if && validateSchema(value, schema.if, path).length === 0 && schema.then) errors.push(...validateSchema(value, schema.then, path));
  return errors;
}

function resolveReference(reference) {
  const [file, pointer] = reference.split('#');
  const root = file === 'domain.schema.json' ? schemas.domain : file === 'ai.schema.json' || file === '' ? schemas.ai : null;
  if (!root) throw new Error(`Unsupported schema reference: ${reference}`);
  return (pointer || '').split('/').filter(Boolean).reduce((value, part) => value[part.replaceAll('~1', '/').replaceAll('~0', '~')], root);
}

function matchesType(value, expected) {
  const types = Array.isArray(expected) ? expected : [expected];
  return types.some((type) => type === 'null' ? value === null : type === 'array' ? Array.isArray(value) : type === 'object' ? isObject(value) : type === 'integer' ? Number.isInteger(value) : typeof value === type);
}

function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

function loadSchema(relativePath) {
  return JSON.parse(readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8'));
}
