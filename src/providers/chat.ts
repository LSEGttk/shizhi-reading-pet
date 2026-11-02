import type { ChatMessage, Settings, ToolCall, ToolDefinition } from '../types';
import { errorCode, record } from '../diagnostics';

export function endpoint(base: string): URL {
  const url = new URL(base);
  if (url.username || url.password || url.search || url.hash) throw new Error('接口地址不能包含用户名、密码、查询参数或锚点。');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('使用 HTTPS 地址；本地模型可使用 localhost HTTP。');
  url.pathname = `${url.pathname.replace(/\/$/, '').replace(/\/chat\/completions$/, '')}/chat/completions`;
  return url;
}
export const permissionOrigin = (url: URL) => `${url.protocol}//${url.hostname}/*`;

export async function* sseData(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader(), decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const event = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (data) yield data;
      }
      if (done) { if (buffer.startsWith('data:')) yield buffer.slice(5).trim(); break; }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function complete(settings: Settings, messages: ChatMessage[], tools: ToolDefinition[], signal: AbortSignal, onDelta: (text: string) => void): Promise<ChatMessage> {
  const started = Date.now();
  record('model.started', { inputMessages: messages.length, toolCount: tools.length });
  try {
    const result = await completeInner(settings, messages, tools, signal, onDelta);
    record('model.completed', { durationMs: Date.now() - started, outputChars: result.content?.length || 0, toolCount: result.tool_calls?.length || 0 });
    return result;
  } catch (error) {
    record('model.failed', { durationMs: Date.now() - started, code: errorCode(error) });
    throw error;
  }
}
async function completeInner(settings: Settings, messages: ChatMessage[], tools: ToolDefinition[], signal: AbortSignal, onDelta: (text: string) => void): Promise<ChatMessage> {
  const url = endpoint(settings.baseUrl);
  if (!settings.model.trim()) throw new Error('请在设置中填写模型名称。');
  const allowed = await chrome.permissions.contains({ origins: [permissionOrigin(url)] });
  if (!allowed) throw new Error('尚未授权模型接口域名，请在设置中保存并授权。');
  const response = await fetch(url, {
    method: 'POST', redirect: 'error', signal, cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ...(settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {}) },
    body: JSON.stringify({ model: settings.model, messages, stream: true, max_tokens: settings.maxOutput, ...(tools.length ? { tools, tool_choice: 'auto' } : {}) }),
  });
  record('model.http', { status: response.status });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`模型接口返回 HTTP ${response.status}。${response.status === 401 ? '请检查密钥。' : response.status === 429 ? '额度或请求频率受到限制。' : '请检查模型名称、接口路径和工具调用兼容性。'}`);
  }
  if (!response.body) throw new Error('模型接口没有返回内容。');
  if (response.headers.get('content-type')?.includes('application/json')) {
    const data = await response.json();
    if (data.error) throw new Error('模型接口返回错误，请检查设置。');
    const choice = data.choices?.[0], message = choice?.message;
    if (!message) throw new Error('模型返回格式不兼容聊天接口。');
    if (choice.finish_reason === 'length') throw new Error('回答达到输出上限，尚未完成；可以提高设置中的输出上限。');
    if (!['stop', 'tool_calls'].includes(choice.finish_reason)) throw new Error('模型未正常完成回答，未保存不完整内容。');
    if ((message.content?.length || 0) + (message.reasoning_content?.length || 0) > 80_000) throw new Error('模型输出超出本次上限。');
    if (message.tool_calls?.some((call: ToolCall) => (call.function?.arguments?.length || 0) > 12_000)) throw new Error('工具参数过长，已停止本次请求。');
    if (message.content) onDelta(message.content);
    return message;
  }
  let content = '', reasoning = '', finish = '';
  const calls = new Map<number, ToolCall>();
  for await (const data of sseData(response.body)) {
    if (data === '[DONE]') break;
    const event = JSON.parse(data);
    if (event.error) throw new Error('模型生成过程中返回错误。');
    const choice = event.choices?.[0]; if (!choice) continue;
    const delta = choice.delta || {};
    if (delta.content) { content += delta.content; onDelta(delta.content); }
    if (delta.reasoning_content) reasoning += delta.reasoning_content;
    for (const item of delta.tool_calls || []) {
      const call = calls.get(item.index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (item.id) call.id = item.id;
      if (item.function?.name) call.function.name += item.function.name;
      if (item.function?.arguments) call.function.arguments += item.function.arguments;
      if (call.function.arguments.length > 12_000) throw new Error('工具参数过长，已停止本次请求。');
      calls.set(item.index, call);
    }
    if (choice.finish_reason) finish = choice.finish_reason;
    if (content.length + reasoning.length > 80_000) throw new Error('模型输出超出本次上限。');
  }
  if (finish === 'length') throw new Error('回答达到输出上限，尚未完成；可以提高设置中的输出上限。');
  if (!finish) throw new Error('模型连接提前中断，未保存不完整回答。');
  return { role: 'assistant', content: content || null, ...(calls.size ? { tool_calls: [...calls.values()], ...(reasoning ? { reasoning_content: reasoning } : {}) } : {}) };
}
