import type { Block, ContextReport, Depth, Note, PageSnapshot, Scope, Turn } from './types';
import { runReading, summarizeNote, topicKey } from './agent/run';
import { appendTurn, deleteNote, exportNotes, getMedia, getSettings, listNotes, loadThread, patchTurn, putNote, updateNote, THREAD_WRITER } from './storage/local';
import { button, downloadText, renderAnswer, replaceRichImage } from './ui/render';
import { generateImage } from './providers/images';
import { captureRuntimeErrors, errorCode, record } from './diagnostics';
import { DEFAULT_READING_QUESTION, DEPTH_LABELS } from './core/learning';
import { createKnowledge } from './ui/knowledge';

captureRuntimeErrors('panel');

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let page: PageSnapshot | null = null, tabId: number | null = null, turns: Turn[] = [], notes: Note[] = [];
let controller: AbortController | null = null, generation = 0, clearSelection = false;
let renderEpoch = 0, readEpoch = 0;
const pendingThreadUpdates=new Set<string>();let syncingThread=false;
const renderedTurns=new WeakMap<HTMLElement,{turn:Turn;fingerprint:string}>();
function turnFingerprint(turn:Turn,version:string,key?:string){const{interactions,...content}=turn;return `${key}|${version}|${JSON.stringify(content)}`;}
const status = $('status');
const knowledge = createKnowledge({onLocate:(block,version)=>{void locate(block,version);},onNotesChanged:refreshNotes,canStart:()=>!controller,onIdle:()=>{void syncThreadUpdates();}});
function showStatus(text: string, error = false) { status.textContent = text; status.classList.toggle('error', error); }
async function pet(state: string) { if (tabId !== null) await chrome.tabs.sendMessage(tabId, { type: 'PET_STATE', state }).catch(() => {}); }
function busy(value: boolean) {
  for (const element of document.querySelectorAll<HTMLButtonElement | HTMLSelectElement>('#send,#scope,#depth,#refresh,#clear-selection,#quick-actions button,#reexplain')) element.disabled = value;
  $('cancel').hidden = !value; $('send').hidden = value;
}
function reportContext(report: ContextReport) {
  record('context.built', { phase: 'panel', depth: report.depth, scope: report.scope, skill: report.skill, estimatedTokens: report.estimatedTokens, budget: report.budget, blocks: report.blockIds.length, clipped: report.clipped });
  $('context-details').hidden = false;
  $('context-text').textContent = `模式：${report.depth ? DEPTH_LABELS[report.depth] : '未记录'}\n规则：${report.skill}\n范围：${({ passage: '附近段落', article: '当前文章', notes: '文章＋本地笔记' })[report.scope]}\n估算输入：${report.estimatedTokens} / ${report.budget} tokens\n原文片段：${report.blockIds.length}\n关联笔记：${report.notes.length}\n${report.clipped ? '部分材料已节选或未装入，AI 可在范围内按需补读。\n' : ''}${report.blockIds.join('\n')}`;
}
async function locate(block: Block, version: string) {
  if (tabId === null) return;
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'LOCATE', blockId: block.id, version });
    if (!response?.ok) { record('reader.locate.failed', { code: errorCode(new Error(response?.error || '')) }); showStatus(response?.error || '无法定位原文。', true); }
  } catch (error) { record('reader.locate.failed', { code: errorCode(error) }); showStatus('网页已关闭或重新加载，请重新读取。', true); }
}
function renderTurn(turn: Turn, version: string, threadKey?: string) {
  const wrapper = document.createElement('section'); wrapper.className = 'turn';
  const question = document.createElement('p'); question.className = 'question'; question.textContent = turn.displayQuestion || turn.question;
  if(turn.id)wrapper.dataset.turnId=turn.id;
  const mode = document.createElement('div'); mode.className = 'answer-mode';
  if (turn.depth) { mode.textContent = `${turn.surface === 'bubble' ? '气泡 · ' : '侧栏 · '}${DEPTH_LABELS[turn.depth]}`; wrapper.dataset.depth = turn.depth; }
  else mode.hidden = true;
  const answer = document.createElement('div'); answer.className = 'answer';
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  renderAnswer(answer, turn.answer, turn.citations.map(b => b.id), {
    images: turn.images, resolveMedia: getMedia, generateImage, states: turn.interactions,
    onInteraction: (index, state) => {
      turn.interactions = { ...turn.interactions, [String(index)]: state };
      clearTimeout(saveTimer);
      if (threadKey && turn.id) saveTimer = setTimeout(() => { void patchTurn(threadKey,turn.id!,{interactions:turn.interactions}).catch(error => showStatus(error.message, true)); }, 350);
    },
    onImageSaved: async (index, id) => {
      turn.answer = replaceRichImage(turn.answer, index, id);
      renderedTurns.set(wrapper,{turn,fingerprint:turnFingerprint(turn,version,threadKey)});
      if (threadKey && turn.id) await patchTurn(threadKey,turn.id,{answer:turn.answer});
    },
  });
  const sources = document.createElement('div'); sources.className = 'sources';
  turn.citations.forEach((source, i) => {
    const link = button(`↗ 原文 ${i + 1} · ${source.heading.slice(0, 25)}`, () => { void locate(source, version); }, 'source');
    link.title = source.text; sources.append(link);
  });
  turn.relatedNotes?.forEach(note => sources.append(button(`↗ 笔记 · ${note.title.slice(0, 24)}`, () => { void showNotes(); }, 'source')));
  wrapper.append(question, mode, answer, sources);
  if (turn.answer) {
    const adjust = document.createElement('div'); adjust.className = 'explanation-actions'; adjust.setAttribute('aria-label', '调整这次解释');
    const context = `\n此前的问题（仅作背景）：${turn.question.slice(0, 700)}`;
    adjust.append(
      button('拆开符号讲', () => { void ask(`请拆开符号，结合附近原文用白话解释这句话的含义和必要概念。${context}`, 'brief'); }),
      button('符号已懂，讲原理', () => { void ask(`符号含义我已懂，不用再解释名称。请直接结合本段讲清运作原理，再用一个具体小例子验证因果关系。${context}`, 'example'); }),
      button('用小题检验', () => { void ask(`给我一道检验理解的小题：沿用本段原理，只变一个条件，先不告诉答案。${context}`, 'brief'); }),
    ); wrapper.append(adjust);
    if(threadKey) { const actions=document.createElement('div');actions.className='turn-actions';actions.append(button('整理到笔记',()=>saveTurnNote(turn,version,threadKey)));wrapper.append(actions); }
  }
  $('conversation').append(wrapper);
  renderedTurns.set(wrapper,{turn,fingerprint:turnFingerprint(turn,version,threadKey)});
  return { wrapper, answer, sources };
}
function paintConversation(version:string,key:string) {
  const container=$('conversation'),existing=new Map([...container.children].map(node=>[(node as HTMLElement).dataset.turnId,node as HTMLElement]));
  const ids=new Set(turns.map(t=>t.id));
  for(const node of [...container.children])if(!(node as HTMLElement).dataset.turnId||!ids.has((node as HTMLElement).dataset.turnId))node.remove();
  turns.forEach((turn,i)=>{
    const node=turn.id?existing.get(turn.id):undefined,rendered=node?renderedTurns.get(node):undefined;
    if(node?.isConnected&&rendered?.fingerprint===turnFingerprint(turn,version,key)){
      // Keep live demo and image-generation DOM intact when only another message was appended.
      rendered.turn.interactions ||= turn.interactions;turns[i]=rendered.turn;return;
    }
    const fresh=renderTurn(turn,version,key).wrapper;
    if(node?.isConnected)node.replaceWith(fresh);
    else {const position=container.children[i];if(position&&position!==fresh)position.before(fresh);}
  });
  $('reexplain').hidden=!turns.length;
}
async function syncThreadUpdates() {
  if(syncingThread||controller||knowledge.busy||!$('knowledge-view').hidden||tabId===null||!pendingThreadUpdates.size)return;
  const ids=[...pendingThreadUpdates];pendingThreadUpdates.clear();syncingThread=true;
  const requestTab=tabId, requestEpoch=readEpoch;
  try {
    const response=await chrome.tabs.sendMessage(requestTab,{type:'GET_PAGE'});
    if(tabId!==requestTab||readEpoch!==requestEpoch||!response?.page)return;
    if(controller||knowledge.busy||!$('knowledge-view').hidden){ids.forEach(id=>pendingThreadUpdates.add(id));return;}
    const next:PageSnapshot=response.page,key=topicKey(next);
    if(!ids.includes(key))return;
    const loaded=await loadThread(key);
    if(tabId!==requestTab||readEpoch!==requestEpoch)return;
    if(controller||knowledge.busy||!$('knowledge-view').hidden){ids.forEach(id=>pendingThreadUpdates.add(id));return;}
    if(!page||topicKey(page)!==key){clearSelection=false;await renderPage(next);}
    else if(JSON.stringify(turns)!==JSON.stringify(loaded)) {
      const atBottom=document.documentElement.scrollHeight-scrollY-innerHeight<120;
      turns=loaded;paintConversation(next.version,key);
      if(atBottom&&!$('read-view').hidden)requestAnimationFrame(()=>$('conversation').lastElementChild?.scrollIntoView({block:'end'}));
    }
    record('thread.synced',{phase:'panel',turns:loaded.length});
  }catch(error){record('reader.capture.failed',{phase:'panel',code:errorCode(error)});}
  finally{syncingThread=false;if(pendingThreadUpdates.size&&!controller&&!knowledge.busy&&$('knowledge-view').hidden)void syncThreadUpdates();}
}
async function renderPage(next: PageSnapshot, force = false, keepRequest = false) {
  const epoch = ++renderEpoch;
  const nextKey = topicKey(next), changed = !page || topicKey(page) !== nextKey;
  if (changed || force) {
    if (!keepRequest) { controller?.abort(); generation++; controller = null; busy(false); }
    const loaded = await loadThread(nextKey);
    if (epoch !== renderEpoch) return;
    turns = loaded;
    paintConversation(next.version,nextKey);
    $('context-details').hidden = true;
  }
  page = next;
  knowledge.setContext(next,tabId);
  record('reader.captured', { blocks: next.blocks.length, selectionChars: next.selection?.text.length || 0, truncated: next.truncated });
  $('page-title').textContent = next.title;
  $('page-meta').textContent = `${next.blocks.length} 个正文片段 · ${new URL(next.url).hostname}${next.truncated ? ' · 正文较长，已截取前部内容' : ''}`;
  $('selection-card').hidden = !next.selection;
  $('selection-text').textContent = next.selection?.text || '';
  showStatus(next.blocks.length ? '已准备好原文。可以划词解释，或直接问这篇文章。' : '没有识别到正文，请在普通文章网页上重试。', !next.blocks.length);
}
async function maybeExplain(actionId?: string) {
  if (!actionId || controller || !page?.selection) return;
  const key = `action-${tabId}`;
  const previous = await chrome.storage.session.get(key);
  if (previous[key] === actionId) return;
  await chrome.storage.session.set({ [key]: actionId });
  await ask(DEFAULT_READING_QUESTION, 'brief');
}
async function readActive(force=false) {
  const epoch = ++readEpoch;
  ++renderEpoch;
  const current = () => epoch === readEpoch;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!current()) return;
    if (!tab?.id) throw new Error('没有可读取的网页。');
    if (tabId !== tab.id) { controller?.abort(); generation++; controller = null; busy(false); page = null; turns = []; clearSelection = false; $('conversation').replaceChildren(); knowledge.setContext(null,null); }
    tabId = tab.id;
    let response;
    try { response = await chrome.tabs.sendMessage(tabId, { type: 'GET_PAGE' }); }
    catch {
      if (!current()) return;
      const injection = await chrome.runtime.sendMessage({ type: 'INJECT', tabId });
      if (!current()) return;
      if (!injection?.ok) throw new Error(injection?.error || '请点击工具栏中的拾知图标，授权当前网页。');
      response = await chrome.tabs.sendMessage(tabId, { type: 'GET_PAGE' });
    }
    if (!current()) return;
    if (!response?.page) throw new Error('没有获取到网页正文。');
    await renderPage({ ...response.page, selection: clearSelection ? null : response.page.selection },force);
    if (!current()) return;
    const deepKey = `deep-${tabId}`;
    const pending = (await chrome.storage.session.get(deepKey))[deepKey] as { question?: string } | undefined;
    if (!current()) return;
    if (pending?.question && !controller) {
      await chrome.storage.session.remove(deepKey);
      if (!current()) return;
      $<HTMLSelectElement>('depth').value = 'example';
      await ask(`请结合选中段落讲清运作原理，再用一个具体小例子验证。当前按原理＋例子展开。\n此前的问题（仅作背景）：${pending.question}`, 'example');
    }
    if (!current()) return;
    await maybeExplain(response.actionId);
    if (!current()) return;
    const viewKey = `view-${tabId}`;
    const view = (await chrome.storage.session.get(viewKey))[viewKey];
    if (!current()) return;
    if (view === 'notes') { await chrome.storage.session.remove(viewKey); if (!current()) return; await showNotes(); }
    if (!current()) return;
    const knowledgeKey=`knowledge-${tabId}`;
    const knowledgeAction = (await chrome.storage.session.get(knowledgeKey))[knowledgeKey];
    if (!current()) return;
    if(knowledgeAction){await chrome.storage.session.remove(knowledgeKey);if(current())showKnowledge();}
  } catch (error) { if (!current()) return; page = null; knowledge.setContext(null,null); record('reader.capture.failed', { code: errorCode(error) }); showStatus((error as Error).message, true); }
}

