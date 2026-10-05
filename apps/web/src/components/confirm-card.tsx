import { CircleAlert, CircleHelp, LoaderCircle, type LucideIcon } from 'lucide-react';
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { ConfirmRequests, type ConfirmRequestOptions } from './confirm-requests.js';
import { focusableWithin, wrapFocusIndex } from './focus-trap.js';

/**
 * default：可以撤回或影响有限的操作（如归档，之后可以恢复），打开时焦点在确认按钮上，Enter 直接确认。
 * danger：丢失数据或无法撤回的操作，用状态色（失败色族）而不是强调色表达；打开时焦点在取消按钮上，
 * 误按 Enter 不会执行，需要 Tab 到确认按钮或直接点击。
 */
export type ConfirmTone = 'default' | 'danger';

/** 确认卡的内容：标题、说明、要点与按钮文案。 */
export interface ConfirmContent {
  /** 卡片标题，也是对话框的可访问名称，例如“归档「导航结构」”。 */
  title: string;
  /** 标题下的一句说明：这个操作会带来什么结果。 */
  description?: ReactNode;
  /** 要点列表：保留什么、之后怎样找回、有哪些影响。 */
  details?: readonly ReactNode[];
  /** 标题前的图标；缺省时 default 用问号、danger 用警示。 */
  icon?: LucideIcon;
  tone?: ConfirmTone;
  confirmLabel: string;
  /** 缺省为“取消”。 */
  cancelLabel?: string;
  /** 触发元素随操作一起消失（例如归档后列表行被移走）时，关闭后把焦点交给这里。 */
  fallbackFocus?: () => HTMLElement | null | undefined;
}

/** `useConfirm()` 的参数：内容之外，可以带一个确认后执行的异步操作。 */
export interface ConfirmOptions extends ConfirmContent, ConfirmRequestOptions {}

