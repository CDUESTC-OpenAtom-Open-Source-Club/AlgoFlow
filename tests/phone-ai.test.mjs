// Executes the actual platform-neutral ArkTS implementation with the existing
// Node type transformer. SDK stubs are NOT device or real RDB validation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { runInThisContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { validateCompletionFragment } from '../packages/contracts/cpp-fragment.mjs';
const root = resolve('entry/src/main/ets');
// In-memory FormKit/preferences stand-ins for service card tests; not device validation.
const cardKit = { prefs: new Map(), forms: [], updates: [], failList: false };
const cardPreferences = {
  async getPreferences() {
    return { async put(key, value) { cardKit.prefs.set(key, value); }, async flush() {},
      async get(key, fallback) { return cardKit.prefs.has(key) ? cardKit.prefs.get(key) : fallback; } };
  },
  getPreferencesSync() {
    return { getSync(key, fallback) { return cardKit.prefs.has(key) ? cardKit.prefs.get(key) : fallback; } };
  },
  removePreferencesFromCacheSync() {}
};
const cardFormKit = {
  formBindingData: { createFormBindingData(data) { return { data: JSON.parse(JSON.stringify(data)) }; } },
  formProvider: {
    async getPublishedRunningFormInfos() {
      if (cardKit.failList) throw new Error('form service unavailable');
      return cardKit.forms.map(formId => ({ formId }));
    },
    async updateForm(formId, binding) { cardKit.updates.push({ formId, data: binding.data }); }
  },
  formInfo: {}
};
function loader(debug = true, http = {}) {
  const cache = new Map();
  const stubs = {
    '@kit.AbilityKit': {}, '@kit.BasicServicesKit': {},
    '@kit.FormKit': cardFormKit, '@ohos.data.preferences': { default: cardPreferences }, '@ohos.router': { default: {} },
    BuildProfile: { DEBUG: debug }, '@ohos.net.http': { default: http },
    '@kit.PerformanceAnalysisKit': { hilog: { info() {}, warn() {}, error() {} } },
    '@kit.ArkTS': { util: { generateRandomUUID: randomUUID } },
    '@kit.ArkData': { relationalStore: { SecurityLevel: { S1: 1 } } },
  };
  function load(file) {
    file = resolve(root, file.endsWith('.ets') ? file : file + '.ets');
    if (cache.has(file)) return cache.get(file);
    const module = { exports: {} }; cache.set(file, module.exports);
    let code = stripTypeScriptTypes(readFileSync(file, 'utf8'), { mode: 'transform' });
    const names = [];
    code = code.replace(/import\s+\{([^}]+)\}\s+from\s+'([^']+)';/g, (_, members, name) => `const {${members}} = require('${name}');`)
      .replace(/import\s+(\w+)\s+from\s+'([^']+)';/g, (_, member, name) => `const ${member} = require('${name}').default;`)
      .replace(/export (class|async function|function|const|let|var) (\w+)/g, (_, kind, name) => { names.push(name); return `${kind} ${name}`; });
    code += `\nObject.assign(exports, {${names.join(',')}});`;
    runInThisContext(`(function(require,module,exports){${code}\n})`, { filename: file })(name => {
      if (name in stubs) return stubs[name];
      if (name.startsWith('.')) return load(resolve(dirname(file), name));
      throw new Error('Unstubbed SDK: ' + name);
    }, module, module.exports);
    cache.set(file, module.exports); return module.exports;
  }
  return load;
}
const load = loader();
const M = load('domain/IDEAIModels');
const { parseIDEResult, safeFragment } = load('domain/IDEAIContract');
const { IDEAISession } = load('application/IDEAISession');
const { resultSlot, decodeAIRecord, RdbAIResultRepository } = load('platform/RdbAIResultRepository');
const vectors = JSON.parse(readFileSync('packages/contracts/vectors/ide-completion-vectors.json'));
function recordFor(request, capability = 'completion') {
  const record = new M.IDERecord(); record.id = randomUUID(); record.capability = capability;
  record.context = Object.assign(new M.IDEContext(), { draftId: request.draft_id, version: request.draft_version, code: request.code,
    idea: 'Sort', segments: request.idea_segments, problemContext: request.problem_context });
  record.cursor = request.cursor; return record;
}
const request = vectors.requests[0].request;
const artifact = vectors.results[0].result;
const reviewVectors = JSON.parse(readFileSync('packages/contracts/vectors/ide-review-vectors.json'));
for (const vector of reviewVectors.results) {
  test('phone shared review shape: ' + vector.name, () => {
    const record = recordFor({ ...request, draft_id: vector.result.draft_id, draft_version: vector.result.source_draft_version,
      code: Array(5).fill(' '.repeat(100)).join('\n') }, 'review');
    record.reviewKind = ['explanation', 'risk', 'complexity'].includes(vector.result.review_kind) ? vector.result.review_kind : 'risk';
    if (vector.valid) assert.doesNotThrow(() => parseIDEResult(JSON.stringify(vector.result), record));
    else assert.throws(() => parseIDEResult(JSON.stringify(vector.result), record));
  });
}
test('phone review parser accepts the shared hint diagnostic level', () => {
  const result = { ...reviewVectors.results[0].result, diagnostics: [{ ...reviewVectors.results[0].result.diagnostics[0], level: 'hint', range: null }] };
  const record = recordFor({ ...request, draft_id: result.draft_id, draft_version: result.source_draft_version }, 'review');
  record.reviewKind = result.review_kind;
  assert.doesNotThrow(() => parseIDEResult(JSON.stringify(result), record));
});
test('completion rejects bad types, provenance, cursor exclusion, 501 chars and full-file replacement', () => {
  const record = recordFor(request);
  for (const patch of [{ suggestion_text: {} }, { suggestion_text: 'x'.repeat(501) }, { source_refs: ['other'] },
    { source_draft_version: 4 }, { replaced_range: { start_line: 1, start_char: 0, end_line: 1, end_char: 1 } },
    { replaced_range: { start_line: 1, start_char: 0, end_line: 4, end_char: 1 } }]) {
    assert.throws(() => parseIDEResult(JSON.stringify({ ...artifact, ...patch }), record));
  }
  record.context.code = Array(10).fill('abcd').join('\n'); record.cursor = { line: 5, char: 2 };
  for (const range of [{ start_line: 1, start_char: 0, end_line: 5, end_char: 2 }, { start_line: 5, start_char: 2, end_line: 9, end_char: 0 }]) {
    assert.throws(() => parseIDEResult(JSON.stringify({ ...artifact, replaced_range: range }), record));
  }
});
for (const vector of vectors.fragments) {
  test('phone shared C++ vector: ' + vector.name, () => assert.equal(safeFragment(vector.source), vector.valid));
}
for (const vector of vectors.against_request) {
  test('phone request-relative vector: ' + vector.name, () => assert.throws(() => parseIDEResult(JSON.stringify(vector.result), recordFor(vector.request))));
}
for (const vector of vectors.results) {
  test('phone shared completion shape: ' + vector.name, () => {
    const record = recordFor(request);
    if (!vector.valid) assert.throws(() => parseIDEResult(JSON.stringify(vector.result), record));
    else assert.doesNotThrow(() => parseIDEResult(JSON.stringify(vector.result), record));
  });
}
for (const source of ['int x = 1;', '#define X 1', 'int main() {}', '// main\nint x;', '"#define main";',
  'R"(main #define)";', 'ma\\\nin();', '%:define X 1', '/* unfinished', "int n = 1'000;", '//ok\r#define X', 'αmain = 1;']) {
  test('phone/shared lexical parity ' + JSON.stringify(source), () => assert.equal(safeFragment(source), validateCompletionFragment(source).length === 0));
}
function fixture() {
  const pending = []; let aborts = 0;
  const provider = { cancel() { aborts++; }, request() { return new Promise(resolve => pending.push(resolve)); } };
  const slots = new Map();
  const repo = { async list() { return []; }, async removeDraft() { slots.clear(); }, async save(r, latest) {
    const key = `${r.context.draftId}/${resultSlot(r)}/${r.isTestData}`;
    if (latest || slots.get(key)?.id === r.id) slots.set(key, structuredClone(r));
  } };
  const session = new IDEAISession(provider, repo);
  return { session, repo, pending, slots, aborts: () => aborts };
}
const reply = () => Object.assign(new M.IDEReply(), { body: JSON.stringify(artifact) });
for (const change of ['code', 'idea', 'draftId', 'file', 'version', 'mode', 'cancel', 'dispose', 'new-request']) {
  test('phone ignores late response after ' + change, async () => {
    const f = fixture(), context = recordFor(request).context;
    await f.session.setContext(context);
    const work = f.session.request('completion', 'explanation', request.cursor);
    if (change === 'cancel' || change === 'dispose') f.session[change]();
    else if (change === 'new-request') f.session.request('completion', 'explanation', request.cursor);
    else await f.session.setContext({ ...context, [change]: change === 'version' ? 4 : 'changed' });
    f.pending[0](reply()); await work;
    assert.ok(f.aborts() > 1);
    assert.equal(f.session.records.some(r => f.session.canAccept(r)), false);
  });
}

test('phone issues one request per operation and late success or failure never re-arms acceptance', async () => {
  const pending = [];
  let calls = 0;
  const provider = {
    cancel() {},
    request() { calls++; return new Promise((resolve, reject) => pending.push({ resolve, reject })); }
  };
  const repo = { async list() { return []; }, async save() {}, async removeDraft() {} };
  const session = new IDEAISession(provider, repo);
  const context = recordFor(request).context;
  await session.setContext(context);
  const first = session.request('completion', 'explanation', request.cursor);
  await new Promise(resolve => setImmediate(resolve));
  const second = session.request('completion', 'explanation', request.cursor);
  assert.equal(calls, 2);
  pending[0].resolve(reply());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(session.records.some(record => session.canAccept(record)), false);
  pending[1].reject(new Error('late provider failure'));
  await Promise.all([first, second]);
  assert.equal(session.records.some(record => session.canAccept(record)), false);
  assert.equal(session.records.every(record => record.stale || record.state !== 'success'), true);
});

test('phone provisional loading records never enter the normal cache partition', async () => {
  const f = fixture(); const context = recordFor(request).context;
  await f.session.setContext(context);
  const work = f.session.request('completion', 'explanation', request.cursor);
  await new Promise(resolve => setImmediate(resolve));
  f.session.cancel();
  assert.equal(f.slots.size, 0);
  f.pending[0](reply());
  await work;
  assert.equal(f.slots.size, 0);
});

