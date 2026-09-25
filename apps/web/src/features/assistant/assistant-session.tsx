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
  ASSISTANT_DRAFT_MAX_UTF8_BYTES,
  AssistantContextRefSchema,
  AssistantQuoteSchema,
  GLOBAL_ASSISTANT_SESSION_ID,
  type AssistantCommandReceipt,
  type AssistantContextRef,
  type AssistantCommandAnchor,
  type AssistantMessageView,
  type AssistantPageState,
  type AssistantPublicEvent,
  type AssistantQuote,
  type AssistantSessionPageResponse,
  type AssistantStreamingBehavior,
} from '@multivac/contracts';
import { Check } from 'typebox/value';
import { Type } from 'typebox';
import {
  AssistantApiError,
  cancelAssistantTurn,
  getAssistantCommand,
  getAssistantPageState,
  getAssistantSessionPage,
  putAssistantPageState,
  sendAssistantMessage,
  subscribeAssistantEvents,
} from '../../data/assistant-api.js';
import {
  admitStreamingSnapshot, appendStreamingDelta, loadStreamingHistory, reconcileStreamingMessages,
  type StreamingHistorySnapshot, type VisibleAssistantMessage,
} from './streaming-messages';
import { sameQuote } from './message-quote';
import {
  useSessionModelController,
  type SessionModel,
  type SessionModelState,
} from './session-model.js';
import {
  applyToolExecutionEvent,
  applyRunTraceEvent,
  groupAssistantTimeline,
  hydrateRunTraces,
  hydrateToolExecutions,
  mergeAssistantTimeline,
  withoutCommand,
  type AssistantGroupedTimelineItem,
  type RunTrace,
  type RunTraceRecords,
  type ToolExecution,
  type ToolExecutionRecords,
} from './tool-executions';

const INITIAL_PAGE_STATE: AssistantPageState = {
  draft: '',
  anchorEntryId: null,
  anchorOffsetPx: 0,
  quote: null,
  revision: 0,
};

const SAVE_DELAY_MS = 450;
const COMMAND_RECONCILIATION_TIMEOUT_MS = 12_000;
const COMMAND_RECONCILIATION_DELAYS_MS = [100, 200, 400, 800, 1_000] as const;
const EVENT_RECOVERY_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000] as const;
const ContextRefsSchema = Type.Array(AssistantContextRefSchema, { maxItems: 1 });

/** 浏览器内的挂起命令、命令代数与草稿版本按会话分键保存。 */
interface SessionStorageKeys {
  pendingCommand: string;
  activePrompt: string;
  commandGeneration: string;
  draftVersion: string;
}

function sessionStorageKeys(sessionId: string): SessionStorageKeys {
  // 全局会话沿用原有键名，已有的浏览器现场无需迁移；其他会话在键名后追加会话 id。
  const suffix = sessionId === GLOBAL_ASSISTANT_SESSION_ID ? '' : `:${sessionId}`;
  return {
    pendingCommand: `multivac.assistant.pending-command${suffix}`,
    activePrompt: `multivac.assistant.active-prompt-command${suffix}`,
    commandGeneration: `multivac.assistant.command-generation${suffix}`,
    draftVersion: `multivac.assistant.draft-version${suffix}`,
  };
}
const textEncoder = new TextEncoder();

export type SavePhase = 'saved' | 'pending' | 'saving' | 'error';
type LocalChangeKind = 'draft-intent' | 'command-settlement' | 'view-anchor';

export interface SaveFeedback {
  phase: SavePhase;
  message: string;
}

export type RunPhase = 'idle' | 'reconciling' | 'accepted' | 'handed' |
  'processing' | 'tool' | 'retry' | 'compaction' |
  'succeeded' | 'failed' | 'cancelled' | 'unknown';

export interface RunFeedback {
  phase: RunPhase;
  message: string;
}

interface CommandIdentity {
  commandId: string;
  generation: number;
}

interface StreamingBehaviorSelection extends CommandIdentity {
  behavior: AssistantStreamingBehavior;
  selectionGeneration: number;
}

interface PendingCommand extends CommandIdentity {
  text: string;
  quote: AssistantQuote | null;
  /** 发送时附带的上下文引用，属于命令指纹；按原命令重试时必须原样带上。 */
  contextRefs: AssistantContextRef[];
  draftVersion: number;
  cleared: boolean;
  unknown: boolean;
  streamingBehavior: AssistantStreamingBehavior | null;
}

interface LegacyPendingCommand extends CommandIdentity {
  text: string | null;
  quote: AssistantQuote | null;
  contextRefs: AssistantContextRef[];
  draftVersion: number | null;
  cleared: boolean;
  unknown: boolean;
  streamingBehavior: AssistantStreamingBehavior | null;
}

type StoredPendingCommand = PendingCommand | LegacyPendingCommand;

type ActivePrompt = CommandIdentity;

function isCommandId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/u.test(value);
}

function isGeneration(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function sameCommand(left: CommandIdentity | null, right: CommandIdentity): boolean {
  return left?.commandId === right.commandId && left.generation === right.generation;
}

function sameStreamingBehaviorSelection(
  left: StreamingBehaviorSelection | null,
  right: StreamingBehaviorSelection,
): boolean {
  return sameCommand(left, right) && left?.selectionGeneration === right.selectionGeneration;
}

function isPendingCommand(command: StoredPendingCommand | null): command is PendingCommand {
  return command !== null && command.text !== null && command.draftVersion !== null;
}

function readPendingCommand(keys: SessionStorageKeys): StoredPendingCommand | null {
  const stored = sessionStorage.getItem(keys.pendingCommand);
  if (!stored) return null;

  try {
    const value = JSON.parse(stored) as unknown;
    if (isCommandId(value)) {
      return {
        commandId: value,
        generation: 0,
        text: null,
        quote: null,
        contextRefs: [],
        draftVersion: null,
        cleared: false,
        unknown: false,
        streamingBehavior: null,
      };
    }
    if (
      typeof value !== 'object' || value === null ||
      !('commandId' in value) || !isCommandId(value.commandId) ||
      ('text' in value && typeof value.text !== 'string') ||
      ('draftVersion' in value && !Number.isSafeInteger(value.draftVersion)) ||
      ('cleared' in value && typeof value.cleared !== 'boolean') ||
      ('unknown' in value && typeof value.unknown !== 'boolean') ||
      ('generation' in value && !isGeneration(value.generation)) ||
      ('streamingBehavior' in value &&
        value.streamingBehavior !== null &&
        value.streamingBehavior !== 'steer' &&
        value.streamingBehavior !== 'followUp')
    ) return null;
    return {
      commandId: value.commandId,
      generation: 'generation' in value ? value.generation as number : 0,
      text: 'text' in value ? value.text as string : null,
      // 本地存储可能来自更早版本或被改写；引用必须重新按契约校验后才可复用。
      quote: 'quote' in value && Check(AssistantQuoteSchema, value.quote)
        ? value.quote as AssistantQuote
        : null,
      // 旧版本没有该字段即为不带上下文；内容同样按契约重新校验。
      contextRefs: 'contextRefs' in value && Check(ContextRefsSchema, value.contextRefs)
        ? value.contextRefs as AssistantContextRef[]
        : [],
      draftVersion: 'draftVersion' in value ? value.draftVersion as number : null,
      cleared: 'cleared' in value ? value.cleared as boolean : false,
      unknown: 'unknown' in value ? value.unknown as boolean : false,
      streamingBehavior: 'streamingBehavior' in value
        ? value.streamingBehavior as AssistantStreamingBehavior | null
        : null,
    } as StoredPendingCommand;
  } catch {
    return isCommandId(stored)
      ? {
          commandId: stored,
          generation: 0,
          text: null,
          quote: null,
          contextRefs: [],
          draftVersion: null,
          cleared: false,
          unknown: false,
          streamingBehavior: null,
        }
      : null;
  }
}

function writePendingCommand(keys: SessionStorageKeys, command: PendingCommand | null): void {
  if (command) sessionStorage.setItem(keys.pendingCommand, JSON.stringify(command));
  else sessionStorage.removeItem(keys.pendingCommand);
}

function readActivePrompt(keys: SessionStorageKeys): ActivePrompt | null {
  const value = sessionStorage.getItem(keys.activePrompt);
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      typeof parsed === 'object' && parsed !== null &&
      'commandId' in parsed && isCommandId(parsed.commandId) &&
      'generation' in parsed && isGeneration(parsed.generation)
    ) {
      return { commandId: parsed.commandId, generation: parsed.generation };
    }
  } catch {
    // 兼容 CR1 已写入的裸 commandId；下一次更新会迁移为带 generation 的结构。
  }
  return isCommandId(value) ? { commandId: value, generation: 0 } : null;
}

function writeActivePrompt(keys: SessionStorageKeys, prompt: ActivePrompt | null): void {
  if (prompt) sessionStorage.setItem(keys.activePrompt, JSON.stringify(prompt));
  else sessionStorage.removeItem(keys.activePrompt);
}

function readCommandGeneration(keys: SessionStorageKeys): number {
  const value = Number(sessionStorage.getItem(keys.commandGeneration) ?? '0');
  return isGeneration(value) ? value : 0;
}

function writeCommandGeneration(keys: SessionStorageKeys, generation: number): void {
  sessionStorage.setItem(keys.commandGeneration, String(generation));
}

