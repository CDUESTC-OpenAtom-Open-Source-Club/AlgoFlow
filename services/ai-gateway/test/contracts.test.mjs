import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createAIGateway } from '../src/server.mjs';
import {
  AI_MODES,
  DIAGNOSTIC_LEVELS,
  REVIEW_KINDS,
  validateAIArtifact,
  validateAIRequest,
  validateCompletionRequest,
  validateCompletionResult,
  validateReviewRequest,
  validateReviewResult
} from '../src/contracts.mjs';

const validRequest = {
  mode: 'faithful_transform',
  draft_id: 'draft-1',
  draft_version: 3,
  language: 'cpp',
  rule_version: '1.0.0',
  problem_context: 'Given intervals, choose a non-overlapping subset.',
  idea_segments: [
    { id: 'idea_segment_1', content: 'Sort intervals by right endpoint.' },
    { id: 'idea_segment_2', content: 'Select non-overlapping intervals.' }
  ],
  output_kind: 'pseudocode',
  visibility: 'visible'
};

const validArtifact = {
  mode: 'faithful_transform',
  pseudocode: [
    { id: 'step_1', step: 'Sort by right endpoint', source_refs: ['idea_segment_1'] },
    { id: 'step_2', step: 'Select non-overlapping intervals', source_refs: ['idea_segment_2'] }
  ],
  code_snippet: null,
  code_mappings: [],
  assumptions: [],
  missing_information: [],
  risk_flags: [],
  added_algorithm_steps: [],
  source_draft_version: 3,
  model_id: 'provider-disabled',
  rule_version: '1.0.0',
  output_kind: 'pseudocode',
  visibility: 'visible',
  template_id: null
};

const validReviewRequest = {
  mode: 'faithful_transform',
  draft_id: 'draft-1',
  draft_version: 3,
  language: 'cpp',
  rule_version: '1.0.0',
  review_kind: 'risk',
  problem_context: 'Given intervals, choose a non-overlapping subset.',
  idea_segments: [
    { id: 'idea_segment_1', content: 'Sort intervals by right endpoint.' }
  ],
  code: 'void choose(vector<Interval>& intervals) {\n  sort(intervals.begin(), intervals.end(), byRight);\n  \n}',
  visibility: 'visible'
};

const validReviewResult = {
  mode: 'faithful_transform',
  draft_id: 'draft-1',
  source_draft_version: 3,
  model_id: 'provider-disabled',
  rule_version: '1.0.0',
  review_kind: 'risk',
  diagnostics: [
    {
      id: 'diag_1',
      level: 'warning',
      range: { start_line: 3, start_char: 2, end_line: 3, end_char: 2 },
      problem: 'The selection loop is empty.',
      basis: 'The greedy selection step is not implemented.',
      suggestion: 'Track the last selected end and append non-overlapping intervals.'
    }
  ],
  visibility: 'visible'
};

const validCompletionRequest = {
  mode: 'faithful_transform',
  draft_id: 'draft-1',
  draft_version: 3,
  language: 'cpp',
  rule_version: '1.0.0',
  problem_context: 'Given intervals, choose a non-overlapping subset.',
  idea_segments: [
    { id: 'idea_segment_1', content: 'Sort intervals by right endpoint.' }
  ],
  code: 'void choose(vector<Interval>& intervals) {\n  sort(intervals.begin(), intervals.end(), byRight);\n  \n}',
  cursor: { line: 3, char: 2 },
  visibility: 'visible'
};

const validCompletionResult = {
  mode: 'faithful_transform',
  draft_id: 'draft-1',
  source_draft_version: 3,
  model_id: 'provider-disabled',
  rule_version: '1.0.0',
  replaced_range: { start_line: 3, start_char: 2, end_line: 3, end_char: 2 },
  suggestion_text: 'int last = -1;\n  for (auto& interval : intervals) { if (interval.start >= last) { pick(interval); last = interval.end; } }',
  source_refs: ['idea_segment_1'],
  visibility: 'visible'
};

test('AI request vectors match expected validity', async (t) => {
  const source = new URL('../../../packages/contracts/vectors/ai-requests.json', import.meta.url);
  const vectors = JSON.parse(await readFile(source, 'utf8'));
  for (const vector of vectors) {
    await t.test(vector.name, () => {
      assert.equal(validateAIRequest(vector.request).length === 0, vector.valid, vector.name);
    });
  }
});

test('AI artifact vectors match expected validity', async (t) => {
  const source = new URL('../../../packages/contracts/vectors/ai-artifacts.json', import.meta.url);
  const vectors = JSON.parse(await readFile(source, 'utf8'));
  for (const vector of vectors) {
    await t.test(vector.name, () => {
      assert.equal(validateAIArtifact(vector.artifact).length === 0, vector.valid, vector.name);
    });
  }
});

