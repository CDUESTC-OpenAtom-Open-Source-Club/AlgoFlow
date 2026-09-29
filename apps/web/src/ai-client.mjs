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
}

/** @param {import('./types').Draft} draft @param {import('./types').Documents} documents @param {import('./types').Mode} mode */
export function buildAIRequest(draft, documents, mode) {
  const ideaSegments = documents['idea.md'].split('\n').map((content, position) => ({
    id: `idea_segment_${position + 1}`, content: content.trim(),
  })).filter((segment) => segment.content.length > 0);
  return {
    mode, draft_id: draft.id, draft_version: draft.version, language: draft.language,
    rule_version: '1.0.0', problem_context: documents['idea.md'] || draft.title,
    idea_segments: ideaSegments, output_kind: 'pseudocode', visibility: 'visible',
  };
}

/** @param {Record<string, unknown>} response @param {import('./types').Draft} draft @param {string} clientId @returns {import('./types').AIArtifact} */
export function artifactFromGateway(response, draft, clientId) {
  const required = ['mode', 'pseudocode', 'code_snippet', 'code_mappings', 'assumptions', 'missing_information', 'risk_flags', 'added_algorithm_steps', 'source_draft_version', 'model_id', 'rule_version', 'output_kind', 'visibility', 'template_id'];
  if (required.some((field) => !(field in response))) throw new Error('INVALID_AI_ARTIFACT');
  const now = new Date().toISOString();
  const artifact = /** @type {import('./types').AIArtifact} */ (/** @type {unknown} */ ({
    id: crypto.randomUUID(), version: 0, server_sequence: 0, created_at: now, updated_at: now,
    deleted: false, last_modified_client_id: clientId, draft_id: draft.id, ...response,
  })) ;
  if (artifact.mode !== 'faithful_transform' || artifact.source_draft_version !== draft.version || artifact.output_kind !== 'pseudocode' || artifact.visibility !== 'visible') {
    throw new Error('INVALID_AI_ARTIFACT');
  }
  return artifact;
}
