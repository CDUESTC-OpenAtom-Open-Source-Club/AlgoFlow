import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { validateAIArtifact, validateAIRequest } from './contracts.mjs';

export function createAIGateway({ aiProvider = null, templates = [], enabledModes = ['faithful_transform'], timeoutMs = 30000 } = {}) {
  const enabledModeSet = new Set(enabledModes);
  const hasProvider = aiProvider !== null && typeof aiProvider.generate === 'function';
  return createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (request.method === 'GET' && request.url === '/status') {
      response.end(JSON.stringify({ enabled: hasProvider, code: hasProvider ? 'AI_ENABLED' : 'AI_NOT_ENABLED' }));
      return;
    }
    if (request.method === 'POST' && request.url === '/requests') {
      const body = await readJson(request);
      const errors = validateAIRequest(body);
      if (errors.length) { writeJson(response, 400, { code: 'INVALID_REQUEST', errors }); return; }
      if (!enabledModeSet.has(body.mode)) { writeJson(response, 409, { code: 'AI_MODE_NOT_AVAILABLE', mode: body.mode }); return; }
      if (!hasProvider) { writeJson(response, 503, { code: 'AI_NOT_ENABLED' }); return; }
      try {
        const artifact = await generateWithTimeout(aiProvider, body, templates, timeoutMs);
        const artifactErrors = validateAIArtifact(artifact);
        artifactErrors.push(...validateArtifactAgainstRequest(artifact, body, templates));
        if (artifactErrors.length) { writeJson(response, 422, { code: 'INVALID_AI_ARTIFACT', errors: artifactErrors }); return; }
        writeJson(response, 200, artifact);
      } catch (error) {
        if (error !== null && typeof error === 'object' && error.code === 'AI_TIMEOUT') {
          writeJson(response, 504, { code: 'AI_PROVIDER_TIMEOUT' });
        } else {
          writeJson(response, 502, { code: 'AI_PROVIDER_ERROR' });
        }
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

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { return null; }
}

async function generateWithTimeout(aiProvider, request, templates, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error('AI provider timed out');
      error.code = 'AI_TIMEOUT';
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([aiProvider.generate({ request, templates }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function writeJson(response, statusCode, body) {
  response.statusCode = statusCode;
  response.end(JSON.stringify(body));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createAIGateway().listen(8788, '127.0.0.1', () => console.log('[AlgoFlow] AI gateway skeleton: http://127.0.0.1:8788'));
}
