import { useSessionContextController, type SessionContext } from './session-context.js';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {
  GLOBAL_ASSISTANT_SESSION_ID,
  type AssistantCommandAnchor,
  type AssistantExecutor,
  type AssistantPageState,
  type AssistantQuote,
  type AssistantStreamingBehavior,
  type ToolAuthorizationDecision,
  type ToolAuthorizationRequest,
} from '@multivac/contracts';
import { useGlobalEvents } from '../events/global-events-provider.js';
import type { RunFeedback } from './command-feedback.js';
import { useImageDraft } from './image-draft.js';
import type { SaveFeedback } from './page-state-saver.js';
import {
  AssistantSessionController,
  type AuthorizationDecisionState,
  type SubmitHooks,
} from './session-controller.js';
import { useSessionModelController, type SessionModel, type SessionModelState } from './session-model.js';
import { deriveSessionView } from './session-view.js';
import type { VisibleAssistantMessage } from './streaming-messages.js';
import type { FailedSubmission, ReadingDraftQuote } from './submission-recovery.js';
import type { AssistantGroupedTimelineItem, RunTrace, ToolExecution } from './tool-executions.js';

export type { RunFeedback, RunPhase } from './command-feedback.js';
export type { SaveFeedback, SavePhase } from './page-state-saver.js';
export type { AuthorizationDecisionState, SubmitHooks } from './session-controller.js';

/**
 * 会话控制器对外暴露的状态与操作。
 *
 * 事件订阅、命令对账、页面现场保存与运行状态在应用中只有一份；
 * 首页与侧栏等呈现实例都通过它读写同一会话。
 */
export interface AssistantSession {
  imageDraft: ReturnType<typeof useImageDraft>;
  sessionId: string;
  status: 'loading' | 'ready' | 'error';
  /** 每次（重新）加载递增；呈现实例据此重新执行阅读位置恢复。 */
  loadGeneration: number;
  initialError: string;
  reload(): void;

  messages: readonly VisibleAssistantMessage[];
  displayMessages: readonly VisibleAssistantMessage[];
  echoId: string | null;
  timeline: AssistantGroupedTimelineItem[];
  visibleReplyCommands: ReadonlySet<string>;
  toolExecutions: readonly ToolExecution[];
  runTraces: readonly RunTrace[];
  /** 会话的目录外访问授权请求（含历史），按创建时间升序。 */
  authorizations: readonly ToolAuthorizationRequest[];
  authorizationDecisions: Readonly<Record<string, AuthorizationDecisionState>>;
  /** 对待授权请求作出决定（仅这一次 / 拒绝）；结果以服务端返回的请求为准。 */
  decideAuthorization(requestId: string, decision: ToolAuthorizationDecision): Promise<void>;
  hasMore: boolean;
  loadingEarlier: boolean;
  historyError: string;
  /** 最近一次成功合并的更早历史批次，呈现实例用它做滚动补偿。 */
  renderedHistoryGeneration: number | null;
  /** 开始加载更早消息；返回本次批次号，未开始时返回 null。 */
  loadEarlier(): number | null;

  pageState: AssistantPageState;
  saveFeedback: SaveFeedback;
  updateDraft(draft: string): void;
  setAgentId(agentId: string | null): void;
  executors: Readonly<Record<string, AssistantExecutor>>;
  commandAnchors: readonly AssistantCommandAnchor[];
  currentExecutor: AssistantExecutor | null;
  setQuote(quote: AssistantQuote): void;
  removeQuote(): void;
  /** 记录阅读锚点；只应由首页呈现实例调用。 */
  setReadingAnchor(entryId: string | null, offsetPx: number): void;
  retrySave(): void;

  model: SessionModelState;
  runFeedback: RunFeedback;
  runFeedbackCommandId: string | null;
  /** 本地这轮反馈开始时已知的事件水位，用于与其他窗口的新一轮比较。 */
  runFeedbackAfterCursor: number;
  runActive: boolean;
  runBusy: boolean;
  submitting: boolean;
  cancelling: boolean;
  sendError: string;
  streamingBehavior: AssistantStreamingBehavior | '';
  canSubmit: boolean;
  canRetryUnknown: boolean;
  pendingSubmission: { commandId: string; agentId: string | undefined; unknown: boolean; confirmed: boolean; checking: boolean } | null;
  failedSubmissions: readonly FailedSubmission[];
  readingQuote: ReadingDraftQuote | null;
  setReadingQuote(quote: ReadingDraftQuote | null): void;
  restoreFailedSubmission(commandId: string): boolean;
  retryFailedSubmission(commandId: string): Promise<void>;
  retryUnknownSubmission(): Promise<void>;
  checkPendingSubmission(): Promise<void>;
  dismissFailedSubmission(commandId: string): void;
  selectStreamingBehavior(behavior: AssistantStreamingBehavior): void;
  submitDraft(hooks?: SubmitHooks): Promise<void>;
  cancelCurrentRun(): Promise<void>;
}