async function refreshNotes() { notes = await listNotes(); $('note-count').textContent = String(notes.length); }
function selectView(view:'read'|'knowledge'|'notes') { for(const name of ['read','knowledge','notes']){$(`${name}-view`).hidden=name!==view;$(`${name}-tab`).classList.toggle('active',name===view);} }
function showRead() { selectView('read');void syncThreadUpdates(); }
function showKnowledge(){selectView('knowledge');void knowledge.open();}
async function showNotes() {
  await refreshNotes(); selectView('notes');
  const list = $('notes-list'); list.replaceChildren();
  if (!notes.length) {
    const empty = document.createElement('div'); empty.className = 'empty-state';
    const img = document.createElement('img'); img.src = chrome.runtime.getURL('assets/sprites/dafeiyu-idle.png'); img.alt = '安静等待的陪读宠物';
    const title = document.createElement('strong'); title.textContent = '每弄懂一点，就留下来。';
    const hint = document.createElement('p'); hint.textContent = '回答后的理解会整理在这里。也可以在回答下方手动整理。'; empty.append(img, title, hint); list.append(empty);
  }
  for (const note of notes) {
    const card = document.createElement('article'); card.className = 'note';
    const title = document.createElement('h2'); title.textContent = note.title;
    const body = document.createElement('div'); body.className = 'answer'; renderAnswer(body, note.summary, note.sources.map(b => b.id), { images: note.images, resolveMedia: getMedia, generateImage,
      onImageSaved: async (index, id) => { note.summary = replaceRichImage(note.summary, index, id); await putNote(note); },
    });
    const meta = document.createElement('div'); meta.className = 'note-meta'; meta.textContent = `${new URL(note.url).hostname} · ${new Date(note.updatedAt).toLocaleDateString('zh-CN')} · ${note.questions.length} 个问题`;
    const actions = document.createElement('div'); actions.className = 'turn-actions';
    actions.append(button('编辑', () => {
      const editor = document.createElement('textarea'); editor.value = note.summary; editor.setAttribute('aria-label', '编辑理解笔记'); body.replaceChildren(editor);
      const save = button('保存修改', () => {
        const updated = { ...note, previous: note.summary, summary: editor.value, updatedAt: new Date().toISOString() };
        void putNote(updated).then(showNotes).catch(error => showStatus(error.message, true));
      }); body.append(save); editor.focus();
    }));
    if (note.previous !== null) actions.append(button('撤销上次整理', () => { void putNote({ ...note, summary: note.previous!, previous: null }).then(showNotes); }));
    actions.append(button('导出', () => downloadText(`拾知-${note.id.slice(0, 8)}.md`, exportNotes([note]))));
    actions.append(button('删除', () => { void deleteNote(note.id).then(showNotes); }));
    const source = document.createElement('a'); source.textContent = '打开原网页 ↗'; source.href = note.url; source.target = '_blank'; source.rel = 'noopener noreferrer'; source.className = 'text-button';
    card.append(title, body, meta, actions, source); list.append(card);
  }
}

