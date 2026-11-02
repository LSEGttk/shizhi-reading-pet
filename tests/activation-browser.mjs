import { chromium } from 'playwright';
import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const temp = await mkdtemp(join(tmpdir(), 'reading-pet-activation-'));
const ext = join(temp, 'extension');
await cp('dist', ext, { recursive: true });
const manifest = JSON.parse(await readFile(join(ext, 'manifest.json'), 'utf8'));
// This disposable profile pre-grants website access. Production requests optional
// permission via the checkbox; missing/revoked permissions have separate unit tests.
manifest.host_permissions = ['https://*/*', 'http://*/*'];
await writeFile(join(ext, 'manifest.json'), JSON.stringify(manifest));
const context = await chromium.launchPersistentContext(join(temp, 'profile'), {
  executablePath: process.env.READING_PET_CHROMIUM || '/usr/bin/google-chrome', headless: true,
  ignoreDefaultArgs: ['--disable-extensions'], args: ['--no-sandbox', '--enable-unsafe-extension-debugging'],
});
const errors = [], requests = [];
context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
await context.route(/^https?:\/\/(?:one|two)\.reading-pet\.example\//, async route => {
  requests.push(route.request().method());
  const name = new URL(route.request().url()).pathname.slice(1);
  await route.fulfill({ contentType: 'text/html', body: `<html><title>${name}</title><article><h1>${name}</h1><p>${'这篇测试文章用于确认切换网页后读取正确的上下文，不需要发送模型请求。'.repeat(5)}</p></article></html>` });
});
try {
  const cdp = await context.browser().newBrowserCDPSession();
  await cdp.send('Extensions.loadUnpacked', { path: ext });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).hostname;
  const first = await context.newPage(); await first.goto('https://one.reading-pet.example/first');
  const second = await context.newPage(); await second.goto('https://two.reading-pet.example/second');
  assert.equal(await first.locator('[data-reading-pet]').count(), 0, 'no automatic reading before opt-in');
  const options = await context.newPage(); await options.goto(`chrome-extension://${id}/options.html`);
  await options.waitForFunction(() => document.querySelector('#model').value === '');
  // Exercise the declined-request UI without a native permission dialog in headless Chrome.
  await options.evaluate(() => { window.realRequest = chrome.permissions.request; chrome.permissions.request = async () => false; });
  await options.locator('#auto-read').click();
  await options.waitForFunction(() => document.querySelector('#auto-read-status').textContent.includes('未授权'));
  assert.equal(await options.locator('#auto-read').isChecked(), false);
  await options.evaluate(() => { chrome.permissions.request = window.realRequest; });
  await options.locator('#auto-read').check();
  await options.waitForFunction(() => document.querySelector('#auto-read-status').textContent.includes('已开启'));
  const scripts = await worker.evaluate(() => chrome.scripting.getRegisteredContentScripts());
  assert.equal(scripts.length, 1); assert.equal(scripts[0].persistAcrossSessions, true);
  await first.bringToFront(); await first.waitForSelector('[data-reading-pet]');
  await second.bringToFront(); await second.waitForSelector('[data-reading-pet]');
  const fresh = await context.newPage(); await fresh.goto('http://one.reading-pet.example/fresh');
  await fresh.waitForSelector('[data-reading-pet]');
  await fresh.reload(); await fresh.waitForSelector('[data-reading-pet]');
  assert.equal(await fresh.locator('[data-reading-pet]').count(), 1);
  const firstId = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'https://one.reading-pet.example/first' }))[0].id);
  const secondId = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'https://two.reading-pet.example/second' }))[0].id);

  const panel = await context.newPage();
  await panel.addInitScript(tabId => {
    window.testTab = tabId;
    chrome.tabs.query = async () => [{ id: window.testTab }];
    const send = chrome.tabs.sendMessage.bind(chrome.tabs);
    chrome.tabs.sendMessage = async (...args) => {
      const result = await send(...args);
      if (args[1]?.type === 'GET_PAGE' && window.delayRead) {
        window.delayRead = false; window.readDelayed = true;
        await new Promise(resolve => { window.releaseRead = resolve; });
      }
      return result;
    };
  }, firstId);
  await panel.goto(`chrome-extension://${id}/panel.html`);
  await panel.waitForFunction(() => document.querySelector('#page-title').textContent === 'first');
  await first.goto('https://one.reading-pet.example/changed');
  await panel.waitForFunction(() => document.querySelector('#page-title').textContent === 'changed');

  // Hold one old-page response, switch to another tab, then release it.
  await panel.evaluate(() => { window.delayRead = true; });
  await panel.locator('#refresh').click();
  await panel.waitForFunction(() => window.readDelayed);
  await panel.evaluate(tabId => { window.testTab = tabId; }, secondId);
  await worker.evaluate(tabId => chrome.tabs.update(tabId, { active: true }), secondId);
  await panel.waitForFunction(() => document.querySelector('#page-title').textContent === 'second');
  await panel.evaluate(() => window.releaseRead());
  await panel.evaluate(() => new Promise(resolve => setTimeout(resolve, 100)));
  assert.equal(await panel.locator('#page-title').textContent(), 'second', 'late response cannot restore the previous article');

  await panel.close();
  await options.locator('#auto-read').uncheck();
  await options.waitForFunction(() => document.querySelector('#auto-read-status').textContent.includes('已关闭'));
  assert.equal((await worker.evaluate(() => chrome.scripting.getRegisteredContentScripts())).length, 0);
  await fresh.reload();
  assert.equal(await fresh.locator('[data-reading-pet]').count(), 0, 'disabled mode does not return after refresh');
  assert.ok(requests.every(method => method === 'GET'), 'appearance and navigation do not call the model');
  assert.deepEqual(errors, []);
  const result = { passed: ['opt-in and declined request UI', 'persistent content-script registration', 'existing tabs activate on switch', 'new HTTP and HTTPS pages', 'reload without duplicate pets', 'sidebar follows navigation', 'late old-tab response discarded', 'disable prevents future injection', 'no automatic model requests'] };
  await writeFile('artifacts/activation-browser-results.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { await context.close(); await rm(temp, { recursive: true, force: true }); }
