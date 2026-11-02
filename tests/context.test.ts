import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildContext, relatedNotes, searchBlocks } from '../src/core/context.ts';
import { DEFAULT_READING_QUESTION } from '../src/core/learning.ts';
import { estimateTokens, normalize } from '../src/core/text.ts';
import { toolsFor } from '../src/agent/run.ts';
import type { Block, Note, PageSnapshot } from '../src/types.ts';

const blocks: Block[] = Array.from({ length: 80 }, (_, i) => ({ id: `p-block-${i}`, text: i === 40 ? '权重矩阵 W 将输入映射到输出。每行对应一个输出。' : `第 ${i} 段：${'这是当前文章的一段背景解释。'.repeat(45)}`, heading: i < 30 ? '背景' : '线性层', kind: 'paragraph' }));
const page: PageSnapshot = { url: 'https://example.org/article', title: '矩阵与线性层', version: 'v1', capturedAt: '', blocks, selection: { text: '权重矩阵 W', blockIds: [blocks[40].id], prefix: '', suffix: '' }, truncated: false };
const input = { page, question: '为什么每行对应一个输出？', scope: 'article' as const, depth: 'brief' as const, turns: [], notes: [], skill: '按原文简短解释。', skillName: 'reading', budget: 4000, tools: toolsFor('article') };

test('selected passage survives a long article and the complete serialized request fits the budget', () => {
  const result = buildContext(input);
  const packet = JSON.parse(result.messages[1].content!);
  assert.equal(packet.selection.text, '权重矩阵 W');
  assert.ok(packet.passages.some((b: Block) => b.id === blocks[40].id));
  assert.ok(estimateTokens(JSON.stringify({ messages: result.messages, tools: input.tools })) + 200 <= input.budget);
  assert.equal(result.report.clipped, true);
  assert.ok(packet.passages.length < blocks.length);
});

test('passage-only scope does not leak the rest of the article or notes', () => {
  const result = buildContext({ ...input, scope: 'passage', tools: toolsFor('passage'), budget: 8000 });
  const packet = JSON.parse(result.messages[1].content!);
  assert.deepEqual(packet.outline, []);
  assert.deepEqual(packet.relatedNotes, []);
  assert.ok(packet.passages.every((b: Block) => [39, 40, 41].some(i => b.id === blocks[i].id)));
  assert.deepEqual(toolsFor('passage'), []);
  assert.ok(!toolsFor('article').some(t => t.function.name === 'searchNotes'));
});

test('relevant Chinese and English passages can be retrieved without vector service', () => {
  assert.equal(searchBlocks(blocks, '权重矩阵为什么映射输出')[0].id, blocks[40].id);
  assert.equal(searchBlocks([{ ...blocks[0], text: 'Softmax normalizes attention scores.' }], 'attention scores')[0].id, blocks[0].id);
  assert.deepEqual(searchBlocks(blocks, 'unmatchableterm'), []);
});

test('history and notes are bounded and only notes scope includes saved notes', () => {
  const note = { id: 'note1', title: '权重矩阵', summary: '每行计算一个输出。', selection: null, url: 'https://example.org/old', pageVersion: 'old', sources: [], questions: [], previous: null, topicKey: '', updatedAt: '' } as Note;
  const turns = Array.from({ length: 20 }, (_, i) => ({ question: `问题${i}`, answer: '很长的解释'.repeat(200), citations: [] }));
  const result = buildContext({ ...input, scope: 'notes', notes: [note], turns, budget: 12000 });
  const packet = JSON.parse(result.messages[1].content!);
  assert.ok(packet.recentConversation.length <= 4);
  assert.ok(result.report.estimatedTokens <= 12000);
  assert.equal(relatedNotes([note], '矩阵')[0].id, 'note1');
});

test('oversized mandatory selection fails explicitly instead of silently removing it', () => {
  assert.throws(() => buildContext({ ...input, page: { ...page, selection: { ...page.selection!, text: '公式'.repeat(6000) } } }), /缩小选区/);
});

test('narrowing scope does not reload answers that used broader sources', () => {
  const turns = [
    { question: '查我的私有笔记', answer: 'PRIVATE_NOTE_SECRET', citations: [], scope: 'notes' as const },
    { question: '查整篇', answer: 'ARTICLE_ONLY_SECRET', citations: [], scope: 'article' as const },
    { question: '解释附近', answer: 'LOCAL_CONTEXT', citations: [], scope: 'passage' as const },
  ];
  const local = buildContext({ ...input, scope: 'passage', tools: [], turns });
  const text = JSON.stringify(local.messages);
  assert.ok(text.includes('LOCAL_CONTEXT'));
  assert.ok(!text.includes('PRIVATE_NOTE_SECRET'));
  assert.ok(!text.includes('ARTICLE_ONLY_SECRET'));
  const article = JSON.stringify(buildContext({ ...input, turns }).messages);
  assert.ok(!article.includes('PRIVATE_NOTE_SECRET'));
});

