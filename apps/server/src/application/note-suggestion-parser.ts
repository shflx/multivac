import { Check } from 'typebox/value';
import { NoteSuggestionOutputSchema, noteBoundary, type NoteSuggestionOutput } from '@multivac/contracts';
import { NotesError } from '../modules/notes/note.js';

export function parseNoteSuggestions(text: string): NoteSuggestionOutput {
  if (text.length > 200_000) throw new NotesError('建议回复超过解析上限。');
  const blocks = [...text.matchAll(/```json\s*\n([\s\S]*?)\n```/giu)].map(match => match[1]!);
  const candidates = blocks.length ? blocks : [text.trim()];
  if (candidates.length !== 1) throw new NotesError('回复需要一个明确的JSON建议代码块，请让助手重新生成。');
  let value: unknown;
  try { value = JSON.parse(candidates[0]!); } catch { throw new NotesError('回复不是有效的结构化建议，请让助手按JSON格式重新生成。'); }
  if (!Check(NoteSuggestionOutputSchema, value)) throw new NotesError('建议结构无效：需要1至8条 reason/before/after，且原文不能为空。');
  if (value.suggestions.some(item => item.before === item.after || /[\uD800-\uDFFF]/u.test(item.after))) throw new NotesError('建议没有实际修改或含不完整的Unicode字符，请重新生成。');
  return value;
}
export function uniqueNoteLocation(body: string, before: string): { start: number; end: number } | null {
  if (!before) return null;
  const start = body.indexOf(before);
  if (start < 0 || body.indexOf(before, start + 1) >= 0) return null;
  const end = start + before.length;
  return noteBoundary(body, start) && noteBoundary(body, end) ? { start, end } : null;
}
