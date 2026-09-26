import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdeaSegments, rangeToOffsets, toCursor, WebAIClient } from '../src/ai-client.mjs';

const request = {
  mode: 'faithful_transform', draft_id: 'draft-test', draft_version: 1,
  language: 'cpp', rule_version: '1.0.0', problem_context: '统计',
  idea_segments: [{ id: 'idea-1', content: '累加' }], code: 'int count = 0;',
  output_kind: 'review', review_kind: 'risk', visibility: 'visible',
};

const result = {
  mode: request.mode, draft_id: request.draft_id, source_draft_version: request.draft_version,
  model_id: 'test-model', rule_version: request.rule_version, review_kind: request.review_kind,
  output_kind: 'review', diagnostics: [], visibility: request.visibility,
};

test('client maps test marker and cursor/range helpers', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(result), { status: 200, headers: { 'X-AlgoFlow-Test-Data': 'true' } });
  try {
    const response = await new WebAIClient('http://example.test', { allowTestData: true }).requestReview(request);
    assert.equal(response.isTestData, true);
    assert.deepEqual(toCursor(3, 4), { line: 3, char: 3 });
    assert.deepEqual(createIdeaSegments('a\n\nb', [], (() => { let index = 0; return () => `idea-${++index}`; })()), [{ id: 'idea-1', content: 'a' }, { id: 'idea-2', content: 'b' }]);
    assert.deepEqual(rangeToOffsets('ab\ncd', { start_line: 1, start_char: 1, end_line: 2, end_char: 1 }), { from: 1, to: 4 });
  } finally { globalThis.fetch = originalFetch; }
});

test('client classifies unavailable provider', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ code: 'AI_NOT_ENABLED' }), { status: 503 });
  try { await assert.rejects(new WebAIClient('http://example.test').requestReview({}), (error) => error.code === 'AI_NOT_ENABLED' && error.status === 503); }
  finally { globalThis.fetch = originalFetch; }
});

test('the browser uses a same-origin AI route by default', () => {
  assert.equal(new WebAIClient().baseUrl, '/ai-api');
});

test('native fetch receives the browser global as its receiver', async () => {
  const client = new WebAIClient('/ai-api', { fetchImpl: async function () {
    assert.equal(this, globalThis);
    return new Response(JSON.stringify(result));
  } });
  assert.deepEqual((await client.requestReview(request)).result, result);
});

test('inserting or reordering idea lines keeps their existing source IDs', () => {
  const original = createIdeaSegments('sort\nvisit');
  const inserted = createIdeaSegments('check\nsort\nvisit', original);
  assert.equal(inserted[1].id, original[0].id);
  assert.equal(inserted[2].id, original[1].id);
  const reordered = createIdeaSegments('visit\nsort\ncheck', inserted);
  assert.equal(reordered[0].id, original[1].id);
  assert.equal(new Set(reordered.map(item => item.id)).size, 3);
});

test('range offsets preserve CRLF rather than counting it as one character', () => {
  assert.deepEqual(rangeToOffsets('ab\r\ncd', { start_line: 2, start_char: 1, end_line: 2, end_char: 2 }), { from: 5, to: 6 });
});

test('range conversion rejects invalid and inverted coordinates', () => {
  for (const range of [
    { start_line: 0, start_char: 0, end_line: 1, end_char: 1 },
    { start_line: 1, start_char: 3, end_line: 1, end_char: 4 },
    { start_line: 2, start_char: 0, end_line: 1, end_char: 1 },
    { start_line: 1, start_char: 1, end_line: 1, end_char: 0 },
    { start_line: 1.5, start_char: 0, end_line: 2, end_char: 0 },
  ]) assert.throws(() => rangeToOffsets('ab\ncd', range));
});
