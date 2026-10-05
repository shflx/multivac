import { Type } from 'typebox';
import { Check } from 'typebox/value';
import { ASSISTANT_DRAFT_MAX_UTF8_BYTES, AssistantContextRefSchema, AssistantQuoteSchema, BookReferenceSchema, ReadingMessageSourceSchema } from '@multivac/contracts';

/** 阅读选区沿用阅读引用长度限制，不借用 Multivac 的 4 KiB 引用槽。 */
export const ReadingDraftQuoteSchema = Type.Object({ reference: BookReferenceSchema, sourceMessage: Type.Optional(ReadingMessageSourceSchema) }, { additionalProperties: false });
export type ReadingDraftQuote = Type.Static<typeof ReadingDraftQuoteSchema>;
export function readReadingDraftQuote(key: string): ReadingDraftQuote | null {
  try { const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null'); return Check(ReadingDraftQuoteSchema, value) ? value : null; }
  catch { return null; }
}
export function writeReadingDraftQuote(key: string, quote: ReadingDraftQuote | null): void {
  if (quote) localStorage.setItem(key, JSON.stringify(quote)); else localStorage.removeItem(key);
}

/** 已明确拒绝的发送快照；恢复或重试不能借用输入区里的下一条草稿。 */
const FailedSubmissionSchema = Type.Object({
  commandId: Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' }),
  text: Type.String({ maxLength: ASSISTANT_DRAFT_MAX_UTF8_BYTES }),
  createdAt: Type.String(),
  quote: Type.Union([AssistantQuoteSchema, Type.Null()]),
  readingQuote: Type.Union([ReadingDraftQuoteSchema, Type.Null()]),
  contextRefs: Type.Array(AssistantContextRefSchema, { maxItems: 1 }),
  restoredDraftVersion: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  error: Type.String(),
}, { additionalProperties: false });
export type FailedSubmission = Type.Static<typeof FailedSubmissionSchema>;
const FailedSubmissionsSchema = Type.Array(FailedSubmissionSchema);

export function readFailedSubmissions(key: string): FailedSubmission[] {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? '[]');
    return Check(FailedSubmissionsSchema, value) ? value : [];
  } catch { return []; }
}
export function writeFailedSubmissions(key: string, submissions: readonly FailedSubmission[]): void {
  if (submissions.length) sessionStorage.setItem(key, JSON.stringify(submissions));
  else sessionStorage.removeItem(key);
}