test('IDE review request vectors match expected validity', async (t) => {
  const source = new URL('../../../packages/contracts/vectors/ide-review-vectors.json', import.meta.url);
  const vectors = JSON.parse(await readFile(source, 'utf8'));
  for (const vector of vectors.requests) {
    await t.test(vector.name, () => {
      assert.equal(validateReviewRequest(vector.request).length === 0, vector.valid, vector.name);
    });
  }
});

test('IDE review result vectors match expected validity', async (t) => {
  const source = new URL('../../../packages/contracts/vectors/ide-review-vectors.json', import.meta.url);
  const vectors = JSON.parse(await readFile(source, 'utf8'));
  for (const vector of vectors.results) {
    await t.test(vector.name, () => {
      assert.equal(validateReviewResult(vector.result).length === 0, vector.valid, vector.name);
    });
  }
});

test('IDE completion request vectors match expected validity', async (t) => {
  const source = new URL('../../../packages/contracts/vectors/ide-completion-vectors.json', import.meta.url);
  const vectors = JSON.parse(await readFile(source, 'utf8'));
  for (const vector of vectors.requests) {
    await t.test(vector.name, () => {
      assert.equal(validateCompletionRequest(vector.request).length === 0, vector.valid, vector.name);
    });
  }
});

test('IDE completion result vectors match expected validity', async (t) => {
  const source = new URL('../../../packages/contracts/vectors/ide-completion-vectors.json', import.meta.url);
  const vectors = JSON.parse(await readFile(source, 'utf8'));
  for (const vector of vectors.results) {
    await t.test(vector.name, () => {
      assert.equal(validateCompletionResult(vector.result).length === 0, vector.valid, vector.name);
    });
  }
});

test('IDE review request-boundary vectors match expected validity', async (t) => {
  const source = new URL('../../../packages/contracts/vectors/ide-review-vectors.json', import.meta.url);
  const vectors = JSON.parse(await readFile(source, 'utf8'));
  for (const vector of vectors.against_request) {
    await t.test(vector.name, async () => {
      const server = createAIGateway({ aiProvider: { async review() { return vector.result; } } });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const response = await requestJson(server.address().port, 'POST', '/reviews', vector.request);
      await new Promise((resolve) => server.close(resolve));
      assert.equal(response.statusCode === 200, vector.valid, vector.name);
    });
  }
});

test('IDE completion request-boundary vectors match expected validity', async (t) => {
  const source = new URL('../../../packages/contracts/vectors/ide-completion-vectors.json', import.meta.url);
  const vectors = JSON.parse(await readFile(source, 'utf8'));
  for (const vector of vectors.against_request) {
    await t.test(vector.name, async () => {
      const server = createAIGateway({ aiProvider: { async complete() { return vector.result; } } });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const response = await requestJson(server.address().port, 'POST', '/completions', vector.request);
      await new Promise((resolve) => server.close(resolve));
      assert.equal(response.statusCode === 200, vector.valid, vector.name);
    });
  }
});

test('review and diagnostic enums stay identical to the JSON Schema source of truth', async () => {
  const source = new URL('../../../packages/contracts/schemas/domain.schema.json', import.meta.url);
  const schema = JSON.parse(await readFile(source, 'utf8'));
  assert.deepEqual([...REVIEW_KINDS], schema.$defs.reviewKind.enum);
  assert.deepEqual([...DIAGNOSTIC_LEVELS], schema.$defs.diagnosticLevel.enum);
});

test('accepts a review request with explicit mode, versions, and source code', () => {
  assert.deepEqual(validateReviewRequest(validReviewRequest), []);
});

for (const field of ['mode', 'draft_version', 'rule_version', 'review_kind', 'code', 'visibility']) {
  test(`rejects a review request missing required ${field}`, () => {
    const request = { ...validReviewRequest };
    delete request[field];
    assert.notDeepEqual(validateReviewRequest(request), [], `missing ${field}`);
  });
}

test('rejects a review result whose diagnostic omits the separated suggestion field', () => {
  // A diagnostic must carry its own suggestion text; it cannot smuggle user code back.
  assert.notDeepEqual(validateReviewResult({
    ...validReviewResult,
    diagnostics: [{ id: 'diag_1', level: 'error', problem: 'x', basis: 'y' }]
  }), []);
});

test('rejects a review result with a diagnostic lacking a basis', () => {
  assert.notDeepEqual(validateReviewResult({
    ...validReviewResult,
    diagnostics: [{ ...validReviewResult.diagnostics[0], basis: undefined }]
  }), []);
});

test('accepts a review result whose diagnostic is a global suggestion', () => {
  assert.deepEqual(validateReviewResult({
    ...validReviewResult,
    diagnostics: [{ ...validReviewResult.diagnostics[0], range: null }]
  }), []);
});

