import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateAIArtifact } from '../src/contracts.mjs';

test('AI artifact vectors match expected validity', async () => {
  const source = new URL('../../../packages/contracts/vectors/ai-artifacts.json', import.meta.url);
  const vectors = JSON.parse(await readFile(source, 'utf8'));
  for (const vector of vectors) {
    assert.equal(validateAIArtifact(vector.artifact).length === 0, vector.valid, vector.name);
  }
});
