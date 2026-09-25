import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdeaSegments, rangeToOffsets, toCursor, WebAIClient } from '../src/ai-client.mjs';

test('client maps test marker and cursor/range helpers', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'X-AlgoFlow-Test-Data': 'true' } });
  try {
    const response = await new WebAIClient('http://example.test').requestReview({});
    assert.equal(response.isTestData, true);
    assert.deepEqual(toCursor(3, 4), { line: 3, char: 3 });
    assert.deepEqual(createIdeaSegments('a\n\nb'), [{ id: 'idea_segment_1', content: 'a' }, { id: 'idea_segment_3', content: 'b' }]);
    assert.deepEqual(rangeToOffsets('ab\ncd', { start_line: 1, start_char: 1, end_line: 2, end_char: 1 }), { from: 1, to: 4 });
  } finally { globalThis.fetch = originalFetch; }
});

test('client classifies unavailable provider', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ code: 'AI_NOT_ENABLED' }), { status: 503 });
  try { await assert.rejects(new WebAIClient('http://example.test').requestReview({}), (error) => error.code === 'AI_NOT_ENABLED' && error.status === 503); }
  finally { globalThis.fetch = originalFetch; }
});
