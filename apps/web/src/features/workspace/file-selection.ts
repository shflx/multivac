import type { AssistantFileQuote } from '@multivac/contracts';
import { quoteToolbarPosition } from '../assistant/message-quote.js';

export interface FileSelection { quote: AssistantFileQuote; left: number; top: number; clear: () => void }

export function captureFileSelection(host: HTMLElement, source: { sessionId: string; root: string; path: string }, offset = { left: 0, top: 0 }): FileSelection | null {
  const selection = host.ownerDocument.getSelection();
  if (!selection || !selection.rangeCount || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!host.contains(range.commonAncestorContainer) || !host.contains(range.startContainer) || !host.contains(range.endContainer)) return null;
  const text = selection.toString().replace(/\r\n?/gu, '\n');
  if (!text.trim()) return null;
  const rect = range.getBoundingClientRect();
  if (!rect.width && !rect.height) return null;
  const start = range.startContainer.parentElement?.closest<HTMLElement>('[data-line]');
  const end = range.endContainer.parentElement?.closest<HTMLElement>('[data-line]');
  const line = start ? Number(start.dataset.line) : undefined;
  const endLine = end ? Number(end.dataset.line) : undefined;
  const heading = [...host.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter((node) => node === range.startContainer.parentElement || Boolean(node.compareDocumentPosition(range.startContainer) & Node.DOCUMENT_POSITION_FOLLOWING)).at(-1)?.textContent?.trim();
  return {
    quote: { sourceKind: 'file', sourceSessionId: source.sessionId, text, sourceFile: { root: source.root, path: source.path, ...(line ? { line } : {}), ...(endLine && line && endLine > line ? { endLine } : {}), ...(!line && heading ? { section: heading.slice(0, 500) } : {}) } },
    ...quoteToolbarPosition({ left: rect.left + offset.left, top: rect.top + offset.top, bottom: rect.bottom + offset.top }, { width: window.innerWidth, height: window.innerHeight }, 360),
    clear: () => selection.removeAllRanges(),
  };
}
