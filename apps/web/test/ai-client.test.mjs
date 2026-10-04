import test from 'node:test';
import assert from 'node:assert/strict';
import { artifactFromGateway, buildAIRequest, reconcileIdeaSegments } from '../src/ai-client.mjs';
import { assertReviewResult } from '../src/sync-client.mjs';

const draft = {
  id: 'draft-1', version: 3, language: 'cpp',
  idea_segments: [
    { id: 'idea-segment-a', content: 'Sort by endpoint.', position: 0 },
    { id: 'idea-segment-b', content: 'Choose compatible intervals.', position: 1 },
  ],
};

const validResponse = {
  mode: 'faithful_transform',
  pseudocode: [{ id: 'step-1', step: 'Sort by endpoint.', source_refs: ['idea-segment-a'] }],
  code_snippet: null,
  code_mappings: [],
  assumptions: [],
  missing_information: [],
  risk_flags: [],
  added_algorithm_steps: [],
  source_draft_version: 3,
  model_id: 'provider-model',
  rule_version: '1.0.0',
  output_kind: 'pseudocode',
  visibility: 'visible',
  template_id: null,
};

test('accepts a complete Gateway artifact and creates local entity metadata', () => {
  const artifact = artifactFromGateway(validResponse, draft, 'web-client');
  assert.equal(artifact.draft_id, draft.id);
  assert.equal(artifact.version, 0);
  assert.equal(artifact.last_modified_client_id, 'web-client');
});

for (const [name, mutate] of [
  ['rejects non-string assumptions', (value) => ({ ...value, assumptions: [7] })],
  ['rejects unknown source references', (value) => ({ ...value, pseudocode: [{ ...value.pseudocode[0], source_refs: ['ghost'] }] })],
  ['rejects response entity metadata', (value) => ({ ...value, version: 'bad' })],
  ['rejects a response draft mismatch', (value) => ({ ...value, draft_id: 'other' })],
  ['rejects a response rule version mismatch', (value) => ({ ...value, rule_version: 'other' })],
]) {
  test(name, () => assert.throws(() => artifactFromGateway(mutate(validResponse), draft, 'web-client'), /INVALID_AI_ARTIFACT/));
}

test('builds requests from persisted segment ids across reordering', () => {
  const request = buildAIRequest(draft, { 'idea.md': 'Choose compatible intervals.\nSort by endpoint.', 'main.cpp': '', 'cases.txt': '' }, 'faithful_transform');
  assert.deepEqual(request.idea_segments.map((segment) => segment.id), ['idea-segment-b', 'idea-segment-a']);
});

test('keeps old IDs when a new idea line is inserted before them', () => {
  const segments = reconcileIdeaSegments(draft.idea_segments, 'New thought.\nSort by endpoint.\nChoose compatible intervals.');
  assert.equal(segments[1].id, 'idea-segment-a');
  assert.equal(segments[2].id, 'idea-segment-b');
  assert.notEqual(segments[0].id, 'idea-segment-a');
});

test('accepts an independent review result with diagnostics and ranges', () => {
  const review = {
    id: 'review-1', version: 1, server_sequence: 2, created_at: '2026-09-15T00:00:00.000Z', updated_at: '2026-09-15T00:00:00.000Z',
    deleted: false, last_modified_client_id: 'web', draft_id: 'draft-1', mode: 'faithful_transform', source_draft_version: 1,
    model_id: 'review-model', rule_version: '1.0.0', review_kind: 'complexity', visibility: 'visible',
    diagnostics: [{ id: 'd1', level: 'info', range: { start_line: 1, start_char: 0, end_line: 1, end_char: 3 }, problem: 'O(n log n)', basis: 'Sort dominates', suggestion: 'Document complexity' }]
  };
  assert.doesNotThrow(() => assertReviewResult(review));
  for (const reviewKind of ['explanation', 'risk', 'complexity']) {
    assert.doesNotThrow(() => assertReviewResult({ ...review, review_kind: reviewKind }));
  }
});

test('rejects review results with inverted ranges', () => {
  assert.throws(() => assertReviewResult({
    id: 'review-1', version: 1, server_sequence: 2, created_at: '2026-09-15T00:00:00.000Z', updated_at: '2026-09-15T00:00:00.000Z',
    deleted: false, last_modified_client_id: 'web', draft_id: 'draft-1', mode: 'faithful_transform', source_draft_version: 1,
    model_id: 'review-model', rule_version: '1.0.0', review_kind: 'risk', visibility: 'visible',
    diagnostics: [{ id: 'd1', level: 'error', range: { start_line: 3, start_char: 0, end_line: 2, end_char: 0 }, problem: 'Bad range', basis: 'Invalid', suggestion: 'Fix' }]
  }), /INVALID_REVIEW_RESULT/);
});

test('rejects review results with incomplete diagnostic content or ranges', () => {
  const review = {
    id: 'review-1', version: 1, server_sequence: 2, created_at: '2026-09-15T00:00:00.000Z', updated_at: '2026-09-15T00:00:00.000Z',
    deleted: false, last_modified_client_id: 'web', draft_id: 'draft-1', mode: 'faithful_transform', source_draft_version: 1,
    model_id: 'review-model', rule_version: '1.0.0', review_kind: 'risk', visibility: 'visible',
    diagnostics: [{ id: 'd1', level: 'warning', range: null, problem: 'Potential issue', basis: 'Rule matched', suggestion: 'Review this line' }]
  };
  assert.throws(() => assertReviewResult({ ...review, diagnostics: [{ ...review.diagnostics[0], basis: ' ' }] }), /INVALID_REVIEW_RESULT/);
  assert.throws(() => assertReviewResult({ ...review, diagnostics: [{ ...review.diagnostics[0], range: { start_line: 0, start_char: 0, end_line: 1, end_char: 0 } }] }), /INVALID_REVIEW_RESULT/);
  assert.throws(() => assertReviewResult({ ...review, updated_at: '2026-09-15T00:00:00+08:00' }), /INVALID_REVIEW_RESULT/);
});