/**
 * 单个会话控制器的 React 绑定：创建并启动控制器，订阅它的状态快照，接入图片草稿、选模状态与页面生命周期。
 * sessionId 在宿主生命周期内不变（宿主以会话 id 作为 key）。
 */
function useAssistantSessionController(sessionId: string, modelState: SessionModelState): AssistantSession {
  const globalEvents = useGlobalEvents();
  const [controller] = useState(() => new AssistantSessionController({ sessionId, events: globalEvents.router }));
  const imageDraft = useImageDraft(sessionId, () => controller.imageDraftChanged());
  // 图片草稿与选模状态由各自的 React 控制器维护；控制器在操作时读取最近一次渲染的值。
  controller.imageDraft = imageDraft;
  controller.model = modelState;
  const state = useSyncExternalStore(controller.subscribe, controller.getState);

  useEffect(() => {
    controller.start();
    return () => controller.dispose();
  }, [controller]);

  useEffect(() => {
    const flushOnExit = () => controller.flushOnExit();
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') controller.flushOnExit();
    };
    const onOnline = () => controller.online();
    window.addEventListener('pagehide', flushOnExit);
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('pagehide', flushOnExit);
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [controller]);

  const view = deriveSessionView(state, modelState, imageDraft);
  return {
    ...view,
    sessionId,
    status: state.status,
    loadGeneration: state.loadGeneration,
    initialError: state.initialError,
    reload: () => controller.reload(),
    messages: state.history.messages,
    toolExecutions: state.history.toolExecutions,
    runTraces: state.history.runTraces,
    authorizations: state.authorizations,
    authorizationDecisions: state.authorizationDecisions,
    decideAuthorization: (requestId, decision) => controller.decideAuthorization(requestId, decision),
    hasMore: state.history.hasMore,
    loadingEarlier: state.loadingEarlier,
    historyError: state.historyError,
    renderedHistoryGeneration: state.renderedHistoryGeneration,
    loadEarlier: () => controller.loadEarlier(),
    pageState: state.page,
    imageDraft,
    saveFeedback: state.saveFeedback,
    updateDraft: (draft) => controller.updateDraft(draft),
    setAgentId: (agentId) => controller.setAgentId(agentId),
    executors: state.history.executors,
    commandAnchors: state.history.commandAnchors,
    setQuote: (quote) => controller.setQuote(quote),
    removeQuote: () => controller.removeQuote(),
    setReadingAnchor: (entryId, offsetPx) => controller.setReadingAnchor(entryId, offsetPx),
    retrySave: () => controller.retrySave(),
    model: modelState,
    runFeedbackCommandId: state.runFeedbackOwner?.commandId ?? null,
    runFeedbackAfterCursor: state.runFeedbackAfterCursor,
    submitting: state.submitting,
    cancelling: state.cancelling,
    sendError: state.sendError,
    failedSubmissions: state.failedSubmissions,
    readingQuote: state.readingQuote,
    setReadingQuote: (quote) => controller.setReadingQuote(quote),
    restoreFailedSubmission: (commandId) => controller.restoreFailedSubmission(commandId),
    retryFailedSubmission: (commandId) => controller.retryFailedSubmission(commandId),
    retryUnknownSubmission: () => controller.retryUnknownSubmission(),
    checkPendingSubmission: () => controller.checkPendingSubmission(),
    dismissFailedSubmission: (commandId) => controller.dismissFailedSubmission(commandId),
    selectStreamingBehavior: (behavior) => controller.selectStreamingBehavior(behavior),
    submitDraft: (hooks) => controller.submitDraft(hooks),
    cancelCurrentRun: () => controller.cancelCurrentRun(),
  };
}

/** 一个会话在应用中的唯一状态：会话控制器与该会话的选模控制器。 */
export interface AssistantSessionEntry {
  session: AssistantSession;
  model: SessionModel;
  context: SessionContext;
}

/**
 * 会话控制器集合的外部存储。
 *
 * 控制器由各自的会话宿主（React 组件）运行，宿主在每次渲染后把最新状态发布到这里；
 * 呈现实例按会话 id 订阅，只有自己关心的会话变化时才重新渲染。
 */
class SessionControllerStore {
  private readonly entries = new Map<string, AssistantSessionEntry>();
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  get(sessionId: string): AssistantSessionEntry | undefined {
    return this.entries.get(sessionId);
  }

  publish(sessionId: string, entry: AssistantSessionEntry): void {
    const current = this.entries.get(sessionId);
    if (current?.session === entry.session && current.model === entry.model && current.context === entry.context) return;
    this.entries.set(sessionId, entry);
    this.emit();
  }

