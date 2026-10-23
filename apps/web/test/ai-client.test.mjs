import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AIClientError, artifactFromGateway, canUseTestData, createIdeaSegments, parseAIArtifactResult, parseCompletionResult, parseReviewResult, rangeToOffsets, toCursor, transformErrorMessage, WebAIClient } from '../src/ai-client.mjs';
import { assertAIArtifact } from '../src/sync-client.mjs';

const reviewVectors = JSON.parse(readFileSync(new URL('../../../packages/contracts/vectors/ide-review-vectors.json', import.meta.url), 'utf8'));
const completionVectors = JSON.parse(readFileSync(new URL('../../../packages/contracts/vectors/ide-completion-vectors.json', import.meta.url), 'utf8'));

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

test('client preserves hint diagnostics from the shared contract', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    ...result,
    diagnostics: [{ id: 'hint-1', level: 'hint', range: null, problem: 'p', basis: 'b', suggestion: 's' }],
  }), { status: 200 });
  try {
    const response = await new WebAIClient('http://example.test').requestReview(request);
    assert.equal(response.result.diagnostics[0].level, 'hint');
  } finally { globalThis.fetch = originalFetch; }
});

test('client classifies unavailable provider', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ code: 'AI_NOT_ENABLED' }), { status: 503 });
  try { await assert.rejects(new WebAIClient('http://example.test').requestReview({}), (error) => error.code === 'AI_NOT_ENABLED' && error.status === 503); }
  finally { globalThis.fetch = originalFetch; }
});

test('release client rejects a marked test response even when the payload is valid', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(result), {
    status: 200,
    headers: { 'X-AlgoFlow-Test-Data': 'true' },
  });
  try {
    await assert.rejects(
      new WebAIClient('http://example.test', { allowTestData: false }).requestReview(request),
      (error) => error.code === 'AI_NOT_ENABLED' && error.status === 503 && error.isTestData === true,
    );
  } finally { globalThis.fetch = originalFetch; }
});

test('client does not infer test data from a model name without the response header', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ...result, model_id: 'test-data-provider' }), { status: 200 });
  try {
    const response = await new WebAIClient('http://example.test').requestReview(request);
    assert.equal(response.isTestData, false);
  } finally { globalThis.fetch = originalFetch; }
});

