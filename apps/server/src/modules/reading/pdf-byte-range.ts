/** 单范围字节读取；拒绝多范围及溢出，避免按不可信范围分配内存。 */
export function pdfByteRange(header: string | undefined, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header);
  if (!match || (!match[1] && !match[2])) throw new RangeError('PDF 字节范围无效。');
  const suffix = !match[1];
  const first = Number(match[1] || match[2]);
  const start = suffix ? Math.max(0, size - first) : first;
  const last = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(last)) throw new RangeError('PDF 字节范围无效。');
  const end = suffix || !match[2] ? size - 1 : Math.min(last, size - 1);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(end) || first < 0 || suffix && first === 0 || start >= size || end < start) throw new RangeError('PDF 字节范围超出文件。');
  return { start, end };
}
