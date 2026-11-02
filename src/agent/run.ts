import type { Block, ContextReport, Depth, Note, PageSnapshot, Scope, Settings, ToolDefinition, Turn, ChatMessage } from '../types';
import { buildContext, relatedNotes, searchBlocks } from '../core/context';
import { estimateTokens, fitText, hash } from '../core/text';
import { complete } from '../providers/chat';
import { cleanBriefOpening, reviewReason, visibleAnswer } from '../core/quality';
import { ANSWER_BOUNDARY_RULE, compatibleHistory, depthContract, explicitShortRequest } from '../core/learning';
import { knowledgeReviewReason } from '../core/knowledge';
import { record } from '../diagnostics';

const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolDefinition => ({
  type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
});
export function toolsFor(scope: Scope): ToolDefinition[] {
  if (scope === 'passage') return [];
  const result = [
    tool('searchPage', '在当前文章中搜索定义、论据或相关段落。返回段落原文和可引用的 ID。', { query: { type: 'string' } }, ['query']),
    tool('readSection', '读取一个已知段落及其前后段落，以补全语境。', { blockId: { type: 'string' } }, ['blockId']),
    tool('getPageOutline', '获取当前文章的小节标题和段落 ID。', {}, []),
  ];
  if (scope === 'notes') result.push(tool('searchNotes', '搜索用户保存的本地笔记。引用笔记用 [n-笔记ID]，不能把笔记当成当前文章原文。', { query: { type: 'string' } }, ['query']));
  return result;
}

export async function loadSkill(name: string): Promise<string> {
  if (!['reading', 'formula', 'notes', 'teaching', 'contextual', 'knowledge', 'refine', 'presentation'].includes(name)) throw new Error('未知的陪读规则。');
  const response = await fetch(chrome.runtime.getURL(`skills/${name}/SKILL.md`), { cache: 'no-store' });
  if (!response.ok) throw new Error('无法读取内置陪读规则，请重新构建扩展。');
  return (await response.text()).replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '').trim();
}

