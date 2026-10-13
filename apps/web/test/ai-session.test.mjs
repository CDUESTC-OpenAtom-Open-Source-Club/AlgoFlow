import test from 'node:test';
import assert from 'node:assert/strict';
import { AIClientError, rangeToOffsets } from '../src/ai-client.mjs';
import { AISession } from '../src/ai-session.mjs';
import { completionResult, context, deferred, reviewResult, resultRecord } from './ai-fixtures.mjs';

function repository() {
  const records = [];
  return { records,
    listForDraft: (draftId, mode) => records.filter(r => r.draftId === draftId && r.mode === mode),
    save: record => { const slot = records.findIndex(r => r.draftId === record.draftId && r.mode === record.mode && r.capability === record.capability && r.reviewKind === record.reviewKind); if (slot >= 0) records.splice(slot, 1); records.push(record); },
    update: record => { const index = records.findIndex(r => r.id === record.id); if (index >= 0) records[index] = record; },
    reconcileSegments: (_id, _idea) => [{ id: 'idea-1', content: '累加' }], removeDraft: id => { while (records.some(r => r.draftId === id)) records.splice(records.findIndex(r => r.draftId === id), 1); },
  };
}

function clientFor(requests) {
  return { requestReview: async (request, options) => { requests.push(['review', request, options.signal]); return { result: reviewResult(request), isTestData: true }; }, requestCompletion: async (request, options) => { requests.push(['completion', request, options.signal]); return { result: completionResult(request), isTestData: true }; } };
}

test('reviews append same-kind messages while persistence keeps the latest slot', async () => {
  const requests = []; const repo = repository(); const session = new AISession(clientFor(requests), repo);
  session.setContext(context());
  await session.requestReview('risk'); await session.requestReview('risk'); await session.requestReview('explanation');
  assert.equal(session.getSnapshot().reviews.length, 3);
  assert.equal(repo.records.filter(r => r.reviewKind === 'risk').length, 1);
  assert.equal(repo.records.filter(r => r.reviewKind === 'explanation').length, 1);
  assert.equal(session.getSnapshot().reviews.every(r => r.isTestData), true);
});

test('successful review exposes a persisted entity bridge for sync adapters', async () => {
  const repo = repository(); const session = new AISession(clientFor([]), repo); let persisted;
  session.setPersistedResultHandler((record) => { persisted = record; });
  session.setContext(context());
  await session.requestReview('risk');
  assert.equal(persisted?.capability, 'review');
  assert.equal(persisted?.result?.output_kind, 'review');
  assert.equal(persisted?.sourceDraftVersion, 3);
});

test('restored completion remains the current historical record but requires a fresh request to accept', () => {
  const req = { mode: 'faithful_transform', draft_id: 'draft-test', draft_version: 3, rule_version: '1.0.0',
    code: context().code, visibility: 'visible', cursor: { line: 3, char: 0 } };
  const record = resultRecord({ capability: 'completion', reviewKind: undefined, result: completionResult(req), sourceCursor: req.cursor });
  const repo = repository(); repo.records.push(record);
  const session = new AISession(clientFor([]), repo); session.setContext(context());
  assert.equal(session.getSnapshot().completion?.stale, false);
  assert.equal(session.getSnapshot().completion?.restored, true);
  assert.equal(session.canAcceptCompletion(), false);
});

test('new request cancels the previous generation and ignores a late success', async () => {
  const first = deferred(); const calls = []; const client = { requestReview: async (request, { signal }) => { calls.push(signal); if (calls.length === 1) return first.promise; return { result: reviewResult(request), isTestData: false }; }, requestCompletion: async () => { throw new Error('unused'); } };
  const session = new AISession(client, repository()); session.setContext(context());
  const pending = session.requestReview('risk'); await new Promise(resolve => setImmediate(resolve));
  const next = session.requestReview('risk'); await next; first.resolve({ result: reviewResult(), isTestData: false }); await pending;
  assert.equal(calls[0].aborted, true); assert.equal(session.getSnapshot().reviews.filter(r => r.state === 'success').length, 1);
});

test('provisional loading records never enter the normal cache partition', async () => {
  const pending = deferred(); const repo = repository();
  const session = new AISession({ requestReview: async () => pending.promise, requestCompletion: async () => { throw new Error('unused'); } }, repo);
  session.setContext(context());
  const work = session.requestReview('risk');
  await new Promise(resolve => setImmediate(resolve));
  session.cancel();
  assert.equal(repo.records.length, 0);
  pending.resolve({ result: reviewResult(), isTestData: false });
  await work;
  assert.equal(repo.records.length, 0);
});

test('release rejection of a marked test response leaves both cache partitions empty', async () => {
  const repo = repository();
  const session = new AISession({
    requestReview: async () => { throw new AIClientError('AI_NOT_ENABLED', 'test response rejected', 503, true); },
    requestCompletion: async () => { throw new Error('unused'); },
  }, repo);
  session.setContext(context());
  await session.requestReview('risk');
  assert.equal(repo.records.length, 0);
});

test('context changes stale completion and prevent acceptance after source edit', async () => {
  const repo = repository(); const session = new AISession(clientFor([]), repo); session.setContext(context());
  await session.requestCompletion({ line: 3, char: 0 }); assert.equal(session.canAcceptCompletion(), true);
  session.setContext(context({ code: 'changed' })); assert.equal(session.canAcceptCompletion(), false);
  assert.equal(session.getSnapshot().completion.stale, true);
});