async function persistNote(pageForTurn: PageSnapshot, turn: Turn, signal: AbortSignal) {
  record('notes.started');
  try {
  await refreshNotes();
  const settings = await getSettings();
  const note = await updateNote(topicKey(pageForTurn), previous => summarizeNote({ page: pageForTurn, question: turn.question, answer: turn.answer, sources: turn.citations, relatedNotes: turn.relatedNotes, previous, settings, signal }), signal);
  await refreshNotes();
  record('notes.saved', { sourceCount: note.sources.length });
  } catch (error) { record('notes.failed', { code: errorCode(error) }); throw error; }
}
function saveTurnNote(turn:Turn,version:string,key:string) {
  if(controller||knowledge.busy)return;
  if(!page||page.version!==version||topicKey(page)!==key){showStatus('请重新读取对应网页后再整理。',true);return;}
  const frozen=structuredClone(page),manual=new AbortController();controller=manual;busy(true);showStatus('正在合并这次理解…');
  const timeout=setTimeout(()=>manual.abort(),90000);
  void persistNote(frozen,turn,manual.signal).then(()=>showStatus('已整理到理解笔记。'),error=>showStatus(error.name==='AbortError'?'已停止整理。':error.message,true))
    .finally(()=>{clearTimeout(timeout);if(controller===manual){controller=null;busy(false);void syncThreadUpdates();}});
}

