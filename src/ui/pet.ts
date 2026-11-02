// Pose facing and breath keyframes adapted from dsh-pet-dafeiyu (MIT).
// Copyright (c) 2026 bauerelizabeth07139. See THIRD_PARTY_NOTICES.md.
export type PetState = 'idle' | 'thinking' | 'answering' | 'error' | 'sleep';
import type { Block, Depth, Turn } from '../types';
import { renderAnswer } from './render';
export function createPet(actions: { onSelect: () => void; onAsk: (text: string, depth: Depth) => void; onCancel: () => void; onPanel: (teach: boolean) => void; onLocate: (block: Block) => void; onSettings: () => void }) {
  const host = document.createElement('div');
  host.dataset.readingPet = 'true';
  host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483646;';
  const root = host.attachShadow({ mode: 'closed' });
  for (const path of ['vendor/katex.min.css', 'rich.css']) { const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = chrome.runtime.getURL(path); root.append(link); }
  const style = document.createElement('style');
  style.textContent = `
    :host{all:initial}*{box-sizing:border-box}button{font:13px system-ui;cursor:pointer;border:0}
    .pet{position:fixed;right:22px;bottom:20px;width:98px;pointer-events:auto;touch-action:none;background:none;padding:0;border-radius:28px}
    .pet:focus-visible,.ask:focus-visible{outline:3px solid #63b8a9;outline-offset:4px}
    .pet img{display:block;width:98px;height:118px;object-fit:contain;user-select:none;animation:breathe 3.4s ease-in-out infinite;filter:drop-shadow(0 8px 10px #183d4220)}
    .pet span{display:block;background:#fffef9;color:#255a54;border:1px solid #d5e7df;padding:5px 9px;border-radius:20px;box-shadow:0 3px 15px #12292312;white-space:nowrap;font-size:11px}
    .ask{display:none;position:fixed;pointer-events:auto;background:#234f49;color:white;padding:9px 14px;border-radius:12px;box-shadow:0 5px 22px #102d4933}
    .hide{position:fixed;right:18px;bottom:150px;pointer-events:auto;color:#517169;background:#fffef9;border:1px solid #d5e7df;border-radius:50%;width:21px;height:21px;font-size:12px}
    .bubble{position:fixed;pointer-events:auto;background:#fffef9;color:#263b36;border:1px solid #dbe3d4;border-radius:17px;padding:16px;box-shadow:0 12px 45px #18332925;font:13px/1.85 system-ui;max-height:calc(100vh - 36px);overflow:auto}
    .bubble-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:9px}.bubble-head strong{font-size:12px;color:#376957;font-weight:600}.bubble-head button{background:none;color:#8a9989;font-size:18px;padding:0 3px}
    .bubble-quote{border-left:2px solid #b7cba6;padding-left:9px;margin-bottom:10px;color:#89947f;font-size:10px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
    .bubble-answer{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;max-height:240px;overflow:auto}.bubble-answer h3{font-size:13px;margin:7px 0}.bubble-answer strong{color:#244e40}.bubble-answer code{font:12px monospace;background:#edf0e6;border-radius:3px;padding:1px 3px}
    .bubble-sources{display:flex;gap:9px;margin-top:7px}.bubble-sources button,.bubble-footer button,.bubble-adjustments button{background:none;color:#597557;font-size:10px;padding:2px 0}
    .bubble-status{font-size:9px;color:#8b9982;margin:9px 0}.bubble-form{display:flex;gap:7px;border-top:1px solid #e7ebdf;padding-top:10px}.bubble-form input{all:initial;font:12px system-ui;color:#263b36;min-width:0;flex:1;background:#f5f6ed;border-radius:7px;padding:8px}.bubble-form>button{background:#305f52;color:white;border-radius:7px;padding:5px 11px;font-size:11px}.bubble-footer,.bubble-adjustments{display:flex;gap:12px;margin-top:8px}.bubble button:disabled{opacity:.45;cursor:wait}.bubble [hidden]{display:none!important}
    @keyframes breathe{0%,100%{transform:translateY(0) scaleY(1)}50%{transform:translateY(-3px) scaleY(1.015)}}
    @media(prefers-reduced-motion:reduce){.pet img{animation:none}}
  `;
  const button = document.createElement('button'); button.className = 'pet'; button.title = '打开拾知陪读（可以拖动）'; button.setAttribute('aria-label', '打开拾知陪读');
  const image = document.createElement('img'); image.alt = '大肥鱼陪读宠物'; image.draggable = false;
  const label = document.createElement('span'); label.textContent = '划出不懂的地方';
  button.append(image, label);
  const ask = document.createElement('button'); ask.className = 'ask'; ask.textContent = '✦ 请它解释';
  ask.onpointerdown = event => event.preventDefault(); ask.onclick = () => { actions.onSelect(); ask.style.display = 'none'; };
  const hide = document.createElement('button'); hide.className = 'hide'; hide.textContent = '×'; hide.title = '收起宠物，点击扩展图标可恢复';
  hide.onclick = () => { button.hidden = true; hide.hidden = true; bubble.hidden = true; ask.style.display = 'none'; };
  const bubble = document.createElement('section'); bubble.className = 'bubble'; bubble.hidden = true;
  bubble.setAttribute('role', 'region'); bubble.setAttribute('aria-label', '拾知陪读气泡');
  const heading = document.createElement('div'); heading.className = 'bubble-head';
  const title = document.createElement('strong'); title.textContent = '拾知 · 简短解惑';
  const close = document.createElement('button'); close.textContent = '×'; close.title = '收起气泡'; close.setAttribute('aria-label', '收起气泡'); close.onclick = () => { bubble.hidden = true; };
  heading.append(title, close);
  const quote = document.createElement('div'); quote.className = 'bubble-quote'; quote.hidden = true;
  const answer = document.createElement('div'); answer.className = 'bubble-answer answer'; answer.textContent = '选中一段文字，我帮你理清它在讲什么。'; answer.setAttribute('aria-live', 'polite');
  const citations = document.createElement('div'); citations.className = 'bubble-sources';
  const status = document.createElement('p'); status.className = 'bubble-status'; status.textContent = '简短解惑，不打断阅读。';
  const form = document.createElement('form'); form.className = 'bubble-form';
  const input = document.createElement('input'); input.placeholder = '这里为什么这样？'; input.maxLength = 2000; input.setAttribute('aria-label', '在气泡中追问');
  const send = document.createElement('button'); send.textContent = '问'; send.type = 'submit'; send.title = '发送问题';
  form.append(input, send); form.onsubmit = event => { event.preventDefault(); if (!send.disabled && input.value.trim()) { actions.onAsk(input.value.trim(), 'brief'); input.value = ''; } };
  const footer = document.createElement('div'); footer.className = 'bubble-footer';
  const example = document.createElement('button'); example.textContent = '举个例子'; example.onclick = () => actions.onAsk('用一个极简例子说明这句话在此处的含义。', 'brief');
  const teach = document.createElement('button'); teach.textContent = '知识讲解 ↗'; teach.onclick = () => actions.onPanel(true);
  const library = document.createElement('button'); library.textContent = '笔记'; library.onclick = () => actions.onPanel(false);
  const settings = document.createElement('button'); settings.textContent = '设置'; settings.onclick = actions.onSettings;
  const cancel = document.createElement('button'); cancel.textContent = '停止'; cancel.hidden = true; cancel.onclick = actions.onCancel;
  const simpler = document.createElement('button'); simpler.textContent = '再白话点'; simpler.onclick = () => actions.onAsk('这次解释我还没看懂，请再白话一点，补上理解这里必需的词义或关系；先不展开更多知识。', 'brief');
  const redirect = document.createElement('button'); redirect.textContent = '不是问这个'; redirect.onclick = () => { input.value = '我想问的是：'; input.focus(); };
  const adjustments = document.createElement('div'); adjustments.className = 'bubble-adjustments'; adjustments.setAttribute('aria-label', '调整这次解释'); adjustments.append(simpler, redirect);
  footer.append(example, teach, library, settings, cancel);
  bubble.append(heading, quote, answer, citations, status, adjustments, form, footer);
  root.append(style, button, hide, ask, bubble); document.documentElement.append(host);
  function positionBubble() {
    const rect = button.getBoundingClientRect(), width = Math.min(330, innerWidth - 24);
    bubble.style.width = `${width}px`;
    bubble.style.left = `${Math.max(12, Math.min(innerWidth - width - 12, rect.left > innerWidth / 2 ? rect.right - width : rect.left))}px`;
    const bottom = Math.max(12, Math.min(innerHeight - 240, innerHeight - rect.top + 12));
    bubble.style.bottom = `${bottom}px`; bubble.style.maxHeight = `${Math.max(160, innerHeight - bottom - 12)}px`;
  }
  function showBubble() { bubble.hidden = false; positionBubble(); }
  function setBusy(value: boolean) { send.disabled = example.disabled = teach.disabled = simpler.disabled = redirect.disabled = value; cancel.hidden = !value; }
  window.addEventListener('resize', positionBubble);
  let state: PetState = 'idle', drag: { x: number; y: number; left: number; top: number; moved: boolean } | null = null;
  function setPose(pose: string) {
    image.src = chrome.runtime.getURL(`assets/sprites/dafeiyu-${pose}.png`);
    const artFacing = ['idle', 'blink'].includes(pose) ? -1 : 1;
    const desiredFacing = button.getBoundingClientRect().left > innerWidth / 2 ? -1 : 1;
    image.style.scale = `${desiredFacing === artFacing ? 1 : -1} 1`;
  }
  function setState(next: PetState) { state = next; setPose(({ idle: 'idle', thinking: 'think', answering: 'talk', error: 'sad', sleep: 'sleep' })[next]); label.textContent = ({ idle: '划出不懂的地方', thinking: '正在读原文…', answering: '随时问我', error: '点我查看提示', sleep: '我在这里等你' })[next]; }
  button.onpointerdown = event => {
    if (event.button !== 0) return;
    const rect = button.getBoundingClientRect();
    drag = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, moved: false };
    button.setPointerCapture(event.pointerId);
  };
  button.onpointermove = event => {
    if (!drag) return;
    if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 5) drag.moved = true;
    if (!drag.moved) return;
    button.style.right = button.style.bottom = 'auto';
    button.style.left = `${Math.max(0, Math.min(innerWidth - 98, drag.left + event.clientX - drag.x))}px`;
    button.style.top = `${Math.max(0, Math.min(innerHeight - 148, drag.top + event.clientY - drag.y))}px`;
    positionBubble();
  };
  button.onpointerup = () => { const moved = drag?.moved; drag = null; if (moved) setState(state); };
  button.onclick = event => { if (event.detail === 0 || !drag) showBubble(); };
  // Suppress the click generated after a drag, while retaining keyboard activation.
  button.addEventListener('click', event => { if (button.dataset.dragged === 'yes') { event.stopImmediatePropagation(); button.dataset.dragged = ''; } }, true);
  button.addEventListener('pointermove', () => { if (drag?.moved) button.dataset.dragged = 'yes'; });
  button.addEventListener('pointercancel', () => { drag = null; });
  const blink = setInterval(() => {
    if (state !== 'idle' || document.hidden || button.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    setPose('blink'); setTimeout(() => { if (state === 'idle') setPose('idle'); }, 160);
  }, 5700);
  window.addEventListener('pagehide', () => clearInterval(blink), { once: true });
  setState('idle');
  return {
    setState,
    showBubble,
    setBusy,
    showQuote(text: string) { quote.textContent = text; quote.hidden = !text; },
    showStatus(text: string) { status.textContent = text; },
    showAnswer(turn: Turn) {
      renderAnswer(answer, turn.answer, turn.citations.map(b => b.id), { images: turn.images }); citations.replaceChildren();
      turn.citations.slice(0, 3).forEach((block, i) => { const link = document.createElement('button'); link.textContent = `原文 ${i + 1} ↗`; link.title = block.heading; link.onclick = () => actions.onLocate(block); citations.append(link); });
    },
    restore() { button.hidden = false; hide.hidden = false; },
    showSelection(rect: DOMRect | null) { ask.style.display = rect ? 'block' : 'none'; if (rect) { ask.style.left = `${Math.max(8, Math.min(innerWidth - 135, rect.left))}px`; ask.style.top = `${Math.max(8, Math.min(innerHeight - 50, rect.bottom + 9))}px`; } },
  };
}
