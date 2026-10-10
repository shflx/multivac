import { posix } from 'node:path';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { ReadingError } from './book-import.js';

export type XmlNode = { [key: string]: XmlNode[] | string | Record<string, string> };
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
