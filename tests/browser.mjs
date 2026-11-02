import { chromium } from 'playwright';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const fixture = await readFile('tests/fixtures/article.html', 'utf8');
const bpeFixture = await readFile('tests/fixtures/bpe.html', 'utf8');
const embeddingFixture = await readFile('tests/fixtures/embedding.html', 'utf8');
const siteFixture = process.env.READING_PET_ARTICLE_HTML ? (await readFile(process.env.READING_PET_ARTICLE_HTML, 'utf8')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<link\b[^>]*>/gi, '') : null;
const requests = [];
let shouldHang = false;
let summaries = 0;
const server = createServer(async (req, res) => {
  if (req.url === '/article') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(fixture); return; }
  if (req.url === '/embedding') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(embeddingFixture); return; }
  if (req.url === '/bpe') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(bpeFixture); return; }
  if (req.url === '/site-article' && siteFixture) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(siteFixture); return; }
  if (req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return; }
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw); requests.push(body);
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const send = event => res.write(`data: ${JSON.stringify(event)}\n\n`);
  if (shouldHang) { res.write(': waiting\n\n'); return; }
  const system = body.messages[0].content;
  if (system.includes('合并后的 Markdown')) {
    summaries++;
    send({ choices: [{ delta: { content: `**核心理解**\nW 的一行生成一个输出，因此 3 个输入生成 2 个输出时，W 为 2×3。\n${summaries > 1 ? '数值先初始化，再通过训练学习；具体初始化方式原文未说明。' : ''}` } }] });
    send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
  } else if (system.includes('你是解释质检编辑')) {
    const packet = JSON.parse(body.messages[1].content), id = packet.passages[0]?.id;
    const bpe = packet.selection?.text.includes('BPE'), embedding = packet.selection?.text.includes('B×T×384');
    const text = embedding ? `输入里每个位置原本只有一个编号，因为查表把这个编号替换成384个数，所以样本轴与位置轴保留，在末尾增加特征轴，得到B×T×384。[${id}]\n例如假设B=2、T=3，就有6个编号，每个换成384个数，按原位置摆好得到2×3×384。这里的查表结果是本次输入的输出张量，参数表则是另一回事。` : bpe ? `关键在：BPE 像给常见片段设“快捷键”：用更多词表条目，换更少的 token。罕见片段能否退回小符号表示，取决于基础符号是否覆盖完整。[${id}]` : `把矩阵想成两台小计算器：每台接收 3 个输入，算出 1 个输出，所以要 2 行 3 列。数值则通过训练学习。[${id}]`;
    const formatted=packet.depth==='example'&&!packet.module?`### 原理\n${text.replace('\n例如','\n### 例子\n例如')}`:text;
    send({ choices: [{ delta: { content: formatted }, finish_reason: 'stop' }] });
  } else if (JSON.parse(body.messages[1].content).module === 'knowledge') {
    const packet=JSON.parse(body.messages[1].content),id=packet.passages[0]?.id;
    const text=packet.knowledgeOverview ? `## 定义\n这里的输出形状表示一批文本的向量排列，B是样本数，T是每条的位置数，384是向量宽度。[${id}]\n\n## 原理\n因为每个位置的一个编号被替换成384个数，所以样本和位置轴保留，末尾新增向量轴。[${id}]\n\n## 例子\n例如假设B=2、T=3，有6个编号，各取出384个数，按原位置摆成2×3×384。\n\n## 延伸\n本次输出随输入大小变化；参数表是另一张词表大小×384的表，不会因为这批样本增加而扩大。[${id}]` : `D表示每个位置对应的向量里有多少个数；本段设为384。[${id}]`;
    send({choices:[{delta:{content:text},finish_reason:'stop'}]});
  } else if (body.tools?.length && !body.messages.some(m => m.role === 'tool')) {
    send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-definition', type: 'function', function: { name: 'searchPage', arguments: '{"query":"本文采用列向量约定 输入 输出"}' } }] } }] });
    send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
  } else {
    const packet = JSON.parse(body.messages[1].content);
    const id = packet.passages[0]?.id;
    const contextualRead = packet.depth === 'context' && packet.task.includes('结合附近原文') && packet.page.title.includes('权重矩阵');
    const text = packet.depth==='example'&&packet.page.title.includes('BPE') ? `### 原理\n因为常见片段能用一个编号表示，所以更大的词表可以换更短的序列；代价是嵌入表随词表扩大。[${id}]\n### 例子\n例如把反复出现的a和b合成ab，原来的a b a b四个符号就能写成ab ab两个符号。` : contextualRead ? `这里的W记录输入与输出之间的权重。两行分别对应两个输出，三列分别对应三个输入；选中的符号是在说明这张表的尺寸。[${id}]` : packet.learningPlan?.focusHint === 'check' ? '同一张宽度为384的词向量表，若每个样本的位置数从3变成5，样本数保持2，输出形状应怎样变化？请说出位置轴变化的原因。' : packet.page.title.includes('Embedding') ? 'B是样本数，T是位置数，384是向量宽度。' : packet.depth === 'brief' ? `**核心含义**：${packet.passages[0]?.text}\n**直接原因**：${'请结合文章中的定义与完整语境逐步理解这一过程。'.repeat(8)}[${id}]` : `**这是把输入映射成输出的权重矩阵。**\n每个输出需要 3 个权重，所以有 3 列；需要 2 个输出，所以有 2 行。[${id}]\n例如假设输入是 [2,1,0]，某行权重是 [1,2,0]，逐项相乘再求和就得到 4。参数数值先初始化，再通过训练学习。具体初始化方法原文未说明。`;
    const formatted=packet.depth==='example'&&!text.startsWith('###')?`### 原理\n${text.replace('\n例如','\n### 例子\n例如')}`:text;
    for (const piece of [formatted.slice(0, 20), formatted.slice(20, 65), formatted.slice(65)]) send({ choices: [{ delta: { content: piece } }] });
    send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
  }
  res.end('data: [DONE]\n\n');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const localOrigin = `http://127.0.0.1:${server.address().port}`;
