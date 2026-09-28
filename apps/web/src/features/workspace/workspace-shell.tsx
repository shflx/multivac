import { useEffect, useRef, useState, type PointerEvent } from 'react';
import type { AssistantQuote } from '@multivac/contracts';
import { useAssistantSession } from '../assistant/assistant-session.js';
import { MultivacSidebar } from '../assistant/multivac-sidebar.js';
import { multivacProcessing, sidebarCollapseDecision } from '../assistant/sidebar-collapse.js';
import { WorkspaceView } from './workspace-view.js';

/** 旧版把侧栏开合记在本机；现在每次都从收起开始，清掉遗留的记录。 */
const LEGACY_SIDEBAR_STORAGE_KEY = 'multivac.workspace.multivac-sidebar';

/** 叫出或收起侧栏的快捷键：⌘J / Ctrl+J（与 ⌘\ / Ctrl+\ 切换工作区条互不冲突）。 */
const SIDEBAR_SHORTCUT = {
  hint: /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘J' : 'Ctrl+J',
  keys: 'Meta+J Control+J',
};

interface WorkspaceShellProps {
  /** 工作区是否正在显示。 */
  active: boolean;
  onManageModels: () => void;
  /** 从别处（管理 · 会话页）打开的会话；id 递增表示一次新的打开。 */
  openRequest?: { id: number; sessionId: string } | null;
}

/**
 * 工作区外壳：会话区在左，同一个 Multivac 常驻右侧。
 *
 * 侧栏“默认收起、用完即收”：
 * - 每次打开页面都从收起的窄轨开始，不记住上次的开合。
 * - 明确叫出时临时展开：窄轨按钮、⌘J / Ctrl+J、选中内容“交给 Multivac”。
 * - 点回工作区（侧栏之外的任何位置）时：
 *   - Multivac 已处理完，且侧栏里没有未发出的草稿或引用 → 立即收起；
 *   - 还在处理（发送中、运行中、等待授权）→ 保持展开，处理完再收起；
 *     这期间回到侧栏里操作，就取消这次“处理完再收起”；
 *   - 侧栏里还有未发出的草稿或引用 → 保持展开，等用户处理完下一次点回再说。
 * - 收起按钮与快捷键随时可以手动收起。
 * 收起只是不显示侧栏，会话、草稿、引用与阅读位置都不受影响，进行中的处理照常继续。
 */
export function WorkspaceShell({ active, onManageModels, openRequest = null }: WorkspaceShellProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  // 工作区当前焦点会话：侧栏据此提示并在发送时作为上下文。
  const [workspaceFocus, setWorkspaceFocus] = useState<{ sessionId: string; title: string } | null>(null);
  // 从工作会话交给 Multivac 的引用；id 递增表示一次新的交接。
  const [handoff, setHandoff] = useState<{ id: number; quote: AssistantQuote } | null>(null);
  // 点回工作区时 Multivac 还在处理：记下来，处理完再收起。
  const collapseAfterProcessingRef = useRef(false);
  const global = useAssistantSession()?.session;
  const processing = global ? multivacProcessing(global) : false;

  useEffect(() => {
    try {
      localStorage.removeItem(LEGACY_SIDEBAR_STORAGE_KEY);
    } catch {
      // 本机存储不可用时没有需要清理的记录。
    }
  }, []);

  function openSidebar(): void {
    collapseAfterProcessingRef.current = false;
    setSidebarOpen(true);
  }

  function collapseSidebar(): void {
    collapseAfterProcessingRef.current = false;
    setSidebarOpen(false);
  }

  /** 明确叫出侧栏（窄轨按钮、快捷键）：展开并把焦点交给侧栏输入区。 */
  function summonSidebar(): void {
    openSidebar();
    setFocusRequest((current) => current + 1);
  }

  /** 交给 Multivac：展开侧栏，把引用写入侧栏输入区并聚焦；当前会话保持原样。 */
  function handToMultivac(quote: AssistantQuote): void {
    openSidebar();
    setHandoff((current) => ({ id: (current?.id ?? 0) + 1, quote }));
  }

  // ⌘J / Ctrl+J 叫出或收起侧栏，只在工作区可见时生效；确认卡等模态层会拦下按键。
  const toggleRef = useRef<() => void>(() => undefined);
  toggleRef.current = () => sidebarOpen ? collapseSidebar() : summonSidebar();
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== 'j') return;
      event.preventDefault();
      toggleRef.current();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [active]);

  // 点回工作区时还在处理的，处理一结束就按同样的规则再判断一次。
  useEffect(() => {
    if (processing || !collapseAfterProcessingRef.current) return;
    collapseAfterProcessingRef.current = false;
    if (global && sidebarCollapseDecision(global) === 'collapse') setSidebarOpen(false);
  }, [processing]);

  /** 点回工作区：按规则立即收起，或记下处理完再收起。 */
  const returnToWorkspaceRef = useRef<() => void>(() => undefined);
  returnToWorkspaceRef.current = () => {
    if (!sidebarOpen || !global) return;
    const decision = sidebarCollapseDecision(global);
    if (decision === 'collapse') collapseSidebar();
    else if (decision === 'after-processing') collapseAfterProcessingRef.current = true;
  };

  /**
   * 用完即收：在侧栏之外按下即视为点回工作区。只认本外壳 DOM 内的按下，
   * 确认卡等经 portal 渲染到别处的层不算；选中内容的操作条是在叫 Multivac，也不算。
   *
   * 等这次点击处理完再收起：收起会让工作区变宽，按下时就收起会让按钮在松开前移位、点击落空。
   * 松开时选中了文字的（正在阅读，可能要交给 Multivac）不算点回。
   */
  function onPointerDownCapture(event: PointerEvent<HTMLDivElement>): void {
    if (!sidebarOpen) return;
    const target = event.target as Element;
    if (!event.currentTarget.contains(target) || target.closest('.selection-toolbar')) return;
    if (target.closest('.multivac-sidebar')) {
      collapseAfterProcessingRef.current = false;
      return;
    }
    const release = new AbortController();
    window.addEventListener('pointerup', () => {
      release.abort();
      if (window.getSelection()?.isCollapsed === false) return;
      // click 紧随 pointerup 在同一轮事件中派发，下一轮再收起。
      window.setTimeout(() => returnToWorkspaceRef.current(), 0);
    }, { signal: release.signal });
    window.addEventListener('pointercancel', () => release.abort(), { signal: release.signal });
  }

  return (
    <div
      className="workspace-shell"
      onPointerDownCapture={onPointerDownCapture}
      onFocusCapture={(event) => {
        // 键盘回到侧栏同样表示还要继续用它。
        if ((event.target as Element).closest('.multivac-sidebar')) collapseAfterProcessingRef.current = false;
      }}
    >
      <WorkspaceView
        active={active}
        onManageModels={onManageModels}
        openRequest={openRequest}
        onFocusChange={setWorkspaceFocus}
        onHandToMultivac={handToMultivac}
      />
      <MultivacSidebar
        active={active}
        collapsed={!sidebarOpen}
        onCollapse={collapseSidebar}
        onExpand={summonSidebar}
        onManageModels={onManageModels}
        note="处理完、点回工作区即自动收起"
        shortcut={SIDEBAR_SHORTCUT}
        context={workspaceFocus}
        incomingQuote={handoff}
        onIncomingQuoteHandled={() => setHandoff(null)}
        focusRequest={focusRequest}
      />
    </div>
  );
}
