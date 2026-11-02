import type { Block, Depth } from '../types';
import { explicitShortRequest, learningPlan } from './learning';
export function visibleAnswer(text: string): string {
  return text.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm, '').replace(/\[(?:p-[a-z0-9]+-\d+|n-[a-z0-9-]+)\]/g, '').replace(/[*`#]/g, '').trim();
}
// Remove only a redundant opening; never truncate the explanation or edit embedded assertions.
export function cleanBriefOpening(answer: string) {
  return answer.replace(/^\s*(?:\*\*)?关键(?:在于|在|是)(?:\*\*)?[\s：:，,]*/, '');
}
export type ReviewReason = 'length' | 'copy' | 'template' | 'missing_example' | 'missing_mechanism' | 'missing_sections' | 'missing_structure' | 'repeated_brief';
export function hasMechanism(answer: string) {
  const text = visibleAnswer(answer);
  // Causal or operational links are an auditable minimum, not proof of correct teaching.
  return /(?:因为|由于|所以|因此|之所以|为了|从而|使得|这意味着|原因是|通过|取决于)[^。！？\n]{6,}/.test(text)
    || /(?:每个|每一|逐项|分别)[^。！？\n]{2,25}(?:得到|生成|计算|相乘|相加|求和|变成|替换|换成|对应)[^。！？\n]{3,}/.test(text)
    || /(?:保留|增加|减少|改变)[^。！？\n]{2,20}(?:轴|维度|输入|输出|长度)[^。！？\n]{2,}/.test(text);
}
export function hasConcreteExample(answer: string) {
  if (/```reading-pet\s*\n[\s\S]*?"type"\s*:\s*"(?:matrix|bpe|calculator)"/.test(answer)) return true;
  const text = visibleAnswer(answer);
  // Bounded heuristic: examples need an actual case, not the word “例子” alone.
  return /(?:例如|比如|假设|举例|试想|设想)[：:,，\s]*[^。！？\n]{5,}/.test(text)
    || /(?:当|取|令|设)[^。！？\n]{0,25}[=＝为是][^。！？\n]{0,12}\d/.test(text)
    || /[a-zA-Z]\s*[=＝]\s*\d/.test(text)
    || /(?:输入|权重|向量)[^。！？\n]{0,15}[\[（(][\d,，.\s-]+[\]）)]/.test(text);
}
export function reviewReason(answer: string, sources: Block[], depth: Depth, question = ''): ReviewReason | null {
  const text = visibleAnswer(answer);
  if (depth === 'brief' && text.length > 140) return 'length';
  if (depth === 'brief' && /(?:^|\n)\s*(?:核心含义|直接原因|注意|总结)\s*[:：]/.test(text)) return 'template';
  const original = sources.map(b => b.text.replace(/\s+/g, '')).join('\n');
  const compact = text.replace(/\s+/g, '');
  for (let i = 0; i <= compact.length - 22; i++) {
    const phrase = compact.slice(i, i + 22);
    if ((phrase.match(/[\p{Script=Han}]/gu) || []).length >= 15 && original.includes(phrase)) return 'copy';
  }
  if (depth === 'example' && !explicitShortRequest(question) && learningPlan(question, depth, []).focusHint !== 'check') {
    if (!hasMechanism(answer)) return 'missing_mechanism';
    if (!hasConcreteExample(answer)) return 'missing_example';
    if(!/^#{2,3}\s+原理\s*$/m.test(answer)||!/^#{2,3}\s+例子\s*$/m.test(answer))return 'missing_structure';
  }
  return null;
}
