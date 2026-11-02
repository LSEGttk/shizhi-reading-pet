import type { PageSnapshot, Turn } from '../types';
import { hash } from '../core/text';
import { runReading, topicKey, type RunInput } from './run';

export function knowledgeThreadKey(page: PageSnapshot, topic: string) {
  return `knowledge-${hash(`${topicKey(page)}|${topic.trim()}`)}`;
}
export function runKnowledge(input: Omit<RunInput, 'question' | 'depth' | 'module' | 'knowledgeOverview'> & { topic: string; followup?: string; readingTurns?: Turn[] }) {
  const topic = input.topic.trim();
  if (!topic || topic.length > 160) throw new Error('知识点需要在1～160字之间。');
  const followup = input.followup?.trim() || '';
  if (followup.length > 1500) throw new Error('追问请保持在1500字以内。');
  const overview = !followup;
  const question = overview
    ? `请完整讲解这个知识点：${topic}。以当前选区和附近原文为起点，依次给出定义、原理、具体例子和一个直接相关的延伸（应用或边界）。`
    : `${followup}\n当前知识点（仅作背景）：${topic}`;
  return runReading({ ...input, depth:'deep', module:'knowledge', knowledgeOverview:overview, question, turns:[...(input.readingTurns || []).slice(-2), ...input.turns] });
}
