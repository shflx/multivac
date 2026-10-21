import { fromMarkdown } from 'mdast-util-from-markdown';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { AssistantMessageView, SessionFileReference } from '@multivac/contracts';
import { isPathWithin } from '../modules/sessions/working-directory.js';

export interface MessageFileSourceRepository {
  get(sessionId: string, runtimeSessionId: string, entryId: string): SessionFileReference[] | null;
  putIfAbsent(sessionId: string, runtimeSessionId: string, entryId: string, references: SessionFileReference[]): void;
}

/** 路径识别只记录来源，实际读取仍由会话文件服务校验权限。 */
export function messageFileReferences(text: string, root: string, includeImages = false): SessionFileReference[] {
  if (text.length > 512 * 1024) return [];
  const tree = fromMarkdown(text);
  type Node = (typeof tree)['children'][number] | typeof tree;
  const definitions = new Map<string, string>();
  const collectDefinitions = (node: Node) => {
    if (node.type === 'definition') definitions.set(node.identifier, node.url);
    if ('children' in node) for (const child of node.children) collectDefinitions(child);
  };
  collectDefinitions(tree);
  const references: SessionFileReference[] = [];
  const add = (href: string, startOffset: number, endOffset: number, image = false): SessionFileReference | undefined => {
    if (href.length > 8192 || references.length >= 20) return;
    try {
      if (href.startsWith('#') || href.startsWith('//')) return;
      let rawPath: string;
      let fragment: string;
      if (/^file:/i.test(href)) {
        const url = new URL(href);
        if (url.protocol !== 'file:' || url.host || url.search) return;
        rawPath = decodeURIComponent(url.pathname); fragment = decodeURIComponent(url.hash.slice(1));
      } else {
        const parts = href.split('#');
        if (!parts[0] || parts[0].includes('?')) return;
        rawPath = decodeURIComponent(parts[0]); fragment = decodeURIComponent(parts.slice(1).join('#'));
      }
      const suffix = /:(\d+)(?:[-–](\d+))?$/u.exec(rawPath);
      if (suffix) rawPath = rawPath.slice(0, suffix.index);
      // 冒号仅可用于行号；拒绝 URL、盘符及不完整的定位。
      if (!rawPath || rawPath.includes(':') || rawPath.includes('\0') || rawPath.includes('\\') || rawPath.split('/').includes('..')) return;
      if (suffix && fragment) return;
      const absolute = isAbsolute(rawPath) ? resolve(rawPath) : resolve(root, rawPath);
      if (!isPathWithin(resolve(root), absolute)) return;
      const path = relative(resolve(root), absolute).split(sep).join('/');
      if (!path || path.length > 4096) return;
      const lines = /^L(\d+)(?:[-–]L?(\d+))?$/u.exec(fragment);
      if (fragment.startsWith('L') && !lines) return;
      const location = suffix ?? lines;
      const line = location ? Number(location[1]) : undefined;
      const endLine = location?.[2] ? Number(location[2]) : undefined;
      if ((line !== undefined && (!Number.isSafeInteger(line) || line < 1 || line > 20000)) || (endLine !== undefined && (!Number.isSafeInteger(endLine) || endLine > 20000 || endLine < line!)) || fragment.length > 500) return;
      const reference: SessionFileReference = { root, path, href, startOffset, endOffset, ...(image ? { kind: 'image' as const } : {}), ...(line ? { line } : {}), ...(endLine ? { endLine } : {}), ...(!lines && fragment ? { section: fragment } : {}) };
      references.push(reference);
      return reference;
    } catch { return; /* 非法 URL 或编码不产生可操作来源。 */ }
  };
  const visit = (node: Node, context: Set<string>, inListItem = false) => {
    // 列表项独立持有上下文；普通段落之间不继承文件。
    if (node.type === 'listItem') { context = new Set(); inListItem = true; }
    else if ((node.type === 'paragraph' || node.type === 'heading') && !inListItem) context = new Set();
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;
    if (node.type === 'link' || node.type === 'linkReference' || (includeImages && (node.type === 'image' || node.type === 'imageReference'))) {
      const href = 'url' in node ? node.url : definitions.get(node.identifier);
      const image = node.type === 'image' || node.type === 'imageReference';
      const reference = href ? add(href, start, end, image) : undefined;
      if (reference && !image) context.add(reference.path);
      else if (href && !image && !/^(?:[a-z][a-z\d+.-]*:\/|mailto:|multivac:|#)/i.test(href)) context.add(href);
      return; // 链接标签与图片替代文字不重复识别。
    }
    if (node.type === 'text' || node.type === 'inlineCode') {
      let valueStart = start;
      if (node.type === 'inlineCode') valueStart += /^`+/u.exec(text.slice(start, end))?.[0].length ?? 0;
      // Markdown 转义和代码空白归一化无法直接映射时保守退化。
      if (text.slice(valueStart, valueStart + node.value.length) !== node.value) return;
      const pattern = /(?:^|(?<=[\s（(\[，。；：、]))((?:[\p{L}\p{N}_@+./-]+\/[\p{L}\p{N}_@+.-]+|[\p{L}\p{N}_@+-][\p{L}\p{N}_@+.-]*\.[\p{L}_][\p{L}\p{N}_+-]*)(?::\d+(?:[-–]\d+)?)?|:\d+(?:[-–]\d+)?)(?=$|[\s）)\]，。；、!?！？,]|\.(?:\s|$))/gu;
      for (const match of node.value.matchAll(pattern)) {
        const literal = match[1]!;
        if (literal.startsWith('www.')) continue;
        const offset = valueStart + match.index!;
        if (literal.startsWith(':')) {
          if (context.size === 1) add(`${[...context][0]}${literal}`, offset, offset + literal.length);
        } else {
          const reference = add(literal, offset, offset + literal.length);
          if (reference) context.add(reference.path);
          else context.add(literal); // 无效或越界的前置文件不能让后续省略引用沿用更早来源。
        }
      }
      return;
    }
    if ('children' in node) for (const child of node.children) visit(child, context, inListItem);
  };
  visit(tree, new Set());
  return references;
}

function recordKey(sessionId: string, message: AssistantMessageView): string {
  return `${sessionId}\0${message.runtimeSessionId}\0${message.runtimeEntryId}`;
}

export class MessageFileSources {
  // 来源只写入一次、之后不变：记住已有记录的消息，每次采集只处理新增消息，不随历史长度逐条回查。
  private readonly recorded = new Set<string>();

  constructor(private readonly repository: MessageFileSourceRepository) {}

  seed(sessionId: string, messages: readonly AssistantMessageView[]): void {
    for (const message of messages) {
      const key = recordKey(sessionId, message);
      if (this.recorded.has(key)) continue;
      this.repository.putIfAbsent(sessionId, message.runtimeSessionId, message.runtimeEntryId, []);
      this.recorded.add(key);
    }
  }

  capture(sessionId: string, root: string, messages: readonly AssistantMessageView[]): void {
    for (const message of messages) {
      const key = recordKey(sessionId, message);
      if (this.recorded.has(key)) continue;
      if (this.repository.get(sessionId, message.runtimeSessionId, message.runtimeEntryId) === null) {
        this.repository.putIfAbsent(sessionId, message.runtimeSessionId, message.runtimeEntryId, message.role === 'assistant' ? messageFileReferences(message.text, root, true) : []);
      }
      this.recorded.add(key);
    }
  }
  project(sessionId: string, message: AssistantMessageView): AssistantMessageView {
    const references = this.repository.get(sessionId, message.runtimeSessionId, message.runtimeEntryId) ?? [];
    return references.length ? { ...message, fileReferences: references } : message;
  }
}
