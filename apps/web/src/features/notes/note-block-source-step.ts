import { Step, StepResult, StepMap } from '@tiptap/pm/transform';
import type { Node as DocumentNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import { parseNoteMarkdown, type NoteMarkdown } from './note-markdown.js';

/** 本地撤销历史同时携带原文；不增加文档节点，也不写入服务端协议。 */
export class NoteBlockSourceStep extends Step {
  constructor(readonly before: string, readonly after: string) { super(); }
  apply(doc: DocumentNode) { return StepResult.ok(doc); }
  invert() { return new NoteBlockSourceStep(this.after, this.before); }
  map() { return this; }
  getMap() { return StepMap.empty; }
  toJSON() { return { stepType: 'noteBlockSource', before: this.before, after: this.after }; }
}

export function noteBlockTransactionSource(tr: Transaction): NoteMarkdown | undefined {
  const step = tr.steps.findLast(step => step instanceof NoteBlockSourceStep);
  return step instanceof NoteBlockSourceStep ? parseNoteMarkdown(step.after, tr.doc.type.schema) : undefined;
}