test('recovered results are read-only and hidden state is local', () => {
  const repo = repository(); repo.records.push(resultRecord({ hidden: true }));
  const session = new AISession({ requestReview: async () => { throw new Error(); }, requestCompletion: async () => { throw new Error(); } }, repo);
  session.setContext(context());
  assert.equal(session.getSnapshot().reviews[0].hidden, true); assert.equal(session.getSnapshot().reviews[0].stale, false);
});

for (const [label, update] of Object.entries({ code: { code: 'new code' }, idea: { idea: 'new idea' },
  draft: { draftId: 'draft-other' }, file: { fileId: 'idea.md' }, mode: { mode: 'progressive_hint' },
  version: { draftVersion: 4 }, context: { problemContext: 'new problem' }, cancel: null, dispose: null })) {
  for (const failure of [false, true]) test(`${label} invalidates pending completion and ignores late ${failure ? 'failure' : 'success'}`, async () => {
    const pending = deferred(); let signal; let request;
    const session = new AISession({ requestCompletion: (value, options) => {
      signal = options.signal; request = value; return pending.promise;
    } }, repository());
    session.setContext(context());
    const run = session.requestCompletion({ line: 3, char: 0 });
    if (label === 'cancel') session.cancel();
    else if (label === 'dispose') session.dispose();
    else session.setContext(context(update));
    const state = session.getSnapshot();
    assert.equal(signal.aborted, true);
    if (failure) pending.reject(new Error('late failure'));
    else pending.resolve({ result: completionResult(request), isTestData: true });
    await run;
    assert.deepEqual(session.getSnapshot(), state);
    assert.equal(session.canAcceptCompletion(), false);
  });
}

test('acceptance applies exactly once and hide/reject never write code', async () => {
  const session = new AISession(clientFor([]), repository()); session.setContext(context());
  await session.requestCompletion({ line: 3, char: 0 });
  const id = session.getSnapshot().completion.id;
  session.setHidden(id, true);
  let writes = 0;
  const apply = () => { writes++; return true; };
  assert.equal(session.acceptCompletion(apply), false);
  session.setHidden(id, false);
  assert.equal(session.acceptCompletion(apply), true);
  assert.equal(session.acceptCompletion(apply), false);
  await session.requestCompletion({ line: 3, char: 0 }); session.rejectCompletion();
  assert.equal(session.acceptCompletion(apply), false);
  assert.equal(writes, 1);
});

test('completion stays out of the sync bridge and can be explicitly withdrawn while its context is unchanged', async () => {
  const repo = repository(); const session = new AISession(clientFor([]), repo); const bridged = [];
  session.setPersistedResultHandler(record => bridged.push(record));
  session.setContext(context({ syncStatus: 'synced' }));
  await session.requestCompletion({ line: 3, char: 0 });
  assert.equal(bridged.length, 0);
  assert.equal(repo.records.some(record => record.capability === 'completion'), true);

  const before = context().code;
  let editorCode = before;
  const apply = (change) => {
    if (editorCode !== change.sourceCode) return false;
    const { from, to } = rangeToOffsets(editorCode, change.range);
    editorCode = editorCode.slice(0, from) + change.insert + editorCode.slice(to);
    session.setContext(context({ code: editorCode, syncStatus: 'local_only' }));
    return true;
  };
  assert.equal(session.acceptCompletion(apply), true);
  assert.notEqual(editorCode, before);
  assert.equal(session.canWithdrawCompletion(), true);
  assert.equal(session.withdrawCompletion(apply), true);
  assert.equal(editorCode, before);
  assert.equal(session.canWithdrawCompletion(), false);
  assert.equal(bridged.length, 0);
});

test('completion withdrawal is permanently invalidated by a later edit or sync context change', async () => {
  const session = new AISession(clientFor([]), repository());
  let editorCode = context().code;
  const apply = (change) => {
    if (editorCode !== change.sourceCode) return false;
    const lines = editorCode.split(/\r\n|\n|\r/);
    const to = lines.slice(0, change.range.end_line - 1).reduce((sum, line) => sum + line.length + 1, 0) + change.range.end_char;
    const from = lines.slice(0, change.range.start_line - 1).reduce((sum, line) => sum + line.length + 1, 0) + change.range.start_char;
    editorCode = editorCode.slice(0, from) + change.insert + editorCode.slice(to);
    session.setContext(context({ code: editorCode, syncStatus: 'local_only' }));
    return true;
  };
  session.setContext(context({ syncStatus: 'synced' }));
  await session.requestCompletion({ line: 3, char: 0 });
  assert.equal(session.acceptCompletion(apply), true);
  assert.equal(session.canWithdrawCompletion(), true);
  editorCode = `${editorCode}\n// later edit`;
  session.setContext(context({ code: editorCode, syncStatus: 'local_only' }));
  const afterEdit = editorCode;
  assert.equal(session.canWithdrawCompletion(), false);
  assert.equal(session.withdrawCompletion(apply), false);
  assert.equal(editorCode, afterEdit);

  session.setContext(context({ code: editorCode, syncStatus: 'synced' }));
  await session.requestCompletion({ line: 3, char: 0 });
  assert.equal(session.acceptCompletion(apply), true);
  session.setContext(context({ code: editorCode, syncStatus: 'syncing' }));
  assert.equal(session.canWithdrawCompletion(), false);
  assert.equal(session.withdrawCompletion(apply), false);
});
