import { open as openFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { createRequire } from 'node:module';
import { open as openZip, type Entry, type ZipFile } from 'yauzl';
import { BOOK_MAX_PARAGRAPH_LENGTH, type Book } from '@multivac/contracts';
import { xml, find, tag, attributes, plain, archivePath, type Chapter } from './binary-book-import.js';
import { ReadingError } from './book-import.js';

/** 与旧导入的规范化完全一致，改变存储方式不改变原文锚点。 */
function normalize(part: Chapter, ordinal: number): Book['chapters'][number] {
  const id = `c${ordinal + 1}`;
  const paragraphs: Book['chapters'][number]['paragraphs'] = [];
  for (const raw of part.paragraphs) {
    const text = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/gu, '').trim();
    for (let start = 0; start < text.length;) {
      let end = Math.min(start + BOOK_MAX_PARAGRAPH_LENGTH, text.length);
      if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]!)) --end;
      paragraphs.push({ id: `${id}:p${paragraphs.length + 1}`, text: text.slice(start, end) }); start = end;
    }
  }
  return { id, title: Array.from(part.title).slice(0, 150).join(''), paragraphs };
}
export async function* fileBookChapters(path: string, format: 'pdf' | 'epub') {
  let ordinal = 0, count = 0;
  try {
    for await (const part of format === 'pdf' ? pdf(path) : epub(path)) {
      const chapter = normalize(part, ordinal++); count += chapter.paragraphs.length; yield chapter;
    }
    if (!count) throw new ReadingError(format === 'pdf' ? 'PDF 没有可提取文字，扫描版暂不支持 OCR。' : 'EPUB 没有可读正文。');
  } catch (error) {
    if (error instanceof ReadingError) throw error;
    if ((error as Error).name === 'PasswordException') throw new ReadingError('PDF 已加密，请先解密后再导入。');
    throw new ReadingError(`${format.toUpperCase()} 文件损坏或格式不受支持。`);
  }
}
async function* pdf(path: string): AsyncGenerator<Chapter> {
  const file = await openFile(path, 'r');
  let loading: ReturnType<typeof import('pdfjs-dist/legacy/build/pdf.mjs').getDocument> | undefined;
  try {
    const size = (await file.stat()).size;
    const initial = new Uint8Array(Math.min(size, 65536)); await file.read(initial, 0, initial.length, 0);
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
    const resources = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
    loading = getDocument({ range: new FileRange(size, initial), rangeChunkSize: 65536,
      disableAutoFetch: true, disableStream: true, useSystemFonts: false, disableFontFace: true, useWorkerFetch: false, verbosity: 0,
      cMapUrl: join(resources, 'cmaps/'), cMapPacked: true, standardFontDataUrl: join(resources, 'standard_fonts/'),
    });
    const document = await loading.promise;
    if (document.numPages > 10000) throw new ReadingError('PDF 目录超过 10000 页。', 413);
    for (let n = 1; n <= document.numPages; n++) {
      const page = await document.getPage(n);
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items) {
        if ('str' in item) text += item.str + (item.hasEOL ? '\n' : '');
        if (text.length > 4 * 1024 * 1024) throw new ReadingError('PDF 单页文字超过处理预算。', 413);
      }
      yield { title: `第 ${n} 页`, paragraphs: text.split(/\n\s*\n/u) };
      page.cleanup();
    }
  } finally { await loading?.destroy(); await file.close(); }
}
async function* epub(path: string): AsyncGenerator<Chapter> {
  const zip = await new Promise<ZipFile>((resolve, reject) => openZip(path, { lazyEntries: true, autoClose: false }, (error, value) => error ? reject(error) : resolve(value!)));
  try {
    const entries = await new Promise<Map<string, Entry>>((resolve, reject) => {
      const found = new Map<string, Entry>();
      zip.on('error', reject);
      zip.on('entry', (entry: Entry) => {
        try {
          if (found.size >= 20000 || entry.fileName.length > 2048) throw new ReadingError('EPUB 资源目录超过处理预算。', 413);
          archivePath('.', entry.fileName);
          if (found.has(entry.fileName)) throw new ReadingError('EPUB 包含重复资源路径。');
          found.set(entry.fileName, entry); zip.readEntry();
        } catch (error) { reject(error); }
      });
      zip.once('end', () => resolve(found)); zip.readEntry();
    });
    async function read(name: string): Promise<Uint8Array> {
      const entry = entries.get(name);
      if (!entry) throw new ReadingError(`EPUB 缺少阅读所需资源：${name}`);
      if (entry.uncompressedSize > 16 * 1024 * 1024) throw new ReadingError('EPUB 单个正文资源超过 16 MiB 处理预算。', 413);
      const stream = await new Promise<NodeJS.ReadableStream>((resolve, reject) => zip.openReadStream(entry, (error, value) => error ? reject(error) : resolve(value!)));
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of stream) {
        size += chunk.length;
        if (size > 16 * 1024 * 1024) { (stream as import('node:stream').Readable).destroy(); throw new ReadingError('EPUB 单个正文资源超过处理预算。', 413); }
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    }
    if (new TextDecoder().decode(await read('mimetype')).trim() !== 'application/epub+zip') throw new ReadingError('文件不是有效的 EPUB。');
    const encrypted = new Set(entries.has('META-INF/encryption.xml')
      ? find(xml(await read('META-INF/encryption.xml')), 'CipherReference').map(node => archivePath('.', attributes(node)['@_URI'] ?? '')) : []);
    const readText = async (name: string) => { if (encrypted.has(name)) throw new ReadingError('EPUB 正文已加密，请使用未加密版本。'); return xml(await read(name)); };
    const root = find(xml(await read('META-INF/container.xml')), 'rootfile').find(node => attributes(node)['@_media-type'] === 'application/oebps-package+xml');
    if (!root) throw new ReadingError('EPUB 缺少内容目录。');
    const packagePath = archivePath('.', attributes(root)['@_full-path'] ?? '');
    const opf = await readText(packagePath);
    const manifest = new Map(find(opf, 'item').map(node => [attributes(node)['@_id'], attributes(node)]));
    const spine = find(opf, 'itemref').filter(node => attributes(node)['@_linear'] !== 'no');
    if (!spine.length || spine.length > 10000) throw new ReadingError('EPUB 阅读顺序为空或超过 10000 章节。');
    for (const [index, node] of spine.entries()) {
      const item = manifest.get(attributes(node)['@_idref']);
      if (!item || !['application/xhtml+xml', 'text/html'].includes(item['@_media-type'] ?? '')) throw new ReadingError('EPUB 阅读顺序包含不支持的正文资源。');
      const document = await readText(archivePath(posix.dirname(packagePath), item['@_href'] ?? ''));
      const body = find(document, 'body')[0];
      if (!body) throw new ReadingError('EPUB 章节缺少正文。');
      const children = body.body as Parameters<typeof plain>[0];
      const heading = find(children, 'h1')[0] ?? find(children, 'h2')[0] ?? find(document, 'title')[0];
      const title = heading ? plain(heading[tag(heading)!] as Parameters<typeof plain>[0]).trim() : '';
      yield { title: title || `第 ${index + 1} 章`, paragraphs: plain(children).split(/\n\s*\n/u).map(text => text.replace(/[\t\r\n ]+/gu, ' ').trim()).filter(Boolean) };
    }
  } finally { zip.close(); }
}