function readDraftVersion(keys: SessionStorageKeys): number {
  const value = Number(sessionStorage.getItem(keys.draftVersion) ?? '0');
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function writeDraftVersion(keys: SessionStorageKeys, version: number): void {
  sessionStorage.setItem(keys.draftVersion, String(version));
}

function mergeMessages(
  earlier: readonly AssistantMessageView[],
  current: readonly AssistantMessageView[],
): AssistantMessageView[] {
  const seen = new Set<string>();
  return [...earlier, ...current].filter((message) => {
    if (seen.has(message.id)) return false;
    seen.add(message.id);
    return true;
  });
}

function sameContent(left: AssistantPageState, right: AssistantPageState): boolean {
  return left.draft === right.draft &&
    left.anchorEntryId === right.anchorEntryId &&
    left.anchorOffsetPx === right.anchorOffsetPx &&
    sameQuote(left.quote, right.quote);
}

/** 命令结算后用于自动重试保存冲突的提交快照：正文与引用必须同时匹配才可覆盖远端。 */
interface SubmittedPageContent {
  draft: string;
  quote: AssistantQuote | null;
}

/**
 * 刚发出、尚未回读到 Pi 历史的消息，用于本地回显。
 *
 * 它只是渲染层的临时行：没有 Pi entry，因此不作阅读锚点、不可被引用，
 * 也不会进入消息状态或流式对账。
 */
interface LocalEcho extends CommandIdentity {
  text: string;
  quote: AssistantQuote | null;
  createdAt: string;
  /** 提交时历史中已有的同内容消息条数；超过它即说明本次消息已经回读到。 */
  baseline: number;
}

function echoOccurrences(
  messages: readonly VisibleAssistantMessage[],
  echo: Pick<LocalEcho, 'text' | 'quote'>,
): number {
  return messages.filter((message) => message.role === 'user' &&
    message.streamCursor === undefined && message.text === echo.text &&
    sameQuote(message.quote ?? null, echo.quote)).length;
}

export function draftSizeBytes(draft: string): number {
  return textEncoder.encode(draft).byteLength;
}

async function loadInitialWindow(
  sessionId: string,
  pageState: AssistantPageState,
  initialPage: AssistantSessionPageResponse,
  isCurrent: () => boolean,
): Promise<AssistantSessionPageResponse | null> {
  let page = initialPage;
  if (!pageState.anchorEntryId) return page;

  let messages = page.messages;
  let attempts = 0;
  while (
    isCurrent() &&
    !messages.some((message) => message.piEntryId === pageState.anchorEntryId) &&
    page.hasMore &&
    page.nextBefore &&
    attempts < 10
  ) {
    const earlier = await getAssistantSessionPage(sessionId, page.nextBefore);
    messages = mergeMessages(earlier.messages, messages);
    page = { ...page, messages, hasMore: earlier.hasMore, nextBefore: earlier.nextBefore };
    attempts += 1;
  }
  return isCurrent() ? page : null;
}

export function errorMessage(error: unknown): string {
  if (error instanceof AssistantApiError) return error.message;
  return '无法读取 Multivac 会话，请稍后重试。';
}

function saveErrorMessage(error: unknown): string {
  if (error instanceof AssistantApiError) {
    if (error.code === 'BODY_TOO_LARGE') {
      return '草稿超过可保存的大小限制，请缩短后重试。';
    }
    return `草稿保存失败：${error.message}`;
  }
  return '草稿保存失败：网络连接不可用，请重试。';
}

/** 提交过程中交给呈现实例的回调：只有真正发出命令时才调用，呈现实例据此处理滚动跟随。 */
export interface SubmitHooks {
  onStart?: () => void;
  onRejected?: () => void;
  /** 本次发送附带的上下文引用（工作区侧栏的当前焦点会话）。 */
  contextRefs?: readonly AssistantContextRef[];
}

function sameContextRefs(left: readonly AssistantContextRef[], right: readonly AssistantContextRef[]): boolean {
  return left.length === right.length &&
    left.every((ref, index) => ref.kind === right[index]?.kind && ref.sessionId === right[index]?.sessionId);
}

/**
 * 会话控制器对外暴露的状态与操作。
 *
 * 事件订阅、命令对账、页面现场保存与运行状态在应用中只有一份；
 * 首页与侧栏等呈现实例都通过它读写同一会话。
 */
export interface AssistantSession {
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
  setQuote(quote: AssistantQuote): void;
  removeQuote(): void;
  /** 记录阅读锚点；只应由首页呈现实例调用。 */
  setReadingAnchor(entryId: string | null, offsetPx: number): void;
  retrySave(): void;

  model: SessionModelState;
  runFeedback: RunFeedback;
  runFeedbackCommandId: string | null;
  runActive: boolean;
  runBusy: boolean;
  submitting: boolean;
  cancelling: boolean;
  sendError: string;
  streamingBehavior: AssistantStreamingBehavior | '';
  canSubmit: boolean;
  canRetryUnknown: boolean;
  selectStreamingBehavior(behavior: AssistantStreamingBehavior): void;
  submitDraft(hooks?: SubmitHooks): Promise<void>;
  cancelCurrentRun(): Promise<void>;
}

/**
 * 单个会话的控制器。sessionId 在宿主生命周期内不变（宿主以会话 id 作为 key），
 * 因此回调依赖中不重复声明它。
 */
function useAssistantSessionController(sessionId: string, modelState: SessionModelState): AssistantSession {
  const storageKeysRef = useRef(sessionStorageKeys(sessionId));
  const storageKeys = storageKeysRef.current;
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [initialError, setInitialError] = useState('');
  const [historyError, setHistoryError] = useState('');
  const [messages, setMessages] = useState<VisibleAssistantMessage[]>([]);
  const messagesRef = useRef<readonly VisibleAssistantMessage[]>([]);
  const [toolExecutions, setToolExecutions] = useState<ToolExecution[]>([]);
  const toolExecutionsRef = useRef<ToolExecutionRecords>([]);
  const [runTraces, setRunTraces] = useState<RunTrace[]>([]);
  const runTracesRef = useRef<RunTraceRecords>([]);
  // 命令锚点来自会话快照，用于把工具记录放回所属 Turn。
  const [commandAnchors, setCommandAnchors] = useState<AssistantCommandAnchor[]>([]);
  const updateToolExecutions = useCallback(
    (update: (current: ToolExecutionRecords) => ToolExecution[]) => {
      const next = update(toolExecutionsRef.current);
      toolExecutionsRef.current = next;
      setToolExecutions(next);
    },
    [],
  );
  const updateRunTraces = useCallback((update: (current: RunTraceRecords) => RunTrace[]) => {
    const next = update(runTracesRef.current);
    runTracesRef.current = next;
    setRunTraces(next);
  }, []);
  const paginationRef = useRef({ hasMore: false, nextBefore: null as string | null });
  const updateMessages = useCallback((update: (current: readonly VisibleAssistantMessage[]) => VisibleAssistantMessage[]) => {
    const next = update(messagesRef.current);
    messagesRef.current = next;
    setMessages(next);
  }, []);
  const [hasMore, setHasMore] = useState(false);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [pageState, setPageState] = useState(INITIAL_PAGE_STATE);
  const [saveFeedback, setSaveFeedback] = useState<SaveFeedback>({
    phase: 'saved',
    message: '草稿已保存',
  });
  const [eventCursor, setEventCursor] = useState('0');
  const [eventSubscriptionGeneration, setEventSubscriptionGeneration] = useState(0);
  const [runFeedback, setRunFeedback] = useState<RunFeedback>({ phase: 'idle', message: '' });
  const [activePrompt, setActivePrompt] = useState<ActivePrompt | null>(readActivePrompt(storageKeys));
  const [streamingBehaviorSelection, setStreamingBehaviorSelection] =
    useState<StreamingBehaviorSelection | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [reconcilingCommandId, setReconcilingCommandId] = useState<string | null>(null);
  const [sendError, setSendError] = useState('');
  const [localEcho, setLocalEcho] = useState<LocalEcho | null>(null);
  const [renderedHistoryGeneration, setRenderedHistoryGeneration] = useState<number | null>(null);
  const [loadGeneration, setLoadGeneration] = useState(0);
  const saveTimerRef = useRef<number | undefined>(undefined);
  const pageStateRef = useRef<AssistantPageState>(INITIAL_PAGE_STATE);
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const mountedRef = useRef(false);
  const lifecycleGenerationRef = useRef(0);
  const loadGenerationRef = useRef(0);
  const historyGenerationRef = useRef(0);
  const initializedRef = useRef(false);
  const dirtyRef = useRef(false);
  // 页面现场版本用于保存队列；草稿版本只随正文变化，滚动不能阻止成功命令清稿。
  const localVersionRef = useRef(readDraftVersion(storageKeys));
  const draftVersionRef = useRef(localVersionRef.current);
  const needsRevisionRefreshRef = useRef(false);
  // 冲突补读只同步 revision，不授权后台保存覆盖远端；需等待用户重试或实际修改草稿。
  const conflictBlockedRef = useRef(false);
  const exitFlushVersionRef = useRef(-1);
  const loadingEarlierRef = useRef(false);
  const lastEventCursorRef = useRef(0);
  const historySnapshotCursorRef = useRef(0);
  const storedPendingCommandRef = useRef<StoredPendingCommand | null>(readPendingCommand(storageKeys));
  const pendingCommandRef = useRef<PendingCommand | null>(
    isPendingCommand(storedPendingCommandRef.current) ? storedPendingCommandRef.current : null,
  );
  const legacyPendingCommandRef = useRef<LegacyPendingCommand | null>(
    storedPendingCommandRef.current && !isPendingCommand(storedPendingCommandRef.current)
      ? storedPendingCommandRef.current
      : null,
  );
  const activePromptRef = useRef<ActivePrompt | null>(activePrompt);
  const commandGenerationRef = useRef(Math.max(
    readCommandGeneration(storageKeys),
    legacyPendingCommandRef.current?.generation ?? 0,
    pendingCommandRef.current?.generation ?? 0,
    activePrompt?.generation ?? 0,
  ));
  const commandGenerationsRef = useRef(new Map<string, number>());
  const streamingBehaviorSelectionRef = useRef<StreamingBehaviorSelection | null>(null);
  const streamingBehaviorSelectionGenerationRef = useRef(0);
  const latestPromptRef = useRef<CommandIdentity | null>(
    pendingCommandRef.current?.streamingBehavior === null && (
      !activePrompt || pendingCommandRef.current.generation >= activePrompt.generation
    )
      ? pendingCommandRef.current
      : activePrompt,
  );
  const runFeedbackOwnerRef = useRef<CommandIdentity | null>(null);
  const submittingRef = useRef(false);
  const submissionCommandRef = useRef<CommandIdentity | null>(null);
  const cancellingRef = useRef(false);
  const cancellingPromptRef = useRef<CommandIdentity | null>(null);
  const reconciliationCommandRef = useRef<CommandIdentity | null>(null);
  const eventRecoveryRef = useRef(false);
  const eventRecoveryTimerRef = useRef<number | undefined>(undefined);

  if (commandGenerationsRef.current.size === 0) {
    const pending = pendingCommandRef.current;
    if (pending) commandGenerationsRef.current.set(pending.commandId, pending.generation);
    if (activePrompt) {
      commandGenerationsRef.current.set(activePrompt.commandId, activePrompt.generation);
    }
  }

  const isActiveLifecycle = useCallback((lifecycle: number) =>
    mountedRef.current && lifecycleGenerationRef.current === lifecycle, []);

  const clearCancellation = useCallback((owner: CommandIdentity): void => {
    if (!sameCommand(cancellingPromptRef.current, owner)) return;
    cancellingPromptRef.current = null;
    cancellingRef.current = false;
    setCancelling(false);
  }, []);

  const clearStreamingBehaviorSelection = useCallback((
    selection: StreamingBehaviorSelection,
  ): void => {
    if (!sameStreamingBehaviorSelection(streamingBehaviorSelectionRef.current, selection)) return;
    streamingBehaviorSelectionRef.current = null;
    setStreamingBehaviorSelection(null);
  }, []);

  const selectStreamingBehavior = useCallback((behavior: AssistantStreamingBehavior): void => {
    const owner = activePromptRef.current;
    if (!owner) return;
    const selection: StreamingBehaviorSelection = {
      ...owner,
      behavior,
      selectionGeneration: ++streamingBehaviorSelectionGenerationRef.current,
    };
    streamingBehaviorSelectionRef.current = selection;
    setStreamingBehaviorSelection(selection);
  }, []);

  const activatePrompt = useCallback((owner: CommandIdentity): boolean => {
    if (!sameCommand(latestPromptRef.current, owner)) return false;
    const current = activePromptRef.current;
    if (current && !sameCommand(current, owner) && current.generation >= owner.generation) return false;
    activePromptRef.current = owner;
    writeActivePrompt(storageKeys, owner);
    setActivePrompt(owner);
    const behaviorSelection = streamingBehaviorSelectionRef.current;
    if (behaviorSelection && !sameCommand(behaviorSelection, owner)) {
      streamingBehaviorSelectionRef.current = null;
      setStreamingBehaviorSelection(null);
    }
    if (cancellingPromptRef.current && !sameCommand(cancellingPromptRef.current, owner)) {
      cancellingPromptRef.current = null;
      cancellingRef.current = false;
      setCancelling(false);
    }
    return true;
  }, []);

  const clearActivePrompt = useCallback((owner: CommandIdentity): boolean => {
    if (!sameCommand(activePromptRef.current, owner)) return false;
    activePromptRef.current = null;
    writeActivePrompt(storageKeys, null);
    setActivePrompt(null);
    return true;
  }, []);

  const setPromptFeedback = useCallback((
    owner: CommandIdentity,
    feedback: RunFeedback,
  ): boolean => {
    if (!sameCommand(latestPromptRef.current, owner)) return false;
    runFeedbackOwnerRef.current = owner;
    setRunFeedback(feedback);
    return true;
  }, []);

  const updateRevision = useCallback((revision: number, lifecycle: number): void => {
    // 持久化队列在组件卸载后仍需推进 revision，React 状态则只更新当前生命周期。
    const next = { ...pageStateRef.current, revision };
    pageStateRef.current = next;
    if (isActiveLifecycle(lifecycle)) setPageState(next);
  }, [isActiveLifecycle]);

  const saveLatestState = useCallback(async (
    keepalive: boolean,
    lifecycle: number,
    conflictRetrySubmitted?: SubmittedPageContent,
  ): Promise<void> => {
    if (!initializedRef.current || !dirtyRef.current || conflictBlockedRef.current) return;

    if (draftSizeBytes(pageStateRef.current.draft) > ASSISTANT_DRAFT_MAX_UTF8_BYTES) {
      if (isActiveLifecycle(lifecycle)) {
        setSaveFeedback({
          phase: 'error',
          message: `草稿超过 ${ASSISTANT_DRAFT_MAX_UTF8_BYTES / 1024} KB 保存上限，正文已保留。`,
        });
      }
      return;
    }

    if (needsRevisionRefreshRef.current) {
      try {
        const remote = await getAssistantPageState(sessionId);
        updateRevision(remote.revision, lifecycle);
        needsRevisionRefreshRef.current = false;
      } catch (refreshError) {
        conflictBlockedRef.current = true;
        if (isActiveLifecycle(lifecycle)) {
          setSaveFeedback({
            phase: 'error',
            message: `草稿尚未保存，最新版本读取失败：${errorMessage(refreshError)}`,
          });
        }
        return;
      }
    }

    let canRetryConflict = conflictRetrySubmitted !== undefined;
    while (true) {
      const candidate = pageStateRef.current;
      const candidateVersion = localVersionRef.current;
      const candidateDraftVersion = draftVersionRef.current;
      if (isActiveLifecycle(lifecycle)) {
        setSaveFeedback({ phase: 'saving', message: '正在保存草稿' });
      }

      try {
        const saved = await putAssistantPageState(sessionId, candidate, keepalive);
        updateRevision(saved.revision, lifecycle);
        if (
          localVersionRef.current === candidateVersion &&
          sameContent(pageStateRef.current, candidate)
        ) {
          dirtyRef.current = false;
          needsRevisionRefreshRef.current = false;
          conflictBlockedRef.current = false;
          if (isActiveLifecycle(lifecycle)) {
            setSaveFeedback({ phase: 'saved', message: '草稿已保存' });
          }
        } else if (isActiveLifecycle(lifecycle)) {
          setSaveFeedback({ phase: 'pending', message: '草稿有尚未保存的更改' });
        }
        return;
      } catch (saveError) {
        if (saveError instanceof AssistantApiError && saveError.code === 'PAGE_STATE_CONFLICT') {
          conflictBlockedRef.current = true;
          try {
            const remote = await getAssistantPageState(sessionId);
            updateRevision(remote.revision, lifecycle);
            needsRevisionRefreshRef.current = false;
            // 自动结算只在远端仍为本次已提交正文时重试；远端已空则无需再次写入。
            if (
              canRetryConflict && candidate.draft === '' && candidate.quote === null &&
              remote.draft === conflictRetrySubmitted!.draft &&
              sameQuote(remote.quote, conflictRetrySubmitted!.quote) &&
              draftVersionRef.current === candidateDraftVersion &&
              pageStateRef.current.draft === '' && pageStateRef.current.quote === null
            ) {
              canRetryConflict = false;
              conflictBlockedRef.current = false;
              continue;
            }
            if (
              canRetryConflict && candidate.draft === '' && candidate.quote === null &&
              remote.draft === '' && remote.quote === null &&
              localVersionRef.current === candidateVersion &&
              sameContent(pageStateRef.current, { ...candidate, revision: remote.revision })
            ) {
              dirtyRef.current = false;
              needsRevisionRefreshRef.current = false;
              conflictBlockedRef.current = false;
              if (isActiveLifecycle(lifecycle)) {
                setSaveFeedback({ phase: 'saved', message: '草稿已保存' });
              }
              return;
            }
            // 补读期间发生的编辑也不能绕过“补读完成后等待用户处理”的冲突状态。
            conflictBlockedRef.current = true;
            if (isActiveLifecycle(lifecycle)) {
              setSaveFeedback({
                phase: 'error',
                message: '其他页面更新了保存版本；当前草稿已保留，请重试保存。',
              });
            }
          } catch (refreshError) {
            needsRevisionRefreshRef.current = true;
            conflictBlockedRef.current = true;
            if (isActiveLifecycle(lifecycle)) {
              setSaveFeedback({
                phase: 'error',
                message: `保存版本冲突，且最新版本读取失败：${errorMessage(refreshError)}`,
              });
            }
          }
          return;
        }

        if (isActiveLifecycle(lifecycle)) {
          setSaveFeedback({ phase: 'error', message: saveErrorMessage(saveError) });
        }
        return;
      }
    }
  }, [isActiveLifecycle, updateRevision]);

  const enqueueSave = useCallback((
    keepalive = false,
    userInitiated = false,
    conflictRetrySubmitted?: SubmittedPageContent,
  ) => {
    window.clearTimeout(saveTimerRef.current);
    if (userInitiated) conflictBlockedRef.current = false;
    const lifecycle = lifecycleGenerationRef.current;
    const task = saveChainRef.current
      .catch(() => {})
      .then(() => saveLatestState(keepalive, lifecycle, conflictRetrySubmitted));
    saveChainRef.current = task.catch(() => {
      if (isActiveLifecycle(lifecycle)) {
        setSaveFeedback({
          phase: 'error',
          message: '草稿保存失败，保存队列已恢复，请重试。',
        });
      }
    });
    return saveChainRef.current;
  }, [isActiveLifecycle, saveLatestState]);

  const scheduleSave = useCallback(() => {
    window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => void enqueueSave(), SAVE_DELAY_MS);
  }, [enqueueSave]);

  const markLocalChange = useCallback((next: AssistantPageState, kind: LocalChangeKind) => {
    pageStateRef.current = next;
    setPageState(next);
    dirtyRef.current = true;
    localVersionRef.current += 1;
    if (kind !== 'view-anchor') {
      draftVersionRef.current += 1;
      writeDraftVersion(storageKeys, draftVersionRef.current);
    }
    exitFlushVersionRef.current = -1;
    if (kind === 'draft-intent') conflictBlockedRef.current = false;

    // 阅读锚点仍保留在本地待恢复快照中，但不能代表用户决定覆盖冲突的远端草稿。
    if (conflictBlockedRef.current) return;

    if (draftSizeBytes(next.draft) > ASSISTANT_DRAFT_MAX_UTF8_BYTES) {
      window.clearTimeout(saveTimerRef.current);
      setSaveFeedback({
        phase: 'error',
        message: `草稿超过 ${ASSISTANT_DRAFT_MAX_UTF8_BYTES / 1024} KB 保存上限，正文已保留。`,
      });
      return;
    }

    setSaveFeedback({ phase: 'pending', message: '草稿有尚未保存的更改' });
    scheduleSave();
  }, [scheduleSave]);

  const load = useCallback(async (lifecycle: number) => {
    const generation = ++loadGenerationRef.current;
    historyGenerationRef.current += 1;
    initializedRef.current = false;
    loadingEarlierRef.current = false;
    setLoadGeneration(generation);
    setRenderedHistoryGeneration(null);
    setStatus('loading');
    setInitialError('');
    setHistoryError('');
    setLoadingEarlier(false);
    setSendError('');
    setLocalEcho(null);

    const isCurrent = () =>
      isActiveLifecycle(lifecycle) && loadGenerationRef.current === generation;

    try {
      const [state, latestPage] = await Promise.all([
        getAssistantPageState(sessionId),
        getAssistantSessionPage(sessionId),
      ]);
      const page = await loadInitialWindow(sessionId, state, latestPage, isCurrent);
      if (!page || !isCurrent()) return;

      const legacyPending = legacyPendingCommandRef.current;
      let pending = pendingCommandRef.current;
      let restoredState = state;
      let restoredPendingDraft = false;
      let legacyPendingError = '';
      if (legacyPending) {
        const recoveredText = legacyPending.text ?? (state.draft !== '' ? state.draft : null);
        if (recoveredText === null || (state.draft !== '' && state.draft !== recoveredText)) {
          legacyPendingCommandRef.current = null;
          storedPendingCommandRef.current = null;
          writePendingCommand(storageKeys, null);
          legacyPendingError = '旧命令缺少可恢复的正文，已清理待重试记录。';
        } else {
          pending = {
            ...legacyPending,
            text: recoveredText,
            draftVersion: draftVersionRef.current,
          };
          pendingCommandRef.current = pending;
          legacyPendingCommandRef.current = null;
          storedPendingCommandRef.current = pending;
          writePendingCommand(storageKeys, pending);
          commandGenerationsRef.current.set(pending.commandId, pending.generation);
          commandGenerationRef.current = Math.max(commandGenerationRef.current, pending.generation);
          writeCommandGeneration(storageKeys, commandGenerationRef.current);
          if (
            pending.streamingBehavior === null &&
            (!activePromptRef.current || pending.generation >= activePromptRef.current.generation)
          ) {
            latestPromptRef.current = pending;
          }
        }
      }
      if (pending) {
        draftVersionRef.current = Math.max(draftVersionRef.current, pending.draftVersion);
        localVersionRef.current = Math.max(localVersionRef.current, draftVersionRef.current);
        if (
          pending.cleared && sameCommand(latestPromptRef.current, pending) &&
          pending.text === state.draft && sameQuote(state.quote, pending.quote) &&
          draftVersionRef.current === pending.draftVersion
        ) {
          restoredState = { ...state, draft: '', quote: null };
          restoredPendingDraft = true;
        } else if (
          !pending.cleared && state.draft === '' && state.quote === null &&
          draftVersionRef.current === pending.draftVersion
        ) {
          restoredState = { ...state, draft: pending.text, quote: pending.quote };
          restoredPendingDraft = true;
        }
      } else {
        localVersionRef.current += 1;
        draftVersionRef.current += 1;
      }
      writeDraftVersion(storageKeys, draftVersionRef.current);
      pageStateRef.current = restoredState;
      dirtyRef.current = restoredPendingDraft;
      needsRevisionRefreshRef.current = false;
      conflictBlockedRef.current = false;
      exitFlushVersionRef.current = -1;
      initializedRef.current = true;
      setPageState(restoredState);
      updateMessages(() => reconcileStreamingMessages([], page));
      updateToolExecutions(() => hydrateToolExecutions([], page));
      updateRunTraces(() => hydrateRunTraces(page));
      setCommandAnchors(page.commandAnchors ?? []);
      historySnapshotCursorRef.current = Number(page.eventCursor);
      setHasMore(page.hasMore);
      setNextBefore(page.nextBefore);
      paginationRef.current = { hasMore: page.hasMore, nextBefore: page.nextBefore };
      lastEventCursorRef.current = Number(page.eventCursor);
      setEventCursor(page.eventCursor);
      setSaveFeedback(restoredPendingDraft
        ? { phase: 'pending', message: '草稿有尚未保存的更改' }
        : { phase: 'saved', message: '草稿已保存' });
      if (legacyPendingError) setSendError(legacyPendingError);
      setStatus('ready');
      if (restoredPendingDraft) scheduleSave();
    } catch (loadError) {
      if (!isCurrent()) return;
      setInitialError(errorMessage(loadError));
      setStatus('error');
    }
  }, [isActiveLifecycle, scheduleSave, updateMessages, updateRunTraces, updateToolExecutions]);

  const flushOnExit = useCallback(() => {
    window.clearTimeout(saveTimerRef.current);
    if (!initializedRef.current || !dirtyRef.current || conflictBlockedRef.current) return;
    const version = localVersionRef.current;
    if (exitFlushVersionRef.current === version) return;
    exitFlushVersionRef.current = version;
    // keepalive 仅作为同一保存队列中的退出任务，不能绕过在途 PUT。
    void enqueueSave(true);
  }, [enqueueSave]);

  useEffect(() => {
    const lifecycle = ++lifecycleGenerationRef.current;
    mountedRef.current = true;
    void load(lifecycle);

    return () => {
      flushOnExit();
      mountedRef.current = false;
      lifecycleGenerationRef.current += 1;
      loadGenerationRef.current += 1;
      historyGenerationRef.current += 1;
      window.clearTimeout(saveTimerRef.current);
      window.clearTimeout(eventRecoveryTimerRef.current);
    };
  }, [flushOnExit, load]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flushOnExit();
    };
    const onOnline = () => {
      if (!initializedRef.current || !dirtyRef.current || conflictBlockedRef.current) return;
      setSaveFeedback({ phase: 'pending', message: '网络已恢复，正在同步草稿' });
      void enqueueSave();
    };
    window.addEventListener('pagehide', flushOnExit);
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('pagehide', flushOnExit);
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [enqueueSave, flushOnExit]);

  const applyHistorySnapshot = useCallback((snapshot: StreamingHistorySnapshot): boolean => {
    const { page, discardedStreamIds } = snapshot;
    const admission = admitStreamingSnapshot(Number(page.eventCursor), historySnapshotCursorRef.current,
      lastEventCursorRef.current);
    if (!admission.admitted) return false;
    historySnapshotCursorRef.current = admission.historyCursor;
    const oldest = messagesRef.current.find((message) => message.streamCursor === undefined);
    // 期间手动加载了更早历史时，保留已扩展窗口的分页边界。
    if (!oldest || page.messages.some((message) => message.id === oldest.id)) {
      paginationRef.current = { hasMore: page.hasMore, nextBefore: page.nextBefore };
      setHasMore(page.hasMore);
      setNextBefore(page.nextBefore);
    }
    updateMessages((current) => reconcileStreamingMessages(current, page, discardedStreamIds));
    // 终态工具记录以服务端投影为准，同时保留已展开的明细。
    updateToolExecutions((current) => hydrateToolExecutions(current, page));
    updateRunTraces(() => hydrateRunTraces(page));
    setCommandAnchors(page.commandAnchors ?? []);
    return true;
  }, [updateMessages, updateRunTraces, updateToolExecutions]);

  const refreshLatestMessages = useCallback(async (
    lifecycle: number,
    attempt = 0,
  ): Promise<void> => {
    if (!isActiveLifecycle(lifecycle)) return;
    try {
      const latest = await getAssistantSessionPage(sessionId);
      if (!isActiveLifecycle(lifecycle)) return;
      if (Number(latest.eventCursor) < historySnapshotCursorRef.current) return;
      const snapshot = await loadStreamingHistory(messagesRef.current, latest,
        (before) => getAssistantSessionPage(sessionId, before), () => isActiveLifecycle(lifecycle));
      if (!isActiveLifecycle(lifecycle)) return;
      applyHistorySnapshot(snapshot);
    } catch {
      if (!isActiveLifecycle(lifecycle)) return;
      window.setTimeout(() => void refreshLatestMessages(lifecycle, attempt + 1),
        Math.min(250 * 2 ** Math.min(attempt, 4), 3_000));
    }
  }, [applyHistorySnapshot, isActiveLifecycle]);

  function rememberCommand(owner: CommandIdentity): void {
    commandGenerationsRef.current.set(owner.commandId, owner.generation);
    commandGenerationRef.current = Math.max(commandGenerationRef.current, owner.generation);
    writeCommandGeneration(storageKeys, commandGenerationRef.current);
  }

  function nextCommandGeneration(): number {
    commandGenerationRef.current += 1;
    writeCommandGeneration(storageKeys, commandGenerationRef.current);
    return commandGenerationRef.current;
  }

  function commandIdentity(commandId: string | null): CommandIdentity | null {
    if (!commandId) return null;
    const generation = commandGenerationsRef.current.get(commandId);
    return generation === undefined ? null : { commandId, generation };
  }

  function isCurrentPending(owner: CommandIdentity): boolean {
    return sameCommand(pendingCommandRef.current, owner);
  }

  function confirmPendingCommand(owner: CommandIdentity): void {
    const pending = pendingCommandRef.current;
    if (!pending || !sameCommand(pending, owner) || !pending.unknown) return;
    const confirmed: PendingCommand = { ...pending, unknown: false };
    pendingCommandRef.current = confirmed;
    writePendingCommand(storageKeys, confirmed);
  }

  function clearRunningCommandDraft(owner: CommandIdentity): void {
    const pending = pendingCommandRef.current;
    if (
      !pending || !sameCommand(pending, owner) ||
      !sameCommand(latestPromptRef.current, owner) || pending.streamingBehavior !== null ||
      pending.cleared ||
      draftVersionRef.current !== pending.draftVersion ||
      pageStateRef.current.draft !== pending.text ||
      !sameQuote(pageStateRef.current.quote, pending.quote)
    ) return;

    // 运行已确认；正文与引用留在 pending 元数据，保存队列只清理同版本的提交内容。
    markLocalChange({ ...pageStateRef.current, draft: '', quote: null }, 'command-settlement');
    const cleared = { ...pending, draftVersion: draftVersionRef.current, cleared: true };
    pendingCommandRef.current = cleared;
    writePendingCommand(storageKeys, cleared);
    void enqueueSave(false, false, { draft: pending.text, quote: pending.quote });
  }

  function restoreUnsentCommandDraft(owner: CommandIdentity): void {
    const pending = pendingCommandRef.current;
    if (
      !pending || !sameCommand(pending, owner) || !pending.cleared ||
      draftVersionRef.current !== pending.draftVersion ||
      pageStateRef.current.draft !== '' || pageStateRef.current.quote !== null
    ) return;
    // 发送未成功；该命令的工具记录不属于会话事实，一并清除。
    updateToolExecutions((current) => withoutCommand(current, pending.commandId));
    // 引用与正文一起回到输入区，用户不必重新选择来源。
    markLocalChange(
      { ...pageStateRef.current, draft: pending.text, quote: pending.quote },
      'command-settlement',
    );
  }

  function showCommandStatus(
    statusValue: 'unknown' | 'accepted' | 'handed_to_pi' | 'running',
    owner: CommandIdentity,
  ): void {
    switch (statusValue) {
      case 'unknown':
        setPromptFeedback(owner, { phase: 'reconciling', message: '正在确认消息是否已接受' });
        break;
      case 'accepted':
        setPromptFeedback(owner, { phase: 'accepted', message: '消息已接受' });
        break;
      case 'handed_to_pi':
        setPromptFeedback(owner, { phase: 'handed', message: '消息已交给 Pi' });
        break;
      case 'running':
        setPromptFeedback(owner, { phase: 'processing', message: 'Multivac 正在处理' });
        break;
    }
  }

  async function applyCommandReceipt(
    receipt: AssistantCommandReceipt,
    submitted: PendingCommand,
  ): Promise<boolean> {
    if (receipt.commandId !== submitted.commandId) return false;
    const owner: CommandIdentity = submitted;
    const ownsPending = isCurrentPending(owner);
    const ownsLatestPrompt = submitted.streamingBehavior === null &&
      sameCommand(latestPromptRef.current, owner);

    if (receipt.status !== 'terminal' || receipt.terminalOutcome === null) {
      if (receipt.status !== 'unknown') confirmPendingCommand(owner);
      if (receipt.status === 'running') clearRunningCommandDraft(owner);
      if (ownsLatestPrompt) {
        if (receipt.status !== 'unknown') activatePrompt(owner);
        showCommandStatus(
          receipt.status as 'unknown' | 'accepted' | 'handed_to_pi' | 'running',
          owner,
        );
      }
      return false;
    }

    if (ownsLatestPrompt) {
      clearActivePrompt(owner);
      clearCancellation(owner);
      if (receipt.terminalOutcome === 'succeeded') {
        setPromptFeedback(owner, { phase: 'succeeded', message: '处理完成' });
      } else if (receipt.terminalOutcome === 'failed' || receipt.terminalOutcome === 'rejected') {
        setPromptFeedback(owner, { phase: 'failed', message: '处理失败' });
      } else if (receipt.terminalOutcome === 'cancelled') {
        setPromptFeedback(owner, { phase: 'cancelled', message: '处理已取消' });
      }
    }

    // 迟到回执仍可作为历史事实读取，但不能结算已经被较新命令替换的 pending/draft。
    if (!ownsPending) return true;

    const successful = receipt.terminalOutcome === 'succeeded' || receipt.terminalOutcome === 'accepted';
    if (!successful) {
      clearLocalEcho(owner);
      restoreUnsentCommandDraft(owner);
      pendingCommandRef.current = null;
      writePendingCommand(storageKeys, null);
      setSendError(receipt.error?.message ?? (
        receipt.terminalOutcome === 'cancelled' ? '消息处理已取消。' : '消息处理失败，请重试。'
      ));
      return true;
    }

    const currentPending = pendingCommandRef.current!;
    pendingCommandRef.current = null;
    writePendingCommand(storageKeys, null);
    if (
      !currentPending.cleared && !conflictBlockedRef.current &&
      draftVersionRef.current === currentPending.draftVersion &&
      pageStateRef.current.draft === submitted.text &&
      sameQuote(pageStateRef.current.quote, submitted.quote)
    ) {
      // 命令成功是草稿清理条件，不是覆盖 page-state conflict 的用户授权。
      markLocalChange({ ...pageStateRef.current, draft: '', quote: null }, 'command-settlement');
      await enqueueSave(false, false, { draft: submitted.text, quote: submitted.quote });
    }
    return true;
  }

  async function applyActivePromptReceipt(
    receipt: AssistantCommandReceipt,
    owner: ActivePrompt,
    lifecycle: number,
  ): Promise<void> {
    if (receipt.commandId !== owner.commandId || !sameCommand(activePromptRef.current, owner)) return;
    if (receipt.status !== 'terminal' || receipt.terminalOutcome === null) {
      showCommandStatus(receipt.status as 'accepted' | 'handed_to_pi' | 'running', owner);
      return;
    }

    clearActivePrompt(owner);
    clearCancellation(owner);
    if (receipt.terminalOutcome === 'succeeded') {
      setPromptFeedback(owner, { phase: 'succeeded', message: '处理完成' });
    } else if (receipt.terminalOutcome === 'cancelled') {
      setPromptFeedback(owner, { phase: 'cancelled', message: '处理已取消' });
    } else {
      setPromptFeedback(owner, { phase: 'failed', message: '处理失败' });
    }
    void refreshLatestMessages(lifecycle);
  }

  async function reconcilePendingCommand(
    submitted: PendingCommand,
    lifecycle: number,
  ): Promise<void> {
    const owner: CommandIdentity = submitted;
    if (sameCommand(reconciliationCommandRef.current, owner)) return;
    reconciliationCommandRef.current = owner;
    if (isActiveLifecycle(lifecycle)) setReconcilingCommandId(owner.commandId);
    const startedAt = Date.now();
    let attempt = 0;
    let remainedUnknown = true;

    try {
      while (
        isActiveLifecycle(lifecycle) &&
        Date.now() - startedAt < COMMAND_RECONCILIATION_TIMEOUT_MS
      ) {
        try {
          const reconciliation = await getAssistantCommand(sessionId, submitted.commandId);
          if (!isActiveLifecycle(lifecycle) || !isCurrentPending(owner)) return;
          if (reconciliation.status === 'terminal' && reconciliation.receipt) {
            await applyCommandReceipt(reconciliation.receipt, submitted);
            return;
          }
          if (reconciliation.status === 'terminal') {
            setSendError('命令已终结，但服务未返回可用回执。');
            return;
          }
          remainedUnknown = remainedUnknown && reconciliation.status === 'unknown';
          if (reconciliation.status !== 'unknown') confirmPendingCommand(owner);
          if (reconciliation.status === 'running') clearRunningCommandDraft(owner);
          if (reconciliation.receipt) {
            await applyCommandReceipt(reconciliation.receipt, submitted);
          } else if (submitted.streamingBehavior === null) {
            if (reconciliation.status !== 'unknown') activatePrompt(owner);
            showCommandStatus(reconciliation.status, owner);
          }
        } catch {
          if (!isActiveLifecycle(lifecycle) || !isCurrentPending(owner)) return;
        }

        const delay = COMMAND_RECONCILIATION_DELAYS_MS[
          Math.min(attempt, COMMAND_RECONCILIATION_DELAYS_MS.length - 1)
        ]!;
        attempt += 1;
        await new Promise((resolve) => window.setTimeout(resolve, delay));
      }

      if (!isActiveLifecycle(lifecycle) || !isCurrentPending(owner)) return;
      if (!remainedUnknown || pendingCommandRef.current?.cleared) return;
      const unknownCommand = { ...submitted, unknown: true };
      pendingCommandRef.current = unknownCommand;
      writePendingCommand(storageKeys, unknownCommand);
      if (submitted.streamingBehavior === null) {
        clearActivePrompt(owner);
        setPromptFeedback(owner, { phase: 'unknown', message: '发送结果未知' });
      }
      setSendError('发送结果未知，可按原命令重试。');
    } finally {
      if (sameCommand(reconciliationCommandRef.current, owner)) {
        reconciliationCommandRef.current = null;
        if (isActiveLifecycle(lifecycle)) setReconcilingCommandId(null);
      }
    }
  }

  async function reconcileActivePrompt(lifecycle: number): Promise<void> {
    const owner = activePromptRef.current;
    if (!owner || sameCommand(pendingCommandRef.current, owner)) return;
    for (let attempt = 0; attempt < COMMAND_RECONCILIATION_DELAYS_MS.length; attempt += 1) {
      try {
        const reconciliation = await getAssistantCommand(sessionId, owner.commandId);
        if (!isActiveLifecycle(lifecycle) || !sameCommand(activePromptRef.current, owner)) return;
        if (reconciliation.receipt) {
          await applyActivePromptReceipt(reconciliation.receipt, owner, lifecycle);
        } else if (reconciliation.status === 'unknown') {
          clearActivePrompt(owner);
        }
        return;
      } catch {
        if (!isActiveLifecycle(lifecycle)) return;
        await new Promise((resolve) => window.setTimeout(
          resolve,
          COMMAND_RECONCILIATION_DELAYS_MS[attempt],
        ));
      }
    }
  }

  async function settlePendingCommandFromTerminalEvent(
    owner: CommandIdentity | null,
    lifecycle: number,
  ): Promise<void> {
    const pending = pendingCommandRef.current;
    if (!owner || !sameCommand(pending, owner)) return;
    try {
      const reconciliation = await getAssistantCommand(sessionId, owner.commandId);
      if (!isActiveLifecycle(lifecycle) || !isCurrentPending(owner) || !reconciliation.receipt) return;
      await applyCommandReceipt(reconciliation.receipt, pendingCommandRef.current!);
    } catch {
      // 既有持续对账仍会重试；terminal SSE 不因一次补读失败退回运行态。
    }
  }

  async function recoverExpiredEventCursor(lifecycle: number, attempt = 0): Promise<void> {
    if (eventRecoveryRef.current) return;
    eventRecoveryRef.current = true;
    const pending = pendingCommandRef.current;
    const active = activePromptRef.current;
    try {
      const commandIds = [...new Set([
        pending?.commandId,
        active?.commandId,
      ].filter((value): value is string => Boolean(value)))];
      const [state, latest, reconciliations] = await Promise.all([
        getAssistantPageState(sessionId),
        getAssistantSessionPage(sessionId).then((page) => loadStreamingHistory(messagesRef.current, page,
          (before) => getAssistantSessionPage(sessionId, before), () => isActiveLifecycle(lifecycle))),
        Promise.all(commandIds.map((commandId) => getAssistantCommand(sessionId, commandId))),
      ]);
      if (!isActiveLifecycle(lifecycle)) return;

      const conflictWasBlocked = conflictBlockedRef.current;
      updateRevision(state.revision, lifecycle);
      if (!conflictWasBlocked && sameContent(state, pageStateRef.current)) {
        dirtyRef.current = false;
        needsRevisionRefreshRef.current = false;
        conflictBlockedRef.current = false;
        setSaveFeedback({ phase: 'saved', message: '草稿已保存' });
      } else if (!conflictWasBlocked && !dirtyRef.current) {
        pageStateRef.current = state;
        setPageState(state);
        needsRevisionRefreshRef.current = false;
        conflictBlockedRef.current = false;
        setSaveFeedback({ phase: 'saved', message: '草稿已保存' });
      } else {
        conflictBlockedRef.current = true;
        setSaveFeedback({
          phase: 'error',
          message: '其他页面更新了保存版本；当前草稿已保留，请重试保存。',
        });
      }
      applyHistorySnapshot(latest);
      // 恢复等待状态/命令期间，普通刷新与消费水位可能已经推进。
      const resumeCursor = Math.max(lastEventCursorRef.current, historySnapshotCursorRef.current);
      lastEventCursorRef.current = resumeCursor;
      setEventCursor(String(resumeCursor));
      setEventSubscriptionGeneration((current) => current + 1);
      const results = new Map(reconciliations.map((item) => [item.commandId, item]));
      const activeResult = active ? results.get(active.commandId) : null;
      if (active && activeResult?.receipt) {
        await applyActivePromptReceipt(activeResult.receipt, active, lifecycle);
      } else if (active && activeResult?.status === 'unknown') {
        clearActivePrompt(active);
      }
      const pendingResult = pending ? results.get(pending.commandId) : null;
      if (pending && isCurrentPending(pending) && pendingResult?.receipt) {
        await applyCommandReceipt(pendingResult.receipt, pending);
      } else if (pending && isCurrentPending(pending)) {
        void reconcilePendingCommand(pending, lifecycle);
      }
      setSendError((current) => current.startsWith('事件恢复失败：') ? '' : current);
    } catch (error) {
      if (isActiveLifecycle(lifecycle)) {
        setSendError(`事件恢复失败：${errorMessage(error)}`);
        const delay = EVENT_RECOVERY_DELAYS_MS[
          Math.min(attempt, EVENT_RECOVERY_DELAYS_MS.length - 1)
        ]!;
        window.clearTimeout(eventRecoveryTimerRef.current);
        eventRecoveryTimerRef.current = window.setTimeout(
          () => void recoverExpiredEventCursor(lifecycle, attempt + 1),
          delay,
        );
      }
    } finally {
      eventRecoveryRef.current = false;
    }
  }

  useEffect(() => {
    if (status !== 'ready') return;
    const lifecycle = lifecycleGenerationRef.current;
    return subscribeAssistantEvents(sessionId, eventCursor, {
      onEvent(event: AssistantPublicEvent) {
        const cursor = Number(event.cursor);
        if (!isActiveLifecycle(lifecycle) || cursor <= lastEventCursorRef.current) return;
        lastEventCursorRef.current = cursor;
        const owner = commandIdentity(event.commandId);
        const ownsLatestPrompt = Boolean(owner && sameCommand(latestPromptRef.current, owner));
        const ownsActivePrompt = Boolean(owner && sameCommand(activePromptRef.current, owner));

        switch (event.type) {
          case 'assistant.message.delta':
            updateMessages((current) => appendStreamingDelta(current, event));
            break;
          case 'assistant.thinking.delta':
            updateRunTraces((current) => applyRunTraceEvent(current, event));
            break;
          case 'assistant.command.handed_to_pi':
            if (
              event.data.dispatchMode === 'prompt' && owner && ownsLatestPrompt &&
              (ownsActivePrompt || sameCommand(pendingCommandRef.current, owner))
            ) {
              confirmPendingCommand(owner);
              activatePrompt(owner);
              showCommandStatus('handed_to_pi', owner);
            }
            break;
          case 'assistant.run.processing':
            updateRunTraces((current) => applyRunTraceEvent(current, event));
            if (!owner || !ownsLatestPrompt || (
              !ownsActivePrompt && !sameCommand(pendingCommandRef.current, owner)
            )) break;
            confirmPendingCommand(owner);
            activatePrompt(owner);
            clearRunningCommandDraft(owner);
            setPromptFeedback(owner, { phase: 'processing', message: 'Multivac 正在处理' });
            // prompt HTTP 可以继续等待 settled；run.started 已证明 handoff，允许用户显式 steer/followUp。
            if (sameCommand(submissionCommandRef.current, owner)) {
              submittingRef.current = false;
              submissionCommandRef.current = null;
              setSubmitting(false);
            }
            break;
          case 'assistant.tool.started':
          case 'assistant.tool.updated':
          case 'assistant.tool.ended':
            updateToolExecutions((current) => applyToolExecutionEvent(current, event));
            if (event.type !== 'assistant.tool.ended') {
              if (owner && ownsActivePrompt) {
                setPromptFeedback(owner, { phase: 'tool', message: `正在使用 ${event.data.toolName}` });
              }
            } else if (owner && ownsActivePrompt) {
              setPromptFeedback(owner, {
                phase: event.data.isError ? 'tool' : 'processing',
                message: event.data.isError ? `${event.data.toolName} 执行失败` : '工具执行完成，继续处理',
              });
            }
            break;
          case 'assistant.retry.started':
            if (owner && ownsActivePrompt) {
              setPromptFeedback(owner, {
                phase: 'retry',
                message: `正在重试 ${event.data.attempt}/${event.data.maxAttempts}`,
              });
            }
            break;
          case 'assistant.retry.ended':
            if (owner && ownsActivePrompt) {
              setPromptFeedback(owner, { phase: 'processing', message: '重试结束，继续处理' });
            }
            break;
          case 'assistant.compaction.started':
            if (owner && ownsActivePrompt) {
              setPromptFeedback(owner, { phase: 'compaction', message: '正在压缩会话上下文' });
            }
            break;
          case 'assistant.compaction.ended':
            if (owner && ownsActivePrompt) {
              setPromptFeedback(owner, {
                phase: 'processing',
                message: event.data.status === 'failed'
                  ? '会话上下文压缩失败，继续等待运行结果'
                  : '上下文压缩完成',
              });
            }
            break;
          case 'assistant.run.succeeded':
            updateRunTraces((current) => applyRunTraceEvent(current, event));
            if (owner && ownsLatestPrompt && (
              ownsActivePrompt || sameCommand(pendingCommandRef.current, owner)
            )) {
              clearActivePrompt(owner);
              clearCancellation(owner);
              setPromptFeedback(owner, { phase: 'succeeded', message: '处理完成' });
            }
            if (owner && sameCommand(pendingCommandRef.current, owner)) {
              void settlePendingCommandFromTerminalEvent(owner, lifecycle);
            }
            void refreshLatestMessages(lifecycle);
            break;
          case 'assistant.run.failed':
            updateRunTraces((current) => applyRunTraceEvent(current, event));
            if (owner && ownsLatestPrompt && (
              ownsActivePrompt || sameCommand(pendingCommandRef.current, owner)
            )) {
              clearActivePrompt(owner);
              clearCancellation(owner);
              setPromptFeedback(owner, { phase: 'failed', message: '处理失败' });
            }
            if (owner && sameCommand(pendingCommandRef.current, owner)) {
              void settlePendingCommandFromTerminalEvent(owner, lifecycle);
            }
            void refreshLatestMessages(lifecycle);
            break;
          case 'assistant.run.cancelled':
            updateRunTraces((current) => applyRunTraceEvent(current, event));
            if (owner && ownsLatestPrompt && (
              ownsActivePrompt || sameCommand(pendingCommandRef.current, owner)
            )) {
              clearActivePrompt(owner);
              clearCancellation(owner);
              setPromptFeedback(owner, { phase: 'cancelled', message: '处理已取消' });
            }
            if (owner && sameCommand(pendingCommandRef.current, owner)) {
              void settlePendingCommandFromTerminalEvent(owner, lifecycle);
            }
            void refreshLatestMessages(lifecycle);
            break;
          case 'assistant.message.changed':
            if (event.data.role !== 'tool') void refreshLatestMessages(lifecycle);
            break;
          case 'assistant.command.rejected':
            if (owner && sameCommand(pendingCommandRef.current, owner)) {
              setSendError(event.data.error.message);
            }
            break;
          case 'assistant.command.reconciled':
            if (event.data.error?.code === 'COMMAND_INTERRUPTED') void refreshLatestMessages(lifecycle);
            if (
              owner && sameCommand(pendingCommandRef.current, owner) &&
              event.data.terminalOutcome === 'failed' && event.data.error
            ) {
              setSendError(event.data.error.message);
            }
            if (owner && ownsActivePrompt && ownsLatestPrompt) {
              clearActivePrompt(owner);
              clearCancellation(owner);
              setPromptFeedback(owner, { phase: 'failed', message: '处理已中断' });
            }
            break;
          default:
            break;
        }
      },
      onError(error) {
        if (error.code === 'EVENT_CURSOR_EXPIRED') {
          void recoverExpiredEventCursor(lifecycle);
        }
      },
    });
  }, [eventCursor, eventSubscriptionGeneration, isActiveLifecycle, refreshLatestMessages, status,
    updateMessages, updateRunTraces, updateToolExecutions]);

  useEffect(() => {
    if (status !== 'ready') return;
    const pending = pendingCommandRef.current;
    if (pending) void reconcilePendingCommand(pending, lifecycleGenerationRef.current);
    void reconcileActivePrompt(lifecycleGenerationRef.current);
  }, [status]);

  function updateDraft(draft: string): void {
    if (pageStateRef.current.draft === draft) return;
    setSendError('');
    markLocalChange({ ...pageStateRef.current, draft }, 'draft-intent');
  }

  function clearLocalEcho(owner: CommandIdentity): void {
    setLocalEcho((current) => current && sameCommand(current, owner) ? null : current);
  }

  function setQuote(quote: AssistantQuote): void {
    setSendError('');
    // 只替换引用，草稿原样保留。
    markLocalChange({ ...pageStateRef.current, quote }, 'draft-intent');
  }

  function removeQuote(): void {
    if (!pageStateRef.current.quote) return;
    markLocalChange({ ...pageStateRef.current, quote: null }, 'draft-intent');
  }

  async function submitDraft(hooks: SubmitHooks = {}): Promise<void> {
    const lifecycle = lifecycleGenerationRef.current;
    const text = pageStateRef.current.draft;
    const quote = pageStateRef.current.quote;
    const contextRefs = [...(hooks.contextRefs ?? [])];
    const running = activePromptRef.current !== null;
    const currentBehaviorSelection = streamingBehaviorSelectionRef.current;
    const ownedBehaviorSelection = running && currentBehaviorSelection &&
      sameCommand(currentBehaviorSelection, activePromptRef.current!)
      ? currentBehaviorSelection
      : null;
    const reusable = pendingCommandRef.current;
    // 引用与上下文都是命令指纹的一部分；任一变化就不再是同一条命令，必须新建 commandId。
    const retryingUnknown = Boolean(
      reusable?.unknown && reusable.text === text && sameQuote(reusable.quote, quote) &&
      sameContextRefs(reusable.contextRefs, contextRefs) && (
        reusable.streamingBehavior === null || running
      ),
    );
    if (
      !modelState.available || modelState.busy || submittingRef.current || !text.trim() ||
      draftSizeBytes(text) > ASSISTANT_DRAFT_MAX_UTF8_BYTES ||
      (running && !ownedBehaviorSelection && !retryingUnknown)
    ) return;

    hooks.onStart?.();
    submittingRef.current = true;
    setSubmitting(true);
    setSendError('');
    const selectedBehavior = retryingUnknown
      ? reusable!.streamingBehavior
      : ownedBehaviorSelection?.behavior ?? null;
    const submittedBehaviorSelection = retryingUnknown ? null : ownedBehaviorSelection;
    const submitted: PendingCommand = retryingUnknown
      ? { ...reusable!, draftVersion: draftVersionRef.current, unknown: false }
      : {
          commandId: crypto.randomUUID(),
          generation: nextCommandGeneration(),
          text,
          quote,
          contextRefs,
          draftVersion: draftVersionRef.current,
          cleared: false,
          unknown: false,
          streamingBehavior: selectedBehavior,
    };
    rememberCommand(submitted);
    setLocalEcho({
      commandId: submitted.commandId,
      generation: submitted.generation,
      text: submitted.text,
      quote: submitted.quote,
      createdAt: new Date().toISOString(),
      baseline: echoOccurrences(messagesRef.current, submitted),
    });
    // 提交即刻清空上一命令的工具执行记录，避免跨 Turn 混入当前运行。
    updateToolExecutions((current) => withoutCommand(current, submitted.commandId));
    if (submitted.streamingBehavior === null) {
      latestPromptRef.current = submitted;
      setPromptFeedback(submitted, { phase: 'reconciling', message: '正在发送消息' });
    }
    pendingCommandRef.current = submitted;
    writePendingCommand(storageKeys, submitted);
    submissionCommandRef.current = submitted;

    try {
      const receipt = await sendAssistantMessage({
        commandId: submitted.commandId,
        assistantSessionId: sessionId,
        text: submitted.text,
        contextRefs: submitted.contextRefs,
        ...(submitted.quote ? { quote: submitted.quote } : {}),
        ...(submitted.streamingBehavior ? { streamingBehavior: submitted.streamingBehavior } : {}),
      });
      if (!isActiveLifecycle(lifecycle)) return;
      const terminal = await applyCommandReceipt(receipt, submitted);
      if (!terminal) await reconcilePendingCommand(submitted, lifecycle);
      if (submittedBehaviorSelection) {
        clearStreamingBehaviorSelection(submittedBehaviorSelection);
      }
    } catch (error) {
      if (!isActiveLifecycle(lifecycle)) return;
      if (error instanceof AssistantApiError && error.status >= 400 && error.status < 500) {
        hooks.onRejected?.();
        if (submitted.streamingBehavior === null) {
          clearActivePrompt(submitted);
          setPromptFeedback(submitted, { phase: 'failed', message: '处理失败' });
        }
        if (isCurrentPending(submitted)) {
          clearLocalEcho(submitted);
          restoreUnsentCommandDraft(submitted);
          pendingCommandRef.current = null;
          writePendingCommand(storageKeys, null);
          setSendError(errorMessage(error));
        }
      } else {
        if (isCurrentPending(submitted)) {
          const unknownCommand = { ...pendingCommandRef.current!, unknown: true };
          pendingCommandRef.current = unknownCommand;
          writePendingCommand(storageKeys, unknownCommand);
          await reconcilePendingCommand(unknownCommand, lifecycle);
        }
      }
    } finally {
      if (
        isActiveLifecycle(lifecycle) &&
        sameCommand(submissionCommandRef.current, submitted)
      ) {
        submissionCommandRef.current = null;
        submittingRef.current = false;
        setSubmitting(false);
      }
    }
  }

  async function cancelCurrentRun(): Promise<void> {
    const owner = activePromptRef.current;
    if (!owner || cancellingRef.current) return;
    cancellingPromptRef.current = owner;
    cancellingRef.current = true;
    setCancelling(true);
    setSendError('');
    try {
      await cancelAssistantTurn({
        commandId: crypto.randomUUID(),
        assistantSessionId: sessionId,
      });
    } catch (error) {
      if (sameCommand(cancellingPromptRef.current, owner)) {
        clearCancellation(owner);
        if (sameCommand(activePromptRef.current, owner)) setSendError(errorMessage(error));
      }
    }
  }

  function setReadingAnchor(entryId: string | null, offsetPx: number): void {
    const current = pageStateRef.current;
    if (current.anchorEntryId === entryId && Math.abs(current.anchorOffsetPx - offsetPx) < 0.5) return;
    markLocalChange({ ...current, anchorEntryId: entryId, anchorOffsetPx: offsetPx }, 'view-anchor');
  }

  function loadEarlier(): number | null {
    if (!nextBefore || loadingEarlierRef.current) return null;
    const generation = ++historyGenerationRef.current;
    void loadEarlierBatch(nextBefore, generation);
    return generation;
  }

  async function loadEarlierBatch(before: string, generation: number): Promise<void> {
    const lifecycle = lifecycleGenerationRef.current;
    setHistoryError('');
    loadingEarlierRef.current = true;
    setLoadingEarlier(true);
    try {
      const earlier = await getAssistantSessionPage(sessionId, before);
      if (!isActiveLifecycle(lifecycle) || historyGenerationRef.current !== generation) return;
      if (paginationRef.current.nextBefore !== before) return;
      updateMessages((current) => mergeMessages(earlier.messages, current));
      setRenderedHistoryGeneration(generation);
      setHasMore(earlier.hasMore);
      setNextBefore(earlier.nextBefore);
      paginationRef.current = { hasMore: earlier.hasMore, nextBefore: earlier.nextBefore };
    } catch (loadError) {
      if (!isActiveLifecycle(lifecycle) || historyGenerationRef.current !== generation) return;
      setHistoryError(errorMessage(loadError));
    } finally {
      if (isActiveLifecycle(lifecycle) && historyGenerationRef.current === generation) {
        loadingEarlierRef.current = false;
        setLoadingEarlier(false);
      }
    }
  }

  const runActive = activePrompt !== null;
  // 回显只在本次消息尚未回读到历史时出现；一旦 Pi 历史带回同一条，就交还给历史渲染。
  const echoVisible = localEcho !== null &&
    echoOccurrences(messages, localEcho) <= localEcho.baseline;
  const echoId = echoVisible ? `pending:${localEcho.commandId}` : null;
  const displayMessages: VisibleAssistantMessage[] = echoVisible
    ? [...messages, {
        id: `pending:${localEcho.commandId}`,
        piSessionId: messages.at(-1)?.piSessionId ?? '',
        piEntryId: `pending:${localEcho.commandId}`,
        role: 'user',
        text: localEcho.text,
        createdAt: localEcho.createdAt,
        // 没有 Pi entry：该行不做阅读锚点，也不作为引用来源。
        streamCursor: Number.MAX_SAFE_INTEGER,
        ...(localEcho.quote ? { quote: localEcho.quote } : {}),
      }]
    : messages;
  // 正文与工具记录按服务端时间戳合并，工具记录不会堆在会话末尾。
  const timeline = groupAssistantTimeline(
    mergeAssistantTimeline(displayMessages, toolExecutions, commandAnchors),
    runTraces,
    commandAnchors,
  );
  const visibleReplyCommands = new Set(commandAnchors.flatMap((anchor) =>
    messages.some((message) => message.piEntryId === anchor.piEntryId) ? [anchor.commandId] : []));
  for (const message of messages) {
    if (message.commandId) visibleReplyCommands.add(message.commandId);
  }
  const streamingBehavior = activePrompt && streamingBehaviorSelection &&
    sameCommand(streamingBehaviorSelection, activePrompt)
    ? streamingBehaviorSelection.behavior
    : '';
  const runBusy = runActive || ['reconciling', 'accepted', 'handed'].includes(runFeedback.phase);
  const draftWithinLimit = draftSizeBytes(pageState.draft) <= ASSISTANT_DRAFT_MAX_UTF8_BYTES;
  const pendingUnknown = pendingCommandRef.current?.unknown === true;
  const pendingReconciliation = !runActive && reconcilingCommandId !== null &&
    pendingCommandRef.current?.commandId === reconcilingCommandId;
  const canRetryUnknown = pendingUnknown && pendingCommandRef.current?.text === pageState.draft;
  const canSubmit = modelState.available && !modelState.busy && Boolean(pageState.draft.trim()) && draftWithinLimit && !submitting &&
    !pendingReconciliation && (!runActive || Boolean(streamingBehavior) || canRetryUnknown);

  return {
    sessionId,
    status,
    loadGeneration,
    initialError,
    reload: () => void load(lifecycleGenerationRef.current),
    messages,
    displayMessages,
    echoId,
    timeline,
    visibleReplyCommands,
    toolExecutions,
    runTraces,
    hasMore,
    loadingEarlier,
    historyError,
    renderedHistoryGeneration,
    loadEarlier,
    pageState,
    saveFeedback,
    updateDraft,
    setQuote,
    removeQuote,
    setReadingAnchor,
    retrySave: () => void enqueueSave(false, true),
    model: modelState,
    runFeedback,
    runFeedbackCommandId: runFeedbackOwnerRef.current?.commandId ?? null,
    runActive,
    runBusy,
    submitting,
    cancelling,
    sendError,
    streamingBehavior,
    canSubmit,
    canRetryUnknown,
    selectStreamingBehavior,
    submitDraft,
    cancelCurrentRun,
  };
}