test('phone release rejection of marked test response leaves cache empty', async () => {
  const f = fixture(); const context = recordFor(request).context;
  f.session.setProvider({ cancel() {}, async request() {
    return Object.assign(new M.IDEReply(), { errorCode: 'AI_NOT_ENABLED', message: 'test data rejected', isTestData: true });
  } });
  await f.session.setContext(context);
  await f.session.request('completion', 'explanation', request.cursor);
  assert.equal(f.slots.size, 0);
});
test('completion accepts once, preserves CRLF and withdraws only unchanged content', async () => {
  const f = fixture(), context = recordFor(request).context; context.code = context.code.replaceAll('\n', '\r\n');
  await f.session.setContext(context);
  const work = f.session.request('completion', 'explanation', request.cursor); f.pending[0](reply()); await work;
  const r = f.session.records[0]; let writes = 0;
  const apply = code => { writes++; context.code = code; f.session.setContext(context); };
  assert.equal(f.session.accept(r.id, apply), true);
  assert.equal(f.session.accept(r.id, apply), false);
  assert.equal(f.session.canWithdraw(), true);
  assert.equal(f.session.withdraw(apply), true);
  assert.equal(context.code, request.code.replaceAll('\n', '\r\n')); assert.equal(writes, 2);
  const second = f.session.request('completion', 'explanation', request.cursor); f.pending[1](reply()); await second;
  f.session.accept(f.session.records.at(-1).id, apply);
  apply(context.code + '// new'); assert.equal(f.session.canWithdraw(), false);
});
test('accepted main.cpp completion leaves short code isolated and context switch disables withdraw', async () => {
  const f = fixture(); const context = recordFor(request).context; context.file = 'main.cpp';
  const { Draft } = load('domain/Models');
  const { DraftWorkspaceViewModel } = load('application/DraftWorkspaceViewModel');
  const draft = new Draft(context.draftId, 'fixture'); draft.code = context.code;
  draft.idea = 'Sort'; draft.shortCode = 'int helper() { return 1; }';
  const draftRepository = { get: id => id === draft.id ? draft : undefined, save: value => Object.assign(draft, value),
    list: () => [draft], delete() {} };
  const viewModel = new DraftWorkspaceViewModel(draftRepository, undefined, { cancel() {} });
  await f.session.setContext(context);
  const work = f.session.request('completion', 'explanation', request.cursor); f.pending[0](reply()); await work;
  const apply = code => {
    viewModel.update(draft.id, draft.title, draft.idea, code, draft.shortCode, draft.rewrite);
    context.code = code; f.session.setContext(context);
  };
  const record = f.session.records[0];
  assert.equal(f.session.accept(record.id, apply), true);
  assert.equal(draft.code, context.code);
  assert.equal(draft.shortCode, 'int helper() { return 1; }');
  assert.equal(f.session.canWithdraw(), true);
  await f.session.setContext({ ...context, draftId: 'other-draft' });
  assert.equal(f.session.canWithdraw(), false);
  assert.equal(draft.shortCode, 'int helper() { return 1; }');
});
test('accepted completion updates the local draft without starting synchronization', async () => {
  const { Draft, IdeaSegment } = load('domain/Models');
  const { RdbDraftRepository } = load('platform/RdbDraftRepository');
  const draft = new Draft('local-only', 'Sort intervals');
  draft.idea = 'Sort intervals'; draft.code = request.code; draft.ideaSegments = [new IdeaSegment('idea-1', 'Sort intervals', 0)];
  const repository = new RdbDraftRepository({});
  repository.store = { version: 3, async executeSql() {} };
  repository.clientId = 'phone-client';
  repository.applyServerDraft(draft);
  let syncCalls = 0;
  const syncRepository = { ...repository, listPendingOperations() { syncCalls++; return repository.listPendingOperations(); } };
  const viewModel = new (load('application/DraftWorkspaceViewModel').DraftWorkspaceViewModel)(repository, syncRepository, { cancel() {} });
  const f = fixture(); const context = recordFor(request).context;
  await f.session.setContext(context);
  viewModel.aiSession = f.session;
  const work = f.session.request('completion', 'explanation', request.cursor); f.pending[0](reply()); await work;
  const record = f.session.records[0];
  assert.equal(f.session.accept(record.id, value => viewModel.update(draft.id, draft.title, draft.idea, value, draft.shortCode, draft.rewrite)), true);
  assert.equal(repository.listPendingOperations().length, 1);
  assert.equal(repository.listPendingOperations()[0].entity_type, 'draft');
  assert.equal(repository.listPendingOperations()[0].payload.code, repository.getDraft(draft.id).code);
  assert.equal(syncCalls, 0);
  assert.notEqual(repository.getDraft(draft.id).code, request.code);
});

