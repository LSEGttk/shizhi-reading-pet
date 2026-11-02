export const EVENTS = [
  'extension.installed', 'panel.open', 'panel.open.failed', 'reader.injected', 'reader.inject.failed',
  'reader.captured', 'reader.capture.failed', 'reader.locate.failed', 'reading.started', 'reading.completed',
  'reading.failed', 'reading.cancelled', 'context.built', 'notes.started', 'notes.saved', 'notes.failed',
  'model.started', 'model.http', 'model.completed', 'model.failed', 'settings.saved', 'settings.failed',
  'runtime.error', 'runtime.rejection',
  'answer.review.started', 'answer.review.completed', 'answer.review.failed', 'bubble.open', 'thread.synced',
] as const;
export type DiagnosticEvent = typeof EVENTS[number];
export type DiagnosticMeta = Record<string, unknown>;
export interface DiagnosticEntry { at: string; event: DiagnosticEvent; meta: Record<string, number | boolean | string> }

const numberKeys = new Set(['durationMs', 'status', 'blocks', 'selectionChars', 'inputMessages', 'toolCount', 'outputChars', 'estimatedTokens', 'budget', 'sourceCount', 'line', 'column', 'turns']);
const booleanKeys = new Set(['truncated', 'toolsEnabled', 'autoNotes', 'keyConfigured', 'modelConfigured', 'clipped']);
const enumValues: Record<string, string[]> = {
  scope: ['passage', 'article', 'notes'], depth: ['brief', 'context', 'example', 'deep'],
  skill: ['reading', 'reading + formula', 'reading + teaching', 'reading + formula + teaching', 'reading + contextual', 'reading + formula + contextual', 'reading + knowledge', 'reading + formula + knowledge', 'notes'], phase: ['background', 'panel', 'options', 'content'],
  module: ['knowledge'],
  reason: ['length', 'copy', 'template', 'missing_example', 'missing_mechanism', 'missing_sections', 'missing_structure', 'repeated_brief'],
  code: ['cancelled', 'json_parse', 'type_error', 'permission', 'budget', 'stale_page', 'network', 'output_limit', 'stream_interrupted', 'configuration', 'unknown'],
  transport: ['http', 'https'], finish: ['stop', 'tool_calls', 'length', 'content_filter', 'other'],
};

// Strict allowlist: do not stringify arbitrary errors, requests, URLs, prompts or settings.
export function cleanMeta(meta: DiagnosticMeta): DiagnosticEntry['meta'] {
  const safe: DiagnosticEntry['meta'] = {};
  for (const [key, value] of Object.entries(meta)) {
    if (numberKeys.has(key) && typeof value === 'number' && Number.isFinite(value)) safe[key] = Math.max(0, Math.min(1e9, Math.round(value)));
    if (booleanKeys.has(key) && typeof value === 'boolean') safe[key] = value;
    if (enumValues[key] && typeof value === 'string' && enumValues[key].includes(value)) safe[key] = value;
  }
  return safe;
}
export function errorCode(error: unknown): string {
  const value = error instanceof Error ? error : new Error('');
  if (value.name === 'AbortError') return 'cancelled';
  if (value.name === 'SyntaxError') return 'json_parse';
  if (/fetch|network|网络|Failed to fetch/i.test(value.message)) return 'network';
  if (/permission|授权|权限/i.test(value.message)) return 'permission';
  if (/预算/.test(value.message)) return 'budget';
  if (/正文已变化|网页内容已变化/.test(value.message)) return 'stale_page';
  if (/输出上限/.test(value.message)) return 'output_limit';
  if (/提前中断|断流/.test(value.message)) return 'stream_interrupted';
  if (/设置|模型名称|接口地址/.test(value.message)) return 'configuration';
  if (value.name === 'TypeError') return 'type_error';
  return 'unknown';
}
export function record(event: DiagnosticEvent, meta: DiagnosticMeta = {}): void {
  if (typeof window === 'undefined' && typeof chrome !== 'undefined' && typeof chrome.storage?.local?.get === 'function') { void appendDiagnostic(event, meta).catch(() => {}); return; }
  try { void chrome.runtime.sendMessage({ type: 'DIAGNOSTIC', event, meta: cleanMeta(meta) }).catch(() => {}); } catch { /* Logging cannot break reading. */ }
}
let queue = Promise.resolve();
// Only the service worker writes this bounded ring, so simultaneous panel/model events cannot overwrite each other.
export function appendDiagnostic(event: DiagnosticEvent, meta: DiagnosticMeta = {}): Promise<void> {
  queue = queue.catch(() => {}).then(async () => {
    const { diagnosticsEnabled, diagnosticLog } = await chrome.storage.local.get(['diagnosticsEnabled', 'diagnosticLog']);
    if (diagnosticsEnabled === false) return;
    const previous = Array.isArray(diagnosticLog) ? diagnosticLog.slice(-199) : [];
    const entry: DiagnosticEntry = { at: new Date().toISOString(), event, meta: cleanMeta(meta) };
    await chrome.storage.local.set({ diagnosticLog: [...previous, entry] });
  });
  return queue;
}
export async function flushDiagnostics() { await queue.catch(() => {}); }
export async function diagnosticReport() {
  await chrome.runtime.sendMessage({ type: 'DIAGNOSTIC_FLUSH' }).catch(() => {});
  const { diagnosticsEnabled, diagnosticLog } = await chrome.storage.local.get(['diagnosticsEnabled', 'diagnosticLog']);
  return {
    format: 'reading-pet-diagnostics-v1', version: chrome.runtime.getManifest().version,
    exportedAt: new Date().toISOString(), enabled: diagnosticsEnabled !== false,
    privacy: 'Only local stage/timing/status counters. No API keys, URLs, page text, questions, answers or note text.',
    events: (Array.isArray(diagnosticLog) ? diagnosticLog : []).filter((entry: DiagnosticEntry) => EVENTS.includes(entry.event)).slice(-200)
      .map((entry: DiagnosticEntry) => ({ at: /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(entry.at) ? entry.at : '', event: entry.event, meta: cleanMeta(entry.meta || {}) })),
  };
}
export function captureRuntimeErrors(phase: 'panel' | 'options') {
  window.addEventListener('error', event => record('runtime.error', { phase, code: errorCode(event.error), line: event.lineno, column: event.colno }));
  window.addEventListener('unhandledrejection', event => record('runtime.rejection', { phase, code: errorCode(event.reason) }));
}