export interface RunInput {
  page: PageSnapshot; question: string; scope: Scope; depth: Depth; turns: Turn[]; notes: Note[];
  settings: Settings; signal: AbortSignal;
  module?: 'knowledge'; knowledgeOverview?: boolean;
  onText: (text: string) => void; onStatus: (text: string) => void; onContext: (report: ContextReport) => void;
}
export async function runReading(input: RunInput): Promise<{ answer: string; sources: Block[]; relatedNotes: { id: string; title: string; url: string }[]; report: ContextReport }> {
  const { page, settings, signal, question, scope } = input;
  const focusText = page.blocks.filter(b => page.selection?.blockIds.includes(b.id)).map(b => `${b.heading} ${b.text}`).join(' ').slice(0, 3000);
  const formula = /[∑∂∇∈ℝ×]|\\(?:frac|mathbf|mathbb)|矩阵|参数|张量|维度|公式|梯度|matrix|tensor|weight|\bW\s*[=:∈]/i.test(`${page.selection?.text || ''} ${question} ${focusText}`);
  const knowledge = input.module === 'knowledge';
  const modeSkill=knowledge?'knowledge':input.depth==='context'?'contextual':input.depth==='brief'?null:'teaching';
  const skillName = `${formula ? 'reading + formula' : 'reading'}${modeSkill?` + ${modeSkill}`:''}`;
  const skills = ['reading', ...(formula ? ['formula'] : []), ...(modeSkill ? [modeSkill, 'presentation'] : [])];
  const skill = (await Promise.all(skills.map(loadSkill))).join('\n\n');
  const definitions = settings.tools ? toolsFor(scope) : [];
  const built = buildContext({ ...input, budget: settings.inputBudget, skill, skillName, tools: definitions });
  const { messages, report } = built;
  const available = new Map(built.sources.map(b => [b.id, b]));
  input.onContext(report);
  let calls = 0;
  for (let round = 0; round <= 2; round++) {
    signal.throwIfAborted();
    const activeTools = round < 2 && calls < 4 ? definitions : [];
    if (!activeTools.length && round > 0) messages.push({ role: 'user', content: '补读次数已到上限，请基于已获取的材料回答；不足以判断时明确说明。' });
    if (estimateTokens(JSON.stringify({ messages, tools: activeTools })) + 200 > settings.inputBudget) throw new Error('补读材料超过本次上下文预算，请缩小范围或提高预算。');
    let output = '';
    const message = await complete(settings, messages, activeTools, signal, chunk => { output += chunk; if (input.depth !== 'brief') input.onText(output); });
    if (!message.tool_calls?.length) {
      if (!message.content?.trim()) throw new Error('模型没有返回解释。');
      if (input.depth === 'brief') message.content = cleanBriefOpening(message.content);
      const sameBrief=!knowledge&&input.depth!=='brief'&&!explicitShortRequest(question)&&compatibleHistory(input.turns,scope).slice(-4).some(t=>(t.depth==='brief'||t.surface==='bubble')&&visibleAnswer(t.answer).replace(/\s/g,'')===visibleAnswer(message.content!).replace(/\s/g,''));
      const reason = settings.reviewAnswers !== false ? reviewReason(message.content, [...available.values()], input.depth, question) || (knowledge && input.knowledgeOverview ? knowledgeReviewReason(message.content) : null) || (sameBrief?'repeated_brief':null) : null;
      if (reason) {
        record('answer.review.started', { reason, depth: input.depth });
        input.onStatus(reason === 'missing_sections' ? '正在补齐定义、原理、例子和延伸…' : reason === 'missing_example' ? '正在补上能说明原理的小例子…' : reason === 'missing_mechanism' ? '正在结合这一段补清运作原理…' : '正在检查解释是否讲到点上…');
        const reviewSources = [...available.values()].sort((a, b) => Number(message.content!.includes(`[${b.id}]`) || !!page.selection?.blockIds.includes(b.id)) - Number(message.content!.includes(`[${a.id}]`) || !!page.selection?.blockIds.includes(a.id))).slice(0, 8);
        const review: ChatMessage[] = [
          { role: 'system', content: `${await loadSkill('refine')}\n\n${depthContract(input.depth)}\n${page.selection ? ANSWER_BOUNDARY_RULE : ''}${knowledge ? `\n\n${await loadSkill('knowledge')}` : ''}` },
          { role: 'user', content: JSON.stringify({ question, depth: input.depth, ...(knowledge ? { module:'knowledge', knowledgeOverview:input.knowledgeOverview === true } : {}), reason, learningPlan: built.learningPlan, selection: page.selection, focusPassageIds: page.selection?.blockIds || reviewSources.slice(0, 3).map(b => b.id), draft: message.content, passages: reviewSources.map(b => ({ ...b, text: fitText(b.text, 600) })), relatedNotes: input.notes.filter(n => report.notes.includes(n.id)).slice(0, 3).map(n => ({ id: `n-${n.id}`, summary: fitText(n.summary, 350) })) }) },
        ];
        if (estimateTokens(JSON.stringify(review)) + 200 <= settings.inputBudget) {
          try {
            const revised = await complete(settings, review, [], signal, () => {});
            if (revised.content?.trim()) message.content = input.depth === 'brief' ? cleanBriefOpening(revised.content) : revised.content;
            record('answer.review.completed', { depth: input.depth, outputChars: message.content.length });
          } catch {
            signal.throwIfAborted();
            record('answer.review.failed');
          }
        }
      }
      // Only expose citations for passages actually supplied to the model, not guessed IDs.
      const referenced = [...new Set(message.content.match(/p-[a-z0-9]+-\d+/g) || [])];
      const sources = referenced.map(id => available.get(id)).filter((b): b is Block => !!b);
      report.blockIds = [...available.keys()]; input.onContext(report);
      const usedNotes = input.notes.filter(n => report.notes.includes(n.id) && message.content!.includes(`n-${n.id}`)).map(n => ({ id: n.id, title: n.title, url: n.url }));
      const answer = message.content.replace(/\[(p-[a-z0-9]+-\d+)\]/g, (all, id: string) => available.has(id) ? all : '[引用未验证]');
      input.onText(answer);
      return { answer, sources, relatedNotes: usedNotes, report };
    }
    if (!activeTools.length || message.tool_calls.length > 4) throw new Error('模型返回了超出范围或上限的工具调用。');
    input.onText('');
    messages.push(message);
    for (const call of message.tool_calls) {
      signal.throwIfAborted(); calls++;
      let delivered: Block[] = [];
      let deliveredNotes: string[] = [];
      let result: unknown = { error: '已达到补读次数上限。' };
      if (calls <= 4 && activeTools.some(t => t.function.name === call.function.name)) {
        input.onStatus(call.function.name === 'searchNotes' ? '正在查找相关笔记…' : '正在补读相关原文…');
        try {
          const args = JSON.parse(call.function.arguments || '{}');
          if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('无效参数');
          const remaining = settings.inputBudget - estimateTokens(JSON.stringify({ messages, tools: definitions })) - 550;
          const maxChars = Math.max(0, Math.min(5000, Math.floor(remaining / 3) - 100));
          if (maxChars < 120) result = { error: '上下文预算接近上限，请使用已有资料回答。' };
          else if (call.function.name === 'getPageOutline') {
            result = page.blocks.filter(b => b.kind === 'heading').slice(0, 40).map(b => ({ id: b.id, text: b.text.slice(0, 120) }));
          } else if (call.function.name === 'searchNotes' && scope === 'notes') {
            if (typeof args.query !== 'string' || args.query.length > 500) throw new Error('无效查询');
            result = relatedNotes(input.notes, args.query).map(n => {
              deliveredNotes.push(n.id);
              return { id: `n-${n.id}`, title: n.title, url: n.url, summary: n.summary.slice(0, Math.floor(maxChars / 3)) };
            });
          } else {
            let blocks: Block[];
            if (call.function.name === 'searchPage') {
              if (typeof args.query !== 'string' || args.query.length > 500) throw new Error('无效查询');
              blocks = searchBlocks(page.blocks, args.query, 3);
            } else {
              const index = page.blocks.findIndex(b => b.id === args.blockId);
              if (index < 0) throw new Error('段落不存在');
              blocks = page.blocks.slice(Math.max(0, index - 1), index + 2);
            }
            const excerpts = blocks.map(b => ({ ...b, text: b.text.length > maxChars / 3 ? `[段落节选] ${b.text.slice(0, Math.floor(maxChars / 3))}` : b.text }));
            delivered = excerpts; result = excerpts;
          }
        } catch { result = { error: '工具参数不正确，未执行。' }; }
      } else if (!activeTools.some(t => t.function.name === call.function.name)) result = { error: '该工具不在本次允许范围中。' };
      const content = JSON.stringify(result);
      const toolMessage: ChatMessage = { role: 'tool', tool_call_id: call.id, content };
      messages.push(toolMessage);
      if (estimateTokens(JSON.stringify({ messages, tools: definitions })) + 450 > settings.inputBudget) {
        toolMessage.content = JSON.stringify({ error: '结果超过上下文预算，请使用已有材料。' });
        report.clipped = true;
      } else {
        delivered.forEach(b => available.set(b.id, b));
        deliveredNotes.forEach(id => { if (!report.notes.includes(id)) report.notes.push(id); });
      }
    }
    report.estimatedTokens = estimateTokens(JSON.stringify({ messages, tools: definitions })) + 200;
    report.blockIds = [...available.keys()]; input.onContext(report);
  }
  throw new Error('补读结束后模型仍未给出回答。');
}

