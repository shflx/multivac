import type { SessionFileReference } from '@multivac/contracts';

interface Node {
  type: string;
  value?: string;
  url?: string;
  children?: Node[];
  position?: { start: { offset?: number }; end: { offset?: number } };
  data?: { hName?: string; hProperties?: Record<string, unknown> };
}

/** 只消费服务端冻结区间，不在浏览器中识别路径或猜测来源。 */
export function fileReferencePositions({ references }: { references: readonly SessionFileReference[] }) {
  return (tree: Node, file: { value: unknown }) => {
    const text = String(file.value);
    const visit = (node: Node) => {
      if (['link', 'linkReference', 'image', 'imageReference', 'code'].includes(node.type)) return;
      if ((node.type === 'text' || node.type === 'inlineCode') && node.value !== undefined) {
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        if (start === undefined || end === undefined) return;
        const valueStart = start + (node.type === 'inlineCode' ? /^`+/u.exec(text.slice(start, end))?.[0].length ?? 0 : 0);
        if (text.slice(valueStart, valueStart + node.value.length) !== node.value) return;
        const matches = references.map((source, index) => ({ source, index })).filter(({ source }) =>
          source.kind !== 'image' && source.startOffset !== undefined && source.endOffset !== undefined &&
          source.startOffset >= valueStart && source.endOffset <= valueStart + node.value!.length && source.endOffset > source.startOffset,
        ).filter(({ source }) => {
          const literal = text.slice(source.startOffset, source.endOffset);
          return literal === source.href || (literal.startsWith(':') && source.href === `${source.path}${literal}`);
        }).sort((a, b) => a.source.startOffset! - b.source.startOffset!);
        if (!matches.length) return;
        const children: Node[] = [];
        let offset = valueStart;
        for (const { source, index } of matches) {
          if (source.startOffset! < offset) continue;
          if (source.startOffset! > offset) children.push({ type: 'text', value: text.slice(offset, source.startOffset) });
          children.push({ type: 'link', url: source.href, data: { hName: 'span', hProperties: { 'data-file-reference': index } }, children: [{ type: 'text', value: text.slice(source.startOffset, source.endOffset) }] });
          offset = source.endOffset!;
        }
        if (offset < valueStart + node.value.length) children.push({ type: 'text', value: text.slice(offset, valueStart + node.value.length) });
        // 用显式 code 容器保留行内代码样式，同时允许其中部分文字成为入口。
        node.data = { hName: node.type === 'inlineCode' ? 'code' : 'span' };
        node.type = 'emphasis';
        delete node.value;
        node.children = children;
        return;
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

export function fileReferenceHrefMatches(source: SessionFileReference, href: string | undefined): boolean {
  if (!href) return false;
  try { return decodeURI(source.href) === decodeURI(href); }
  catch { return source.href === href; }
}

export function fileReferenceTitle(source: SessionFileReference): string {
  return `${source.root}/${source.path}${source.line ? `:${source.line}${source.endLine ? `–${source.endLine}` : ''}` : source.section ? `#${source.section}` : ''}`;
}
