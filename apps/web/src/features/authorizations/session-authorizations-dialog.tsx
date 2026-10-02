import { X } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useLayoutEffect, useRef } from 'react';
import { focusableWithin, wrapFocusIndex } from '../../components/focus-trap.js';
import { SessionAuthorizations } from './session-authorizations.js';

/** 工作会话与归档共用的轻量授权窗口；关闭后返回入口，撤销确认卡在窗口之上。 */
export function SessionAuthorizationsDialog({ sessionId, title, onClose }: {
  sessionId: string; title: string; onClose: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const previous = useRef(document.activeElement);
  useLayoutEffect(() => {
    const dialog = root.current;
    const focusClose = () => dialog?.querySelector<HTMLButtonElement>('button')?.focus();
    focusClose();
    // 重试成功或撤销后按钮可能消失；焦点落空时仍留在模态窗口内。
    const observer = new MutationObserver(() => {
      if (dialog?.isConnected && document.activeElement === document.body) focusClose();
    });
    if (dialog) observer.observe(dialog, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      if (previous.current instanceof HTMLElement && previous.current.isConnected && previous.current.checkVisibility()) {
        previous.current.focus({ preventScroll: true });
      }
    };
  }, []);
  return createPortal(<div className="session-authorizations-scrim" onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <div ref={root} className="session-authorizations-dialog" role="dialog" aria-modal="true" aria-label={`「${title}」的授权`} onKeyDown={(event) => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      if (event.key === 'Tab') {
        const items = focusableWithin(event.currentTarget);
        const next = wrapFocusIndex(items.length, items.indexOf(document.activeElement as HTMLElement), event.shiftKey);
        if (next !== null) { event.preventDefault(); items[next]?.focus(); }
      }
    }}>
      <header className="browser-toolbar"><strong>{title} · 授权</strong><button className="icon-button" aria-label="关闭授权" onClick={onClose}><X /></button></header>
      <div className="session-authorizations-body"><SessionAuthorizations sessionId={sessionId} visible /></div>
    </div>
  </div>, document.body);
}