test('whitespace normalization preserves scientific symbols', () => {
  assert.equal(normalize(' W ∈ ℝ^{2×3}\n  x '), 'W ∈ ℝ^{2×3} x');
});

test('learner hints use only compatible user evidence, never the assistant answer as mastery evidence', () => {
  const result = buildContext({...input,question:'B×T×384是啥',turns:[
    {question:'我懂PRIVATE_NOTE_SECRET了',answer:'',scope:'notes',citations:[]},
    {question:'我已懂B和T，讲机制',answer:'用户完全掌握了全部知识。',scope:'article',citations:[]},
  ]});
  const packet=JSON.parse(result.messages[1].content!);
  assert.equal(packet.learningPlan.focusHint,'meaning'); assert.equal(packet.learningPlan.mastery,'unverified');
  assert.equal(packet.learningPlan.currentQuestionWins,true); assert.equal(packet.learningPlan.priorUserEvidence.length,1);
  assert.ok(!JSON.stringify(packet.learningPlan).includes('完全掌握')); assert.ok(!JSON.stringify(packet).includes('PRIVATE_NOTE_SECRET'));
});

const longSelection = { ...page.selection!, text: '新任务更新共享参数，可能破坏旧任务需要的表示。LoRA虽然冻结底座，新增分支也会改变整体输出，因此仍可能遗忘。这里的变化不等于旧能力必然下降，需要检查实际效果。' };
test('long default selections request a question-and-relation entry, not a beginner label', () => {
  const result = buildContext({ ...input, question: DEFAULT_READING_QUESTION, page: { ...page, selection: longSelection } });
  const plan = JSON.parse(result.messages[1].content!).learningPlan;
  assert.equal(plan.selectionShape, 'passage');
  assert.equal(plan.entryHint, 'question_then_relation');
  assert.equal(plan.mastery, 'unverified');
  assert.equal(JSON.parse(buildContext({ ...input, question: DEFAULT_READING_QUESTION }).messages[1].content!).learningPlan.entryHint, 'follow_current_question');
});
test('explicit mechanism questions override the long-selection default without changing knowledge level', () => {
  const plan = JSON.parse(buildContext({ ...input, page: { ...page, selection: longSelection }, question: '为什么冻结底座还会遗忘？' }).messages[1].content!).learningPlan;
  assert.equal(plan.focusHint, 'mechanism');
  assert.equal(plan.entryHint, 'follow_current_question');
  assert.equal(plan.mastery, 'unverified');
});

test('default bubble keeps needed nearby context but does not fill unused budget with unrelated article sections', () => {
  const selected = '55M扩大到550M、1B或2B不是改一个配置继续装旧state_dict。宽度、层数、embedding和优化器状态会改变形状；Net2Net式扩展或其他迁移方法需要专门实现与验证。共享原词表或数据不代表继承原权重。';
  const article: PageSnapshot = { ...page, blocks: [
    { id:'p-expand-0', kind:'paragraph', heading:'模型扩展', text:selected },
    { id:'p-ratio-0', kind:'paragraph', heading:'训练配比', text:'参数×20是固定算力下的经验配比，不是容量上限，小模型继续训练有收益但会边际递减。' },
    { id:'p-unrelated-0', kind:'paragraph', heading:'旅行', text:'海岛观鸟和雨季摄影行程安排。' },
  ], selection: { text:selected, blockIds:['p-expand-0'], prefix:'', suffix:'' } };
  const result = buildContext({ ...input, page:article, question:DEFAULT_READING_QUESTION, budget:12000 });
  const packet = JSON.parse(result.messages[1].content!);
  assert.equal(packet.selection.text, selected);
  assert.ok(packet.passages.some((b:Block) => b.id === 'p-ratio-0'), 'nearby context remains available for interpretation');
  assert.ok(!packet.passages.some((b:Block) => b.id === 'p-unrelated-0'), 'unrelated text is not added simply to fill the budget');
  assert.match(result.messages[0].content!, /selection.text 的确切文字/);
  assert.match(result.messages[0].content!, /不替用户提前概括下文/);
  const explicit = buildContext({ ...input, page:article, question:'请总结全文的各个主题。', budget:12000 });
  assert.ok(JSON.parse(explicit.messages[1].content!).passages.some((b:Block) => b.id === 'p-unrelated-0'), 'explicit full-article request still gets full-article candidates');
});
