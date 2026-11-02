export interface Block { id: string; text: string; heading: string; kind: 'heading' | 'paragraph' | 'code' }
export interface SelectionAnchor { text: string; blockIds: string[]; prefix: string; suffix: string }
export interface PageSnapshot {
  url: string; title: string; version: string; capturedAt: string;
  blocks: Block[]; selection: SelectionAnchor | null; truncated: boolean;
  images?: ArticleImage[];
}
export interface ArticleImage { id: string; url: string; alt: string; caption: string }
export interface ImageSettings { enabled: boolean; baseUrl: string; apiKey: string; model: string; size: string }
export type Scope = 'passage' | 'article' | 'notes';
export type Depth = 'brief' | 'context' | 'example' | 'deep';
export interface Settings {
  baseUrl: string; apiKey: string; model: string; tools: boolean;
  inputBudget: number; maxOutput: number; autoNotes: boolean;
  reviewAnswers: boolean;
  image?: ImageSettings;
}
export interface Turn { id?: string; question: string; displayQuestion?: string; answer: string; citations: Block[]; scope?: Scope; depth?: Depth; surface?: 'bubble' | 'panel'; module?: 'knowledge'; images?: ArticleImage[]; interactions?: Record<string, unknown>; relatedNotes?: { id: string; title: string; url: string }[] }
export interface Note {
  id: string; topicKey: string; title: string; url: string; pageVersion: string;
  selection: SelectionAnchor | null; summary: string; questions: string[];
  sources: Block[]; updatedAt: string; previous: string | null;
  relatedNotes?: { id: string; title: string; url: string }[];
  images?: ArticleImage[];
}
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null;
  tool_calls?: ToolCall[]; tool_call_id?: string; reasoning_content?: string;
}
export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export interface ContextReport {
  scope: Scope; depth?: Depth; module?: 'knowledge'; skill: string; estimatedTokens: number; budget: number;
  blockIds: string[]; notes: string[]; clipped: boolean;
}
export interface ToolDefinition {
  type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> };
}