test('accepts a completion request with explicit cursor position', () => {
  assert.deepEqual(validateCompletionRequest(validCompletionRequest), []);
});

for (const field of ['mode', 'draft_version', 'rule_version', 'code', 'cursor', 'visibility']) {
  test(`rejects a completion request missing required ${field}`, () => {
    const request = { ...validCompletionRequest };
    delete request[field];
    assert.notDeepEqual(validateCompletionRequest(request), [], `missing ${field}`);
  });
}

test('rejects a completion that returns a complete main program', () => {
  assert.notDeepEqual(validateCompletionResult({
    ...validCompletionResult,
    suggestion_text: 'int main() { return 0; }'
  }), []);
});

test('rejects a completion with an empty suggestion text', () => {
  assert.notDeepEqual(validateCompletionResult({ ...validCompletionResult, suggestion_text: '' }), []);
});

test('rejects a completion result without source references', () => {
  const result = { ...validCompletionResult };
  delete result.source_refs;
  assert.notDeepEqual(validateCompletionResult(result), []);
});

test('AI gateway mode values stay identical to the JSON Schema source of truth', async () => {
  const source = new URL('../../../packages/contracts/schemas/domain.schema.json', import.meta.url);
  const schema = JSON.parse(await readFile(source, 'utf8'));
  assert.deepEqual([...AI_MODES], schema.$defs.aiMode.enum);
});

test('accepts an AI request with explicit mode, versions, and stable idea segment ids', () => {
  assert.deepEqual(validateAIRequest(validRequest), []);
});

for (const field of ['mode', 'draft_id', 'draft_version', 'language', 'rule_version', 'problem_context', 'output_kind', 'visibility']) {
  test(`rejects an AI request missing required ${field}`, () => {
    const request = { ...validRequest };
    delete request[field];
    assert.notDeepEqual(validateAIRequest(request), [], `missing ${field}`);
  });
}

test('rejects an AI request without a stable non-empty idea segment id', () => {
  const requestWithoutSegmentId = {
    ...validRequest,
    idea_segments: [{ id: '', content: 'segment without a stable id' }]
  };
  assert.notDeepEqual(validateAIRequest(requestWithoutSegmentId), [], 'missing idea segment id');
});

test('rejects duplicate idea segment ids', () => {
  const request = {
    ...validRequest,
    idea_segments: [
      { id: 'idea_segment_1', content: 'first' },
      { id: 'idea_segment_1', content: 'duplicate' }
    ]
  };
  assert.notDeepEqual(validateAIRequest(request), [], 'duplicate idea segment ids');
});

test('rejects provider secrets and other fields outside the request schema', () => {
  assert.notDeepEqual(validateAIRequest({
    ...validRequest,
    api_key: 'must-not-enter-client-contracts'
  }), []);
});

test('rejects an overlong problem_context', () => {
  const request = { ...validRequest, problem_context: 'A'.repeat(20001) };
  assert.notDeepEqual(validateAIRequest(request), [], 'overlong problem_context');
});

test('rejects a non-integer draft_version', () => {
  const request = { ...validRequest, draft_version: 1.5 };
  assert.notDeepEqual(validateAIRequest(request), [], 'non-integer draft_version');
});

test('accepts a faithful artifact whose every pseudocode step maps to source segments', () => {
  assert.deepEqual(validateAIArtifact(validArtifact), []);
});

test('accepts a bounded code snippet with pseudocode-to-code mappings', () => {
  const artifact = {
    ...validArtifact,
    output_kind: 'code_snippet',
    code_snippet: 'void sortIntervals(std::vector<Interval>& intervals) {\n  sort(intervals.begin(), intervals.end(), byRight);\n}',
    code_mappings: [{ step_id: 'step_1', start_line: 1, end_line: 3 }],
    template_id: 'interval-sort-fragment'
  };
  assert.deepEqual(validateAIArtifact(artifact), []);
});

test('rejects code snippet output without a step mapping', () => {
  assert.notDeepEqual(validateAIArtifact({
    ...validArtifact,
    output_kind: 'code_snippet',
    code_snippet: 'sort(intervals.begin(), intervals.end(), byRight);',
    code_mappings: []
  }), []);
});

test('rejects faithful artifacts that add algorithm steps', () => {
  assert.notDeepEqual(
    validateAIArtifact({ ...validArtifact, added_algorithm_steps: ['Invent a missing proof'] }),
    []
  );
});

test('rejects blank source references instead of accepting unmapped generated steps', () => {
  assert.notDeepEqual(validateAIArtifact({
    ...validArtifact,
    pseudocode: [{ id: 'step_1', step: 'Invent an implementation detail', source_refs: [''] }]
  }), []);
});

