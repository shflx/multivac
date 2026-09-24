import {
  ArrowRight,
  CircleCheck,
  ChevronUp,
  CircleAlert,
  CircleStop,
  Layers3,
  LoaderCircle,
  Orbit,
  Quote,
  RefreshCw,
  RotateCw,
  Wrench,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ASSISTANT_QUOTE_MAX_UTF8_BYTES,
  assistantQuoteWithinLimit,
} from '@multivac/contracts';
import { useAssistantSession, type RunFeedback } from './assistant-session.js';
import { MarkdownBody } from './markdown-body';
import { captureQuoteSelection, type QuoteSelectionCandidate } from './message-quote';
import { ModelSelector } from './model-selector';
import { ToolExecutionGroup } from './tool-execution';

/** 运行反馈映射为轨迹状态；轨迹只据此区分运行中与已结束，结果文案由状态条陈述。 */
function runTraceStatus(feedback: RunFeedback, active: boolean) {
  if (active) return 'running' as const;
  if (feedback.phase === 'succeeded' || feedback.phase === 'failed' || feedback.phase === 'cancelled') {
    return feedback.phase;
  }
  return 'unknown' as const;
}

interface AssistantViewProps {
  active?: boolean;
  /**
   * 呈现形态。首页（page）是阅读锚点的唯一写入者，并在恢复时回到锚点；
   * 其他形态只读锚点，从最新消息开始阅读。
   */
  variant?: 'page' | 'sidebar';
  onManageModels?: () => void;
}

/**
 * Multivac 会话的一个呈现实例。
 *
 * 会话状态与网络交互都在共享的会话控制器中；这里只处理呈现相关的界面状态：
 * 滚动与跟随、阅读位置恢复、选区引用工具条和焦点。
 */
