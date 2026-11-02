import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendDiagnostic, cleanMeta, errorCode, flushDiagnostics } from '../src/diagnostics.ts';

test('diagnostic metadata drops keys, content, URLs and arbitrary strings', () => {
  const safe = cleanMeta({ apiKey: 'secret', question: 'private text', answer: 'private answer', url: 'https://example.org/private', model: 'user-model', status: 401, durationMs: 12.6, phase: 'panel', code: 'permission', scope: 'notes', toolsEnabled: true, line: Infinity, skill: 'unknown-text' });
  assert.deepEqual(safe, { status: 401, durationMs: 13, phase: 'panel', code: 'permission', scope: 'notes', toolsEnabled: true });
  assert.equal(errorCode(new TypeError('Failed to fetch https://secret.example/?key=token')), 'network');
  assert.equal(errorCode(new Error('arbitrary secret error message')), 'unknown');
});

test('concurrent writes are serialized, capped at 200 and disabled logging is respected', async () => {
  const state: Record<string, unknown> = {};
  (globalThis as unknown as { chrome: unknown }).chrome = { storage: { local: {
    get: async () => structuredClone(state), set: async (update: Record<string, unknown>) => { Object.assign(state, structuredClone(update)); },
  } } };
  await Promise.all(Array.from({ length: 230 }, (_, i) => appendDiagnostic('model.http', { status: i, apiKey: 'never-save' })));
  await flushDiagnostics();
  const entries = state.diagnosticLog as { meta: { status: number } }[];
  assert.equal(entries.length, 200);
  assert.equal(entries[0].meta.status, 30);
  assert.equal(entries[199].meta.status, 229);
  assert.ok(!JSON.stringify(state).includes('never-save'));
  state.diagnosticsEnabled = false;
  await appendDiagnostic('model.failed', { code: 'network' });
  assert.equal((state.diagnosticLog as unknown[]).length, 200);
});
