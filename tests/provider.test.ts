import { test } from 'node:test';
import assert from 'node:assert/strict';
import { complete, endpoint, permissionOrigin, sseData } from '../src/providers/chat.ts';
import { DEFAULT_SETTINGS } from '../src/storage/local.ts';

test('endpoint retains the configured base path and accepts local model URLs', () => {
  assert.equal(endpoint('https://api.example.org/v1/').href, 'https://api.example.org/v1/chat/completions');
  assert.equal(endpoint('https://api.example.org/v1/chat/completions').href, 'https://api.example.org/v1/chat/completions');
  assert.equal(endpoint('http://127.0.0.1:11434/v1').port, '11434');
  assert.equal(permissionOrigin(endpoint('http://127.0.0.1:11434/v1')), 'http://127.0.0.1/*');
  for (const url of ['http://example.org', 'https://user:secret@example.org', 'https://example.org?key=secret', 'file:///tmp/key']) assert.throws(() => endpoint(url));
});

test('SSE parser handles split UTF-8, split events, CRLF and comments', async () => {
  const bytes = new TextEncoder().encode(': ping\r\n\r\ndata: {"text":"矩阵"}\r\n\r\ndata: [DONE]\n\n');
  const stream = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } });
  const data = []; for await (const item of sseData(stream)) data.push(item);
  assert.deepEqual(data, ['{"text":"矩阵"}', '[DONE]']);
});

test('provider assembles fragmented tools, excludes reasoning from displayed text, and detects truncated output', async () => {
  const originalFetch = globalThis.fetch;
  (globalThis as unknown as { chrome: unknown }).chrome = { permissions: { contains: async () => true } };
  let finish = 'tool_calls';
  globalThis.fetch = async () => {
    const events = [
      { choices: [{ delta: { reasoning_content: '内部推理' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'searchPage', arguments: '{"query":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"矩阵"}' } }] }, finish_reason: finish }] },
    ];
    return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  };
  try {
    let displayed = '';
    const result = await complete({ ...DEFAULT_SETTINGS, model: 'test' }, [], [], new AbortController().signal, text => { displayed += text; });
    assert.equal(result.tool_calls?.[0].function.arguments, '{"query":"矩阵"}');
    assert.equal(result.reasoning_content, '内部推理');
    assert.equal(displayed, '');
    finish = 'length';
    await assert.rejects(complete({ ...DEFAULT_SETTINGS, model: 'test' }, [], [], new AbortController().signal, () => {}), /输出上限/);
    finish = '';
    await assert.rejects(complete({ ...DEFAULT_SETTINGS, model: 'test' }, [], [], new AbortController().signal, () => {}), /提前中断/);
  } finally { globalThis.fetch = originalFetch; }
});

test('JSON fallback rejects incomplete answers before display or persistence', async () => {
  const originalFetch = globalThis.fetch, originalChrome = globalThis.chrome;
  globalThis.chrome = { permissions: { contains: async () => true } } as unknown as typeof chrome;
  let finish: string | undefined = 'stop', content = '完整回答';
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ finish_reason: finish, message: { role:'assistant',content } }] }), { headers:{'Content-Type':'application/json'} });
  try {
    let displayed = '';
    const request = () => complete({ ...DEFAULT_SETTINGS, model:'test' }, [], [], new AbortController().signal, text => { displayed += text; });
    assert.equal((await request()).content, '完整回答');
    for (const reason of ['length', 'content_filter', undefined]) {
      displayed = ''; finish = reason;
      await assert.rejects(request(), /输出上限|未正常完成/);
      assert.equal(displayed, '');
    }
    finish = 'stop'; content = 'x'.repeat(80_001); displayed = '';
    await assert.rejects(request(), /超出本次上限/); assert.equal(displayed, '');
  } finally { globalThis.fetch = originalFetch; globalThis.chrome = originalChrome; }
});
