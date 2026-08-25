import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createAIGateway } from '../src/server.mjs';
import { AI_MODES, validateAIArtifact, validateAIRequest } from '../src/contracts.mjs';

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

test('AI artifact vectors match expected validity', async () => {
  const source = new URL('../../../packages/contracts/vectors/ai-artifacts.json', import.meta.url);
  const vectors = JSON.parse(await readFile(source, 'utf8'));
  for (const vector of vectors) {
    assert.equal(validateAIArtifact(vector.artifact).length === 0, vector.valid, vector.name);
  }
});

test('AI gateway mode values stay identical to the JSON Schema source of truth', async () => {
  const source = new URL('../../../packages/contracts/schemas/domain.schema.json', import.meta.url);
  const schema = JSON.parse(await readFile(source, 'utf8'));
  assert.deepEqual([...AI_MODES], schema.$defs.aiMode.enum);
});

test('accepts an AI request with explicit mode, versions, and stable idea segment ids', () => {
  assert.deepEqual(validateAIRequest(validRequest), []);
});

for (const field of ['mode', 'draft_version', 'language', 'rule_version', 'problem_context', 'output_kind', 'visibility']) {
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

test('rejects provider secrets and other fields outside the request schema', () => {
  assert.notDeepEqual(validateAIRequest({
    ...validRequest,
    api_key: 'must-not-enter-client-contracts'
  }), []);
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

test('AI gateway reports disabled AI instead of returning a mock artifact', async (t) => {
  const server = createAIGateway();
  t.after(() => server.close());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const status = await requestJson(address.port, 'GET', '/status');
  assert.equal(status.statusCode, 200);
  assert.deepEqual(status.body, { enabled: false, code: 'AI_NOT_ENABLED' });

  const response = await requestJson(address.port, 'POST', '/requests', validRequest);
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.body, { code: 'AI_NOT_ENABLED' });
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