  remove(sessionId: string): void {
    if (!this.entries.delete(sessionId)) return;
    this.emit();
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

interface AssistantSessionsContextValue {
  store: SessionControllerStore;
  retain(sessionId: string, active: boolean): void;
  release(sessionId: string, active: boolean): void;
}

const AssistantSessionsContext = createContext<AssistantSessionsContextValue | null>(null);

/** 运行单个会话的控制器并发布到集合；不渲染任何界面。 */
function SessionHost({ sessionId, store, active }: { sessionId: string; store: SessionControllerStore; active: boolean }) {
  const model = useSessionModelController(sessionId, active);
  const context = useSessionContextController(sessionId, active);
  const session = useAssistantSessionController(sessionId, {
    available: model.available,
    busy: model.busy || context.pending,
    loaded: model.loaded,
  });

  useEffect(() => { if (active && session.status === 'ready') context.invalidate(); }, [active, session.status, session.loadGeneration, context.invalidate]);
  useLayoutEffect(() => {
    store.publish(sessionId, { session, context, model: context.pending && model.data
      ? { ...model, data: { ...model.data, running: true, disabledReason: '上下文压缩正在执行或等待核对，暂不能切换模型。' } } : model });
  });
  useLayoutEffect(() => () => store.remove(sessionId), [sessionId, store]);
  return null;
}

/**
 * 应用级会话宿主集合：每个打开的会话只有一份控制器（事件订阅、命令对账、草稿、引用、
 * 运行状态与选模），供该会话的所有呈现实例共享。
 *
 * 全局 Multivac 会话常驻；其他会话在第一个呈现实例出现时创建，最后一个呈现实例离开后释放。
 */
export function AssistantSessionsProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new SessionControllerStore());
  const [openSessionIds, setOpenSessionIds] = useState<readonly string[]>([GLOBAL_ASSISTANT_SESSION_ID]);
  const retainCountsRef = useRef(new Map<string, number>());
  // 可见实例决定模型轮询；隐藏实例仍保留草稿、运行状态和事件处理。
  const activeCountsRef = useRef(new Map<string, number>());
  const [activeIds, setActiveIds] = useState<ReadonlySet<string>>(() => new Set([GLOBAL_ASSISTANT_SESSION_ID]));
  const releaseTimersRef = useRef(new Map<string, number>());

  const retain = useCallback((sessionId: string, active: boolean) => {
    if (active) {
      activeCountsRef.current.set(sessionId, (activeCountsRef.current.get(sessionId) ?? 0) + 1);
      setActiveIds(current => current.has(sessionId) ? current : new Set([...current, sessionId]));
    }
    const counts = retainCountsRef.current;
    counts.set(sessionId, (counts.get(sessionId) ?? 0) + 1);
    window.clearTimeout(releaseTimersRef.current.get(sessionId));
    releaseTimersRef.current.delete(sessionId);
    setOpenSessionIds((current) => current.includes(sessionId) ? current : [...current, sessionId]);
  }, []);

  const release = useCallback((sessionId: string, active: boolean) => {
    if (active) {
      const remaining = (activeCountsRef.current.get(sessionId) ?? 1) - 1;
      if (remaining > 0) activeCountsRef.current.set(sessionId, remaining);
      else {
        activeCountsRef.current.delete(sessionId);
        if (sessionId !== GLOBAL_ASSISTANT_SESSION_ID) setActiveIds(current => {
          if (!current.has(sessionId)) return current;
          const next = new Set(current); next.delete(sessionId); return next;
        });
      }
    }
    const counts = retainCountsRef.current;
    const remaining = (counts.get(sessionId) ?? 1) - 1;
    if (remaining > 0) {
      counts.set(sessionId, remaining);
      return;
    }
    counts.delete(sessionId);
    if (sessionId === GLOBAL_ASSISTANT_SESSION_ID) return;
    // 呈现实例在布局间移动时会先卸载再挂载；延后一拍释放，避免重建会话控制器。
    releaseTimersRef.current.set(sessionId, window.setTimeout(() => {
      releaseTimersRef.current.delete(sessionId);
      if (retainCountsRef.current.has(sessionId)) return;
      setOpenSessionIds((current) => current.filter((id) => id !== sessionId));
    }, 0));
  }, []);

  useEffect(() => () => {
    for (const timer of releaseTimersRef.current.values()) window.clearTimeout(timer);
  }, []);

  const value = useMemo(() => ({ store, retain, release }), [release, retain, store]);
  return (
    <AssistantSessionsContext.Provider value={value}>
      {openSessionIds.map((sessionId) => <SessionHost key={sessionId} sessionId={sessionId} store={store} active={activeIds.has(sessionId)} />)}
      {children}
    </AssistantSessionsContext.Provider>
  );
}

/**
 * 取得会话状态并在使用期间保持该会话打开。会话控制器尚未就绪时返回 undefined。
 */
export function useAssistantSession(
  sessionId: string = GLOBAL_ASSISTANT_SESSION_ID,
  active = true,
): AssistantSessionEntry | undefined {
  const context = useContext(AssistantSessionsContext);
  if (!context) throw new Error('useAssistantSession 必须在 AssistantSessionsProvider 内使用。');
  const { store, retain, release } = context;

  useLayoutEffect(() => {
    retain(sessionId, active);
    return () => release(sessionId, active);
  }, [release, retain, sessionId, active]);

  return useSyncExternalStore(store.subscribe, () => store.get(sessionId));
}