const origin = 'https://reading-pet.example';
const modelOrigin = 'https://model.reading-pet.example';
const temp = await mkdtemp(join(tmpdir(), 'reading-pet-e2e-'));
const ext = join(temp, 'extension'); await cp('dist', ext, { recursive: true });
// Test-only export, created in the disposable copy and never included in the release package.
await build({stdin:{contents:"export {appendTurn,patchTurn,loadThread,updateNote,listNotes} from './src/storage/local.ts';export {topicKey} from './src/agent/run.ts';",resolveDir:process.cwd(),loader:'ts'},bundle:true,format:'esm',outfile:join(ext,'test-storage.js'),target:'chrome116'});
const manifest = JSON.parse(await readFile(join(ext, 'manifest.json'), 'utf8'));
// Only the mock model origin is granted up front; article access still requires the action gesture.
manifest.host_permissions = [`${modelOrigin}/*`];
await writeFile(join(ext, 'manifest.json'), JSON.stringify(manifest));
const context = await chromium.launchPersistentContext(join(temp, 'profile'), {
  executablePath: process.env.READING_PET_CHROMIUM || '/usr/bin/google-chrome',
  headless: true, viewport: { width: 1100, height: 900 },
  ignoreDefaultArgs: ['--disable-extensions'],
  args: ['--no-sandbox', '--enable-unsafe-extension-debugging'],
});
async function shadowCall(page, body, arg = null) {
  const session = await context.newCDPSession(page);
  try {
    const { root } = await session.send('DOM.getDocument', { depth: -1, pierce: true });
    function find(node) {
      if (node.attributes?.includes('data-reading-pet')) return node;
      for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) { const result = find(child); if (result) return result; }
    }
    const host = find(root); assert.ok(host?.shadowRoots?.[0]);
    const { object } = await session.send('DOM.resolveNode', { backendNodeId: host.shadowRoots[0].backendNodeId });
    const result = await session.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: `function(arg){${body}}`, arguments: [{ value: arg }], returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  } finally { await session.detach(); }
}
async function waitShadow(page, body, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await shadowCall(page, body)) return; await new Promise(resolve => setTimeout(resolve, 70)); }
  throw new Error(`Bubble assertion timed out: ${body}`);
}
try {
  const cdp = await context.browser().newBrowserCDPSession();
  await cdp.send('Extensions.loadUnpacked', { path: ext });
  // Route synthetic domains through Node's local test server. No external model is contacted;
  // extension code, browser messages, storage and page DOM still run in the real browser.
  await context.route(/https:\/\/(?:model\.)?reading-pet\.example\//, async route => {
    if (shouldHang && route.request().method() === 'POST') return;
    try {
      const request = route.request();
      const response = await fetch(`${localOrigin}${new URL(request.url()).pathname}`, { method: request.method(), headers: { 'Content-Type': request.headers()['content-type'] || 'application/json' }, ...(request.postData() ? { body: request.postData() } : {}) });
      await route.fulfill({ status: response.status, contentType: response.headers.get('content-type') || 'text/html', body: Buffer.from(await response.arrayBuffer()) });
    } catch { await route.abort().catch(() => {}); }
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).hostname;
  const errors = [];
  const article = await context.newPage(); article.on('pageerror', e => errors.push(e.message));
  await article.goto(`${origin}/article`);
  const articleId = await worker.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id);
  const { targetInfos } = await cdp.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }] });
  const tabTarget = targetInfos.find(t => t.url === `${origin}/article`);
  assert.ok(tabTarget, 'article tab target exists');
  await cdp.send('Extensions.triggerAction', { id, targetId: tabTarget.targetId });
  await article.waitForSelector('[data-reading-pet]');
  await worker.evaluate(async tabId => { if (chrome.sidePanel.close) { const tab = await chrome.tabs.get(tabId); await chrome.sidePanel.close({ windowId: tab.windowId }).catch(() => {}); } }, articleId);
  await article.evaluate(() => {
    const target = document.querySelector('#selection');
    const range = document.createRange(); range.selectNodeContents(target);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  });
  const initial = await worker.evaluate(tabId => chrome.tabs.sendMessage(tabId, { type: 'GET_PAGE' }), articleId);
  assert.ok(initial.page.selection.text.includes('权重矩阵'));
  assert.ok(initial.page.blocks.every(b => !b.text.includes('山川来信 /')));
  const repeated = initial.page.blocks.filter(b => b.text === '这里的参数需要结合定义理解。');
  assert.equal(repeated.length, 2); assert.notEqual(repeated[0].id, repeated[1].id);
  await worker.evaluate(async ({ modelOrigin }) => {
    await chrome.storage.local.set({ settings: { baseUrl: `${modelOrigin}/v1`, apiKey: 'local-test-key', model: 'mock-reader', tools: true, inputBudget: 12000, maxOutput: 800, autoNotes: true } });
  }, { modelOrigin });
  const isolated = await worker.evaluate(async tabId => (await chrome.scripting.executeScript({ target: { tabId }, func: async () => {
    try { return { exposed: !!(await chrome.storage.local.get('settings')).settings }; } catch { return { exposed: false }; }
  } }))[0].result, articleId);
  assert.equal(isolated.exposed, false, 'content script cannot read the API key settings');
  const panel = await context.newPage(); panel.on('pageerror', e => errors.push(e.message));
  // Render the actual extension side-panel page in a test tab; only active-tab discovery is stubbed.
  await panel.addInitScript(tabId => { chrome.tabs.query = async () => [{ id: tabId }]; }, articleId);
  await panel.setViewportSize({ width: 410, height: 1000 });
  await panel.goto(`chrome-extension://${id}/panel.html`);
  await panel.waitForFunction(() => document.querySelector('#selection-text').textContent.includes('权重矩阵'));
  assert.equal(await panel.locator('#depth').inputValue(), 'context', 'sidebar default expands contextual understanding');
  await panel.locator('[data-prompt]').first().click();
  await panel.waitForFunction(() => document.querySelector('#status').textContent.includes('这次理解已留下'));
  assert.equal(requests.length, 3, 'one read + one tool continuation + one note merge');
  assert.ok(requests[1].messages.some(m => m.role === 'tool'));
  await panel.locator('#context-details summary').click();
  assert.match(await panel.locator('#context-text').textContent(), /reading \+ formula/);
  assert.ok(await panel.locator('.source').count() > 0);
  assert.equal(await panel.locator('.turn').last().getAttribute('data-depth'), 'context');
  assert.match(await panel.locator('.turn .answer-mode').last().textContent(),/结合上下文/);
  assert.ok(!requests[0].messages[0].content.includes('像一本写得清楚的教科书'),'default reading does not load the principle teaching rules');
  assert.match(await panel.locator('.mode-hint').textContent(),/侧栏按上下文展开/);
  await panel.locator('.source').first().click();
  assert.ok(await article.locator('[style*="outline"]').count() > 0);
  await mkdir('artifacts', { recursive: true });
  await panel.screenshot({ path: 'artifacts/context-preview.png', fullPage: true });
  await panel.locator('#context-details summary').click();
  await panel.screenshot({ path: 'artifacts/reading-panel.png', fullPage: true });
  await article.screenshot({ path: 'artifacts/article-pet.png', fullPage: true });
  await panel.locator('#question').fill('这些参数的数值从哪里来？');
  await panel.locator('#send').click();
  await panel.waitForFunction(() => document.querySelector('#status').textContent.includes('这次理解已留下'));
  await panel.locator('#notes-tab').click();
  await panel.waitForSelector('.note');
  assert.equal(await panel.locator('.note').count(), 1, 'follow-up updates one topic instead of appending duplicate notes');
  assert.match(await panel.locator('.note').textContent(), /2 个问题/);
  await panel.screenshot({ path: 'artifacts/notes-panel.png', fullPage: true });
  await panel.getByRole('button', { name: '编辑', exact: true }).click();
  await panel.locator('.note textarea').fill('我自己的理解：每行计算一个输出。');
  await panel.getByRole('button', { name: '保存修改' }).click();
  await panel.waitForFunction(() => document.querySelector('.note .answer').textContent.includes('我自己的理解'));
  await panel.getByRole('button', { name: '撤销上次整理' }).click();
  await panel.waitForFunction(() => !document.querySelector('.note .answer').textContent.includes('我自己的理解'));
  await panel.reload();
  await panel.waitForFunction(() => document.querySelectorAll('.turn').length === 2);
  await panel.locator('#scope').selectOption('passage');
  await panel.locator('#question').fill('仅用附近内容解释。');
  await panel.locator('#send').click();
  await panel.waitForFunction(() => document.querySelector('#status').textContent.includes('这次理解已留下'));
  const passageRequest = requests.find(r => r.messages[1]?.content.includes('仅用附近内容解释。'));
  assert.equal(passageRequest.tools, undefined);
  assert.deepEqual(JSON.parse(passageRequest.messages[1].content).outline, []);
  shouldHang = true;
  await panel.locator('#question').fill('测试中止'); await panel.locator('#send').click();
  await panel.waitForFunction(() => !document.querySelector('#cancel').hidden);
  await panel.locator('#cancel').click();
  await panel.waitForFunction(() => document.querySelector('#status').textContent.includes('已停止本次解释'));
  shouldHang = false;
  // Page mutation must prevent a stale answer and stale citations.
  const count = requests.length;
  await article.locator('#definition').evaluate(el => { el.textContent += ' 这是修改后的定义。'; });
  await panel.locator('#question').fill('继续解释'); await panel.locator('#send').click();
  await panel.waitForFunction(() => document.querySelector('#status').textContent.includes('网页内容已变化'));
  assert.equal(requests.length, count);
  const located = await worker.evaluate(({ tabId, blockId, version }) => chrome.tabs.sendMessage(tabId, { type: 'LOCATE', blockId, version }), { tabId: articleId, blockId: initial.page.blocks[0].id, version: initial.page.version });
  assert.equal(located.ok, false);
  const options = await context.newPage(); await options.goto(`chrome-extension://${id}/options.html`);
  await options.waitForFunction(() => document.querySelector('#model').value === 'mock-reader');
  assert.equal(await options.locator('#api-key').inputValue(), 'local-test-key');
  await options.waitForFunction(() => document.querySelector('#diagnostics-enabled').checked);
  await options.waitForFunction(() => /[1-9]\d* 条/.test(document.querySelector('#diagnostics-status').textContent));
  const diagnosticDownload = options.waitForEvent('download');
  await options.locator('#export-diagnostics').click();
  const logFile = await diagnosticDownload;
  const diagnostic = JSON.parse(await readFile(await logFile.path(), 'utf8'));
  assert.equal(diagnostic.version, manifest.version);
  assert.ok(diagnostic.events.some(e => e.event === 'reading.completed'));
  assert.ok(diagnostic.events.some(e => e.event === 'model.http' && e.meta.status === 200));
  assert.ok(diagnostic.events.some(e => e.event === 'notes.saved'));
  for (const privateText of ['local-test-key', '权重矩阵', '这些参数的数值从哪里来', modelOrigin]) assert.ok(!JSON.stringify(diagnostic).includes(privateText));
  await options.locator('#diagnostics-enabled').uncheck();
  await options.evaluate(() => chrome.runtime.sendMessage({ type: 'DIAGNOSTIC_FLUSH' }));
  const beforeDisable = await worker.evaluate(async () => (await chrome.storage.local.get('diagnosticLog')).diagnosticLog.length);
  await options.evaluate(() => chrome.runtime.sendMessage({ type: 'DIAGNOSTIC', event: 'model.started', meta: { inputMessages: 7 } }));
  const afterDisable = await worker.evaluate(async () => (await chrome.storage.local.get('diagnosticLog')).diagnosticLog.length);
  assert.equal(afterDisable, beforeDisable);
  await options.locator('#diagnostics-enabled').check();
  await options.screenshot({ path: 'artifacts/model-settings.png', fullPage: true });
  // Exercise the in-page bubble without a side-panel executor. The background owns the API key.
  await panel.close(); await options.close();
  const bpe = await context.newPage(); bpe.on('pageerror', e => errors.push(e.message));
  await bpe.goto(`${origin}/bpe`);
  const { targetInfos: bpeTargets } = await cdp.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }] });
  await cdp.send('Extensions.triggerAction', { id, targetId: bpeTargets.find(t => t.url.endsWith('/bpe')).targetId });
  await bpe.waitForSelector('[data-reading-pet]');
  await bpe.evaluate(() => { const el = document.querySelector('#selection'), range = document.createRange(); range.selectNodeContents(el); getSelection().removeAllRanges(); getSelection().addRange(range); el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); });
  const bpeId = await worker.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id);
  const syncPanel=await context.newPage();syncPanel.on('pageerror',e=>errors.push(e.message));
  await syncPanel.addInitScript(tabId=>{if(chrome?.tabs)chrome.tabs.query=async()=>[{id:tabId}];},bpeId);
  await syncPanel.setViewportSize({width:410,height:1000});
  await syncPanel.goto(`chrome-extension://${id}/panel.html`);
  await syncPanel.waitForFunction(()=>document.querySelector('#selection-text').textContent.includes('BPE'));
  await syncPanel.locator('#question').fill('这个草稿需要保留');await syncPanel.locator('#depth').selectOption('example');
  const beforeBubble = requests.length;
  await shadowCall(bpe, "this.querySelector('.ask').click();");
  await waitShadow(bpe, "return this.querySelector('.bubble-answer').textContent.includes('快捷键') && this.querySelector('.bubble-footer button:last-child').hidden;");
  const bubbleText = await shadowCall(bpe, "return this.querySelector('.bubble-answer').textContent;");
  assert.ok(bubbleText.length < 150);
  assert.ok(!bubbleText.includes('核心含义'));
  assert.ok(!bubbleText.startsWith('关键在'));
  assert.match(await shadowCall(bpe, "return this.querySelector('.bubble-head strong').textContent;"), /简短解惑/);
  assert.ok(bubbleText.includes('覆盖完整'), 'compression retains the symbol-coverage condition');
  const beforeCorrection = requests.length;
  await shadowCall(bpe, "[...this.querySelectorAll('.bubble-adjustments button')].find(b=>b.textContent==='不是问这个').click();");
  assert.equal(await shadowCall(bpe, "return this.querySelector('.bubble-form input').value;"), '我想问的是：');
  assert.equal(requests.length, beforeCorrection, 'correction input does not call the model before sending');
  assert.equal(await shadowCall(bpe, "return this.querySelector('.bubble-adjustments button').textContent;"), '再白话点');
  const bubbleRequests = requests.slice(beforeBubble);
  assert.equal(bubbleRequests.filter(r => r.messages[0].content.includes('你是解释质检编辑')).length, 1, 'one bounded review pass');
  await syncPanel.waitForFunction(()=>document.querySelectorAll('#conversation .turn').length===1&&document.querySelector('#conversation .answer').textContent.includes('快捷键'));
  assert.match(await syncPanel.locator('.answer-mode').textContent(),/气泡/);
  assert.equal(await syncPanel.locator('#question').inputValue(),'这个草稿需要保留');
  assert.equal(await syncPanel.locator('#depth').inputValue(),'example');
  await syncPanel.locator('#conversation .turn').first().evaluate(el=>{el.dataset.preserveProbe='live';});
  const beforeRewrite=requests.length;
  await syncPanel.locator('#reexplain').click();
  await syncPanel.waitForFunction(()=>document.querySelectorAll('#conversation .turn').length===2&&document.querySelector('#status').textContent.includes('这次理解已留下'));
  assert.deepEqual(await syncPanel.locator('#conversation .turn').last().locator('.answer h3').allTextContents(),['原理','例子']);
  assert.equal(await syncPanel.locator('#conversation .turn').first().getAttribute('data-preserve-probe'),'live','appending a turn preserves existing answer DOM');
  const rewriteRequest=requests.slice(beforeRewrite).find(r=>!r.messages[0].content.includes('解释质检编辑'));
  assert.equal(JSON.parse(rewriteRequest.messages[1].content).depth,'example');
  assert.equal(await syncPanel.locator('#question').inputValue(),'这个草稿需要保留');
  await syncPanel.screenshot({path:'artifacts/synced-sidebar-principle.png',fullPage:true});
  await bpe.screenshot({ path: 'artifacts/pet-bubble.png', fullPage: true });
  await shadowCall(bpe, "const input=this.querySelector('.bubble-form input');input.value='那有什么代价？';this.querySelector('.bubble-form').requestSubmit();");
  await waitShadow(bpe, "return this.querySelector('.bubble-footer button:last-child').hidden;");
  const latestBpeRequest = requests.filter(r => r.tools?.length && r.messages[1]?.content.includes('那有什么代价')).at(-1);
  assert.ok(JSON.parse(latestBpeRequest.messages[1].content).recentConversation.length >= 1, 'bubble follow-up retains the current question thread');
  await syncPanel.waitForFunction(()=>document.querySelectorAll('#conversation .turn[data-turn-id]').length===3);
  assert.equal(await syncPanel.locator('#conversation .turn').first().getAttribute('data-preserve-probe'),'live');
  // Atomic appends/patches from two extension contexts preserve both messages and legacy records.
  const storageUrl=`chrome-extension://${id}/test-storage.js`;
  const storageActor=await context.newPage();await storageActor.goto(`chrome-extension://${id}/options.html`);
  await Promise.all([syncPanel.evaluate(async url=>{const api=await import(url);await api.appendTurn('concurrent-test',{question:'A',answer:'one',citations:[]});},storageUrl),
    storageActor.evaluate(async url=>{const api=await import(url);await api.appendTurn('concurrent-test',{question:'B',answer:'two',citations:[]});},storageUrl)]);
  const concurrent=await syncPanel.evaluate(async url=>{const api=await import(url);const before=await api.loadThread('concurrent-test');await Promise.all([api.appendTurn('concurrent-test',{question:'C',answer:'three',citations:[]}),api.patchTurn('concurrent-test',before[0].id,{answer:'updated',interactions:{value:3}})]);return api.loadThread('concurrent-test');},storageUrl);
  assert.deepEqual(new Set(concurrent.map(t=>t.question)),new Set(['A','B','C']));assert.ok(concurrent.some(t=>t.answer==='updated'));
  const migrated=await storageActor.evaluate(async url=>{
    await new Promise((resolve,reject)=>{const r=indexedDB.open('reading-pet',2);r.onsuccess=()=>{const db=r.result,tx=db.transaction('threads','readwrite');tx.objectStore('threads').put({id:'legacy-test',turns:[{question:'旧问题',answer:'旧答案',citations:[]}]});tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error);};r.onerror=()=>reject(r.error);});
    const api=await import(url),legacy=(await api.loadThread('legacy-test'))[0];
    await Promise.all([api.patchTurn('legacy-test',legacy.id,{answer:'更新后的旧答案'}),api.appendTurn('legacy-test',{question:'新问题',answer:'新答案',citations:[]})]);return api.loadThread('legacy-test');
  },storageUrl);
  assert.equal(migrated.length,2);assert.equal(migrated.find(t=>t.question==='旧问题').answer,'更新后的旧答案');

  // Do not replace an in-flight sidebar response when an external turn arrives; sync after stopping it.
  const activeSnapshot=await worker.evaluate(tabId=>chrome.tabs.sendMessage(tabId,{type:'GET_PAGE'}),bpeId);
  const activeKey=await syncPanel.evaluate(async ({url,page})=>(await import(url)).topicKey(page),{url:storageUrl,page:activeSnapshot.page});
  shouldHang=true;await syncPanel.locator('#question').fill('测试处理中同步');await syncPanel.locator('#send').click();await syncPanel.waitForFunction(()=>!document.querySelector('#cancel').hidden);
  await syncPanel.locator('#question').fill('生成过程中输入的新草稿');
  await storageActor.evaluate(async ({url,key})=>(await import(url)).appendTurn(key,{question:'另一端完成的气泡',answer:'这条解释应当在当前请求结束后出现。',citations:[],scope:'article',surface:'bubble',depth:'brief'}),{url:storageUrl,key:activeKey});
  assert.ok(!await syncPanel.locator('#cancel').isHidden(),'incoming update does not stop the sidebar request');
  await syncPanel.locator('#cancel').click();await syncPanel.waitForFunction(()=>document.querySelector('#conversation').textContent.includes('另一端完成的气泡')&&document.querySelector('#cancel').hidden);shouldHang=false;
  assert.equal(await syncPanel.locator('#question').inputValue(),'生成过程中输入的新草稿');
  assert.equal(await syncPanel.locator('#conversation .turn[data-turn-id]').count(),4);
  // A new selection in the same article follows the bubble's new topic without a manual refresh.
  await bpe.evaluate(()=>{const el=[...document.querySelectorAll('p')].find(p=>p.textContent.startsWith('BPE 训练')),range=document.createRange();range.selectNodeContents(el);getSelection().removeAllRanges();getSelection().addRange(range);el.dispatchEvent(new PointerEvent('pointerup',{bubbles:true}));});
  await shadowCall(bpe,"this.querySelector('.ask').click();");
  await waitShadow(bpe,"return this.querySelector('.bubble-footer button:last-child').hidden;");
  await syncPanel.waitForFunction(()=>document.querySelector('#selection-text').textContent.startsWith('BPE 训练')&&document.querySelectorAll('#conversation .turn[data-turn-id]').length===1);
  assert.equal(await syncPanel.locator('#question').inputValue(),'生成过程中输入的新草稿');
  await storageActor.close();
  await shadowCall(bpe, "this.querySelector('.bubble-footer button:nth-child(2)').click();");
  const teachPanel = syncPanel;
  const beforeKnowledgeOpen=requests.length;
  await teachPanel.waitForFunction(()=>!document.querySelector('#knowledge-view').hidden);
  const latestSelected=await worker.evaluate(tabId=>chrome.tabs.sendMessage(tabId,{type:'GET_PAGE'}),bpeId);
  assert.equal(await teachPanel.locator('#knowledge-topic').inputValue(),latestSelected.page.selection.text.slice(0,160));
  assert.equal(requests.length,beforeKnowledgeOpen,'opening the knowledge module does not generate a lesson');
  assert.equal(await teachPanel.locator('#depth').inputValue(),'example','knowledge entry preserves selected reading mode');
  // Reproduce the reported problem in a real sidebar request, then exercise explicit corrections.
  const embedding = await context.newPage(); embedding.on('pageerror', e => errors.push(e.message));
  await embedding.goto(`${origin}/embedding`);
  const { targetInfos: embeddingTargets } = await cdp.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }] });
  await cdp.send('Extensions.triggerAction', { id, targetId: embeddingTargets.find(t => t.url.endsWith('/embedding')).targetId });
  await embedding.waitForSelector('[data-reading-pet]');
  await embedding.evaluate(() => { const el=document.querySelector('#selection'), range=document.createRange();range.selectNodeContents(el);getSelection().removeAllRanges();getSelection().addRange(range);el.dispatchEvent(new PointerEvent('pointerup',{bubbles:true})); });
  const embeddingId = await worker.evaluate(async () => (await chrome.tabs.query({ active:true,currentWindow:true }))[0].id);
  const embeddingPanel = await context.newPage(); embeddingPanel.on('pageerror',e=>errors.push(e.message));
  await embeddingPanel.addInitScript(tabId=>{if(chrome?.tabs)chrome.tabs.query=async()=>[{id:tabId}];},embeddingId);
  await embeddingPanel.setViewportSize({width:410,height:1000});await embeddingPanel.goto(`chrome-extension://${id}/panel.html`);
  await embeddingPanel.waitForFunction(()=>document.querySelector('#selection-text').textContent.includes('B×T×384'));
  assert.equal(await embeddingPanel.locator('#depth').inputValue(),'context');
  await embeddingPanel.locator('#depth').selectOption('example');
  const embeddingStart=requests.length;
  await embeddingPanel.locator('#question').fill('B×T×384是啥');await embeddingPanel.locator('#send').click();
  await embeddingPanel.waitForFunction(()=>document.querySelector('#status').textContent.includes('这次理解已留下'));
  const embeddingRequests=requests.slice(embeddingStart);
  assert.ok(embeddingRequests.some(r=>r.messages[0].content.includes('解释质检编辑')&&JSON.parse(r.messages[1].content).reason==='missing_mechanism'));
  assert.match(await embeddingPanel.locator('.turn .answer').last().textContent(),/因为.*所以/);
  assert.match(await embeddingPanel.locator('.turn .answer').last().textContent(),/2×3×384/);
  assert.ok(!(await embeddingPanel.locator('.turn .answer').last().textContent()).includes('输出投影'),'does not switch the topic to weight tying');
  await embeddingPanel.screenshot({path:'artifacts/embedding-teaching.png',fullPage:true});
  await embeddingPanel.getByRole('button',{name:'符号已懂，讲原理',exact:true}).last().click();
  await embeddingPanel.waitForFunction(()=>document.querySelectorAll('.turn').length===2 && document.querySelector('#status').textContent.includes('这次理解已留下'));
  const corrected=requests.filter(r=>r.messages[0].content.includes('本次解释模式')&&!r.messages[0].content.includes('解释质检编辑')&&r.messages[1]?.content.includes('符号含义我已懂')).at(-1);
  const correctedPacket=JSON.parse(corrected.messages[1].content);
  assert.equal(correctedPacket.depth,'example');assert.equal(correctedPacket.learningPlan.focusHint,'mechanism');assert.equal(correctedPacket.learningPlan.mastery,'unverified');
  assert.equal(await embeddingPanel.locator('.turn').last().getAttribute('data-depth'),'example');
  await embeddingPanel.reload();await embeddingPanel.waitForFunction(()=>document.querySelectorAll('.turn').length===2);
  assert.match(await embeddingPanel.locator('.turn .answer-mode').last().textContent(),/原理＋例子/);
  const beforeCheck=requests.length;
  await embeddingPanel.getByRole('button',{name:'用小题检验',exact:true}).last().click();
  await embeddingPanel.waitForFunction(()=>document.querySelectorAll('.turn').length===3&&document.querySelector('#status').textContent.includes('这次理解已留下'));
  const checkPacket=JSON.parse(requests.slice(beforeCheck).find(r=>r.tools?.length).messages[1].content);
  assert.equal(checkPacket.learningPlan.focusHint,'check');assert.equal(checkPacket.depth,'brief');
  assert.ok(checkPacket.learningPlan.priorUserEvidence.some(e=>e.text.includes('我已懂')));
  assert.match(await embeddingPanel.locator('.turn .answer').last().textContent(),/请说出/);
  // Knowledge module: explicit start, four sections, independent thread, scoped follow-up and local note save.
  const readingCount=await embeddingPanel.locator('#conversation .turn').count(),beforeModule=requests.length;
  await embeddingPanel.locator('#knowledge-tab').click();
  await embeddingPanel.waitForFunction(()=>!document.querySelector('#knowledge-view').hidden);
  assert.equal(requests.length,beforeModule);
  await embeddingPanel.locator('#knowledge-topic').fill('Embedding输出形状');
  await embeddingPanel.locator('#knowledge-scope').selectOption('passage');
  await embeddingPanel.locator('#knowledge-start').click();
  await embeddingPanel.waitForFunction(()=>document.querySelectorAll('#knowledge-conversation .knowledge-turn').length===1);
  const knowledgePacket=JSON.parse(requests.at(-1).messages[1].content);
  assert.equal(knowledgePacket.module,'knowledge');assert.equal(knowledgePacket.knowledgeOverview,true);
  assert.equal(knowledgePacket.scope,'passage');assert.deepEqual(knowledgePacket.outline,[]);assert.deepEqual(knowledgePacket.recentConversation,[]);
  assert.equal(requests.at(-1).tools,undefined,'nearby-only knowledge module exposes no article or note tools');
  assert.deepEqual(await embeddingPanel.locator('#knowledge-conversation h2').allTextContents(),['定义','原理','例子','延伸']);
  assert.equal(await embeddingPanel.locator('#knowledge-conversation .knowledge-section-links button').count(),4);
  assert.equal(await embeddingPanel.locator('#conversation .turn').count(),readingCount,'knowledge does not append to reading chat');
  await embeddingPanel.getByRole('button',{name:'延伸',exact:true}).click();
  await embeddingPanel.screenshot({path:'artifacts/knowledge-module.png',fullPage:true});
  await embeddingPanel.getByRole('button',{name:'保存为理解笔记',exact:true}).click();
  await embeddingPanel.waitForFunction(()=>document.querySelector('#knowledge-status').textContent.includes('已保存完整讲解'));
  await embeddingPanel.locator('#notes-tab').click();await embeddingPanel.waitForFunction(()=>[...document.querySelectorAll('.note h2')].some(h=>h.textContent.includes('知识讲解 · Embedding输出形状')));
  const lessonNote=embeddingPanel.locator('.note').filter({hasText:'知识讲解 · Embedding输出形状'});assert.match(await lessonNote.textContent(),/延伸/);
  const beforeRestore=requests.length;
  await embeddingPanel.reload();await embeddingPanel.waitForFunction(()=>document.querySelector('#knowledge-topic').value==='Embedding输出形状');
  await embeddingPanel.locator('#knowledge-tab').click();await embeddingPanel.waitForFunction(()=>document.querySelectorAll('#knowledge-conversation .knowledge-turn').length===1);
  assert.equal(requests.length,beforeRestore,'restoring a lesson does not regenerate it');
  assert.equal(await embeddingPanel.locator('#knowledge-scope').inputValue(),'passage','restoring a lesson preserves the chosen reference scope');
  await embeddingPanel.locator('#knowledge-question').fill('只解释D是什么意思。');await embeddingPanel.locator('#knowledge-followup-send').click();
  await embeddingPanel.waitForFunction(()=>document.querySelectorAll('#knowledge-conversation .knowledge-turn').length===2);
  const followupPacket=JSON.parse(requests.at(-1).messages[1].content);assert.equal(followupPacket.knowledgeOverview,false);assert.ok(followupPacket.recentConversation.some(t=>t.question.includes('完整讲解')));
  assert.equal(await embeddingPanel.locator('#knowledge-conversation .knowledge-turn').last().locator('h2').count(),0,'follow-up need not repeat all four sections');
  await embeddingPanel.getByRole('button',{name:'保存为理解笔记',exact:true}).last().click();
  await embeddingPanel.waitForFunction(()=>document.querySelector('#knowledge-status').textContent.includes('已保存完整讲解'));
  await embeddingPanel.locator('#notes-tab').click();await embeddingPanel.waitForFunction(()=>[...document.querySelectorAll('.note')].some(n=>n.textContent.includes('知识讲解 · Embedding输出形状')&&n.textContent.includes('追问')));
  const mergedLesson=embeddingPanel.locator('.note').filter({hasText:'知识讲解 · Embedding输出形状'});
  assert.match(await mergedLesson.textContent(),/定义/);assert.match(await mergedLesson.textContent(),/延伸/);assert.match(await mergedLesson.textContent(),/D表示/);
  await embeddingPanel.locator('#knowledge-tab').click();
  await embeddingPanel.setViewportSize({width:320,height:900});assert.ok(await embeddingPanel.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await embeddingPanel.screenshot({path:'artifacts/knowledge-module-narrow.png',fullPage:true});
  shouldHang=true;await embeddingPanel.locator('#knowledge-question').fill('继续讲这个知识点');await embeddingPanel.locator('#knowledge-followup-send').click();
  await embeddingPanel.waitForFunction(()=>!document.querySelector('#knowledge-cancel').hidden);await embeddingPanel.locator('#knowledge-cancel').click();
  await embeddingPanel.waitForFunction(()=>document.querySelector('#knowledge-status').textContent.includes('已停止'));
  assert.equal(await embeddingPanel.locator('#knowledge-conversation .knowledge-turn').count(),2);shouldHang=false;
  const beforeStale=requests.length;await embedding.locator('#selection').evaluate(el=>{el.textContent+=' 这是网页修改。';});
  await embeddingPanel.locator('#knowledge-start').click();await embeddingPanel.waitForFunction(()=>document.querySelector('#knowledge-status').textContent.includes('网页内容已变化'));
  assert.equal(requests.length,beforeStale,'knowledge module rejects stale page before calling the model');
  let websiteSmoke = null;
  if (siteFixture) {
    const site = await context.newPage(); await site.goto(`${origin}/site-article`);
    const { targetInfos: siteTargets } = await cdp.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }] });
    await cdp.send('Extensions.triggerAction', { id, targetId: siteTargets.find(t => t.url.endsWith('/site-article')).targetId });
    await site.waitForSelector('[data-reading-pet]');
    const siteId = await worker.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id);
    const data = await worker.evaluate(tabId => chrome.tabs.sendMessage(tabId, { type: 'GET_PAGE' }), siteId);
    assert.ok(data.page.blocks.length > 0);
    assert.ok(!data.page.blocks.some(b => b.text === '这篇文章里'));
    websiteSmoke = { title: data.page.title, passages: data.page.blocks.length, characters: data.page.blocks.reduce((sum, b) => sum + b.text.length, 0) };
  }
  // Cross-context note merges read the latest value while holding one origin-wide lock.
  const mergeNote = async (context, label) => context.evaluate(async ({url,label}) => {
    const api = await import(url);
    const signal = new AbortController().signal;
    await api.updateNote('note-race', async previous => {
      await new Promise(resolve => setTimeout(resolve, 60));
      return {id:previous?.id||crypto.randomUUID(),topicKey:'note-race',title:'并发笔记',url:'https://example.org',pageVersion:'v',selection:null,summary:(previous?.summary||'')+label,questions:[...(previous?.questions||[]),label],sources:[],updatedAt:new Date().toISOString(),previous:previous?.summary||null};
    }, signal);
    return api.listNotes();
  }, {url:storageUrl,label});
  const noteActor=await context.newPage();await noteActor.goto(`chrome-extension://${id}/options.html`);
  await Promise.all([mergeNote(syncPanel,'A'),mergeNote(noteActor,'B')]);
  const raceNotes=await noteActor.evaluate(async url=>(await import(url)).listNotes(),storageUrl);
  const merged=raceNotes.filter(n=>n.topicKey==='note-race');
  assert.equal(merged.length,1);assert.deepEqual(new Set(merged[0].questions),new Set(['A','B']));
  assert.equal(merged[0].summary.length,2);await noteActor.close();

  const selectionPage=await context.newPage();await selectionPage.goto(`${origin}/article?selection-refresh`);
  const {targetInfos:selectionTargets}=await cdp.send('Target.getTargets',{filter:[{type:'tab',exclude:false}]});
  await cdp.send('Extensions.triggerAction',{id,targetId:selectionTargets.find(t=>t.url.includes('selection-refresh')).targetId});
  await selectionPage.waitForSelector('[data-reading-pet]');
  const selectionTabId=await worker.evaluate(async()=> (await chrome.tabs.query({active:true,currentWindow:true}))[0].id);
  const selectText=async selector=>selectionPage.locator(selector).evaluate(el=>{const range=document.createRange();range.selectNodeContents(el);getSelection().removeAllRanges();getSelection().addRange(range);el.dispatchEvent(new PointerEvent('pointerup',{bubbles:true}));});
  await selectText('#selection');
  const selectionPanel=await context.newPage();await selectionPanel.addInitScript(tabId=>{chrome.tabs.query=async()=>[{id:tabId}];},selectionTabId);
  await selectionPanel.goto(`chrome-extension://${id}/panel.html`);
  await selectionPanel.waitForFunction(()=>document.querySelector('#selection-text').textContent.includes('权重矩阵'));
  await selectText('#definition');
  await selectionPanel.locator('#question').fill('解释刚换的新选区');await selectionPanel.locator('#send').click();
  await selectionPanel.waitForFunction(()=>document.querySelector('#status').textContent.includes('这次理解已留下'));
  const selectionPacket=JSON.parse(requests.findLast(r=>r.messages[1]?.content.includes('"task":"解释刚换的新选区"')).messages[1].content);
  assert.ok(selectionPacket.selection.text.includes('本文采用列向量约定'));
  assert.deepEqual(selectionPacket.recentConversation,[],'a new selection loads its own thread');
  await selectionPanel.locator('#clear-selection').click();
  await selectionPanel.locator('#question').fill('解释主动清除选区后的文章');await selectionPanel.locator('#send').click();
  await selectionPanel.waitForFunction(()=>document.querySelector('#status').textContent.includes('这次理解已留下'));
  const clearedPacket=JSON.parse(requests.findLast(r=>r.messages[1]?.content.includes('"task":"解释主动清除选区后的文章"')).messages[1].content);
  assert.equal(clearedPacket.selection,null);
  await selectionPanel.close();await selectionPage.close();
  assert.deepEqual(errors, []);
  const result = { passed: ['toolbar action and activeTab injection', 'content-script key isolation', 'article extraction', 'selection anchors', 'repeated passage IDs', 'tool call continuation', 'formula skill routing', 'context preview', 'source jump', 'note merge', 'note edit and undo', 'session restore', 'passage scope', 'request cancellation', 'stale page rejection', 'settings persistence', 'diagnostic export and redaction', 'diagnostic logging toggle', 'bubble execution with live sidebar synchronization', 'one-pass answer review', 'brief answer preserves conditions', 'bubble follow-up context', 'bubble opens independent knowledge module without model calls', 'contextual sidebar default distinct from brief bubble', 'explicitly selected embedding principle mode repaired into mechanism and example', 'explicit explanation correction and restored mode', 'opt-in understanding check with scoped user evidence', 'four-part independent knowledge module', 'knowledge reference scope and no background generation', 'knowledge note save and session restore', 'targeted knowledge follow-up and cancellation', 'selected mode rewrites previous bubble with visible principle and example', 'live sync preserves unsent drafts and selected mode', 'atomic concurrent thread append and partial update', 'sync waits for sidebar request completion', 'new bubble selection follows into sidebar automatically', 'sidebar refreshes selection and topic before sending', 'explicit clear selection survives preflight', 'cross-context note merge serialization'], mockModelRequests: requests.length, websiteSmoke, artifacts: ['reading-panel.png', 'article-pet.png', 'notes-panel.png', 'model-settings.png', 'context-preview.png', 'pet-bubble.png', 'embedding-teaching.png', 'knowledge-module.png', 'knowledge-module-narrow.png', 'synced-sidebar-principle.png'] };
  await writeFile('artifacts/browser-results.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { await context.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(temp, { recursive: true, force: true }); }