test('unaccepted mobile completion is stored locally without creating an AI sync operation', async () => {
  const { RdbDraftRepository } = load('platform/RdbDraftRepository');
  const calls = [];
  const repository = new RdbDraftRepository({});
  repository.clientId = 'phone-client';
  repository.store = { version: 3, async executeSql(sql) { calls.push(sql); } };
  const record = recordFor(request);
  record.state = M.IDEState.SUCCESS;
  record.body = JSON.stringify(artifact);
  record.updatedAt = new Date().toISOString();
  record.createdAt = record.updatedAt;
  await repository.aiResults(false).save(record, true);
  assert.equal(calls.some(sql => sql.includes('INSERT OR REPLACE INTO ai_results')), true);
  assert.equal(repository.listPendingOperations().length, 0);
  assert.equal(calls.some(sql => sql.includes('sync_operations')), false);
});
test('review slots, hidden old message, AI-only persistence and retry', async () => {
  const f = fixture(); await f.session.setContext(recordFor(request).context);
  for (const kind of ['explanation', 'risk', 'complexity', 'risk']) {
    const work = f.session.request('review', kind);
    const body = { ...artifact, output_kind: 'review', review_kind: kind, diagnostics: [] };
    delete body.replaced_range; delete body.suggestion_text; delete body.source_refs;
    f.pending.at(-1)(Object.assign(new M.IDEReply(), { body: JSON.stringify(body) })); await work;
  }
  await f.session.retryStorage(); assert.equal(f.slots.size, 3);
  const latest = f.session.records[3].id;
  f.session.setHidden(f.session.records[1].id, true); await f.session.retryStorage();
  assert.equal([...f.slots.values()].find(r => r.reviewKind === 'risk').id, latest);
  assert.equal([...f.slots.values()].find(r => r.reviewKind === 'risk').hidden, false);
  const original = f.repo.save; f.repo.save = async () => { throw Error('full'); };
  f.session.setHidden(latest, true); await f.session.retryStorage(); assert.match(f.session.storageError, /失败/);
  f.repo.save = original; await f.session.retryStorage(); assert.equal(f.session.storageError, '');
});
test('RDB migration transaction control (stub, not real RDB)', async () => {
  const { RdbDraftRepository } = load('platform/RdbDraftRepository');
  for (const version of [0, 1, 2, 3, 4]) {
    const sql = []; const store = { version, beginTransaction() {}, commit() {}, rollBack() {}, async executeSql(s) { sql.push(s); } };
    const repo = new RdbDraftRepository({});
    if (version === 4) await assert.rejects(repo.migrate(store));
    else { await repo.migrate(store); assert.equal(store.version, 3); }
    assert.equal(sql.some(s => /DROP|DELETE/.test(s)), false);
  }
  let rolled = false; const store = { version: 1, beginTransaction() {}, commit() {}, rollBack() { rolled = true; }, async executeSql() { throw Error('full'); } };
  await assert.rejects(new RdbDraftRepository({}).migrate(store)); assert.equal(store.version, 1); assert.equal(rolled, true);
});
test('migration accepts the PR23 v2 artifact-column variant without replacing ordinary tables', async () => {
  const { migrateWorkspaceStore } = load('platform/RdbDraftRepository');
  const sql = [];
  const store = {
    version: 2, beginTransaction() {}, commit() {}, rollBack() {},
    async executeSql(statement) { sql.push(statement); },
    async querySql(statement) {
      if (statement.startsWith('PRAGMA table_info(')) return { goToFirstRow() { return false; }, goToNextRow() { return false; }, close() {} };
      assert.equal(statement, 'PRAGMA table_info(conflicts)');
      let index = -1;
      const rows = [{ name: 'id' }, { name: 'entity_id' }, { name: 'local_copy_id' }];
      return { goToFirstRow() { index = 0; return true; }, goToNextRow() { index++; return index < rows.length; },
        getColumnIndex() { return 0; }, getString() { return rows[index].name; }, close() {} };
    }
  };
  await migrateWorkspaceStore(store);
  assert.equal(sql.some(statement => statement.includes('CREATE TABLE IF NOT EXISTS ai_results')), true);
  assert.equal(sql.some(statement => statement.includes('CREATE TABLE IF NOT EXISTS ai_result_history')), true);
  assert.equal(sql.some(statement => statement.includes('CREATE TABLE IF NOT EXISTS draft_source_history')), true);
  assert.equal(sql.some(statement => statement.includes('ALTER TABLE conflicts ADD COLUMN entity_type')), true);
  assert.equal(sql.some(statement => /DROP TABLE|DELETE FROM drafts|ALTER TABLE drafts/i.test(statement)), false);
});
test('draft writes keep legacy PR23 embedded AI artifacts until an explicit conversion is available', async () => {
  const { RdbDraftRepository } = load('platform/RdbDraftRepository');
  const { Draft } = load('domain/Models');
  const legacy = '[{"mode":"faithful_transform","pseudocode":[{"id":"step-1","step":"Keep source result","source_refs":["idea-1"]}]}]';
  const sql = [];
  const rows = { goToFirstRow() { return true; }, getColumnIndex() { return 0; }, getString() { return legacy; }, close() {} };
  const repo = new RdbDraftRepository({});
  repo.store = { version: 3, async executeSql(statement, args) { sql.push([statement, args]); }, async querySql() { return rows; } };
  const draft = new Draft('legacy-draft', 'legacy'); draft.code = 'int value = 1;';
  repo.applyServerDraft(draft); await repo.flush();
  const insert = sql.find(([statement]) => statement.includes('INSERT OR REPLACE INTO drafts'));
  assert.match(insert[0], /ai_artifacts_json/);
  assert.equal(insert[1].includes(legacy), true);
});
test('draft restore decodes PR23 embedded AI artifacts for the existing AI result view', async () => {
  const { RdbDraftRepository } = load('platform/RdbDraftRepository');
  const legacy = JSON.stringify([{ id: 'artifact-old', version: 0, server_sequence: 0,
    created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-02T00:00:00.000Z', deleted: false,
    last_modified_client_id: 'phone-old', draft_id: 'legacy-draft', mode: 'faithful_transform',
    pseudocode: [{ id: 'step-1', step: 'Keep source result', source_refs: ['idea-1'] }],
    code_snippet: null, code_mappings: [], assumptions: [], missing_information: [], risk_flags: [], added_algorithm_steps: [],
    source_draft_version: 4, model_id: 'legacy-model', rule_version: '1.0.0', output_kind: 'pseudocode', visibility: 'visible', template_id: null }]);
  const values = { id: 'legacy-draft', title: 'legacy', workspace_id: 'workspace-test', idea: 'Keep source result',
    code: 'int value = 1;', short_code: '', rewrite: '', version: 4, created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-02T00:00:00.000Z', deleted: 0, last_modified_client_id: 'phone-old', sync_status: 'synced',
    ai_mode: 'faithful_transform', artifact_hidden: 1, ai_artifacts_json: legacy,
    idea_segments_json: '[{"id":"idea-1","content":"Keep source result","position":0}]' };
  const columns = Object.keys(values); let read = false;
  const rows = { goToFirstRow() { read = true; return true; }, goToNextRow() { read = false; return false; },
    getColumnIndex(name) { return columns.indexOf(name); }, getString(index) { return String(values[columns[index]]); },
    getLong(index) { return Number(values[columns[index]]); }, close() {} };
  const repo = new RdbDraftRepository({});
  await repo.loadDrafts({ async querySql() { return rows; } });
  const draft = repo.get('legacy-draft');
  assert.equal(read, false);
  assert.equal(draft.artifactHidden, true);
  assert.equal(draft.aiArtifacts.length, 1);
  assert.equal(draft.aiArtifacts[0].pseudocode[0].sourceRefs[0], 'idea-1');
});
test('PR23 v2 migration imports faithful and non-default mode artifacts into readable ai_results and is idempotent on re-run', async () => {
  const { migrateWorkspaceStore } = load('platform/RdbDraftRepository');
  const { RdbAIResultRepository } = load('platform/RdbAIResultRepository');
  const { IDEAISession } = load('application/IDEAISession');
  const { IDEContext } = load('domain/IDEAIModels');
  const { AIRequestSegment } = load('domain/Models');
  const legacyArtifacts = JSON.stringify([
    {
      mode: 'faithful_transform',
      pseudocode: [{ id: 'step-1', step: 'Sort intervals by right endpoint', source_refs: ['idea-1'] }],
      code_snippet: null, code_mappings: [], assumptions: [], missing_information: [], risk_flags: [],
      added_algorithm_steps: [], source_draft_version: 4, model_id: 'legacy-model',
      rule_version: '1.0.0', output_kind: 'pseudocode', visibility: 'visible', template_id: null
    },
    {
      mode: 'feasibility_analysis',
      pseudocode: [{ id: 'step-2', step: 'Analyze greedy choice property', source_refs: ['idea-1'] }],
      code_snippet: null, code_mappings: [], assumptions: ['intervals non-empty'], missing_information: [],
      risk_flags: ['greedy choice not proven'], added_algorithm_steps: ['Consider exchange argument'],
      source_draft_version: 4, model_id: 'legacy-model', rule_version: '1.0.0',
      output_kind: 'pseudocode', visibility: 'visible', template_id: null
    },
    {
      mode: 'progressive_hint',
      pseudocode: [{ id: 'step-3', step: 'Compare current start with last end', source_refs: ['idea-1'] }],
      code_snippet: 'if (cur.left >= lastRight) {\n  lastRight = cur.right;\n}',
      code_mappings: [{ step_id: 'step-3', start_line: 1, end_line: 3 }],
      assumptions: [], missing_information: [], risk_flags: [],
      added_algorithm_steps: ['Track last selected right endpoint'], source_draft_version: 4,
      model_id: 'legacy-model', rule_version: '1.0.0', output_kind: 'code_snippet',
      visibility: 'hidden', template_id: 'greedy-hint'
    },
    {
      mode: 'full_solution',
      pseudocode: [{ id: 'step-4', step: 'Complete interval scheduling pass', source_refs: ['idea-1'] }],
      code_snippet: null, code_mappings: [], assumptions: [], missing_information: [], risk_flags: [],
      added_algorithm_steps: ['Count all compatible intervals'], source_draft_version: 4,
      model_id: 'legacy-model', rule_version: '1.0.0', output_kind: 'pseudocode',
      visibility: 'visible', template_id: null
    },
    {
      mode: 'faithful_transform',
      pseudocode: [{ id: 'step-5', step: 'Preserve later same-mode result', source_refs: ['idea-1'] }],
      code_snippet: null, code_mappings: [], assumptions: [], missing_information: [], risk_flags: [],
      added_algorithm_steps: [], source_draft_version: 4, model_id: 'legacy-model',
      rule_version: '1.0.0', output_kind: 'pseudocode', visibility: 'visible', template_id: null
    }
  ]);
  const draftRow = {
    id: 'legacy-draft', title: 'Interval Scheduling', workspace_id: 'workspace-test',
    idea: 'Keep source result', code: 'int value = 1;', short_code: '', rewrite: '', version: 4,
    created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-02T00:00:00.000Z', deleted: 0,
    last_modified_client_id: 'phone-old', sync_status: 'synced', ai_mode: 'feasibility_analysis',
    artifact_hidden: 0, ai_artifacts_json: legacyArtifacts,
    idea_segments_json: '[{"id":"idea-1","content":"Keep source result","position":0}]'
  };
  const makeResultSet = (items) => {
    let idx = -1;
    const cols = items.length > 0 ? Object.keys(items[0]) : [];
    return {
      goToFirstRow() { idx = 0; return items.length > 0; },
      goToNextRow() { idx++; return idx < items.length; },
      getColumnIndex(name) { return cols.indexOf(name); },
      getString(colIdx) { return String(items[idx][cols[colIdx] ?? cols[0]]); },
      getLong(colIdx) { return Number(items[idx][cols[colIdx] ?? cols[0]]); },
      close() {}
    };
  };
  let committedResults = new Map();
  let committedHistory = new Map();
  let workingResults = null;
  let workingHistory = null;
  let totalInsertAttempts = 0;
  const store = {
    version: 2,
    beginTransaction() { workingResults = new Map(committedResults); workingHistory = new Map(committedHistory); },
    commit() { if (workingResults) { committedResults = workingResults; committedHistory = workingHistory; workingResults = null; workingHistory = null; } },
    rollBack() { workingResults = null; workingHistory = null; },
    async executeSql(statement, args = []) {
      const target = workingResults ?? committedResults;
      const history = workingHistory ?? committedHistory;
      if (statement.startsWith('INSERT OR IGNORE INTO ai_result_history') && statement.includes('SELECT')) {
        const [draftId, mode, slot] = args;
        const current = target.get(`${draftId}:${mode}:${slot}:0`);
        if (current !== undefined) history.set(current.resultId, current);
      } else if (statement.startsWith('INSERT OR IGNORE INTO ai_result_history')) {
        const [draftId, mode, slot, resultId, updatedAt, recordJson] = args;
        history.set(resultId, { draft_id: draftId, mode, slot, is_test: 0, resultId, updatedAt, recordJson });
      } else if (statement.startsWith('INSERT OR IGNORE INTO ai_results') || statement.startsWith('INSERT OR REPLACE INTO ai_results')) {
        totalInsertAttempts++;
        const [draftId, mode, slot, resultId, updatedAt, recordJson] = args;
        const key = `${draftId}:${mode}:${slot}:0`;
        if (statement.startsWith('INSERT OR REPLACE') || !target.has(key)) {
          target.set(key, { draft_id: draftId, mode, slot, is_test: 0, resultId, updatedAt, recordJson });
        }
      }
    },
    async querySql(statement, args = []) {
      const target = workingResults ?? committedResults;
      if (statement === 'PRAGMA table_info(drafts)') return makeResultSet([{ name: 'id' }, { name: 'ai_artifacts_json' }]);
      if (statement === 'PRAGMA table_info(conflicts)') return makeResultSet([{ name: 'id' }, { name: 'entity_type' }]);
      if (statement.startsWith('PRAGMA table_info(')) return makeResultSet([]);
      if (statement === 'SELECT * FROM drafts') return makeResultSet([draftRow]);
      if (statement.startsWith('SELECT record_json FROM ai_results WHERE draft_id = ? AND mode = ?')) {
        const [draftId, mode, allowTest] = args;
        const matched = [...target.values()].filter(row => row.draft_id === draftId && row.mode === mode && (row.is_test === 0 || allowTest === 1));
        return makeResultSet(matched.map(row => ({ record_json: row.recordJson })));
      }
      if (statement.startsWith('SELECT record_json FROM ai_result_history')) {
        const [draftId, mode, allowTest] = args;
        const matched = [...(workingHistory ?? committedHistory).values()]
          .filter(row => row.draft_id === draftId && row.mode === mode && (row.is_test === 0 || allowTest === 1));
        return makeResultSet(matched.map(row => ({ record_json: row.recordJson })));
      }
      return makeResultSet([]);
    }
  };
  await migrateWorkspaceStore(store);
  assert.equal(store.version, 3);
  assert.equal(committedResults.size, 4);
  assert.equal(committedHistory.size, 5);
  const repository = new RdbAIResultRepository(store, false);
  for (const [mode, expectedId, expectedHidden, expectedStep] of [
    ['faithful_transform', 'legacy-legacy-draft-4', false, 'Preserve later same-mode result'],
    ['feasibility_analysis', 'legacy-legacy-draft-1', false, 'Analyze greedy choice property'],
    ['progressive_hint', 'legacy-legacy-draft-2', true, 'Compare current start with last end'],
    ['full_solution', 'legacy-legacy-draft-3', false, 'Complete interval scheduling pass']
  ]) {
    const records = await repository.list('legacy-draft', mode);
    const selected = records.find(record => record.id === expectedId);
    assert.equal(selected !== undefined, true);
    assert.equal(selected.context.mode, mode);
    assert.equal(selected.restored, true);
    assert.equal(selected.stale, true);
    assert.equal(selected.hidden, expectedHidden);
    if (mode === 'faithful_transform') {
      assert.equal(records.length, 2);
      assert.equal(records.some(record => record.id === 'legacy-legacy-draft-0'), true);
      assert.equal(committedResults.get('legacy-draft:faithful_transform:transform:0').resultId, expectedId);
      const oldRecord = JSON.parse(committedHistory.get('legacy-legacy-draft-0').recordJson);
      assert.equal(oldRecord.body.includes('Sort intervals by right endpoint'), true);
    } else {
      assert.equal(records.length, 1);
    }
    const session = new IDEAISession({ async request() { throw Error('not called'); }, cancel() {} }, repository);
    const ctx = new IDEContext();
    ctx.draftId = 'legacy-draft'; ctx.version = 4; ctx.mode = mode; ctx.code = draftRow.code;
    ctx.idea = draftRow.idea; ctx.problemContext = draftRow.title;
    ctx.segments = [new AIRequestSegment('idea-1', 'Keep source result')];
    await session.setContext(ctx);
    assert.equal(session.storageError, '');
    assert.equal(session.records.length, mode === 'faithful_transform' ? 2 : 1);
    const selectedMessage = session.records.find(record => session.result(record).transformText.includes(expectedStep));
    assert.notEqual(selectedMessage, undefined);
    const text = session.result(selectedMessage).transformText;
    if (mode === 'progressive_hint') {
      assert.match(text, /if \(cur\.left >= lastRight\)/);
      assert.match(text, /step-3: L1-L3/);
    }
  }
  const key = 'legacy-draft:feasibility_analysis:transform:0';
  const modifiedRecord = JSON.parse(committedResults.get(key).recordJson);
  modifiedRecord.hidden = true;
  committedResults.get(key).recordJson = JSON.stringify(modifiedRecord);
  store.version = 2;
  await migrateWorkspaceStore(store);
  assert.equal(store.version, 3);
  assert.equal(committedResults.size, 4);
  assert.equal(committedHistory.size, 5);
  assert.equal(totalInsertAttempts, 8);
  const afterRerun = await repository.list('legacy-draft', 'feasibility_analysis');
  assert.equal(afterRerun.length, 1);
  assert.equal(afterRerun[0].hidden, true);
  const faithfulAfterRerun = await repository.list('legacy-draft', 'faithful_transform');
  assert.equal(faithfulAfterRerun.length, 2);
  assert.equal(new Set(faithfulAfterRerun.map(record => record.id)).size, 2);
});
test('PR23 migration rolls back corrupt artifacts but isolates historical results with deleted sources', async () => {
  const { migrateWorkspaceStore } = load('platform/RdbDraftRepository');
  const makeResultSet = (items) => {
    let idx = -1;
    const cols = items.length > 0 ? Object.keys(items[0]) : [];
    return {
      goToFirstRow() { idx = 0; return items.length > 0; },
      goToNextRow() { idx++; return idx < items.length; },
      getColumnIndex(name) { return cols.indexOf(name); },
      getString(colIdx) { return String(items[idx][cols[colIdx] ?? cols[0]]); },
      getLong(colIdx) { return Number(items[idx][cols[colIdx] ?? cols[0]]); },
      close() {}
    };
  };
  const validDraft = {
    id: 'draft-valid', title: 'Valid', workspace_id: 'workspace-test', idea: 'Idea', code: 'int a = 1;',
    short_code: '', rewrite: '', version: 1, created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-02T00:00:00.000Z', deleted: 0, last_modified_client_id: 'phone',
    sync_status: 'synced', ai_mode: 'faithful_transform', artifact_hidden: 0,
    ai_artifacts_json: JSON.stringify([{
      mode: 'faithful_transform',
      pseudocode: [{ id: 'step-1', step: 'Valid step', source_refs: ['idea-1'] }],
      code_snippet: null, code_mappings: [], assumptions: [], missing_information: [], risk_flags: [],
      added_algorithm_steps: [], source_draft_version: 1, model_id: 'legacy-model',
      rule_version: '1.0.0', output_kind: 'pseudocode', visibility: 'visible', template_id: null
    }]),
    idea_segments_json: '[{"id":"idea-1","content":"Idea","position":0}]'
  };
  for (const badArtifactsJson of [
    '{corrupt-json',
    JSON.stringify([{
      mode: 'faithful_transform',
      pseudocode: [{ id: 'step-1', step: 'Illegal step addition', source_refs: ['idea-1'] }],
      code_snippet: null, code_mappings: [], assumptions: [], missing_information: [], risk_flags: [],
      added_algorithm_steps: ['Forbidden in faithful_transform'], source_draft_version: 1,
      model_id: 'legacy-model', rule_version: '1.0.0', output_kind: 'pseudocode',
      visibility: 'visible', template_id: null
    }]),
    JSON.stringify([{
      mode: 'faithful_transform',
      pseudocode: [{ id: 'step-1', step: 'Unknown source', source_refs: ['missing-segment'] }],
      code_snippet: null, code_mappings: [], assumptions: [], missing_information: [], risk_flags: [],
      added_algorithm_steps: [], source_draft_version: 1, model_id: 'legacy-model',
      rule_version: '1.0.0', output_kind: 'pseudocode', visibility: 'visible', template_id: null
    }])
  ]) {
    const corruptDraft = { ...validDraft, id: 'draft-corrupt', ai_artifacts_json: badArtifactsJson };
    let committedResults = new Map();
    let workingResults = null;
    let rolledBack = false;
    const store = {
      version: 2,
      beginTransaction() { workingResults = new Map(committedResults); },
      commit() { if (workingResults) { committedResults = workingResults; workingResults = null; } },
      rollBack() { rolledBack = true; workingResults = null; },
      async executeSql(statement, args = []) {
        const target = workingResults ?? committedResults;
        if (statement.startsWith('INSERT OR IGNORE INTO ai_results') || statement.startsWith('INSERT OR REPLACE INTO ai_results')) {
          const [draftId, mode, slot, resultId, updatedAt, recordJson] = args;
          target.set(`${draftId}:${mode}:${slot}:0`, { resultId, updatedAt, recordJson });
        }
      },
      async querySql(statement) {
        if (statement === 'PRAGMA table_info(drafts)') return makeResultSet([{ name: 'id' }, { name: 'ai_artifacts_json' }]);
        if (statement === 'PRAGMA table_info(conflicts)') return makeResultSet([{ name: 'id' }, { name: 'entity_type' }]);
        if (statement.startsWith('PRAGMA table_info(')) return makeResultSet([]);
        if (statement === 'SELECT * FROM drafts') return makeResultSet([validDraft, corruptDraft]);
        return makeResultSet([]);
      }
    };
    if (badArtifactsJson.includes('missing-segment')) {
      await migrateWorkspaceStore(store);
      assert.equal(rolledBack, false);
      assert.equal(store.version, 3);
      assert.equal(committedResults.size, 2);
      const record = JSON.parse([...committedResults.values()].find((item) => item.recordJson.includes('missing-segment')).recordJson);
      assert.equal(record.hidden, true);
      assert.deepEqual(record.context.segments, [{ id: 'missing-segment', content: '' }]);
    } else {
      await assert.rejects(() => migrateWorkspaceStore(store), /AI 结果数据库兼容升级失败，原工作区未删除/);
      assert.equal(rolledBack, true);
      assert.equal(store.version, 2);
      assert.equal(committedResults.size, 0);
    }
  }
});
test('phone pull batch leaves its cursor unchanged when queued RDB writes fail', async () => {
  const { PhoneSyncService } = load('platform/PhoneSyncService');
  const { HttpSyncClient } = load('platform/HttpSyncClient');
  const applied = []; let cursor = '4'; let commitCalls = 0;
  const repository = { listPendingOperations: () => [], markInFlight() {}, getBaseUrl: () => 'http://sync', getCursor: () => cursor,
    getClientId: () => 'phone', getDraft: () => undefined, setDraftSyncStatus() {}, hasPendingOperation: () => false,
    removeOperation() {}, applyServerDraft(draft) { applied.push(draft); }, setCursor() {},
    async flush() { throw Error('disk full'); }, async commitCursor(next) { commitCalls++; cursor = next; } };
  const oldPull = HttpSyncClient.prototype.pull;
  HttpSyncClient.prototype.pull = async () => ({ changes: [{ entity_type: 'draft', entity: {
    id: 'pulled', version: 1, code: 'remote', last_modified_client_id: 'web'
  } }], next_cursor: '5' });
  try {
    const result = await new PhoneSyncService(repository).synchronize();
    assert.equal(result.status, 'failed'); assert.equal(applied.length, 1);
    assert.equal(cursor, '4'); assert.equal(commitCalls, 0);
  } finally { HttpSyncClient.prototype.pull = oldPull; }
});
test('RDB cursor changes in memory only after durable cursor write succeeds', async () => {
  const { RdbDraftRepository } = load('platform/RdbDraftRepository');
  let fail = true;
  const repo = new RdbDraftRepository({}); repo.store = { version: 3, async executeSql() { if (fail) throw Error('disk full'); } };
  repo.cursor = '4';
  await assert.rejects(repo.commitCursor('5'), /disk full/); assert.equal(repo.getCursor(), '4');
  fail = false; await repo.commitCursor('5'); assert.equal(repo.getCursor(), '5');
});
test('RDB AI result save rolls back a partial write and can be retried', async () => {
  const record = recordFor(request, 'completion'); record.body = JSON.stringify(artifact);
  const calls = []; let fail = true; let rolledBack = 0; let committed = 0;
  const store = {
    beginTransaction() { calls.push('begin'); }, commit() { committed++; calls.push('commit'); }, rollBack() { rolledBack++; calls.push('rollback'); },
    async executeSql(sql) { calls.push(sql); if (fail && sql.startsWith('INSERT OR REPLACE INTO ai_results')) throw Error('disk full'); },
    async querySql() { return { goToFirstRow() { return true; }, close() {} }; }
  };
  const { RdbAIResultRepository } = load('platform/RdbAIResultRepository');
  const repo = new RdbAIResultRepository(store, false);
  await assert.rejects(repo.save(record, true), /disk full/);
  assert.equal(rolledBack, 1); assert.equal(committed, 0);
  fail = false; await repo.save(record, true);
  assert.equal(committed, 1); assert.equal(rolledBack, 1);
});
test('migration preparation fixture preserves every v1 table and field', async () => {
  const { migrateWorkspaceStore } = load('platform/RdbDraftRepository');
  const sql = [];
  const store = { version: 1, beginTransaction() {}, commit() {}, rollBack() {}, async executeSql(statement) { sql.push(statement); } };
  await migrateWorkspaceStore(store);
  assert.equal(store.version, 3);
  for (const table of ['drafts', 'sync_operations', 'sync_state', 'conflicts']) {
    assert.equal(sql.some(statement => statement.includes(table)), false, `v1->v2 must not recreate ${table}`);
  }
  assert.equal(sql.filter(statement => statement.includes('CREATE TABLE IF NOT EXISTS ai_results')).length, 2);
  const v1Fixture = {
    draft: { id: 'test-draft', workspace_id: 'workspace-test', title: '迁移样例', idea: '保留用户思路', code: 'int value = 1;', short_code: 'value += 1;', rewrite: '// rewrite', version: 4 },
    operation: { operation_id: 'operation-v1', entity_id: 'test-draft', base_version: 3, payload_json: '{"code":"int value = 1;"}' },
    cursor: '42', conflict: { id: 'conflict-v1', entity_id: 'test-draft', local_copy_id: 'test-draft-conflict', resolved: 0 }
  };
  assert.deepEqual(Object.keys(v1Fixture.draft), ['id', 'workspace_id', 'title', 'idea', 'code', 'short_code', 'rewrite', 'version']);
  assert.equal(v1Fixture.operation.base_version, 3);
  assert.equal(v1Fixture.cursor, '42');
  assert.equal(v1Fixture.conflict.resolved, 0);
});

