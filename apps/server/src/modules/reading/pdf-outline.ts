import { open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import type { PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { Book, BookIndex, BookTocEntry } from '@multivac/contracts';
import { ReadingError } from './book-import.js';

export type PdfOutline = { title: string; depth: number; pageIndex: number | null }[];

export function pdfResources() {
  const resources = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
  // 字符映射和字体只读取依赖资源，不请求书中的外链。
  return { cMapUrl: join(resources, 'cmaps/'), cMapPacked: true, standardFontDataUrl: join(resources, 'standard_fonts/') };
}

/** 文件导入和旧书目录补建共用按需读取，避免为目录加载整本 PDF。 */
export async function openPdfFile(path: string) {
  const file = await open(path, 'r');
  let loading: ReturnType<typeof import('pdfjs-dist/legacy/build/pdf.mjs').getDocument> | undefined;
  const destroy = async () => { try { await loading?.destroy(); } finally { await file.close(); } };
  try {
    const size = (await file.stat()).size;
    const initial = new Uint8Array(Math.min(size, 65536));
    let offset = 0;
    while (offset < initial.length) {
      const result = await file.read(initial, offset, initial.length - offset, offset);
      if (!result.bytesRead) throw new ReadingError('PDF 文件读取不完整。');
      offset += result.bytesRead;
    }
    if (Buffer.from(initial.subarray(0, 1024)).indexOf('%PDF-') < 0) throw new ReadingError('文件不是有效的 PDF。');
    const { PDFDataRangeTransport, getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    class FileRange extends PDFDataRangeTransport {
      requestDataRange(begin: number, end: number) {
        void (async () => {
          if (begin < 0 || end > size || end <= begin) throw new Error('PDF 字节范围无效。');
          const bytes = new Uint8Array(end - begin);
          let offset = 0;
          while (offset < bytes.length) {
            const result = await file.read(bytes, offset, bytes.length - offset, begin + offset);
            if (!result.bytesRead) throw new Error('PDF 文件读取不完整。');
            offset += result.bytesRead;
          }
          this.onDataRange(begin, bytes);
        })().catch(() => { void loading?.destroy(); });
      }
    }
    loading = getDocument({ range: new FileRange(size, initial), rangeChunkSize: 65536,
      disableAutoFetch: true, disableStream: true, useSystemFonts: false, disableFontFace: true, useWorkerFetch: false, verbosity: 0,
      ...pdfResources(),
    });
    const document = await loading.promise;
    if (document.numPages > 10000) throw new ReadingError('PDF 超过 10000 页。', 413);
    return { document, destroy };
  } catch (error) { await destroy(); throw error; }
}

/** 保留目录顺序和层级；仅解析文档内部目标，外部链接不交给浏览器执行。 */
export async function readPdfOutline(document: PDFDocumentProxy): Promise<PdfOutline> {
  const outline = await document.getOutline();
  const result: PdfOutline = [];
  const pending = (outline ?? []).map(item => ({ item, depth: 0 })).reverse();
  while (pending.length) {
    const { item, depth } = pending.pop()!;
    if (result.length >= 10000 || depth > 100) throw new ReadingError('PDF 书签目录超过处理预算。', 413);
    let pageIndex: number | null = null;
    try {
      const destination = typeof item.dest === 'string' ? await document.getDestination(item.dest) : item.dest;
      if (Array.isArray(destination)) {
        const target = destination[0];
        const index = typeof target === 'number' ? target : target && typeof target === 'object' ? await document.getPageIndex(target) : -1;
        if (Number.isInteger(index) && index >= 0 && index < document.numPages) pageIndex = index;
      }
    } catch { /* 一个失效目标不应丢弃其余目录或子目录。 */ }
    result.push({ title: Array.from(item.title.trim() || '未命名目录').slice(0, 150).join(''), depth, pageIndex });
    for (let i = item.items.length - 1; i >= 0; i--) pending.push({ item: item.items[i]!, depth: depth + 1 });
  }
  return result;
}

/** 目录与正文身份分开保存；页内坐标映射到该原始页首段，不重分章节。 */
export function pdfToc(outline: PdfOutline, chapters: Book['chapters'] | BookIndex['chapters']): BookTocEntry[] {
  return outline.map((entry, index) => {
    const chapter = entry.pageIndex === null ? undefined : chapters[entry.pageIndex];
    const paragraph = chapter?.paragraphs[0];
    return { id: `toc${index + 1}`, title: entry.title, depth: entry.depth,
      position: chapter && paragraph ? { chapterId: chapter.id, paragraphId: paragraph.id, offset: 0 } : null,
    };
  });
}
