import {
  ArrowRight,
  CircleCheck,
  ChevronUp,
  CircleAlert,
  CircleStop,
  Layers3,
  LoaderCircle,
  Orbit,
  RefreshCw,
  RotateCw,
  Wrench,
} from 'lucide-react';
import {
  admitStreamingSnapshot, appendStreamingDelta, loadStreamingHistory, reconcileStreamingMessages,
  type StreamingHistorySnapshot, type VisibleAssistantMessage,
} from './streaming-messages';
import { MarkdownBody } from './markdown-body';
import { ModelSelector } from './model-selector';
import { ToolExecutionGroup } from './tool-execution';
import {
  applyToolExecutionEvent,
  applyRunTraceEvent,
  groupAssistantTimeline,
  hydrateRunTraces,
  hydrateToolExecutions,
  mergeAssistantTimeline,
  withoutCommand,
  type RunTrace,
  type RunTraceRecords,
  type ToolExecution,
  type ToolExecutionRecords,
} from './tool-executions';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import {
  ASSISTANT_DRAFT_MAX_UTF8_BYTES,
  GLOBAL_ASSISTANT_SESSION_ID,
  type AssistantCommandReceipt,
  type AssistantCommandAnchor,
  type AssistantMessageView,
  type AssistantPageState,
  type AssistantPublicEvent,
  type AssistantSessionPageResponse,
  type AssistantStreamingBehavior,
} from '@multivac/contracts';
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

const INITIAL_PAGE_STATE: AssistantPageState = {
  draft: '',
  anchorEntryId: null,
  anchorOffsetPx: 0,
  revision: 0,
};

const SAVE_DELAY_MS = 450;
const COMMAND_RECONCILIATION_TIMEOUT_MS = 12_000;
const COMMAND_RECONCILIATION_DELAYS_MS = [100, 200, 400, 800, 1_000] as const;
const EVENT_RECOVERY_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000] as const;
const PENDING_COMMAND_STORAGE_KEY = 'multivac.assistant.pending-command';
const ACTIVE_PROMPT_STORAGE_KEY = 'multivac.assistant.active-prompt-command';
const COMMAND_GENERATION_STORAGE_KEY = 'multivac.assistant.command-generation';
const DRAFT_VERSION_STORAGE_KEY = 'multivac.assistant.draft-version';
const textEncoder = new TextEncoder();

type SavePhase = 'saved' | 'pending' | 'saving' | 'error';
type LocalChangeKind = 'draft-intent' | 'command-settlement' | 'view-anchor';

interface SaveFeedback {
  phase: SavePhase;
  message: string;
}

type RunPhase = 'idle' | 'reconciling' | 'accepted' | 'handed' |
  'processing' | 'tool' | 'retry' | 'compaction' |
  'succeeded' | 'failed' | 'cancelled' | 'unknown';

interface RunFeedback {
  phase: RunPhase;
  message: string;
}

function runTracePresentation(feedback: RunFeedback, active: boolean) {
  if (active) return { status: 'running' as const, summary: '思考中', message: feedback.message };
  if (feedback.phase === 'succeeded') {
    return { status: 'succeeded' as const, summary: '处理完成', message: feedback.message };
  }
  if (feedback.phase === 'failed') {
    return { status: 'failed' as const, summary: '处理失败', message: feedback.message };
  }
  if (feedback.phase === 'cancelled') {
    return { status: 'cancelled' as const, summary: '已停止', message: feedback.message };
  }
  return { status: 'unknown' as const, summary: '状态待确认', message: feedback.message };
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
  draftVersion: number;
  cleared: boolean;
  unknown: boolean;
  streamingBehavior: AssistantStreamingBehavior | null;
}

