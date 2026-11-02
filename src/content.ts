import { capturePage, locateBlock } from './reader/page';
import { createPet, type PetState } from './ui/pet';
import type { Depth, PageSnapshot, SelectionAnchor } from './types';
import { DEFAULT_READING_QUESTION } from './core/learning';

declare global { interface Window { __readingPetMounted?: boolean } }
if (!window.__readingPetMounted) {
  window.__readingPetMounted = true;
  // Mounting on a new page must not parse the article or call the model.
  let snapshot: PageSnapshot | null = null;
  let savedSelection: SelectionAnchor | null = null;
  let savedVersion = '', savedUrl = location.href;
  let port: chrome.runtime.Port | null = null, heartbeat: ReturnType<typeof setInterval> | null = null;
  let activePage: PageSnapshot | null = null, busy = false;
  const pet = createPet({
    onSelect: () => { ask(DEFAULT_READING_QUESTION, 'brief'); },
    onAsk: (text, depth) => ask(text, depth),
    onCancel: () => port?.postMessage({ type: 'CANCEL' }),
    onPanel: teach => {
      void chrome.runtime.sendMessage({ type: 'OPEN_PANEL', view: teach ? 'knowledge' : 'notes' }).catch(() => pet.showStatus('无法打开侧栏，请点击扩展图标后重试。'));
    },
    onLocate: block => { const result = locateBlock(block.id, activePage?.version || snapshot?.version || ''); if (!result.ok) pet.showStatus(result.error!); },
    onSettings: () => { void chrome.runtime.sendMessage({ type: 'OPEN_SETTINGS' }); },
  });
  function readPage() {
    snapshot = capturePage();
    if (savedVersion !== snapshot.version || savedUrl !== snapshot.url) savedSelection = null;
    if (snapshot.selection) savedSelection = snapshot.selection;
    savedVersion = snapshot.version; savedUrl = snapshot.url;
    return { ...snapshot, selection: savedSelection };
  }
  function finish() { busy = false; pet.setBusy(false); if (heartbeat) clearInterval(heartbeat); heartbeat = null; }
  function connect() {
    if (port) return port;
    const current = chrome.runtime.connect({ name: 'reading-pet' }); port = current;
    current.onMessage.addListener(message => {
      if (message.type === 'STATUS') pet.showStatus(message.text);
      if (message.type === 'ANSWER') {
        const latest = capturePage();
        if (message.version !== latest.version || message.url !== latest.url) { current.postMessage({ type: 'CANCEL' }); pet.showStatus('网页内容已变化，请重新选中后提问。'); return; }
        pet.showAnswer(message.turn); pet.setState('answering');
      }
      if (message.type === 'ERROR') { finish(); pet.showStatus(message.text); pet.setState('error'); }
      if (message.type === 'DONE') finish();
    });
    current.onDisconnect.addListener(() => { if (port === current) port = null; if (busy) { finish(); pet.showStatus('连接中断，请重试；未完成内容没有保存。'); pet.setState('error'); } });
    return current;
  }
  function ask(text: string, depth: Depth) {
    if (busy) return;
    activePage = readPage();
    pet.showQuote(savedSelection?.text || activePage.title); pet.showBubble(); pet.setState('thinking'); pet.setBusy(true);
    pet.showStatus('正在读懂这一处…'); busy = true;
    try {
      const connection = connect();
      connection.postMessage({ type: 'ASK', page: activePage, question: text, depth });
      // Only while a visible reading request is active. Navigation/disconnection aborts the task.
      heartbeat = setInterval(() => { try { connection.postMessage({ type: 'PING' }); } catch { finish(); } }, 20_000);
    } catch { finish(); pet.showStatus('扩展已更新，请刷新网页后再试。'); }
  }
  function showSelection() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) { pet.showSelection(null); return; }
    readPage();
    const anchor = snapshot?.selection;
    if (!anchor) { pet.showSelection(null); return; }
    const range = window.getSelection()?.getRangeAt(0);
    pet.showSelection(range?.getBoundingClientRect() || null);
  }
  document.addEventListener('pointerup', event => { if (!(event.target as Element)?.closest?.('[data-reading-pet]')) showSelection(); });
  document.addEventListener('keyup', event => { if (event.key === 'Shift' || event.key.startsWith('Arrow')) showSelection(); });
  document.addEventListener('scroll', () => pet.showSelection(null), { passive: true });
  window.addEventListener('pagehide', () => { port?.disconnect(); finish(); }, { once: true });
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message?.type === 'READER_READY') {
      respond({ ok: true });
    } else if (message?.type === 'GET_PAGE') {
      respond({ ok: true, page: readPage() });
    } else if (message?.type === 'LOCATE') {
      respond(locateBlock(message.blockId, message.version));
    } else if (message?.type === 'PET_STATE') {
      pet.setState(message.state as PetState); respond({ ok: true });
    } else if (message?.type === 'SHOW_BUBBLE') {
      pet.restore(); pet.showBubble(); respond({ ok: true });
    } else if (message?.type === 'RESTORE') {
      pet.restore(); respond({ ok: true });
    }
  });
}
