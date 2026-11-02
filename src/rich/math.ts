import type MarkdownIt from 'markdown-it';
import katex from 'katex';
export function mathPlugin(md: InstanceType<typeof MarkdownIt>) {
  md.inline.ruler.before('escape', 'reading_math', (state, silent) => {
    const start = state.pos, src = state.src;
    const open = src.startsWith('\\(', start) ? '\\(' : src[start] === '$' && src[start + 1] !== '$' ? '$' : '';
    if (!open) return false;
    const close = open === '$' ? '$' : '\\)', end = src.indexOf(close, start + open.length);
    if (end < 0 || end - start > 4000 || src.slice(start + open.length, end).includes('\n') || (open === '$' && /\s/.test(src[start + 1] || ''))) return false;
    if (!silent) { const token = state.push('reading_math', 'math', 0); token.content = src.slice(start + open.length, end); }
    state.pos = end + close.length; return true;
  });
  md.block.ruler.before('fence', 'reading_math_block', (state, startLine, endLine, silent) => {
    const start = state.bMarks[startLine] + state.tShift[startLine], line = state.src.slice(start, state.eMarks[startLine]);
    const open = line.startsWith('$$') ? '$$' : line.startsWith('\\[') ? '\\[' : '';
    if (!open) return false;
    const close = open === '$$' ? '$$' : '\\]';
    let content = line.slice(open.length), next = startLine;
    if (!content.trimEnd().endsWith(close)) {
      while (++next < endLine && content.length < 8000) { const part = state.src.slice(state.bMarks[next], state.eMarks[next]); content += `\n${part}`; if (part.trimEnd().endsWith(close)) break; }
      if (next >= endLine || content.length >= 8000) return false;
    }
    if (!silent) { const token = state.push('reading_math_block', 'math', 0); token.block = true; token.content = content.trimEnd().slice(0, -close.length); token.map = [startLine, next + 1]; }
    state.line = next + 1; return true;
  });
  const render = (content: string, displayMode: boolean) => katex.renderToString(content, { displayMode, throwOnError: false, trust: false, strict: 'ignore', maxExpand: 300, maxSize: 20, output: 'htmlAndMathml' });
  md.renderer.rules.reading_math = (tokens, idx) => render(tokens[idx].content, false);
  md.renderer.rules.reading_math_block = (tokens, idx) => `<div class="rich-math-block">${render(tokens[idx].content, true)}</div>`;
}