interface LegacyPendingCommand extends CommandIdentity {
  text: string | null;
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

function readPendingCommand(): StoredPendingCommand | null {
  const stored = sessionStorage.getItem(PENDING_COMMAND_STORAGE_KEY);
  if (!stored) return null;

  try {
    const value = JSON.parse(stored) as unknown;
    if (isCommandId(value)) {
      return {
        commandId: value,
        generation: 0,
        text: null,
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
          draftVersion: null,
          cleared: false,
          unknown: false,
          streamingBehavior: null,
        }
      : null;
  }
}

function writePendingCommand(command: PendingCommand | null): void {
  if (command) sessionStorage.setItem(PENDING_COMMAND_STORAGE_KEY, JSON.stringify(command));
  else sessionStorage.removeItem(PENDING_COMMAND_STORAGE_KEY);
}

function readActivePrompt(): ActivePrompt | null {
  const value = sessionStorage.getItem(ACTIVE_PROMPT_STORAGE_KEY);
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

function writeActivePrompt(prompt: ActivePrompt | null): void {
  if (prompt) sessionStorage.setItem(ACTIVE_PROMPT_STORAGE_KEY, JSON.stringify(prompt));
  else sessionStorage.removeItem(ACTIVE_PROMPT_STORAGE_KEY);
}

function readCommandGeneration(): number {
  const value = Number(sessionStorage.getItem(COMMAND_GENERATION_STORAGE_KEY) ?? '0');
  return isGeneration(value) ? value : 0;
}

function writeCommandGeneration(generation: number): void {
  sessionStorage.setItem(COMMAND_GENERATION_STORAGE_KEY, String(generation));
}

function readDraftVersion(): number {
  const value = Number(sessionStorage.getItem(DRAFT_VERSION_STORAGE_KEY) ?? '0');
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function writeDraftVersion(version: number): void {
  sessionStorage.setItem(DRAFT_VERSION_STORAGE_KEY, String(version));
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
    left.anchorOffsetPx === right.anchorOffsetPx;
}

function draftSizeBytes(draft: string): number {
  return textEncoder.encode(draft).byteLength;
}

async function loadInitialWindow(
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
    const earlier = await getAssistantSessionPage(page.nextBefore);
    messages = mergeMessages(earlier.messages, messages);
    page = { ...page, messages, hasMore: earlier.hasMore, nextBefore: earlier.nextBefore };
    attempts += 1;
  }
  return isCurrent() ? page : null;
}

function errorMessage(error: unknown): string {
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

interface AssistantViewProps {
  active?: boolean;
  onManageModels?: () => void;
}

export function AssistantView({ active = true, onManageModels }: AssistantViewProps) {
  const [modelState, setModelState] = useState({ available: false, busy: false, loaded: false });
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
  const [activePrompt, setActivePrompt] = useState<ActivePrompt | null>(readActivePrompt());
  const [streamingBehaviorSelection, setStreamingBehaviorSelection] =
    useState<StreamingBehaviorSelection | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [reconcilingCommandId, setReconcilingCommandId] = useState<string | null>(null);
  const [sendError, setSendError] = useState('');
  const [renderedHistoryGeneration, setRenderedHistoryGeneration] = useState<number | null>(null);
  const assistantRootRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const lastFocusRef = useRef<HTMLElement | null>(null);
  const activeRef = useRef(active);
  const saveTimerRef = useRef<number | undefined>(undefined);
  const pageStateRef = useRef<AssistantPageState>(INITIAL_PAGE_STATE);
  const restoredRef = useRef(false);
  const prependRef = useRef<{
    generation: number;
    height: number;
    top: number;
  } | null>(null);
  const followLatestRef = useRef(false);
  const lastScrollTopRef = useRef(0);
  const userPausedFollowRef = useRef(false);
  const scrollFrameRef = useRef<number | undefined>(undefined);
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const mountedRef = useRef(false);
  const lifecycleGenerationRef = useRef(0);
  const loadGenerationRef = useRef(0);
  const historyGenerationRef = useRef(0);
  const initializedRef = useRef(false);
  const dirtyRef = useRef(false);
  // 页面现场版本用于保存队列；草稿版本只随正文变化，滚动不能阻止成功命令清稿。
  const localVersionRef = useRef(readDraftVersion());
  const draftVersionRef = useRef(localVersionRef.current);
  const needsRevisionRefreshRef = useRef(false);
  // 冲突补读只同步 revision，不授权后台保存覆盖远端；需等待用户重试或实际修改草稿。
  const conflictBlockedRef = useRef(false);
  const exitFlushVersionRef = useRef(-1);
  const loadingEarlierRef = useRef(false);
  const lastEventCursorRef = useRef(0);
  const historySnapshotCursorRef = useRef(0);
  const storedPendingCommandRef = useRef<StoredPendingCommand | null>(readPendingCommand());
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
    readCommandGeneration(),
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

  activeRef.current = active;

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
    writeActivePrompt(owner);
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
    writeActivePrompt(null);
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
    conflictRetryDraft?: string,
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
        const remote = await getAssistantPageState();
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

    let canRetryConflict = conflictRetryDraft !== undefined;
    while (true) {
      const candidate = pageStateRef.current;
      const candidateVersion = localVersionRef.current;
      const candidateDraftVersion = draftVersionRef.current;
      if (isActiveLifecycle(lifecycle)) {
        setSaveFeedback({ phase: 'saving', message: '正在保存草稿' });
      }

      try {
        const saved = await putAssistantPageState(candidate, keepalive);
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
            const remote = await getAssistantPageState();
            updateRevision(remote.revision, lifecycle);
            needsRevisionRefreshRef.current = false;
            // 自动结算只在远端仍为本次已提交正文时重试；远端已空则无需再次写入。
            if (
              canRetryConflict && candidate.draft === '' &&
              remote.draft === conflictRetryDraft &&
              draftVersionRef.current === candidateDraftVersion &&
              pageStateRef.current.draft === ''
            ) {
              canRetryConflict = false;
              conflictBlockedRef.current = false;
              continue;
            }
            if (
              canRetryConflict && candidate.draft === '' && remote.draft === '' &&
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
    conflictRetryDraft?: string,
  ) => {
    window.clearTimeout(saveTimerRef.current);
    if (userInitiated) conflictBlockedRef.current = false;
    const lifecycle = lifecycleGenerationRef.current;
    const task = saveChainRef.current
      .catch(() => {})
      .then(() => saveLatestState(keepalive, lifecycle, conflictRetryDraft));
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
      writeDraftVersion(draftVersionRef.current);
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
    restoredRef.current = false;
    prependRef.current = null;
    loadingEarlierRef.current = false;
    setRenderedHistoryGeneration(null);
    setStatus('loading');
    setInitialError('');
    setHistoryError('');
    setLoadingEarlier(false);
    setSendError('');

    const isCurrent = () =>
      isActiveLifecycle(lifecycle) && loadGenerationRef.current === generation;

    try {
      const [state, latestPage] = await Promise.all([
        getAssistantPageState(),
        getAssistantSessionPage(),
      ]);
      const page = await loadInitialWindow(state, latestPage, isCurrent);
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
          writePendingCommand(null);
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
          writePendingCommand(pending);
          commandGenerationsRef.current.set(pending.commandId, pending.generation);
          commandGenerationRef.current = Math.max(commandGenerationRef.current, pending.generation);
          writeCommandGeneration(commandGenerationRef.current);
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
          pending.text === state.draft &&
          draftVersionRef.current === pending.draftVersion
        ) {
          restoredState = { ...state, draft: '' };
          restoredPendingDraft = true;
        } else if (
          !pending.cleared && state.draft === '' &&
          draftVersionRef.current === pending.draftVersion
        ) {
          restoredState = { ...state, draft: pending.text };
          restoredPendingDraft = true;
        }
      } else {
        localVersionRef.current += 1;
        draftVersionRef.current += 1;
      }
      writeDraftVersion(draftVersionRef.current);
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
      window.cancelAnimationFrame(scrollFrameRef.current ?? 0);
    };
  }, [flushOnExit, load]);

  useLayoutEffect(() => {
    if (!active || status !== 'ready' || restoredRef.current) return;
    const container = scrollRef.current;
    if (!container || container.getClientRects().length === 0) return;
    restoredRef.current = true;
    const anchor = pageState.anchorEntryId
      ? container.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(pageState.anchorEntryId)}"]`)
      : null;
    if (anchor) {
      const offset = anchor.getBoundingClientRect().top - container.getBoundingClientRect().top;
      container.scrollTop += offset - pageState.anchorOffsetPx;
    } else {
      container.scrollTop = container.scrollHeight;
    }
    lastScrollTopRef.current = container.scrollTop;
  }, [active, messages, pageState.anchorEntryId, pageState.anchorOffsetPx, status]);

  useLayoutEffect(() => {
    if (!active) return;
    const pending = prependRef.current;
    const container = scrollRef.current;
    if (
      !pending || pending.generation !== renderedHistoryGeneration ||
      !container || container.getClientRects().length === 0
    ) return;
    container.scrollTop = pending.top + container.scrollHeight - pending.height;
    lastScrollTopRef.current = container.scrollTop;
    prependRef.current = null;
  }, [active, messages, renderedHistoryGeneration]);

  useLayoutEffect(() => {
    if (active && followLatestRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      lastScrollTopRef.current = scrollRef.current.scrollTop;
    }
  }, [active, messages, runFeedback.phase]);

  useLayoutEffect(() => {
    if (!active) return;
    const previous = lastFocusRef.current;
    const target = previous?.isConnected && !previous.matches(':disabled')
      ? previous
      : composerRef.current ?? scrollRef.current ?? assistantRootRef.current;
    target?.focus({ preventScroll: true });
  }, [active, status, modelState.loaded]);

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
      const latest = await getAssistantSessionPage();
      if (!isActiveLifecycle(lifecycle)) return;
      if (Number(latest.eventCursor) < historySnapshotCursorRef.current) return;
      const snapshot = await loadStreamingHistory(messagesRef.current, latest,
        (before) => getAssistantSessionPage(before), () => isActiveLifecycle(lifecycle));
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
    writeCommandGeneration(commandGenerationRef.current);
  }

  function nextCommandGeneration(): number {
    commandGenerationRef.current += 1;
    writeCommandGeneration(commandGenerationRef.current);
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
    writePendingCommand(confirmed);
  }

  function clearRunningCommandDraft(owner: CommandIdentity): void {
    const pending = pendingCommandRef.current;
    if (
      !pending || !sameCommand(pending, owner) ||
      !sameCommand(latestPromptRef.current, owner) || pending.streamingBehavior !== null ||
      pending.cleared ||
      draftVersionRef.current !== pending.draftVersion ||
      pageStateRef.current.draft !== pending.text
    ) return;

    // 运行已确认；正文留在 pending 元数据，保存队列只清理同版本的提交草稿。
    markLocalChange({ ...pageStateRef.current, draft: '' }, 'command-settlement');
    const cleared = { ...pending, draftVersion: draftVersionRef.current, cleared: true };
    pendingCommandRef.current = cleared;
    writePendingCommand(cleared);
    void enqueueSave(false, false, pending.text);
  }

  function restoreUnsentCommandDraft(owner: CommandIdentity): void {
    const pending = pendingCommandRef.current;
    if (
      !pending || !sameCommand(pending, owner) || !pending.cleared ||
      draftVersionRef.current !== pending.draftVersion || pageStateRef.current.draft !== ''
    ) return;
    // 发送未成功；该命令的工具记录不属于会话事实，一并清除。
    updateToolExecutions((current) => withoutCommand(current, pending.commandId));
    markLocalChange({ ...pageStateRef.current, draft: pending.text }, 'command-settlement');
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
      restoreUnsentCommandDraft(owner);
      pendingCommandRef.current = null;
      writePendingCommand(null);
      setSendError(receipt.error?.message ?? (
        receipt.terminalOutcome === 'cancelled' ? '消息处理已取消。' : '消息处理失败，请重试。'
      ));
      return true;
    }

    const currentPending = pendingCommandRef.current!;
    pendingCommandRef.current = null;
    writePendingCommand(null);
    if (
      !currentPending.cleared && !conflictBlockedRef.current &&
      draftVersionRef.current === currentPending.draftVersion &&
      pageStateRef.current.draft === submitted.text
    ) {
      // 命令成功是草稿清理条件，不是覆盖 page-state conflict 的用户授权。
      markLocalChange({ ...pageStateRef.current, draft: '' }, 'command-settlement');
      await enqueueSave(false, false, submitted.text);
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
          const reconciliation = await getAssistantCommand(submitted.commandId);
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
      writePendingCommand(unknownCommand);
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
        const reconciliation = await getAssistantCommand(owner.commandId);
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
      const reconciliation = await getAssistantCommand(owner.commandId);
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
        getAssistantPageState(),
        getAssistantSessionPage().then((page) => loadStreamingHistory(messagesRef.current, page,
          (before) => getAssistantSessionPage(before), () => isActiveLifecycle(lifecycle))),
        Promise.all(commandIds.map((commandId) => getAssistantCommand(commandId))),
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
    return subscribeAssistantEvents(eventCursor, {
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

  async function submitDraft(): Promise<void> {
    const lifecycle = lifecycleGenerationRef.current;
    const text = pageStateRef.current.draft;
    const running = activePromptRef.current !== null;
    const currentBehaviorSelection = streamingBehaviorSelectionRef.current;
    const ownedBehaviorSelection = running && currentBehaviorSelection &&
      sameCommand(currentBehaviorSelection, activePromptRef.current!)
      ? currentBehaviorSelection
      : null;
    const reusable = pendingCommandRef.current;
    const retryingUnknown = Boolean(
      reusable?.unknown && reusable.text === text && (
        reusable.streamingBehavior === null || running
      ),
    );
    if (
      !modelState.available || modelState.busy || submittingRef.current || !text.trim() ||
      draftSizeBytes(text) > ASSISTANT_DRAFT_MAX_UTF8_BYTES ||
      (running && !ownedBehaviorSelection && !retryingUnknown)
    ) return;

    followLatestRef.current = true;
    userPausedFollowRef.current = false;
    prependRef.current = null;
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      lastScrollTopRef.current = scrollRef.current.scrollTop;
    }
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
          draftVersion: draftVersionRef.current,
          cleared: false,
          unknown: false,
          streamingBehavior: selectedBehavior,
    };
    rememberCommand(submitted);
    // 提交即刻清空上一命令的工具执行记录，避免跨 Turn 混入当前运行。
    updateToolExecutions((current) => withoutCommand(current, submitted.commandId));
    if (submitted.streamingBehavior === null) {
      latestPromptRef.current = submitted;
      setPromptFeedback(submitted, { phase: 'reconciling', message: '正在发送消息' });
    }
    pendingCommandRef.current = submitted;
    writePendingCommand(submitted);
    submissionCommandRef.current = submitted;

    try {
      const receipt = await sendAssistantMessage({
        commandId: submitted.commandId,
        assistantSessionId: GLOBAL_ASSISTANT_SESSION_ID,
        text: submitted.text,
        contextRefs: [],
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
        followLatestRef.current = false;
        if (submitted.streamingBehavior === null) {
          clearActivePrompt(submitted);
          setPromptFeedback(submitted, { phase: 'failed', message: '处理失败' });
        }
        if (isCurrentPending(submitted)) {
          restoreUnsentCommandDraft(submitted);
          pendingCommandRef.current = null;
          writePendingCommand(null);
          setSendError(errorMessage(error));
        }
      } else {
        if (isCurrentPending(submitted)) {
          const unknownCommand = { ...pendingCommandRef.current!, unknown: true };
          pendingCommandRef.current = unknownCommand;
          writePendingCommand(unknownCommand);
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
        assistantSessionId: GLOBAL_ASSISTANT_SESSION_ID,
      });
    } catch (error) {
      if (sameCommand(cancellingPromptRef.current, owner)) {
        clearCancellation(owner);
        if (sameCommand(activePromptRef.current, owner)) setSendError(errorMessage(error));
      }
    }
  }

  function captureAnchor(): void {
    if (!activeRef.current || scrollFrameRef.current !== undefined) return;
    const lifecycle = lifecycleGenerationRef.current;
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = undefined;
      if (!activeRef.current || !isActiveLifecycle(lifecycle)) return;
      const container = scrollRef.current;
      if (!container || container.getClientRects().length === 0) return;
      const containerTop = container.getBoundingClientRect().top;
      const persistedRows = [...container.querySelectorAll<HTMLElement>('[data-entry-id]')];
      const anchor = persistedRows.find((element) => element.getBoundingClientRect().bottom > containerTop + 1)
        ?? persistedRows.at(-1);
      const nextAnchor = anchor?.dataset.entryId ?? null;
      const nextOffset = anchor ? anchor.getBoundingClientRect().top - containerTop : 0;
      const current = pageStateRef.current;
      if (
        current.anchorEntryId === nextAnchor &&
        Math.abs(current.anchorOffsetPx - nextOffset) < 0.5
      ) {
        return;
      }
      markLocalChange(
        { ...current, anchorEntryId: nextAnchor, anchorOffsetPx: nextOffset },
        'view-anchor',
      );
    });
  }

  function pauseLatestFollow(): void {
    followLatestRef.current = false;
    userPausedFollowRef.current = true;
  }

  async function loadEarlier(): Promise<void> {
    if (!nextBefore || loadingEarlierRef.current) return;
    const lifecycle = lifecycleGenerationRef.current;
    const generation = ++historyGenerationRef.current;
    const before = nextBefore;
    const container = scrollRef.current;
    if (container) {
      prependRef.current = {
        generation,
        height: container.scrollHeight,
        top: container.scrollTop,
      };
    }
    setHistoryError('');
    loadingEarlierRef.current = true;
    setLoadingEarlier(true);
    try {
      const earlier = await getAssistantSessionPage(before);
      if (!isActiveLifecycle(lifecycle) || historyGenerationRef.current !== generation) return;
      if (paginationRef.current.nextBefore !== before) {
        prependRef.current = null;
        return;
      }
      updateMessages((current) => mergeMessages(earlier.messages, current));
      setRenderedHistoryGeneration(generation);
      setHasMore(earlier.hasMore);
      setNextBefore(earlier.nextBefore);
      paginationRef.current = { hasMore: earlier.hasMore, nextBefore: earlier.nextBefore };
    } catch (loadError) {
      if (!isActiveLifecycle(lifecycle) || historyGenerationRef.current !== generation) return;
      prependRef.current = null;
      setHistoryError(errorMessage(loadError));
    } finally {
      if (isActiveLifecycle(lifecycle) && historyGenerationRef.current === generation) {
        loadingEarlierRef.current = false;
        setLoadingEarlier(false);
      }
    }
  }

  const runActive = activePrompt !== null;
  // 正文与工具记录按服务端时间戳合并，工具记录不会堆在会话末尾。
  const timeline = groupAssistantTimeline(
    mergeAssistantTimeline(messages, toolExecutions, commandAnchors),
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
  const RunIcon = runFeedback.phase === 'tool'
    ? Wrench
    : runFeedback.phase === 'retry'
      ? RotateCw
      : runFeedback.phase === 'compaction'
        ? Layers3
        : runFeedback.phase === 'succeeded'
          ? CircleCheck
          : runFeedback.phase === 'failed'
            ? CircleAlert
            : runFeedback.phase === 'cancelled'
              ? CircleStop
              : runFeedback.phase === 'unknown'
                ? CircleAlert
              : LoaderCircle;

  return (
    <main
      ref={assistantRootRef}
      className="assistant-page"
      tabIndex={-1}
      onFocusCapture={(event) => {
        const target = event.target;
        if (target instanceof HTMLElement && !target.hasAttribute('data-shell-navigation')) {
          lastFocusRef.current = target;
        }
      }}
    >
      {status === 'loading' && (
        <section className="assistant-state" aria-live="polite">
          <LoaderCircle className="spin" aria-hidden="true" />
          <h1>正在恢复会话</h1>
          <p>读取 Multivac 的 active branch 和页面现场。</p>
        </section>
      )}

      {status === 'error' && (
        <section className="assistant-state error-state" role="alert">
          <CircleAlert aria-hidden="true" />
          <h1>会话暂时不可用</h1>
          <p>{initialError}</p>
          <button type="button" onClick={() => void load(lifecycleGenerationRef.current)}><RefreshCw aria-hidden="true" />重试</button>
        </section>
      )}

      {status === 'ready' && (
        <section className="assistant-conversation" aria-label="Multivac 会话">
          <div
            className="message-scroll"
            ref={scrollRef}
            tabIndex={0}
            onScroll={(event) => {
              const container = event.currentTarget;
              // 用户上翻后，迟到的程序滚动事件不能重新开启跟随。
              if (container.scrollHeight - container.clientHeight - container.scrollTop <= 2 &&
                  (!userPausedFollowRef.current || container.scrollTop > lastScrollTopRef.current)) {
                followLatestRef.current = true;
                userPausedFollowRef.current = false;
              } else if (container.scrollTop < lastScrollTopRef.current) {
                pauseLatestFollow();
              }
              lastScrollTopRef.current = container.scrollTop;
              captureAnchor();
            }}
            onWheel={(event) => { if (event.deltaY < 0) pauseLatestFollow(); }}
            onTouchStart={pauseLatestFollow}
            onPointerDown={pauseLatestFollow}
            onKeyDown={(event) => {
              if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) pauseLatestFollow();
            }}
          >
            <div className="message-stream">
              {hasMore && (
                <div className="history-controls">
                  {historyError ? (
                    <div className="history-error" role="alert">
                      <CircleAlert aria-hidden="true" />
                      <div>
                        <strong>更早消息加载失败</strong>
                        <p>{historyError}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => void loadEarlier()}
                        aria-label="重试加载更早消息"
                        title="重试加载更早消息"
                      >
                        <RefreshCw aria-hidden="true" />
                        <span>重试</span>
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="load-earlier"
                      onClick={() => void loadEarlier()}
                      disabled={loadingEarlier}
                    >
                      {loadingEarlier ? <LoaderCircle className="spin" aria-hidden="true" /> : <ChevronUp aria-hidden="true" />}
                      {loadingEarlier ? '正在加载' : '加载更早消息'}
                    </button>
                  )}
                </div>
              )}

              {messages.length === 0 && toolExecutions.length === 0 && runTraces.length === 0 ? (
                <div className="empty-state">
                  <Orbit aria-hidden="true" />
                  <h1>会话还没有消息</h1>
                  <p>Multivac 产生首条可见消息后，会在这里显示。</p>
                </div>
              ) : (
                <>
                  {timeline.map((item) => item.kind === 'trace' ? (
                    <ToolExecutionGroup
                      key={item.key}
                      records={item.tools}
                      replyVisible={item.commandId !== null && visibleReplyCommands.has(item.commandId)}
                      {...(item.trace ? { trace: item.trace } : {})}
                      {...(runFeedbackOwnerRef.current?.commandId === item.commandId
                        ? { feedback: runTracePresentation(runFeedback, runBusy) }
                        : {})}
                    />
                  ) : (
                    <article
                      className={`chat-row ${item.message.role}`}
                      data-entry-id={item.message.streamCursor === undefined ? item.message.piEntryId : undefined}
                      key={item.message.id}
                    >
                      <span className="avatar" aria-hidden="true">
                        {item.message.role === 'assistant' ? <Orbit /> : '你'}
                      </span>
                      <div>
                        <span className="message-author">{item.message.role === 'assistant' ? 'Multivac' : '你'}</span>
                        {item.message.role === 'assistant'
                          ? <MarkdownBody text={item.message.text}
                            identity={JSON.stringify([item.message.piSessionId, item.message.runtimeMessageId ?? item.message.id])} />
                          : <p>{item.message.text}</p>}
                      </div>
                    </article>
                  ))}
                </>
              )}
            </div>
          </div>

          <div className="assistant-composer">
            {runFeedback.phase !== 'idle' && (
              <div className={`run-status ${runFeedback.phase}`} role="status" aria-live="polite">
                <RunIcon className={runBusy ? 'spin' : ''} aria-hidden="true" />
                <span>{runFeedback.message}</span>
                {runActive && (
                  <button
                    type="button"
                    onClick={() => void cancelCurrentRun()}
                    disabled={cancelling}
                    aria-label="取消当前处理"
                    title="取消当前处理"
                  >
                    <CircleStop aria-hidden="true" />
                    {cancelling ? '取消中' : '取消'}
                  </button>
                )}
              </div>
            )}
            {runActive && (
              <div className="streaming-behavior" role="group" aria-label="运行中消息行为">
                <span>运行中发送方式</span>
                <button
                  type="button"
                  aria-pressed={streamingBehavior === 'steer'}
                  className={streamingBehavior === 'steer' ? 'active' : ''}
                  onClick={() => selectStreamingBehavior('steer')}
                >立即调整
                </button>
                <button
                  type="button"
                  aria-pressed={streamingBehavior === 'followUp'}
                  className={streamingBehavior === 'followUp' ? 'active' : ''}
                  onClick={() => selectStreamingBehavior('followUp')}
                >完成后继续
                </button>
              </div>
            )}
            <textarea
              ref={composerRef}
              aria-label="Multivac 草稿"
              aria-busy={!modelState.loaded}
              disabled={!modelState.loaded}
              aria-invalid={saveFeedback.phase === 'error' || Boolean(sendError)}
              value={pageState.draft}
              onChange={(event) => updateDraft(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key === 'Enter' && !event.shiftKey &&
                  !event.nativeEvent.isComposing && event.keyCode !== 229
                ) {
                  event.preventDefault();
                  void submitDraft();
                }
              }}
              placeholder={runActive ? '输入运行中的调整或后续消息…' : '发送消息给 Multivac…'}
            />
            {sendError && (
              <div className="send-error" role="alert">
                <CircleAlert aria-hidden="true" />
                <span>{sendError}</span>
                {pageState.draft.trim() && (
                  <button type="button" onClick={() => void submitDraft()} disabled={submitting}>
                    <RefreshCw aria-hidden="true" />
                    {canRetryUnknown ? '按原命令重试' : '重试发送'}
                  </button>
                )}
              </div>
            )}
            {saveFeedback.phase === 'error' && (
              <div className="save-error" role="alert">
                <CircleAlert aria-hidden="true" />
                <span>{saveFeedback.message}</span>
                <button type="button" onClick={() => void enqueueSave(false, true)}>
                  <RefreshCw aria-hidden="true" />
                  重试保存
                </button>
              </div>
            )}
            <div className="composer-bar">
              <div className="composer-meta">
                <ModelSelector active={active} running={runBusy || submitting} onManage={onManageModels} onState={setModelState} />
                <span className={`save-status ${saveFeedback.phase}`} aria-live="polite"
                  title={saveFeedback.phase === 'error' ? '草稿尚未保存，正文已保留' : saveFeedback.message}>
                  {saveFeedback.phase === 'saving'
                    ? <LoaderCircle className="spin" aria-hidden="true" />
                    : <CircleCheck aria-hidden="true" />}
                  {saveFeedback.phase === 'error' ? '草稿尚未保存，正文已保留' : saveFeedback.message}
                </span>
              </div>
              <button
                type="button"
                className="composer-send-button"
                aria-label="发送消息"
                title={!modelState.loaded ? '正在读取会话模型'
                  : modelState.busy ? '模型选择正在提交或对账，暂不能发送'
                  : !modelState.available ? '当前会话模型不可用，请查看模型选择状态'
                  : runActive && !streamingBehavior && !canRetryUnknown
                  ? '请先选择运行中发送方式'
                  : canRetryUnknown ? '按原命令重试' : '发送消息'}
                disabled={!canSubmit}
                onClick={() => void submitDraft()}
              >
                {submitting ? <LoaderCircle className="spin" aria-hidden="true" /> : <ArrowRight aria-hidden="true" />}
              </button>
            </div>
          </div>
        </section>
      )}
    </main>
  );
}
