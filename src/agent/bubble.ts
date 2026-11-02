import type { PageSnapshot, Depth, Turn } from '../types';
import { runReading, summarizeNote, topicKey } from './run';
import { appendTurn, getSettings, listNotes, loadThread, updateNote } from '../storage/local';
import { appendDiagnostic, errorCode } from '../diagnostics';

function validPage(value: unknown, senderUrl: string): value is PageSnapshot {
  const page = value as PageSnapshot;
  try {
    if (!page || new URL(page.url).origin !== new URL(senderUrl).origin || !page.version || typeof page.title !== 'string' || page.title.length > 2000 || !Array.isArray(page.blocks) || page.blocks.length > 1000) return false;
    let size = 0;
    for (const block of page.blocks) {
      if (!block || typeof block.id !== 'string' || block.id.length > 80 || typeof block.text !== 'string' || typeof block.heading !== 'string') return false;
      size += block.text.length + block.heading.length;
    }
    if (size > 400_000) return false;
    if (page.images && (!Array.isArray(page.images) || page.images.length > 16 || page.images.some(i => !i || typeof i.id !== 'string' || !/^img-[a-z0-9]+$/.test(i.id) || typeof i.url !== 'string' || i.url.length > 8000 || !/^https:\/\//.test(i.url) || typeof i.alt !== 'string' || i.alt.length > 300 || typeof i.caption !== 'string' || i.caption.length > 400))) return false;
    if (page.selection && (typeof page.selection.text !== 'string' || page.selection.text.length > 6000 || !Array.isArray(page.selection.blockIds))) return false;
    return true;
  } catch { return false; }
}

export function connectBubble(port: chrome.runtime.Port) {
  if (port.name !== 'reading-pet' || port.sender?.id !== chrome.runtime.id || !port.sender.tab?.id || port.sender.frameId !== 0 || !/^https?:/.test(port.sender.url || '')) return;
  let active: AbortController | null = null, connected = true;
  const send = (message: unknown) => { if (connected) { try { port.postMessage(message); } catch { connected = false; active?.abort(); } } };
  port.onDisconnect.addListener(() => { connected = false; active?.abort(); });
  port.onMessage.addListener(message => {
    if (message?.type === 'PING') return; // User-visible request only: the client stops this heartbeat when it finishes.
    if (message?.type === 'CANCEL') { active?.abort(); return; }
    if (message?.type !== 'ASK' || active) return;
    if (typeof message.question !== 'string' || !message.question.trim() || message.question.length > 2000 || !validPage(message.page, port.sender!.url!)) { send({ type: 'ERROR', text: '问题或网页材料无效，请重新读取。' }); send({ type: 'DONE' }); return; }
    const page: PageSnapshot = message.page, question: string = message.question.trim();
    const depth: Depth = message.depth === 'example' ? 'example' : 'brief';
    const current = new AbortController(); active = current;
    const timeout = setTimeout(() => current.abort(), 150_000), started = Date.now();
    void (async () => {
      await appendDiagnostic('reading.started', { phase: 'background', scope: 'article', depth });
      const settings = await getSettings();
      if (!settings.model) throw new Error('先打开模型设置，填写接口和模型名称。');
      const notes = await listNotes(), key = topicKey(page), turns = await loadThread(key);
      send({ type: 'STATUS', text: '正在读懂这一处…' });
      const result = await runReading({ page, question, scope: 'article', depth, turns, notes, settings, signal: current.signal,
        onText: () => {}, // Brief mode exposes only the final answer, not an unreviewed draft.
        onStatus: text => send({ type: 'STATUS', text }),
        onContext: report => { void appendDiagnostic('context.built', { phase: 'background', depth, scope: report.scope, skill: report.skill, blocks: report.blockIds.length, estimatedTokens: report.estimatedTokens, budget: report.budget }); },
      });
      current.signal.throwIfAborted();
      const turn: Turn = { question, answer: result.answer, citations: result.sources, relatedNotes: result.relatedNotes, scope: 'article', depth, surface: 'bubble', images: page.images };
      await appendTurn(key, turn);
      await appendDiagnostic('reading.completed', { phase: 'background', depth, durationMs: Date.now() - started, outputChars: result.answer.length, sourceCount: result.sources.length });
      send({ type: 'ANSWER', turn, version: page.version, url: page.url });
      if (settings.autoNotes) {
        send({ type: 'STATUS', text: '理解已呈现，正在留下笔记…' });
        await appendDiagnostic('notes.started');
        try {
          const note = await updateNote(key, previous => summarizeNote({ page, question, answer: turn.answer, sources: turn.citations, relatedNotes: turn.relatedNotes, previous, settings, signal: current.signal }), current.signal);
          await appendDiagnostic('notes.saved', { sourceCount: note.sources.length });
          send({ type: 'STATUS', text: '理解已留下，可以继续读。' });
        } catch (error) {
          current.signal.throwIfAborted(); await appendDiagnostic('notes.failed', { code: errorCode(error) });
          send({ type: 'STATUS', text: '解释已完成，笔记整理失败；可以稍后在侧栏重试。' });
        }
      } else send({ type: 'STATUS', text: '可以继续读，也可以追问。' });
    })().catch(error => {
      void appendDiagnostic(current.signal.aborted ? 'reading.cancelled' : 'reading.failed', { code: errorCode(error), durationMs: Date.now() - started });
      send({ type: 'ERROR', text: current.signal.aborted ? '已停止。' : (error as Error).message });
    }).finally(() => { clearTimeout(timeout); active = null; send({ type: 'DONE' }); });
  });
}
