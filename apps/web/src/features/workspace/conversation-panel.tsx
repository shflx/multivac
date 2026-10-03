import { Archive, ArrowLeft, Columns2, FileText, FolderInput, Layers3, Maximize2, MoreHorizontal, ShieldCheck, Orbit, Quote, X } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type SyntheticEvent } from 'react';
import type { AssistantQuote, CurrentFileReading, SessionFileReference, WorkingDirectory } from '@multivac/contracts';
import { AssistantView } from '../assistant/assistant-view.js';
import { useMarkSessionViewed } from '../assistant/session-read.js';
import { SessionAuthorizationsDialog } from '../authorizations/session-authorizations-dialog.js';
import { SessionDirectory } from './session-directory.js';
import { FileBrowser } from './file-browser.js';
import { useReadingScene, type UpdateReading } from './use-reading-scene.js';
import { openReading } from './reading-scene.js';
import { readSessionFile } from '../../data/session-files-api.js';
import { assistantQuoteWithinLimit } from '@multivac/contracts';
import type { FileSelection } from './file-selection.js';

interface ConversationPanelProps {
  sessionId: string;
  workspaceId: string;
  onReadingFocus: (reading: CurrentFileReading | null) => void;
  title: string;
  /** 会话的工作目录，取自会话记录；会话列表尚未读到时为空。 */
  workingDirectory: WorkingDirectory | null;
  /** 工作区是否可见。 */
  visible: boolean;
  /** 是否为当前会话（焦点高亮，接住焦点）。 */
  current: boolean;
  /**
   * 成为当前会话时是否接住焦点，缺省为是。当前会话由别处（其他窗口、Multivac）改变时为否：
   * 高亮随之变化，但不把焦点从用户正在操作的地方抢走。
   */
  claimFocus?: boolean;
  /**
   * 请求把焦点交给输入区（“在工作区打开”这个会话时）；从 1 起递增，每个新值是一次新的请求。
   * 会话本来就是当前会话时，成为当前会话不会再次接住焦点，打开时靠它交出焦点。
   */
  focusRequest?: number;
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
  sessionId, workspaceId, onReadingFocus, title, workingDirectory, visible, current, claimFocus = true, focusRequest, focused, slotLabel = '', collapseComposer,
  onActivate, onFocusMode, onReturnToParallel, onManageModels, onHandToMultivac, onDrillDown,
  stackPath = [], originText = null, onBackToParent, onMoveToProject, onArchive,
}: ConversationPanelProps) {
  const [reading, updateReading] = useReadingScene(workspaceId, sessionId, workingDirectory?.path ?? '');
  const filesOpen = !reading.hidden;
  const readingView = reading.view;
  const setReadingView = (view: typeof readingView) => setReading((scene) => ({ ...scene, view }));
  const [canSplit, setCanSplit] = useState(false);
  const [fileOpenError, setFileOpenError] = useState('');
  const [fileSelection, setFileSelection] = useState<FileSelection | null>(null);
  const fileSelectionRef = useRef(fileSelection);
  fileSelectionRef.current = fileSelection;
  const [incomingQuote, setIncomingQuote] = useState<{ id: number; quote: AssistantQuote } | null>(null);
  const incomingQuoteId = useRef(0);
  const fileOpenRequest = useRef(0);
  const fileOpenAbort = useRef<AbortController | null>(null);
  // 浏览导航是更新的用户意图；旧文件校验结束后不得再把现场切回去。
  const setReading: UpdateReading = (change) => updateReading((scene) => {
    const next = change(scene);
    if (next.position.path !== scene.position.path || next.history !== scene.history || next.future !== scene.future || next.hidden !== scene.hidden || next.view !== scene.view || next.chooser !== scene.chooser) fileOpenAbort.current?.abort();
    return next;
  });
  useEffect(() => () => { fileOpenAbort.current?.abort(); }, [sessionId, workingDirectory?.path, focused, visible]);
  const panelRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    let width = panel.clientWidth;
    const observer = new ResizeObserver(() => {
      if (width !== panel.clientWidth) { fileSelectionRef.current?.clear(); setFileSelection(null); width = panel.clientWidth; }
      setCanSplit(panel.clientWidth >= 780);
    });
    observer.observe(panel);
    return () => observer.disconnect();
  }, []);
  const browserVisible = filesOpen && focused;
  const discussionHidden = browserVisible && readingView !== 'discussion' && (readingView === 'original' || !canSplit);
  useMarkSessionViewed(sessionId, visible && current && !discussionHidden, panelRef);
  const reportReading = (focus: 'file' | 'discussion') => onReadingFocus(browserVisible && reading.position.path ? { sessionId, root: reading.root, path: reading.position.path, focus, ...(reading.position.line ? { line: reading.position.line } : {}), ...(reading.position.section ? { section: reading.position.section } : {}) } : null);
  useEffect(() => { if (current && visible) reportReading(browserVisible && readingView !== 'discussion' ? 'file' : 'discussion'); }, [current, visible, browserVisible, readingView, reading.position.path]);
  useEffect(() => {
    fileSelection?.clear(); setFileSelection(null);
  }, [focused, reading.hidden, reading.view, reading.position.path, reading.chooser, reading.directoryOpen, reading.position.findOpen, canSplit, visible]);
  const useFileSelection = (action: 'quote' | 'drill' | 'hand') => {
    if (!fileSelection) return;
    if (!assistantQuoteWithinLimit(fileSelection.quote)) { setFileOpenError('引用超过 4 KiB UTF-8 上限，请缩短选区后重试。'); return; }
    setFileOpenError('');
    const quote = { ...fileSelection.quote, sourceTitle: title };
    fileSelection.clear(); setFileSelection(null);
    if (action === 'quote') {
      setIncomingQuote({ id: ++incomingQuoteId.current, quote });
      setReadingView(canSplit ? 'auto' : 'discussion');
    } else if (action === 'drill') onDrillDown?.(quote);
    else onHandToMultivac?.(quote);
  };
  const openOriginal = async (reference: SessionFileReference) => {
    fileOpenAbort.current?.abort();
    const abort = new AbortController();
    fileOpenAbort.current = abort;
    const request = ++fileOpenRequest.current;
    setFileOpenError('');
    try {
      const content = await readSessionFile(sessionId, reference.path, reference.root, abort.signal);
      if (reference.line && reference.line > content.text.split('\n').length) throw new Error('引用的行号已失效，请从目录重新打开文件。');
      if (abort.signal.aborted || request !== fileOpenRequest.current) return;
      setReading((scene) => ({ ...openReading(scene, reference.path, { ...(reference.line ? { line: reference.line } : {}), ...(reference.section ? { section: reference.section } : {}) }), view: 'auto' }));
      onFocusMode();
    } catch (reason) { if (!abort.signal.aborted && request === fileOpenRequest.current) setFileOpenError(reason instanceof Error ? reason.message : '无法打开原文。'); }
  };
  return (
    <section
      ref={panelRef}
      className={['conversation-panel', current ? 'active' : '', focused ? 'focused' : ''].filter(Boolean).join(' ')}
      aria-label={title}
      data-session-id={sessionId}
      onPointerDownCapture={(event) => { if (activates(event)) onActivate(); reportReading(event.target instanceof Element && event.target.closest('.conversation-original') ? 'file' : 'discussion'); }}
      onFocusCapture={(event) => { if (activates(event)) onActivate(); reportReading(event.target instanceof Element && event.target.closest('.conversation-original') ? 'file' : 'discussion'); }}
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
                <SessionDirectory sessionId={sessionId} directory={workingDirectory} />
              </div>
            )}
          </div>
        </div>
        <div className="conversation-tools">
          {workingDirectory && <button type="button" className="icon-button" aria-label={browserVisible && readingView === 'discussion' ? '返回原文' : '查看文件'} title={browserVisible && readingView === 'discussion' ? '返回原文' : '查看文件'} onClick={() => { setReading((scene) => ({ ...scene, hidden: false, view: 'auto' })); onFocusMode(); }}><FileText /></button>}
          {(onMoveToProject || onArchive) && (
            <SessionTitleMenu
              sessionId={sessionId}
              visible={visible}
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
      {fileOpenError && <p className="browser-empty" role="alert">{fileOpenError}</p>}
      {originText && (
        <div className="stack-source">
          <Layers3 aria-hidden="true" />
          <div>
            <span>来自父会话的选中内容</span>
            <p>{originText}</p>
          </div>
        </div>
      )}
      <div className={`discussion-surface ${browserVisible && readingView !== 'discussion' && !discussionHidden ? 'has-reading' : ''}`}>
      <div className="conversation-discussion" hidden={discussionHidden}>
      <AssistantView
        sessionId={sessionId}
        variant="panel"
        active={visible && !discussionHidden}
        focusOnActivate={visible && current && claimFocus && !browserVisible}
        {...(focusRequest ? { focusRequest } : {})}
        collapseComposer={collapseComposer}
        composerLabel={title}
        onManageModels={onManageModels}
        onOpenFileReference={(reference) => void openOriginal(reference)}
        incomingQuote={incomingQuote}
        onIncomingQuoteHandled={() => setIncomingQuote(null)}
        {...(onHandToMultivac ? { onHandToMultivac } : {})}
        {...(onDrillDown ? { onDrillDown } : {})}
      />
      </div>
      {filesOpen && workingDirectory && <div className="conversation-original" hidden={!browserVisible || readingView === 'discussion'}><FileBrowser key={workingDirectory.path} sessionId={sessionId} root={workingDirectory.path} reading={reading} setReading={setReading} visible={visible && browserVisible && readingView !== 'discussion'}
        onSelection={(selection) => { setFileSelection(selection); if (selection) onReadingFocus({ sessionId, root: reading.root, path: selection.quote.sourceFile.path, focus: 'file', ...(selection.quote.sourceFile.line ? { line: selection.quote.sourceFile.line } : {}), ...(selection.quote.sourceFile.endLine ? { endLine: selection.quote.sourceFile.endLine } : {}), ...(selection.quote.sourceFile.section ? { section: selection.quote.sourceFile.section } : {}) }); }} onReadingFocus={() => { onActivate(); reportReading('file'); }}
        expanded={discussionHidden} onExpand={() => setReadingView(readingView === 'original' ? 'auto' : 'original')}
        onReturn={() => setReadingView(canSplit ? 'auto' : 'discussion')} onClose={() => setReading((scene) => ({ ...scene, hidden: true, view: 'auto' }))} /></div>}
      </div>
      {fileSelection && browserVisible && readingView !== 'discussion' && createPortal(<div className="selection-toolbar" role="toolbar" aria-label="原文选中内容操作" style={{ left: fileSelection.left, top: fileSelection.top }} onMouseDown={(event) => event.preventDefault()}>
        <button onClick={() => useFileSelection('quote')}><Quote />引用</button>
        {onDrillDown && <button onClick={() => useFileSelection('drill')}><Layers3 />深入一层</button>}
        {onHandToMultivac && <button onClick={() => useFileSelection('hand')}><Orbit />交给 Multivac</button>}
        <button title="关闭选中工具条" aria-label="关闭原文选中工具条" onClick={() => { fileSelection.clear(); setFileSelection(null); }}><X /></button>
      </div>, document.body)}
    </section>
  );
}

/**
 * 会话标题栏菜单（按原型）：只放已实现的会话操作——归入项目、授权、归档。
 * 点击菜单项先收起菜单再执行（确认卡随之打开）；Esc 收起并把焦点还给按钮，点别处收起；
 * 上下方向键在菜单项之间移动。
 */
function SessionTitleMenu({ sessionId, visible, title, onMoveToProject, onArchive }: {
  sessionId: string;
  visible: boolean;
  title: string;
  onMoveToProject?: () => void;
  onArchive?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [authorizationsOpen, setAuthorizationsOpen] = useState(false);
  useEffect(() => { if (!visible) { setOpen(false); setAuthorizationsOpen(false); } }, [visible]);
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
          <button type="button" role="menuitem" onClick={act(() => { triggerRef.current?.focus(); setAuthorizationsOpen(true); })}><ShieldCheck />授权</button>
          {onArchive && (
            <button type="button" role="menuitem" onClick={act(onArchive)}>
              <Archive aria-hidden="true" />
              归档
            </button>
          )}
        </div>
      )}
      {authorizationsOpen && <SessionAuthorizationsDialog sessionId={sessionId} title={title} onClose={() => setAuthorizationsOpen(false)} />}
    </div>
  );
}