test('AI Gateway URL uses the existing sync_state persistence', async () => {
  const { RdbDraftRepository } = load('platform/RdbDraftRepository');
  const calls = [];
  const repo = new RdbDraftRepository({});
  repo.store = { version: 3, async executeSql(sql, args) { calls.push([sql, args]); },
    async querySql() {
      const rows = [{ key: 'ai_base_url', value: 'http://192.168.1.10:8788' }]; let index = -1;
      return { goToFirstRow() { index = 0; return true; }, goToNextRow() { index++; return index < rows.length; },
        getColumnIndex(column) { return column === 'state_key' ? 0 : 1; },
        getString(column) { return column === 0 ? rows[index].key : rows[index].value; }, close() {} };
    } };
  await repo.loadState(repo.store);
  assert.equal(repo.getAIBaseUrl(), 'http://192.168.1.10:8788');
  repo.setAIBaseUrl('http://192.168.1.20:8788/'); await repo.flush();
  assert.equal(repo.getAIBaseUrl(), 'http://192.168.1.20:8788');
  assert.equal(calls.some(([sql, args]) => args[0] === 'ai_base_url' && args[1] === 'http://192.168.1.20:8788'), true);
});
test('cache rejects corrupt body and restores loading as cancelled, read-only', async () => {
  const record = recordFor(request); record.body = JSON.stringify(artifact);
  assert.throws(() => decodeAIRecord(JSON.stringify({ ...record, body: '{}' })));
  const rows = { goToFirstRow: () => true, goToNextRow: () => false, getString: () => JSON.stringify(record), close() {} };
  const repo = new RdbAIResultRepository({ async querySql() { return rows; } }, false);
  const [restored] = await repo.list(record.context.draftId, record.context.mode);
  assert.equal(restored.stale, true); assert.equal(restored.state, 'cancelled');
  record.isTestData = true; assert.deepEqual(await repo.list(record.context.draftId, record.context.mode), []);
});
test('RDB AI results keep capability and test partitions independent', async () => {
  const normalReview = recordFor(request, 'review'); normalReview.reviewKind = 'risk';
  normalReview.body = JSON.stringify({ mode: artifact.mode, source_draft_version: artifact.source_draft_version,
    model_id: artifact.model_id, rule_version: artifact.rule_version, output_kind: 'review', visibility: artifact.visibility,
    draft_id: normalReview.context.draftId, review_kind: 'risk', diagnostics: [] });
  const testReview = structuredClone(normalReview); testReview.id = 'test-review'; testReview.isTestData = true;
  const normalCompletion = recordFor(request, 'completion'); normalCompletion.id = 'normal-completion';
  normalCompletion.body = JSON.stringify(artifact);
  const rows = [normalReview, testReview, normalCompletion].map(record => ({ value: JSON.stringify(record) }));
  const calls = [];
  const resultSet = {
    index: -1,
    goToFirstRow() { this.index = 0; return rows.length > 0; },
    goToNextRow() { this.index++; return this.index < rows.length; },
    getString() { return rows[this.index].value; }, close() {}
  };
  const repo = new RdbAIResultRepository({ async querySql(sql, args) { calls.push([sql, args]); return resultSet; } }, true);
  const records = await repo.list(request.draft_id, 'faithful_transform');
  assert.equal(records.length, 3);
  assert.equal(records.filter(record => record.isTestData).length, 1);
  assert.equal(records.filter(record => record.capability === 'review').length, 2);
  assert.equal(calls[0][1].at(-1), 1);
  assert.equal(resultSlot(normalReview), 'review:risk');
});

test('RDB AI result recovery keeps one completion and prefers normal data', async () => {
  const normalCompletion = recordFor(request, 'completion'); normalCompletion.id = 'normal-completion';
  normalCompletion.body = JSON.stringify(artifact);
  const testCompletion = structuredClone(normalCompletion); testCompletion.id = 'test-completion'; testCompletion.isTestData = true;
  const rows = [testCompletion, normalCompletion].map(record => ({ value: JSON.stringify(record) }));
  const resultSet = {
    index: -1,
    goToFirstRow() { this.index = 0; return true; },
    goToNextRow() { this.index++; return this.index < rows.length; },
    getString() { return rows[this.index].value; }, close() {}
  };
  const repo = new RdbAIResultRepository({ async querySql() { return resultSet; } }, true);
  const records = await repo.list(request.draft_id, 'faithful_transform');
  assert.deepEqual(records.filter(record => record.capability === 'completion').map(record => record.isTestData), [false, true]);
});
test('AI result persistence only targets ai_results and deletion is isolated', async () => {
  const record = recordFor(request, 'completion'); record.body = JSON.stringify(artifact);
  const testRecord = structuredClone(record); testRecord.isTestData = true;
  const calls = [];
  const store = { async executeSql(sql, args) { calls.push([sql, args]); } };
  const repo = new RdbAIResultRepository(store, false);
  await repo.save(record, true);
  const debugRepo = new RdbAIResultRepository(store, true);
  await debugRepo.save(testRecord, true); await repo.removeDraft(record.context.draftId);
  assert.equal(calls.some(([sql]) => sql.startsWith('INSERT OR REPLACE INTO ai_results')), true);
  assert.equal(calls.some(([sql]) => sql === 'DELETE FROM ai_results WHERE draft_id = ?'), true);
  assert.equal(calls.some(([sql]) => sql === 'DELETE FROM ai_result_history WHERE draft_id = ?'), true);
  assert.equal(calls.some(([sql]) => /(?:UPDATE|INSERT|DELETE)\s+(?:drafts|sync_operations|sync_state|conflicts)/i.test(sql)), false);
  assert.equal(calls.some(([sql]) => sql.includes('DELETE FROM ai_results WHERE result_id')), false);
});
test('remote tombstone persists as a delete and clears only the AI result table', async () => {
  const { RdbDraftRepository } = load('platform/RdbDraftRepository');
  const { Draft } = load('domain/Models');
  const calls = [];
  const repo = new RdbDraftRepository({});
  repo.store = { version: 3, async executeSql(sql, args) { calls.push([sql, args]); } };
  const tombstone = new Draft('sync-delete', 'Deleted remotely');
  tombstone.deleted = true; tombstone.version = 4;
  repo.applyServerDraft(tombstone);
  await repo.flush();
  assert.equal(calls.some(([sql]) => sql.startsWith('DELETE FROM ai_results WHERE draft_id = ?')), true);
  assert.equal(calls.some(([sql]) => /(?:UPDATE|INSERT|DELETE)\s+sync_operations/i.test(sql)), false);
});
test('remote tombstone clears the in-memory AI session for the deleted draft', async () => {
  const { DraftWorkspaceViewModel } = load('application/DraftWorkspaceViewModel');
  const f = fixture(); const context = recordFor(request).context;
  await f.session.setContext(context);
  const work = f.session.request('completion', 'explanation', request.cursor); f.pending[0](reply()); await work;
  assert.equal(f.session.records.length, 1);
  const viewModel = new DraftWorkspaceViewModel({ get: () => undefined }, undefined, { cancel() {} });
  viewModel.aiSession = f.session;
  viewModel.selectAIContext(context.draftId, 'main.cpp');
  assert.equal(f.session.records.length, 0);
});
test('stable thought IDs preserve moves, prepend, duplicates and restored edits', () => {
  const { DraftWorkspaceViewModel } = load('application/DraftWorkspaceViewModel');
  const { Draft } = load('domain/Models');
  const draft = new Draft('d', 'title');
  const repo = { get: () => draft, save() {} }; const vm = new DraftWorkspaceViewModel(repo, undefined, { cancel() {} });
  vm.update('d', 'title', 'A\nB\nB', '', '', ''); const ids = draft.ideaSegments.map(s => s.id);
  vm.update('d', 'title', 'X\nB\nA\nB', '', '', '');
  assert.deepEqual(draft.ideaSegments.slice(1).map(s => s.id), [ids[1], ids[0], ids[2]]);
  const snapshot = structuredClone(draft.ideaSegments);
  const restored = new DraftWorkspaceViewModel(repo, undefined, { cancel() {} });
  restored.update('d', 'title', 'Y\nB\nA\nB', '', '', '');
  assert.deepEqual(draft.ideaSegments.map(s => s.id), snapshot.map(s => s.id));
});

