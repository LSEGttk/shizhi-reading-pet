import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runReading } from '../src/agent/run.ts';
import { DEFAULT_SETTINGS } from '../src/storage/local.ts';
import type { ChatMessage, Depth, PageSnapshot, Turn } from '../src/types.ts';

const page: PageSnapshot = { url: 'https://example.org/bpe', title: 'BPE', version: 'v1', capturedAt: '', truncated: false, blocks: [{ id: 'p-bpe-0', kind: 'paragraph', heading: '取舍', text: '合并高频片段，以更大的词表换更短的序列。只有基础符号覆盖完整，才能保证表示所有输入。' }], selection: { text: 'BPE 的取舍', blockIds: ['p-bpe-0'], prefix: '', suffix: '' } };
async function scenario(outputs: (string | Error)[], depth: Depth = 'brief', options: { question?: string; page?: PageSnapshot; turns?: Turn[] } = {}) {
  const originalFetch = globalThis.fetch;
  const originalChrome = (globalThis as unknown as { chrome?: unknown }).chrome;
  const requests: { messages: ChatMessage[] }[] = [], displayed: string[] = [];
  (globalThis as unknown as { chrome: unknown }).chrome = { runtime: { getURL: (path: string) => `https://extension.example/${path}`, sendMessage: async () => ({}) }, permissions: { contains: async () => true } };
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://extension.example/skills/')) return new Response(readFileSync(new URL(`../${String(url).replace('https://extension.example/', '')}`, import.meta.url), 'utf8'));
    const body = JSON.parse(String(init?.body)); requests.push(body);
    const next = outputs[requests.length - 1];
    if (next instanceof Error) throw next;
    assert.equal(typeof next, 'string', 'no unbounded review loop');
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: next }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
  };
  try {
    const result = await runReading({ page: options.page || page, question: options.question || '为什么这样设计？', scope: 'article', depth, turns: options.turns || [], notes: [], settings: { ...DEFAULT_SETTINGS, model: 'mock', tools: false }, signal: new AbortController().signal, onText: text => displayed.push(text), onStatus: () => {}, onContext: () => {} });
    return { result, requests, displayed };
  } finally { globalThis.fetch = originalFetch; (globalThis as unknown as { chrome?: unknown }).chrome = originalChrome; }
}
test('brief explanation is reviewed at most once, preserves references and hides the draft', async () => {
  const draft = '核心含义：' + '这是原文的冗长复述。'.repeat(30);
  const concise = 'BPE 给常见片段设快捷键，以词表容量换短序列；能否覆盖罕见输入，取决于基础符号是否齐全。[p-bpe-0]';
  const { result, requests, displayed } = await scenario([draft, concise]);
  assert.equal(requests.length, 2);
  assert.ok(requests[1].messages[0].content?.includes('解释质检编辑'));
  assert.equal(result.answer, concise);
  assert.deepEqual(result.sources.map(b => b.id), ['p-bpe-0']);
  assert.deepEqual(displayed, [concise]);
});
test('a useful short answer has no mandatory extra request; sidebar loads the teaching rules', async () => {
  const short = '用更大的词典，换更短的表示。';
  assert.equal((await scenario([short])).requests.length, 1);
  const teaching = await scenario(['### 原理\n因为常见片段一次就能表示，所以序列变短。\n### 例子\n例如，原本三个字符分成三个符号，合并后用一个符号表示同一片段。'], 'example');
  assert.equal(teaching.requests.length, 1);
  assert.ok(teaching.requests[0].messages[0].content?.includes('像一本写得清楚的教科书'));
});
test('optional editing failure retains the complete draft rather than cutting it off', async () => {
  const draft = '说明'.repeat(100);
  const { result, requests } = await scenario([draft, new TypeError('Failed to fetch')]);
  assert.equal(requests.length, 2);
  assert.equal(result.answer, draft);
});