export function AssistantView({ active = true, variant = 'page', onManageModels }: AssistantViewProps) {
  const session = useAssistantSession();
  const {
    status, pageState, runFeedback, runActive, runBusy, submitting, cancelling,
    sendError, saveFeedback, streamingBehavior, canSubmit, canRetryUnknown,
    displayMessages, messages, timeline, visibleReplyCommands, echoId,
    hasMore, loadingEarlier, historyError, model: modelState,
  } = session;
  const writesAnchor = variant === 'page';
  const [quoteSelection, setQuoteSelection] = useState<QuoteSelectionCandidate | null>(null);
  const [quoteError, setQuoteError] = useState('');
  const assistantRootRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const lastFocusRef = useRef<HTMLElement | null>(null);
  const activeRef = useRef(active);
  const mountedRef = useRef(false);
  // 记录已完成阅读位置恢复的加载批次；控制器重新加载后需要再恢复一次。
  const restoredGenerationRef = useRef<number | null>(null);
  const prependRef = useRef<{
    generation: number;
    height: number;
    top: number;
  } | null>(null);
  const followLatestRef = useRef(false);
  const lastScrollTopRef = useRef(0);
  const userPausedFollowRef = useRef(false);
  const scrollFrameRef = useRef<number | undefined>(undefined);
  const quoteDraggingRef = useRef(false);

  activeRef.current = active;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      window.cancelAnimationFrame(scrollFrameRef.current ?? 0);
    };
  }, []);

  const refreshQuoteSelection = useCallback((): void => {
    const container = scrollRef.current;
    if (!activeRef.current || !container) {
      setQuoteSelection(null);
      return;
    }
    setQuoteSelection(captureQuoteSelection(container, window.getSelection(), {
      width: window.innerWidth,
      height: window.innerHeight,
    }));
  }, []);

  useEffect(() => {
    if (status !== 'ready') return;
    const onSelectionChange = () => {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        setQuoteSelection(null);
        return;
      }
      // 拖拽期间不弹工具条；指针抬起后再定位，避免工具条跟着光标抖动。
      if (quoteDraggingRef.current) return;
      refreshQuoteSelection();
    };
    const onPointerUp = () => {
      if (!quoteDraggingRef.current) return;
      quoteDraggingRef.current = false;
      refreshQuoteSelection();
    };
    document.addEventListener('selectionchange', onSelectionChange);
    window.addEventListener('pointerup', onPointerUp);
    return () => {
      document.removeEventListener('selectionchange', onSelectionChange);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, [refreshQuoteSelection, status]);

  // 离开工作面时不保留上一次的选区状态，回来后不会出现悬空工具条。
  useEffect(() => {
    if (active) return;
    quoteDraggingRef.current = false;
    setQuoteSelection(null);
    setQuoteError('');
  }, [active]);

  useLayoutEffect(() => {
    if (!active || status !== 'ready' || restoredGenerationRef.current === session.loadGeneration) return;
    const container = scrollRef.current;
    if (!container || container.getClientRects().length === 0) return;
    restoredGenerationRef.current = session.loadGeneration;
    prependRef.current = null;
    const anchor = writesAnchor && pageState.anchorEntryId
      ? container.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(pageState.anchorEntryId)}"]`)
      : null;
    if (anchor) {
      const offset = anchor.getBoundingClientRect().top - container.getBoundingClientRect().top;
      container.scrollTop += offset - pageState.anchorOffsetPx;
    } else {
      container.scrollTop = container.scrollHeight;
    }
    lastScrollTopRef.current = container.scrollTop;
  }, [active, messages, pageState.anchorEntryId, pageState.anchorOffsetPx, session.loadGeneration, status,
    writesAnchor]);

  useLayoutEffect(() => {
    if (!active) return;
    const pending = prependRef.current;
    const container = scrollRef.current;
    if (
      !pending || pending.generation !== session.renderedHistoryGeneration ||
      !container || container.getClientRects().length === 0
    ) return;
    container.scrollTop = pending.top + container.scrollHeight - pending.height;
    lastScrollTopRef.current = container.scrollTop;
    prependRef.current = null;
  }, [active, messages, session.renderedHistoryGeneration]);

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

  function clearQuoteSelection(): void {
    window.getSelection()?.removeAllRanges();
    quoteDraggingRef.current = false;
    setQuoteSelection(null);
  }

  function quoteCurrentSelection(): void {
    const candidate = quoteSelection;
    if (!candidate) return;
    if (!assistantQuoteWithinLimit(candidate.quote)) {
      // 选区保留，用户可以直接缩小后再次点击；不静默截断已选内容。
      setQuoteError(
        `选中内容超过 ${ASSISTANT_QUOTE_MAX_UTF8_BYTES / 1024} KB 引用上限，请缩小选区后重试。`,
      );
      return;
    }
    setQuoteError('');
    session.setQuote(candidate.quote);
    clearQuoteSelection();
    window.requestAnimationFrame(() => composerRef.current?.focus());
  }

  function removeQuote(): void {
    setQuoteError('');
    if (!pageState.quote) return;
    session.removeQuote();
    composerRef.current?.focus();
  }

  /** 发送时回到最新消息并恢复跟随；发送被拒绝则停止跟随。 */
  function submitDraft(): Promise<void> {
    return session.submitDraft({
      onStart() {
        followLatestRef.current = true;
        userPausedFollowRef.current = false;
        prependRef.current = null;
        const container = scrollRef.current;
        if (!container) return;
        container.scrollTo({
          top: container.scrollHeight,
          behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
        });
        lastScrollTopRef.current = container.scrollHeight;
      },
      onRejected() {
        followLatestRef.current = false;
      },
    });
  }

  function captureAnchor(): void {
    if (!writesAnchor || !activeRef.current || scrollFrameRef.current !== undefined) return;
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = undefined;
      if (!activeRef.current || !mountedRef.current) return;
      const container = scrollRef.current;
      if (!container || container.getClientRects().length === 0) return;
      const containerTop = container.getBoundingClientRect().top;
      const persistedRows = [...container.querySelectorAll<HTMLElement>('[data-entry-id]')];
      const anchor = persistedRows.find((element) => element.getBoundingClientRect().bottom > containerTop + 1)
        ?? persistedRows.at(-1);
      session.setReadingAnchor(
        anchor?.dataset.entryId ?? null,
        anchor ? anchor.getBoundingClientRect().top - containerTop : 0,
      );
    });
  }

  function pauseLatestFollow(): void {
    followLatestRef.current = false;
    userPausedFollowRef.current = true;
  }

  function loadEarlier(): void {
    const container = scrollRef.current;
    const height = container?.scrollHeight ?? 0;
    const top = container?.scrollTop ?? 0;
    const generation = session.loadEarlier();
    if (generation !== null && container) prependRef.current = { generation, height, top };
  }

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
          <p>{session.initialError}</p>
          <button type="button" onClick={session.reload}><RefreshCw aria-hidden="true" />重试</button>
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
              // 工具条按视口定位；列表滚动后必须重新测量，否则会停在旧位置。
              refreshQuoteSelection();
            }}
            onWheel={(event) => { if (event.deltaY < 0) pauseLatestFollow(); }}
            onTouchStart={pauseLatestFollow}
            onPointerDown={() => {
              pauseLatestFollow();
              quoteDraggingRef.current = true;
            }}
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
                        onClick={loadEarlier}
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
                      onClick={loadEarlier}
                      disabled={loadingEarlier}
                    >
                      {loadingEarlier ? <LoaderCircle className="spin" aria-hidden="true" /> : <ChevronUp aria-hidden="true" />}
                      {loadingEarlier ? '正在加载' : '加载更早消息'}
                    </button>
                  )}
                </div>
              )}

              {displayMessages.length === 0 && session.toolExecutions.length === 0 && session.runTraces.length === 0 ? (
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
                      {...(session.runFeedbackCommandId === item.commandId
                        ? { feedbackStatus: runTraceStatus(runFeedback, runBusy) }
                        : {})}
                    />
                  ) : (
                    <article
                      className={`chat-row ${item.message.role}${item.message.id === echoId ? ' pending' : ''}`}
                      data-entry-id={item.message.streamCursor === undefined ? item.message.piEntryId : undefined}
                      key={item.message.id}
                    >
                      <span className="avatar" aria-hidden="true">
                        {item.message.role === 'assistant' ? <Orbit /> : '你'}
                      </span>
                      <div>
                        <span className="message-author">{item.message.role === 'assistant' ? 'Multivac' : '你'}</span>
                        {item.message.quote && (
                          <blockquote className="message-quote">
                            <Quote aria-hidden="true" />
                            <span>{item.message.quote.text}</span>
                          </blockquote>
                        )}
                        {item.message.role === 'assistant'
                          ? <MarkdownBody text={item.message.text}
                            identity={JSON.stringify([item.message.piSessionId, item.message.runtimeMessageId ?? item.message.id])}
                            {...(item.message.streamCursor === undefined
                              ? {
                                  quoteSessionId: item.message.piSessionId,
                                  quoteEntryId: item.message.piEntryId,
                                  quoteRole: 'assistant' as const,
                                }
                              : {})} />
                          : (
                            <p
                              {...(item.message.streamCursor === undefined
                                ? {
                                    'data-quote-session-id': item.message.piSessionId,
                                    'data-quote-entry-id': item.message.piEntryId,
                                    'data-quote-role': 'user',
                                  }
                                : {})}
                            >{item.message.text}</p>
                          )}
                      </div>
                    </article>
                  ))}
                </>
              )}
            </div>
          </div>

          {quoteSelection && (
            <div
              className="selection-toolbar"
              style={{ left: quoteSelection.left, top: quoteSelection.top }}
              role="toolbar"
              aria-label="选中内容操作"
              // 按下即失焦会先清空选区；阻止默认行为才能在点击时仍拿到选中文本。
              onMouseDown={(event) => event.preventDefault()}
            >
              <button type="button" onClick={quoteCurrentSelection}>
                <Quote aria-hidden="true" />
                引用
              </button>
              <button
                type="button"
                className="selection-toolbar-close"
                aria-label="关闭引用工具条"
                title="关闭"
                onClick={clearQuoteSelection}
              >
                <X aria-hidden="true" />
              </button>
            </div>
          )}

          <div className="assistant-composer">
            {runFeedback.phase !== 'idle' && (
              <div className={`run-status ${runFeedback.phase}`} role="status" aria-live="polite">
                <RunIcon className={runBusy ? 'spin' : ''} aria-hidden="true" />
                <span>{runFeedback.message}</span>
                {runActive && (
                  <button
                    type="button"
                    onClick={() => void session.cancelCurrentRun()}
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
                  onClick={() => session.selectStreamingBehavior('steer')}
                >立即调整
                </button>
                <button
                  type="button"
                  aria-pressed={streamingBehavior === 'followUp'}
                  className={streamingBehavior === 'followUp' ? 'active' : ''}
                  onClick={() => session.selectStreamingBehavior('followUp')}
                >完成后继续
                </button>
              </div>
            )}
            {pageState.quote && (
              <div className="composer-quote">
                <Quote aria-hidden="true" />
                <div>
                  <span>引用选中内容</span>
                  <p>{pageState.quote.text}</p>
                </div>
                <button type="button" aria-label="移除引用" title="移除引用" onClick={removeQuote}>
                  <X aria-hidden="true" />
                </button>
              </div>
            )}
            {quoteError && (
              <div className="send-error" role="alert">
                <CircleAlert aria-hidden="true" />
                <span>{quoteError}</span>
              </div>
            )}
            <textarea
              ref={composerRef}
              aria-label="Multivac 草稿"
              aria-busy={!modelState.loaded}
              disabled={!modelState.loaded}
              aria-invalid={saveFeedback.phase === 'error' || Boolean(sendError)}
              value={pageState.draft}
              onChange={(event) => session.updateDraft(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key === 'Enter' && !event.shiftKey &&
                  !event.nativeEvent.isComposing && event.keyCode !== 229
                ) {
                  event.preventDefault();
                  void submitDraft();
                }
              }}
              placeholder={pageState.quote
                ? '基于这段内容继续讨论…'
                : runActive ? '输入运行中的调整或后续消息…' : '发送消息给 Multivac…'}
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
                <button type="button" onClick={session.retrySave}>
                  <RefreshCw aria-hidden="true" />
                  重试保存
                </button>
              </div>
            )}
            <div className="composer-bar">
              <div className="composer-meta">
                <ModelSelector active={active} running={runBusy || submitting} onManage={onManageModels} />
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