test('rejects complete submission-shaped code in faithful transform mode', () => {
  assert.notDeepEqual(validateAIArtifact({
    ...validArtifact,
    code_snippet: '#include <iostream>\nint main() { std::cout << 0; return 0; }'
  }), []);
});

for (const field of ['source_draft_version', 'model_id', 'rule_version']) {
  test(`rejects an artifact missing required ${field}`, () => {
    const artifact = { ...validArtifact };
    delete artifact[field];
    assert.notDeepEqual(validateAIArtifact(artifact), [], `missing ${field}`);
  });
}

test('rejects duplicate pseudocode step ids', () => {
  assert.notDeepEqual(validateAIArtifact({
    ...validArtifact,
    pseudocode: [
      { id: 'step_1', step: 'first', source_refs: ['idea_segment_1'] },
      { id: 'step_1', step: 'second', source_refs: ['idea_segment_2'] }
    ]
  }), []);
});

test('rejects a code mapping whose end line precedes its start line', () => {
  assert.notDeepEqual(validateAIArtifact({
    ...validArtifact,
    output_kind: 'code_snippet',
    code_snippet: 'sort(intervals.begin(), intervals.end());',
    code_mappings: [{ step_id: 'step_1', start_line: 5, end_line: 2 }]
  }), []);
});

test('AI gateway reports disabled AI instead of returning a mock artifact', async (t) => {
  const server = createAIGateway();
  t.after(() => server.close());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const status = await requestJson(address.port, 'GET', '/status');
  assert.equal(status.statusCode, 200);
  assert.deepEqual(status.body, {
    enabled: false,
    code: 'AI_NOT_ENABLED',
    capabilities: { transform: false, review: false, completion: false }
  });

  const response = await requestJson(address.port, 'POST', '/requests', validRequest);
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.body, { code: 'AI_NOT_ENABLED' });
});

test('AI gateway reports enabled when a provider is configured', async (t) => {
  const server = createAIGateway({ aiProvider: { async generate() { return validArtifact; } } });
  t.after(() => server.close());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const status = await requestJson(server.address().port, 'GET', '/status');
  assert.equal(status.statusCode, 200);
  assert.deepEqual(status.body, {
    enabled: true,
    code: 'AI_ENABLED',
    capabilities: { transform: true, review: false, completion: false }
  });
});

test('AI gateway delegates configured generation through the AIProvider port', async (t) => {
  let generationInput = null;
  const aiProvider = {
    async generate(input) {
      generationInput = input;
      return validArtifact;
    }
  };
  const templates = [{ id: 'interval-greedy-fragment', language: 'cpp', code: 'void chooseIntervals();' }];
  const server = createAIGateway({ aiProvider, templates });
  t.after(() => server.close());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const response = await requestJson(server.address().port, 'POST', '/requests', validRequest);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(generationInput, { request: validRequest, templates });
  assert.deepEqual(response.body, validArtifact);
});

test('AI gateway maps provider exceptions to AI_PROVIDER_ERROR', async (t) => {
  const server = createAIGateway({ aiProvider: { async generate() { throw new Error('provider down'); } } });
  t.after(() => server.close());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const response = await requestJson(server.address().port, 'POST', '/requests', validRequest);
  assert.equal(response.statusCode, 502);
  assert.deepEqual(response.body, { code: 'AI_PROVIDER_ERROR' });
});

test('AI gateway returns AI_PROVIDER_ERROR when generation exceeds the budget', async (t) => {
  const server = createAIGateway({
    aiProvider: { async generate() { await new Promise((resolve) => setTimeout(resolve, 500)); return validArtifact; } },
    timeoutMs: 20
  });
  t.after(() => server.close());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const response = await requestJson(server.address().port, 'POST', '/requests', validRequest);
  assert.equal(response.statusCode, 502);
  assert.deepEqual(response.body, { code: 'AI_PROVIDER_ERROR' });
});

test('AI gateway rejects provider output that cites ideas absent from the user draft', async (t) => {
  const aiProvider = {
    async generate() {
      return {
        ...validArtifact,
        pseudocode: [{ id: 'step_1', step: 'Replace the idea with a standard answer', source_refs: ['missing_segment'] }]
      };
    }
  };
  const server = createAIGateway({ aiProvider });
  t.after(() => server.close());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const response = await requestJson(server.address().port, 'POST', '/requests', validRequest);
  assert.equal(response.statusCode, 422);
  assert.equal(response.body.code, 'INVALID_AI_ARTIFACT');
  assert.ok(response.body.errors.some((error) => error.includes('unknown source_ref')));
});