export interface ConfirmCardProps extends ConfirmContent {
  /** 说明与要点之后的自定义内容，例如名称、目录输入或选项。 */
  children?: ReactNode;
  /** 确认条件尚未满足（例如必填项为空）时禁用确认。 */
  confirmDisabled?: boolean;
  /** 确认正在进行：按钮禁用、Esc 与点击遮罩不再取消。 */
  busy?: boolean;
  /** 可取消的长操作（如文件导入）在忙碌时仍允许请求取消。 */
  allowCancelWhileBusy?: boolean;
  /** 确认失败的原因；卡片保持打开，可以重试或取消。 */
  error?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * 确认卡：设计样式的模态确认，替代浏览器原生确认框。
 *
 * 受控组件，挂载即显示。需要在卡片里放输入或选项（新建项目、归入项目）时直接使用它；
 * 只需要“确认 / 取消”时用 `useConfirm()`。
 *
 * 键盘：打开时焦点落在默认按钮上（见 ConfirmTone；children 里有 autoFocus 的输入时保留在输入上），
 * Tab 在卡内循环，Enter 确认（焦点在取消按钮上时按下的是取消），Esc 取消；
 * 键盘事件不外泄，Esc 不会连带收起侧栏或离开管理。关闭后焦点还给打开前的元素。
 */
export function ConfirmCard({
  title, description, details, icon, tone = 'default', confirmLabel, cancelLabel = '取消', fallbackFocus,
  children, confirmDisabled = false, busy = false, allowCancelWhileBusy = false, error, onConfirm, onCancel,
}: ConfirmCardProps) {
  const titleId = useId();
  const descriptionId = useId();
  const detailsId = useId();
  const cardRef = useRef<HTMLFormElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  // 打开卡片的元素：首次渲染时焦点还在它上面。
  const [trigger] = useState(() => document.activeElement);
  const fallbackFocusRef = useRef(fallbackFocus);
  useLayoutEffect(() => {
    fallbackFocusRef.current = fallbackFocus;
  });

  const Icon = icon ?? (tone === 'danger' ? CircleAlert : CircleHelp);
  const hasDetails = Boolean(details?.length);
  const describedBy = [description ? descriptionId : '', hasDetails ? detailsId : ''].filter(Boolean).join(' ');

  function focusDefault(): void {
    const preferred = tone === 'danger' ? cancelRef.current : confirmRef.current;
    const target = [preferred, cancelRef.current].find((button) => button && !button.disabled);
    (target ?? cardRef.current)?.focus();
  }

  // 打开时把焦点移进卡片；关闭后还给触发元素。
  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    if (!card.contains(document.activeElement)) focusDefault();
    return () => {
      // 开发模式下 StrictMode 会模拟卸载再挂载，卡片节点仍在页面上，此时不交还焦点。
      if (card.isConnected) return;
      // 关闭时别处已经接管了焦点（例如操作完成后聚焦新内容），不去抢。
      const active = document.activeElement;
      if (active && active !== document.body && !card.contains(active)) return;
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true });
      if (document.activeElement !== trigger) fallbackFocusRef.current?.()?.focus({ preventScroll: true });
    };
    // 只在挂载与卸载时执行。
  }, []);

  // 忙碌时按钮被禁用，焦点先放在卡片上，键盘仍在卡内；结束后（例如失败）回到默认按钮，便于重试。
  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const active = document.activeElement;
    if (busy) {
      if (!card.contains(active) || (active instanceof HTMLButtonElement && active.disabled)) card.focus();
    } else if (active === card) {
      focusDefault();
    }
  }, [busy]);

  const canConfirm = !busy && !confirmDisabled;

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (canConfirm) onConfirm();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLFormElement>): void {
    // 模态层：键盘事件不再传给下层的全局快捷键（Esc 收起侧栏、Cmd+\ 切换工作区条等）。
    event.stopPropagation();

    if (event.key === 'Escape') {
      event.preventDefault();
      if (!busy || allowCancelWhileBusy) onCancel();
      return;
    }

    // 焦点在卡片容器本身（点击了卡内文字或忙碌结束前）时，Enter 同样确认；
    // 按钮与输入框上的 Enter 由浏览器按原生行为处理（确认按钮提交、取消按钮取消、输入框提交）。
    if (event.key === 'Enter' && event.target === event.currentTarget) {
      event.preventDefault();
      if (canConfirm) onConfirm();
      return;
    }

    if (event.key === 'Tab') {
      const focusables = focusableWithin(event.currentTarget);
      const index = focusables.indexOf(document.activeElement as HTMLElement);
      const next = wrapFocusIndex(focusables.length, index, event.shiftKey);
      if (next === null) return;
      event.preventDefault();
      focusables[next]?.focus();
    }
  }

  return createPortal(
    <div
      className="confirm-scrim"
      role="presentation"
      // 模态层：卡片与遮罩上的指针操作不算作下层弹层（如会话列表）的“外部点击”。
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget) return;
        // 阻止默认的失焦，焦点由卡片关闭时交还给触发元素。
        event.preventDefault();
        if (!busy || allowCancelWhileBusy) onCancel();
      }}
    >
      <form
        ref={cardRef}
        className={`confirm-card${tone === 'danger' ? ' danger' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy || undefined}
        aria-busy={busy || undefined}
        tabIndex={-1}
        noValidate
        onSubmit={submit}
        onKeyDown={handleKeyDown}
      >
        <div className="confirm-card-head">
          <Icon aria-hidden="true" />
          <div>
            <h2 id={titleId}>{title}</h2>
            {description && <p id={descriptionId}>{description}</p>}
          </div>
        </div>

        {hasDetails && (
          <ul id={detailsId} className="confirm-card-details">
            {details!.map((detail, index) => <li key={index}>{detail}</li>)}
          </ul>
        )}

        {children}

        {error && (
          <p className="confirm-card-error" role="alert">
            <CircleAlert aria-hidden="true" />
            <span>{error}</span>
          </p>
        )}

        <div className="confirm-card-actions">
          <button ref={cancelRef} type="button" className="secondary-button" disabled={busy && !allowCancelWhileBusy} onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="submit"
            className={tone === 'danger' ? 'secondary-button danger' : 'primary-button'}
            disabled={!canConfirm}
          >
            {busy && <LoaderCircle className="spin" aria-hidden="true" />}
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

type Confirm = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<Confirm | null>(null);

/** 应用级确认卡宿主：`useConfirm()` 发起的确认在这里显示，同一时刻最多一张。 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [requests] = useState(() => new ConfirmRequests<ConfirmOptions>());
  const pending = useSyncExternalStore(requests.subscribe, requests.snapshot);

  useEffect(() => () => requests.dispose(), [requests]);

  let card: ReactNode = null;
  if (pending) {
    const { action: _action, ...content } = pending.options;
    card = (
      <ConfirmCard
        // 每次确认挂载新的卡片：各自记住触发元素与初始焦点。
        key={pending.id}
        {...content}
        busy={pending.busy}
        error={pending.error}
        onConfirm={() => void requests.accept()}
        onCancel={requests.cancel}
      />
    );
  }

  return (
    <ConfirmContext.Provider value={requests.request}>
      {children}
      {card}
    </ConfirmContext.Provider>
  );
}

/**
 * Promise 风格的确认：确认（且 action 成功）时得到 true，取消时得到 false。
 *
 * ```ts
 * const confirm = useConfirm();
 * const archived = await confirm({
 *   title: `归档「${title}」`,
 *   description: '归档后不再出现在工作区中。',
 *   confirmLabel: '归档',
 *   action: async () => onArchived(await archiveWorkspaceSession(id)),
 * });
 * ```
 */
export function useConfirm(): Confirm {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error('useConfirm 必须在 ConfirmProvider 内使用。');
  return confirm;
}
