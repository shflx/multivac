import type { BookPosition } from '@multivac/contracts';

type Paragraph = { id: string; text: string };
export interface PdfTextSpan { rawStart: number; rawEnd: number; paragraphId: string; offset: number }
export interface PdfTextMap { chapterId: string; paragraphs: Paragraph[]; spans: PdfTextSpan[] }

/** 与两条历史 PDF 导入流程逐字一致；不靠模糊匹配猜测旧引用位置。 */
export function mapPdfText(raw: string, chapterId: string, paragraphs: Paragraph[]): PdfTextMap | null {
  const clean = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/gu, '');
  const indices = new Uint32Array(clean.length);
  let written = 0;
  for (let i = 0; i < raw.length; i++) if (!/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(raw[i]!)) indices[written++] = i;
  const spans: PdfTextSpan[] = [];
  let paragraph = 0;
  const split = /\n\s*\n/gu;
  let begin = 0;
  function add(from: number, to: number) {
    const part = clean.slice(from, to);
    let start = from + part.length - part.trimStart().length;
    const end = to - (part.length - part.trimEnd().length);
    while (start < end) {
      let stop = Math.min(start + 16384, end);
      if (stop < end && /[\uD800-\uDBFF]/u.test(clean[stop - 1]!)) --stop;
      const p = paragraphs[paragraph++];
      if (!p || p.text !== clean.slice(start, stop)) return false;
      for (let i = start; i < stop;) {
        let j = i + 1;
        while (j < stop && indices[j] === indices[j - 1]! + 1) ++j;
        spans.push({ rawStart: indices[i]!, rawEnd: indices[j - 1]! + 1, paragraphId: p.id, offset: i - start });
        i = j;
      }
      start = stop;
    }
    return true;
  }
  function cleanBoundary(rawOffset: number) {
    let low = 0, high = indices.length;
    while (low < high) { const middle = Math.floor((low + high) / 2); if (indices[middle]! < rawOffset) low = middle + 1; else high = middle; }
    return low;
  }
  // 历史导入先按原始空行切段，再清理控制字符；不能交换两步制造新段落。
  for (let match = split.exec(raw); match; match = split.exec(raw)) {
    if (!add(cleanBoundary(begin), cleanBoundary(match.index))) return null;
    begin = match.index + match[0].length;
  }
  if (!add(cleanBoundary(begin), clean.length) || paragraph !== paragraphs.length) return null;
  return { chapterId, paragraphs, spans };
}

export function pdfTextPosition(map: PdfTextMap, rawOffset: number, end: boolean): BookPosition | null {
  const spans = end ? [...map.spans].reverse() : map.spans;
  const span = spans.find(s => end ? s.rawStart < rawOffset : s.rawEnd > rawOffset);
  if (!span) return null;
  const offset = span.offset + Math.max(0, Math.min(rawOffset - span.rawStart, span.rawEnd - span.rawStart));
  const p = map.paragraphs.find(p => p.id === span.paragraphId)!;
  if (offset > 0 && offset < p.text.length && /[\uD800-\uDBFF]/u.test(p.text[offset - 1]!) && /[\uDC00-\uDFFF]/u.test(p.text[offset]!)) return null;
  return { chapterId: map.chapterId, paragraphId: span.paragraphId, offset };
}

/** 原文范围映射到文字层，不保存会随缩放改变的屏幕像素。 */
export function pdfRawRanges(map: PdfTextMap, start: BookPosition, end: BookPosition) {
  const ranks = new Map<string, number>(); let rank = 0;
  for (const p of map.paragraphs) { ranks.set(p.id, rank); rank += p.text.length + 1; }
  const a = start.chapterId === map.chapterId ? (ranks.get(start.paragraphId) ?? Infinity) + start.offset : -Infinity;
  const b = end.chapterId === map.chapterId ? (ranks.get(end.paragraphId) ?? -Infinity) + end.offset : Infinity;
  return map.spans.flatMap(span => {
    const base = ranks.get(span.paragraphId)! + span.offset;
    const from = Math.max(0, a - base), to = Math.min(span.rawEnd - span.rawStart, b - base);
    return to > from ? [{ start: span.rawStart + from, end: span.rawStart + to }] : [];
  });
}
