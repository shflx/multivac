import { positionRank, validReference } from './reading-state.js';

/**
 * 导入书籍的规则，与 dev 的导入对话框一致：支持 PDF、EPUB、TXT、Markdown；TXT 与 Markdown 最大 1 MiB。
 * 原型只在浏览器里解析 TXT 与 Markdown 的正文，PDF、EPUB 用示例正文代替，不代表真实解析能力。
 */
export const READING_IMPORT_ACCEPT = '.pdf,.epub,.txt,.md,.markdown';
export const TEXT_IMPORT_LIMIT = 1024 * 1024;

export function importKindOf(fileName) {
  const extension = fileName.toLowerCase().split('.').pop();
  return { pdf: 'pdf', epub: 'epub', txt: 'text', md: 'markdown', markdown: 'markdown' }[extension] || null;
}

/** 选中文件后立即校验：不支持的格式与超限的文本文件不进入导入。 */
export function importFileError(file) {
  const kind = importKindOf(file.name);
  if (!kind) return '仅支持 PDF、EPUB、TXT 或 Markdown 文件。';
  if (['text', 'markdown'].includes(kind) && file.size > TEXT_IMPORT_LIMIT) return 'TXT、Markdown 最大 1 MiB，请拆分后再导入。';
  if (file.size === 0) return '文件是空的，请重新选择。';
  return '';
}

/** 书名留空时使用去掉扩展名的文件名。 */
export function importTitleOf(fileName, title = '') {
  return title.trim() || fileName.replace(/\.[^.]+$/u, '') || '未命名书籍';
}

const SAMPLE_PARAGRAPHS = [
  '这是原型生成的示例正文：原型不解析 PDF 与 EPUB，导入后用这段文字代替原书内容，便于体验阅读、标注与讨论。',
  '真实导入会保留原书的章节结构；扫描版 PDF 需要先转换为可识别文字的版本。',
];

/**
 * 把导入的正文整理成书：Markdown 按一级、二级标题分章，TXT 只有一章；段落按空行切分。
 * 没有可读正文时退回示例正文，保证书至少有一段可读内容。
 */
export function bookFromImport({ id, fileName, title, author, text = '' }) {
  const kind = importKindOf(fileName);
  const chapters = [];
  let current = null;
  const lines = ['text', 'markdown'].includes(kind) ? text.replace(/\r\n?/gu, '\n').split('\n') : [];
  let buffer = [];
  const flush = () => {
    const paragraph = buffer.join(' ').trim();
    buffer = [];
    if (!paragraph) return;
    if (!current) { current = { id: `${id}-c1`, title: '正文', keywords: [], paragraphs: [] }; chapters.push(current); }
    current.paragraphs.push(paragraph);
  };
  for (const line of lines) {
    const heading = kind === 'markdown' && line.match(/^#{1,2}\s+(.+)$/u);
    if (heading) {
      flush();
      current = { id: `${id}-c${chapters.length + 1}`, title: heading[1].trim(), keywords: [], paragraphs: [] };
      chapters.push(current);
    } else if (!line.trim()) flush();
    else buffer.push(line.trim());
  }
  flush();
  const readable = chapters.filter((chapter) => chapter.paragraphs.length);
  return {
    id,
    title: importTitleOf(fileName, title),
    author: author.trim() || '未知作者',
    imported: true,
    chapters: readable.length ? readable : [{ id: `${id}-c1`, title: '正文（示例）', keywords: [], paragraphs: SAMPLE_PARAGRAPHS }],
  };
}

/** 划线按原文位置排序；位置已失效的排在最后。 */
export function sortHighlights(book, highlights) {
  return [...highlights].sort((a, b) => (validReference(book, a.reference) ? positionRank(book, a.reference.start) : Infinity) - (validReference(book, b.reference) ? positionRank(book, b.reference.start) : Infinity));
}
