import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assignRewriteLines, compareRewrite, compareSourceFromArtifact, resolveRewriteMapping, rewriteFingerprint, selectionLines } from '../src/rewrite-compare.mjs';
import { BrowserRewriteMappingRepository } from '../src/rewrite-mapping-storage.mjs';
import { artifactFromGateway, buildAIRequest } from '../src/ai-client.mjs';
import { memoryStorage } from './ai-fixtures.mjs';
import { validateAIRequest } from '../../../services/ai-gateway/src/contracts.mjs';

const vectors = JSON.parse(readFileSync(new URL('../../../packages/contracts/vectors/rewrite-compare.json', import.meta.url), 'utf8'));

test('rewrite comparison matches the shared vectors', () => {
  for (const vector of vectors.compare) {
    assert.deepEqual(compareRewrite(vector.source, vector.rewrite, vector.rewrite_mappings), vector.expected, vector.name);
  }
});

test('rewrite partition edits match the shared vectors', () => {
  for (const vector of vectors.assign) {
    assert.deepEqual(assignRewriteLines(vector.mappings, vector.start, vector.end, vector.step_id), vector.expected, vector.name);
  }
});

test('rewrite fingerprint and selection lines match the shared vectors', () => {
  for (const vector of vectors.fingerprint) assert.equal(rewriteFingerprint(vector.text), vector.expected, JSON.stringify(vector.text));
  for (const vector of vectors.selection) assert.deepEqual(selectionLines(vector.text, vector.from, vector.to), vector.expected, vector.name);
});

test('a stored partition applies only to its artifact and is outdated after the rewrite changes', () => {
  const record = { draft_id: 'd', artifact_id: 'a1', rewrite_fingerprint: rewriteFingerprint('x;\ny;'), mappings: [{ step_id: 's', start_line: 1, end_line: 1 }], updated_at: '2026-10-23T00:00:00.000Z' };
  assert.equal(resolveRewriteMapping(record, 'a1', 'x;\r\ny;').status, 'current');
  assert.equal(resolveRewriteMapping(record, 'a1', 'x;\ny;\nz;').status, 'outdated');
  assert.deepEqual(resolveRewriteMapping(record, 'a2', 'x;\ny;'), { status: 'empty', mappings: [] });
  assert.deepEqual(resolveRewriteMapping(null, 'a1', ''), { status: 'empty', mappings: [] });
});

test('partition storage keeps one local record per draft and drops damaged data', () => {
  const storage = memoryStorage();
  const repository = new BrowserRewriteMappingRepository({ storage });
  repository.save('d1', 'a1', 'x;', [{ step_id: 's1', start_line: 1, end_line: 1 }]);
  repository.save('d2', 'a9', 'y;', []);
  const replaced = repository.save('d1', 'a2', 'x;', [{ step_id: 's2', start_line: 1, end_line: 1 }]);
  assert.equal(repository.load('d1')?.artifact_id, 'a2');
  assert.equal(replaced.rewrite_fingerprint, rewriteFingerprint('x;'));
  repository.removeDraft('d1');
  assert.equal(repository.load('d1'), null);
  assert.equal(repository.load('d2')?.artifact_id, 'a9');
  storage.setItem('algoflow.rewrite-mappings.v1', '[{"draft_id":"d3"},{"draft_id":"d4","artifact_id":"a","rewrite_fingerprint":"f","updated_at":"t","mappings":[{"step_id":"s","start_line":0,"end_line":1}]}]');
  assert.equal(repository.load('d3'), null);
  assert.equal(repository.load('d4'), null);
  storage.setItem('algoflow.rewrite-mappings.v1', '{broken');
  assert.equal(repository.load('d2'), null);
});

test('partition data never enters the draft or the sync queue', () => {
  const storage = memoryStorage();
  new BrowserRewriteMappingRepository({ storage }).save('draft-local', 'a1', 'x;', [{ step_id: 's', start_line: 1, end_line: 1 }]);
  assert.deepEqual([...storage.entries.keys()], ['algoflow.rewrite-mappings.v1']);
});

test('code_snippet transform request and artifact keep the requested output kind', () => {
  const draft = { id: 'draft-local', version: 2, language: 'cpp', title: 't', idea_segments: [{ id: 'idea-1', content: 'sum' }], ai_mode: 'faithful_transform' };
  const documents = { 'main.cpp': 'int main() {}', 'idea.md': 'sum', 'cases.txt': '', 'rewrite.cpp': '' };
  assert.equal(buildAIRequest(draft, documents, 'faithful_transform').output_kind, 'pseudocode');
  const request = buildAIRequest(draft, documents, 'faithful_transform', 'code_snippet');
  assert.equal(request.output_kind, 'code_snippet');
  // Phone-synced segments carry position; the closed request schema must still accept the request.
  const synced = buildAIRequest({ ...draft, idea_segments: [{ id: 'idea-1', content: 'sum', position: 0 }] }, documents, 'faithful_transform', 'code_snippet');
  assert.deepEqual(validateAIRequest(synced), []);
  assert.deepEqual(synced.idea_segments, [{ id: 'idea-1', content: 'sum' }]);
  const response = {
    mode: 'faithful_transform', pseudocode: [{ id: 'step_1', step: 'sum', source_refs: ['idea-1'] }],
    code_snippet: 'total += x;', code_mappings: [{ step_id: 'step_1', start_line: 1, end_line: 1 }],
    assumptions: [], missing_information: [], risk_flags: [], added_algorithm_steps: [], source_draft_version: 2,
    model_id: 'fixture', rule_version: '1.0.0', output_kind: 'code_snippet', visibility: 'visible', template_id: null,
  };
  const artifact = artifactFromGateway(response, draft, 'web-client', ['idea-1'], '1.0.0', 'code_snippet');
  assert.deepEqual(compareSourceFromArtifact(artifact), { steps: [{ id: 'step_1', step: 'sum' }], code_snippet: 'total += x;', code_mappings: [{ step_id: 'step_1', start_line: 1, end_line: 1 }] });
  assert.throws(() => artifactFromGateway(response, draft, 'web-client', ['idea-1'], '1.0.0', 'pseudocode'), /INVALID_AI_ARTIFACT/);
  assert.throws(() => artifactFromGateway({ ...response, code_mappings: [{ step_id: 'step_1', start_line: 1, end_line: 2 }] }, draft, 'web-client', ['idea-1'], '1.0.0', 'code_snippet'), /INVALID_AI_ARTIFACT/);
  assert.equal(compareSourceFromArtifact({ ...artifact, output_kind: 'pseudocode', code_snippet: null, code_mappings: [] }), null);
});
