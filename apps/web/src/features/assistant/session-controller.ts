import {
  ASSISTANT_DRAFT_MAX_UTF8_BYTES,
  type AssistantCommandReceipt,
  type AssistantContextRef,
  type AssistantExecutor,
  type AssistantPageState,
  type AssistantPublicEvent,
  type AssistantQuote,
  type AssistantStreamingBehavior,
  type CurrentViewSnapshot,
  type ToolAuthorizationDecision,
  type ToolAuthorizationRequest,
} from '@multivac/contracts';
import {
  AssistantApiError,
  cancelAssistantTurn,
  decideToolAuthorization,
  getAssistantCommand,
  getAssistantPageState,
  getAssistantSessionPage,
  listToolAuthorizations,
  putAssistantPageState,
  sendAssistantMessage,
} from '../../data/assistant-api.js';
import { newCommandId } from '../../data/command-id.js';
import type { GlobalEventRouter, SessionEventFeed } from '../events/event-router.js';
import {
  AWAITING_AUTHORIZATION_FEEDBACK, IDLE_FEEDBACK, PROCESSING_FEEDBACK, SENDING_FEEDBACK, UNKNOWN_FEEDBACK,
  cancelledFeedback, commandStatusFeedback, failedFeedback, progressFeedback, reconciledFeedback, runEndFeedback,
  terminalFeedback, unsuccessfulSendError,
  type CommandProgressStatus, type RunFeedback,
} from './command-feedback.js';
import { sameQuote } from './message-quote.js';
import {
  INITIAL_PAGE_STATE, PageStateSaver, draftSizeBytes, readErrorMessage,
  type LocalChangeKind, type SaveFeedback, type SubmittedPageContent, type Timers,
} from './page-state-saver.js';
import {
  canClearRunningDraft, canClearSettledDraft, canRestoreUnsentDraft,
  isPendingCommand, pendingDraftRestoration, sameCommand,
  type CommandIdentity, type DraftContext, type LegacyPendingCommand, type PendingCommand,
} from './pending-command.js';
import {
  EMPTY_HISTORY, applyEarlierPage, applyHistorySnapshot, historyFromPage, loadInitialWindow, withExecutor,
  type SessionHistory,
} from './session-history.js';
import { SessionPersistence } from './session-persistence.js';
import type { SessionModelState } from './session-model.js';
import { admitStreamingSnapshot, appendStreamingDelta, loadStreamingHistory, type StreamingHistorySnapshot } from './streaming-messages.js';
import type { FailedSubmission, ReadingDraftQuote } from './submission-recovery.js';
import { applyRunTraceEvent, applyToolExecutionEvent, withoutCommand, type RunTrace, type ToolExecution } from './tool-executions.js';
import {
  applyAuthorizationEvent, authorizationDecisionError, mergeAuthorizations, pendingAuthorizations, upsertAuthorization,
} from './tool-authorizations.js';
import { echoOccurrences, type LocalEcho } from './local-echo.js';

const COMMAND_RECONCILIATION_TIMEOUT_MS = 12_000;
const COMMAND_RECONCILIATION_DELAYS_MS = [100, 200, 400, 800, 1_000] as const;
const EVENT_RECOVERY_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000] as const;

/** 授权卡上一次提交的进行状态与失败说明；只在本页面内有效，状态本身以服务端请求为准。 */
export interface AuthorizationDecisionState {
  submitting: ToolAuthorizationDecision | null;
  error: string;
}

interface StreamingBehaviorSelection extends CommandIdentity {
  behavior: AssistantStreamingBehavior;
  selectionGeneration: number;
}

/** 提交过程中交给呈现实例的回调：只有真正发出命令时才调用，呈现实例据此处理滚动跟随。 */
export interface SubmitHooks {
  onStart?: () => void;
  onRejected?: () => void;
  /** 书伴将正文与本次引用立即移交消息区；普通工作对话仍按回执清稿。 */
  clearOnSubmit?: boolean;
  /** 阅读引用只通过 contextRefs 发送，不占用普通消息的引用槽。 */
  omitQuote?: boolean;
  /** 本次发送附带的上下文引用（Multivac 侧栏正在看的会话或项目）。 */
  contextRefs?: readonly AssistantContextRef[];
  /**
   * 发送时本窗口的当前视图（只有全局 Multivac 带）。它描述发送时的界面，不是发送内容：
   * 不属于命令指纹，按原命令重试时带的是重试那一刻的视图。
   */
  view?: CurrentViewSnapshot | null;
}

/** 会话控制器的唯一状态快照；每次变化都产生新对象，呈现层按引用比较。 */
export interface SessionState {
  status: 'loading' | 'ready' | 'error';
  /** 每次（重新）加载递增；呈现实例据此重新执行阅读位置恢复。 */
  loadGeneration: number;
  initialError: string;
  historyError: string;
  history: SessionHistory;
  loadingEarlier: boolean;
  /** 最近一次成功合并的更早历史批次，呈现实例用它做滚动补偿。 */
  renderedHistoryGeneration: number | null;
  /** 会话的目录外访问授权请求（含历史），按创建时间升序。 */
  authorizations: readonly ToolAuthorizationRequest[];
  authorizationDecisions: Readonly<Record<string, AuthorizationDecisionState>>;
  page: AssistantPageState;
  saveFeedback: SaveFeedback;
  runFeedback: RunFeedback;
  /** 状态条当前描述的命令。 */
  runFeedbackOwner: CommandIdentity | null;
  /** 本地这轮反馈开始时已知的事件水位，用于与其他窗口的新一轮比较。 */
  runFeedbackAfterCursor: number;
  /** 运行中的普通发送（服务端已接手、尚未终结）。 */
  activePrompt: CommandIdentity | null;
  streamingBehaviorSelection: StreamingBehaviorSelection | null;
  /** 等待回执或对账的本次发送。 */
  pendingCommand: PendingCommand | null;
  submitting: boolean;
  cancelling: boolean;
  reconcilingCommandId: string | null;
  sendError: string;
  localEcho: LocalEcho | null;
  readingQuote: ReadingDraftQuote | null;
  failedSubmissions: readonly FailedSubmission[];
}

/** 会话读写服务端的接口；测试可替换为内存实现。 */
export interface SessionApi {
  getPageState: typeof getAssistantPageState;
  putPageState: typeof putAssistantPageState;
  getPage: typeof getAssistantSessionPage;
  listAuthorizations: typeof listToolAuthorizations;
  decideAuthorization: typeof decideToolAuthorization;
  getCommand: typeof getAssistantCommand;
  send: typeof sendAssistantMessage;
  cancel: typeof cancelAssistantTurn;
}

export const httpSessionApi: SessionApi = {
  getPageState: getAssistantPageState,
  putPageState: putAssistantPageState,
  getPage: getAssistantSessionPage,
  listAuthorizations: listToolAuthorizations,
  decideAuthorization: decideToolAuthorization,
  getCommand: getAssistantCommand,
  send: sendAssistantMessage,
  cancel: cancelAssistantTurn,
};

/** 控制器使用的图片草稿能力（由呈现层的图片草稿提供）。 */
export interface ImageDraftPort {
  ids(): string[];
  readonly ready: boolean;
  clear(ids: readonly string[]): void;
  restore(ids: readonly string[], isCurrent?: () => boolean): Promise<void>;
}

const NO_IMAGE_DRAFT: ImageDraftPort = { ids: () => [], ready: true, clear: () => {}, restore: async () => {} };

export interface SessionControllerOptions {
  sessionId: string;
  events: Pick<GlobalEventRouter, 'open'>;
  api?: SessionApi;
  persistence?: SessionPersistence;
  timers?: Timers;
  createCommandId?: () => string;
  now?: () => string;
  /** 毫秒时钟，用于对账超时。 */
  clock?: () => number;
}

