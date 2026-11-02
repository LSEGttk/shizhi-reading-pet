import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanBriefOpening, hasMechanism, reviewReason, visibleAnswer } from '../src/core/quality.ts';
import type { Block } from '../src/types.ts';
const source: Block = { id: 'p-bpe-0', kind: 'paragraph', heading: 'BPE', text: '反复把训练文本中相邻出现频率最高的一对符号合并成一个新符号，逐渐建立高频片段词表。' };
test('brief mode checks verbosity and template repetition without cutting off meaning', () => {
  assert.equal(reviewReason('核心含义：BPE 合并高频符号。\n直接原因：减少长度。', [], 'brief'), 'template');
  assert.equal(reviewReason('这是一个很长但不一定有用的解释。'.repeat(20), [], 'brief'), 'length');
  assert.equal(reviewReason('这是一个很长但有必要的推导。'.repeat(20), [], 'deep'), null);
});
test('long verbatim prose is flagged while shared math notation and short terms are allowed', () => {
  assert.equal(reviewReason(source.text, [source], 'example'), 'copy');
  assert.equal(reviewReason('BPE 像给常见片段设快捷键，用更大的词表换更短的序列。[p-bpe-0]', [source], 'brief'), null);
  assert.equal(reviewReason('W ∈ ℝ^{2×3}，因为每行产生一个输出。', [source], 'brief'), null);
  assert.equal(visibleAnswer('**理解** [p-bpe-0]'), '理解');
});

test('principle plus example requires both a mechanism and a concrete case, without a word-count minimum', () => {
  assert.equal(reviewReason('B是样本数，T是序列长度，D是维度。', [], 'example'), 'missing_mechanism');
  assert.equal(reviewReason('B是样本数。例如B=2时有两个样本。', [], 'example'), 'missing_mechanism');
  assert.equal(reviewReason('因为每个ID会换成D个数，所以输出多了一个特征轴。', [], 'example'), 'missing_example');
  assert.equal(reviewReason('### 原理\n每个ID换成D个数，所以保留位置轴再增加特征轴。\n### 例子\n例如B=2、T=3，有6个位置，输出是2×3×D。', [], 'example'), null);
  assert.equal(reviewReason('只需查表。', [], 'example', '请一句话回答，不用举例。'), null);
  assert.equal(reviewReason('换个输入后会怎样？', [], 'example', '给我一道检验理解的小题，先不告诉答案。'), null);
  assert.ok(hasMechanism('每一行把输入逐项相乘后相加，生成一个输出值。'));
});
test('brief opening cleanup does not remove embedded explanations or mathematical conditions', () => {
  assert.equal(cleanBriefOpening('**关键在于**：B×T×D保留B和T两条轴。'),'B×T×D保留B和T两条轴。');
  assert.equal(cleanBriefOpening('问题的关键在于约定。'),'问题的关键在于约定。');
});

test('principle mode requests visible sections while contextual mode can answer without a forced tutorial',()=>{
 const answer='因为每个编号换成一串数，所以多出特征轴。例如B=2，原样本轴保留。';
 assert.equal(reviewReason(answer,[],'example'),'missing_structure');
 assert.equal(reviewReason('本段的B表示一次处理的文本条数。',[],'context'),null);
});