test('transport one attempt, error categories, header-only test marker and Release gate', async () => {
  for (const debug of [true, false]) for (const allow of [true, false]) {
    let calls = 0, destroyed = 0, marked = true, status = 200;
    const http = { RequestMethod: { POST: 'POST' }, HttpDataType: { STRING: 'STRING' }, createHttp() {
      return { async request() { calls++; return { responseCode: status, header: marked ? { 'X-AlgoFlow-Test-Data': 'true' } : {}, result: JSON.stringify(artifact) }; }, destroy() { destroyed++; } };
    } };
    const { HttpAIProvider } = loader(debug, http)('platform/HttpAIProvider');
    const provider = new HttpAIProvider('http://test', 5, 1000, allow);
    const body = M.buildIDERequest(recordFor(request));
    let result = await provider.request(body, 'completion');
    assert.equal(result.errorCode, debug && allow ? '' : 'AI_NOT_ENABLED');
    assert.equal(calls, 1); assert.equal(destroyed, 1);
    marked = false; status = 502; result = await provider.request(body, 'completion');
    assert.equal(result.errorCode, 'AI_PROVIDER_ERROR'); assert.equal(calls, 2);
    status = 422; result = await provider.request(body, 'completion'); assert.equal(result.errorCode, 'INVALID_AI_ARTIFACT');
    status = 200; result = await provider.request(body, 'completion'); assert.equal(result.isTestData, false);
  }
});
test('Release AI result storage rejects test writes before touching the database', async () => {
  const record = recordFor(request, 'completion'); record.body = JSON.stringify(artifact); record.isTestData = true;
  const calls = [];
  const repo = new RdbAIResultRepository({ async executeSql(sql, args) { calls.push([sql, args]); } }, false);
  await assert.rejects(repo.save(record, true), /禁止保存测试数据/);
  assert.equal(calls.length, 0);
});
test('native cancellation destroys transport and late response stays cancelled', async () => {
  let finish, destroyed = 0;
  const http = { RequestMethod: { POST: 'POST' }, HttpDataType: { STRING: 'STRING' }, createHttp() {
    return { request() { return new Promise(resolve => { finish = resolve; }); }, destroy() { destroyed++; } };
  } };
  const { HttpAIProvider } = loader(true, http)('platform/HttpAIProvider');
  const provider = new HttpAIProvider(); const work = provider.request(M.buildIDERequest(recordFor(request)), 'completion');
  provider.cancel(); assert.equal(destroyed, 1);
  finish({ responseCode: 200, header: {}, result: JSON.stringify(artifact) });
  assert.equal((await work).errorCode, 'CANCELLED');
});
test('legacy request cancellation clears loading without saving draft', async () => {
  const { DraftWorkspaceViewModel } = load('application/DraftWorkspaceViewModel');
  const { Draft, IdeaSegment, AIResult, AIErrorCode } = load('domain/Models');
  const draft = new Draft('d', 'title'); draft.ideaSegments = [new IdeaSegment('s', 'idea', 0)];
  let finish, saves = 0;
  const vm = new DraftWorkspaceViewModel({ get: () => draft, save() { saves++; } }, undefined,
    { cancel() {}, generate() { return new Promise(resolve => { finish = resolve; }); } });
  const work = vm.requestAI('d', 'faithful_transform'); assert.equal(vm.isAIRequestInFlight(), true);
  vm.cancelAI(); assert.equal(vm.isAIRequestInFlight(), false);
  finish(AIResult.failure(AIErrorCode.CANCELLED, 'cancelled')); await work;
  assert.equal(saves, 0);
});
test('sync response preserves newer local edit and rotates operation identity', async () => {
  const { RdbDraftRepository } = load('platform/RdbDraftRepository');
  const { PhoneSyncService } = load('platform/PhoneSyncService');
  const { HttpSyncClient } = load('platform/HttpSyncClient');
  const { Draft } = load('domain/Models');
  const repo = new RdbDraftRepository({}); repo.store = { version: 3, async executeSql() {} }; repo.clientId = 'phone';
  const draft = new Draft('d', 't'); draft.code = 'before'; repo.save(draft); await repo.flush();
  const original = repo.listPendingOperations()[0]; let finish;
  const oldPush = HttpSyncClient.prototype.push;
  HttpSyncClient.prototype.push = () => new Promise(resolve => { finish = resolve; });
  try {
    const work = new PhoneSyncService(repo).synchronize();
    const edited = repo.get('d'); edited.code = 'newer'; repo.save(edited);
    assert.notEqual(repo.listPendingOperations()[0].operation_id, original.operation_id);
    finish({ status: 'applied', server_entity: original.payload });
    assert.equal((await work).status, 'local_only'); assert.equal(repo.get('d').code, 'newer');
    assert.equal(repo.listPendingOperations()[0].payload.code, 'newer');
    await repo.flush();
  } finally { HttpSyncClient.prototype.push = oldPush; }
});
test('phone sync preserves server version and creates a local conflict copy', async () => {
  const { PhoneSyncService } = load('platform/PhoneSyncService');
  const { HttpSyncClient } = load('platform/HttpSyncClient');
  const localPayload = { id: 'shared', title: 'Local', code: 'local edit', version: 0, deleted: false };
  const serverPayload = { ...localPayload, title: 'Server', code: 'server edit', version: 1, last_modified_client_id: 'web' };
  const operation = { operation_id: 'phone-conflict-op', entity_id: 'shared', payload: localPayload };
  const applied = []; let removed = ''; let conflictCopy; let conflictRecord;
  const repository = {
    listPendingOperations: () => [operation], markInFlight() {}, getBaseUrl: () => 'http://sync', getCursor: () => '0',
    getClientId: () => 'phone', getDraft: () => undefined, setCursor() {}, setDraftSyncStatus() {}, hasPendingOperation: () => false,
    flush: async () => {}, commitCursor: async () => {},
    removeOperation(id) { removed = id; }, applyServerDraft(draft) { applied.push(draft); },
    saveConflictDraft(copy, record) { conflictCopy = copy; conflictRecord = record; }
  };
  const oldPush = HttpSyncClient.prototype.push;
  const oldPull = HttpSyncClient.prototype.pull;
  HttpSyncClient.prototype.push = async () => ({ status: 'conflict', server_entity: serverPayload });
  HttpSyncClient.prototype.pull = async () => ({ changes: [], next_cursor: '0' });
  try {
    const result = await new PhoneSyncService(repository).synchronize();
    assert.equal(result.status, 'conflict');
    assert.equal(applied[0].code, 'server edit');
    assert.equal(conflictCopy.code, 'local edit');
    assert.equal(conflictCopy.id.startsWith('shared-conflict-'), true);
    assert.equal(conflictRecord.entity_id, 'shared');
    assert.equal(removed, 'phone-conflict-op');
  } finally {
    HttpSyncClient.prototype.push = oldPush;
    HttpSyncClient.prototype.pull = oldPull;
  }
});
test('Node ArkTS loader: PhoneSyncService orchestration retains an independent faithful artifact', async () => {
  const { PhoneSyncService } = load('platform/PhoneSyncService');
  const { HttpSyncClient } = load('platform/HttpSyncClient');
  const first = {
    id: 'phone-artifact-a', version: 0, server_sequence: 0,
    created_at: '2026-10-10T00:00:00.000Z', updated_at: '2026-10-10T00:00:00.000Z',
    deleted: false, last_modified_client_id: 'phone-a', draft_id: 'shared-draft',
    mode: 'faithful_transform', pseudocode: [{ id: 'step-a', step: 'Sort by right endpoint', source_refs: ['segment-1'] }],
    code_snippet: null, code_mappings: [], assumptions: [], missing_information: [], risk_flags: [],
    added_algorithm_steps: [], source_draft_version: 4, model_id: 'provider-disabled',
    rule_version: '1.0.0', output_kind: 'pseudocode', visibility: 'visible', template_id: null,
  };
  const second = { ...structuredClone(first), id: 'web-artifact-b', last_modified_client_id: 'web-b',
    created_at: '2026-10-10T00:00:01.000Z', updated_at: '2026-10-10T00:00:01.000Z',
    pseudocode: [{ id: 'step-b', step: 'Select non-overlapping intervals', source_refs: ['segment-1'] }] };
  const records = new Map([[first.id, first]]);
  const operations = [{ operation_id: 'phone-artifact-op', entity_type: 'ai_artifact', entity_id: first.id,
    operation_type: 'upsert', base_version: 0, client_id: 'phone-a', occurred_at: first.updated_at, payload: first }];
  const repository = {
    listPendingOperations: () => operations.slice(), markInFlight() {}, getBaseUrl: () => 'http://sync', getCursor: () => repository.cursor,
    getClientId: () => 'phone-a', getDraft: () => undefined, setCursor(cursor) { repository.cursor = cursor; }, cursor: '0',
    commitCursor: async (cursor) => { repository.cursor = cursor; }, flush: async () => {},
    setDraftSyncStatus() {}, hasPendingOperation: (id) => operations.some((operation) => operation.entity_id === id),
    removeOperation(id) { const index = operations.findIndex((operation) => operation.operation_id === id); if (index >= 0) operations.splice(index, 1); },
    applyServerDraft() {}, saveConflictDraft() {}, queueAIRecord() {}, getAIRecord: async (id) => records.get(id),
    applyServerAIArtifact: async (payload) => { records.set(payload.id, payload); }, applyServerReview: async () => {},
    saveConflictAIRecord: async () => {}, getDraftSourceCode: () => undefined, getDraftSourceSegments: () => undefined,
  };
  const oldPush = HttpSyncClient.prototype.push;
  const oldPull = HttpSyncClient.prototype.pull;
  HttpSyncClient.prototype.push = async (operation) => ({ status: 'applied', version: 1, server_entity: { ...operation.payload, version: 1, server_sequence: 1 } });
  HttpSyncClient.prototype.pull = async () => ({ changes: [{ cursor: '2', entity_type: 'ai_artifact', entity: { ...second, version: 1, server_sequence: 2 } }], next_cursor: '2' });
  try {
    const result = await new PhoneSyncService(repository).synchronize();
    assert.equal(result.status, 'synced');
    assert.equal(operations.length, 0);
    assert.equal(repository.cursor, '2');
    assert.deepEqual([...records.keys()].sort(), ['phone-artifact-a', 'web-artifact-b']);
  } finally {
    HttpSyncClient.prototype.push = oldPush;
    HttpSyncClient.prototype.pull = oldPull;
  }
});
test('phone sync ignores an older remote change during pull', async () => {
  const { PhoneSyncService } = load('platform/PhoneSyncService');
  const { HttpSyncClient } = load('platform/HttpSyncClient');
  const local = { id: 'ordered', version: 3, code: 'newer' };
  const repository = {
    listPendingOperations: () => [], markInFlight() {}, getBaseUrl: () => 'http://sync', getCursor: () => '2',
    getClientId: () => 'phone', getDraft: () => local, setCursor(cursor) { this.cursor = cursor; }, cursor: '2',
    commitCursor(cursor) { this.cursor = cursor; return Promise.resolve(); }, flush() { return Promise.resolve(); },
    setDraftSyncStatus() {}, hasPendingOperation: () => false, removeOperation() {}, applyServerDraft() { this.applied = true; },
    saveConflictDraft() {}
  };
  const oldPull = HttpSyncClient.prototype.pull;
  HttpSyncClient.prototype.pull = async () => ({ changes: [{ entity_type: 'draft', entity: {
    id: 'ordered', version: 2, code: 'older', last_modified_client_id: 'web'
  } }], next_cursor: '3' });
  try {
    const result = await new PhoneSyncService(repository).synchronize();
    assert.equal(result.status, 'synced');
    assert.equal(repository.applied, undefined);
    assert.equal(repository.cursor, '3');
  } finally { HttpSyncClient.prototype.pull = oldPull; }
});

