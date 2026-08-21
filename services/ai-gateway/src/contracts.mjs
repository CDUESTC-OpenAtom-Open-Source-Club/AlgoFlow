export const AI_MODES = new Set([
  'faithful_transform',
  'feasibility_analysis',
  'progressive_hint',
  'full_solution'
]);

export function validateAIRequest(request) {
  const errors = [];
  if (!request || typeof request !== 'object') return ['request must be an object'];
  if (!AI_MODES.has(request.mode)) errors.push('mode is invalid or missing');
  if (!request.draft_id) errors.push('draft_id is required');
  if (!Number.isInteger(request.draft_version) || request.draft_version < 0) errors.push('draft_version must be a non-negative integer');
  if (!Array.isArray(request.idea_segments) || request.idea_segments.length === 0) errors.push('idea_segments must not be empty');
  return errors;
}

export function validateAIArtifact(artifact) {
  const errors = [];
  if (!artifact || typeof artifact !== 'object') return ['artifact must be an object'];
  if (!AI_MODES.has(artifact.mode)) errors.push('mode is invalid or missing');
  if (!Array.isArray(artifact.pseudocode)) {
    errors.push('pseudocode must be an array');
  } else {
    artifact.pseudocode.forEach((step, index) => {
      if (!step.step || !Array.isArray(step.source_refs) || step.source_refs.length === 0) {
        errors.push(`pseudocode[${index}] requires step and source_refs`);
      }
    });
  }
  if (!Array.isArray(artifact.added_algorithm_steps)) errors.push('added_algorithm_steps must be an array');
  if (artifact.mode === 'faithful_transform' && artifact.added_algorithm_steps?.length > 0) {
    errors.push('faithful_transform cannot contain added_algorithm_steps');
  }
  return errors;
}
