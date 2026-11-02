// Browser lifecycle and permission handling stay separate from reading/model work.
export const AUTO_READ_ORIGINS = ['https://*/*', 'http://*/*'];
export const AUTO_READ_KEY = 'autoRead';
const SCRIPT_ID = 'reading-pet-auto';

export async function ensureReader(tabId: number, showBubble = false) {
  const mounted = await chrome.tabs.sendMessage(tabId, { type: 'READER_READY' }).catch(() => null);
  if (!mounted?.ok) await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  if (showBubble) await chrome.tabs.sendMessage(tabId, { type: 'SHOW_BUBBLE' });
}

export async function autoReadEnabled() {
  return (await chrome.storage.local.get(AUTO_READ_KEY))[AUTO_READ_KEY] === true
    && await chrome.permissions.contains({ origins: AUTO_READ_ORIGINS });
}

export function installAutoReader() {
  // Serialize updates: settings changes and permission events can arrive together.
  let pending = Promise.resolve();
  async function activate(tabId: number) {
    if (!await autoReadEnabled()) return;
    const tab = await chrome.tabs.get(tabId);
    if (tab.status !== 'complete' || !/^https?:\/\//.test(tab.url || '')) return;
    // Browser-restricted pages may have an HTTPS URL; failure must not break other tabs.
    await ensureReader(tabId).catch(() => {});
  }
  async function sync() {
    const enabled = await autoReadEnabled();
    const registered = (await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] })).length > 0;
    if (enabled && !registered) {
      await chrome.scripting.registerContentScripts([{
        id: SCRIPT_ID, matches: AUTO_READ_ORIGINS, js: ['content.js'],
        runAt: 'document_idle', allFrames: false, persistAcrossSessions: true,
      }]);
    } else if (!enabled && registered) {
      await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
    }
    if (enabled) {
      for (const tab of await chrome.tabs.query({ active: true })) {
        if (tab.id !== undefined) await activate(tab.id).catch(() => {});
      }
    }
  }
  function schedule() {
    pending = pending.catch(() => {}).then(sync);
    return pending;
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[AUTO_READ_KEY]) void schedule().catch(() => {});
  });
  chrome.permissions.onAdded.addListener(() => { void schedule().catch(() => {}); });
  chrome.permissions.onRemoved.addListener(() => { void schedule().catch(() => {}); });
  chrome.tabs.onActivated.addListener(({ tabId }) => { void activate(tabId).catch(() => {}); });
  chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
    if (tab.active && change.status === 'complete') void activate(tabId).catch(() => {});
  });
  void schedule().catch(() => {});
  return schedule;
}