test('AI gateway rejects provider output that adds algorithm steps in faithful mode', async (t) => {
  const aiProvider = {
    async generate() {
      return { ...validArtifact, added_algorithm_steps: ['Invent a proof'] };
    }
  };
  const server = createAIGateway({ aiProvider });
  t.after(() => server.close());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const response = await requestJson(server.address().port, 'POST', '/requests', validRequest);
  assert.equal(response.statusCode, 422);
  assert.equal(response.body.code, 'INVALID_AI_ARTIFACT');
});

test('AI gateway accepts and reports a configured template selected by the provider', async (t) => {
  const templates = [{ id: 'interval-sort-fragment', language: 'cpp', code: 'void sortIntervals();' }];
  const aiProvider = {
    async generate() {
      return {
        ...validArtifact,
        output_kind: 'code_snippet',
        code_snippet: 'void sortIntervals() {\n  sort(intervals.begin(), intervals.end(), byRight);\n}',
        code_mappings: [{ step_id: 'step_1', start_line: 1, end_line: 3 }],
        template_id: 'interval-sort-fragment'
      };
    }
  };
  const server = createAIGateway({ aiProvider, templates });
  t.after(() => server.close());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const response = await requestJson(server.address().port, 'POST', '/requests', {
    ...validRequest,
    output_kind: 'code_snippet'
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.template_id, 'interval-sort-fragment');
});

test('AI gateway rejects malformed requests before checking model availability', async (t) => {
  const server = createAIGateway();
  t.after(() => server.close());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const response = await requestJson(server.address().port, 'POST', '/requests', {
    ...validRequest,
    mode: 'not-a-contract-mode'
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.code, 'INVALID_REQUEST');
  assert.ok(response.body.errors.length > 0);
});

test('AI gateway keeps hint and full solution modes unavailable until explicitly implemented', async (t) => {
  const server = createAIGateway({ aiProvider: { async generate() { return validArtifact; } } });
  t.after(() => server.close());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  for (const mode of ['progressive_hint', 'full_solution']) {
    const response = await requestJson(server.address().port, 'POST', '/requests', {
      ...validRequest,
      mode
    });
    assert.equal(response.statusCode, 409);
    assert.deepEqual(response.body, { code: 'AI_MODE_NOT_AVAILABLE', mode });
  }
});

test('AI gateway keeps feasibility_analysis available when explicitly enabled', async (t) => {
  const aiProvider = {
    async generate() { return { ...validArtifact, mode: 'feasibility_analysis' }; }
  };
  const server = createAIGateway({ aiProvider, enabledModes: ['faithful_transform', 'feasibility_analysis'] });
  t.after(() => server.close());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const response = await requestJson(server.address().port, 'POST', '/requests', {
    ...validRequest,
    mode: 'feasibility_analysis'
  });
  assert.equal(response.statusCode, 200);
});

test('AI gateway validates artifacts through the dedicated endpoint', async (t) => {
  const server = createAIGateway();
  t.after(() => server.close());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const valid = await requestJson(server.address().port, 'POST', '/artifacts/validate', validArtifact);
  assert.equal(valid.statusCode, 200);
  assert.deepEqual(valid.body, { valid: true, errors: [] });

  const invalid = await requestJson(server.address().port, 'POST', '/artifacts/validate', {
    ...validArtifact,
    added_algorithm_steps: ['extra step']
  });
  assert.equal(invalid.statusCode, 422);
  assert.equal(invalid.body.valid, false);
  assert.ok(invalid.body.errors.length > 0);
});

test('AI gateway does not expose compilation or execution as an AI endpoint', async (t) => {
  const server = createAIGateway();
  t.after(() => server.close());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const response = await requestJson(server.address().port, 'POST', '/execute', {
    code: 'int main() { return 0; }'
  });
  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.body, { code: 'NOT_FOUND' });
});

test('AI gateway reports disabled review and completion capabilities', async (t) => {
  const server = createAIGateway();
  t.after(() => server.close());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  for (const [path, request] of [['/reviews', validReviewRequest], ['/completions', validCompletionRequest]]) {
    const response = await requestJson(port, 'POST', path, request);
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.body, { code: 'AI_NOT_ENABLED' });
  }
});

test('AI gateway delegates configured review through the AIProvider port', async (t) => {
  let reviewInput = null;
  const aiProvider = {
    async review(input) {
      reviewInput = input;
      return validReviewResult;
    }
  };
  const server = createAIGateway({ aiProvider });
  t.after(() => server.close());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const response = await requestJson(server.address().port, 'POST', '/reviews', validReviewRequest);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(reviewInput, { request: validReviewRequest });
  assert.deepEqual(response.body, validReviewResult);
});

