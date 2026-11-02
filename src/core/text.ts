export const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
export function hash(text: string): string {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++) { value ^= text.charCodeAt(i); value = Math.imul(value, 16777619); }
  return (value >>> 0).toString(36);
}
// Conservative planning estimate, not a provider tokenizer. Enforce it on the complete serialized payload.
export const estimateTokens = (text: string) => Math.ceil(new TextEncoder().encode(text).length / 2);
export function fitText(text: string, budget: number): string {
  if (estimateTokens(text) <= budget) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (estimateTokens(text.slice(0, mid)) <= budget) lo = mid; else hi = mid - 1; }
  return text.slice(0, lo);
}
export function terms(text: string): string[] {
  const lower = text.toLowerCase();
  const words: string[] = lower.match(/[a-z0-9_]{2,}/g) || [];
  for (const run of lower.match(/[\p{Script=Han}]+/gu) || []) {
    if (run.length === 1) words.push(run);
    for (let i = 0; i < run.length - 1; i++) words.push(run.slice(i, i + 2));
  }
  return [...new Set(words)].slice(0, 120);
}
export function relevance(text: string, query: string): number {
  const haystack = text.toLowerCase();
  return terms(query).reduce((score, word) => score + (haystack.includes(word) ? 1 : 0), 0);
}
