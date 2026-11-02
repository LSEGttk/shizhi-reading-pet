import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoReadEnabled, ensureReader, installAutoReader } from '../src/reader/activation.ts';

test('automatic reading requires both opt-in and site permission; revocation unregisters future injection', async () => {
  const oldChrome = globalThis.chrome;
  let enabled = false, permitted = false, registered = false, injected = 0;
  const removed: (() => void)[] = [];
  const event = { addListener: () => {} };
  globalThis.chrome = {
    storage: { local: { get: async () => ({ autoRead: enabled }) }, onChanged: event },
    permissions: { contains: async () => permitted, onAdded: event, onRemoved: { addListener: (f: () => void) => removed.push(f) } },
    tabs: { query: async () => [{ id: 1 }], get: async () => ({ status: 'complete', url: 'https://example.org' }),
      sendMessage: async () => { throw new Error('not mounted'); }, onActivated: event, onUpdated: event },
    scripting: { getRegisteredContentScripts: async () => registered ? [{ id: 'reading-pet-auto' }] : [],
      registerContentScripts: async () => { registered = true; }, unregisterContentScripts: async () => { registered = false; },
      executeScript: async () => { injected++; } },
  } as unknown as typeof chrome;
  try {
    const sync = installAutoReader();
    await sync(); assert.equal(registered, false);
    enabled = true; await sync(); assert.equal(await autoReadEnabled(), false); assert.equal(injected, 0);
    permitted = true; await sync(); assert.equal(registered, true); assert.ok(injected > 0);
    const before = injected;
    permitted = false; removed.forEach(f => f()); await sync();
    assert.equal(registered, false); assert.equal(injected, before);
    // A previously granted broad permission alone must not enable reading.
    enabled = false; permitted = true; await sync(); assert.equal(registered, false);
  } finally { globalThis.chrome = oldChrome; }
});

test('existing reader is not reinjected or opened during automatic activation', async () => {
  const oldChrome = globalThis.chrome;
  const messages: string[] = [];
  let injections = 0;
  globalThis.chrome = {
    tabs: { sendMessage: async (_id: number, message: { type: string }) => { messages.push(message.type); return { ok: true }; } },
    scripting: { executeScript: async () => { injections++; } },
  } as unknown as typeof chrome;
  try {
    await ensureReader(1);
    assert.deepEqual(messages, ['READER_READY']); assert.equal(injections, 0);
    await ensureReader(1, true);
    assert.equal(messages.at(-1), 'SHOW_BUBBLE'); assert.equal(injections, 0);
  } finally { globalThis.chrome = oldChrome; }
});