const browserTimers: Timers = {
  setTimeout: (callback, delay) => window.setTimeout(callback, delay),
  clearTimeout: (handle) => window.clearTimeout(handle),
};

/**
 * 单个会话的控制器：拥有该会话在本页的全部状态，统一调度服务端请求、事件订阅与浏览器存储。
 *
 * 规则分在各自模块：命令草稿归属见 pending-command，运行反馈见 command-feedback，
 * 页面现场保存见 page-state-saver，历史合并见 session-history；这里只负责把它们按事件串起来。
 * 呈现层通过 subscribe/getState 读取快照，通过公开方法发出操作。
 */
export class AssistantSessionController {
  readonly sessionId: string;
  /** 呈现层每次渲染时更新：图片草稿与选模状态由 React 控制器提供。 */
  imageDraft: ImageDraftPort = NO_IMAGE_DRAFT;
  model: SessionModelState = { available: false, busy: false, loaded: false };

  private state: SessionState;
  private readonly listeners = new Set<() => void>();
  private readonly api: SessionApi;
  private readonly events: Pick<GlobalEventRouter, 'open'>;
  private readonly persistence: SessionPersistence;
  private readonly timers: Timers;
  private readonly createCommandId: () => string;
  private readonly now: () => string;
  private readonly clock: () => number;
  private readonly saver: PageStateSaver;

  private mounted = false;
  private lifecycle = 0;
  private loadCounter = 0;
  private historyGeneration = 0;
  private lastEventCursor = 0;
  private historySnapshotCursor = 0;
  private legacyPendingCommand: LegacyPendingCommand | null;
  private commandGeneration: number;
  private readonly commandGenerations = new Map<string, number>();
  private streamingBehaviorSelectionGeneration = 0;
  /** 最近一次普通发送（不含运行中追加）；只有它的结果能改变状态条与草稿。 */
  private latestPrompt: CommandIdentity | null;
  private submissionCommand: CommandIdentity | null = null;
  private cancellingPrompt: CommandIdentity | null = null;
  private reconciliationCommand: CommandIdentity | null = null;
  private eventRecovering = false;
  /** 恢复进行中又收到过期通知（全局流在恢复衔接之后才过期）：本次结束后再恢复一次。 */
  private eventRecoveryAgain = false;
  private eventRecoveryTimer: number | undefined;
  /** 本会话在全局事件流上的接入：每次（重新）读取快照前接入，快照到位后衔接。 */
  private eventFeed: SessionEventFeed | null = null;
  private readonly deciding = new Set<string>();

  constructor(options: SessionControllerOptions) {
    this.sessionId = options.sessionId;
    this.api = options.api ?? httpSessionApi;
    this.events = options.events;
    this.persistence = options.persistence ?? new SessionPersistence(options.sessionId);
    this.timers = options.timers ?? browserTimers;
    this.createCommandId = options.createCommandId ?? newCommandId;
    this.now = options.now ?? (() => new Date().toISOString());
    // 每次调用时取当时的全局时钟：测试与调试工具可能在控制器创建之后替换 Date。
    this.clock = options.clock ?? (() => Date.now());

    const stored = this.persistence.readPendingCommand();
    const pending = isPendingCommand(stored) ? stored : null;
    this.legacyPendingCommand = stored && !isPendingCommand(stored) ? stored : null;
    const activePrompt = this.persistence.readActivePrompt();
    this.commandGeneration = Math.max(
      this.persistence.readCommandGeneration(),
      this.legacyPendingCommand?.generation ?? 0,
      pending?.generation ?? 0,
      activePrompt?.generation ?? 0,
    );
    if (pending) this.commandGenerations.set(pending.commandId, pending.generation);
    if (activePrompt) this.commandGenerations.set(activePrompt.commandId, activePrompt.generation);
    this.latestPrompt = pending?.streamingBehavior === null && (!activePrompt || pending.generation >= activePrompt.generation)
      ? pending
      : activePrompt;

    this.saver = new PageStateSaver({
      read: () => this.api.getPageState(this.sessionId),
      write: (state, keepalive) => this.api.putPageState(this.sessionId, state, keepalive),
      timers: this.timers,
      lifecycle: () => this.lifecycle,
      isActive: (lifecycle) => this.isActive(lifecycle),
      persistDraftVersion: (version) => this.persistence.writeDraftVersion(version),
      changed: () => this.update({ page: this.saver.page, saveFeedback: this.saver.feedback }),
    }, this.persistence.readDraftVersion());

    this.state = {
      status: 'loading',
      loadGeneration: 0,
      initialError: '',
      historyError: '',
      history: EMPTY_HISTORY,
      loadingEarlier: false,
      renderedHistoryGeneration: null,
      authorizations: [],
      authorizationDecisions: {},
      page: INITIAL_PAGE_STATE,
      saveFeedback: this.saver.feedback,
      runFeedback: IDLE_FEEDBACK,
      runFeedbackOwner: null,
      runFeedbackAfterCursor: 0,
      activePrompt,
      streamingBehaviorSelection: null,
      pendingCommand: pending,
      submitting: false,
      cancelling: false,
      reconcilingCommandId: null,
      sendError: '',
      localEcho: null,
      readingQuote: this.persistence.readReadingQuote(),
      failedSubmissions: this.persistence.readFailedSubmissions(),
    };
  }

  // ── 状态与生命周期 ──────────────────────────────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): SessionState => this.state;

  /** 呈现层挂载：开始读取并接入事件流。卸载后可以再次 start（开发模式下的重复挂载）。 */
  start(): void {
    const lifecycle = ++this.lifecycle;
    this.mounted = true;
    void this.load(lifecycle);
  }

  /** 呈现层卸载：退出前保存草稿，作废在途请求的结果并断开事件流。 */
  dispose(): void {
    this.saver.flushOnExit();
    this.mounted = false;
    this.lifecycle += 1;
    this.loadCounter += 1;
    this.historyGeneration += 1;
    this.saver.dispose();
    this.timers.clearTimeout(this.eventRecoveryTimer);
    this.eventFeed?.close();
    this.eventFeed = null;
  }

  reload(): void {
    void this.load(this.lifecycle);
  }

  /** 页面隐藏或离开。 */
  flushOnExit(): void {
    this.saver.flushOnExit();
  }

  /** 网络恢复。 */
  online(): void {
    this.saver.online();
  }

  private update(patch: Partial<SessionState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener();
  }

  private updateHistory(change: (history: SessionHistory) => SessionHistory): void {
    this.update({ history: change(this.state.history) });
  }

  private isActive(lifecycle: number): boolean {
    return this.mounted && this.lifecycle === lifecycle;
  }

