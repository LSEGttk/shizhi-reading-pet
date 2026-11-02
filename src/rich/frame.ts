import DOMPurify from 'dompurify';
import { parseRich, type RichSpec } from './schema';
import { calculate, trainBpe, encodeBpe } from './compute';

const root = document.getElementById('root')!;
const nonce = location.hash.slice(1);
let initialized = false;
let initialState: Record<string, any> = {};
const send = (type: string, data: unknown) => parent.postMessage({ channel: 'reading-pet-rich', nonce, type, data }, '*');
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = '') => { const node = document.createElement(tag); node.textContent = text; node.className = className; return node; };
const heading = (title: string) => { if (title) root.append(el('h2', title)); };
const changed = (state: unknown) => send('STATE', state);
window.addEventListener('keydown', event => { if (event.key === 'Escape') send('CLOSE', null); });
new ResizeObserver(() => send('HEIGHT', Math.min(1100, root.getBoundingClientRect().height + 24))).observe(root);

function range(label: string, min: number, max: number, step: number, value: number, unit: string, onChange: (value: number) => void) {
  const wrapper = el('label', '', 'field'), head = el('span', '', 'field-head'), name = el('span', label), out = el('output', `${value} ${unit}`);
  const input = el('input'); input.type = 'range'; input.min = String(min); input.max = String(max); input.step = String(step); input.value = String(value); input.setAttribute('aria-label', label);
  head.append(name, out); wrapper.append(head, input);
  input.oninput = () => { out.value = `${Number(input.value)} ${unit}`; onChange(Number(input.value)); };
  return wrapper;
}
function renderSteps(spec: Extract<RichSpec, {type:'steps'}>) {
  const list = el('ol', '', 'steps');
  spec.items.forEach((item, i) => { const li = el('li'); li.append(el('span', String(i + 1), 'step-number'), el('div', item.title, 'step-title'), el('div', item.body, 'step-body')); list.append(li); }); root.append(list);
}
function renderCalculator(spec: Extract<RichSpec, {type:'calculator'}>) {
  const values = Object.fromEntries(spec.inputs.map(i => [i.key, typeof initialState.values?.[i.key] === 'number' && Number.isFinite(initialState.values[i.key]) ? Math.min(i.max, Math.max(i.min, initialState.values[i.key])) : i.value]));
  const outputs = el('div', '', 'outputs');
  const slots = spec.outputs.map(output => { const group = el('div'), value = el('div', '', 'output-value'); group.append(el('div', output.label, 'output-label'), value); outputs.append(group); return value; });
  const update = () => {
    spec.outputs.forEach((o, i) => { try { const n = calculate(o.expression, values); slots[i].textContent = `${Number(n.toFixed(o.digits)).toLocaleString('zh-CN', { maximumFractionDigits: o.digits })} ${o.unit}`; } catch { slots[i].textContent = '当前参数无法计算'; } });
  };
  spec.inputs.forEach(i => root.append(range(i.label, i.min, i.max, i.step, values[i.key], i.unit, value => {
    values[i.key] = value; update();
    changed({ type: 'calculator', title: spec.title, values, parameters: spec.inputs.map(i => ({ key:i.key, label:i.label, value:values[i.key], unit:i.unit })), outputs: spec.outputs.map(o => { try { return { label:o.label, value:calculate(o.expression, values), unit:o.unit }; } catch { return { label:o.label, error:'当前参数无法计算' }; } }) });
  })));
  root.append(outputs, el('p', '数值按给定模型计算，不会因拖动滑块请求 AI。', 'muted')); update();
}
function renderMatrix(spec: Extract<RichSpec, {type:'matrix'}>) {
  let active = Number.isInteger(initialState.row) ? Math.max(0, Math.min(spec.matrix.length - 1, initialState.row - 1)) : 0;
  const vector = spec.vector.map((v, i) => typeof initialState.vector?.[i] === 'number' && Number.isFinite(initialState.vector[i]) ? Math.max(Math.min(-5, v), Math.min(Math.max(5, v), initialState.vector[i])) : v);
  const equation = el('div', '', 'matrix-equation'), grid = el('div', '', 'matrix-grid'), x = el('div', '', 'matrix-grid'), y = el('div', '', 'matrix-grid');
  grid.style.gridTemplateColumns = `repeat(${vector.length},minmax(28px,1fr))`;
  const cells = spec.matrix.flatMap((row, i) => row.map(value => { const cell = el('span', String(value), `cell${i === active ? ' active' : ''}`); grid.append(cell); return cell; }));
  const xCells = vector.map(v => { const cell = el('span', String(v), 'cell'); x.append(cell); return cell; });
  const yCells = spec.matrix.map(() => { const cell = el('span', '', 'cell'); y.append(cell); return cell; });
  equation.append(grid, el('span', '×'), x, el('span', '='), y); const expr = el('div', '', 'expression'), rows = el('div', '', 'rows');
  const update = () => {
    const result = spec.matrix.map(row => row.reduce((sum, v, i) => sum + v * vector[i], 0));
    cells.forEach((cell, i) => cell.classList.toggle('active', Math.floor(i / vector.length) === active));
    vector.forEach((v, i) => { xCells[i].textContent = String(v); }); result.forEach((v, i) => { yCells[i].textContent = String(Number(v.toFixed(3))); yCells[i].classList.toggle('active', i === active); });
    expr.textContent = `第 ${active + 1} 个输出 = ${spec.matrix[active].map((v, i) => `(${v})×(${vector[i]})`).join(' + ')} = ${Number(result[active].toFixed(3))}`;
    [...rows.children].forEach((b, i) => b.setAttribute('aria-pressed', String(i === active)));
  };
  const saveState = () => changed({ type:'matrix', title: spec.title, row: active + 1, matrix:spec.matrix, vector, outputs: spec.matrix.map(row => row.reduce((sum, v, i) => sum + v * vector[i], 0)) });
  spec.matrix.forEach((_, i) => { const button = el('button', `第 ${i + 1} 行`); button.onclick = () => { active = i; update(); saveState(); }; rows.append(button); });
  root.append(equation, rows, expr);
  vector.forEach((v, i) => root.append(range(`输入 x${i + 1}`, Math.min(-5, spec.vector[i]), Math.max(5, spec.vector[i]), 1, v, '', value => { vector[i] = value; update(); saveState(); })));
  root.append(el('p', `列向量约定：${spec.matrix.length}×${vector.length} 的矩阵，把 ${vector.length} 个输入变成 ${spec.matrix.length} 个输出。`, 'muted')); update();
}
function renderBpe(spec: Extract<RichSpec, {type:'bpe'}>) {
  const merges = trainBpe(spec.corpus, spec.merges), base = new Set(Array.from(spec.corpus.map(w => w.text).join(''))); let step = Number.isInteger(initialState.step) ? Math.max(0, Math.min(merges.length, initialState.step)) : 0;
  const label = el('label', '输入一小段文本'), input = el('input'), pieces = el('div', '', 'piece-row'), info = el('p'), status = el('p', '', 'muted'); input.type = 'text'; input.value = typeof initialState.text === 'string' ? initialState.text.slice(0, 100) : spec.text; input.maxLength = 100; input.setAttribute('aria-label', 'BPE 示例文本'); label.append(input);
  const controls = el('div', '', 'tools'), prev = el('button', '上一步'), next = el('button', '下一步'); controls.append(prev, next);
  const update = () => {
    pieces.replaceChildren(); const groups = encodeBpe(input.value, merges, step); let unknown = false;
    groups.forEach(group => { const word = el('span', '', 'word'); group.forEach(piece => { const missing = Array.from(piece).some(c => !base.has(c)); unknown ||= missing; word.append(el('span', piece, `piece${missing ? ' unknown' : ''}`)); }); pieces.append(word); });
    prev.disabled = step === 0; next.disabled = step === merges.length;
    info.textContent = `合并 ${step}/${merges.length} 步 · ${groups.reduce((n, g) => n + g.length, 0)} 个符号片段 · 词表 ${base.size + step} 项`;
    status.textContent = unknown ? '虚线片段含训练基础集合未覆盖的字符；不能据此认定真实模型能编码它。' : step ? `本步：${merges[step - 1][0]} + ${merges[step - 1][1]} → ${merges[step - 1].join('')}` : '从基础字符开始，按训练语料中的频次学习合并。';
  };
  const save = () => changed({ type:'bpe', title: spec.title, text: input.value, step, pieces: encodeBpe(input.value, merges, step), currentMerge: merges[step - 1] || null, baseCoverage: Array.from(input.value.replace(/\s/g, '')).every(c => base.has(c)), teachingExample:true });
  prev.onclick = () => { step--; update(); save(); }; next.onclick = () => { step++; update(); save(); }; input.oninput = () => { update(); save(); };
  root.append(label, pieces, info, controls, status, el('p', '字符级教学示意：在词内学习合并，空白只作分隔。词表和规则不代表任何真实模型。', 'muted')); update();
}
function safeSvg(source: string, trustedStyle = false): string {
  const clean = DOMPurify.sanitize(source, { USE_PROFILES: { svg: true }, FORBID_ATTR: trustedStyle ? [] : ['style'], FORBID_TAGS: ['script','foreignObject','a','image','animate','animateMotion','animateTransform','set','use', ...(trustedStyle ? [] : ['style'])] });
  const parsed = new DOMParser().parseFromString(clean, 'image/svg+xml'), svg = parsed.documentElement;
  if (svg.localName !== 'svg' || svg.querySelector('parsererror') || svg.querySelectorAll('*').length > 2500) throw new Error('SVG 格式无效或过大');
  [svg, ...svg.querySelectorAll('*')].forEach(node => {
    for (const attr of [...node.attributes]) if (/href|^on/i.test(attr.name) || [...attr.value.matchAll(/url\(([^)]+)\)/gi)].some(m => !m[1].replace(/["']/g, '').trim().startsWith('#'))) node.removeAttribute(attr.name);
    if (node.localName === 'style' && (/@import/i.test(node.textContent || '') || [...(node.textContent || '').matchAll(/url\(([^)]+)\)/gi)].some(m => !m[1].replace(/["']/g,'').trim().startsWith('#')))) node.remove();
  });
  if (!svg.hasAttribute('viewBox')) { const width = Number.parseFloat(svg.getAttribute('width') || '600'), height = Number.parseFloat(svg.getAttribute('height') || '400'); svg.setAttribute('viewBox', `0 0 ${Math.max(1, Math.min(4000, width || 600))} ${Math.max(1, Math.min(4000, height || 400))}`); }
  svg.removeAttribute('width'); svg.removeAttribute('height'); svg.setAttribute('role','img'); svg.setAttribute('aria-label','知识关系图');
  return new XMLSerializer().serializeToString(svg);
}
let mermaidReady: Promise<any> | null = null;
function mermaid() {
  mermaidReady ||= new Promise((resolve, reject) => { const script = document.createElement('script'); script.src = 'vendor/mermaid.min.js'; script.onload = () => resolve((globalThis as any).mermaid); script.onerror = () => reject(new Error('无法加载本地图示组件')); document.head.append(script); });
  return mermaidReady;
}
async function renderDiagram(spec: Extract<RichSpec, {type:'flow'|'mermaid'|'svg'}>) {
  let source = spec.type === 'svg' || spec.type === 'mermaid' ? spec.code : '';
  if (spec.type === 'flow') {
    const quote = (value: string) => value.replace(/["\n\r<>]/g, ' ').replace(/\[/g,'（').replace(/\]/g,'）');
    const groups = [...new Set(spec.nodes.map(n => n.group).filter(Boolean))];
    source = `flowchart ${spec.direction}\n`;
    const node = (n: typeof spec.nodes[number]) => `${n.id}["${quote(n.label)}"]\n`;
    source += spec.nodes.filter(n => !n.group).map(node).join('');
    groups.forEach((group, i) => { source += `subgraph group${i}["${quote(group!)}"]\n${spec.nodes.filter(n => n.group === group).map(node).join('')}end\n`; });
    source += spec.edges.map(e => `${e.from} -->${e.label ? `|"${quote(e.label)}"|` : ''} ${e.to}`).join('\n');
  }
  const display = el('div', '', 'diagram'); display.textContent = '正在绘制…'; root.append(display);
  try {
    if (spec.type === 'svg') display.innerHTML = safeSvg(source);
    else {
      if (/%%\{|^---|\bclick\s|(?:classDef|linkStyle|style)\s|https?:|url\(/im.test(source)) throw new Error('图示中包含不支持的配置或链接');
      const api = await mermaid(); api.initialize({ startOnLoad:false, securityLevel:'strict', htmlLabels:false, suppressErrorRendering:true, maxTextSize:12000, maxEdges:60, theme:'base', themeVariables:{ primaryColor:'#eff3e8',primaryTextColor:'#294d3b',primaryBorderColor:'#a5bb96',lineColor:'#85967b',fontFamily:'system-ui,sans-serif',fontSize:'14px' }, flowchart:{ useMaxWidth:true } });
      const { svg } = await api.render(`diagram${Math.random().toString(36).slice(2)}`, source); display.innerHTML = safeSvg(svg, true);
    }
    let zoom = 1;
    const tools = el('div', '', 'tools'), ratio = el('span', '100%', 'muted'), smaller = el('button', '缩小 −'), larger = el('button', '放大 ＋'), reset = el('button', '重置');
    const updateZoom = () => { const svg = display.querySelector('svg'); if (!svg) return; svg.style.maxWidth = 'none'; svg.style.width = `${zoom * 100}%`; ratio.textContent = `${Math.round(zoom * 100)}%`; smaller.disabled = zoom <= 0.75; larger.disabled = zoom >= 3; };
    smaller.onclick = () => { zoom = Math.max(0.75, zoom - 0.25); updateZoom(); }; larger.onclick = () => { zoom = Math.min(3, zoom + 0.25); updateZoom(); }; reset.onclick = () => { zoom = 1; updateZoom(); };
    tools.append(smaller, ratio, larger, reset); root.append(tools);
  } catch { display.replaceChildren(el('p', '这张图暂时无法绘制，原始描述保留在下方。', 'error'), el('pre', source, 'svg-error')); }
}
window.addEventListener('message', event => {
  if (initialized || event.source !== parent || event.data?.channel !== 'reading-pet-rich' || event.data?.nonce !== nonce || event.data?.type !== 'INIT') return;
  initialized = true;
  try {
    const spec = parseRich(event.data.spec); initialState = event.data.state?.type === spec.type && typeof event.data.state === 'object' ? event.data.state : {}; root.replaceChildren(); heading(spec.title);
    switch (spec.type) {
      case 'steps': renderSteps(spec); break;
      case 'calculator': renderCalculator(spec); break;
      case 'matrix': renderMatrix(spec); break;
      case 'bpe': renderBpe(spec); break;
      case 'flow': case 'mermaid': case 'svg': void renderDiagram(spec); break;
      default: throw new Error('此组件不在演示沙箱中展示');
    }
  } catch (error) { root.replaceChildren(el('p', (error as Error).message, 'error')); }
});
