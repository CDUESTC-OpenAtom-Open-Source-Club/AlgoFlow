import { assertAIArtifact } from './sync-client.mjs';
import { assertReviewResult } from './storage.mjs';

const DEFAULT_AI_BASE = import.meta.env?.VITE_AI_GATEWAY_BASE ?? 'http://127.0.0.1:8788';

export class LocalAIClient {
  /** @param {string} [baseUrl] */
  constructor(baseUrl = DEFAULT_AI_BASE) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  /** @param {Record<string, unknown>} request */
  async generate(request) {
    const response = await fetch(`${this.baseUrl}/requests`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.code ?? 'AI_REQUEST_FAILED');
    return result;
  }

  /** @param {Record<string, unknown>} request */
  async review(request) {
    const response = await fetch(`${this.baseUrl}/reviews`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.code ?? 'AI_REVIEW_FAILED');
    return result;
  }
}

/** @param {import('./types').Draft} draft @param {import('./types').Documents} documents @param {import('./types').Mode} mode */
export function buildAIRequest(draft, documents, mode) {
  const ideaSegments = reconcileIdeaSegments(draft.idea_segments ?? [], documents['idea.md'])
    .map((segment) => ({ id: segment.id, content: segment.content }));
  if (ideaSegments.length === 0) throw new Error('AI_IDEA_REQUIRED');
  return {
    mode, draft_id: draft.id, draft_version: draft.version, language: draft.language,
    rule_version: '1.0.0', problem_context: documents['idea.md'] || draft.title,
    idea_segments: ideaSegments, output_kind: 'pseudocode', visibility: 'visible',
  };
}

/** @param {import('./types').Draft} draft @param {import('./types').Documents} documents @param {import('./types').Mode} mode @param {import('./types').ReviewKind} reviewKind */
export function buildReviewRequest(draft, documents, mode, reviewKind) {
  return {
    mode, draft_id: draft.id, draft_version: draft.version, language: draft.language,
    rule_version: '1.0.0', code: documents['main.cpp'], idea: documents['idea.md'], review_kind: reviewKind, visibility: 'visible',
  };
}

/** @param {import('./types').IdeaSegment[]} existing @param {string} idea @returns {import('./types').IdeaSegment[]} */
export function reconcileIdeaSegments(existing, idea) {
  const previousByContent = /** @type {Map<string, import('./types').IdeaSegment[]>} */ (new Map());
  const previousByPosition = /** @type {Map<number, import('./types').IdeaSegment>} */ (new Map());
  for (const segment of existing) {
    const content = segment.content.trim();
    if (!content) continue;
    const matches = previousByContent.get(content) ?? [];
    matches.push(segment);
    previousByContent.set(content, matches);
    previousByPosition.set(segment.position, segment);
  }
  const used = new Set();
  const lines = idea.split('\n').map((raw) => raw.trim()).filter((raw) => raw.length > 0);
  const remainingContents = new Map();
  for (const raw of lines) remainingContents.set(raw, (remainingContents.get(raw) ?? 0) + 1);
  return lines.map((raw, index) => {
    remainingContents.set(raw, remainingContents.get(raw) - 1);
    const contentMatches = previousByContent.get(raw) ?? [];
    const sameContent = contentMatches.find((segment) => !used.has(segment.id));
    const samePosition = previousByPosition.get(index);
    const positionReservedForLater = samePosition && (remainingContents.get(samePosition.content.trim()) ?? 0) > 0;
    const reused = sameContent ?? (samePosition && !used.has(samePosition.id) && !positionReservedForLater ? samePosition : undefined);
    const id = reused?.id ?? `idea_segment_${crypto.randomUUID()}`;
    used.add(id);
    return { id, content: raw, position: index };
  });
}

/** @param {Record<string, unknown>} response @param {import('./types').Draft} draft @param {string} clientId @param {string[]} [sourceSegmentIds] @param {string} [ruleVersion] @returns {import('./types').AIArtifact} */
export function artifactFromGateway(response, draft, clientId, sourceSegmentIds = (draft.idea_segments ?? []).map(/** @param {import('./types').IdeaSegment} segment */ (segment) => segment.id), ruleVersion = '1.0.0') {
  const required = ['mode', 'pseudocode', 'code_snippet', 'code_mappings', 'assumptions', 'missing_information', 'risk_flags', 'added_algorithm_steps', 'source_draft_version', 'model_id', 'rule_version', 'output_kind', 'visibility', 'template_id'];
  const entityFields = ['id', 'version', 'server_sequence', 'created_at', 'updated_at', 'deleted', 'last_modified_client_id', 'draft_id'];
  const allowed = new Set(required);
  if (!response || typeof response !== 'object' || Array.isArray(response) || required.some((field) => !(field in response)) || Object.keys(response).some((field) => !allowed.has(field)) || entityFields.some((field) => field in response)) {
    throw new Error('INVALID_AI_ARTIFACT');
  }
  const now = new Date().toISOString();
  const artifact = /** @type {import('./types').AIArtifact} */ (/** @type {unknown} */ ({
    ...response, id: crypto.randomUUID(), version: 0, server_sequence: 0, created_at: now, updated_at: now,
    deleted: false, last_modified_client_id: clientId, draft_id: draft.id,
  }));
  assertAIArtifact(artifact);
  if (artifact.mode !== 'faithful_transform' || artifact.source_draft_version !== draft.version || artifact.rule_version !== ruleVersion || artifact.output_kind !== 'pseudocode' || artifact.visibility !== 'visible') {
    throw new Error('INVALID_AI_ARTIFACT');
  }
  const sourceIds = new Set(sourceSegmentIds);
  if (artifact.pseudocode.some((step) => step.source_refs.some((sourceRef) => !sourceIds.has(sourceRef)))) {
    throw new Error('INVALID_AI_ARTIFACT');
  }
  return artifact;
}

/** @param {Record<string, unknown>} response @param {import('./types').Draft} draft @param {string} clientId @param {import('./types').Mode} mode @param {import('./types').ReviewKind} reviewKind @param {string} ruleVersion @returns {import('./types').ReviewResult} */
export function reviewResultFromGateway(response, draft, clientId, mode, reviewKind, ruleVersion = '1.0.0') {
  const required = ['mode', 'source_draft_version', 'model_id', 'rule_version', 'review_kind', 'diagnostics', 'visibility'];
  const entityFields = ['id', 'version', 'server_sequence', 'created_at', 'updated_at', 'deleted', 'last_modified_client_id', 'draft_id'];
  const allowed = new Set(required);
  if (!response || typeof response !== 'object' || Array.isArray(response) || required.some((field) => !(field in response)) ||
    Object.keys(response).some((field) => !allowed.has(field)) || entityFields.some((field) => field in response)) {
    throw new Error('INVALID_REVIEW_RESULT');
  }
  const now = new Date().toISOString();
  const result = /** @type {import('./types').ReviewResult} */ (/** @type {unknown} */ ({
    ...response, id: crypto.randomUUID(), version: 0, server_sequence: 0, created_at: now, updated_at: now,
    deleted: false, last_modified_client_id: clientId, draft_id: draft.id,
  }));
  assertReviewResult(result);
  if (result.mode !== mode || result.source_draft_version !== draft.version || result.rule_version !== ruleVersion ||
    result.review_kind !== reviewKind || result.visibility !== 'visible') throw new Error('INVALID_REVIEW_RESULT');
  return result;
}
