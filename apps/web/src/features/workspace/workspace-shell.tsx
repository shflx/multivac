import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { AssistantQuote, WorkspaceScene } from '@multivac/contracts';
import { windowId } from '../../data/window-id.js';
import { useWorkbenchEvents } from '../workbench/workbench-sync-provider.js';
import { isOwnDirectChange } from '../workbench/workbench-sync.js';
import type { WorkspaceViewReport } from '../assistant/current-view.js';
import { railIsCrowded, rememberedRailOpen, RAIL_STORAGE_KEY } from './rail-layout.js';
import { WorkspaceView } from './workspace-view.js';
import { rememberedWorkspaceId, rememberWorkspaceId } from './workspaces.js';

interface WorkspaceShellProps {
  /** 工作区是否正在显示。 */
  active: boolean;
  onManageModels: () => void;
  onOpenArchive: (workspaceId: string) => void;
  /** 从别处（设置 · 归档页、对话、Multivac 的导航）打开的会话或工作区；id 递增表示一次新的打开。 */
  openRequest?: WorkspaceOpenRequest | null;
  /** 当前焦点会话变化时报告给外壳：Multivac 侧栏据此提示“正在看”，并在发送时作为上下文。 */
  onFocusChange: (focus: { sessionId: string; title: string } | null) => void;
  /** 把会话中选中的内容交给 Multivac：外壳展开侧栏并把引用写入侧栏输入区。 */
  onHandToMultivac: (quote: AssistantQuote) => void;
  /** 当前工作区与界面呈现的现场变化时报告给外壳：向 Multivac 发送消息时作为当前视图带上。 */
  onViewChange?: (report: WorkspaceViewReport) => void;
  railToggleRef?: MutableRefObject<(() => void) | null>;
  onRailVisibleChange?: (visible: boolean) => void;
}

/**
 * 在工作区打开：切到 workspaceId 这个工作区，并把输入焦点交给 sessionId 这个会话（为 null 时只切换工作区）。
 * layout 为 focus 时聚焦查看这个会话（界面上的“在工作区打开”）；为 keep 时不改现场（Multivac 已在服务端排好，
 * 现场随推送应用）。
 */
export interface WorkspaceOpenRequest {
  id: number;
  workspaceId: string;
  sessionId: string | null;
  layout: 'focus' | 'keep' | 'navigate';
}

/**
 * 工作区外壳：当前工作区的会话区。Multivac 侧栏由应用外壳统一提供（工作区与管理共用），
 * 这里只报告当前焦点会话并转交“交给 Multivac”。
 *
 * 当前工作区记在本机，下次进入时回到这里。切换工作区时整个会话区按新工作区重建：
 * 离开的工作区先保存现场，进入的工作区读回自己的现场（本页已打开过的直接用本页记下的最新现场）。
 * 侧栏与全局 Multivac 不随工作区变化。
 */
