import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import {
  validateAIArtifact,
  validateAIRequest,
  validateCompletionRequest,
  validateCompletionResult,
  validateReviewRequest,
  validateReviewResult
} from './contracts.mjs';

const DEFAULT_PROVIDER_TIMEOUT_MS = 10000;

export function createAIGateway({
  aiProvider = null,
  templates = [],
  enabledModes = ['faithful_transform'],
  providerTimeoutMs = DEFAULT_PROVIDER_TIMEOUT_MS
} = {}) {
  const enabledModeSet = new Set(enabledModes);
  const hasGenerate = aiProvider !== null && typeof aiProvider.generate === 'function';
  const hasReview = aiProvider !== null && typeof aiProvider.review === 'function';
  const hasComplete = aiProvider !== null && typeof aiProvider.complete === 'function';
  const anyEnabled = hasGenerate || hasReview || hasComplete;
  return createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (request.method === 'GET' && request.url === '/status') {
      writeJson(response, 200, {
        enabled: anyEnabled,
        code: anyEnabled ? 'AI_ENABLED' : 'AI_NOT_ENABLED',
        capabilities: { transform: hasGenerate, review: hasReview, completion: hasComplete }
      });
      return;
    }
    if (request.method === 'POST' && request.url === '/requests') {
      const body = await readJson(request);
      const errors = validateAIRequest(body);
      if (errors.length) { writeJson(response, 400, { code: 'INVALID_REQUEST', errors }); return; }
      if (!enabledModeSet.has(body.mode)) { writeJson(response, 409, { code: 'AI_MODE_NOT_AVAILABLE', mode: body.mode }); return; }
      if (!hasGenerate) { writeJson(response, 503, { code: 'AI_NOT_ENABLED' }); return; }
      try {
        const artifact = await withTimeout(aiProvider.generate({ request: body, templates }), providerTimeoutMs);
        const artifactErrors = validateAIArtifact(artifact);
        artifactErrors.push(...validateArtifactAgainstRequest(artifact, body, templates));
        if (artifactErrors.length) { writeJson(response, 422, { code: 'INVALID_AI_ARTIFACT', errors: artifactErrors }); return; }
        writeJson(response, 200, artifact);
      } catch (error) {
        writeProviderError(response, error);
      }
      return;
    }
    if (request.method === 'POST' && request.url === '/reviews') {
      const body = await readJson(request);
      const errors = validateReviewRequest(body);
      if (errors.length) { writeJson(response, 400, { code: 'INVALID_REQUEST', errors }); return; }
      if (!enabledModeSet.has(body.mode)) { writeJson(response, 409, { code: 'AI_MODE_NOT_AVAILABLE', mode: body.mode }); return; }
      if (!hasReview) { writeJson(response, 503, { code: 'AI_NOT_ENABLED' }); return; }
      try {
        const result = await withTimeout(aiProvider.review({ request: body }), providerTimeoutMs);
        const resultErrors = validateReviewResult(result);
        resultErrors.push(...validateReviewAgainstRequest(result, body));
        if (resultErrors.length) { writeJson(response, 422, { code: 'INVALID_AI_ARTIFACT', errors: resultErrors }); return; }
        writeJson(response, 200, result);
      } catch (error) {
        writeProviderError(response, error);
      }
      return;
    }
    if (request.method === 'POST' && request.url === '/completions') {
      const body = await readJson(request);
      const errors = validateCompletionRequest(body);
      if (errors.length) { writeJson(response, 400, { code: 'INVALID_REQUEST', errors }); return; }
      if (!enabledModeSet.has(body.mode)) { writeJson(response, 409, { code: 'AI_MODE_NOT_AVAILABLE', mode: body.mode }); return; }
      if (!hasComplete) { writeJson(response, 503, { code: 'AI_NOT_ENABLED' }); return; }
      try {
        const result = await withTimeout(aiProvider.complete({ request: body }), providerTimeoutMs);
        const resultErrors = validateCompletionResult(result);
        resultErrors.push(...validateCompletionAgainstRequest(result, body));
        if (resultErrors.length) { writeJson(response, 422, { code: 'INVALID_AI_ARTIFACT', errors: resultErrors }); return; }
        writeJson(response, 200, result);
      } catch (error) {
        writeProviderError(response, error);
      }
      return;
    }
    if (request.method === 'POST' && request.url === '/artifacts/validate') {
      const errors = validateAIArtifact(await readJson(request));
      writeJson(response, errors.length ? 422 : 200, { valid: errors.length === 0, errors });
      return;
    }
    writeJson(response, 404, { code: 'NOT_FOUND' });
  });
}