const embedding: PageSnapshot = { ...page, title: 'Embedding', blocks: [
  { id:'p-embed-0', heading:'2. Embedding：编号变成向量', kind:'paragraph', text:'输入 token ID 的形状为 B×T。词嵌入表形状为词表大小×384。每个位置按照 ID 取对应向量，输出形状为 B×T×384。' },
  { id:'p-share-0', heading:'7. 参数量', kind:'paragraph', text:'输入嵌入表和输出投影共用权重，可以节省参数。' },
], selection:{text:'B×T×384',blockIds:['p-embed-0'],prefix:'输出形状为',suffix:''} };
const workedEmbedding = '### 原理\n这里描述的是一次查表后的输出。输入中每个样本的每个位置原本只有一个编号，因为查表会把这个编号换成384个数，所以原来的样本轴和位置轴保留，再增加向量轴，得到B×T×384。[p-embed-0]\n### 例子\n例如假设B=2、T=3，就有6个编号；每个编号取出384个数，按原有位置摆放成2×3×384。词表参数是另一张表，不等同于本次输出。';
test('sidebar repairs a definition-only response into contextual mechanism plus worked example', async () => {
  const result = await scenario(['B是样本数，T是位置数，384是向量宽度。', workedEmbedding], 'example', { page: embedding, question:'B×T×384是啥' });
  assert.equal(result.requests.length,2);
  const packet = JSON.parse(result.requests[0].messages[1].content!);
  assert.deepEqual(packet.focusPassageIds,['p-embed-0']); assert.equal(packet.learningPlan.focusHint,'meaning');
  const repair = JSON.parse(result.requests[1].messages[1].content!);
  assert.equal(repair.reason,'missing_mechanism'); assert.equal(repair.depth,'example'); assert.equal(repair.learningPlan.mastery,'unverified');
  assert.match(result.requests[0].messages[0].content!,/输入\/前提/);
  assert.match(result.result.answer,/因为.*所以/); assert.match(result.result.answer,/B=2、T=3/);
  assert.deepEqual(result.result.sources.map(b=>b.id),['p-embed-0']);
});
test('sidebar repairs a concrete example that never explains the mechanism', async () => {
  const draft = 'B是样本数，T是位置数，384是宽度。例如B=2、T=3，输出形状就是2×3×384。';
  const result = await scenario([draft,workedEmbedding],'example',{page:embedding,question:'B和T我懂了，但这个形状为什么这样？'});
  assert.equal(JSON.parse(result.requests[1].messages[1].content!).reason,'missing_mechanism');
});
test('sidebar repairs missing examples and carries the user correction into the repair request', async () => {
  const draft = '因为每个位置的ID被换成向量，所以样本和位置轴保留，在末尾增加一个向量轴。';
  const correction = 'B和T我已懂，请直接讲原理。';
  const result = await scenario([draft,workedEmbedding],'example',{page:embedding,question:'为什么要增加这一个维度？',turns:[{question:correction,answer:'模型讲过不代表学会。',citations:[],scope:'article'}]});
  const repair = JSON.parse(result.requests[1].messages[1].content!);
  assert.equal(repair.reason,'missing_example'); assert.equal(repair.learningPlan.priorUserEvidence[0].text,correction);
  assert.equal(repair.learningPlan.mastery,'unverified');
});
test('bubble removes a redundant opening without another model call, preserving math and citations', async () => {
  const text = '关键在：每个位置的ID换成384个数，样本和位置仍保留，所以是B×T×384。[p-embed-0]';
  const result=await scenario([text],'brief',{page:embedding,question:'这是什么？'});
  assert.equal(result.requests.length,1); assert.ok(!result.result.answer.startsWith('关键')); assert.match(result.result.answer,/B×T×384/);
  assert.deepEqual(result.result.sources.map(b=>b.id),['p-embed-0']);
});
test('brief instructions quoted during handoff do not suppress the sidebar teaching requirements', async () => {
  const result = await scenario(['因为用词表容量换序列长度，所以要取舍。', '因为常见片段能用一个符号表示，所以序列更短。例如原本三个符号合成一个，长度从3变成1。'],'example',{question:'请结合本段讲清运作原理并举例。\n此前的问题（仅作背景）：请简短回答BPE是什么。'});
  assert.equal(result.requests.length,2); assert.equal(JSON.parse(result.requests[1].messages[1].content!).reason,'missing_example');
});

test('default contextual brief answer can explain meaning without a mandatory mechanism or example', async () => {
  const answer = '这里的B是本批文本条数，T是每条的位置数；384是每个位置向量中的数值个数。这是在描述本段输出的排列尺寸。[p-embed-0]';
  const result = await scenario([answer], 'brief', { page:embedding, question:'结合附近原文，解释选中内容在这里指什么、表达什么。' });
  assert.equal(result.requests.length,1);
  assert.equal(result.result.answer,answer);
  assert.ok(!result.requests[0].messages[0].content!.includes('像一本写得清楚的教科书'));
  assert.match(result.requests[0].messages[0].content!,/原理和设计取舍留给用户明确追问/);
});

