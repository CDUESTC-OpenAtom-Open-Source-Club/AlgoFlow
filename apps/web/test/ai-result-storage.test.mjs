import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserAIResultRepository } from '../src/ai-result-storage.mjs';
import { memoryStorage, resultRecord } from './ai-fixtures.mjs';

test('stores only latest result per draft, mode and capability slot', () => {
  const repo = new BrowserAIResultRepository({ storage: memoryStorage() });
  const first = resultRecord({ reviewKind: 'risk', updatedAt: '2026-09-26T01:00:00.000Z' });
  const second = resultRecord({ reviewKind: 'risk', updatedAt: '2026-09-26T02:00:00.000Z' });
  repo.save(first); repo.save(second);
  assert.deepEqual(repo.listForDraft('draft-test').map(r => r.id), [second.id]);
  repo.update({ ...first, hidden: true });
  assert.equal(repo.listForDraft('draft-test')[0].hidden, false);
});

test('test and normal result partitions never leak across configuration', () => {
  const storage = memoryStorage(); const normal = new BrowserAIResultRepository({ storage }); const testRepo = new BrowserAIResultRepository({ storage, allowTestData: true });
  testRepo.save(resultRecord({ isTestData: true })); normal.save(resultRecord({ isTestData: false }));
  assert.equal(normal.load().every(r => !r.isTestData), true); assert.equal(testRepo.load().length, 2);
});

test('corrupt cache is reported without deleting workspace data', () => {
  const storage = memoryStorage({ 'algoflow.ai-results.v2.normal': '{bad' }); const repo = new BrowserAIResultRepository({ storage });
  assert.throws(() => repo.load(), /本地缓存不可读取/); assert.equal(storage.entries.has('algoflow.ai-results.v2.normal'), true);
});
