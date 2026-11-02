import type { ImageSettings, Note, Settings, Turn } from '../types';
import { hash } from '../core/text';
export const THREAD_WRITER=crypto.randomUUID();

export const DEFAULT_IMAGE_SETTINGS: ImageSettings = { enabled: false, baseUrl: '', apiKey: '', model: '', size: '1024x1024' };

export const DEFAULT_SETTINGS: Settings = {
  baseUrl: 'https://api.deepseek.com', apiKey: '', model: '', tools: true,
  inputBudget: 12000, maxOutput: 800, autoNotes: true,
  reviewAnswers: true,
};
export async function getSettings(): Promise<Settings> {
  const { settings } = await chrome.storage.local.get('settings');
  const saved = settings && typeof settings === 'object' ? settings as Partial<Settings> : {};
  return { ...DEFAULT_SETTINGS, ...saved, image: { ...DEFAULT_IMAGE_SETTINGS, ...saved.image } };
}
export async function saveSettings(settings: Settings) { await chrome.storage.local.set({ settings }); }

let database: Promise<IDBDatabase> | null = null;
function db() {
  database ||= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('reading-pet', 2);
    request.onupgradeneeded = () => {
      for (const name of ['notes', 'threads', 'media']) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath: 'id' });
    };
    request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); database = null; }; resolve(request.result); }; request.onerror = () => { database = null; reject(request.error); };
  });
  return database;
}
async function transaction<T>(store: string, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(store, mode), request = run(tx.objectStore(store));
    tx.oncomplete = () => resolve(request.result); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  });
}
export async function listNotes(): Promise<Note[]> { return (await transaction<Note[]>('notes', 'readonly', s => s.getAll())).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
const noteLock = (topic: string) => `reading-pet-note:${topic}`;
export async function putNote(note: Note) {
  await navigator.locks.request(noteLock(note.topicKey), () => transaction('notes', 'readwrite', s => s.put(note)));
}
// The read, model merge, and write share one cross-context lock. A second
// tab/worker reads the previous writer's result rather than overwriting it.
export async function updateNote(topic: string, build: (previous: Note | undefined) => Promise<Note>, signal: AbortSignal) {
  return navigator.locks.request(noteLock(topic), { signal }, async () => {
    signal.throwIfAborted();
    const previous = (await listNotes()).find(n => n.topicKey === topic);
    const note = await build(previous);
    signal.throwIfAborted();
    if (note.topicKey !== topic) throw new Error('笔记话题不匹配，未保存。');
    await transaction('notes', 'readwrite', s => s.put(note));
    return note;
  });
}
export async function deleteNote(id: string) { await transaction('notes', 'readwrite', s => s.delete(id)); }
function identifyTurns(id:string, turns:Turn[]) {
  return turns.map((turn,i)=>turn.id?turn:{...turn,id:`legacy-${hash(`${id}|${i}|${turn.question}|${turn.answer}`)}`});
}
async function announceThread(id:string) {
  // Only opaque identity/revision metadata; page content and credentials stay out of the signal.
  await chrome.storage.session.set({threadChanged:{id,revision:crypto.randomUUID(),writer:THREAD_WRITER}}).catch(()=>{});
}
export async function loadThread(id: string): Promise<Turn[]> { return identifyTurns(id,(await transaction<{ turns: Turn[] } | undefined>('threads', 'readonly', s => s.get(id)))?.turns || []); }
async function mutateThread(id:string, mutate:(turns:Turn[])=>Turn[]):Promise<Turn[]> {
  const database=await db();
  const saved=await new Promise<Turn[]>((resolve,reject)=>{
    const tx=database.transaction('threads','readwrite'),store=tx.objectStore('threads'),request=store.get(id);let next:Turn[]=[];
    request.onsuccess=()=>{try{next=mutate(identifyTurns(id,request.result?.turns||[])).slice(-12);store.put({id,turns:next});}catch(error){tx.abort();reject(error);}};
    tx.oncomplete=()=>resolve(next);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('对话未保存。'));
  });
  await announceThread(id);return saved;
}
export async function appendTurn(id:string, turn:Turn) {
  turn.id ||= crypto.randomUUID();
  return mutateThread(id,current=>current.some(t=>t.id===turn.id)?current:[...current,turn]);
}
export async function patchTurn(id:string, turnId:string, patch:Pick<Partial<Turn>,'answer'|'interactions'>) {
  return mutateThread(id,current=>{
    if(!current.some(t=>t.id===turnId))throw new Error('这条对话已不在最近记录中，请重新打开后再试。');
    return current.map(turn=>turn.id===turnId?{...turn,...patch}:turn);
  });
}
export interface Media { id: string; url: string; alt: string; createdAt: string; generated: boolean }
export async function saveMedia(media: Media) { await transaction('media', 'readwrite', s => s.put(media)); }
export async function getMedia(id: string): Promise<Media | undefined> { return transaction('media', 'readonly', s => s.get(id)); }
export function exportNotes(notes: Note[]) {
  return notes.map(n => `# ${n.title}\n\n${n.summary}\n\n## 阅读问题\n${n.questions.map(q => `- ${q}`).join('\n')}\n\n## 原文来源\n${n.url}\n正文版本：${n.pageVersion}\n${n.sources.map(b => `\n[${b.id}] ${b.text}`).join('\n')}\n${n.relatedNotes?.map(note => `\n关联笔记 [n-${note.id}] ${note.title} — ${note.url}`).join('') || ''}\n\n整理于 ${n.updatedAt}`).join('\n\n---\n\n');
}
