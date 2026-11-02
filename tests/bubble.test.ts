import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectBubble } from '../src/agent/bubble.ts';

test('invalid bubble requests finish explicitly so the content client can retry', () => {
  const original = globalThis.chrome;
  globalThis.chrome = { runtime:{id:'test-extension'} } as unknown as typeof chrome;
  let receive: (message: unknown) => void = () => {};
  const sent: {type:string}[] = [];
  const port = { name:'reading-pet',sender:{id:'test-extension',tab:{id:1},frameId:0,url:'https://example.org/article'},
    onMessage:{addListener:(handler:typeof receive)=>{receive=handler;}},onDisconnect:{addListener:()=>{}},postMessage:(message:{type:string})=>sent.push(message) };
  try {
    connectBubble(port as unknown as chrome.runtime.Port);
    receive({type:'ASK',question:'',page:{}});
    receive({type:'ASK',question:'解释',page:{url:'https://example.org/article',version:'v',title:'长'.repeat(2001),blocks:[]}});
    assert.deepEqual(sent.map(m=>m.type), ['ERROR','DONE','ERROR','DONE']);
  } finally { globalThis.chrome = original; }
});
