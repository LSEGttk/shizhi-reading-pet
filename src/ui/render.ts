import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import python from 'highlight.js/lib/languages/python';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import { mathPlugin } from '../rich/math';
import { parseRich, safeImageUrl, type RichSpec } from '../rich/schema';
import type { ArticleImage } from '../types';
for (const [name, language] of Object.entries({ javascript, typescript: javascript, js: javascript, python, py: python, json, bash, shell: bash })) hljs.registerLanguage(name, language);

export interface RenderOptions {
  preview?: boolean; images?: ArticleImage[];
  resolveMedia?: (id: string) => Promise<{ url: string; alt: string } | undefined>;
  generateImage?: (prompt: string, alt: string, signal: AbortSignal) => Promise<string>;
  onImageSaved?: (index: number, id: string) => Promise<void>;
  states?: Record<string, unknown>;
  onInteraction?: (index: number, state: unknown) => void;
}
interface Slot { spec?: RichSpec; url?: string; alt?: string; error?: string; index?: number }
interface RenderEnv { [key: PropertyKey]: unknown; slots: Slot[]; preview: boolean; richIndex: number }
const md = new MarkdownIt({ html: false, linkify: false, breaks: false, typographer: true, highlight(code, language) {
  return language && hljs.getLanguage(language) ? hljs.highlight(code.slice(0, 50000), { language, ignoreIllegals: true }).value : '';
} }).use(mathPlugin);
const fence = md.renderer.rules.fence!;
function slot(env: RenderEnv, value: Slot) { const id = env.slots.push(value) - 1; return `<div class="rich-slot" data-rich-slot="${id}"></div>`; }
md.renderer.rules.fence = (tokens, idx, options, rawEnv, renderer) => {
  const env = rawEnv as RenderEnv;
  const token = tokens[idx], language = token.info.trim().split(/\s+/)[0];
  if (['reading-pet', 'mermaid', 'svg'].includes(language)) {
    const index = env.richIndex++;
    if (env.preview) return '<p class="rich-pending">讲解组件将在回答完成后显示…</p>';
    try { return slot(env, { index, spec: parseRich(language === 'reading-pet' ? JSON.parse(token.content) : { type: language, title: '', code: token.content }) }); }
    catch { return slot(env, { error: '讲解组件参数不完整，已保留原始内容。' }) + fence(tokens, idx, options, env, renderer); }
  }
  return fence(tokens, idx, options, env, renderer);
};
md.renderer.rules.image = (tokens, idx, _options, rawEnv) => {
  const env = rawEnv as RenderEnv;
  const token = tokens[idx];
  return env.preview ? '<span class="rich-pending">图片将在回答完成后显示</span>' : slot(env, { url: String(token.attrGet('src') || ''), alt: token.content.slice(0, 300) });
};
const cleanups = new WeakMap<HTMLElement, () => void>();
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', cls = '') => { const n = document.createElement(tag); n.textContent = text; n.className = cls; return n; };
export function renderAnswer(target: HTMLElement, text: string, sourceIds: string[] = [], options: RenderOptions = {}) {
  cleanups.get(target)?.();
  const resources: (() => void)[] = [];
  cleanups.set(target, () => resources.splice(0).forEach(dispose => dispose()));
  target.classList.add('rich-answer');
  const display = text.slice(0, 100000).replace(/\[(p-[a-z0-9]+-\d+)\]/g, (_all, id: string) => { const index = sourceIds.indexOf(id); return index >= 0 ? `〔${index + 1}〕` : '〔原文〕'; }).replace(/\[n-[a-z0-9-]+\]/g, '〔关联笔记〕');
  const env: RenderEnv = { slots: [], preview: !!options.preview, richIndex: 0 };
  target.innerHTML = DOMPurify.sanitize(md.render(display, env), { USE_PROFILES: { html: true, mathMl: true, svg: true }, FORBID_TAGS: ['style', 'iframe', 'object', 'form', 'input'], ADD_ATTR: ['target', 'data-rich-slot'] });
  target.querySelectorAll('a').forEach(a => {
    try { if (!['https:', 'http:', 'mailto:'].includes(new URL(a.href).protocol)) a.removeAttribute('href'); } catch { a.removeAttribute('href'); }
    a.target = '_blank'; a.rel = 'noopener noreferrer';
  });
  target.querySelectorAll('table').forEach(table => { const wrap = node('div', '', 'rich-table'); table.replaceWith(wrap); wrap.append(table); wrap.tabIndex = 0; wrap.setAttribute('aria-label', '可横向滚动的比较表'); });
  target.querySelectorAll('pre').forEach(pre => {
    const copy = button('复制', () => { void navigator.clipboard.writeText(pre.querySelector('code')?.textContent || '').then(() => { copy.textContent = '已复制'; }, () => { copy.textContent = '复制失败'; }); }, 'rich-copy');
    pre.append(copy);
  });
  target.querySelectorAll<HTMLElement>('[data-rich-slot]').forEach(placeholder => {
    const item = env.slots[Number(placeholder.dataset.richSlot)]; if (!item) return;
    if (item.error) { placeholder.append(node('p', item.error, 'rich-error')); return; }
    if (item.url !== undefined) { renderImage(placeholder, item.url, item.alt || '', options); return; }
    const spec = item.spec!;
    if (spec.type === 'image') { renderImage(placeholder, spec.sourceId, spec.alt || spec.title, options); return; }
    if (spec.type === 'generate-image') { renderGeneration(placeholder, spec, item.index!, options, resources); return; }
    renderFrame(placeholder, spec, item.index!, options, resources);
  });
  // Cancel listeners and generation when a completed answer is removed from the page.
  const observer = new MutationObserver(() => { if (!target.isConnected) { cleanups.get(target)?.(); observer.disconnect(); } });
  queueMicrotask(() => { if (target.isConnected) observer.observe(document.body, { childList: true, subtree: true }); });
  resources.push(() => observer.disconnect());
}
function renderFrame(host: HTMLElement, spec: RichSpec, index: number, options: RenderOptions, resources: (() => void)[]) {
  host.className = 'rich-component';
  const toolbar = node('div', '', 'rich-toolbar'), label = node('span', ({ steps: '学习步骤', flow: '关系图', mermaid: '流程图', svg: '图示', matrix: '矩阵实验', bpe: '分词实验', calculator: '参数实验', image: '图片', 'generate-image': '插画' })[spec.type]);
  const expand = button('放大 ↗', () => { const opened = host.classList.toggle('rich-expanded'); expand.textContent = opened ? '收起 ×' : '放大 ↗'; }, 'rich-expand');
  toolbar.append(label, expand);
  const iframe = node('iframe'); iframe.title = spec.title || label.textContent || '交互讲解'; iframe.setAttribute('sandbox', 'allow-scripts'); iframe.referrerPolicy = 'no-referrer';
  const nonce = crypto.randomUUID(); iframe.src = chrome.runtime.getURL(`rich-frame.html#${nonce}`); iframe.height = '160';
  const onMessage = (event: MessageEvent) => {
    if (event.source !== iframe.contentWindow || event.data?.channel !== 'reading-pet-rich' || event.data?.nonce !== nonce) return;
    if (event.data.type === 'HEIGHT' && typeof event.data.data === 'number' && Number.isFinite(event.data.data)) { const height = Math.ceil(Math.max(60, Math.min(1100, event.data.data + 4))); iframe.height = String(height); iframe.style.height = `${height}px`; }
    if (event.data.type === 'STATE') {
      const state = event.data.data;
      if (state && JSON.stringify(state).length < 3000 && state.type === spec.type) options.onInteraction?.(index, state);
    }
    if (event.data.type === 'CLOSE') { host.classList.remove('rich-expanded'); expand.textContent = '放大 ↗'; }
  };
  window.addEventListener('message', onMessage); resources.push(() => window.removeEventListener('message', onMessage));
  const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { host.classList.remove('rich-expanded'); expand.textContent = '放大 ↗'; } };
  window.addEventListener('keydown', onKey); resources.push(() => window.removeEventListener('keydown', onKey));
  iframe.onload = () => iframe.contentWindow?.postMessage({ channel: 'reading-pet-rich', nonce, type: 'INIT', spec, state: options.states?.[String(index)] }, '*');
  host.append(toolbar, iframe);
}
function renderImage(host: HTMLElement, address: string, alt: string, options: RenderOptions) {
  const figure = node('figure', '', 'rich-image'), caption = node('figcaption', alt), status = node('p', '', 'rich-pending'); host.append(figure);
  const show = (url: string, title: string, generated = false) => {
    const image = node('img'); image.alt = alt || title; image.loading = 'lazy'; image.referrerPolicy = 'no-referrer'; image.src = url;
    image.onerror = () => { status.textContent = '图片无法加载，可能需要原站登录。'; figure.append(status); };
    const link = node('a', '打开图片 ↗'); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer';
    if (generated) { link.download = '拾知-讲解插画.png'; link.textContent = '下载图片 ↗'; }
    caption.replaceChildren(document.createTextNode(alt || title), node('br'), link); figure.replaceChildren(image, caption);
  };
  const sourceId = address.replace(/^article:/, '').replace(/^media:/, 'media-');
  const known = options.images?.find(i => i.id === sourceId);
  if (known && safeImageUrl(known.url)) { show(known.url, known.caption || known.alt); return; }
  if (/^media-[a-z0-9-]+$/i.test(sourceId)) {
    status.textContent = '正在读取已保存的图片…'; figure.append(status);
    void options.resolveMedia?.(sourceId).then(media => {
      if (media && (/^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=\r\n]+$/i.test(media.url) || safeImageUrl(media.url))) show(media.url, media.alt, true);
      else status.textContent = '这张本地图片暂时不可用，请在侧栏查看。';
    }).catch(() => { status.textContent = '读取图片失败。'; });
    if (!options.resolveMedia) status.textContent = '在侧栏查看已保存的图片。';
    return;
  }
  const url = safeImageUrl(address);
  if (!url) { figure.append(node('p', '未找到这张图片的已知来源。', 'rich-error')); return; }
  const load = button('加载外部图片', () => show(url, new URL(url).hostname), 'rich-image-load');
  figure.append(node('p', `${alt || '讲解图片'} · ${new URL(url).hostname}`, 'rich-pending'), load);
}
function renderGeneration(host: HTMLElement, spec: Extract<RichSpec, {type:'generate-image'}>, index: number, options: RenderOptions, resources: (() => void)[]) {
  host.className = 'rich-generate'; host.append(node('strong', spec.title || '用一张插画讲清楚'));
  const prompt = node('textarea'); prompt.value = spec.prompt; prompt.maxLength = 2500; prompt.rows = 3; prompt.setAttribute('aria-label', '插画生成描述');
  const status = node('p', '使用单独配置的图片接口；点击后才会生成并产生接口用量。', 'rich-pending');
  let active: AbortController | null = null;
  const cancel = button('停止', () => active?.abort()); cancel.hidden = true;
  const generate = button('生成插画', () => {
    if (!options.generateImage) { status.textContent = '请在侧栏打开此回答，并在设置中连接图片接口。'; return; }
    if (!prompt.value.trim() || active) return;
    active = new AbortController(); const current = active; generate.disabled = true; cancel.hidden = false; status.textContent = '正在生成插画…';
    void options.generateImage(prompt.value.trim(), spec.alt || spec.title, current.signal).then(async id => {
      let saved = true;
      try { await options.onImageSaved?.(index, id); } catch { saved = false; }
      host.replaceChildren(); renderImage(host, id, spec.alt || spec.title, options);
      if (!saved) host.append(node('p', '图片已生成，会话记录未保存成功，请先下载图片。', 'rich-error'));
    }).catch(error => { status.textContent = current.signal.aborted ? '已停止生成。' : (error as Error).message; }).finally(() => { active = null; generate.disabled = false; cancel.hidden = true; });
  });
  resources.push(() => active?.abort());
  host.append(prompt, generate, cancel, status);
}
export function replaceRichImage(answer: string, index: number, id: string): string {
  const tokens = md.parse(answer, {});
  const token = tokens.filter(token => token.type === 'fence' && ['reading-pet', 'mermaid', 'svg'].includes(token.info.trim().split(/\s+/)[0]))[index];
  if (!token?.map || !/^media-[a-z0-9-]+$/i.test(id)) throw new Error('图片已生成，但无法更新回答，请先下载保存。');
  const lines = answer.split('\n');
  lines.splice(token.map[0], token.map[1] - token.map[0], '```reading-pet', JSON.stringify({ type: 'image', sourceId: id, title: '讲解插画', alt: 'AI 生成的讲解插画' }), '```');
  return lines.join('\n');
}
export function button(text: string, action: () => void, className = 'text-button') {
  const el = document.createElement('button'); el.type = 'button'; el.textContent = text; el.className = className; el.onclick = action; return el;
}
export function downloadText(name: string, text: string, mime = 'text/markdown;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