test('ordinary contextual sidebar uses its own rules and is not capped by bubble brevity',async()=>{
 const answer='这里的B表示本批文本条数，T表示每条的位置数，384表示每个位置有多少个数。\n这三个轴描述本次输入查表后取出的向量排列；它们不在表示参数表的词数。';
 const result=await scenario([answer],'context',{page:embedding,question:'这在本段是什么意思？'});
 assert.equal(result.requests.length,1);assert.equal(result.result.report.depth,'context');
 assert.match(result.requests[0].messages[0].content!,/不受气泡40～100字限制/);
 assert.ok(!result.requests[0].messages[0].content!.includes('像一本写得清楚的教科书'));
});
test('contextual sidebar checks exact reuse of a prior bubble rather than silently presenting the same short answer',async()=>{
 const brief='这里指本次输入查表后取出的向量排列。';
 const expanded='本段输入的每个位置原本是一个编号，取出的向量按原样本顺序和位置排列。B和T描述原来的分组，384说明每个位置放多少个数；它们共同描述本次输出，而不是参数表的大小。';
 const result=await scenario([brief,expanded],'context',{page:embedding,question:'讲清上下文关系',turns:[{question:'这是什么',answer:brief,citations:[],scope:'article',depth:'brief',surface:'bubble'}]});
 assert.equal(result.requests.length,2);assert.equal(JSON.parse(result.requests[1].messages[1].content!).reason,'repeated_brief');assert.equal(result.result.answer,expanded);
});

test('long-selection guidance survives optional review, while useful plain-language paraphrase is accepted', async () => {
  const selected = { ...page, selection: { ...page.selection!, text: '合并高频片段能缩短序列，但需要把新片段保存在词表中。词表扩大后，每个条目对应的向量也会占用参数，因此要在序列长度和词表容量之间做选择。' } };
  const question = '结合附近原文，帮我理解选中的内容。';
  const answer = '这段在解释：为什么不把所有片段都合成一个符号？因为表示越省长度，词典往往就越大，需要在两边找平衡。';
  const clean = await scenario([answer], 'brief', { page: selected, question });
  assert.equal(clean.requests.length, 1);
  assert.equal(JSON.parse(clean.requests[0].messages[1].content!).learningPlan.entryHint, 'question_then_relation');
  const repaired = await scenario(['核心含义：' + '这是冗长的解释。'.repeat(30), answer], 'brief', { page: selected, question });
  const packet = JSON.parse(repaired.requests[1].messages[1].content!);
  assert.equal(packet.learningPlan.entryHint, 'question_then_relation');
  assert.match(repaired.requests[1].messages[0].content!, /允许有帮助的白话转述/);
  assert.equal(repaired.result.answer, answer);
});

test('answer repair receives the same selected-text boundary even when valid adjacent sources are available', async () => {
  const selected = '55M扩大到550M、1B或2B不是改一个配置继续装旧state_dict。宽度、层数、embedding和优化器状态会改变形状；Net2Net式扩展或其他迁移方法需要专门实现与验证。共享原词表或数据不代表继承原权重。';
  const article: PageSnapshot = { ...page, blocks:[
    {id:'p-expand-0',kind:'paragraph',heading:'模型扩展',text:selected},
    {id:'p-ratio-0',kind:'paragraph',heading:'训练配比',text:'参数×20是固定算力下的经验配比，不是容量上限，小模型继续训练有收益但会边际递减。'},
  ], selection:{text:selected,blockIds:['p-expand-0'],prefix:'',suffix:''} };
  const draft = '这里在澄清两个误区：模型从55M扩到550M、1B或2B，不能只改配置继续装旧state_dict，因为宽度、层数、embedding和优化器状态都会改变张量形状；共享词表或数据也不等于继承原权重。[p-expand-0]“参数×20”是固定算力下的经验配比，不是容量上限，小模型继续训练有收益但会边际递减。[p-ratio-0]';
  const focused = '这段在回答：小模型学到的东西能直接搬进大模型吗？旧state_dict保存的是按旧结构排列的参数，新结构尺寸变了，不能原样套用，需要专门迁移。[p-expand-0]';
  const result = await scenario([draft,focused], 'brief', { page:article, question:'结合附近原文，解释选中的这一段。' });
  assert.equal(result.requests.length,2);
  for (const request of result.requests) assert.match(request.messages[0].content!, /不替用户提前概括下文/);
  assert.match(result.requests[1].messages[0].content!, /引用有效只证明有出处/);
  assert.equal(JSON.parse(result.requests[1].messages[1].content!).selection.text,selected);
  assert.deepEqual(result.result.sources.map(s=>s.id),['p-expand-0']);
});