async function ask(question: string, requestedDepth?: Depth, displayQuestion?:string) {
  if (controller) return;
  if (knowledge.busy) { showStatus('知识讲解正在生成，请完成或停止后再提问。',true); return; }
  if (!question.trim()) return;
  if (!page || tabId === null) { showStatus('先点击工具栏中的拾知图标，读取当前网页。', true); return; }
  const requestId = ++generation, requestTab = tabId, current = new AbortController(); controller = current; busy(true);
  showStatus('正在读取当前问题的上下文…');
  const started = Date.now();
  if (requestedDepth) $<HTMLSelectElement>('depth').value = requestedDepth;
  const depth = $<HTMLSelectElement>('depth').value as Depth;
  record('reading.started', { phase: 'panel', scope: $<HTMLSelectElement>('scope').value, depth });
  const timer = setTimeout(() => current.abort(), 150000);
  let completedTurn: Turn | null = null;
  try {
    // Re-read immediately before every turn. Never answer against a stale page snapshot.
    const latest = await chrome.tabs.sendMessage(requestTab, { type: 'GET_PAGE' });
    current.signal.throwIfAborted(); if (generation !== requestId) return;
    if (!latest?.page) throw new Error('无法读取网页，请重新开启陪读。');
    if (latest.page.url !== page.url || latest.page.version !== page.version) throw new Error('网页内容已变化，请点击“重新读取”后再提问。');
    const frozen = structuredClone({ ...latest.page, selection: clearSelection ? null : latest.page.selection }) as PageSnapshot;
    await renderPage(frozen, false, true);
    current.signal.throwIfAborted(); if (generation !== requestId) return;
    const settings = await getSettings();
    if (!settings.model) throw new Error('先点击右上角设置，填写 API 地址、密钥和模型名称。');
    const pending = renderTurn({ question, displayQuestion, answer: '', citations: [], depth, surface: 'panel' }, frozen.version);
    const scope = $<HTMLSelectElement>('scope').value as Scope;
    showStatus('正在结合原文理解…'); await pet('thinking');
    const result = await runReading({ page: frozen, question, scope, depth, turns, notes: await listNotes(), settings, signal: current.signal,
      onText: text => { if (generation === requestId) renderAnswer(pending.answer, text, [], { preview: true }); },
      onStatus: text => { if (generation === requestId) showStatus(text); },
      onContext: report => { if (generation === requestId) reportContext(report); },
    });
    current.signal.throwIfAborted(); if (generation !== requestId) return;
    completedTurn = { question, ...(displayQuestion?{displayQuestion}:{}), answer: result.answer, citations: result.sources, scope, depth, surface: 'panel', relatedNotes: result.relatedNotes, images: frozen.images };
    record('reading.completed', { phase: 'panel', depth, durationMs: Date.now() - started, outputChars: result.answer.length, sourceCount: result.sources.length });
    turns=await appendTurn(topicKey(frozen),completedTurn);
    current.signal.throwIfAborted();if(generation!==requestId)return;
    pending.wrapper.remove();paintConversation(frozen.version,topicKey(frozen));
    await pet('answering');
    if (settings.autoNotes) { showStatus('解释完成，正在合并理解笔记…'); await persistNote(frozen, completedTurn, current.signal); }
    if (generation === requestId) showStatus(settings.autoNotes ? '这次理解已留下。可以继续阅读，或围绕这一处追问。' : '解释完成。可以继续追问，或手动整理到笔记。');
  } catch (error) {
    record((error as Error).name === 'AbortError' ? 'reading.cancelled' : 'reading.failed', { durationMs: Date.now() - started, code: errorCode(error) });
    if (generation === requestId) {
      const e = error as Error;
      showStatus(e.name === 'AbortError' ? (completedTurn ? '解释已完成；笔记整理已停止。' : '已停止本次解释，未保存不完整回答。') : (completedTurn ? `解释已完成，笔记未更新：${e.message}` : e.message), e.name !== 'AbortError');
      await pet(e.name === 'AbortError' ? 'idle' : 'error');
    }
  } finally {
    clearTimeout(timer);
    if (generation === requestId) { controller = null; busy(false);void syncThreadUpdates(); }
  }
}

