import { test } from 'node:test';
import assert from 'node:assert/strict';
import MarkdownIt from 'markdown-it';
import { mathPlugin } from '../src/rich/math.ts';
import { calculate, trainBpe, encodeBpe } from '../src/rich/compute.ts';
import { parseRich, safeImageUrl } from '../src/rich/schema.ts';
import { imageEndpoint } from '../src/providers/images.ts';
import { buildContext } from '../src/core/context.ts';
import { reviewReason } from '../src/core/quality.ts';
import { replaceRichImage } from '../src/ui/render.ts';

test('calculator follows arithmetic precedence and rejects script execution and invalid results', () => {
  assert.equal(calculate('v*d + max(0,b)', { v:32000, d:512, b:-1 }), 16384000);
  assert.equal(calculate('-2^2', {}), -4);
  assert.equal(calculate('2^-2 + sqrt(9)', {}), 3.25);
  assert.equal(calculate('2^3^2', {}), 512);
  for (const expression of ['window.alert(1)', 'constructor.constructor(1)', '1/0', 'sqrt(-1)', 'unknown', '2^100', 'x=1', '1;fetch(1)']) assert.throws(() => calculate(expression, {}));
});
test('BPE learns corpus frequencies and applies the learned merge order', () => {
  const merges = trainBpe([{text:'aaa',count:10},{text:'low',count:2}], 3);
  assert.deepEqual(merges[0], ['a','a']);
  assert.deepEqual(encodeBpe('aaa aaa', merges, 2), [['aaa'],['aaa']]);
  assert.deepEqual(encodeBpe('新', merges, 3), [['新']], 'unknown base characters are preserved for UI warning, not claimed encodable');
});
test('component schema bounds matrices, graph edges and calculator variables', () => {
  assert.equal(parseRich({type:'matrix',matrix:[[1,2],[3,4]],vector:[1,2]}).type, 'matrix');
  assert.throws(() => parseRich({type:'matrix',matrix:[[1,2]],vector:[1]}));
  assert.throws(() => parseRich({type:'flow',nodes:[{id:'a',label:'A'}],edges:[{from:'a',to:'missing'}]}));
  assert.throws(() => parseRich({type:'calculator',inputs:[{key:'__proto__',min:0,max:10,step:1,value:1}],outputs:[{expression:'1'}]}));
  assert.throws(() => parseRich({type:'script',code:'alert(1)'}));
  assert.equal(safeImageUrl('javascript:alert(1)'),null);
  assert.equal(safeImageUrl('https://user:pass@example.com/img.png'),null);
  assert.equal(safeImageUrl('https://example.com/img.png'),'https://example.com/img.png');
});
test('math renders inline and display formulas without trusting links or breaking code', () => {
  const md = new MarkdownIt({html:false}).use(mathPlugin);
  assert.match(md.render('行内 $y=Wx$ 和 \\(x^2\\)。'), /katex/);
  const block = md.render('$$\nW=\\begin{bmatrix}1&2\\\\3&4\\end{bmatrix}\n$$');
  assert.match(block, /katex-display/); assert.match(block, /<math/);
  assert.ok(!md.render('`$a$`').includes('class="katex"'));
  assert.ok(!md.render('$\\href{javascript:alert(1)}{x}$').includes('href="javascript:'));
  assert.match(md.render('<script>alert(1)</script>'), /&lt;script&gt;/);
});
test('image endpoint normalizes the generation path and rejects credential-bearing addresses', () => {
  assert.equal(imageEndpoint('https://example.com/v1/').href,'https://example.com/v1/images/generations');
  assert.equal(imageEndpoint('https://example.com/v1/images/generations').href,'https://example.com/v1/images/generations');
  assert.throws(() => imageEndpoint('https://a:b@example.com/v1'));
  assert.throws(() => imageEndpoint('http://example.com'));
});
test('image descriptions and observed demo state fit context, without sending image URLs or pixels', () => {
  const page = {url:'https://example.com/a',title:'图例',version:'1',capturedAt:'',selection:null,truncated:false,blocks:[{id:'p-one-0',heading:'图例',text:'矩阵的每一行对应一个输出。',kind:'paragraph' as const}],images:[{id:'img-a',url:'https://private.example/img?secret=1',alt:'矩阵示意',caption:'两行三列'}]};
  const input = {page,question:'解释矩阵',scope:'article' as const,depth:'example' as const,turns:[{question:'改参数',answer:'看输出',citations:[],interactions:{'0':{type:'matrix',row:2,vector:[1,3]}}}],notes:[],skill:'规则',skillName:'reading',budget:5000,tools:[]};
  const result = buildContext(input); const text = JSON.stringify(result.messages);
  assert.ok(text.includes('img-a')); assert.ok(text.includes('observedDemoState')); assert.ok(!text.includes('private.example'));
  assert.ok(!JSON.stringify(buildContext({...input,scope:'passage'}).messages).includes('img-a'));
  const selected = buildContext({...input,page:{...page,selection:{text:'矩阵',blockIds:['p-one-0'],prefix:'',suffix:''}}});
  assert.ok(JSON.stringify(selected.messages).includes('img-a'), 'selection rules do not consume the separate image-metadata allowance');
  assert.ok(selected.report.estimatedTokens <= input.budget);
  assert.equal(reviewReason('调节参数观察输出。\n```reading-pet\n'+JSON.stringify({type:'steps',title:'x'.repeat(200),items:[]})+'\n```', [], 'brief'),null);
});

test('saved images replace exactly the matching rich fence, including tilde fences', () => {
  const answer = '先看图。\n```mermaid\nflowchart TD\nA-->B\n```\n\n  ~~~reading-pet\n  {"type":"generate-image","prompt":"插画"}\n  ~~~\n结束。';
  const updated = replaceRichImage(answer, 1, 'media-test-id');
  assert.ok(updated.includes('flowchart TD')); assert.ok(updated.includes('media-test-id')); assert.ok(!updated.includes('generate-image')); assert.ok(updated.endsWith('结束。'));
  assert.throws(() => replaceRichImage(answer, 6, 'media-test-id'));
});