test('AI gateway delegates configured completion through the AIProvider port', async (t) => {
  let completionInput = null;
  const aiProvider = {
    async complete(input) {
      completionInput = input;
      return validCompletionResult;
    }
  };
  const server = createAIGateway({ aiProvider });
  t.after(() => server.close());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const response = await requestJson(server.address().port, 'POST', '/completions', validCompletionRequest);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(completionInput, { request: validCompletionRequest });
  assert.deepEqual(response.body, validCompletionResult);
});

test('AI gateway rejects a completion that returns a full main program', async (t) => {
  const aiProvider = {
    async complete() {
      return { ...validCompletionResult, suggestion_text: '#include <iostream>\nint main() { return 0; }' };
    }
  };
  const server = createAIGateway({ aiProvider });
  t.after(() => server.close());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const response = await requestJson(server.address().port, 'POST', '/completions', validCompletionRequest);
  assert.equal(response.statusCode, 422);
  assert.equal(response.body.code, 'INVALID_AI_ARTIFACT');
});

test('AI gateway rejects a completion whose replaced range is far from the cursor', async (t) => {
  const aiProvider = {
    async complete() {
      return {
        ...validCompletionResult,
        replaced_range: { start_line: 400, start_char: 0, end_line: 400, end_char: 1 }
      };
    }
  };
  const server = createAIGateway({ aiProvider });
  t.after(() => server.close());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const response = await requestJson(server.address().port, 'POST', '/completions', validCompletionRequest);
  assert.equal(response.statusCode, 422);
  assert.equal(response.body.code, 'INVALID_AI_ARTIFACT');
  assert.ok(response.body.errors.some((error) => error.includes('within three lines of the cursor')));
});

const completionBoundaryCases = [
  { name: 'insertion at the cursor', start: [5, 4], end: [5, 4] },
  { name: 'cursor at the range start', start: [5, 4], end: [5, 8] },
  { name: 'cursor at the range end', start: [5, 0], end: [5, 4] },
  { name: 'cursor inside the character range', start: [5, 0], end: [5, 8] },
  { name: 'exact seven-line window', start: [2, 0], end: [8, 8] },
  { name: 'window clipped by the first line', cursor: { line: 1, char: 4 }, start: [1, 4], end: [4, 8] },
  { name: 'window clipped by the last line', cursor: { line: 9, char: 4 }, start: [6, 0], end: [9, 4] },
  { name: 'same-line range before the cursor', start: [5, 0], end: [5, 3], error: 'contain the cursor' },
  { name: 'same-line range after the cursor', start: [5, 5], end: [5, 8], error: 'contain the cursor' },
  { name: 'nearby range on the preceding line', start: [4, 0], end: [4, 8], error: 'contain the cursor' },
  { name: 'nearby range on the following line', start: [6, 0], end: [6, 8], error: 'contain the cursor' },
  { name: 'multiline range starting after the cursor character', start: [5, 5], end: [6, 8], error: 'contain the cursor' },
  { name: 'multiline range ending before the cursor character', start: [4, 0], end: [5, 3], error: 'contain the cursor' },
  { name: 'seven lines extending four lines above', start: [1, 0], end: [7, 8], error: 'within three lines' },
  { name: 'seven lines extending four lines below', start: [3, 0], end: [9, 8], error: 'within three lines' },
  { name: 'eight-line replacement', start: [1, 0], end: [8, 8], error: 'within three lines' },
  { name: 'range beyond the source lines', start: [5, 0], end: [10, 0], error: 'exceeds request code' },
  { name: 'range beyond the source characters', start: [5, 0], end: [5, 100], error: 'exceeds request code line' },
  { name: 'inverted line range', start: [6, 0], end: [4, 8], error: 'must not precede' },
  { name: 'inverted character range', start: [5, 8], end: [5, 0], error: 'must not precede' },
  {
    name: 'entire single-line file', code: 'work();', cursor: { line: 1, char: 3 },
    start: [1, 0], end: [1, 7], error: 'entire file'
  },
  {
    name: 'entire short multiline file', code: 'a();\nb();\nc();', cursor: { line: 2, char: 2 },
    start: [1, 0], end: [3, 4], error: 'entire file'
  },
  {
    name: 'entire file with trailing newline', code: 'a();\nb();\n', cursor: { line: 2, char: 2 },
    start: [1, 0], end: [3, 0], error: 'entire file'
  },
  {
    name: 'entire CRLF file', code: 'a();\r\nb();\r\n', cursor: { line: 2, char: 2 },
    start: [1, 0], end: [3, 0], error: 'entire file'
  },
  {
    name: 'CRLF local edit at end of line', code: 'a();\r\nb();\r\n', cursor: { line: 2, char: 4 },
    start: [2, 0], end: [2, 4]
  },
  { name: 'exactly 500 suggestion characters', start: [5, 4], end: [5, 4], suggestion: '// ' + 'x'.repeat(497) },
  { name: '501 suggestion characters', start: [5, 4], end: [5, 4], suggestion: '// ' + 'x'.repeat(498), error: 'too long' }
];

