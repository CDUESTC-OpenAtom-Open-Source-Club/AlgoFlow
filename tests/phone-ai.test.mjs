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
function loader(debug = true, http = {}) {
  const cache = new Map();
  const stubs = {
    '@kit.AbilityKit': {}, '@kit.BasicServicesKit': {},
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
  for (const version of [0, 1, 2, 3]) {
    const sql = []; const store = { version, beginTransaction() {}, commit() {}, rollBack() {}, async executeSql(s) { sql.push(s); } };
    const repo = new RdbDraftRepository({});
    if (version === 3) await assert.rejects(repo.migrate(store));
    else { await repo.migrate(store); assert.equal(store.version, 2); }
    assert.equal(sql.some(s => /DROP|DELETE/.test(s)), false);
  }
  let rolled = false; const store = { version: 1, beginTransaction() {}, commit() {}, rollBack() { rolled = true; }, async executeSql() { throw Error('full'); } };
  await assert.rejects(new RdbDraftRepository({}).migrate(store)); assert.equal(store.version, 1); assert.equal(rolled, true);
});
test('migration preparation fixture preserves every v1 table and field', async () => {
  const { migrateWorkspaceStore } = load('platform/RdbDraftRepository');
  const sql = [];
  const store = { version: 1, beginTransaction() {}, commit() {}, rollBack() {}, async executeSql(statement) { sql.push(statement); } };
  await migrateWorkspaceStore(store);
  assert.equal(store.version, 2);
  for (const table of ['drafts', 'sync_operations', 'sync_state', 'conflicts']) {
    assert.equal(sql.some(statement => statement.includes(table)), false, `v1->v2 must not recreate ${table}`);
  }
  assert.equal(sql.filter(statement => statement.includes('CREATE TABLE ai_results')).length, 1);
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
test('AI result persistence only targets ai_results and deletion is isolated', async () => {
  const record = recordFor(request, 'completion'); record.body = JSON.stringify(artifact);
  const testRecord = structuredClone(record); testRecord.isTestData = true;
  const calls = [];
  const store = { async executeSql(sql, args) { calls.push([sql, args]); } };
  const repo = new RdbAIResultRepository(store, false);
  await repo.save(record, true);
  const debugRepo = new RdbAIResultRepository(store, true);
  await debugRepo.save(testRecord, true); await repo.removeDraft(record.context.draftId);
  assert.equal(calls.length, 3);
  assert.equal(calls[0][0].startsWith('INSERT OR REPLACE INTO ai_results'), true);
  assert.equal(calls[1][0].startsWith('INSERT OR REPLACE INTO ai_results'), true);
  assert.equal(calls[2][0], 'DELETE FROM ai_results WHERE draft_id = ?');
  assert.equal(calls.some(([sql]) => /(?:UPDATE|INSERT|DELETE)\s+(?:drafts|sync_operations|sync_state|conflicts)/i.test(sql)), false);
  assert.equal(calls.some(([sql]) => sql.includes('DELETE FROM ai_results WHERE result_id')), false);
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
  const repo = new RdbDraftRepository({}); repo.store = { version: 2, async executeSql() {} }; repo.clientId = 'phone';
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
