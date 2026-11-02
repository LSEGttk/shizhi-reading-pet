import { hasConcreteExample, hasMechanism, type ReviewReason } from './quality';

export const KNOWLEDGE_SECTIONS = ['定义', '原理', '例子', '延伸'] as const;
export function knowledgeReviewReason(answer: string): ReviewReason | null {
  const prose = answer.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm, '');
  const headings=[...prose.matchAll(/^#{2,3}\s+(定义|原理|例子|延伸)\s*$/gm)];
  if (KNOWLEDGE_SECTIONS.some((title,i)=>headings[i]?.[1]!==title || prose.slice((headings[i].index||0)+headings[i][0].length,headings[i+1]?.index||prose.length).replace(/\[(?:p|n)-[^\]]+\]/g,'').trim().length<4)) return 'missing_sections';
  if (!hasMechanism(answer)) return 'missing_mechanism';
  if (!hasConcreteExample(answer)) return 'missing_example';
  return null;
}