for (const boundary of completionBoundaryCases) {
  test(`AI gateway completion boundary: ${boundary.name}`, async (t) => {
    const request = {
      ...validCompletionRequest,
      code: boundary.code ?? Array(9).fill('  work();').join('\n'),
      cursor: boundary.cursor ?? { line: 5, char: 4 }
    };
    const result = {
      ...validCompletionResult,
      replaced_range: {
        start_line: boundary.start[0], start_char: boundary.start[1],
        end_line: boundary.end[0], end_char: boundary.end[1]
      },
      suggestion_text: boundary.suggestion ?? 'sort(intervals.begin(), intervals.end(), byRight);'
    };
    const server = createAIGateway({ aiProvider: { async complete() { return result; } } });
    t.after(() => server.close());
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const response = await requestJson(server.address().port, 'POST', '/completions', request);
    assert.equal(response.statusCode, boundary.error ? 422 : 200);
    if (boundary.error) {
      assert.equal(response.body.code, 'INVALID_AI_ARTIFACT');
      assert.ok(response.body.errors.some((error) => error.includes(boundary.error)), JSON.stringify(response.body));
    } else {
      assert.deepEqual(response.body, result);
    }
  });
}

for (const suggestion of [
  'signed main() { return 0; }',
  'auto main() -> int { return 0; }',
  'int/**/main() { return 0; }',
  'int (main)() { return 0; }',
  'int main/**/() { return 0; }',
  'int main// entry point\n() { return 0; }'
]) {
  test(`AI gateway rejects a completion containing ${JSON.stringify(suggestion)}`, async (t) => {
    const result = { ...validCompletionResult, suggestion_text: suggestion };
    assert.notDeepEqual(validateCompletionResult(result), []);
    const server = createAIGateway({ aiProvider: { async complete() { return result; } } });
    t.after(() => server.close());
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const response = await requestJson(server.address().port, 'POST', '/completions', validCompletionRequest);
    assert.equal(response.statusCode, 422);
    assert.equal(response.body.code, 'INVALID_AI_ARTIFACT');
  });
}

const providerEndpoints = [
  {
    path: '/requests', method: 'generate', request: validRequest, result: validArtifact,
    validate: validateAIArtifact,
    malformedFields: [
      { pseudocode: {} }, { pseudocode: [null] },
      { pseudocode: [{ ...validArtifact.pseudocode[0], source_refs: {} }] },
      { code_mappings: {} }, { code_mappings: [null] },
      { model_id: 42 }
    ]
  },
  {
    path: '/reviews', method: 'review', request: validReviewRequest, result: validReviewResult,
    validate: validateReviewResult,
    malformedFields: [
      { diagnostics: {} }, { diagnostics: 'invalid' }, { diagnostics: [null] },
      { diagnostics: [{ ...validReviewResult.diagnostics[0], range: { start_line: { toString: null }, end_line: 3 } }] },
      { diagnostics: [{ ...validReviewResult.diagnostics[0], range: { ...validReviewResult.diagnostics[0].range, start_line: '3' } }] },
      { model_id: 42 }
    ]
  },
  {
    path: '/completions', method: 'complete', request: validCompletionRequest, result: validCompletionResult,
    validate: validateCompletionResult,
    malformedFields: [
      { source_refs: {} }, { source_refs: [null] }, { replaced_range: null },
      { replaced_range: { start_line: { toString: null }, end_line: 3 } },
      { replaced_range: { ...validCompletionResult.replaced_range, start_char: '2' } },
      { suggestion_text: {} }, { model_id: 42 }
    ]
  }
];