function validateArtifactAgainstRequest(artifact, request, templates) {
  if (!artifact || typeof artifact !== 'object') return [];
  const errors = [];
  if (artifact.mode !== request.mode) errors.push('artifact mode must match request mode');
  if (artifact.source_draft_version !== request.draft_version) errors.push('artifact source_draft_version must match request draft_version');
  if (artifact.rule_version !== request.rule_version) errors.push('artifact rule_version must match request rule_version');
  if (artifact.output_kind !== request.output_kind) errors.push('artifact output_kind must match request output_kind');
  if (artifact.visibility !== request.visibility) errors.push('artifact visibility must match request visibility');
  const sourceIds = new Set(request.idea_segments.map((segment) => segment.id));
  for (const step of artifact.pseudocode ?? []) for (const ref of step.source_refs ?? []) if (!sourceIds.has(ref)) errors.push(`unknown source_ref: ${ref}`);
  const stepIds = new Set((artifact.pseudocode ?? []).map((step) => step.id));
  for (const mapping of artifact.code_mappings ?? []) if (!stepIds.has(mapping.step_id)) errors.push(`unknown code mapping step_id: ${mapping.step_id}`);
  const templateIds = new Set(templates.map((template) => template.id));
  if (artifact.template_id !== null && !templateIds.has(artifact.template_id)) errors.push('template_id must identify a configured server template');
  return errors;
}

function validateReviewAgainstRequest(result, request) {
  if (!result || typeof result !== 'object') return [];
  const errors = [];
  if (result.mode !== request.mode) errors.push('result mode must match request mode');
  if (result.draft_id !== request.draft_id) errors.push('result draft_id must match request draft_id');
  if (result.source_draft_version !== request.draft_version) errors.push('result source_draft_version must match request draft_version');
  if (result.rule_version !== request.rule_version) errors.push('result rule_version must match request rule_version');
  if (result.review_kind !== request.review_kind) errors.push('result review_kind must match request review_kind');
  if (result.visibility !== request.visibility) errors.push('result visibility must match request visibility');
  return errors;
}

function validateCompletionAgainstRequest(result, request) {
  if (!result || typeof result !== 'object') return [];
  const errors = [];
  if (result.mode !== request.mode) errors.push('result mode must match request mode');
  if (result.draft_id !== request.draft_id) errors.push('result draft_id must match request draft_id');
  if (result.source_draft_version !== request.draft_version) errors.push('result source_draft_version must match request draft_version');
  if (result.rule_version !== request.rule_version) errors.push('result rule_version must match request rule_version');
  if (result.visibility !== request.visibility) errors.push('result visibility must match request visibility');
  const range = result.replaced_range;
  const cursor = request.cursor;
  if (range && cursor) {
    const windowLines = 5;
    if (cursor.line < range.start_line - windowLines || cursor.line > range.end_line + windowLines) {
      errors.push('replaced_range must stay near the cursor');
    }
  }
  return errors;
}

function withTimeout(promise, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error('AI provider timed out');
      error.code = 'AI_PROVIDER_TIMEOUT';
      reject(error);
    }, timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

function writeProviderError(response, error) {
  if (error && error.code === 'AI_PROVIDER_TIMEOUT') {
    writeJson(response, 504, { code: 'AI_PROVIDER_TIMEOUT' });
    return;
  }
  writeJson(response, 502, { code: 'AI_PROVIDER_ERROR' });
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { return null; }
}

function writeJson(response, statusCode, body) {
  response.statusCode = statusCode;
  response.end(JSON.stringify(body));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createAIGateway().listen(8788, '127.0.0.1', () => console.log('[AlgoFlow] AI gateway skeleton: http://127.0.0.1:8788'));
}
