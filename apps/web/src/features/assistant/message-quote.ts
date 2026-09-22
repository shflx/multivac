import type { AssistantQuote } from '@multivac/contracts';

/** 浮动工具条的尺寸用于夹取位置，与样式表中的取值保持一致。 */
const TOOLBAR_WIDTH_PX = 112;
const TOOLBAR_HEIGHT_PX = 36;
const TOOLBAR_GAP_PX = 8;
const VIEWPORT_MARGIN_PX = 12;

export interface QuoteSelectionCandidate {
  quote: AssistantQuote;
  left: number;
  top: number;
}

export interface QuoteViewport {
  width: number;
  height: number;
}

/**
 * 去掉选区首尾空白，其余原样保留。
 *
 * 不把连续空白压成单空格：代码、列表缩进与段落换行都是引用语义的一部分，
 * 压平后送给模型的内容会与用户所见不一致。
 */
export function normalizeQuoteText(raw: string): string {
  return raw.replace(/\r\n?/gu, '\n').replace(/^\s+|\s+$/gu, '');
}

export function sameQuote(left: AssistantQuote | null, right: AssistantQuote | null): boolean {
  if (left === null || right === null) return left === right;
  return left.sourcePiSessionId === right.sourcePiSessionId &&
    left.sourcePiEntryId === right.sourcePiEntryId &&
    left.sourceRole === right.sourceRole &&
    left.text === right.text;
}

/** 工具条不越出视口；贴近底部时翻到选区上方，避免压住输入区与发送按钮。 */
export function quoteToolbarPosition(
  rect: { left: number; top: number; bottom: number },
  viewport: QuoteViewport,
): { left: number; top: number } {
  const left = Math.max(
    VIEWPORT_MARGIN_PX,
    Math.min(rect.left, viewport.width - TOOLBAR_WIDTH_PX - VIEWPORT_MARGIN_PX),
  );
  const below = rect.bottom + TOOLBAR_GAP_PX;
  const top = below + TOOLBAR_HEIGHT_PX + VIEWPORT_MARGIN_PX > viewport.height
    ? Math.max(VIEWPORT_MARGIN_PX, rect.top - TOOLBAR_HEIGHT_PX - TOOLBAR_GAP_PX)
    : below;
  return { left, top };
}

function quoteSourceElement(node: Node | null): HTMLElement | null {
  const element = node instanceof HTMLElement ? node : node?.parentElement ?? null;
  return element?.closest<HTMLElement>('[data-quote-entry-id]') ?? null;
}

/**
 * 把当前选区解析为引用候选。
 *
 * 只有落在单条已持久化消息正文内的选区才成立：
 * 跨消息选区没有唯一来源，流式正文与工具记录没有稳定 Pi entry，二者都不带来源标记。
 */
export function captureQuoteSelection(
  root: HTMLElement,
  selection: Selection | null,
  viewport: QuoteViewport,
): QuoteSelectionCandidate | null {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;

  const text = normalizeQuoteText(selection.toString());
  if (!text) return null;

  const range = selection.getRangeAt(0);
  const host = quoteSourceElement(range.commonAncestorContainer);
  if (!host || !root.contains(host)) return null;

  const sourcePiSessionId = host.dataset.quoteSessionId;
  const sourcePiEntryId = host.dataset.quoteEntryId;
  const sourceRole = host.dataset.quoteRole;
  if (
    !sourcePiSessionId || !sourcePiEntryId ||
    (sourceRole !== 'user' && sourceRole !== 'assistant')
  ) return null;

  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;

  return {
    quote: { sourcePiSessionId, sourcePiEntryId, sourceRole, text },
    ...quoteToolbarPosition(rect, viewport),
  };
}
