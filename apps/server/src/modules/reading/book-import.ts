import { createHash } from 'node:crypto';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { BOOK_SOURCE_LIMIT_BYTES, BOOK_MAX_PARAGRAPHS, BOOK_MAX_PARAGRAPH_LENGTH, type Book, type ImportBook } from '@multivac/contracts';

export class ReadingError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
export const readingHash = (text: string) => createHash('sha256').update(text).digest('hex');

/** Markdown 只提取可读文本，原始 HTML 与图片不进入正文，不请求远程资源。 */
export function parseBook(input: ImportBook): Book {
  if (Buffer.byteLength(input.text, 'utf8') > BOOK_SOURCE_LIMIT_BYTES) throw new ReadingError('书籍超过 1 MiB 限制。', 413);
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFD]/u.test(input.text)) throw new ReadingError('请选择有效 UTF-8 普通文本。');
  if (!input.title.trim()) throw new ReadingError('书名不能为空。');
  const text = input.text.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n');
  const version = readingHash(`${input.format}\n${text}`);
  const chapters: Book['chapters'] = [];
  let count = 0;
  const chapter = (title: string) => {
    if (chapters.length >= 1000 || title.length > 300) throw new ReadingError('章节数量或标题超过限制。');
    const item = { id: `c${chapters.length + 1}`, title, paragraphs: [] as Book['chapters'][number]['paragraphs'] };
    chapters.push(item); return item;
  };
  let current = chapter('正文');
  const paragraph = (value: string) => {
    if (!value.trim()) return;
    if (++count > BOOK_MAX_PARAGRAPHS || value.length > BOOK_MAX_PARAGRAPH_LENGTH) throw new ReadingError('正文最多 5000 段，每段最多 16384 个 UTF-16 字符。');
    current.paragraphs.push({ id: `${current.id}:p${current.paragraphs.length + 1}`, text: value });
  };
  if (input.format === 'txt') {
    text.split(/\n\s*\n/gu).forEach(paragraph);
  } else {
    const plain = (node: { type: string; value?: string; children?: unknown[] }): string => {
      if (node.type === 'html' || node.type === 'image' || node.type === 'imageReference' || node.type === 'definition') return '';
      if (node.type === 'break') return '\n';
      if (typeof node.value === 'string') return node.value;
      return (node.children ?? []).map(child => plain(child as Parameters<typeof plain>[0])).join(node.type === 'list' || node.type === 'blockquote' || node.type === 'listItem' ? '\n' : '');
    };
    for (const node of fromMarkdown(text).children) {
      if (node.type === 'heading') { current = chapter(plain(node)); } else paragraph(plain(node));
    }
  }
  if (!count) throw new ReadingError('书籍没有可读正文。');
  return { id: `book-${version}`, version, title: input.title.trim(), author: input.author.trim(), format: input.format, createdAt: new Date().toISOString(), paragraphCount: count, chapters };
}
