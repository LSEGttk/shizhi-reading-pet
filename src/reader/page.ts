import { Readability } from '@mozilla/readability';
import type { ArticleImage, Block, PageSnapshot, SelectionAnchor } from '../types';
import { hash, normalize } from '../core/text';

const OMIT = 'nav,header,footer,aside,form,button,script,style,noscript,[hidden],[aria-hidden="true"],[data-reading-pet]';
const TARGETS = 'h1,h2,h3,h4,h5,h6,p,li,pre,blockquote,table,figure,.katex-display,[role="math"]';
let locations = new Map<string, Element>();
let blockList: Block[] = [];

function visible(node: Element) {
  if (node.closest(OMIT)) return false;
  const style = getComputedStyle(node);
  return style.display !== 'none' && style.visibility !== 'hidden' && node.getClientRects().length > 0;
}
function readableText(element: Element): string {
  const clone = element.cloneNode(true) as Element;
  clone.querySelectorAll('script,style,[data-reading-pet],.katex-html').forEach(el => el.remove());
  clone.querySelectorAll('annotation[encoding="application/x-tex"]').forEach(annotation => {
    const math = annotation.closest('.katex,math');
    if (math) math.replaceWith(document.createTextNode(` ${annotation.textContent} `));
  });
  return normalize(clone.textContent || '');
}
function findRoot(): Element {
  for (const selector of ['[data-prose]', '.post-content', '.entry-content', '.article-content', '.prose', '.markdown-body', '[itemprop="articleBody"]', 'article', 'main', '[role="main"]']) {
    const candidates = [...document.querySelectorAll(selector)].filter(visible);
    const best = candidates.sort((a, b) => readableText(b).length - readableText(a).length)[0];
    if (best && readableText(best).length > 100) return best;
  }
  try {
    const parsed = new Readability(document.cloneNode(true) as Document).parse();
    const snippets = parsed?.textContent?.split(/\n+/).map(normalize).filter(t => t.length > 80).slice(0, 6) || [];
    const match = [...document.querySelectorAll('p')].find(p => snippets.some(t => t.includes(normalize(p.textContent || '')) && normalize(p.textContent || '').length > 80));
    if (match) return match.closest('article,main,[role="main"]') || match.parentElement || document.body;
  } catch { /* Semantic DOM fallback below. */ }
  return document.body;
}

export function capturePage(): PageSnapshot {
  const root = findRoot();
  const candidates = [...root.querySelectorAll(TARGETS)].filter(visible).filter(node => {
    // Keep one representative for nested structures, preserving complete lists/tables/code.
    const parent = node.parentElement?.closest(TARGETS);
    return !parent || !root.contains(parent);
  });
  if (!candidates.length) candidates.push(root);
  locations = new Map(); blockList = [];
  const counts = new Map<string, number>();
  let heading = document.title, length = 0, truncated = false;
  for (const node of candidates) {
    const text = readableText(node);
    if (text.length < 2) continue;
    if (length + text.length > 160_000 || blockList.length >= 1000) { truncated = true; break; }
    const base = hash(text), ordinal = counts.get(base) || 0;
    counts.set(base, ordinal + 1);
    const id = `p-${base}-${ordinal}`;
    const isHeading = /^H[1-6]$/.test(node.tagName);
    if (isHeading) heading = text;
    const block: Block = { id, text, heading, kind: isHeading ? 'heading' : node.tagName === 'PRE' ? 'code' : 'paragraph' };
    locations.set(id, node); blockList.push(block); length += text.length;
  }
  const title = (document.querySelector('article h1, main h1, h1')?.textContent?.trim() || document.title).slice(0, 2000);
  const images: ArticleImage[] = [];
  for (const img of root.querySelectorAll('img')) {
    if (images.length >= 16) break;
    if (!visible(img) || Math.max(img.naturalWidth, img.width) < 80) continue;
    try {
      const url = new URL(img.currentSrc || img.src);
      if (url.protocol !== 'https:' || url.username || url.password || images.some(i => i.url === url.href)) continue;
      images.push({ id: `img-${hash(url.href)}`, url: url.href, alt: img.alt.slice(0, 300), caption: (img.closest('figure')?.querySelector('figcaption')?.textContent || '').slice(0, 400) });
    } catch { /* Ignore malformed image addresses. */ }
  }
  return { url: location.href, title, version: hash(blockList.map(b => b.id).join('|')), capturedAt: new Date().toISOString(), blocks: blockList, selection: captureSelection(), truncated, images };
}

export function captureSelection(): SelectionAnchor | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const text = normalize(selection.toString());
  if (!text || text.length > 6000) return null;
  const range = selection.getRangeAt(0);
  const container = range.commonAncestorContainer;
  if ((container instanceof Element ? container : container.parentElement)?.closest('[data-reading-pet],input,textarea,[contenteditable="true"]')) return null;
  const blockIds = [...locations].filter(([, el]) => range.intersectsNode(el)).map(([id]) => id);
  if (!blockIds.length) return null;
  // Prefix/suffix and intersecting block IDs distinguish repeated text and cross-block selections.
  const around = blockList.filter(b => blockIds.includes(b.id)).map(b => b.text).join(' ');
  const index = around.indexOf(text);
  return { text, blockIds, prefix: index < 0 ? '' : around.slice(Math.max(0, index - 80), index), suffix: index < 0 ? '' : around.slice(index + text.length, index + text.length + 80) };
}

export function locateBlock(id: string, expectedVersion: string): { ok: boolean; error?: string } {
  const page = capturePage();
  if (page.version !== expectedVersion) return { ok: false, error: '正文已变化，请重新读取网页后再定位。' };
  const el = locations.get(id);
  if (!el) return { ok: false, error: '找不到这段原文。' };
  el.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'center' });
  const oldOutline = (el as HTMLElement).style.outline;
  (el as HTMLElement).style.outline = '3px solid #57a99b';
  setTimeout(() => { (el as HTMLElement).style.outline = oldOutline; }, 2400);
  return { ok: true };
}