$('settings').onclick = () => { void chrome.runtime.openOptionsPage(); };
$('refresh').onclick = () => { clearSelection = false; void readActive(true); };
$('clear-selection').onclick = () => { if (page) { clearSelection = true; void renderPage({ ...page, selection: null }); } };
$('read-tab').onclick = showRead;
$('knowledge-tab').onclick = showKnowledge;
$('knowledge-open').onclick = showKnowledge;
$('notes-tab').onclick = () => { void showNotes(); };
$('export-notes').onclick = () => downloadText('拾知-理解笔记.md', exportNotes(notes));
$('cancel').onclick = () => controller?.abort();
$('depth').onchange=()=>{const depth=$<HTMLSelectElement>('depth').value as Depth;$('mode-hint').textContent=`已选择“${DEPTH_LABELS[depth]}”。新提问按此方式回答；也可点击下方按钮重讲上一问。`;$('reexplain').hidden=!turns.length;};
$('reexplain').onclick=()=>{const previous=turns.at(-1);if(!previous||controller)return;const depth=$<HTMLSelectElement>('depth').value as Depth;void ask(`请按本次选中的解释方式重新回答此前的问题；此前的回答长度要求不沿用。\n此前的问题（仅作背景）：${previous.question.slice(0,1100)}`,depth,`重新讲解：${(previous.displayQuestion||previous.question).replace(/^重新讲解：/,'').slice(0,120)}`);};
$('ask-form').addEventListener('submit', event => { event.preventDefault(); const input = $<HTMLTextAreaElement>('question'); const text = input.value.trim(); if (!text || controller) return; input.value = ''; void ask(text); });
$('question').addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); $<HTMLFormElement>('ask-form').requestSubmit(); } });
document.querySelectorAll<HTMLButtonElement>('[data-prompt]').forEach(el => { el.onclick = () => { void ask(el.dataset.prompt!); }; });
chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.id !== chrome.runtime.id || sender.tab?.id !== tabId || message?.type !== 'PAGE_SELECTION') return;
  clearSelection = false; showRead();
  void renderPage(message.page).then(() => maybeExplain(message.actionId));
});
chrome.storage.onChanged.addListener((changes, area) => {
  const update=changes.threadChanged?.newValue as {id?:string;writer?:string}|undefined;
  if(area==='session'&&typeof update?.id==='string'&&update.writer!==THREAD_WRITER&&!update.id.startsWith('knowledge-')){pendingThreadUpdates.add(update.id);void syncThreadUpdates();}
  if (area === 'session' && tabId !== null && (changes[`deep-${tabId}`]?.newValue || changes[`view-${tabId}`]?.newValue || changes[`knowledge-${tabId}`]?.newValue)) { clearSelection = false; showRead(); void readActive(); }
});
chrome.tabs.onActivated.addListener(() => { void readActive(); });
chrome.tabs.onUpdated.addListener((id, change) => {
  if (id === tabId && (change.url || change.status === 'loading')) {
    ++readEpoch; ++renderEpoch;
    controller?.abort(); generation++; controller = null; busy(false); page = null; turns = []; clearSelection = false;
    knowledge.setContext(null,null);
    $('conversation').replaceChildren(); $('selection-card').hidden = true; $('context-details').hidden = true;
    $('page-title').textContent = '网页已切换'; showStatus('正在等待网页载入…');
  }
  if (id === tabId && change.status === 'complete') void readActive();
});
void refreshNotes().catch(error => showStatus(error.message, true));
void readActive();