  private delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => this.timers.setTimeout(resolve, milliseconds));
  }

  // ── 本地现场 ────────────────────────────────────────────────────

  private markLocalChange(next: AssistantPageState, kind: LocalChangeKind): void {
    this.saver.change(next, kind);
  }

  /** 图片草稿变化同样是草稿意图。 */
  imageDraftChanged(): void {
    this.markLocalChange({ ...this.saver.page }, 'draft-intent');
  }

  private setPendingCommand(command: PendingCommand | null): void {
    this.persistence.writePendingCommand(command);
    this.update({ pendingCommand: command });
  }

  private updateReadingQuote(quote: ReadingDraftQuote | null): void {
    this.persistence.writeReadingQuote(quote);
    this.update({ readingQuote: quote });
  }

  private updateFailedSubmissions(change: (current: readonly FailedSubmission[]) => FailedSubmission[]): void {
    const next = change(this.state.failedSubmissions);
    this.persistence.writeFailedSubmissions(next);
    this.update({ failedSubmissions: next });
  }

  /** 判断草稿归属所需的本地现场快照。 */
  private draftContext(): DraftContext {
    return { draftVersion: this.saver.draftVersion, page: this.saver.page, readingQuote: this.state.readingQuote, latestPrompt: this.latestPrompt };
  }

  setReadingQuote(quote: ReadingDraftQuote | null): void {
    if (JSON.stringify(quote) === JSON.stringify(this.state.readingQuote)) return;
    this.updateReadingQuote(quote);
    this.markLocalChange({ ...this.saver.page }, 'draft-intent');
  }

  setAgentId(agentId: string | null): void {
    if ((this.saver.page.agentId ?? null) === agentId || this.state.activePrompt || this.state.submitting) return;
    this.update({ sendError: '' });
    this.markLocalChange({ ...this.saver.page, agentId }, 'draft-intent');
  }

  updateDraft(draft: string): void {
    if (this.saver.page.draft === draft) return;
    this.update({ sendError: '' });
    this.markLocalChange({ ...this.saver.page, draft }, 'draft-intent');
  }

  setQuote(quote: AssistantQuote): void {
    this.update({ sendError: '' });
    // 只替换引用，草稿原样保留。
    this.markLocalChange({ ...this.saver.page, quote }, 'draft-intent');
  }

  removeQuote(): void {
    if (!this.saver.page.quote) return;
    this.markLocalChange({ ...this.saver.page, quote: null }, 'draft-intent');
  }

  /** 记录阅读锚点；只应由首页呈现实例调用。 */
  setReadingAnchor(entryId: string | null, offsetPx: number): void {
    const current = this.saver.page;
    if (current.anchorEntryId === entryId && Math.abs(current.anchorOffsetPx - offsetPx) < 0.5) return;
    this.markLocalChange({ ...current, anchorEntryId: entryId, anchorOffsetPx: offsetPx }, 'view-anchor');
  }

  retrySave(): void {
    void this.saver.enqueue(false, true);
  }

  // ── 读取与历史 ──────────────────────────────────────────────────

  private async load(lifecycle: number): Promise<void> {
    const generation = ++this.loadCounter;
    this.historyGeneration += 1;
    this.saver.suspend();
    this.update({
      loadGeneration: generation, renderedHistoryGeneration: null, status: 'loading', initialError: '', historyError: '',
      loadingEarlier: false, sendError: '', localEcho: null,
    });
    const isCurrent = () => this.isActive(lifecycle) && this.loadCounter === generation;

    // 读取快照之前接入全局事件流：读取期间到达的本会话事件先缓存，快照到位后按快照游标衔接。
    this.eventFeed?.close();
    const feed = this.events.open(this.sessionId, {
      deliver: (event) => this.handleEvent(event, lifecycle),
      expired: () => void this.recoverExpiredEventCursor(lifecycle),
    });
    this.eventFeed = feed;

    try {
      const [state, latestPage] = await Promise.all([this.api.getPageState(this.sessionId), this.api.getPage(this.sessionId)]);
      const page = await loadInitialWindow(state, latestPage, (before) => this.api.getPage(this.sessionId, before), isCurrent);
      if (!page || !isCurrent()) return;
      // 授权请求在快照之后读取：快照水位之前创建的请求都在结果里，之后的变化由事件补上。
      const authorizationList = await this.api.listAuthorizations(this.sessionId);
      if (!isCurrent()) return;

      const { pending, restoredState, restoredPendingDraft, legacyPendingError } = this.restoreDraft(state);

      this.historySnapshotCursor = Number(page.eventCursor);
      this.lastEventCursor = Number(page.eventCursor);
      this.saver.reset(restoredState, restoredPendingDraft);
      this.update({
        history: historyFromPage(this.state.history, page),
        localEcho: pending?.clearOnSubmit ? {
          commandId: pending.commandId, generation: pending.generation, text: pending.text, quote: pending.quote,
          contextRefs: pending.contextRefs, omitQuote: pending.omitQuote ?? false,
          createdAt: pending.echoCreatedAt ?? this.now(), baseline: pending.echoBaseline ?? echoOccurrences(page.messages, pending),
        } : null,
        authorizations: mergeAuthorizations([], authorizationList.requests),
        authorizationDecisions: {},
        ...(legacyPendingError ? { sendError: legacyPendingError } : {}),
        status: 'ready',
      });
      // 快照与缓存衔接：丢弃快照已包含的事件，按序应用之后的（必要时先补漏）。
      feed.ready(Number(page.eventCursor));
      // 就绪后核对重新进入前留下的命令。
      const current = this.state.pendingCommand;
      if (current) void this.reconcilePendingCommand(current, lifecycle);
      void this.reconcileActivePrompt(lifecycle);
    } catch (loadError) {
      if (!isCurrent()) return;
      // 读取失败时不再缓存；重新读取时重新接入。
      feed.close();
      this.update({ initialError: readErrorMessage(loadError), status: 'error' });
    }
  }

  /** 重新进入会话时，按待对账命令决定服务端草稿是清空、恢复还是保留。 */
  private restoreDraft(state: AssistantPageState): {
    pending: PendingCommand | null; restoredState: AssistantPageState; restoredPendingDraft: boolean; legacyPendingError: string;
  } {
    const legacy = this.legacyPendingCommand;
    let pending = this.state.pendingCommand;
    let restoredState = state;
    let restoredPendingDraft = false;
    let legacyPendingError = '';
    if (legacy) {
      this.legacyPendingCommand = null;
      const recoveredText = legacy.text ?? (state.draft !== '' ? state.draft : null);
      if (recoveredText === null || (state.draft !== '' && state.draft !== recoveredText)) {
        this.persistence.writePendingCommand(null);
        legacyPendingError = '旧命令缺少可恢复的正文，已清理待重试记录。';
      } else {
        pending = { ...legacy, text: recoveredText, draftVersion: this.saver.draftVersion };
        this.setPendingCommand(pending);
        this.rememberCommand(pending);
        if (pending.streamingBehavior === null && (!this.state.activePrompt || pending.generation >= this.state.activePrompt.generation)) {
          this.latestPrompt = pending;
        }
      }
    }
    if (pending) {
      this.saver.adoptDraftVersion(pending.draftVersion);
      const restoration = pendingDraftRestoration(pending, state, { draftVersion: this.saver.draftVersion, latestPrompt: this.latestPrompt });
      if (restoration.kind === 'clear') {
        restoredState = { ...state, draft: '', quote: null };
        this.imageDraft.clear(pending.imageIds ?? []);
        restoredPendingDraft = true;
      } else if (restoration.kind === 'restore') {
        restoredState = { ...state, draft: pending.text, agentId: pending.agentId ?? null, quote: pending.quote };
        const restoredVersion = this.saver.draftVersion;
        void this.imageDraft.restore(pending.imageIds ?? [], () => this.saver.draftVersion === restoredVersion);
        restoredPendingDraft = true;
      }
    } else {
      const previousDraftVersion = this.saver.draftVersion;
      this.saver.advanceVersions();
      // 恢复过的失败记录跟随草稿进入新版本，仍可识别为同一份恢复内容。
      if (this.state.failedSubmissions.some((item) => item.restoredDraftVersion === previousDraftVersion)) {
        this.updateFailedSubmissions((current) => current.map((item) => item.restoredDraftVersion === previousDraftVersion &&
          item.text === state.draft && sameQuote(item.quote, state.quote) && JSON.stringify(item.readingQuote) === JSON.stringify(this.state.readingQuote)
          ? { ...item, restoredDraftVersion: this.saver.draftVersion } : item));
      }
    }
    return { pending, restoredState, restoredPendingDraft, legacyPendingError };
  }

  private applyHistorySnapshot(snapshot: StreamingHistorySnapshot): boolean {
    const admission = admitStreamingSnapshot(Number(snapshot.page.eventCursor), this.historySnapshotCursor, this.lastEventCursor);
    if (!admission.admitted) return false;
    this.historySnapshotCursor = admission.historyCursor;
    this.updateHistory((history) => applyHistorySnapshot(history, snapshot));
    return true;
  }

  private async refreshLatestMessages(lifecycle: number, attempt = 0): Promise<void> {
    if (!this.isActive(lifecycle)) return;
    try {
      const latest = await this.api.getPage(this.sessionId);
      if (!this.isActive(lifecycle)) return;
      if (Number(latest.eventCursor) < this.historySnapshotCursor) return;
      const snapshot = await loadStreamingHistory(this.state.history.messages, latest,
        (before) => this.api.getPage(this.sessionId, before), () => this.isActive(lifecycle));
      if (!this.isActive(lifecycle)) return;
      this.applyHistorySnapshot(snapshot);
    } catch {
      if (!this.isActive(lifecycle)) return;
      this.timers.setTimeout(() => void this.refreshLatestMessages(lifecycle, attempt + 1),
        Math.min(250 * 2 ** Math.min(attempt, 4), 3_000));
    }
  }

  /** 开始加载更早消息；返回本次批次号，未开始时返回 null。 */
  loadEarlier(): number | null {
    const before = this.state.history.nextBefore;
    if (!before || this.state.loadingEarlier) return null;
    const generation = ++this.historyGeneration;
    void this.loadEarlierBatch(before, generation);
    return generation;
  }

  private async loadEarlierBatch(before: string, generation: number): Promise<void> {
    const lifecycle = this.lifecycle;
    const current = () => this.isActive(lifecycle) && this.historyGeneration === generation;
    this.update({ historyError: '', loadingEarlier: true });
    try {
      const earlier = await this.api.getPage(this.sessionId, before);
      if (!current() || this.state.history.nextBefore !== before) return;
      this.update({ history: applyEarlierPage(this.state.history, earlier), renderedHistoryGeneration: generation });
    } catch (loadError) {
      if (!current()) return;
      this.update({ historyError: readErrorMessage(loadError) });
    } finally {
      if (current()) this.update({ loadingEarlier: false });
    }
  }

  // ── 命令身份与运行反馈 ───────────────────────────────────────────

  private rememberCommand(owner: CommandIdentity): void {
    this.commandGenerations.set(owner.commandId, owner.generation);
    this.commandGeneration = Math.max(this.commandGeneration, owner.generation);
    this.persistence.writeCommandGeneration(this.commandGeneration);
  }

  private nextCommandGeneration(): number {
    this.commandGeneration += 1;
    this.persistence.writeCommandGeneration(this.commandGeneration);
    return this.commandGeneration;
  }

  private commandIdentity(commandId: string | null): CommandIdentity | null {
    if (!commandId) return null;
    const generation = this.commandGenerations.get(commandId);
    return generation === undefined ? null : { commandId, generation };
  }

  private rememberExecutor(commandId: string, executor?: AssistantExecutor): void {
    if (executor) this.updateHistory((history) => ({ ...history, executors: withExecutor(history.executors, commandId, executor) }));
  }

  private isCurrentPending(owner: CommandIdentity): boolean {
    return sameCommand(this.state.pendingCommand, owner);
  }

  private confirmPendingCommand(owner: CommandIdentity): void {
    const pending = this.state.pendingCommand;
    if (!pending || !sameCommand(pending, owner) || (pending.confirmed && !pending.unknown)) return;
    this.setPendingCommand({ ...pending, unknown: false, confirmed: true });
  }

  private clearCancellation(owner: CommandIdentity): void {
    if (!sameCommand(this.cancellingPrompt, owner)) return;
    this.cancellingPrompt = null;
    this.update({ cancelling: false });
  }

  selectStreamingBehavior(behavior: AssistantStreamingBehavior): void {
    const owner = this.state.activePrompt;
    if (!owner) return;
    this.update({ streamingBehaviorSelection: { ...owner, behavior, selectionGeneration: ++this.streamingBehaviorSelectionGeneration } });
  }

  private clearStreamingBehaviorSelection(selection: StreamingBehaviorSelection): void {
    const current = this.state.streamingBehaviorSelection;
    if (!sameCommand(current, selection) || current?.selectionGeneration !== selection.selectionGeneration) return;
    this.update({ streamingBehaviorSelection: null });
  }

  /** 服务端已接手的最近一次普通发送成为运行中的一轮；更早代的命令不能顶替较新的一轮。 */
  private activatePrompt(owner: CommandIdentity): boolean {
    if (!sameCommand(this.latestPrompt, owner)) return false;
    const current = this.state.activePrompt;
    if (current && !sameCommand(current, owner) && current.generation >= owner.generation) return false;
    this.persistence.writeActivePrompt(owner);
    const selection = this.state.streamingBehaviorSelection;
    if (this.cancellingPrompt && !sameCommand(this.cancellingPrompt, owner)) this.cancellingPrompt = null;
    this.update({
      activePrompt: owner,
      ...(selection && !sameCommand(selection, owner) ? { streamingBehaviorSelection: null } : {}),
      ...(this.cancellingPrompt === null ? { cancelling: false } : {}),
    });
    return true;
  }

  private clearActivePrompt(owner: CommandIdentity): boolean {
    if (!sameCommand(this.state.activePrompt, owner)) return false;
    this.persistence.writeActivePrompt(null);
    this.update({ activePrompt: null });
    return true;
  }

  /** 只有最近一次普通发送能改变状态条；换了描述对象时记下当时的事件水位。 */
  private setPromptFeedback(owner: CommandIdentity, feedback: RunFeedback): boolean {
    if (!sameCommand(this.latestPrompt, owner)) return false;
    const afterCursor = sameCommand(this.state.runFeedbackOwner, owner)
      ? this.state.runFeedbackAfterCursor
      : Math.max(this.lastEventCursor, this.historySnapshotCursor);
    this.update({ runFeedback: feedback, runFeedbackOwner: owner, runFeedbackAfterCursor: afterCursor });
    return true;
  }

  /** 这一轮以终态结束：运行中的一轮与取消状态一并结束。 */
  private endPrompt(owner: CommandIdentity, feedback: RunFeedback | null): void {
    this.clearActivePrompt(owner);
    this.clearCancellation(owner);
    if (feedback) this.setPromptFeedback(owner, feedback);
  }

  private authorizationExpired(owner: CommandIdentity): boolean {
    return this.state.authorizations.some((request) => request.commandId === owner.commandId && request.status === 'expired');
  }

  // ── 草稿结算 ────────────────────────────────────────────────────

  private clearRunningCommandDraft(owner: CommandIdentity, immediately = false): void {
    const pending = this.state.pendingCommand;
    if (!canClearRunningDraft(pending, owner, this.draftContext(), immediately)) return;

    // 只清理同版本的正文与引用；智能体选择作为会话默认保留，发送快照仍用于核对和恢复。
    if (pending.clearOnSubmit) this.updateReadingQuote(null);
    this.markLocalChange({ ...this.saver.page, draft: '', quote: null }, 'command-settlement');
    this.imageDraft.clear(pending.imageIds ?? []);
    this.setPendingCommand({ ...pending, draftVersion: this.saver.draftVersion, cleared: true });
    void this.saver.enqueue(false, false, { draft: pending.text, agentId: pending.agentId ?? null, quote: pending.quote });
  }

  private restoreUnsentCommandDraft(owner: CommandIdentity): boolean {
    const pending = this.state.pendingCommand;
    if (!canRestoreUnsentDraft(pending, owner, this.draftContext())) return false;
    // 工具记录不随草稿撤回：命令运行过才会有工具记录，它们已由服务端投影持久化，
    // 属于会话事实（例如等待授权时服务重启、按中断结束的一轮，刷新后仍要看到这一轮的工具记录）。
    // 引用与正文一起回到输入区，用户不必重新选择来源。
    if (pending.clearOnSubmit) this.updateReadingQuote(pending.readingQuote ?? null);
    this.markLocalChange({ ...this.saver.page, draft: pending.text, agentId: pending.agentId ?? null, quote: pending.quote }, 'command-settlement');
    const restoredVersion = this.saver.draftVersion;
    void this.imageDraft.restore(pending.imageIds ?? [], () => this.saver.draftVersion === restoredVersion);
    return true;
  }

  private rejectSubmission(owner: CommandIdentity, error: string, received = false): void {
    const pending = this.state.pendingCommand;
    if (!pending || !sameCommand(pending, owner)) return;
    // 服务端已接收后的执行失败仍是会话事实，不自动撤回为未发送提问；指定智能体的命令同样处理，
    // 未送达时草稿连同智能体选择回到输入区，重试即按原选择发送。
    if (pending.clearOnSubmit && (pending.confirmed || received)) return;
    const restored = received || pending.confirmed ? false : this.restoreUnsentCommandDraft(owner);
    if (pending.clearOnSubmit) this.updateFailedSubmissions((current) => [...current.filter((item) => item.commandId !== pending.commandId).slice(-19), {
      commandId: pending.commandId, text: pending.text, ...(pending.agentId ? { agentId: pending.agentId } : {}), omitQuote: pending.omitQuote ?? false,
      ...(pending.imageIds ? { imageIds: pending.imageIds } : {}), quote: pending.quote, readingQuote: pending.readingQuote ?? null, contextRefs: pending.contextRefs,
      createdAt: pending.echoCreatedAt ?? this.now(), restoredDraftVersion: restored ? this.saver.draftVersion : null, error,
    }]);
  }

  private clearLocalEcho(owner: CommandIdentity): void {
    const echo = this.state.localEcho;
    if (echo && sameCommand(echo, owner)) this.update({ localEcho: null });
  }

  // ── 回执与对账 ──────────────────────────────────────────────────

  /** 应用本次发送的回执；返回命令是否已终结。迟到回执只作为历史事实，不结算已被替换的发送。 */
  private async applyCommandReceipt(receipt: AssistantCommandReceipt, submitted: PendingCommand): Promise<boolean> {
    if (receipt.commandId !== submitted.commandId) return false;
    this.rememberExecutor(receipt.commandId, receipt.executor);
    const owner: CommandIdentity = submitted;
    const ownsPending = this.isCurrentPending(owner);
    const ownsLatestPrompt = submitted.streamingBehavior === null && sameCommand(this.latestPrompt, owner);

    if (receipt.status !== 'terminal' || receipt.terminalOutcome === null) {
      if (receipt.status !== 'unknown') this.confirmPendingCommand(owner);
      if (receipt.status === 'running') this.clearRunningCommandDraft(owner);
      if (ownsLatestPrompt) {
        if (receipt.status !== 'unknown') this.activatePrompt(owner);
        this.setPromptFeedback(owner, commandStatusFeedback(receipt.status as CommandProgressStatus));
      }
      return false;
    }

    const expired = this.authorizationExpired(owner);
    if (ownsLatestPrompt) this.endPrompt(owner, terminalFeedback(receipt.terminalOutcome, receipt.error, expired));
    if (!ownsPending) return true;

    const successful = receipt.terminalOutcome === 'succeeded' || receipt.terminalOutcome === 'accepted';
    if (!successful) {
      this.clearLocalEcho(owner);
      this.rejectSubmission(owner, receipt.error?.message ?? '消息未发送成功。', receipt.terminalOutcome !== 'rejected');
      this.setPendingCommand(null);
      this.update({ sendError: unsuccessfulSendError(receipt.terminalOutcome, receipt.error, expired) });
      return true;
    }

    const currentPending = this.state.pendingCommand!;
    this.setPendingCommand(null);
    if (canClearSettledDraft(currentPending, submitted, { ...this.draftContext(), conflictBlocked: this.saver.blocked })) {
      // 命令成功只清理已发送内容，保留智能体选择，也不能覆盖冲突或下一条草稿。
      this.markLocalChange({ ...this.saver.page, draft: '', quote: null }, 'command-settlement');
      this.imageDraft.clear(submitted.imageIds ?? []);
      await this.saver.enqueue(false, false, { draft: submitted.text, agentId: submitted.agentId ?? null, quote: submitted.quote });
    }
    return true;
  }

  /** 运行中一轮（其他页面或刷新前发出）的回执：只更新状态条。 */
  private applyActivePromptReceipt(receipt: AssistantCommandReceipt, owner: CommandIdentity, lifecycle: number): void {
    if (receipt.commandId !== owner.commandId || !sameCommand(this.state.activePrompt, owner)) return;
    this.rememberExecutor(receipt.commandId, receipt.executor);
    if (receipt.status !== 'terminal' || receipt.terminalOutcome === null) {
      this.setPromptFeedback(owner, commandStatusFeedback(receipt.status as CommandProgressStatus));
      return;
    }
    this.endPrompt(owner, terminalFeedback(receipt.terminalOutcome, receipt.error, this.authorizationExpired(owner)) ?? failedFeedback(receipt.error));
    void this.refreshLatestMessages(lifecycle);
  }

  private async reconcilePendingCommand(submitted: PendingCommand, lifecycle: number): Promise<void> {
    const owner: CommandIdentity = submitted;
    if (sameCommand(this.reconciliationCommand, owner)) return;
    this.reconciliationCommand = owner;
    if (this.isActive(lifecycle)) this.update({ reconcilingCommandId: owner.commandId });
    const startedAt = this.clock();
    let attempt = 0;
    let remainedUnknown = true;

    try {
      while (this.isActive(lifecycle) && this.clock() - startedAt < COMMAND_RECONCILIATION_TIMEOUT_MS) {
        try {
          const reconciliation = await this.api.getCommand(this.sessionId, submitted.commandId);
          if (!this.isActive(lifecycle) || !this.isCurrentPending(owner)) return;
          if (reconciliation.status === 'terminal' && reconciliation.receipt) {
            await this.applyCommandReceipt(reconciliation.receipt, submitted);
            return;
          }
          if (reconciliation.status === 'terminal') {
            this.update({ sendError: '命令已终结，但服务未返回可用回执。' });
            return;
          }
          remainedUnknown = remainedUnknown && reconciliation.status === 'unknown';
          if (reconciliation.status !== 'unknown') this.confirmPendingCommand(owner);
          if (reconciliation.status === 'running') this.clearRunningCommandDraft(owner);
          if (reconciliation.receipt) {
            await this.applyCommandReceipt(reconciliation.receipt, submitted);
          } else if (submitted.streamingBehavior === null) {
            if (reconciliation.status !== 'unknown') this.activatePrompt(owner);
            this.setPromptFeedback(owner, commandStatusFeedback(reconciliation.status as CommandProgressStatus));
          }
        } catch {
          if (!this.isActive(lifecycle) || !this.isCurrentPending(owner)) return;
        }
        const delay = COMMAND_RECONCILIATION_DELAYS_MS[Math.min(attempt, COMMAND_RECONCILIATION_DELAYS_MS.length - 1)]!;
        attempt += 1;
        await this.delay(delay);
      }

      if (!this.isActive(lifecycle) || !this.isCurrentPending(owner)) return;
      const pending = this.state.pendingCommand!;
      if (!remainedUnknown || pending.confirmed || (pending.cleared && !pending.clearOnSubmit)) return;
      this.setPendingCommand({ ...pending, unknown: true });
      if (submitted.streamingBehavior === null) {
        this.clearActivePrompt(owner);
        this.setPromptFeedback(owner, UNKNOWN_FEEDBACK);
      }
      this.update({ sendError: pending.agentId ? '发送结果未知，原智能体选择已保留，请核对原命令结果。' : '发送结果未知，可按原命令重试。' });
    } finally {
      if (sameCommand(this.reconciliationCommand, owner)) {
        this.reconciliationCommand = null;
        if (this.isActive(lifecycle)) this.update({ reconcilingCommandId: null });
      }
    }
  }

  private async reconcileActivePrompt(lifecycle: number): Promise<void> {
    const owner = this.state.activePrompt;
    if (!owner || sameCommand(this.state.pendingCommand, owner)) return;
    for (let attempt = 0; attempt < COMMAND_RECONCILIATION_DELAYS_MS.length; attempt += 1) {
      try {
        const reconciliation = await this.api.getCommand(this.sessionId, owner.commandId);
        if (!this.isActive(lifecycle) || !sameCommand(this.state.activePrompt, owner)) return;
        if (reconciliation.receipt) this.applyActivePromptReceipt(reconciliation.receipt, owner, lifecycle);
        else if (reconciliation.status === 'unknown') this.clearActivePrompt(owner);
        return;
      } catch {
        if (!this.isActive(lifecycle)) return;
        await this.delay(COMMAND_RECONCILIATION_DELAYS_MS[attempt]!);
      }
    }
  }

  private async settlePendingCommandFromTerminalEvent(owner: CommandIdentity, lifecycle: number): Promise<void> {
    if (!this.isCurrentPending(owner)) return;
    try {
      const reconciliation = await this.api.getCommand(this.sessionId, owner.commandId);
      if (!this.isActive(lifecycle) || !this.isCurrentPending(owner) || !reconciliation.receipt) return;
      await this.applyCommandReceipt(reconciliation.receipt, this.state.pendingCommand!);
    } catch {
      // 既有持续对账仍会重试；terminal SSE 不因一次补读失败退回运行态。
    }
  }

  // ── 事件 ────────────────────────────────────────────────────────

  private async recoverExpiredEventCursor(lifecycle: number, attempt = 0): Promise<void> {
    if (this.eventRecovering) {
      this.eventRecoveryAgain = true;
      return;
    }
    this.eventRecovering = true;
    this.eventRecoveryAgain = false;
    const pending = this.state.pendingCommand;
    const active = this.state.activePrompt;
    try {
      const commandIds = [...new Set([pending?.commandId, active?.commandId].filter((value): value is string => Boolean(value)))];
      const [state, latest, reconciliations] = await Promise.all([
        this.api.getPageState(this.sessionId),
        this.api.getPage(this.sessionId).then((page) => loadStreamingHistory(this.state.history.messages, page,
          (before) => this.api.getPage(this.sessionId, before), () => this.isActive(lifecycle))),
        Promise.all(commandIds.map((commandId) => this.api.getCommand(this.sessionId, commandId))),
      ]);
      if (!this.isActive(lifecycle)) return;

      this.saver.reconcileRemote(state, lifecycle);
      this.applyHistorySnapshot(latest);
      // 缺失的授权事件无法重放：在新快照之后重新读取全部请求。
      const authorizationList = await this.api.listAuthorizations(this.sessionId);
      if (!this.isActive(lifecycle)) return;
      this.update({ authorizations: mergeAuthorizations(this.state.authorizations, authorizationList.requests) });
      // 恢复等待状态/命令期间，普通刷新与消费水位可能已经推进；以较高者作为新快照的水位与全局流衔接。
      const resumeCursor = Math.max(this.lastEventCursor, this.historySnapshotCursor);
      this.lastEventCursor = resumeCursor;
      this.eventFeed?.ready(resumeCursor);
      const results = new Map(reconciliations.map((item) => [item.commandId, item]));
      const activeResult = active ? results.get(active.commandId) : null;
      if (active && activeResult?.receipt) this.applyActivePromptReceipt(activeResult.receipt, active, lifecycle);
      else if (active && activeResult?.status === 'unknown') this.clearActivePrompt(active);
      const pendingResult = pending ? results.get(pending.commandId) : null;
      if (pending && this.isCurrentPending(pending) && pendingResult?.receipt) await this.applyCommandReceipt(pendingResult.receipt, pending);
      else if (pending && this.isCurrentPending(pending)) void this.reconcilePendingCommand(pending, lifecycle);
      if (this.state.sendError.startsWith('事件恢复失败：')) this.update({ sendError: '' });
    } catch (error) {
      if (this.isActive(lifecycle)) {
        this.update({ sendError: `事件恢复失败：${readErrorMessage(error)}` });
        // 稍后整体重试，期间的过期通知由这次重试一并处理。
        this.eventRecoveryAgain = false;
        const delay = EVENT_RECOVERY_DELAYS_MS[Math.min(attempt, EVENT_RECOVERY_DELAYS_MS.length - 1)]!;
        this.timers.clearTimeout(this.eventRecoveryTimer);
        this.eventRecoveryTimer = this.timers.setTimeout(() => void this.recoverExpiredEventCursor(lifecycle, attempt + 1), delay);
      }
    } finally {
      this.eventRecovering = false;
      if (this.eventRecoveryAgain) {
        this.eventRecoveryAgain = false;
        if (this.isActive(lifecycle)) void this.recoverExpiredEventCursor(lifecycle);
      }
    }
  }

  /**
   * 应用一条本会话的公共事件（由全局事件流按会话分发，快照到位后按 cursor 升序交付）。
   * 仍按 `cursor <= lastEventCursor` 去重：恢复与普通刷新可能已推进水位。
   */
  private handleEvent(event: AssistantPublicEvent, lifecycle: number): void {
    const cursor = Number(event.cursor);
    if (!this.isActive(lifecycle) || cursor <= this.lastEventCursor) return;
    this.lastEventCursor = cursor;
    const owner = this.commandIdentity(event.commandId);
    if (event.type === 'assistant.command.accepted' && event.commandId) this.rememberExecutor(event.commandId, event.data.executor);
    const ownsLatestPrompt = Boolean(owner && sameCommand(this.latestPrompt, owner));
    const ownsActivePrompt = Boolean(owner && sameCommand(this.state.activePrompt, owner));
    // 这一轮仍由本页跟踪：运行中，或仍在等待本次发送的回执。
    const tracksPrompt = Boolean(owner && ownsLatestPrompt && (ownsActivePrompt || sameCommand(this.state.pendingCommand, owner)));
    const applyTrace = () => this.updateHistory((history) => ({ ...history, runTraces: applyRunTraceEvent(history.runTraces, event) }));

    switch (event.type) {
      case 'assistant.message.delta':
        this.updateHistory((history) => ({ ...history, messages: appendStreamingDelta(history.messages, event) }));
        // 正文与轨迹共用事件水位：历史回读尚未到位时，也能按真实身份归类过程说明。
        applyTrace();
        break;
      case 'assistant.thinking.delta':
        applyTrace();
        break;
      case 'assistant.command.handed_to_pi':
        applyTrace();
        if (event.data.dispatchMode === 'prompt' && owner && tracksPrompt) {
          this.confirmPendingCommand(owner);
          this.activatePrompt(owner);
          this.setPromptFeedback(owner, commandStatusFeedback('handed_to_pi'));
        }
        break;
      case 'assistant.run.processing':
        applyTrace();
        if (!owner || !tracksPrompt) break;
        this.confirmPendingCommand(owner);
        this.activatePrompt(owner);
        this.clearRunningCommandDraft(owner);
        this.setPromptFeedback(owner, PROCESSING_FEEDBACK);
        // prompt HTTP 可以继续等待 settled；run.started 已证明 handoff，允许用户显式 steer/followUp。
        if (sameCommand(this.submissionCommand, owner)) {
          this.submissionCommand = null;
          this.update({ submitting: false });
        }
        break;
      case 'assistant.tool.started':
      case 'assistant.tool.updated':
      case 'assistant.tool.ended': {
        this.updateHistory((history) => ({ ...history, toolExecutions: applyToolExecutionEvent(history.toolExecutions, event) }));
        // 固定记录工具开始的位置；结束时更新的摘要水位不能代替实际执行顺序。
        if (event.type === 'assistant.tool.started') applyTrace();
        // 未获授权的调用没有执行，结束事件不是执行失败；授权结果已给出状态说明。
        const record = this.state.history.toolExecutions.find((item) => item.toolCallId === event.data.toolCallId);
        const notAuthorized = record?.authorization != null &&
          record.authorization.status !== 'pending' && record.authorization.status !== 'approved';
        const feedback = progressFeedback(event, notAuthorized);
        if (owner && ownsActivePrompt && feedback) this.setPromptFeedback(owner, feedback);
        break;
      }
      case 'assistant.authorization.requested':
      case 'assistant.authorization.resolved': {
        // 越界调用的工具记录随授权请求转为待授权，离开待授权后按结果继续或收尾。
        this.update({
          authorizations: applyAuthorizationEvent(this.state.authorizations, event),
          history: { ...this.state.history, toolExecutions: applyToolExecutionEvent(this.state.history.toolExecutions, event) },
        });
        // 待授权期间状态条由请求本身决定；离开待授权后说明本轮接下来怎样继续。
        const feedback = progressFeedback(event);
        if (owner && ownsActivePrompt && feedback) this.setPromptFeedback(owner, feedback);
        break;
      }
      case 'assistant.retry.started':
      case 'assistant.retry.ended':
      case 'assistant.compaction.started':
      case 'assistant.compaction.ended': {
        const feedback = progressFeedback(event);
        if (owner && ownsActivePrompt && feedback) this.setPromptFeedback(owner, feedback);
        break;
      }
      case 'assistant.run.succeeded':
      case 'assistant.run.failed':
      case 'assistant.run.cancelled':
        applyTrace();
        if (owner && tracksPrompt) this.endPrompt(owner, runEndFeedback(event, this.authorizationExpired(owner)));
        if (owner && this.isCurrentPending(owner)) void this.settlePendingCommandFromTerminalEvent(owner, lifecycle);
        void this.refreshLatestMessages(lifecycle);
        break;
      case 'assistant.message.changed':
        applyTrace();
        if (event.data.role !== 'tool') void this.refreshLatestMessages(lifecycle);
        break;
      case 'assistant.command.rejected':
        if (owner && this.isCurrentPending(owner)) this.update({ sendError: event.data.error.message });
        break;
      case 'assistant.command.reconciled':
        applyTrace();
        if (event.data.error?.code === 'COMMAND_INTERRUPTED') void this.refreshLatestMessages(lifecycle);
        if (owner && this.isCurrentPending(owner) && event.data.terminalOutcome === 'failed' && event.data.error) {
          this.update({ sendError: event.data.error.message });
        }
        if (owner && ownsActivePrompt && ownsLatestPrompt && event.data.status === 'terminal' && event.data.terminalOutcome !== 'accepted') {
          this.endPrompt(owner, reconciledFeedback(event, this.authorizationExpired(owner)));
        }
        break;
      default:
        break;
    }
  }

  // ── 发送、取消与授权 ────────────────────────────────────────────

  async submitDraft(hooks: SubmitHooks = {}, recovery?: FailedSubmission, resendUnknown = false): Promise<void> {
    const lifecycle = this.lifecycle;
    const page = this.saver.page;
    const active = this.state.activePrompt;
    const executors = this.state.history.executors;
    const reusable = this.state.pendingCommand;
    const frozen = resendUnknown ? reusable : recovery;
    const text = frozen?.text ?? page.draft;
    const quote = frozen ? frozen.quote : page.quote;
    const agentId = frozen ? frozen.agentId : active ? executors[active.commandId]?.agentId : page.agentId ?? undefined;
    const contextRefs = [...(frozen?.contextRefs ?? hooks.contextRefs ?? [])];
    const running = active !== null;
    const currentBehaviorSelection = this.state.streamingBehaviorSelection;
    const ownedBehaviorSelection = running && currentBehaviorSelection && sameCommand(currentBehaviorSelection, active)
      ? currentBehaviorSelection
      : null;
    // 结果未知时只核对原命令，不借重试按钮重发副作用或换用新的输入。
    if (reusable?.unknown && reusable.agentId) { await this.reconcilePendingCommand(reusable, lifecycle); return; }
    const imageIds = resendUnknown ? reusable?.imageIds ?? [] : recovery ? recovery.imageIds ?? [] : this.imageDraft.ids();
    // 引用与上下文都是命令指纹的一部分；任一变化就不再是同一条命令，必须新建 commandId。
    const retryingUnknown = Boolean(
      reusable?.unknown && reusable.text === text && reusable.agentId === agentId &&
      JSON.stringify(reusable.imageIds ?? []) === JSON.stringify(imageIds) && sameQuote(reusable.quote, quote) &&
      sameContextRefs(reusable.contextRefs, contextRefs) && (reusable.streamingBehavior === null || running),
    );
    if (
      (!agentId && !(active && executors[active.commandId]) && !this.model.available) || this.model.busy || this.state.submitting ||
      (!text.trim() && !imageIds.length) || !this.imageDraft.ready ||
      (reusable?.clearOnSubmit && !retryingUnknown) ||
      draftSizeBytes(text) > ASSISTANT_DRAFT_MAX_UTF8_BYTES ||
      (running && !ownedBehaviorSelection && !retryingUnknown)
    ) return;

    hooks.onStart?.();
    this.update({ submitting: true, sendError: '' });
    const submittedBehaviorSelection = retryingUnknown ? null : ownedBehaviorSelection;
    const submitted: PendingCommand = retryingUnknown
      ? { ...reusable!, draftVersion: resendUnknown ? reusable!.draftVersion : this.saver.draftVersion, unknown: false }
      : {
          commandId: this.createCommandId(),
          generation: this.nextCommandGeneration(),
          text,
          imageIds,
          ...(agentId ? { agentId } : {}),
          quote,
          contextRefs,
          draftVersion: recovery ? recovery.restoredDraftVersion ?? -1 : this.saver.draftVersion,
          cleared: false,
          unknown: false,
          streamingBehavior: ownedBehaviorSelection?.behavior ?? null,
          clearOnSubmit: hooks.clearOnSubmit ?? false,
          omitQuote: hooks.omitQuote ?? false,
          readingQuote: recovery ? recovery.readingQuote : this.state.readingQuote,
          confirmed: false,
          echoCreatedAt: this.now(),
          echoBaseline: echoOccurrences(this.state.history.messages, { text, quote, contextRefs, omitQuote: hooks.omitQuote ?? false }),
        };
    this.rememberCommand(submitted);
    this.update({
      localEcho: {
        commandId: submitted.commandId,
        generation: submitted.generation,
        text: submitted.text,
        imageIds: submitted.imageIds ?? [],
        quote: submitted.quote,
        contextRefs: submitted.contextRefs,
        omitQuote: submitted.omitQuote ?? false,
        createdAt: submitted.echoCreatedAt ?? this.now(),
        baseline: submitted.echoBaseline ?? echoOccurrences(this.state.history.messages, submitted),
      },
      // 提交即刻清空上一命令的工具执行记录，避免跨 Turn 混入当前运行。
      history: { ...this.state.history, toolExecutions: withoutCommand(this.state.history.toolExecutions, submitted.commandId) },
    });
    if (submitted.streamingBehavior === null) {
      this.latestPrompt = submitted;
      this.setPromptFeedback(submitted, SENDING_FEEDBACK);
    }
    this.setPendingCommand(submitted);
    this.submissionCommand = submitted;
    if (submitted.clearOnSubmit) {
      this.clearRunningCommandDraft(submitted, true);
      this.updateFailedSubmissions((current) => current.filter((item) =>
        item.commandId !== recovery?.commandId && !(item.restoredDraftVersion === submitted.draftVersion &&
          item.text === submitted.text && sameQuote(item.quote, submitted.quote) &&
          JSON.stringify(item.readingQuote) === JSON.stringify(submitted.readingQuote))));
    }

    try {
      const receipt = await this.api.send({
        commandId: submitted.commandId,
        assistantSessionId: this.sessionId,
        text: submitted.text,
        ...(submitted.agentId ? { agentId: submitted.agentId } : {}),
        imageIds: submitted.imageIds ?? [],
        contextRefs: submitted.contextRefs,
        ...(hooks.view ? { view: hooks.view } : {}),
        ...(submitted.quote && !submitted.omitQuote ? { quote: submitted.quote } : {}),
        ...(submitted.streamingBehavior ? { streamingBehavior: submitted.streamingBehavior } : {}),
      });
      if (!this.isActive(lifecycle)) return;
      const terminal = await this.applyCommandReceipt(receipt, submitted);
      if (!terminal) await this.reconcilePendingCommand(submitted, lifecycle);
      if (submittedBehaviorSelection) this.clearStreamingBehaviorSelection(submittedBehaviorSelection);
    } catch (error) {
      if (!this.isActive(lifecycle)) return;
      if (error instanceof AssistantApiError && error.status >= 400 && error.status < 500) {
        hooks.onRejected?.();
        if (submitted.streamingBehavior === null) {
          this.clearActivePrompt(submitted);
          this.setPromptFeedback(submitted, failedFeedback());
        }
        if (this.isCurrentPending(submitted)) {
          this.clearLocalEcho(submitted);
          this.rejectSubmission(submitted, readErrorMessage(error));
          this.setPendingCommand(null);
          this.update({ sendError: readErrorMessage(error) });
        }
      } else if (this.isCurrentPending(submitted)) {
        const unknownCommand = { ...this.state.pendingCommand!, unknown: true };
        this.setPendingCommand(unknownCommand);
        await this.reconcilePendingCommand(unknownCommand, lifecycle);
      }
    } finally {
      if (this.isActive(lifecycle) && sameCommand(this.submissionCommand, submitted)) {
        this.submissionCommand = null;
        this.update({ submitting: false });
      }
    }
  }

  restoreFailedSubmission(commandId: string): boolean {
    const failed = this.state.failedSubmissions.find((item) => item.commandId === commandId);
    const page = this.saver.page;
    if (!failed || page.draft !== '' || (page.agentId && page.agentId !== failed.agentId) || page.quote !== null || this.state.readingQuote !== null) return false;
    this.updateReadingQuote(failed.readingQuote);
    this.markLocalChange({ ...page, draft: failed.text, agentId: failed.agentId ?? null, quote: failed.quote }, 'draft-intent');
    const version = this.saver.draftVersion;
    void this.imageDraft.restore(failed.imageIds ?? [], () => version === this.saver.draftVersion);
    this.updateFailedSubmissions((current) => current.map((item) => item.commandId === commandId ? { ...item, restoredDraftVersion: this.saver.draftVersion } : item));
    return true;
  }

  async retryFailedSubmission(commandId: string): Promise<void> {
    const failed = this.state.failedSubmissions.find((item) => item.commandId === commandId);
    if (failed && !this.state.pendingCommand && !this.state.activePrompt) {
      await this.submitDraft({ clearOnSubmit: true, omitQuote: failed.omitQuote ?? false }, failed);
    }
  }

  async retryUnknownSubmission(): Promise<void> {
    const pending = this.state.pendingCommand;
    if (pending?.unknown && pending.agentId) await this.reconcilePendingCommand(pending, this.lifecycle);
    else if (pending?.unknown && pending.clearOnSubmit) await this.submitDraft({ clearOnSubmit: true, omitQuote: pending.omitQuote ?? false }, undefined, true);
  }

  async checkPendingSubmission(): Promise<void> {
    const pending = this.state.pendingCommand;
    if (pending) await this.reconcilePendingCommand(pending, this.lifecycle);
  }

  dismissFailedSubmission(commandId: string): void {
    this.updateFailedSubmissions((current) => current.filter((item) => item.commandId !== commandId));
  }

  async cancelCurrentRun(): Promise<void> {
    const owner = this.state.activePrompt;
    if (!owner || this.state.cancelling) return;
    this.cancellingPrompt = owner;
    this.update({ cancelling: true, sendError: '' });
    try {
      await this.api.cancel({ commandId: this.createCommandId(), assistantSessionId: this.sessionId });
    } catch (error) {
      if (sameCommand(this.cancellingPrompt, owner)) {
        this.clearCancellation(owner);
        if (sameCommand(this.state.activePrompt, owner)) this.update({ sendError: readErrorMessage(error) });
      }
    }
  }

  /** 对待授权请求作出决定（仅这一次 / 拒绝）；结果以服务端返回的请求为准。 */
  async decideAuthorization(requestId: string, decision: ToolAuthorizationDecision): Promise<void> {
    if (this.deciding.has(requestId)) return;
    const lifecycle = this.lifecycle;
    this.deciding.add(requestId);
    this.update({ authorizationDecisions: { ...this.state.authorizationDecisions, [requestId]: { submitting: decision, error: '' } } });
    let error = '';
    try {
      const { request } = await this.api.decideAuthorization(this.sessionId, requestId, decision);
      if (!this.isActive(lifecycle)) return;
      this.update({ authorizations: upsertAuthorization(this.state.authorizations, request) });
    } catch (decisionError) {
      if (!this.isActive(lifecycle)) return;
      const failure = authorizationDecisionError(decisionError);
      error = failure.message;
      // 请求已被另一处决定或已离开待授权：按服务端记录刷新卡片，不执行任何操作。
      if (failure.refresh) {
        try {
          const latest = await this.api.listAuthorizations(this.sessionId);
          if (this.isActive(lifecycle)) this.update({ authorizations: mergeAuthorizations(this.state.authorizations, latest.requests) });
        } catch {
          // 事件流仍会带来最终状态；这里只是尽快对齐。
        }
      }
    } finally {
      this.deciding.delete(requestId);
      if (this.isActive(lifecycle)) {
        this.update({ authorizationDecisions: { ...this.state.authorizationDecisions, [requestId]: { submitting: null, error } } });
      }
    }
  }
}

/** 状态条显示的反馈：存在待授权请求时只说明在等授权。 */
export function displayedRunFeedback(state: Pick<SessionState, 'authorizations' | 'runFeedback'>): RunFeedback {
  return pendingAuthorizations(state.authorizations).length > 0 ? AWAITING_AUTHORIZATION_FEEDBACK : state.runFeedback;
}

export type { RunTrace, ToolExecution };

function sameContextRefs(left: readonly AssistantContextRef[], right: readonly AssistantContextRef[]): boolean {
  return left.length === right.length && left.every((ref, index) => sameContextRef(ref, right[index]));
}

function sameContextRef(left: AssistantContextRef, right: AssistantContextRef | undefined): boolean {
  if (left.kind === 'book') return right?.kind === 'book' && JSON.stringify(left) === JSON.stringify(right);
  if (left.kind === 'note') return right?.kind === 'note' && right.snapshotId === left.snapshotId;
  if (left.kind === 'project') return right?.kind === 'project' && right.projectId === left.projectId;
  if (left.kind === 'task') return right?.kind === 'task' && right.taskId === left.taskId;
  return right?.kind === 'workspace-session' && right.sessionId === left.sessionId;
}