const Card = load('platform/CardSnapshot');
const Routes = load('navigation/AppRoutes');
const CardModels = load('domain/Models');
function cardDraft(id, updatedAt, extra = {}) {
  return Object.assign(new CardModels.Draft(id, `title ${id}`), { updatedAt }, extra);
}

test('service card shows the most recently updated live draft, never a tombstone', () => {
  const snapshot = Card.selectCardSnapshot([
    cardDraft('old', '2026-10-01T00:00:00.000Z', { syncStatus: 'synced' }),
    cardDraft('gone', '2026-10-03T00:00:00.000Z', { deleted: true }),
    cardDraft('new', '2026-10-02T00:00:00.000Z')
  ]);
  assert.equal(snapshot.draftId, 'new');
  assert.equal(snapshot.syncStatus, 'local_only');
  const empty = Card.cardFormData(Card.selectCardSnapshot([cardDraft('gone', '2026-10-03T00:00:00.000Z', { deleted: true })]));
  assert.deepEqual({ ...empty }, { title: '暂无草稿', draftId: '', syncLabel: '点击新建思路开始记录', hasDraft: false });
});

test('service card surfaces failed or conflicting sync runs over the stored draft status', () => {
  const drafts = [cardDraft('a', '2026-10-01T00:00:00.000Z', { syncStatus: 'synced' })];
  assert.equal(Card.selectCardSnapshot(drafts, 'failed').syncStatus, 'failed');
  assert.equal(Card.selectCardSnapshot(drafts, 'conflict').syncStatus, 'conflict');
  assert.equal(Card.selectCardSnapshot(drafts, 'local_only').syncStatus, 'synced');
  assert.deepEqual(['synced', 'syncing', 'conflict', 'failed', 'local_only', 'unknown'].map(Card.cardStatusLabel),
    ['已同步', '同步中', '有冲突', '同步失败', '仅本地', '仅本地']);
});

test('service card data carries only title and status, with a bounded title', () => {
  const draft = cardDraft('a', '2026-10-01T00:00:00.000Z', { title: 'x'.repeat(40), idea: 'secret idea', code: 'int main() {}' });
  const data = Card.cardFormData(Card.selectCardSnapshot([draft]));
  assert.deepEqual(Object.keys(data).sort(), ['draftId', 'hasDraft', 'syncLabel', 'title']);
  assert.equal(data.title, 'x'.repeat(24) + '…');
  assert.ok(!JSON.stringify(data).includes('secret') && !JSON.stringify(data).includes('main'));
  assert.equal(Card.cardFormData(Card.selectCardSnapshot([cardDraft('b', '2026-10-01', { title: '  ' })])).title, '未命名思路');
});

test('publishing a card snapshot persists it and updates every added card', async () => {
  cardKit.prefs.clear(); cardKit.updates = []; cardKit.forms = ['f1', 'f2']; cardKit.failList = false;
  await Card.publishCardSnapshot({}, [cardDraft('a', '2026-10-01T00:00:00.000Z', { syncStatus: 'synced' })]);
  assert.deepEqual(cardKit.updates.map(update => update.formId), ['f1', 'f2']);
  assert.deepEqual(cardKit.updates[0].data, { title: 'title a', draftId: 'a', syncLabel: '已同步', hasDraft: true });
  const restored = Card.loadCardSnapshotSync({});
  assert.equal(restored.draftId, 'a');
  assert.equal(restored.syncStatus, 'synced');
  cardKit.failList = true; cardKit.updates = [];
  await Card.publishCardSnapshot({}, []);
  assert.equal(cardKit.updates.length, 0);
  assert.equal(Card.loadCardSnapshotSync({}).draftId, '');
  cardKit.failList = false; cardKit.forms = [];
});

test('card launch parameters map to explicit actions, accepting nested and legacy params', () => {
  const parse = (parameters) => { const r = Routes.parseCardLaunch(parameters, 'n1'); return [r.action, r.draftId]; };
  assert.deepEqual(parse({ card_action: 'open_draft', draft_id: 'd1' }), ['open_draft', 'd1']);
  assert.deepEqual(parse({ params: JSON.stringify({ card_action: 'new_draft', draft_id: '' }) }), ['new_draft', '']);
  assert.deepEqual(parse({ draft_id: 'legacy' }), ['open_draft', 'legacy']);
  assert.deepEqual(parse({ draft_id: 'latest' }), ['open_home', '']);
  assert.deepEqual(parse({ card_action: 'open_draft', draft_id: ' ' }), ['open_home', '']);
  assert.deepEqual(parse({ card_action: 'open_home' }), ['open_home', '']);
  assert.deepEqual(parse({ params: '{broken' }), ['none', '']);
  assert.deepEqual(parse(undefined), ['none', '']);
  assert.deepEqual(parse({ 'ohos.aafwk.param.callerBundleName': 'x' }), ['none', '']);
});

