import { Archive, ArrowLeft, Columns2, FolderInput, Layers3, Maximize2, MoreHorizontal } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent, type SyntheticEvent } from 'react';
import type { AssistantQuote, WorkingDirectory } from '@multivac/contracts';
import { AssistantView } from '../assistant/assistant-view.js';
import { SessionDirectory } from './session-directory.js';

interface ConversationPanelProps {
  sessionId: string;
  title: string;
  /** 会话的工作目录，取自会话记录；会话列表尚未读到时为空。 */
  workingDirectory: WorkingDirectory | null;
  /** 工作区是否可见。 */
  visible: boolean;
  /** 是否为当前会话（焦点高亮，接住焦点）。 */
  current: boolean;
  /** 是否处于聚焦模式。 */
  focused: boolean;
  /** 并排时所在栏位（如“第 2 栏”），与会话列表中的栏位对应；聚焦时为空。 */
  slotLabel?: string;
  /** 并排时非当前会话的输入区收成一行入口。 */
  collapseComposer: boolean;
  onActivate: () => void;
  onFocusMode: () => void;
  onReturnToParallel: () => void;
  onManageModels: () => void;
  /** 把选中内容连同本会话交给 Multivac 侧栏。 */
  onHandToMultivac?: (quote: AssistantQuote) => void;
  /** 基于选中内容深入一层，新建子会话。 */
  onDrillDown?: (quote: AssistantQuote) => void;
  /** 栈式路径：从顶层会话到本会话的名称；顶层会话只有自身。 */
  stackPath?: readonly string[];
  /** 深入时在父会话中选中的内容；顶层会话没有。 */
  originText?: string | null;
  /** 返回父会话并归档本会话；顶层会话没有。 */
  onBackToParent?: () => void;
  /** 标题栏菜单的“归入项目…”：打开归入项目的确认卡。 */
  onMoveToProject?: () => void;
  /** 标题栏菜单的“归档”：经确认卡归档。 */
  onArchive?: () => void;
}

/**
 * 折叠输入区里的运行状态条（含停止按钮）与就地授权卡操作的是该会话本身，不应顺带把会话切为当前：
 * 否则输入区会在按下时展开，状态条的停止按钮随之卸载、授权卡的按钮被挤开，点击落空。
 */
function activates(event: SyntheticEvent): boolean {
  return !(event.target instanceof Element &&
    event.target.closest('.assistant-composer.collapsed .run-status, .authorization-card'));
}

/**
 * 工作区中的一个会话面板：标题栏（栈式路径、标题、工作目录）加上该会话的完整对话呈现。
 * 消息、Markdown、运行轨迹、工具记录与输入区都复用 Multivac 首页的组件。
 */
export function ConversationPanel({
  sessionId, title, workingDirectory, visible, current, focused, slotLabel = '', collapseComposer,
  onActivate, onFocusMode, onReturnToParallel, onManageModels, onHandToMultivac, onDrillDown,
  stackPath = [], originText = null, onBackToParent, onMoveToProject, onArchive,
}: ConversationPanelProps) {
  return (
    <section
      className={['conversation-panel', current ? 'active' : '', focused ? 'focused' : ''].filter(Boolean).join(' ')}
      aria-label={title}
      data-session-id={sessionId}
      onPointerDownCapture={(event) => { if (activates(event)) onActivate(); }}
      onFocusCapture={(event) => { if (activates(event)) onActivate(); }}
    >
      <header className="conversation-header">
        <div className="conversation-title">
          {onBackToParent && (
            <button
              type="button"
              className="icon-button"
              aria-label="返回父会话"
              title="返回父会话，并归档本会话"
              onClick={onBackToParent}
            >
              <ArrowLeft aria-hidden="true" />
            </button>
          )}
          <div>
            {stackPath.length > 1 && (
              <div className="conversation-path" title={stackPath.join(' / ')}>
                栈式路径 · {stackPath.join(' / ')}
              </div>
            )}
            <div className="conversation-name">
              {slotLabel && <span className="slot-tag">{slotLabel}</span>}
              <h2 title={title}>{title}</h2>
            </div>
            {workingDirectory && (
              <div className="session-meta">
                <SessionDirectory directory={workingDirectory} />
              </div>
            )}
          </div>
        </div>
        <div className="conversation-tools">
          {(onMoveToProject || onArchive) && (
            <SessionTitleMenu
              title={title}
              {...(onMoveToProject ? { onMoveToProject } : {})}
              {...(onArchive ? { onArchive } : {})}
            />
          )}
          {focused ? (
            <button type="button" className="return-parallel" onClick={onReturnToParallel}>
              <Columns2 aria-hidden="true" />
              返回并排
            </button>
          ) : (
            <button
              type="button"
              className="icon-button"
              aria-label={`放大「${title}」`}
              title="放大会话"
              onClick={onFocusMode}
            >
              <Maximize2 aria-hidden="true" />
            </button>
          )}
        </div>
      </header>
      {originText && (
        <div className="stack-source">
          <Layers3 aria-hidden="true" />
          <div>
            <span>来自父会话的选中内容</span>
            <p>{originText}</p>
          </div>
        </div>
      )}
      <AssistantView
        sessionId={sessionId}
        variant="panel"
        active={visible}
        focusOnActivate={visible && current}
        collapseComposer={collapseComposer}
        composerLabel={title}
        onManageModels={onManageModels}
        {...(onHandToMultivac ? { onHandToMultivac } : {})}
        {...(onDrillDown ? { onDrillDown } : {})}
      />
    </section>
  );
}

/**
 * 会话标题栏菜单（按原型）：只放已实现的会话操作——归入项目、归档。
 * 点击菜单项先收起菜单再执行（确认卡随之打开）；Esc 收起并把焦点还给按钮，点别处收起；
 * 上下方向键在菜单项之间移动。
 */
function SessionTitleMenu({ title, onMoveToProject, onArchive }: {
  title: string;
  onMoveToProject?: () => void;
  onArchive?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      // 只收起菜单，不连带收起侧栏等外层。
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (event.key === 'Tab') {
      setOpen(false);
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const items = [...(listRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLElement);
    const step = event.key === 'ArrowDown' ? 1 : -1;
    items[(index + step + items.length) % items.length]?.focus();
  }

  const act = (handler: () => void) => () => {
    setOpen(false);
    handler();
  };

  return (
    <div className="session-menu" ref={rootRef} onKeyDown={open ? onKeyDown : undefined}>
      <button
        type="button"
        ref={triggerRef}
        className="icon-button"
        aria-label={`「${title}」的更多操作`}
        title="更多操作"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <MoreHorizontal aria-hidden="true" />
      </button>
      {open && (
        <div className="session-menu-list" role="menu" aria-label={`「${title}」的更多操作`} ref={listRef}>
          {onMoveToProject && (
            <button type="button" role="menuitem" onClick={act(onMoveToProject)}>
              <FolderInput aria-hidden="true" />
              归入项目…
            </button>
          )}
          {onArchive && (
            <button type="button" role="menuitem" onClick={act(onArchive)}>
              <Archive aria-hidden="true" />
              归档
            </button>
          )}
        </div>
      )}
    </div>
  );
}
