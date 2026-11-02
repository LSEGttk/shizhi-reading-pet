import type { Block, Note, PageSnapshot, Scope, Turn } from '../types';
import { runKnowledge, knowledgeThreadKey } from '../agent/knowledge';
import { topicKey } from '../agent/run';
import { appendTurn, getMedia, getSettings, listNotes, loadThread, patchTurn, putNote } from '../storage/local';
import { button, renderAnswer, replaceRichImage } from './render';
import { generateImage } from '../providers/images';
import { KNOWLEDGE_SECTIONS } from '../core/knowledge';
import { errorCode, record } from '../diagnostics';

export function createKnowledge(actions: { onLocate:(block:Block, version:string)=>void; onNotesChanged:()=>Promise<void>; canStart:()=>boolean;onIdle?:()=>void }) {
  const $ = <T extends HTMLElement>(id:string) => document.getElementById(id) as T;
  const topicInput = $<HTMLInputElement>('knowledge-topic'), status = $('knowledge-status'), conversation = $('knowledge-conversation');
  let page:PageSnapshot|null = null, tabId:number|null = null, turns:Turn[] = [], key = '', epoch = 0;
  let controller:AbortController|null = null, generation = 0, contextKey = '', loading:Promise<void> = Promise.resolve();
  const showStatus = (message:string, error=false) => { status.textContent = message; status.classList.toggle('error',error); };
  function busy(value:boolean) {
    for(const element of document.querySelectorAll<HTMLInputElement|HTMLButtonElement|HTMLSelectElement>('#knowledge-topic,#knowledge-scope,#knowledge-start,#knowledge-followup-send,#knowledge-from-selection')) element.disabled=value;
    $('knowledge-cancel').hidden=!value;
  }
  function showTurn(turn:Turn, thread:Turn[], threadKey:string, version:string) {
    const wrapper=document.createElement('article'); wrapper.className='turn knowledge-turn';
    const question=document.createElement('p');question.className='question';question.textContent=turn.question;
    const answer=document.createElement('div');answer.className='answer';
    let timer:ReturnType<typeof setTimeout>|undefined;
    renderAnswer(answer,turn.answer,turn.citations.map(b=>b.id),{
      images:turn.images,resolveMedia:getMedia,generateImage,states:turn.interactions,
      onInteraction:(index,state)=>{turn.interactions={...turn.interactions,[String(index)]:state};clearTimeout(timer);timer=setTimeout(()=>{if(turn.id)void patchTurn(threadKey,turn.id,{interactions:turn.interactions}).catch(error=>showStatus(error.message,true));},350);},
      onImageSaved:async(index,id)=>{turn.answer=replaceRichImage(turn.answer,index,id);if(turn.id)await patchTurn(threadKey,turn.id,{answer:turn.answer});},
    });
    const sections=document.createElement('nav');sections.className='knowledge-section-links';sections.setAttribute('aria-label','知识讲解章节');
    KNOWLEDGE_SECTIONS.forEach(title=>{const heading=[...answer.querySelectorAll<HTMLElement>('h2,h3')].find(h=>h.textContent?.trim()===title);if(heading)sections.append(button(title,()=>heading.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'start'})));});
    const sources=document.createElement('div');sources.className='sources';
    turn.citations.forEach((source,i)=>sources.append(button(`↗ 原文 ${i+1} · ${source.heading.slice(0,22)}`,()=>actions.onLocate(source,version),'source')));
    turn.relatedNotes?.forEach(note=>{const link=document.createElement('a');link.href=note.url;link.textContent=`↗ 关联笔记来源 · ${note.title.slice(0,22)}`;link.target='_blank';link.rel='noopener noreferrer';link.className='source';sources.append(link);});
    const controls=document.createElement('div');controls.className='turn-actions';
    const save=button('保存为理解笔记',()=>{void saveNote(turn,threadKey,version,save).catch(error=>showStatus(error.message,true));});controls.append(save);
    wrapper.append(question,sections,answer,sources,controls);conversation.append(wrapper);return wrapper;
  }
  async function saveNote(turn:Turn, threadKey:string, version:string, save:HTMLButtonElement) {
    if(!page||version!==page.version||threadKey!==key)return;
    save.disabled=true;showStatus('正在保存完整讲解…');
    try {
      const frozen=structuredClone(page),title=topicInput.value.trim(),previous=(await listNotes()).find(n=>n.topicKey===threadKey);
      if(!page||version!==page.version||threadKey!==key)return;
      const through=turns.slice(0,turns.findIndex(t=>t.id===turn.id)+1);let overview=-1;
      through.forEach((t,i)=>{if(t.question.startsWith('完整讲解：'))overview=i;});
      const selected=overview>=0?through.slice(overview):[turn];
      const summary=overview>=0?selected.map(t=>t.question.startsWith('完整讲解：')?t.answer:`### 追问：${t.question}\n\n${t.answer}`).join('\n\n'):previous?.summary?(previous.summary.includes(turn.answer)?previous.summary:`${previous.summary}\n\n### 追问：${turn.question}\n\n${turn.answer}`):turn.answer;
      const sources=[...new Map([...(overview<0?previous?.sources||[]:[]),...selected.flatMap(t=>t.citations)].map(b=>[b.id,b])).values()];
      const images=[...new Map([...(previous?.images||[]),...selected.flatMap(t=>t.images||[])].map(i=>[i.id,i])).values()].slice(0,24);
      const relatedNotes=[...new Map([...(previous?.relatedNotes||[]),...selected.flatMap(t=>t.relatedNotes||[])].map(n=>[n.id,n])).values()];
      const note:Note={id:previous?.id||crypto.randomUUID(),topicKey:threadKey,title:`知识讲解 · ${title.slice(0,60)}`,url:frozen.url,pageVersion:version,selection:frozen.selection,summary,questions:[...new Set([...(previous?.questions||[]),...selected.map(t=>t.question)])].slice(-30),sources,updatedAt:new Date().toISOString(),previous:previous?.summary||null,relatedNotes,images};
      await putNote(note);await actions.onNotesChanged();save.textContent='已保存到理解笔记';showStatus('已保存完整讲解，可在理解笔记中编辑、撤销和导出。');
    }catch(error){showStatus((error as Error).message,true);}finally{save.disabled=false;}
  }
  async function loadTopic() {
    const current=++epoch;
    if(!page||!topicInput.value.trim()){key='';turns=[];conversation.replaceChildren();$('knowledge-followup-form').hidden=true;return;}
    const nextKey=knowledgeThreadKey(page,topicInput.value),version=page.version;
    if(nextKey===key)return;
    const loaded=await loadThread(nextKey);
    if(epoch!==current)return;
    key=nextKey;turns=loaded;conversation.replaceChildren();turns.forEach(turn=>showTurn(turn,turns,key,version));$('knowledge-followup-form').hidden=!turns.length;
    const lastScope=turns.at(-1)?.scope;
    if(lastScope==='article'||lastScope==='passage'||lastScope==='notes')$<HTMLSelectElement>('knowledge-scope').value=lastScope;
    await chrome.storage.session.set({[`knowledge-topic-${topicKey(page)}`]:topicInput.value.trim()});
    if(epoch!==current)return;
    showStatus(turns.length?'已恢复这个知识点的讲解，可以继续追问。':'点击“开始讲解”，按定义、原理、例子和延伸展开。');
  }
  function cancel(){controller?.abort();}
  function invalidate() { cancel();generation++;controller=null;busy(false);epoch++;key='';turns=[];conversation.replaceChildren();$('knowledge-followup-form').hidden=true;$<HTMLTextAreaElement>('knowledge-question').value=''; }
  function setContext(next:PageSnapshot|null, nextTabId:number|null) {
    const nextContext=next?`${nextTabId}|${topicKey(next)}`:'';
    if(nextContext===contextKey){page=next;tabId=nextTabId;return;}
    contextKey=nextContext;invalidate();page=next;tabId=nextTabId;
    topicInput.value=next?(next.selection?.text||next.title).slice(0,160):'';
    $('knowledge-context-title').textContent=next?.title||'先打开一篇文章';
    $('knowledge-selection').textContent=next?.selection?.text||'可在文章中选中一处，也可直接填写一个知识点。';
    loading=(async()=>{
      if(next){const storageKey=`knowledge-topic-${topicKey(next)}`,saved=(await chrome.storage.session.get(storageKey))[storageKey];if(contextKey!==nextContext)return;if(typeof saved==='string'&&saved.trim()&&saved.length<=160)topicInput.value=saved;}
      await loadTopic();
    })().catch(error=>showStatus(error.message,true));
    if(!next)showStatus('点击工具栏中的拾知图标，读取文章后再打开知识讲解。');
  }
  async function ask(followup='') {
    if(controller)return;
    if(!actions.canStart()){showStatus('当前阅读解释还在生成，请完成或停止后再开始知识讲解。',true);return;}
    if(!page||tabId===null){showStatus('先读取当前文章，再开始知识讲解。',true);return;}
    await loading;
    if(!page||tabId===null)return;
    const topic=topicInput.value.trim();if(!topic){topicInput.reportValidity();return;}
    loading=loadTopic();await loading;
    if(controller||!page||tabId===null)return;
    const frozen=structuredClone(page),requestTab=tabId,requestKey=key,thread=turns,requestId=++generation,current=new AbortController();controller=current;busy(true);
    const timeout=setTimeout(()=>current.abort(),150000),started=Date.now();let pending:HTMLElement|null=null;
    try {
      const latest=await chrome.tabs.sendMessage(requestTab,{type:'GET_PAGE'});
      current.signal.throwIfAborted();if(requestId!==generation)return;
      if(!latest?.page||latest.page.url!==frozen.url||latest.page.version!==frozen.version)throw new Error('网页内容已变化，请回到陪我读重新读取。');
      const settings=await getSettings();if(!settings.model)throw new Error('先在模型设置中连接聊天模型。');
      const scope=$<HTMLSelectElement>('knowledge-scope').value as Scope;
      record('reading.started',{phase:'panel',module:'knowledge',scope,depth:'deep'});
      pending=document.createElement('div');pending.className='answer knowledge-pending';conversation.append(pending);
      showStatus('正在围绕这个知识点组织讲解…');
      const readingTurns=await loadThread(topicKey(frozen));
      const result=await runKnowledge({page:frozen,topic,followup,scope,turns:thread,readingTurns,notes:await listNotes(),settings,signal:current.signal,
        onText:text=>{if(generation===requestId&&pending)renderAnswer(pending,text,[],{preview:true});},
        onStatus:text=>{if(generation===requestId)showStatus(text);},
        onContext:report=>{if(generation!==requestId)return;$('knowledge-context-details').hidden=false;$('knowledge-context-report').textContent=`范围：${scope==='passage'?'只看附近':scope==='notes'?'文章＋笔记':'当前文章'}\n原文片段：${report.blockIds.length}\n估算输入：${report.estimatedTokens} / ${report.budget} tokens\n规则：${report.skill}`;record('context.built',{phase:'panel',module:'knowledge',scope,depth:'deep',skill:report.skill,blocks:report.blockIds.length,estimatedTokens:report.estimatedTokens,budget:report.budget});},
      });
      current.signal.throwIfAborted();if(generation!==requestId)return;
      const turn:Turn={question:followup||`完整讲解：${topic}`,answer:result.answer,citations:result.sources,scope,depth:'deep',surface:'panel',module:'knowledge',relatedNotes:result.relatedNotes,images:frozen.images};
      const saved=await appendTurn(requestKey,turn);thread.splice(0,thread.length,...saved);if(generation!==requestId)return;pending.remove();pending=null;showTurn(turn,thread,requestKey,frozen.version);$('knowledge-followup-form').hidden=false;
      record('reading.completed',{phase:'panel',module:'knowledge',depth:'deep',durationMs:Date.now()-started,outputChars:result.answer.length,sourceCount:result.sources.length});
      showStatus('讲解已保存在这个知识点的对话中。可继续追问，或保存为理解笔记。');
    }catch(error){if(generation===requestId){pending?.remove();showStatus(current.signal.aborted?'已停止，未保存不完整讲解。':(error as Error).message,!current.signal.aborted);record(current.signal.aborted?'reading.cancelled':'reading.failed',{phase:'panel',module:'knowledge',code:errorCode(error)});}}
    finally{clearTimeout(timeout);if(generation===requestId){controller=null;busy(false);actions.onIdle?.();}}
  }
  $('knowledge-overview-form').addEventListener('submit',event=>{event.preventDefault();void ask().catch(error=>showStatus(error.message,true));});
  $('knowledge-followup-form').addEventListener('submit',event=>{event.preventDefault();const input=$<HTMLTextAreaElement>('knowledge-question'),question=input.value.trim();if(!question||controller)return;input.value='';void ask(question).catch(error=>showStatus(error.message,true));});
  $('knowledge-cancel').onclick=cancel;
  topicInput.addEventListener('change',()=>{loading=loadTopic().catch(error=>showStatus(error.message,true));});
  $('knowledge-from-selection').onclick=()=>{if(!page)return;topicInput.value=(page.selection?.text||page.title).slice(0,160);loading=loadTopic().catch(error=>showStatus(error.message,true));};
  window.addEventListener('pagehide',cancel);
  return {setContext,cancel,get busy(){return controller!==null;},open(){return loading;}};
}
