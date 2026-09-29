import { ChevronDown, FolderOpen } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { WorkingDirectory } from '@multivac/contracts';
import { SessionGrantsDisclosure } from '../authorizations/grant-list.js';
import {
  DIRECTORY_NAME_MAX_LENGTH,
  WORKING_DIRECTORY_KINDS,
  truncateMiddle,
  workingDirectoryName,
  workingDirectoryRule,
} from './working-directory.js';

/**
 * 会话标题栏里的工作目录（按原型）：一行显示“类型 · 目录名”，目录名过长时中间截断。
 *
 * 悬停时浏览器提示给出类型、完整路径与规则；点击（或键盘 Enter / 空格）展开说明，
 * 写明类型、完整路径（可选中复制）与本地写规则，下面是“本会话已允许 N 项”，点开可以查看和撤销。
 * 说明不抢焦点，点击别处或按 Esc 收起（撤销的确认卡是模态层，在卡上的操作不会收起说明）。
 */
export function SessionDirectory({ sessionId, directory }: { sessionId: string; directory: WorkingDirectory }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const detailId = useId();
  const kind = WORKING_DIRECTORY_KINDS[directory.kind];
  const rule = workingDirectoryRule(directory.kind);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);

  return (
    <div
      className="session-directory"
      ref={rootRef}
      data-directory-kind={directory.kind}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !open) return;
        // 只收起说明，不连带收起侧栏等外层。
        event.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }}
    >
      <button
        type="button"
        ref={triggerRef}
        className="session-directory-trigger"
        aria-expanded={open}
        aria-controls={open ? detailId : undefined}
        aria-label={`工作目录：${kind.label} ${directory.path}`}
        title={open ? undefined : `${kind.label} ${directory.path}\n${rule}`}
        onClick={() => setOpen((value) => !value)}
      >
        <FolderOpen aria-hidden="true" />
        <span className="session-directory-kind">{kind.label}</span>
        <span className="session-directory-name">
          {' · '}
          {truncateMiddle(workingDirectoryName(directory.path), DIRECTORY_NAME_MAX_LENGTH)}
        </span>
        <ChevronDown aria-hidden="true" />
      </button>
      {open && (
        <div
          id={detailId}
          ref={detailRef}
          className="session-directory-detail"
          role="dialog"
          aria-label="本会话的工作目录"
          // 可以接住点击（选中路径时），Esc 仍能收起。
          tabIndex={-1}
        >
          <span className="directory-rule">
            <span><strong>{kind.label}</strong></span>
            <code>{directory.path}</code>
            <small>{rule}</small>
          </span>
          <SessionGrantsDisclosure sessionId={sessionId} fallbackFocus={() => detailRef.current} />
        </div>
      )}
    </div>
  );
}