test('card requests round-trip through AppStorage encoding and reject malformed values', () => {
  const request = Routes.parseCardLaunch({ card_action: 'open_draft', draft_id: 'd1' }, 'nonce-1');
  const decoded = Routes.decodeCardRequest(Routes.encodeCardRequest(request));
  assert.deepEqual([decoded.action, decoded.draftId, decoded.nonce], ['open_draft', 'd1', 'nonce-1']);
  assert.equal(Routes.encodeCardRequest(Routes.parseCardLaunch(undefined, 'n')), '');
  assert.notEqual(Routes.encodeCardRequest(Routes.parseCardLaunch({ card_action: 'new_draft' }, 'a')),
    Routes.encodeCardRequest(Routes.parseCardLaunch({ card_action: 'new_draft' }, 'b')));
  for (const value of [undefined, '', '{', JSON.stringify({ action: 'drop_db' }), JSON.stringify({ action: 'open_draft', draft_id: '' })]) {
    assert.equal(Routes.decodeCardRequest(value).action, 'none');
  }
});
const pairingVectors = JSON.parse(readFileSync('packages/contracts/vectors/pairing-invitations.json'));
for (const vector of pairingVectors.invitations) {
  test('phone pairing invitation vector: ' + vector.name, () => {
    const { parsePairingInvitation } = load('domain/PairingContract');
    const parsed = parsePairingInvitation(vector.text);
    assert.equal(parsed.invitation !== undefined, vector.valid, parsed.error);
    if (!vector.valid) assert.ok(parsed.error.length > 0);
  });
}
test('manual pairing defaults the sync port and keeps explicit addresses', () => {
  const { manualPairingInvitation } = load('domain/PairingContract');
  assert.equal(manualPairingInvitation('192.168.1.5', '0482 9103').invitation.syncApi, 'http://192.168.1.5:8787');
  assert.equal(manualPairingInvitation('', '04829103').invitation.syncApi, 'http://127.0.0.1:8787');
  assert.equal(manualPairingInvitation('192.168.1.5:9000', '04829103').invitation.syncApi, 'http://192.168.1.5:9000');
  assert.equal(manualPairingInvitation('https://relay.example.test/sync/', '04829103').invitation.syncApi, 'https://relay.example.test/sync');
  assert.equal(manualPairingInvitation('192.168.1.5', '1234').invitation, undefined);
  assert.equal(manualPairingInvitation('bad host', '04829103').invitation, undefined);
});
test('pairing claim rewrites a desktop loopback AI endpoint to the host the phone reached', () => {
  const { PairingClaim, resolvePairingEndpoints } = load('domain/PairingContract');
  const claim = Object.assign(new PairingClaim(), { syncApi: 'http://127.0.0.1:8787', aiGateway: 'http://127.0.0.1:8788' });
  assert.deepEqual(resolvePairingEndpoints('http://192.168.1.5:8787', claim), ['http://192.168.1.5:8787', 'http://192.168.1.5:8788']);
  assert.deepEqual(resolvePairingEndpoints('http://127.0.0.1:8787', claim), ['http://127.0.0.1:8787', 'http://127.0.0.1:8788']);
  claim.aiGateway = 'https://ai.example.test';
  assert.deepEqual(resolvePairingEndpoints('http://192.168.1.5:8787', claim), ['http://192.168.1.5:8787', 'https://ai.example.test']);
});
test('pairing client maps server rejections, transport failure and malformed claims', async () => {
  let reply = { responseCode: 200, result: '' }, fail = false, destroyed = 0, sent;
  const http = { RequestMethod: { POST: 'POST' }, HttpDataType: { STRING: 'STRING' }, createHttp() {
    return { async request(url, options) { sent = { url, options }; if (fail) throw { code: 2300007 }; return reply; }, destroy() { destroyed++; } };
  } };
  const { HttpPairingClient } = loader(true, http)('platform/HttpPairingClient');
  const { PairingInvitation } = loader(true, http)('domain/PairingContract');
  const client = new HttpPairingClient();
  const invitation = Object.assign(new PairingInvitation(), { syncApi: 'http://192.168.1.5:8787', code: '04829103' });
  reply = { responseCode: 200, result: JSON.stringify({ status: 'claimed', pairing_id: 'p1', computer_name: 'PC', route: 'lan',
    sync_api: 'http://127.0.0.1:8787', ai_gateway: 'http://127.0.0.1:8788' }) };
  const claim = await client.claim(invitation, 'phone-1');
  assert.equal(sent.url, 'http://192.168.1.5:8787/v1/pairing/claims');
  assert.deepEqual(JSON.parse(sent.options.extraData), { code: '04829103', phone_client_id: 'phone-1' });
  assert.equal(claim.pairingId, 'p1');
  for (const [status, code] of [[410, 'PAIRING_CODE_EXPIRED'], [409, 'PAIRING_CODE_USED'], [404, 'PAIRING_CODE_INVALID'], [429, 'PAIRING_RATE_LIMITED']]) {
    reply = { responseCode: status, result: JSON.stringify({ status: 'rejected', error_code: code }) };
    await assert.rejects(client.claim(invitation, 'phone-1'), (error) => error.code === code);
  }
  reply = { responseCode: 200, result: JSON.stringify({ status: 'claimed', pairing_id: 'p1', sync_api: 'ftp://x', ai_gateway: 'http://y' }) };
  await assert.rejects(client.claim(invitation, 'phone-1'), (error) => error.code === 'INVALID_RESPONSE');
  fail = true;
  await assert.rejects(client.claim(invitation, 'phone-1'), (error) => error.code === 'NETWORK');
  assert.equal(destroyed, 7);
});
test('view model stores claimed endpoints only after a successful claim', async () => {
  const { DraftWorkspaceViewModel } = load('application/DraftWorkspaceViewModel');
  const { PairingClaim, PairingInvitation, PairingError } = load('domain/PairingContract');
  const writes = [];
  const repository = { setAIBaseUrl(value) { writes.push(['ai', value]); } };
  const sync = { getClientId: () => 'phone-1', setBaseUrl(value) { writes.push(['sync', value]); } };
  const vm = new DraftWorkspaceViewModel(repository, sync, { cancel() {} });
  const invitation = Object.assign(new PairingInvitation(), { syncApi: 'http://192.168.1.5:8787', code: '04829103' });
  vm.pairingClient = { async claim() { throw new PairingError('PAIRING_CODE_EXPIRED'); } };
  await assert.rejects(vm.claimPairing(invitation));
  assert.deepEqual(writes, []);
  let claimedBy;
  vm.pairingClient = { async claim(_, clientId) { claimedBy = clientId;
    return Object.assign(new PairingClaim(), { pairingId: 'p1', syncApi: 'http://127.0.0.1:8787', aiGateway: 'http://127.0.0.1:8788' }); } };
  const claim = await vm.claimPairing(invitation);
  assert.equal(claimedBy, 'phone-1');
  assert.deepEqual(writes, [['sync', 'http://192.168.1.5:8787'], ['ai', 'http://192.168.1.5:8788']]);
  assert.equal(claim.aiGateway, 'http://192.168.1.5:8788');
});
test('view model ignores an unchanged update so pulled content is not re-queued as an edit', () => {
  const { DraftWorkspaceViewModel } = load('application/DraftWorkspaceViewModel');
  const { Draft } = load('domain/Models');
  const draft = new Draft('d', 'Server title'); draft.code = 'server code'; draft.version = 2;
  draft.updatedAt = '2026-10-22T00:00:00.000Z';
  let saves = 0, cancels = 0;
  const vm = new DraftWorkspaceViewModel({ get: (id) => (id === 'd' ? draft : undefined), save() { saves++; } }, undefined,
    { cancel() { cancels++; } });
  assert.equal(vm.update('d', 'Server title', '', 'server code', '', ''), false);
  assert.equal(saves, 0);
  assert.equal(cancels, 0, 'an unchanged update must not cancel a running AI request');
  assert.equal(draft.updatedAt, '2026-10-22T00:00:00.000Z');
  assert.equal(vm.update('d', 'User title', '', 'server code', '', ''), true);
  assert.equal(saves, 1);
  assert.equal(vm.update('missing', 'x', '', '', '', ''), false);
});
test('phone sync keeps an operation when a duplicate arrives without server_entity', async () => {
  const { PhoneSyncService } = load('platform/PhoneSyncService');
  const { HttpSyncClient } = load('platform/HttpSyncClient');
  const operation = { operation_id: 'op-dup', entity_type: 'draft', entity_id: 'd', operation_type: 'upsert',
    base_version: 1, client_id: 'phone', occurred_at: '2026-10-22T00:00:00.000Z', payload: { id: 'd', title: 'Local edit', version: 1 } };
  const statuses = [];
  const repository = {
    operations: [operation], listPendingOperations() { return this.operations.slice(); }, markInFlight() {},
    getBaseUrl: () => 'http://sync', getCursor: () => '0', getClientId: () => 'phone',
    setDraftSyncStatus(id, status) { statuses.push(status); }, removeOperation(id) { this.operations = this.operations.filter(o => o.operation_id !== id); },
    applyServerDraft() { this.applied = true; }, flush: () => Promise.resolve(), commitCursor() { this.committed = true; return Promise.resolve(); }
  };
  const oldPush = HttpSyncClient.prototype.push;
  const oldPull = HttpSyncClient.prototype.pull;
  HttpSyncClient.prototype.push = async (op) => ({ operation_id: op.operation_id, status: 'duplicate' });
  HttpSyncClient.prototype.pull = async () => { throw new Error('pull must not run'); };
  try {
    const result = await new PhoneSyncService(repository).synchronize();
    assert.equal(result.status, 'failed');
    assert.equal(repository.operations.length, 1, 'the unconfirmed edit stays queued');
    assert.equal(repository.applied, undefined, 'the local payload must not be applied as the server version');
    assert.equal(statuses.at(-1), 'failed');
    assert.equal(repository.committed, undefined);
  } finally {
    HttpSyncClient.prototype.push = oldPush;
    HttpSyncClient.prototype.pull = oldPull;
  }
});
test('phone sends base_epoch and the epoch query once a server epoch is committed', async () => {
  const sent = [];
  const http = { RequestMethod: { POST: 'POST', GET: 'GET' }, HttpDataType: { STRING: 'STRING' }, createHttp() {
    return { async request(url, options) { sent.push({ url, body: options.extraData });
      return { responseCode: 200, result: JSON.stringify(url.includes('/changes') ? { changes: [], next_cursor: '0', server_epoch: 'e1', reset: false }
        : { operation_id: 'op', status: 'applied', server_epoch: 'e1' }) }; }, destroy() {} };
  } };
  const { HttpSyncClient } = loader(true, http)('platform/HttpSyncClient');
  const { SyncOperation } = loader(true, http)('domain/SyncModels');
  const op = Object.assign(new SyncOperation(), { operation_id: 'op', entity_id: 'd', base_version: 2, client_id: 'phone', occurred_at: '2026-10-22T00:00:00.000Z' });
  const sync = new HttpSyncClient('http://sync');
  await sync.push(op, 'e1');
  await sync.push(op);
  await sync.pull('3', 'e1');
  await sync.pull('3');
  assert.equal(JSON.parse(sent[0].body).base_epoch, 'e1');
  assert.equal('base_epoch' in JSON.parse(sent[1].body), false, 'no epoch is sent before the first pull');
  assert.equal(sent[2].url, 'http://sync/v1/sync/changes?after=3&epoch=e1');
  assert.equal(sent[3].url, 'http://sync/v1/sync/changes?after=3');
});
test('RDB repository stores the server epoch with the cursor and rebases a draft for a new server', async () => {
  const { RdbDraftRepository } = load('platform/RdbDraftRepository');
  const { Draft } = load('domain/Models');
  const sql = [];
  const repo = new RdbDraftRepository({});
  repo.store = { version: 3, async executeSql(statement, args) { sql.push([statement, args]); } };
  repo.clientId = 'phone';
  await repo.commitCursor('5', 'epoch-a');
  assert.equal(repo.getCursor(), '5');
  assert.equal(repo.getServerEpoch(), 'epoch-a');
  assert.ok(sql.some(([statement, args]) => statement.includes('sync_state') && args[0] === 'server_epoch' && args[1] === 'epoch-a'));
  await repo.commitCursor('6');
  assert.equal(repo.getServerEpoch(), 'epoch-a', 'a pull without an epoch keeps the stored one');

  const draft = new Draft('d', 'kept'); draft.code = 'content'; draft.version = 4;
  repo.applyServerDraft(draft);
  assert.deepEqual(repo.getDraftSourceVersions('d'), [4]);
  repo.rebaseDraftForNewServer('d');
  await repo.flush();
  const rebased = repo.getDraft('d');
  assert.equal(rebased.version, 0);
  assert.equal(rebased.code, 'content');
  assert.equal(rebased.syncStatus, 'local_only');
  assert.deepEqual(repo.getDraftSourceVersions('d'), [], 'old-lineage snapshots are dropped');
  const queued = repo.listPendingOperations();
  assert.equal(queued.length, 1);
  assert.equal(queued[0].base_version, 0);
  assert.ok(sql.some(([statement, args]) => statement.startsWith('DELETE FROM draft_source_history') && args[0] === 'd'));
  assert.deepEqual(repo.listDraftIds(), ['d']);
});
function epochRepository(drafts, operations = []) {
  return {
    drafts: new Map(drafts.map((draft) => [draft.id, draft])), operations, epoch: 'epoch-a', cursor: '9', applied: [], rebased: [], statuses: [],
    getClientId: () => 'phone', getBaseUrl: () => 'http://sync',
    getCursor() { return this.cursor; }, getServerEpoch() { return this.epoch; },
    listPendingOperations() { return this.operations.map((op) => ({ ...op })); }, markInFlight() {},
    hasPendingOperation(id) { return this.operations.some((op) => op.entity_id === id); },
    removeOperation(id) { this.operations = this.operations.filter((op) => op.operation_id !== id); },
    setDraftSyncStatus(id, status) { this.statuses.push([id, status]); },
    getDraft(id) { return this.drafts.get(id); },
    listDraftIds() { return [...this.drafts.keys()]; },
    applyServerDraft(draft) { this.applied.push(`${draft.id}@${draft.version}`); this.drafts.set(draft.id, draft); },
    rebaseDraftForNewServer(id) {
      this.rebased.push(id);
      const draft = this.drafts.get(id); draft.version = 0;
      this.operations = this.operations.filter((op) => op.entity_id !== id);
      this.operations.push({ operation_id: `rebased-${id}`, entity_type: 'draft', entity_id: id, operation_type: 'upsert', base_version: 0,
        client_id: 'phone', occurred_at: '2026-10-22T00:00:00.000Z', payload: { id, version: 0, code: draft.code } });
    },
    saveConflictDraft() {}, flush: () => Promise.resolve(),
    commitCursor(cursor, epoch) { this.cursor = cursor; if (epoch) this.epoch = epoch; return Promise.resolve(); }
  };
}
test('phone re-creates a draft the restarted server lost and retries the push once', async () => {
  const { PhoneSyncService } = load('platform/PhoneSyncService');
  const { HttpSyncClient } = load('platform/HttpSyncClient');
  const repo = epochRepository([{ id: 'd', version: 3, code: 'local', deleted: false }],
    [{ operation_id: 'old', entity_type: 'draft', entity_id: 'd', operation_type: 'upsert', base_version: 3, client_id: 'phone',
      occurred_at: '2026-10-22T00:00:00.000Z', payload: { id: 'd', version: 3, code: 'local' } }]);
  const pushes = [];
  const oldPush = HttpSyncClient.prototype.push;
  const oldPull = HttpSyncClient.prototype.pull;
  HttpSyncClient.prototype.push = async (op, epoch) => {
    pushes.push([op.operation_id, op.base_version, epoch]);
    return op.base_version > 0
      ? { operation_id: op.operation_id, status: 'conflict', error_code: 'EPOCH_MISMATCH', server_entity: null, server_epoch: 'epoch-b' }
      : { operation_id: op.operation_id, status: 'applied', version: 1, server_entity: { id: 'd', version: 1, code: 'local' }, server_epoch: 'epoch-b' };
  };
  HttpSyncClient.prototype.pull = async () => ({
    changes: [{ cursor: '1', entity_type: 'draft', entity: { id: 'd', version: 1, code: 'local', last_modified_client_id: 'phone' } }],
    next_cursor: '1', server_epoch: 'epoch-b', reset: true });
  try {
    const result = await new PhoneSyncService(repo).synchronize();
    assert.deepEqual(pushes, [['old', 3, 'epoch-a'], ['rebased-d', 0, 'epoch-a']]);
    assert.equal(result.status, 'synced');
    assert.deepEqual(repo.rebased, ['d']);
    assert.equal(repo.operations.length, 0);
    assert.equal(repo.drafts.get('d').version, 1);
    assert.equal(repo.epoch, 'epoch-b');
    assert.equal(repo.cursor, '1');
  } finally {
    HttpSyncClient.prototype.push = oldPush;
    HttpSyncClient.prototype.pull = oldPull;
  }
});
test('phone reset pull adopts the latest server copy and re-creates drafts the server lost', async () => {
  const { PhoneSyncService } = load('platform/PhoneSyncService');
  const { HttpSyncClient } = load('platform/HttpSyncClient');
  const repo = epochRepository([
    { id: 'shared', version: 5, code: 'old lineage v5', deleted: false },
    { id: 'lost', version: 2, code: 'only here', deleted: false },
    { id: 'blank', version: 0, code: '', deleted: false }
  ]);
  const pulls = [];
  const oldPull = HttpSyncClient.prototype.pull;
  HttpSyncClient.prototype.pull = async (cursor, epoch) => {
    pulls.push([cursor, epoch]);
    return { changes: [
      { cursor: '1', entity_type: 'draft', entity: { id: 'shared', version: 1, code: 'reseeded v1', last_modified_client_id: 'phone' } },
      { cursor: '2', entity_type: 'draft', entity: { id: 'shared', version: 2, code: 'reseeded v2', last_modified_client_id: 'web' } }
    ], next_cursor: '2', server_epoch: 'epoch-b', reset: true };
  };
  try {
    const result = await new PhoneSyncService(repo).synchronize();
    assert.deepEqual(pulls, [['9', 'epoch-a']]);
    assert.deepEqual(repo.applied, ['shared@2'], 'the server copy wins over the old-lineage v5, latest change only');
    assert.equal(repo.drafts.get('shared').code, 'reseeded v2');
    assert.deepEqual(repo.rebased, ['lost'], 'version-0 drafts are not re-created');
    assert.equal(result.status, 'local_only', 'the re-created draft is uploaded on the next run');
    assert.equal(repo.epoch, 'epoch-b');
  } finally {
    HttpSyncClient.prototype.pull = oldPull;
  }
});
test('phone without a stored epoch replays from 0 once, but an epoch-less server keeps the old merge', async () => {
  const { PhoneSyncService } = load('platform/PhoneSyncService');
  const { HttpSyncClient } = load('platform/HttpSyncClient');
  const oldPull = HttpSyncClient.prototype.pull;
  try {
    const upgraded = epochRepository([{ id: 'x', version: 4, code: 'x', deleted: false }]);
    upgraded.epoch = '';
    let asked;
    HttpSyncClient.prototype.pull = async (cursor) => { asked = cursor; return { changes: [], next_cursor: '0', server_epoch: 'epoch-b', reset: false }; };
    await new PhoneSyncService(upgraded).synchronize();
    assert.equal(asked, '0');
    assert.deepEqual(upgraded.rebased, ['x'], 'the server has nothing for x, so it is re-created');
    assert.equal(upgraded.epoch, 'epoch-b');

    const legacy = epochRepository([{ id: 'y', version: 4, code: 'y', deleted: false }]);
    legacy.epoch = '';
    HttpSyncClient.prototype.pull = async () => ({ changes: [], next_cursor: '9' });
    await new PhoneSyncService(legacy).synchronize();
    assert.deepEqual(legacy.rebased, [], 'without a server epoch nothing is rebased');
    assert.equal(legacy.epoch, '');
  } finally {
    HttpSyncClient.prototype.pull = oldPull;
  }
});
test('issue #20: a read timeout is AI_PROVIDER_TIMEOUT, connect failures stay NETWORK_ERROR, and nothing retries', async () => {
  let calls = 0, failure;
  const http = { RequestMethod: { POST: 'POST' }, HttpDataType: { STRING: 'STRING' }, createHttp() {
    return { async request() { calls++; throw failure; }, destroy() {} };
  } };
  const stubbedLoader = loader(true, http);
  const { HttpAIProvider, classifyTransportError } = stubbedLoader('platform/HttpAIProvider');
  const provider = new HttpAIProvider('http://test', 5, 10000, true);
  let clock = 0;
  provider.now = () => clock;
  const body = M.buildIDERequest(recordFor(request));
  const run = async (code, ms) => {
    failure = { code, message: 'transport' }; clock = 0;
    const work = provider.request(body, 'transform');
    clock = ms;
    return work;
  };

  let reply = await run(2300028, 10012);
  assert.equal(reply.errorCode, 'AI_PROVIDER_TIMEOUT');
  assert.equal(reply.message, 'AI 请求超时');
  assert.equal(calls, 1, 'a read timeout is not retried');

  reply = await run(2300028, 5003);
  assert.equal(reply.errorCode, 'AI_PROVIDER_TIMEOUT', 'just past the connect timeout the socket was connected');
  reply = await run(2300028, 4990);
  assert.equal(reply.errorCode, 'NETWORK_ERROR', 'a timeout within the connect window is a connect timeout');
  for (const code of [2300007, 2300006, 2300056, undefined]) {
    reply = await run(code, 12000);
    assert.equal(reply.errorCode, 'NETWORK_ERROR', `code ${code}`);
    assert.match(reply.message, /不可达/);
  }
  assert.equal(calls, 7, 'every failure makes exactly one transport call');

  assert.equal(classifyTransportError(2300028, 6000), 'read_timeout');
  assert.equal(classifyTransportError(2300028, 1000), 'connect_timeout');
  assert.equal(classifyTransportError(2300007, 6000), 'network');
});
test('issue #20: the legacy generate() path reports AI_PROVIDER_TIMEOUT and cancel still wins over a timeout', async () => {
  let fail;
  const http = { RequestMethod: { POST: 'POST' }, HttpDataType: { STRING: 'STRING' }, createHttp() {
    return { request() { return new Promise((_, reject) => { fail = reject; }); }, destroy() {} };
  } };
  const { HttpAIProvider } = loader(true, http)('platform/HttpAIProvider');
  const { AIRequest, AIRequestSegment } = loader(true, http)('domain/Models');
  const provider = new HttpAIProvider('http://test', 0, 10000, true);
  let clock = 0; provider.now = () => clock;
  const aiRequest = new AIRequest('faithful_transform', 'd', 1, 'cpp', '1.0.0', 'p', [new AIRequestSegment('s1', 'idea')], 'pseudocode', 'visible');
  const pending = provider.generate(aiRequest);
  clock = 10010; fail({ code: 2300028 });
  const result = await pending;
  assert.equal(result.errorCode, 'AI_PROVIDER_TIMEOUT');

  const cancelled = provider.request(M.buildIDERequest(recordFor(request)), 'transform');
  provider.cancel();
  clock = 20020; fail({ code: 2300028 });
  assert.equal((await cancelled).errorCode, 'CANCELLED');
});

