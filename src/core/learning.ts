import type { Depth, Scope, Turn, SelectionAnchor } from '../types';
import { fitText } from './text';

export type LearningFocus = 'meaning' | 'mechanism' | 'application' | 'check' | 'auto';
export const DEFAULT_READING_QUESTION = '结合附近原文，帮我理解选中的内容；如果是一整段，先说它在回答什么问题，再讲清主要关系。';
// Shared by generation and repair: reading access is not the answer's subject.
export const ANSWER_BOUNDARY_RULE = '有选区时，默认讲解对象是 selection.text 的确切文字；focusPassageIds 只定位包含选区的段落，不代表要概括整个段落或小节。附近原文、检索结果、历史对话和笔记用于消歧、确认定义或补必要条件，不自动成为回答主题。补充一句前先判断：删掉它，是否仍能理解选区并回答当前问题？若可以且用户未要求关联、比较或延伸，就省去。先说“这段在回答什么问题”时，“这段”仅指选区，不替用户提前概括下文。即使有引用、位于相邻段落或同一小节，也不代表应该写进回答。用户明确要求比较、全文总结或延伸时，按其当前请求在授权资料范围内展开。';
function selectionShape(selection?: SelectionAnchor | null) {
  const text = selection?.text.trim() || '';
  if (!text) return 'none';
  const sentences = text.split(/[。！？!?]+|\.(?:\s|$)/).filter(s => s.trim()).length;
  // A routing hint, not a claim about intent or ability. Explicit questions win.
  if (text.length >= 120 || (text.length >= 60 && sentences >= 2)) return 'passage';
  return text.length <= 24 && sentences <= 1 ? 'term' : 'sentence';
}
export function compatibleHistory(turns: Turn[], scope: Scope) {
  return turns.filter(turn => scope === 'notes' || (scope === 'article' ? turn.scope !== 'notes' : turn.scope === 'passage'));
}
// These are routing hints from the user's own words, not a proficiency classifier.
export function learningPlan(question: string, depth: Depth, turns: Turn[], selection?: SelectionAnchor | null) {
  question = question.split('\n此前的问题（仅作背景）：')[0];
  let focus: LearningFocus = 'auto';
  if (/检验.{0,8}理解|小题|考考我|先不.{0,5}答案|测试我/.test(question)) focus = 'check';
  else if (/直接讲.{0,5}(?:原理|机制)|只讲.{0,5}(?:原理|机制)|为什么|为何|原理|机制|取舍|怎么.{0,8}(?:实现|算|训练)/.test(question)) focus = 'mechanism';
  else if (/是啥|是什么|什么意思|含义|代表什么|怎么读|看不懂|拆开符号/.test(question)) focus = 'meaning';
  else if (/应用|怎么用|用途|用在哪/.test(question)) focus = 'application';
  const evidence = turns.slice(-4).filter(turn => /我.{0,18}(?:懂|会|知道|理解)|不懂|没懂|看不懂|白话|不是.{0,12}(?:问|意思)|别.{0,8}(?:解释|讲)|不用.{0,8}(?:解释|讲)|重新解释|拆开符号|直接讲/.test(turn.question))
    .slice(-2).map(turn => ({ source:'user_question', text: fitText(turn.question, 240) }));
  const shape = selectionShape(selection);
  const entryHint = shape === 'passage' && focus === 'auto' && (depth === 'brief' || depth === 'context')
    ? 'question_then_relation' : 'follow_current_question';
  return { focusHint: focus, selectionShape: shape, entryHint, depth, mastery: 'unverified', currentQuestionWins: true, priorUserEvidence: evidence };
}
export function explicitShortRequest(question: string) {
  question = question.split('\n此前的问题（仅作背景）：')[0];
  return /(?:请|只|用|要|就|再|更|尽量|尽可能|保持|回答|答复|解释).{0,5}(?:一句话|简短|简答|精简|简洁)|(?:一句话|简短|简答|精简|简洁).{0,5}(?:回答|解释|说明)|(?:只要|只需|只给).{0,5}(?:定义|结论|答案)|不要.{0,3}(?:例子|举例)|不用举例/.test(question);
}
export const DEPTH_LABELS: Record<Depth, string> = { brief:'一句话点破', context:'结合上下文', example:'原理＋例子', deep:'深入讲解' };
export function depthContract(depth: Depth) {
  return `本次解释模式：${DEPTH_LABELS[depth]}。${depth === 'brief' ? '默认结合选区附近原文，说清这里指什么、表达什么，补够当前理解必需的概念。通常1～3句，直接从内容开始，不用“关键在／关键是”等开场。只有用户明确问为什么或原理时，才解释对应的机制，不主动寻找设计取舍。' : depth === 'context' ? '这是普通侧栏的上下文展开，不受气泡短答长度限制。围绕选区在此处的含义、必要概念和前后关系，用少量短段讲清；补足历史简答未说清之处。不要把已有气泡原样再说一遍。用户没问原理时不强制追加推导或延伸。' : depth === 'example' ? '在用户没有明确要求简答时，必须结合当前选区所在段落，把输入/前提如何经操作或推理得到结果讲通，再走完一个直接对应的小例子；只释义、列符号名称或给结论不算讲原理。不要以别处的取舍代替本段机制，不靠凑字数满足深度。' : '围绕当前疑惑展开必要机制、推导和设计边界，保持聚焦。'}\nlearningPlan 是基于用户原话的提示，不是能力评定。当前明确问题或纠正优先于此前猜测；不因展示过解释、未追问或调过滑块而认定已经掌握。`;
}
