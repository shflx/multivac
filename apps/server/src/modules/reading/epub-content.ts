import sharp from 'sharp';
import { posix } from 'node:path';
import { XMLBuilder } from 'fast-xml-parser';
import { BOOK_MAX_PARAGRAPH_LENGTH, type Book, type BookImage } from '@multivac/contracts';
import { xml, find, tag, attributes, plain, archivePath } from './epub-xml.js';
import { ReadingError, readingHash } from './book-import.js';

type Nodes = Parameters<typeof plain>[0];
export type ImageWriter = (id: string, data: Uint8Array) => Promise<void>;
export type IllustratedChapter = { title: string; paragraphs: string[]; images?: BookImage[] };
const marker = /\uE000IMG(\d+)\uE001/gu;
const clean = (text: string) => text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/gu, '').replace(/[\t\r\n ]+/gu, ' ');
const svgTags = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'defs', 'clipPath', 'mask', 'linearGradient', 'radialGradient', 'stop', 'use', 'title', 'desc']);
const svgAttrs = new Set(['id', 'xmlns', 'viewBox', 'width', 'height', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'd', 'points', 'transform', 'fill', 'fill-rule', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'opacity', 'clip-path', 'mask', 'offset', 'stop-color', 'stop-opacity', 'gradientUnits', 'gradientTransform', 'font-size', 'font-family', 'font-weight', 'text-anchor', 'dx', 'dy', 'href']);

