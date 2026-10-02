import { fromMarkdown } from 'mdast-util-from-markdown';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { AssistantMessageView, SessionFileReference } from '@multivac/contracts';
import { isPathWithin } from '../modules/sessions/working-directory.js';

export interface MessageFileSourceRepository {
  get(sessionId: string, piSessionId: string, entryId: string): SessionFileReference[] | null;
  putIfAbsent(sessionId: string, piSessionId: string, entryId: string, references: SessionFileReference[]): void;
}

/** 只识别 Markdown 来源，不从路径文字或代码块推断文件权限。 */
export function messageFileReferences(text: string, root: string, includeImages = false): SessionFileReference[] {
  if (text.length > 512 * 1024) return [];
  const tree = fromMarkdown(text);
  const definitions = new Map<string, string>();
  for (const node of tree.children) if (node.type === 'definition') definitions.set(node.identifier, node.url);
  const references: SessionFileReference[] = [];
  const add = (href: string, image = false) => {
    if (href.length > 8192 || references.length >= 20 || references.some((reference) => reference.href === href)) return;
    try {
      if (href.startsWith('#') || href.startsWith('//')) return;
      let rawPath: string;
      let fragment: string;
      if (/^[a-z][a-z\d+.-]*:/i.test(href)) {
        const url = new URL(href);
        if (url.protocol !== 'file:' || url.host || url.search) return;
        rawPath = decodeURIComponent(url.pathname); fragment = decodeURIComponent(url.hash.slice(1));
      } else {
        const parts = href.split('#');
        if (!parts[0] || parts[0].includes('?')) return;
        rawPath = decodeURIComponent(parts[0]); fragment = decodeURIComponent(parts.slice(1).join('#'));
      }
      if (rawPath.includes('\0') || rawPath.includes('\\') || rawPath.split('/').includes('..')) return;
      const absolute = isAbsolute(rawPath) ? resolve(rawPath) : resolve(root, rawPath);
      if (!isPathWithin(resolve(root), absolute)) return;
      const path = relative(resolve(root), absolute).split(sep).join('/');
      if (!path || path.length > 4096) return;
      const lines = /^L([1-9]\d*)(?:-L?([1-9]\d*))?$/u.exec(fragment);
      if (fragment.startsWith('L') && !lines) return;
      const line = lines ? Number(lines[1]) : undefined;
      const endLine = lines?.[2] ? Number(lines[2]) : undefined;
      if ((line && line > 20000) || (endLine && (endLine > 20000 || endLine < line!)) || fragment.length > 500) return;
      references.push({ root, path, href, ...(image ? { kind: 'image' as const } : {}), ...(line ? { line } : {}), ...(endLine ? { endLine } : {}), ...(!lines && fragment ? { section: fragment } : {}) });
    } catch { /* 非法 URL 或编码不产生可操作来源。 */ }
  };
  const visit = (node: (typeof tree)['children'][number] | typeof tree) => {
    if (node.type === 'link') add(node.url);
    if (node.type === 'linkReference') { const url = definitions.get(node.identifier); if (url) add(url); }
    if (includeImages && node.type === 'image') add(node.url, true);
    if (includeImages && node.type === 'imageReference') { const url = definitions.get(node.identifier); if (url) add(url, true); }
    if ('children' in node) for (const child of node.children) visit(child);
  };
  visit(tree);
  return references;
}

export class MessageFileSources {
  constructor(private readonly repository: MessageFileSourceRepository) {}
  seed(sessionId: string, messages: readonly AssistantMessageView[]): void {
    for (const message of messages) this.repository.putIfAbsent(sessionId, message.piSessionId, message.piEntryId, []);
  }
  capture(sessionId: string, root: string, messages: readonly AssistantMessageView[]): void {
    for (const message of messages) {
      if (this.repository.get(sessionId, message.piSessionId, message.piEntryId) !== null) continue;
      this.repository.putIfAbsent(sessionId, message.piSessionId, message.piEntryId, message.role === 'assistant' ? messageFileReferences(message.text, root, true) : []);
    }
  }
  project(sessionId: string, message: AssistantMessageView): AssistantMessageView {
    const references = this.repository.get(sessionId, message.piSessionId, message.piEntryId) ?? [];
    return references.length ? { ...message, fileReferences: references } : message;
  }
}