// Rewrite comparison: the ArkTS mirror must produce the Web results for the
// same shared vectors. Class instances are compared through JSON.
const rewriteVectors = JSON.parse(readFileSync('packages/contracts/vectors/rewrite-compare.json'));
const RC = load('domain/RewriteCompare');
const plain = value => JSON.parse(JSON.stringify(value));
test('phone rewrite comparison matches the shared vectors', () => {
  for (const vector of rewriteVectors.compare) {
    const source = Object.assign(new RC.RewriteCompareSource(), vector.source);
    assert.deepEqual(plain(RC.compareRewrite(source, vector.rewrite, vector.rewrite_mappings)), vector.expected, vector.name);
  }
  for (const vector of rewriteVectors.assign) {
    assert.deepEqual(plain(RC.assignRewriteLines(vector.mappings, vector.start, vector.end, vector.step_id)), vector.expected, vector.name);
  }
  for (const vector of rewriteVectors.fingerprint) assert.equal(RC.rewriteFingerprint(vector.text), vector.expected);
  for (const vector of rewriteVectors.selection) assert.deepEqual(plain(RC.selectionLines(vector.text, vector.from, vector.to)), vector.expected, vector.name);
});

test('phone rewrite partition records decode strictly and resolve per artifact', () => {
  const record = RC.createRewriteMappingRecord('d', 'ai-1', 'x;\ny;', [new RC.RewriteLineMapping('step_1', 1, 2)]);
  const decoded = RC.decodeRewriteMappingRecord(JSON.stringify(record));
  assert.deepEqual(plain(decoded), plain(record));
  assert.equal(RC.resolveRewriteMapping(decoded, 'ai-1', 'x;\r\ny;').status, 'current');
  assert.equal(RC.resolveRewriteMapping(decoded, 'ai-1', 'x;').status, 'outdated');
  assert.equal(RC.resolveRewriteMapping(decoded, 'ai-2', 'x;\ny;').status, 'empty');
  assert.equal(RC.decodeRewriteMappingRecord('{broken'), null);
  assert.equal(RC.decodeRewriteMappingRecord(JSON.stringify({ ...plain(record), mappings: [{ step_id: 's', start_line: 2, end_line: 1 }] })), null);
  assert.equal(RC.decodeRewriteMappingRecord(JSON.stringify({ ...plain(record), artifact_id: '' })), null);
});

test('phone transform requests the chosen output kind and rejects a mismatched reply', async () => {
  const sent = [];
  const snippetBody = {
    mode: 'faithful_transform', pseudocode: [{ id: 'step_1', step: 'Sort', source_refs: [request.idea_segments[0].id] }],
    code_snippet: 'sort(a, a + n);', code_mappings: [{ step_id: 'step_1', start_line: 1, end_line: 1 }],
    assumptions: [], missing_information: [], risk_flags: ['未检查空输入'], added_algorithm_steps: [],
    source_draft_version: request.draft_version, model_id: 'fixture', rule_version: '1.0.0',
    output_kind: 'code_snippet', visibility: 'visible', template_id: null,
  };
  let body = snippetBody;
  const provider = { cancel() {}, async request(payload) { sent.push(payload.output_kind); return Object.assign(new M.IDEReply(), { body: JSON.stringify(body) }); } };
  const repo = { async list() { return []; }, async save() {}, async removeDraft() {} };
  const session = new IDEAISession(provider, repo);
  await session.setContext(recordFor(request, 'transform').context);
  await session.request('transform', 'explanation', new M.SourceCursor(), 'code_snippet');
  assert.deepEqual(sent, ['code_snippet']);
  const record = session.records.at(-1);
  assert.equal(record.state, 'success');
  const source = RC.compareSourceFromBody(record.body);
  assert.equal(source.code_snippet, 'sort(a, a + n);');
  assert.deepEqual(plain(source.code_mappings), [{ step_id: 'step_1', start_line: 1, end_line: 1 }]);
  assert.deepEqual(source.risk_flags, ['未检查空输入']);
  await session.request('transform');
  assert.equal(sent.at(-1), 'pseudocode');
  assert.equal(session.records.at(-1).errorCode, 'INVALID_AI_ARTIFACT');
  body = { ...snippetBody, code_snippet: null, code_mappings: [], output_kind: 'pseudocode' };
  await session.request('transform', 'explanation', new M.SourceCursor(), 'code_snippet');
  assert.equal(session.records.at(-1).errorCode, 'INVALID_AI_ARTIFACT');
  assert.equal(RC.compareSourceFromBody(JSON.stringify(body)), null);
});

test('phone sync drops a queued AI result the server permanently rejects and keeps going', async () => {
  const { PhoneSyncService } = load('platform/PhoneSyncService');
  const { HttpSyncClient } = load('platform/HttpSyncClient');
  const artifact = { id: 'phone-artifact-lost', version: 0, draft_id: 'draft-local', source_draft_version: 1 };
  const operations = [
    { operation_id: 'op-artifact', entity_type: 'ai_artifact', entity_id: artifact.id, operation_type: 'upsert', base_version: 0, client_id: 'phone', occurred_at: '2026-10-23T00:00:00.000Z', payload: artifact },
    { operation_id: 'op-review', entity_type: 'review_result', entity_id: 'phone-review-lost', operation_type: 'upsert', base_version: 0, client_id: 'phone', occurred_at: '2026-10-23T00:00:00.000Z', payload: { id: 'phone-review-lost' } },
    { operation_id: 'op-draft', entity_type: 'draft', entity_id: 'draft-local', operation_type: 'upsert', base_version: 1, client_id: 'phone', occurred_at: '2026-10-23T00:00:00.000Z', payload: { id: 'draft-local', version: 1 } },
  ];
  const statuses = [];
  const repository = {
    listPendingOperations: () => operations.slice(), markInFlight() {}, getBaseUrl: () => 'http://sync', getCursor: () => repository.cursor, cursor: '3',
    getServerEpoch: () => 'epoch-old', getClientId: () => 'phone', getDraft: () => undefined,
    commitCursor: async (cursor) => { repository.cursor = cursor; }, flush: async () => {},
    setDraftSyncStatus(id, status) { statuses.push(`${id}:${status}`); }, hasPendingOperation: (id) => operations.some((operation) => operation.entity_id === id),
    removeOperation(id) { const index = operations.findIndex((operation) => operation.operation_id === id); if (index >= 0) operations.splice(index, 1); },
    applyServerDraft() { repository.draftApplied = true; }, applyServerAIArtifact: async () => {}, applyServerReview: async () => {},
  };
  const pushed = [];
  const oldPush = HttpSyncClient.prototype.push;
  const oldPull = HttpSyncClient.prototype.pull;
  HttpSyncClient.prototype.push = async (operation) => {
    pushed.push(operation.operation_id);
    if (operation.entity_type === 'ai_artifact') throw new Error('SYNC_HTTP_422_INVALID_AI_ARTIFACT');
    if (operation.entity_type === 'review_result') throw new Error('SYNC_HTTP_400_INVALID_REVIEW_RESULT');
    return { status: 'applied', version: 2, server_entity: { ...operation.payload, version: 2 } };
  };
  HttpSyncClient.prototype.pull = async () => ({ changes: [], next_cursor: '4', server_epoch: 'epoch-old', reset: false });
  try {
    const result = await new PhoneSyncService(repository).synchronize();
    assert.deepEqual(pushed, ['op-artifact', 'op-review', 'op-draft']);
    assert.equal(result.status, 'synced');
    assert.equal(repository.cursor, '4');
    assert.equal(repository.draftApplied, true);
    assert.deepEqual(operations, []);
    assert.equal(statuses.some((status) => status.endsWith(':failed')), false);
  } finally {
    HttpSyncClient.prototype.push = oldPush;
    HttpSyncClient.prototype.pull = oldPull;
  }
});

test('phone sync keeps a queued AI result after a transient failure', async () => {
  const { PhoneSyncService } = load('platform/PhoneSyncService');
  const { HttpSyncClient } = load('platform/HttpSyncClient');
  const operations = [{ operation_id: 'op-artifact', entity_type: 'ai_artifact', entity_id: 'a', operation_type: 'upsert', base_version: 0, client_id: 'phone', occurred_at: '2026-10-23T00:00:00.000Z', payload: { id: 'a' } }];
  const repository = {
    listPendingOperations: () => operations.slice(), markInFlight() {}, getBaseUrl: () => 'http://sync', getCursor: () => '3', getClientId: () => 'phone',
    setDraftSyncStatus() {}, removeOperation(id) { operations.splice(operations.findIndex((operation) => operation.operation_id === id), 1); },
  };
  const oldPush = HttpSyncClient.prototype.push;
  HttpSyncClient.prototype.push = async () => { throw new Error('SYNC_NETWORK_2300007'); };
  try {
    const result = await new PhoneSyncService(repository).synchronize();
    assert.equal(result.status, 'failed');
    assert.equal(operations.length, 1);
  } finally { HttpSyncClient.prototype.push = oldPush; }
});
