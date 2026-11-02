import { appendDiagnostic, errorCode, EVENTS, flushDiagnostics } from './diagnostics';
import { connectBubble } from './agent/bubble';
import { ensureReader, installAutoReader } from './reader/activation';
chrome.runtime.onConnect.addListener(connectBubble);
const syncAutoReader = installAutoReader();
const TRUSTED_PAGES = new Set(['panel.html', 'options.html']);
chrome.runtime.onInstalled.addListener(() => {
  void chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  void appendDiagnostic('extension.installed');
});
void chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });

chrome.action.onClicked.addListener(tab => {
  if (!tab.id) return;
  // The page bubble is the default; the browser side panel opens only when explicitly requested.
  void ensureReader(tab.id, true).then(async () => {
    await appendDiagnostic('reader.injected');
  }, error => appendDiagnostic('reader.inject.failed', { code: errorCode(error) }));
});

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message?.type === 'OPEN_PANEL' && sender.tab?.id) {
    if (message.view === 'notes') void chrome.storage.session.set({ [`view-${sender.tab.id}`]: 'notes' });
    if (message.view === 'knowledge') void chrome.storage.session.set({ [`knowledge-${sender.tab.id}`]: { actionId:crypto.randomUUID() } });
    if (message.teach === true && typeof message.question === 'string' && message.question.length <= 2000) {
      void chrome.storage.session.set({ [`deep-${sender.tab.id}`]: { question: message.question, actionId: crypto.randomUUID() } });
    }
    void chrome.sidePanel.open({ tabId: sender.tab.id }).then(() => { void appendDiagnostic('panel.open'); respond({ ok: true }); }, error => { void appendDiagnostic('panel.open.failed', { code: errorCode(error) }); respond({ ok: false }); });
    return true;
  }
  if (message?.type === 'OPEN_SETTINGS' && sender.tab?.id) { void chrome.runtime.openOptionsPage(); respond({ ok: true }); return; }
  // No key/config relay is exposed to content scripts. These messages only originate in extension pages.
  const path = sender.url?.startsWith(chrome.runtime.getURL('')) ? new URL(sender.url).pathname.slice(1) : '';
  if (path === 'options.html' && message?.type === 'SYNC_AUTO_READER') {
    void syncAutoReader().then(() => respond({ ok: true }), () => respond({ ok: false }));
    return true;
  }
  if (TRUSTED_PAGES.has(path) && message?.type === 'DIAGNOSTIC_FLUSH') {
    void flushDiagnostics().then(() => respond({ ok: true }));
    return true;
  }
  // Extension settings opened in a normal tab have sender.tab too; trust the extension URL, not its absence.
  if (TRUSTED_PAGES.has(path) && message?.type === 'DIAGNOSTIC' && EVENTS.includes(message.event)) {
    void appendDiagnostic(message.event, message.meta && typeof message.meta === 'object' ? message.meta : {}).then(() => respond({ ok: true }), () => respond({ ok: false }));
    return true;
  }
  if (!sender.tab && TRUSTED_PAGES.has(path) && message?.type === 'INJECT' && Number.isInteger(message.tabId)) {
    void ensureReader(message.tabId)
      .then(() => respond({ ok: true }), () => respond({ ok: false, error: '请先点击浏览器工具栏中的拾知图标，授权读取当前网页。' }));
    return true;
  }
});
