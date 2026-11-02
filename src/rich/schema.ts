export type RichSpec =
  | { type: 'steps'; title: string; items: { title: string; body: string }[] }
  | { type: 'flow'; title: string; direction: 'TD' | 'LR'; nodes: { id: string; label: string; group?: string }[]; edges: { from: string; to: string; label?: string }[] }
  | { type: 'mermaid' | 'svg'; title: string; code: string }
  | { type: 'matrix'; title: string; matrix: number[][]; vector: number[] }
  | { type: 'bpe'; title: string; text: string; corpus: { text: string; count: number }[]; merges: number }
  | { type: 'calculator'; title: string; inputs: { key: string; label: string; min: number; max: number; step: number; value: number; unit: string }[]; outputs: { label: string; expression: string; unit: string; digits: number }[] }
  | { type: 'image'; title: string; sourceId: string; alt: string }
  | { type: 'generate-image'; title: string; prompt: string; alt: string };

const text = (v: unknown, max = 200): string => typeof v === 'string' ? v.slice(0, max) : '';
const finite = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
export function parseRich(value: unknown): RichSpec {
  if (!value || typeof value !== 'object') throw new Error('演示配置必须是对象。');
  const v = value as Record<string, any>, title = text(v.title, 100);
  switch (v.type) {
    case 'steps': {
      if (!Array.isArray(v.items) || !v.items.length || v.items.length > 10) break;
      return { type: 'steps', title, items: v.items.map((i: any) => ({ title: text(i?.title, 120), body: text(i?.body, 600) })) };
    }
    case 'flow': {
      if (!Array.isArray(v.nodes) || !v.nodes.length || v.nodes.length > 25 || !Array.isArray(v.edges) || v.edges.length > 50) break;
      const nodes = v.nodes.map((n: any) => ({ id: text(n?.id, 25), label: text(n?.label, 160), group: text(n?.group, 80) }));
      if (nodes.some((n: any) => !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(n.id)) || new Set(nodes.map((n: any) => n.id)).size !== nodes.length) break;
      const ids = new Set(nodes.map((n: any) => n.id));
      if (v.edges.some((e: any) => !ids.has(e?.from) || !ids.has(e?.to))) break;
      return { type: 'flow', title, direction: v.direction === 'LR' ? 'LR' : 'TD', nodes, edges: v.edges.map((e: any) => ({ from: e.from, to: e.to, label: text(e.label, 100) })) };
    }
    case 'mermaid': case 'svg':
      if (typeof v.code === 'string' && v.code.length <= (v.type === 'svg' ? 40_000 : 12_000)) return { type: v.type, title, code: v.code };
      break;
    case 'matrix': {
      if (!Array.isArray(v.matrix) || !v.matrix.length || v.matrix.length > 4 || !Array.isArray(v.vector) || !v.vector.length || v.vector.length > 4) break;
      if (v.vector.some((n: unknown) => !finite(n, -100, 100)) || v.matrix.some((row: any) => !Array.isArray(row) || row.length !== v.vector.length || row.some((n: unknown) => !finite(n, -100, 100)))) break;
      return { type: 'matrix', title, matrix: v.matrix.map((row: number[]) => [...row]), vector: [...v.vector] };
    }
    case 'bpe': {
      const corpus = Array.isArray(v.corpus) ? v.corpus : [{ text: 'low', count: 5 }, { text: 'lower', count: 2 }, { text: 'lowest', count: 3 }];
      if (!corpus.length || corpus.length > 12 || corpus.some((w: any) => !text(w?.text, 31) || text(w?.text, 31).length > 30 || !finite(w?.count, 1, 10000))) break;
      return { type: 'bpe', title, text: text(v.text || 'low lowest', 100), corpus: corpus.map((w: any) => ({ text: w.text, count: Math.floor(w.count) })), merges: finite(v.merges, 1, 12) ? Math.floor(v.merges) : 6 };
    }
    case 'calculator': {
      if (!Array.isArray(v.inputs) || !v.inputs.length || v.inputs.length > 6 || !Array.isArray(v.outputs) || !v.outputs.length || v.outputs.length > 4) break;
      const keys = new Set();
      for (const i of v.inputs) {
        if (!i || !/^[a-z][a-z0-9_]{0,15}$/.test(i.key) || keys.has(i.key) || !finite(i.min, -1e6, 1e6) || !finite(i.max, -1e6, 1e6) || i.max <= i.min || !finite(i.step, 1e-6, i.max - i.min) || !finite(i.value, i.min, i.max)) throw new Error('计算器参数范围不正确。');
        keys.add(i.key);
      }
      return { type: 'calculator', title, inputs: v.inputs.map((i: any) => ({ key: i.key, label: text(i.label, 80), min: i.min, max: i.max, step: i.step, value: i.value, unit: text(i.unit, 20) })), outputs: v.outputs.map((o: any) => ({ label: text(o.label, 100), expression: text(o.expression, 512), unit: text(o.unit, 20), digits: finite(o.digits, 0, 6) ? Math.floor(o.digits) : 2 })) };
    }
    case 'image':
      if (typeof v.sourceId === 'string' && /^(?:img|media)-[a-z0-9-]+$/i.test(v.sourceId)) return { type: 'image', title, sourceId: v.sourceId, alt: text(v.alt, 300) };
      break;
    case 'generate-image':
      if (typeof v.prompt === 'string' && v.prompt.trim() && v.prompt.length <= 2500) return { type: 'generate-image', title, prompt: v.prompt, alt: text(v.alt, 300) };
  }
  throw new Error('演示类型或参数不受支持。');
}
export function safeImageUrl(value: string): string | null {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password ? u.href : null; } catch { return null; }
}
