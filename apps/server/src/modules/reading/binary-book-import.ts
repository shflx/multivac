import { dirname, join, posix } from 'node:path';
import { createRequire } from 'node:module';
import { unzipSync } from 'fflate';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { BOOK_BINARY_LIMIT_BYTES, BOOK_EXTRACTED_LIMIT_BYTES, BOOK_MAX_PARAGRAPHS, BOOK_MAX_PARAGRAPH_LENGTH, type BinaryBookImport, type Book } from '@multivac/contracts';
import { ReadingError, readingHash } from './book-import.js';

export type Chapter = { title: string; paragraphs: string[] };

export function decodeBookSource(input: BinaryBookImport): Buffer {
  if (input.dataBase64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(input.dataBase64)) throw new ReadingError('书籍文件编码无效。');
  const source = Buffer.from(input.dataBase64, 'base64');
  if (!source.length || source.toString('base64') !== input.dataBase64) throw new ReadingError('书籍文件编码无效。');
  if (source.length > BOOK_BINARY_LIMIT_BYTES) throw new ReadingError('PDF、EPUB 文件最多 20 MiB。', 413);
  return source;
}

/** 只保存文本快照；原文件、图片、脚本和外部资源不交给浏览器执行。 */
export async function parseBinaryBook(input: BinaryBookImport, source: Uint8Array): Promise<Book> {
  let parts: Chapter[];
  try { parts = input.format === 'pdf' ? await pdfChapters(source) : epubChapters(source); }
  catch (error) {
    if (error instanceof ReadingError) throw error;
    if ((error as Error).name === 'PasswordException') throw new ReadingError('PDF 已加密，请先解密后再导入。');
    throw new ReadingError(`${input.format.toUpperCase()} 文件损坏或格式不受支持。`);
  }
  let count = 0, bytes = 0;
  const chapters: Book['chapters'] = parts.map((part, index) => {
    const id = `c${index + 1}`;
    const paragraphs: Book['chapters'][number]['paragraphs'] = [];
    for (const raw of part.paragraphs) {
      const text = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/gu, '').trim();
      if (!text) continue;
      bytes += Buffer.byteLength(text, 'utf8');
      if (bytes > BOOK_EXTRACTED_LIMIT_BYTES) throw new ReadingError('提取正文超过 8 MiB 限制。', 413);
      // 在 Unicode 码点边界拆分长段，保证引用端点不拆开代理对。
      let offset = 0;
      while (offset < text.length) {
        let end = Math.min(offset + BOOK_MAX_PARAGRAPH_LENGTH, text.length);
        if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]!)) --end;
        if (++count > BOOK_MAX_PARAGRAPHS) throw new ReadingError('正文超过 5000 段限制。', 413);
        paragraphs.push({ id: `${id}:p${paragraphs.length + 1}`, text: text.slice(offset, end) });
        offset = end;
      }
    }
    return { id, title: Array.from(part.title).slice(0, 150).join(''), paragraphs };
  });
  if (!count) throw new ReadingError(input.format === 'pdf' ? 'PDF 没有可提取文字，扫描版暂不支持 OCR。' : 'EPUB 没有可读正文。');
  if (!input.title.trim()) throw new ReadingError('书名不能为空。');
  const version = readingHash(Buffer.concat([Buffer.from(`${input.format}\n`), source]));
  return { id: `book-${version}`, version, title: input.title.trim(), author: input.author.trim(), format: input.format, createdAt: new Date().toISOString(), paragraphCount: count, chapters };
}

async function pdfChapters(source: Uint8Array): Promise<Chapter[]> {
  if (Buffer.from(source.subarray(0, 1024)).indexOf('%PDF-') < 0) throw new ReadingError('文件不是有效的 PDF。');
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const resources = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
  const loading = getDocument({
    data: new Uint8Array(source), useSystemFonts: false, disableFontFace: true, useWorkerFetch: false, verbosity: 0,
    // 中日韩字符映射和标准字体仅从随依赖安装的资源读取，不请求书中外链。
    cMapUrl: join(resources, 'cmaps/'), cMapPacked: true, standardFontDataUrl: join(resources, 'standard_fonts/'),
  });
  try {
    const pdf = await loading.promise;
    if (pdf.numPages > 1000) throw new ReadingError('PDF 最多 1000 页。', 413);
    const chapters: Chapter[] = [];
    let bytes = 0;
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items) {
        if (!('str' in item)) continue;
        text += item.str + (item.hasEOL ? '\n' : '');
      }
      bytes += Buffer.byteLength(text, 'utf8');
      if (bytes > BOOK_EXTRACTED_LIMIT_BYTES) throw new ReadingError('提取正文超过 8 MiB 限制。', 413);
      chapters.push({ title: `第 ${number} 页`, paragraphs: text.split(/\n\s*\n/u) });
      page.cleanup();
    }
    return chapters;
  } finally { await loading.destroy(); }
}