test('release build gate wins over an explicit test-data option', () => {
  assert.equal(canUseTestData(true, false), false);
  assert.equal(canUseTestData(false, true), false);
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

test('web client validates shared review and completion result vectors including invalid enums and legacy payloads', () => {
  for (const vector of reviewVectors.results) {
    if (vector.valid) assert.doesNotThrow(() => parseReviewResult(vector.result), vector.name);
    else assert.throws(() => parseReviewResult(vector.result), vector.name);
  }
  for (const vector of reviewVectors.against_request) {
    if (vector.valid) assert.doesNotThrow(() => parseReviewResult(vector.result, vector.request), vector.name);
    else assert.throws(() => parseReviewResult(vector.result, vector.request), vector.name);
  }
  for (const vector of completionVectors.results) {
    if (vector.valid) assert.doesNotThrow(() => parseCompletionResult(vector.result), vector.name);
    else assert.throws(() => parseCompletionResult(vector.result), vector.name);
  }
  for (const vector of completionVectors.against_request) {
    if (vector.valid) assert.doesNotThrow(() => parseCompletionResult(vector.result, vector.request), vector.name);
    else assert.throws(() => parseCompletionResult(vector.result, vector.request), vector.name);
  }
});

test('web client enforces shared review and completion test response markers', async () => {
  for (const vector of reviewVectors.test_data_responses) {
    const client = new WebAIClient('http://example.test', {
      allowTestData: vector.allow_test_data,
      fetchImpl: async () => new Response(JSON.stringify(result), { status: 200, headers: vector.headers }),
    });
    if (vector.accepted) {
      const response = await client.requestReview(request);
      assert.equal(response.isTestData, vector.is_test_data, vector.name);
    } else {
      await assert.rejects(
        client.requestReview(request),
        (error) => error.code === vector.expected_error_code && error.isTestData === vector.is_test_data,
        vector.name,
      );
    }
  }
  for (const vector of completionVectors.test_data_responses) {
    const completionRequest = completionVectors.requests[0].request;
    const completionResult = completionVectors.results[0].result;
    const client = new WebAIClient('http://example.test', {
      allowTestData: vector.allow_test_data,
      fetchImpl: async () => new Response(JSON.stringify(completionResult), { status: 200, headers: vector.headers }),
    });
    if (vector.accepted) {
      const response = await client.requestCompletion(completionRequest);
      assert.equal(response.isTestData, vector.is_test_data, vector.name);
    } else {
      await assert.rejects(
        client.requestCompletion(completionRequest),
        (error) => error.code === vector.expected_error_code && error.isTestData === vector.is_test_data,
        vector.name,
      );
    }
  }
});

// issue #21: the Web transform path against the shared contract vectors.
const artifactVectors = JSON.parse(readFileSync(new URL('../../../packages/contracts/vectors/ai-artifacts.json', import.meta.url), 'utf8'));
const entityMetadata = { id: 'artifact-1', version: 0, server_sequence: 0, created_at: '2026-10-23T00:00:00.000Z', updated_at: '2026-10-23T00:00:00.000Z', deleted: false, last_modified_client_id: 'web-test', draft_id: 'draft-test' };
function transformRequestFor(artifact) {
  const refs = [...new Set((Array.isArray(artifact.pseudocode) ? artifact.pseudocode : []).flatMap(step => Array.isArray(step?.source_refs) ? step.source_refs : []))].filter(ref => typeof ref === 'string' && ref.length > 0);
  return { mode: artifact.mode, draft_id: 'draft-test', draft_version: artifact.source_draft_version, language: 'cpp', rule_version: artifact.rule_version,
    problem_context: 'p', idea_segments: (refs.length ? refs : ['idea_segment_1']).map(id => ({ id, content: id })), output_kind: artifact.output_kind, visibility: artifact.visibility };
}
for (const vector of artifactVectors) {
  test(`Web transform contract layer: ${vector.name}`, () => {
    const request = transformRequestFor(vector.artifact);
    const accept = () => {
      const parsed = parseAIArtifactResult(structuredClone(vector.artifact), request);
      assertAIArtifact({ ...parsed, ...entityMetadata }, new Set(request.idea_segments.map(segment => segment.id)));
    };
    if (vector.valid) assert.doesNotThrow(accept); else assert.throws(accept);
  });
}

test('Web transform policy keeps only visible results of the selected mode', () => {
  const valid = artifactVectors.find(vector => vector.valid && vector.artifact.mode === 'faithful_transform' && vector.artifact.visibility === 'visible').artifact;
  const draft = { id: 'draft-test', version: valid.source_draft_version, ai_mode: 'faithful_transform' };
  const ids = valid.pseudocode.flatMap(step => step.source_refs);
  assert.doesNotThrow(() => artifactFromGateway(valid, draft, 'web-test', ids, valid.rule_version, valid.output_kind));
  assert.throws(() => artifactFromGateway(valid, { ...draft, ai_mode: 'full_solution' }, 'web-test', ids, valid.rule_version, valid.output_kind), /INVALID_AI_ARTIFACT/);
  assert.throws(() => artifactFromGateway({ ...valid, visibility: 'hidden' }, draft, 'web-test', ids, valid.rule_version, valid.output_kind), /INVALID_AI_ARTIFACT/);
  assert.throws(() => artifactFromGateway(valid, draft, 'web-test', ['other-id'], valid.rule_version, valid.output_kind), /INVALID_AI_ARTIFACT/);
});

const transformRequest = { mode: 'faithful_transform', draft_id: 'd', draft_version: 1, language: 'cpp', rule_version: '1.0.0', problem_context: 'p',
  idea_segments: [{ id: 's1', content: 'a' }], output_kind: 'pseudocode', visibility: 'visible' };
const hangingFetch = (_url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }));

test('Web transform: a user cancel stays an AbortError and maps to a cancel message', async () => {
  const controller = new AbortController();
  const pending = new WebAIClient('http://x', { fetchImpl: hangingFetch, timeoutMs: 60000 }).requestTransform(transformRequest, { signal: controller.signal });
  controller.abort();
  const error = await pending.catch(caught => caught);
  assert.equal(error.name, 'AbortError');
  assert.equal(transformErrorMessage(error), '已取消本次忠实转换，未保存任何结果。');
});

test('Web transform: an unanswered request times out as AI_PROVIDER_TIMEOUT', async () => {
  const error = await new WebAIClient('http://x', { fetchImpl: hangingFetch, timeoutMs: 20 }).requestTransform(transformRequest).catch(caught => caught);
  assert.ok(error instanceof AIClientError);
  assert.equal(error.code, 'AI_PROVIDER_TIMEOUT');
});

test('Web transform: HTTP and network failures map to actionable codes; local guard codes are never shown raw', async () => {
  const cases = [[503, 'AI_NOT_ENABLED'], [502, 'AI_PROVIDER_ERROR'], [504, 'AI_PROVIDER_TIMEOUT'], [422, 'INVALID_AI_ARTIFACT'], [409, 'AI_MODE_NOT_AVAILABLE'], [400, 'INVALID_REQUEST']];
  for (const [status, code] of cases) {
    const client = new WebAIClient('http://x', { fetchImpl: async () => new Response('{}', { status }) });
    const error = await client.requestTransform(transformRequest).catch(caught => caught);
    assert.equal(error.code, code, String(status));
    assert.ok(transformErrorMessage(error).length > 0 && !/^[A-Z_]+$/.test(transformErrorMessage(error)));
  }
  const offline = await new WebAIClient('http://x', { fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }).requestTransform(transformRequest).catch(caught => caught);
  assert.equal(offline.code, 'NETWORK_ERROR');
  for (const code of ['DRAFT_CHANGED_RETRY_AI', 'INVALID_AI_ARTIFACT']) assert.doesNotMatch(transformErrorMessage(new Error(code)), /^[A-Z_]+$/);
});
