import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {knowledgeReviewReason} from '../src/core/knowledge.ts';
import {runKnowledge,knowledgeThreadKey} from '../src/agent/knowledge.ts';
import {topicKey} from '../src/agent/run.ts';
import {DEFAULT_SETTINGS} from '../src/storage/local.ts';
import type {PageSnapshot,Turn} from '../src/types.ts';
const page:PageSnapshot={url:'https://example.org/embedding',title:'Embedding',version:'v1',capturedAt:'',truncated:false,blocks:[{id:'p-embed-0',heading:'Embedding',kind:'paragraph',text:'输入编号为B×T，每个位置查表取出D维向量，输出为B×T×D。参数表为词表大小×D。'}],selection:{text:'B×T×D',blockIds:['p-embed-0'],prefix:'',suffix:''}};
const complete='## 定义\n这是本次输入取出的向量排列，B是样本数，T是位置数，D是宽度。[p-embed-0]\n\n## 原理\n因为每个位置的一个编号被替换成D个数，所以原样本和位置轴保留，末尾再增加向量轴。[p-embed-0]\n\n## 例子\n例如假设B=2、T=3、D=4，6个编号各取出4个数，得到2×3×4的排列。\n\n## 延伸\n参数表是词表大小×D，与本次输入的输出尺寸不同；改变批次大小不会扩大参数表。[p-embed-0]';
test('knowledge overview requires four substantive sections, a mechanism and a concrete example',()=>{
 assert.equal(knowledgeReviewReason(complete),null);
 assert.equal(knowledgeReviewReason(complete.replace('## 延伸','## 其他')),'missing_sections');
 assert.equal(knowledgeReviewReason('## 定义\n## 原理\n## 例子\n## 延伸'),'missing_sections');
 assert.equal(knowledgeReviewReason('```md\n'+complete+'\n```'),'missing_sections');
});
test('knowledge topic keys isolate topics and preserve the existing reading thread key',()=>{
 const reading=topicKey(page),key=knowledgeThreadKey(page,'Embedding');
 assert.notEqual(key,reading);assert.notEqual(key,knowledgeThreadKey(page,'分词'));assert.equal(key,knowledgeThreadKey(page,' Embedding '));
});
async function scenario(outputs:string[],followup='',turns:Turn[]=[]){
 const originalFetch=globalThis.fetch, originalChrome=(globalThis as any).chrome, requests:any[]=[];
 (globalThis as any).chrome={runtime:{getURL:(path:string)=>`https://extension.example/${path}`,sendMessage:async()=>({})},permissions:{contains:async()=>true}};
 globalThis.fetch=async(url,init)=>{
  if(String(url).startsWith('https://extension.example/skills/'))return new Response(readFileSync(new URL(`../${String(url).replace('https://extension.example/','')}`,import.meta.url),'utf8'));
  requests.push(JSON.parse(String(init?.body)));const output=outputs[requests.length-1];assert.equal(typeof output,'string');
  return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{role:'assistant',content:output}}]}),{headers:{'Content-Type':'application/json'}});
 };
 try{return {result:await runKnowledge({page,topic:'Embedding输出',followup,scope:'passage',turns,notes:[],settings:{...DEFAULT_SETTINGS,model:'mock',tools:true},signal:new AbortController().signal,onText:()=>{},onStatus:()=>{},onContext:()=>{}}),requests};}
 finally{globalThis.fetch=originalFetch;(globalThis as any).chrome=originalChrome;}
}
test('knowledge overview loads its own skill and repairs incomplete sections at most once',async()=>{
 const {result,requests}=await scenario(['只说定义，不讲原理。',complete]);
 assert.equal(requests.length,2);const packet=JSON.parse(requests[0].messages[1].content);
 assert.equal(packet.module,'knowledge');assert.equal(packet.knowledgeOverview,true);assert.equal(packet.scope,'passage');
 assert.equal(requests[0].tools,undefined);assert.ok(requests[0].messages[0].content.includes('## 定义'));
 assert.ok(!requests[0].messages[0].content.includes('像一本写得清楚的教科书'));
 assert.equal(JSON.parse(requests[1].messages[1].content).reason,'missing_sections');
 assert.equal(result.answer,complete);assert.equal(result.report.module,'knowledge');assert.deepEqual(result.sources.map(b=>b.id),['p-embed-0']);
});
test('knowledge follow-up can answer one part without forcing another four-part lesson',async()=>{
 const {result,requests}=await scenario(['D是一个位置对应的向量中有多少个数。[p-embed-0]'],'只解释D是什么意思。',[{question:'完整讲解',answer:complete,citations:[],scope:'passage',module:'knowledge'}]);
 assert.equal(requests.length,1);const packet=JSON.parse(requests[0].messages[1].content);assert.equal(packet.knowledgeOverview,false);
 assert.equal(packet.recentConversation.length,1);assert.ok(result.answer.startsWith('D是'));
});