type XmlNode = { [key: string]: XmlNode[] | string | Record<string, string> };
const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, removeNSPrefix: true, trimValues: false, parseTagValue: false, processEntities: true, htmlEntities: true });
export function xml(data: Uint8Array): XmlNode[] {
  const encoding = data[0] === 0xff && data[1] === 0xfe || data[0] === 0x3c && data[1] === 0
    ? 'utf-16le' : data[0] === 0xfe && data[1] === 0xff || data[0] === 0 && data[1] === 0x3c ? 'utf-16be' : 'utf-8';
  const text = new TextDecoder(encoding, { fatal: true }).decode(data);
  if (/<!ENTITY\b/iu.test(text) || XMLValidator.validate(text) !== true) throw new ReadingError('EPUB XML 结构无效或包含不支持的实体声明。');
  return parser.parse(text) as XmlNode[];
}
export const tag = (node: XmlNode) => Object.keys(node).find(key => !key.startsWith(':') && !key.startsWith('#') && !key.startsWith('?'));
export function find(nodes: XmlNode[], name: string): XmlNode[] {
  return nodes.flatMap(node => {
    const key = tag(node);
    return key ? [...(key === name ? [node] : []), ...find(node[key] as XmlNode[], name)] : [];
  });
}
export const attributes = (node: XmlNode) => (node[':@'] ?? {}) as Record<string, string>;
export function plain(nodes: XmlNode[]): string {
  return nodes.map(node => {
    if (typeof node['#text'] === 'string') return node['#text'];
    const key = tag(node);
    if (!key || ['script', 'style', 'svg', 'math', 'iframe', 'object', 'head', 'img'].includes(key)) return '';
    if (key === 'br') return '\n';
    const text = plain(node[key] as XmlNode[]);
    return /^(p|div|section|article|h[1-6]|li|blockquote|pre|tr)$/u.test(key) ? `\n\n${text}\n\n` : text;
  }).join('');
}
export function archivePath(base: string, href: string): string {
  let decoded: string;
  try { decoded = decodeURIComponent(href.split(/[?#]/u)[0]!); } catch { throw new ReadingError('EPUB 资源路径无效。'); }
  if (!decoded || decoded.startsWith('/') || /[:\\\u0000]/u.test(decoded)) throw new ReadingError('EPUB 资源必须位于书籍内部。');
  const path = posix.normalize(posix.join(base, decoded));
  if (path === '..' || path.startsWith('../')) throw new ReadingError('EPUB 资源路径超出书籍范围。');
  return path;
}
function epubChapters(source: Uint8Array): Chapter[] {
  let total = 0, count = 0;
  const names = new Set<string>();
  // 解压前限制条目数与声明大小，只在内存读取，不写入归档中的任何路径。
  const files = unzipSync(source, { filter: entry => {
    if (++count > 2000 || entry.originalSize > 16 * 1024 * 1024 || (total += entry.originalSize) > 64 * 1024 * 1024) throw new ReadingError('EPUB 解压内容超过限制。', 413);
    if (names.has(entry.name)) throw new ReadingError('EPUB 包含重复资源路径。');
    names.add(entry.name);
    archivePath('.', entry.name);
    return true;
  } });
  const read = (path: string) => { const data = files[path]; if (!data) throw new ReadingError(`EPUB 缺少阅读所需资源：${path}`); return data; };
  if (new TextDecoder().decode(read('mimetype')).trim() !== 'application/epub+zip') throw new ReadingError('文件不是有效的 EPUB。');
  const encrypted = new Set(files['META-INF/encryption.xml']
    ? find(xml(files['META-INF/encryption.xml']), 'CipherReference').map(node => archivePath('.', attributes(node)['@_URI'] ?? '')) : []);
  const readText = (path: string) => {
    if (encrypted.has(path)) throw new ReadingError('EPUB 正文已加密，请使用未加密版本。');
    return xml(read(path));
  };
  const root = find(xml(read('META-INF/container.xml')), 'rootfile').find(node => attributes(node)['@_media-type'] === 'application/oebps-package+xml');
  if (!root) throw new ReadingError('EPUB 缺少内容目录。');
  const packagePath = archivePath('.', attributes(root)['@_full-path'] ?? '');
  const opf = readText(packagePath);
  const manifest = new Map(find(opf, 'item').map(node => [attributes(node)['@_id'], attributes(node)]));
  const spine = find(opf, 'itemref').filter(node => attributes(node)['@_linear'] !== 'no');
  if (!spine.length || spine.length > 1000) throw new ReadingError('EPUB 阅读顺序为空或超过 1000 章节。');
  return spine.map((node, index) => {
    const item = manifest.get(attributes(node)['@_idref']);
    if (!item || !['application/xhtml+xml', 'text/html'].includes(item['@_media-type'] ?? '')) throw new ReadingError('EPUB 阅读顺序包含不支持的正文资源。');
    const document = readText(archivePath(posix.dirname(packagePath), item['@_href'] ?? ''));
    const body = find(document, 'body')[0];
    if (!body) throw new ReadingError('EPUB 章节缺少正文。');
    const children = body.body as XmlNode[];
    const heading = find(children, 'h1')[0] ?? find(children, 'h2')[0] ?? find(document, 'title')[0];
    const title = heading ? plain(heading[tag(heading)!] as XmlNode[]).trim() : '';
    return { title: title || `第 ${index + 1} 章`, paragraphs: plain(children).split(/\n\s*\n/u).map(text => text.replace(/[\t\r\n ]+/gu, ' ').trim()).filter(Boolean) };
  });
}