export function topicKey(page: PageSnapshot): string {
  return hash(`${page.url.split('#')[0]}|${page.version}|${page.selection ? JSON.stringify(page.selection) : 'article'}`);
}

export async function summarizeNote(input: { page: PageSnapshot; question: string; answer: string; sources: Block[]; relatedNotes?: { id: string; title: string; url: string }[]; previous?: Note; settings: Settings; signal: AbortSignal }): Promise<Note> {
  const { page, previous, question, answer, settings, signal } = input;
  const key = topicKey(page);
  const system = await loadSkill('notes');
  // Keep both the previous understanding and the new explanation; fail rather than silently erase old material.
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: JSON.stringify({ existing: previous?.summary || '', selection: page.selection?.text, question, answer }) },
  ];
  if (estimateTokens(JSON.stringify(messages)) + 200 > settings.inputBudget) throw new Error('本次笔记合并超过上下文预算，请手动整理或提高预算。');
  const result = await complete(settings, messages, [], signal, () => {});
  if (!result.content?.trim() || result.tool_calls?.length) throw new Error('没有生成可保存的笔记。');
  const sources = new Map([...(previous?.sources || []), ...input.sources].map(b => [b.id, b]));
  return {
    id: previous?.id || crypto.randomUUID(), topicKey: key, title: page.selection?.text.slice(0, 45) || page.title,
    url: page.url, pageVersion: page.version, selection: page.selection, summary: result.content,
    questions: [...new Set([...(previous?.questions || []), question])].slice(-30), sources: [...sources.values()],
    updatedAt: new Date().toISOString(), previous: previous?.summary || null,
    relatedNotes: [...new Map([...(previous?.relatedNotes || []), ...(input.relatedNotes || [])].map(n => [n.id, n])).values()],
    images: [...new Map([...(previous?.images || []), ...(page.images || [])].map(i => [i.id, i])).values()].slice(0, 24),
  };
}