export function WorkspaceShell({
  active, onManageModels, onOpenArchive, openRequest = null, onFocusChange, onHandToMultivac, onViewChange, railToggleRef, onRailVisibleChange,
}: WorkspaceShellProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(window.innerWidth);
  const [columns, setColumns] = useState(1);
  const [railOpen, setRailOpen] = useState(rememberedRailOpen);
  const [railOverlay, setRailOverlay] = useState(false);
  const crowded = railIsCrowded(width, columns);
  const railVisible = crowded ? railOverlay : railOpen;
  function toggleRail() {
    if (crowded) setRailOverlay((value) => !value);
    else setRailOpen((value) => !value);
  }
  useEffect(() => {
    if (railToggleRef) railToggleRef.current = toggleRail;
    onRailVisibleChange?.(railVisible);
  }, [crowded, railVisible, railToggleRef, onRailVisibleChange]);
  useEffect(() => {
    try { localStorage.setItem(RAIL_STORAGE_KEY, railOpen ? 'open' : 'closed'); } catch { /* 本机存储禁用时仍可使用。 */ }
  }, [railOpen]);
  useEffect(() => { if (!crowded || !active) setRailOverlay(false); }, [crowded, active]);
  useEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    const observer = new ResizeObserver(() => { if (node.clientWidth) setWidth(node.clientWidth); });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!active) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || [...document.querySelectorAll('[aria-modal="true"], .rail-menu')].some((node) => node.checkVisibility())) return;
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'b') {
        event.preventDefault(); toggleRail();
      } else if (crowded && railOverlay && event.key === 'Escape'
        && !(event.target instanceof Element && event.target.closest('.workspace-rail input, .workspace-rail textarea'))
        && ![...document.querySelectorAll('[role="menu"], [role="dialog"]')].some((node) => node.checkVisibility())) {
        event.preventDefault(); event.stopPropagation(); setRailOverlay(false);
      }
    };
    const dismiss = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || target.closest('.workspace-rail-wrap, .rail-menu, [role="dialog"], .rail-handle')) return;
      setRailOverlay(false);
    };
    window.addEventListener('keydown', keydown, true);
    document.addEventListener('pointerdown', dismiss);
    return () => { window.removeEventListener('keydown', keydown, true); document.removeEventListener('pointerdown', dismiss); };
  }, [active, crowded, railOverlay]);
  const [workspaceId, setWorkspaceId] = useState(rememberedWorkspaceId);
  // 本页各工作区的最新现场（带服务端版本）：切回来时直接恢复，不必等离开时的保存与重新读取往返。
  const [sceneCache] = useState(() => new Map<string, WorkspaceScene>());
  // 尚未处理的打开请求：先切到会话所在的工作区，由该工作区读完现场后聚焦。
  const [pendingOpen, setPendingOpen] = useState<WorkspaceOpenRequest | null>(null);
  const handledOpenRef = useRef(0);
  // 工作区内发起的打开（如归入项目后到项目中打开）用负数 id，与外部打开请求的递增 id 互不冲突。
  const localOpenRef = useRef(0);

  // 不在显示的工作区也可能被别处改动：记下的现场随之更新（本窗口离开时自己保存的，只更新版本），
  // 切回来时看到的是最新现场；事件流重连后不再信任记下的现场，切回来时重新读取。当前工作区由视图自己处理。
  useWorkbenchEvents((event) => {
    if (event.type === 'workbench.connected') {
      for (const id of [...sceneCache.keys()]) if (id !== workspaceId) sceneCache.delete(id);
      return;
    }
    if (event.type !== 'scene.changed' || event.scene.workspaceId === workspaceId) return;
    const cached = sceneCache.get(event.scene.workspaceId);
    if (!cached || cached.revision >= event.scene.revision) return;
    sceneCache.set(event.scene.workspaceId, isOwnDirectChange(event.origin, windowId())
      ? { ...cached, revision: event.scene.revision }
      : event.scene);
  });

  /** 切换当前工作区并记在本机；会话区随之按新工作区重建。 */
  const switchWorkspace = useCallback((id: string) => {
    rememberWorkspaceId(id);
    setWorkspaceId(id);
  }, []);

  useEffect(() => {
    if (!openRequest || openRequest.id === handledOpenRef.current) return;
    handledOpenRef.current = openRequest.id;
    switchWorkspace(openRequest.workspaceId);
    setPendingOpen(openRequest);
  }, [openRequest]);

  /** 切到另一个工作区并聚焦其中的会话：与外部打开请求走同一条路径。 */
  const openSession = useCallback((targetWorkspaceId: string, sessionId: string) => {
    localOpenRef.current -= 1;
    switchWorkspace(targetWorkspaceId);
    setPendingOpen({ id: localOpenRef.current, sessionId, workspaceId: targetWorkspaceId, layout: 'navigate' });
  }, [switchWorkspace]);

  const reportView = useCallback((report: WorkspaceViewReport) => {
    if (report.scene) setColumns(report.scene.viewMode === 'parallel' ? report.scene.parallelCount : 1);
    onViewChange?.(report);
  }, [onViewChange]);

  return (
    <div className="workspace-shell" ref={rootRef}>
      <WorkspaceView
        key={workspaceId}
        workspaceId={workspaceId}
        onSwitchWorkspace={switchWorkspace}
        sceneCache={sceneCache}
        active={active}
        railVisible={railVisible} railOverlay={crowded && railOverlay} onToggleRail={toggleRail}
        onCloseOverlay={() => setRailOverlay(false)}
        onChooseLayout={(count) => { if (railIsCrowded(width, count) && railVisible) setRailOverlay(true); }}
        onManageModels={onManageModels}
        onOpenArchive={onOpenArchive}
        openRequest={pendingOpen?.workspaceId === workspaceId ? pendingOpen : null}
        onOpenHandled={() => setPendingOpen(null)}
        onFocusChange={onFocusChange}
        onHandToMultivac={onHandToMultivac}
        onOpenSession={openSession}
        onViewChange={reportView}
      />
    </div>
  );
}
