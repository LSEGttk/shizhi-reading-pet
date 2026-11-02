// Restricted arithmetic parser; no eval, Function, property access or user-defined code.
export function calculate(expression: string, values: Record<string, number>): number {
  if (expression.length > 512) throw new Error('表达式过长');
  const tokens = expression.match(/(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|[a-z][a-z0-9_]*|[()+\-*/^,]/gi) || [];
  if (tokens.length > 200 || tokens.join('').toLowerCase() !== expression.replace(/\s/g, '').toLowerCase()) throw new Error('表达式包含不支持的内容');
  let at = 0;
  const functions: Record<string, (...args: number[]) => number> = { min: Math.min, max: Math.max, abs: Math.abs, sqrt: Math.sqrt, log: Math.log, exp: Math.exp };
  function atom(): number {
    const t = tokens[at++];
    if (t === '(') { const n = sum(); if (tokens[at++] !== ')') throw new Error('括号不匹配'); return n; }
    if (/^(?:\d|\.)/.test(t || '')) return Number(t);
    if (t && Object.hasOwn(values, t)) return values[t];
    if (t && Object.hasOwn(functions, t) && tokens[at++] === '(') {
      const args = [sum()]; while (tokens[at] === ',') { at++; args.push(sum()); if (args.length > 6) throw new Error('参数过多'); }
      if (tokens[at++] !== ')') throw new Error('括号不匹配');
      return functions[t](...args);
    }
    throw new Error('未知变量或函数');
  }
  function power(): number { let n = atom(); if (tokens[at] === '^') { at++; const exponent = unary(); if (Math.abs(exponent) > 50) throw new Error('指数超出范围'); n = n ** exponent; } return n; }
  function unary(): number { if (tokens[at] === '-') { at++; return -unary(); } if (tokens[at] === '+') { at++; return unary(); } return power(); }
  function product(): number { let n = unary(); while (tokens[at] === '*' || tokens[at] === '/') { const op = tokens[at++], rhs = unary(); n = op === '*' ? n * rhs : n / rhs; } return n; }
  function sum(): number { let n = product(); while (tokens[at] === '+' || tokens[at] === '-') { const op = tokens[at++], rhs = product(); n = op === '+' ? n + rhs : n - rhs; } return n; }
  const result = sum(); if (at !== tokens.length || !Number.isFinite(result) || Math.abs(result) > 1e18) throw new Error('结果无效或超出范围'); return result;
}
export type Merge = [string, string];
export function mergePieces(pieces: string[], pair: Merge): string[] {
  const out: string[] = [];
  for (let i = 0; i < pieces.length; i++) { if (pieces[i] === pair[0] && pieces[i + 1] === pair[1]) { out.push(pair.join('')); i++; } else out.push(pieces[i]); }
  return out;
}
export function trainBpe(corpus: { text: string; count: number }[], steps: number): Merge[] {
  const words = corpus.flatMap(w => w.text.trim().split(/\s+/).map(text => ({ pieces: Array.from(text), count: w.count })));
  const merges: Merge[] = [];
  for (let step = 0; step < steps; step++) {
    const pairs = new Map<string, { pair: Merge; count: number }>();
    for (const word of words) for (let i = 0; i < word.pieces.length - 1; i++) {
      const pair: Merge = [word.pieces[i], word.pieces[i + 1]], key = JSON.stringify(pair);
      const found = pairs.get(key) || { pair, count: 0 }; found.count += word.count; pairs.set(key, found);
    }
    const best = [...pairs.values()].sort((a, b) => b.count - a.count || JSON.stringify(a.pair).localeCompare(JSON.stringify(b.pair)))[0];
    if (!best) break; merges.push(best.pair); words.forEach(w => { w.pieces = mergePieces(w.pieces, best.pair); });
  }
  return merges;
}
export function encodeBpe(text: string, merges: Merge[], step: number): string[][] {
  return text.trim().split(/\s+/).filter(Boolean).map(word => merges.slice(0, step).reduce((pieces, pair) => mergePieces(pieces, pair), Array.from(word)));
}
