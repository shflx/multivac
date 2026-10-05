import { useId, useLayoutEffect, useRef, useState } from 'react';

/** 按实际排版判断截断，笔记和摘录共用展开行为。 */
export function useReadingTextPreview(text: string, lines: number) {
  const id = useId();
  const element = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [truncated, setTruncated] = useState(false);
  useLayoutEffect(() => {
    const node = element.current;
    if (!node) return;
    const measure = () => {
      // 展开后仍按完整正文高度判断，保留收起入口；尺寸或字体变化后重新测量。
      const overflowing = node.scrollHeight > Math.ceil(parseFloat(getComputedStyle(node).lineHeight) * lines) + 1;
      setTruncated(overflowing);
      if (!overflowing) setExpanded(false);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    document.fonts.addEventListener('loadingdone', measure);
    measure();
    return () => { observer.disconnect(); document.fonts.removeEventListener('loadingdone', measure); };
  }, [text, lines]);
  return { id, element, expanded, truncated, toggle: () => setExpanded(value => !value) };
}
