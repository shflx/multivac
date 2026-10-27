import { ChevronDown, FolderOpen } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { DIRECTORY_NAME_MAX_LENGTH, truncateMiddle, workingDirectoryName } from '../workspace/working-directory.js';

const KIND_LABEL = '不受管控';
const RULE = '外部程序：Multivac 不管控它的文件访问与命令执行，也不记录为任务或成果。目录只决定启动位置；与会话同时修改同一目录时可能冲突，未观察到的脱组进程不保证回收。';

/**
 * 终端标题栏里的目录，交互与会话的工作目录一致：一行只显示目录名，
 * 点击展开说明（完整路径可选中复制，以及终端不受管控的边界），点击别处或按 Esc 收起。
 */
export function TerminalDirectory({ path }: { path: string }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const detailId = useId();

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
        aria-label={`终端目录：${KIND_LABEL} ${path}`}
        title={open ? undefined : `${KIND_LABEL} ${path}\n${RULE}`}
        onClick={() => setOpen((value) => !value)}
      >
        <FolderOpen aria-hidden="true" />
        <span className="session-directory-name">{truncateMiddle(workingDirectoryName(path), DIRECTORY_NAME_MAX_LENGTH)}</span>
        <ChevronDown aria-hidden="true" />
      </button>
      {open && (
        <div id={detailId} className="session-directory-detail" role="dialog" aria-label="终端目录" tabIndex={-1}>
          <span className="directory-rule">
            <span><strong>外部程序，Multivac 不管控</strong></span>
            <code>{path}</code>
            <small>{RULE}</small>
          </span>
        </div>
      )}
    </div>
  );
}