/** 重建静态 SVG 白名单后才交给栅格化器；不传入样式、脚本、外部 href 或实体。 */
export function staticSvg(nodes: Nodes): Buffer {
  const sanitize = (children: Nodes): Nodes => children.filter(node => !Object.keys(node).some(key => key.startsWith('?') || key === '#comment')).map<Nodes[number]>(node => {
    if (typeof node['#text'] === 'string') return { '#text': node['#text'] };
    const key = tag(node);
    if (!key || !svgTags.has(key)) throw new ReadingError('SVG 包含不支持的元素，无法安全展示。');
    const attrs: Record<string, string> = {};
    for (const [name, value] of Object.entries(attributes(node))) {
      const local = name.slice(2);
      if (!svgAttrs.has(local) || value.length > 100000 || /[\\\u0000-\u001f]/u.test(value) || /\/\*|\*\//u.test(value)) throw new ReadingError('SVG 包含不支持的样式或属性。');
      if (local === 'href' && !/^#[A-Za-z0-9_.:-]+$/u.test(value) || /url\(/iu.test(value) && !/^url\(#[A-Za-z0-9_.:-]+\)$/u.test(value)) throw new ReadingError('SVG 外部资源不可用。');
      attrs[name] = value;
    }
    if (key === 'svg') attrs['@_xmlns'] = 'http://www.w3.org/2000/svg';
    return { [key]: sanitize(node[key] as Nodes), ':@': attrs };
  });
  return Buffer.from(new XMLBuilder({ preserveOrder: true, ignoreAttributes: false }).build(sanitize(nodes)));
}

/** 兼容 EPUB 2 的 cover 元数据与 EPUB 3 cover-image；已有首页封面不重复插入。 */
export function coverBody(children: Nodes, opf: Nodes, packagePath: string, chapterPath: string): Nodes {
  const legacyId = find(opf, 'meta').find(node => attributes(node)['@_name'] === 'cover');
  const cover = find(opf, 'item').find(node => (attributes(node)['@_properties'] ?? '').split(/\s+/u).includes('cover-image') || legacyId && attributes(node)['@_id'] === attributes(legacyId)['@_content']);
  if (!cover) return children;
  let path: string;
  try { path = archivePath(posix.dirname(packagePath), attributes(cover)['@_href'] ?? ''); }
  catch { return [{ img: [], ':@': { '@_src': attributes(cover)['@_href'] ?? '', '@_alt': '封面' } }, ...children]; }
  const exists = [...find(children, 'img'), ...find(children, 'image')].some(node => {
    const attrs = attributes(node);
    try { return archivePath(posix.dirname(chapterPath), attrs['@_src'] ?? attrs['@_href'] ?? attrs['@_xlink:href'] ?? '') === path; } catch { return false; }
  });
  if (exists) return children;
  return [{ img: [], ':@': { '@_src': posix.relative(posix.dirname(chapterPath), path), '@_alt': '封面' } }, { br: [] }, { br: [] }, ...children];
}

async function imageResource(data: Uint8Array, svg: boolean, write?: ImageWriter): Promise<Pick<BookImage, 'resourceId' | 'width' | 'height'>> {
  if (!write) throw new ReadingError('图片资源保存不可用，请补建图文内容。');
  if (data.byteLength > 16 * 1024 * 1024) throw new ReadingError('图片超过 16 MiB 处理预算。');
  const bytes = Buffer.from(data);
  const raster = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes[0] === 255 && bytes[1] === 216 || bytes.subarray(0, 3).toString() === 'GIF' || bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
  const xmlLike = svg || /^(?:\s*<|\uFEFF)/u.test(bytes.subarray(0, 256).toString('utf8')) || bytes[0] === 0xff && bytes[1] === 0xfe || bytes[0] === 0xfe && bytes[1] === 0xff;
  if (!xmlLike && !raster) throw new ReadingError('图片格式不受支持。');
  const safe = raster ? bytes : staticSvg(xml(data));
  const { data: png, info } = await sharp(safe, { limitInputPixels: 40_000_000, pages: 1 }).rotate().resize({ width: 1600, height: 2000, fit: 'inside', withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true });
  const resourceId = readingHash(png);
  await write(resourceId, png);
  return { resourceId, width: info.width, height: info.height };
}

/** 保留原 plain() 的段落边界，用零宽标记记录图片在原文中的偏移。 */
export async function illustratedChapter(title: string, children: Nodes, base: string, read: (path: string) => Promise<Uint8Array>, encrypted: Set<string>, write?: ImageWriter): Promise<IllustratedChapter> {
  const images: BookImage[] = [];
  async function walk(nodes: Nodes): Promise<string> {
    let result = '';
    for (const node of nodes) {
      if (typeof node['#text'] === 'string') {
        if (/\uE000IMG\d+\uE001/u.test(node['#text'])) throw new ReadingError('EPUB 正文包含保留标记。');
        result += node['#text']; continue;
      }
      const key = tag(node); if (!key) continue;
      if (key === 'img' || key === 'svg' || key === 'image') {
        if (images.length >= 2000) throw new ReadingError('章节图片超过处理预算。', 413);
        const attrs = attributes(node);
        const nestedImages = key === 'svg' ? find(node[key] as Nodes, 'image') : [];
        const hasDrawing = key === 'svg' && ['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'use'].some(name => find(node[key] as Nodes, name).length);
        const nested = nestedImages.length === 1 && !hasDrawing ? nestedImages[0] : undefined;
        const src = nested ? attributes(nested)['@_href'] ?? attributes(nested)['@_xlink:href'] : attrs['@_src'] ?? attrs['@_href'] ?? attrs['@_xlink:href'];
        const alt = (attrs['@_alt'] ?? attrs['@_aria-label'] ?? '书内插图').slice(0, 500);
        let resource: Pick<BookImage, 'resourceId' | 'width' | 'height' | 'error'> = { width: 640, height: 480 };
        try {
          if (key === 'svg' && !src) resource = await imageResource(staticSvg([node]), true, write);
          else {
            const path = archivePath(base, src ?? '');
            if (encrypted.has(path)) throw new ReadingError('图片已加密，无法展示。');
            resource = await imageResource(await read(path), /\.svg$/iu.test(path), write);
          }
        } catch (error) {
          if (error instanceof ReadingError && error.status === 507 || (error as NodeJS.ErrnoException).code === 'ENOSPC') throw error;
          resource.error = error instanceof ReadingError ? error.message.slice(0, 300) : '图片损坏或无法解码。';
        }
        const index = images.length;
        images.push({ id: `image-${index + 1}`, offset: 0, alt, ...resource });
        result += `\uE000IMG${index}\uE001`; continue;
      }
      if (['script', 'style', 'math', 'iframe', 'object', 'head'].includes(key)) continue;
      if (key === 'br') { result += '\n'; continue; }
      const text = await walk(node[key] as Nodes);
      result += /^(p|div|section|article|h[1-6]|li|blockquote|pre|tr)$/u.test(key) ? `\n\n${text}\n\n` : text;
    }
    return result;
  }
  return { title, paragraphs: (await walk(children)).split(/\n\s*\n/u), images };
}

/** 文字段落编号只随文字递增；纯图片段落另用 i 前缀，旧 p 编号和 UTF-16 偏移保持不变。 */
export function normalizeIllustratedChapter(part: IllustratedChapter, ordinal: number): Book['chapters'][number] {
  const id = `c${ordinal + 1}`, paragraphs: Book['chapters'][number]['paragraphs'] = [];
  let textCount = 0, imageCount = 0;
  for (const raw of part.paragraphs) {
    const matches = [...raw.matchAll(marker)];
    const text = clean(raw.replace(marker, '')).trim();
    const placed = matches.map(match => {
      const image = part.images?.[Number(match[1])];
      if (!image) throw new ReadingError('EPUB 图片索引无效。');
      return { ...image, id: `${id}:image${++imageCount}`, offset: Math.min(text.length, clean(raw.slice(0, match.index).replace(marker, '')).trimStart().length) };
    });
    if (!text) {
      if (placed.length) paragraphs.push({ id: `${id}:i${imageCount}`, text: '', images: placed });
      continue;
    }
    for (let start = 0; start < text.length;) {
      let end = Math.min(start + BOOK_MAX_PARAGRAPH_LENGTH, text.length);
      if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]!)) --end;
      const images = placed.filter(image => image.offset >= start && (image.offset < end || end === text.length && image.offset === end)).map(image => ({ ...image, offset: image.offset - start }));
      paragraphs.push({ id: `${id}:p${++textCount}`, text: text.slice(start, end), ...(images.length ? { images } : {}) }); start = end;
    }
  }
  return { id, title: Array.from(part.title).slice(0, 150).join(''), paragraphs };
}
