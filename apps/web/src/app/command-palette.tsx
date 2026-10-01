import { createPortal } from 'react-dom';
import type { ReactNode, RefObject } from 'react';

/** 命令面板共用外框、滚动列表和底部键帽，具体按键由各面板处理。 */
export function CommandPalette({ title, children, onClose, dialogRef, panel = false }: {
  title: string; children: ReactNode; onClose: () => void; dialogRef: RefObject<HTMLDivElement | null>; panel?: boolean;
}) {
  return createPortal(<div className="palette-scrim" role="presentation" onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => {
    if (panel) event.preventDefault();
    if (event.target === event.currentTarget) { event.preventDefault(); onClose(); }
  }}>
    <div ref={dialogRef} className={`palette${panel ? ' panel-switcher' : ' quick-switcher'}`} role="dialog" aria-modal="true" aria-label={title}>{children}</div>
  </div>, document.body);
}

export function PaletteFooter({ panel = false }: { panel?: boolean }) {
  return <footer className="palette-foot"><span><kbd>↑</kbd><kbd>↓</kbd>选择</span><span><kbd>↵</kbd>{panel ? '切换' : '跳转'}</span>{panel && <span><kbd>1–3</kbd>直接跳</span>}<span><kbd>Esc</kbd>关闭</span></footer>;
}
