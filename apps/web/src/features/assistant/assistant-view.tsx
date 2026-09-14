import {
  ArrowUp,
  ChevronUp,
  CircleAlert,
  LoaderCircle,
  Orbit,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import {
  ASSISTANT_DRAFT_MAX_UTF8_BYTES,
  type AssistantMessageView,
  type AssistantPageState,
  type AssistantSessionPageResponse,
} from '@multivac/contracts';
import {
  AssistantApiError,
  getAssistantPageState,
  getAssistantSessionPage,
  putAssistantPageState,
} from '../../data/assistant-api.js';

const INITIAL_PAGE_STATE: AssistantPageState = {
  draft: '',
  anchorEntryId: null,
  anchorOffsetPx: 0,
  revision: 0,
};

const SAVE_DELAY_MS = 450;
const textEncoder = new TextEncoder();

type SavePhase = 'saved' | 'pending' | 'saving' | 'error';
type LocalChangeKind = 'draft-intent' | 'view-anchor';

interface SaveFeedback {
  phase: SavePhase;
  message: string;
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
  return '无法读取协调助手会话，请稍后重试。';
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

export function AssistantView() {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [initialError, setInitialError] = useState('');
  const [historyError, setHistoryError] = useState('');
  const [messages, setMessages] = useState<AssistantMessageView[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [pageState, setPageState] = useState(INITIAL_PAGE_STATE);
  const [saveFeedback, setSaveFeedback] = useState<SaveFeedback>({
    phase: 'saved',
    message: '草稿已保存',
  });
  const scrollRef = useRef<HTMLDivElement>(null);
  const saveTimerRef = useRef<number | undefined>(undefined);
  const pageStateRef = useRef<AssistantPageState>(INITIAL_PAGE_STATE);
  const restoredRef = useRef(false);
  const prependRef = useRef<{ height: number; top: number } | null>(null);
  const scrollFrameRef = useRef<number | undefined>(undefined);
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const mountedRef = useRef(false);
  const lifecycleGenerationRef = useRef(0);
  const loadGenerationRef = useRef(0);
  const historyGenerationRef = useRef(0);
  const initializedRef = useRef(false);
  const dirtyRef = useRef(false);
  const localVersionRef = useRef(0);
  const needsRevisionRefreshRef = useRef(false);
  // 冲突补读只同步 revision，不授权后台保存覆盖远端；需等待用户重试或实际修改草稿。
  const conflictBlockedRef = useRef(false);
  const exitFlushVersionRef = useRef(-1);
  const loadingEarlierRef = useRef(false);

  const isActiveLifecycle = useCallback((lifecycle: number) =>
    mountedRef.current && lifecycleGenerationRef.current === lifecycle, []);

  const updateRevision = useCallback((revision: number, lifecycle: number): void => {
    // 持久化队列在组件卸载后仍需推进 revision，React 状态则只更新当前生命周期。
    const next = { ...pageStateRef.current, revision };
    pageStateRef.current = next;
    if (isActiveLifecycle(lifecycle)) setPageState(next);
  }, [isActiveLifecycle]);

  const saveLatestState = useCallback(async (
    keepalive: boolean,
    lifecycle: number,
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

    const candidate = pageStateRef.current;
    const candidateVersion = localVersionRef.current;
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
    } catch (saveError) {
      if (saveError instanceof AssistantApiError && saveError.code === 'PAGE_STATE_CONFLICT') {
        conflictBlockedRef.current = true;
        try {
          const remote = await getAssistantPageState();
          updateRevision(remote.revision, lifecycle);
          needsRevisionRefreshRef.current = false;
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
    }
  }, [isActiveLifecycle, updateRevision]);

  const enqueueSave = useCallback((keepalive = false, userInitiated = false) => {
    window.clearTimeout(saveTimerRef.current);
    if (userInitiated) conflictBlockedRef.current = false;
    const lifecycle = lifecycleGenerationRef.current;
    const task = saveChainRef.current
      .catch(() => {})
      .then(() => saveLatestState(keepalive, lifecycle));
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
    loadingEarlierRef.current = false;
    setStatus('loading');
    setInitialError('');
    setHistoryError('');
    setLoadingEarlier(false);

    const isCurrent = () =>
      isActiveLifecycle(lifecycle) && loadGenerationRef.current === generation;

    try {
      const [state, latestPage] = await Promise.all([
        getAssistantPageState(),
        getAssistantSessionPage(),
      ]);
      const page = await loadInitialWindow(state, latestPage, isCurrent);
      if (!page || !isCurrent()) return;

      pageStateRef.current = state;
      dirtyRef.current = false;
      needsRevisionRefreshRef.current = false;
      conflictBlockedRef.current = false;
      localVersionRef.current += 1;
      exitFlushVersionRef.current = -1;
      initializedRef.current = true;
      setPageState(state);
      setMessages(page.messages);
      setHasMore(page.hasMore);
      setNextBefore(page.nextBefore);
      setSaveFeedback({ phase: 'saved', message: '草稿已保存' });
      setStatus('ready');
    } catch (loadError) {
      if (!isCurrent()) return;
      setInitialError(errorMessage(loadError));
      setStatus('error');
    }
  }, [isActiveLifecycle]);

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
      window.cancelAnimationFrame(scrollFrameRef.current ?? 0);
    };
  }, [flushOnExit, load]);

  useLayoutEffect(() => {
    if (status !== 'ready' || restoredRef.current) return;
    const container = scrollRef.current;
    if (!container) return;
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
  }, [messages, pageState.anchorEntryId, pageState.anchorOffsetPx, status]);

  useLayoutEffect(() => {
    const pending = prependRef.current;
    const container = scrollRef.current;
    if (!pending || !container) return;
    container.scrollTop = pending.top + container.scrollHeight - pending.height;
    prependRef.current = null;
  }, [messages]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flushOnExit();
    };
    window.addEventListener('pagehide', flushOnExit);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('pagehide', flushOnExit);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [flushOnExit]);

  function updateDraft(draft: string): void {
    if (pageStateRef.current.draft === draft) return;
    markLocalChange({ ...pageStateRef.current, draft }, 'draft-intent');
  }

  function captureAnchor(): void {
    if (scrollFrameRef.current !== undefined) return;
    const lifecycle = lifecycleGenerationRef.current;
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = undefined;
      if (!isActiveLifecycle(lifecycle)) return;
      const container = scrollRef.current;
      if (!container) return;
      const containerTop = container.getBoundingClientRect().top;
      const anchor = [...container.querySelectorAll<HTMLElement>('[data-entry-id]')]
        .find((element) => element.getBoundingClientRect().bottom > containerTop + 1);
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

  async function loadEarlier(): Promise<void> {
    if (!nextBefore || loadingEarlierRef.current) return;
    const lifecycle = lifecycleGenerationRef.current;
    const generation = ++historyGenerationRef.current;
    const container = scrollRef.current;
    if (container) {
      prependRef.current = { height: container.scrollHeight, top: container.scrollTop };
    }
    setHistoryError('');
    loadingEarlierRef.current = true;
    setLoadingEarlier(true);
    try {
      const earlier = await getAssistantSessionPage(nextBefore);
      if (!isActiveLifecycle(lifecycle) || historyGenerationRef.current !== generation) return;
      setMessages((current) => mergeMessages(earlier.messages, current));
      setHasMore(earlier.hasMore);
      setNextBefore(earlier.nextBefore);
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

  return (
    <main className="assistant-page">
      <header className="assistant-header">
        <div className="assistant-brand"><Orbit aria-hidden="true" /><span>协调助手</span></div>
        <span className="read-only-status"><ShieldCheck aria-hidden="true" />只读会话</span>
      </header>

      {status === 'loading' && (
        <section className="assistant-state" aria-live="polite">
          <LoaderCircle className="spin" aria-hidden="true" />
          <h1>正在恢复会话</h1>
          <p>读取协调助手的 active branch 和页面现场。</p>
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
        <section className="assistant-conversation" aria-label="协调助手会话">
          <div className="message-scroll" ref={scrollRef} onScroll={captureAnchor}>
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

              {messages.length === 0 ? (
                <div className="empty-state">
                  <Orbit aria-hidden="true" />
                  <h1>会话还没有消息</h1>
                  <p>协调助手产生首条可见消息后，会在这里显示。</p>
                </div>
              ) : messages.map((message) => (
                <article
                  className={`chat-row ${message.role}`}
                  data-entry-id={message.piEntryId}
                  key={message.id}
                >
                  <span className="avatar" aria-hidden="true">
                    {message.role === 'assistant' ? <Orbit /> : '你'}
                  </span>
                  <div>
                    <span className="message-author">{message.role === 'assistant' ? '协调助手' : '你'}</span>
                    <p>{message.text}</p>
                  </div>
                </article>
              ))}
            </div>
          </div>

          <div className="assistant-composer">
            <textarea
              aria-label="协调助手草稿"
              aria-invalid={saveFeedback.phase === 'error'}
              value={pageState.draft}
              onChange={(event) => updateDraft(event.target.value)}
              placeholder="记录下一条消息草稿…"
            />
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
              <span className={`save-status ${saveFeedback.phase}`} aria-live="polite">
                {saveFeedback.phase === 'saving'
                  ? <LoaderCircle className="spin" aria-hidden="true" />
                  : <ShieldCheck aria-hidden="true" />}
                {saveFeedback.phase === 'error' ? '草稿尚未保存，正文已保留' : saveFeedback.message}
              </span>
              <button type="button" aria-label="发送不可用" title="发送将在后续版本开放" disabled>
                <ArrowUp aria-hidden="true" />
              </button>
            </div>
          </div>
        </section>
      )}
    </main>
  );
}
