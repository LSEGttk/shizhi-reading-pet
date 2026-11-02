import { getSettings, saveSettings } from './storage/local';
import { complete, endpoint, permissionOrigin } from './providers/chat';
import type { Settings, ImageSettings } from './types';
import { imageEndpoint } from './providers/images';
import { captureRuntimeErrors, diagnosticReport, errorCode, record } from './diagnostics';
import { downloadText } from './ui/render';
import { AUTO_READ_KEY, AUTO_READ_ORIGINS, autoReadEnabled } from './reader/activation';

captureRuntimeErrors('options');

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $('options-status');
function show(text: string, error = false) { status.textContent = text; status.classList.toggle('error', error); if (error) record('settings.failed'); }
const autoRead = $<HTMLInputElement>('auto-read');
const autoReadStatus = $('auto-read-status');
async function refreshAutoRead() { autoRead.checked = await autoReadEnabled(); }
autoRead.onchange = () => {
  const enabled = autoRead.checked;
  autoRead.disabled = true;
  // Request directly from the checkbox gesture, before any asynchronous work.
  const permission = enabled ? chrome.permissions.request({ origins: AUTO_READ_ORIGINS }) : Promise.resolve(true);
  void permission.then(async granted => {
    if (!granted) throw new Error('未授权，仍可点击工具栏图标在当前网页使用。');
    await chrome.storage.local.set({ [AUTO_READ_KEY]: enabled });
    const synced = await chrome.runtime.sendMessage({ type: 'SYNC_AUTO_READER' });
    if (!synced?.ok) throw new Error('自动陪读未完成配置，请重新切换开关重试。');
    autoReadStatus.textContent = enabled ? '已开启。切换到文章或打开新网页即可陪读，无需重复点击图标。' : '已关闭自动出现。当前页面已有的宠物可收起，刷新后生效。';
  }).catch(error => { autoReadStatus.textContent = error.message; })
    .finally(async () => { await refreshAutoRead(); autoRead.disabled = false; });
};
chrome.permissions.onRemoved.addListener(() => { void refreshAutoRead(); });
void refreshAutoRead();
function read(): Settings {
  return { baseUrl: $<HTMLInputElement>('base-url').value.trim(), apiKey: $<HTMLInputElement>('api-key').value.trim(), model: $<HTMLInputElement>('model').value.trim(), tools: $<HTMLInputElement>('tools').checked, inputBudget: Number($<HTMLInputElement>('input-budget').value), maxOutput: Number($<HTMLInputElement>('max-output').value), autoNotes: $<HTMLInputElement>('auto-notes').checked, reviewAnswers: $<HTMLInputElement>('review-answers').checked };
}
async function save() {
  const settings = read(), url = endpoint(settings.baseUrl);
  if (!settings.model || !Number.isInteger(settings.inputBudget) || !Number.isInteger(settings.maxOutput) || settings.inputBudget < 4000 || settings.inputBudget > 64000 || settings.maxOutput < 256 || settings.maxOutput > 4096) throw new Error('请检查模型名称与预算范围。');
  // Request before any awaited operation so the browser still recognizes the user gesture.
  const permitted = await chrome.permissions.request({ origins: [permissionOrigin(url)] });
  if (!permitted) throw new Error('未获得模型接口域名权限，设置尚未保存。');
  await saveSettings({ ...settings, image: (await getSettings()).image });
  record('settings.saved', { toolsEnabled: settings.tools, autoNotes: settings.autoNotes, keyConfigured: !!settings.apiKey, modelConfigured: !!settings.model });
  return settings;
}
$('settings-form').addEventListener('submit', event => {
  event.preventDefault();
  void save().then(() => show('已保存。回到文章，点击拾知图标即可开始。'), error => show(error.message, true));
});
$('test-model').onclick = () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  show('正在测试接口…');
  void save().then(settings => complete(settings, [{ role: 'user', content: '请只回复：连接成功。' }], [], controller.signal, () => {}))
    .then(() => show('连接成功。可以回到网页开始陪读。'), error => show(error.name === 'AbortError' ? '连接超时，请检查接口地址。' : error.message, true))
    .finally(() => clearTimeout(timer));
};
void getSettings().then(s => {
  const image = s.image!;
  $<HTMLInputElement>('image-enabled').checked = image.enabled;
  $<HTMLInputElement>('image-base-url').value = image.baseUrl; $<HTMLInputElement>('image-api-key').value = image.apiKey; $<HTMLInputElement>('image-model').value = image.model; $<HTMLSelectElement>('image-size').value = image.size;
  $<HTMLInputElement>('base-url').value = s.baseUrl; $<HTMLInputElement>('api-key').value = s.apiKey; $<HTMLInputElement>('model').value = s.model;
  $<HTMLInputElement>('tools').checked = s.tools; $<HTMLInputElement>('input-budget').value = String(s.inputBudget); $<HTMLInputElement>('max-output').value = String(s.maxOutput); $<HTMLInputElement>('auto-notes').checked = s.autoNotes; $<HTMLInputElement>('review-answers').checked = s.reviewAnswers;
});

const diagnosticStatus = $('diagnostics-status');
async function updateDiagnostics() {
  const report = await diagnosticReport();
  $<HTMLInputElement>('diagnostics-enabled').checked = report.enabled;
  diagnosticStatus.textContent = `已保留 ${report.events.length} 条本地诊断事件（最多 200 条）。`;
}
$('diagnostics-enabled').onchange = () => {
  void chrome.storage.local.set({ diagnosticsEnabled: $<HTMLInputElement>('diagnostics-enabled').checked }).then(updateDiagnostics);
};
$('export-diagnostics').onclick = () => {
  void diagnosticReport().then(report => {
    downloadText(`拾知-诊断日志-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, JSON.stringify(report, null, 2), 'application/json');
    diagnosticStatus.textContent = '日志已导出。你可以查看后，手动提供给开发者排查。';
  }).catch(error => { diagnosticStatus.textContent = `无法导出日志（${errorCode(error)}）。`; });
};
void updateDiagnostics();

$('image-settings-form').addEventListener('submit', event => {
  event.preventDefault();
  const image: ImageSettings = { enabled: $<HTMLInputElement>('image-enabled').checked, baseUrl: $<HTMLInputElement>('image-base-url').value.trim(), apiKey: $<HTMLInputElement>('image-api-key').value.trim(), model: $<HTMLInputElement>('image-model').value.trim(), size: $<HTMLSelectElement>('image-size').value };
  void (async () => {
    if (image.enabled) {
      if (!image.model) throw new Error('请填写图片模型名称。');
      const url = imageEndpoint(image.baseUrl);
      if (!await chrome.permissions.request({ origins: [permissionOrigin(url)] })) throw new Error('未获得图片接口域名权限。');
    }
    await saveSettings({ ...await getSettings(), image });
    $('image-status').textContent = image.enabled ? '图片接口已保存。可在侧栏的插画卡片中点击生成。' : '图片生成已关闭，已有图片仍可查看。';
  })().catch(error => { $('image-status').textContent = error.message; });
});
$('image-download-form').addEventListener('submit', event => {
  event.preventDefault();
  void (async () => {
    const url = new URL($<HTMLInputElement>('image-download-origin').value);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('请填写 HTTPS 图片域名。');
    const allowed = await chrome.permissions.request({ origins: [permissionOrigin(url)] });
    $('image-status').textContent = allowed ? '图片下载域名已授权。' : '下载域名未授权。';
  })().catch(error => { $('image-status').textContent = error.message; });
});