for (const endpoint of providerEndpoints) {
  test(`AI gateway classifies malformed JSON from ${endpoint.method} as INVALID_AI_ARTIFACT`, async (t) => {
    let providerResult;
    const server = createAIGateway({ aiProvider: { async [endpoint.method]() { return providerResult; } } });
    t.after(() => server.close());
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const malformedResults = [
      null, [], 'invalid', 42, true, {},
      ...endpoint.malformedFields.map((fields) => ({ ...endpoint.result, ...fields }))
    ];
    for (const result of malformedResults) {
      await t.test(JSON.stringify(result), async () => {
        providerResult = JSON.parse(JSON.stringify(result));
        const validationErrors = endpoint.validate(providerResult);
        assert.notDeepEqual(validationErrors, []);
        const response = await requestJson(server.address().port, 'POST', endpoint.path, endpoint.request);
        assert.equal(response.statusCode, 422);
        assert.equal(response.body.code, 'INVALID_AI_ARTIFACT');
        assert.deepEqual(response.body.errors, validationErrors);
      });
    }
    providerResult = endpoint.result;
    const recovery = await requestJson(server.address().port, 'POST', endpoint.path, endpoint.request);
    assert.equal(recovery.statusCode, 200);
    assert.deepEqual(recovery.body, endpoint.result);
  });

  for (const [failureName, invoke] of [
    ['synchronous exception', () => { throw new Error('private provider details'); }],
    ['provider TypeError', async () => { throw new TypeError('private provider details'); }],
    ['network failure', async () => { throw Object.assign(new Error('private connection details'), { code: 'ECONNRESET' }); }],
    ['provider timeout rejection', async () => { throw Object.assign(new Error('private timeout details'), { code: 'AI_PROVIDER_TIMEOUT' }); }]
  ]) {
    test(`AI gateway maps ${endpoint.method} ${failureName} to AI_PROVIDER_ERROR`, async (t) => {
      const server = createAIGateway({ aiProvider: { [endpoint.method]: invoke } });
      t.after(() => server.close());
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const response = await requestJson(server.address().port, 'POST', endpoint.path, endpoint.request);
      assert.equal(response.statusCode, 502);
      assert.deepEqual(response.body, { code: 'AI_PROVIDER_ERROR' });
    });
  }

  test(`AI gateway validates direct JSON returns from ${endpoint.method}`, async (t) => {
    let providerResult = endpoint.result;
    const server = createAIGateway({ aiProvider: { [endpoint.method]() { return providerResult; } } });
    t.after(() => server.close());
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const valid = await requestJson(server.address().port, 'POST', endpoint.path, endpoint.request);
    assert.equal(valid.statusCode, 200);
    assert.deepEqual(valid.body, endpoint.result);
    providerResult = null;
    const invalid = await requestJson(server.address().port, 'POST', endpoint.path, endpoint.request);
    assert.equal(invalid.statusCode, 422);
    assert.equal(invalid.body.code, 'INVALID_AI_ARTIFACT');
  });
}

test('AI gateway rejects a completion that cites ideas absent from the request', async (t) => {
  const aiProvider = {
    async complete() {
      return { ...validCompletionResult, source_refs: ['idea_segment_not_requested'] };
    }
  };
  const server = createAIGateway({ aiProvider });
  t.after(() => server.close());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const response = await requestJson(server.address().port, 'POST', '/completions', validCompletionRequest);
  assert.equal(response.statusCode, 422);
  assert.equal(response.body.code, 'INVALID_AI_ARTIFACT');
  assert.ok(response.body.errors.some((error) => error.includes('unknown source_ref')));
});

test('AI gateway rejects a review result that drops the problem basis', async (t) => {
  const aiProvider = {
    async review() {
      return {
        ...validReviewResult,
        diagnostics: [{ ...validReviewResult.diagnostics[0], basis: undefined }]
      };
    }
  };
  const server = createAIGateway({ aiProvider });
  t.after(() => server.close());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const response = await requestJson(server.address().port, 'POST', '/reviews', validReviewRequest);
  assert.equal(response.statusCode, 422);
  assert.equal(response.body.code, 'INVALID_AI_ARTIFACT');
});

test('AI gateway returns a classified timeout when the review provider stalls', async (t) => {
  const aiProvider = {
    async review() { return new Promise(() => {}); }
  };
  const server = createAIGateway({ aiProvider, timeoutMs: 20 });
  t.after(() => server.close());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const response = await requestJson(server.address().port, 'POST', '/reviews', validReviewRequest);
  assert.equal(response.statusCode, 502);
  assert.deepEqual(response.body, { code: 'AI_PROVIDER_ERROR' });
});

test('AI gateway returns a classified timeout when the completion provider stalls', async (t) => {
  const aiProvider = {
    async complete() { return new Promise(() => {}); }
  };
  const server = createAIGateway({ aiProvider, timeoutMs: 20 });
  t.after(() => server.close());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const response = await requestJson(server.address().port, 'POST', '/completions', validCompletionRequest);
  assert.equal(response.statusCode, 502);
  assert.deepEqual(response.body, { code: 'AI_PROVIDER_ERROR' });
});

test('AI gateway reports enabled capabilities on the status endpoint', async (t) => {
  const aiProvider = { async review() { return validReviewResult; } };
  const server = createAIGateway({ aiProvider });
  t.after(() => server.close());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const status = await requestJson(server.address().port, 'GET', '/status');
  assert.equal(status.body.enabled, true);
  assert.deepEqual(status.body.capabilities, { transform: false, review: true, completion: false });
});

function requestJson(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      method,
      path,
      headers: body === undefined ? {} : { 'content-type': 'application/json' }
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        try {
          resolve({
            statusCode: response.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('error', reject);
    if (body !== undefined) request.end(JSON.stringify(body));
    else request.end();
  });
}
