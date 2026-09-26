import test from 'node:test';
import assert from 'node:assert/strict';
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

test('new request cancels the previous generation and ignores a late success', async () => {
  const first = deferred(); const calls = []; const client = { requestReview: async (request, { signal }) => { calls.push(signal); if (calls.length === 1) return first.promise; return { result: reviewResult(request), isTestData: false }; }, requestCompletion: async () => { throw new Error('unused'); } };
  const session = new AISession(client, repository()); session.setContext(context());
  const pending = session.requestReview('risk'); await new Promise(resolve => setImmediate(resolve));
  const next = session.requestReview('risk'); await next; first.resolve({ result: reviewResult(), isTestData: false }); await pending;
  assert.equal(calls[0].aborted, true); assert.equal(session.getSnapshot().reviews.filter(r => r.state === 'success').length, 1);
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
  assert.equal(session.getSnapshot().reviews[0].hidden, true); assert.equal(session.getSnapshot().reviews[0].stale, true);
});
