import { MoreHorizontal } from 'lucide-react';
import { createPortal } from 'react-dom';
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import type { AssistantFileQuote, SessionFileEntry } from '@multivac/contracts';
import { getSessionFileTarget, revealSessionFile } from '../../data/session-files-api.js';
import './file-actions.css';

export const FileActionsActive = createContext(true);
export const FileSourceQuote = createContext<((quote: AssistantFileQuote) => void) | null>(null);

export interface FileActionProps {
  sessionId: string; root: string; path: string; kind: SessionFileEntry['kind'];
  onNotice: (message: string, error: boolean) => void;
}

/** 每个入口持有自己的目标，不读取当前选中项或工作区焦点。 */
export function FileActions({ sessionId, root, path, kind, onNotice, children }: FileActionProps & { children: ReactNode }) {
  const active = useContext(FileActionsActive);
  const onQuote = useContext(FileSourceQuote);
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const alive = useRef(false);
  const revealing = useRef(false);
  useEffect(() => { alive.current = active; if (!active) setAnchor(null); return () => { alive.current = false; }; }, [active]);
  const close = () => { setAnchor(null); trigger.current?.focus({ preventScroll: true }); };
  useLayoutEffect(() => {
    if (!anchor || !menu.current) return;
    const rect = menu.current.getBoundingClientRect();
    menu.current.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - rect.width - 8))}px`;
    menu.current.style.top = `${Math.max(8, Math.min(anchor.top, window.innerHeight - rect.height - 8))}px`;
    menu.current.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({ preventScroll: true });
  }, [anchor]);
  useEffect(() => {
    if (!anchor) return;
    const dismiss = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node) && !host.current?.contains(event.target as Node)) setAnchor(null); };
    const hide = () => setAnchor(null);
    document.addEventListener('pointerdown', dismiss);
    window.addEventListener('resize', hide);
    return () => { document.removeEventListener('pointerdown', dismiss); window.removeEventListener('resize', hide); };
  }, [anchor]);
  const copy = async (field: 'absolute' | 'name') => {
    close();
    try {
      const target = await getSessionFileTarget(sessionId, path, root, kind);
      if (!alive.current) return;
      await navigator.clipboard.writeText(target[field]);
      if (alive.current) onNotice(field === 'absolute' ? '已复制绝对路径。' : `已复制${kind === 'file' ? '文件' : '目录'}名。`, false);
    } catch (reason) { if (alive.current) onNotice(reason instanceof Error ? reason.message : '复制失败，请检查剪贴板权限。', true); }
  };
  const reference = () => {
    close();
    // 来源来自该菜单的固定入口；立即更新草稿，避免迟到请求覆盖后续引用。
    // 不读正文；文件失效或根变化由发送前的服务端复核反馈，草稿仍保留。
    onQuote?.({ sourceKind: 'file', quoteKind: 'source', sourceSessionId: sessionId, sourceFile: { root, path }, text: '' });
  };
  const reveal = async (event: MouseEvent<HTMLButtonElement>) => {
    if (!event.isTrusted || !navigator.userActivation?.isActive) { onNotice('请在本机点击文件菜单执行系统定位。', true); return; }
    if (revealing.current) return;
    revealing.current = true;
    close();
    try {
      const result = await revealSessionFile(sessionId, path, root, kind);
      if (alive.current) onNotice(result.message, false);
    } catch (reason) { if (alive.current) onNotice(reason instanceof Error ? reason.message : '系统定位结果无法确认，请查看本机 Finder。', true); }
    finally { revealing.current = false; }
  };
  return <div className="file-action-target" ref={host} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); setAnchor({ left: event.clientX, top: event.clientY }); }} onKeyDown={event => {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); event.stopPropagation(); const rect = trigger.current!.getBoundingClientRect(); setAnchor({ left: rect.left, top: rect.bottom }); }
  }}>
    {children}
    <button ref={trigger} type="button" className="icon-button file-action-trigger" aria-label={`「${path || root}」的文件操作`} title="文件操作" aria-haspopup="menu" aria-expanded={Boolean(anchor)} onClick={() => { const rect = trigger.current!.getBoundingClientRect(); setAnchor(anchor ? null : { left: rect.left, top: rect.bottom }); }}><MoreHorizontal aria-hidden="true" /></button>
    {active && anchor && createPortal(<div ref={menu} className="file-action-menu" role="menu" aria-label={`「${path || root}」的文件操作`} style={{ left: anchor.left, top: anchor.top }} onContextMenu={event => event.preventDefault()} onKeyDown={event => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key === 'Tab') { event.preventDefault(); close(); }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const items = [...menu.current!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')];
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length]?.focus();
      }
    }}>
      <button type="button" role="menuitem" onClick={() => void copy('absolute')}>复制绝对路径</button>
      <button type="button" role="menuitem" onClick={() => void copy('name')}>复制{kind === 'file' ? '文件' : '目录'}名</button>
      {kind === 'file' && onQuote && <button type="button" role="menuitem" onClick={reference}>引用到当前会话</button>}
      <button type="button" role="menuitem" onClick={event => void reveal(event)}>在系统文件管理器中显示</button>
    </div>, document.body)}
  </div>;
}