/** 一个会话在应用中的唯一状态：会话控制器与该会话的选模控制器。 */
export interface AssistantSessionEntry {
  session: AssistantSession;
  model: SessionModel;
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
    if (current?.session === entry.session && current.model === entry.model) return;
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
  retain(sessionId: string): void;
  release(sessionId: string): void;
}

const AssistantSessionsContext = createContext<AssistantSessionsContextValue | null>(null);

/** 运行单个会话的控制器并发布到集合；不渲染任何界面。 */
function SessionHost({ sessionId, store }: { sessionId: string; store: SessionControllerStore }) {
  const model = useSessionModelController(sessionId);
  const session = useAssistantSessionController(sessionId, {
    available: model.available,
    busy: model.busy,
    loaded: model.loaded,
  });

  useLayoutEffect(() => {
    store.publish(sessionId, { session, model });
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
  const releaseTimersRef = useRef(new Map<string, number>());

  const retain = useCallback((sessionId: string) => {
    const counts = retainCountsRef.current;
    counts.set(sessionId, (counts.get(sessionId) ?? 0) + 1);
    window.clearTimeout(releaseTimersRef.current.get(sessionId));
    releaseTimersRef.current.delete(sessionId);
    setOpenSessionIds((current) => current.includes(sessionId) ? current : [...current, sessionId]);
  }, []);

  const release = useCallback((sessionId: string) => {
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
      {openSessionIds.map((sessionId) => <SessionHost key={sessionId} sessionId={sessionId} store={store} />)}
      {children}
    </AssistantSessionsContext.Provider>
  );
}

/**
 * 取得会话状态并在使用期间保持该会话打开。会话控制器尚未就绪时返回 undefined。
 */
export function useAssistantSession(
  sessionId: string = GLOBAL_ASSISTANT_SESSION_ID,
): AssistantSessionEntry | undefined {
  const context = useContext(AssistantSessionsContext);
  if (!context) throw new Error('useAssistantSession 必须在 AssistantSessionsProvider 内使用。');
  const { store, retain, release } = context;

  useLayoutEffect(() => {
    retain(sessionId);
    return () => release(sessionId);
  }, [release, retain, sessionId]);

  return useSyncExternalStore(store.subscribe, () => store.get(sessionId));
}
