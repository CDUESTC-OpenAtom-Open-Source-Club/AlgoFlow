import { createAIGateway } from './src/server.mjs';

const TEST_DATA_HEADER = 'X-AlgoFlow-Test-Data';
const TEST_DATA_VALUE = 'true';
const DEFAULT_HOST = process.env.ALGFLOW_TEST_AI_HOST ?? '127.0.0.1';
const DEFAULT_PORT = Number.parseInt(process.env.ALGFLOW_TEST_AI_PORT ?? '8789', 10);
const scenario = process.env.ALGFLOW_TEST_AI_SCENARIO ?? 'success';
const allowedScenarios = new Set(['success', 'empty', 'invalid', 'delay', 'failure']);

if (!allowedScenarios.has(scenario)) throw new Error(`Unknown test scenario: ${scenario}`);
if (!Number.isInteger(DEFAULT_PORT) || DEFAULT_PORT < 0 || DEFAULT_PORT > 65535) throw new Error('Test AI port must be between 0 and 65535');

const provider = createTestProvider(scenario);
const server = createAIGateway({
  aiProvider: provider,
  timeoutMs: Number.parseInt(process.env.ALGFLOW_TEST_AI_TIMEOUT_MS ?? '30000', 10),
  responseHeaders: {
    [TEST_DATA_HEADER]: TEST_DATA_VALUE,
    'Cache-Control': 'no-store'
  }
});

server.listen(DEFAULT_PORT, DEFAULT_HOST, () => {
  console.log(`[AlgoFlow] test AI provider (测试数据) listening at http://${DEFAULT_HOST}:${DEFAULT_PORT}`);
  console.log(`[AlgoFlow] scenario=${scenario}`);
});

function createTestProvider(selectedScenario) {
  return {
    async generate({ request, signal }) {
      await applyScenario(selectedScenario, signal);
      if (selectedScenario === 'empty') return {
        mode: request.mode, pseudocode: [], code_snippet: null, code_mappings: [],
        assumptions: [], missing_information: ['test-data: no steps returned'], risk_flags: [],
        added_algorithm_steps: [], source_draft_version: request.draft_version,
        model_id: 'test-data-provider', rule_version: request.rule_version,
        output_kind: request.output_kind, visibility: request.visibility, template_id: null
      };
      return {
        mode: request.mode,
        pseudocode: [{ id: 'test_step_1', step: 'test-data: preserve the supplied step', source_refs: [request.idea_segments[0].id] }],
        code_snippet: null, code_mappings: [], assumptions: ['test-data'], missing_information: [],
        risk_flags: [], added_algorithm_steps: [], source_draft_version: request.draft_version,
        model_id: 'test-data-provider', rule_version: request.rule_version,
        output_kind: request.output_kind, visibility: request.visibility, template_id: null
      };
    },
    async review({ request, signal }) {
      await applyScenario(selectedScenario, signal);
      if (selectedScenario === 'invalid') return { diagnostics: 'invalid' };
      if (selectedScenario === 'empty') return baseReview(request, []);
      return baseReview(request, [{
        id: 'test_diag_1', level: 'info', range: null,
        problem: 'test-data: fixed review result', basis: 'test-data: fixed provider', suggestion: 'test-data: review manually'
      }]);
    },
    async complete({ request, signal }) {
      await applyScenario(selectedScenario, signal);
      if (selectedScenario === 'empty') return {
        mode: request.mode, draft_id: request.draft_id, source_draft_version: request.draft_version,
        model_id: 'test-data-provider', rule_version: request.rule_version, output_kind: request.output_kind,
        replaced_range: { start_line: request.cursor.line, start_char: request.cursor.char,
          end_line: request.cursor.line, end_char: request.cursor.char },
        suggestion_text: '// test-data: no suggestion', source_refs: [request.idea_segments[0].id], visibility: request.visibility
      };
      if (selectedScenario === 'invalid') return { suggestion_text: 'int main() {}' };
      return {
        mode: request.mode, draft_id: request.draft_id, source_draft_version: request.draft_version,
        model_id: 'test-data-provider', rule_version: request.rule_version, output_kind: request.output_kind,
        replaced_range: { start_line: request.cursor.line, start_char: request.cursor.char,
          end_line: request.cursor.line, end_char: request.cursor.char },
        suggestion_text: '// test-data: local completion', source_refs: [request.idea_segments[0].id], visibility: request.visibility
      };
    }
  };
}

function baseReview(request, diagnostics) {
  return {
    mode: request.mode, draft_id: request.draft_id, source_draft_version: request.draft_version,
    model_id: 'test-data-provider', rule_version: request.rule_version, review_kind: request.review_kind,
    output_kind: request.output_kind, diagnostics, visibility: request.visibility
  };
}

async function applyScenario(selectedScenario, signal) {
  if (selectedScenario === 'failure') throw new Error('test provider failure');
  if (selectedScenario !== 'delay') return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 5000);
    const abort = () => { clearTimeout(timer); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}
