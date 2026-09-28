/**
 * Promise 风格确认（`useConfirm()`）背后的请求状态，与界面无关，便于单独测试。
 *
 * 同一时刻只有一张确认卡：卡片是模态的，打开期间用户无法再触发新的确认；
 * 程序在此期间发起的新请求直接按“取消”结算，不排队、不顶替正在显示的卡片。
 */

/** 确认请求的最小形状：带 action 时，确认要等它完成才算成功。 */
export interface ConfirmRequestOptions {
  /**
   * 确认后要执行的异步操作。执行期间卡片忙碌、不可取消；失败时卡片留在原处显示错误，
   * 可以重试或取消。不提供时，点确认立即结算为 true。
   */
  action?: () => Promise<unknown> | unknown;
}

/** 正在显示的确认：id 每次请求都不同，界面据此为每次确认挂载新的卡片。 */
export interface PendingConfirm<T extends ConfirmRequestOptions> {
  id: number;
  options: T;
  busy: boolean;
  error: string;
}

const ACTION_FAILED = '操作没有完成，请重试。';

function failureText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : ACTION_FAILED;
}

export class ConfirmRequests<T extends ConfirmRequestOptions> {
  private current: (PendingConfirm<T> & { resolve: (confirmed: boolean) => void }) | null = null;
  // 对外快照保持引用稳定，只在状态变化时替换（useSyncExternalStore 依赖这一点）。
  private view: PendingConfirm<T> | null = null;
  private nextId = 1;
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = (): PendingConfirm<T> | null => this.view;

  /** 打开一张确认卡；确认（且 action 成功）时得到 true，取消时得到 false。 */
  request = (options: T): Promise<boolean> => {
    if (this.current) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      this.current = { id: this.nextId++, options, busy: false, error: '', resolve };
      this.publish();
    });
  };

  /** 取消：action 执行期间不可取消（请求已经发出，结果要如实呈现）。 */
  cancel = (): void => {
    if (!this.current || this.current.busy) return;
    this.settle(false);
  };

  /** 确认：执行 action，成功后关闭并结算为 true；失败时留在卡上显示错误，再次确认即重试。 */
  accept = async (): Promise<void> => {
    const current = this.current;
    if (!current || current.busy) return;
    if (!current.options.action) {
      this.settle(true);
      return;
    }

    const { id } = current;
    this.update({ busy: true, error: '' });
    try {
      await current.options.action();
    } catch (error) {
      if (this.current?.id === id) this.update({ busy: false, error: failureText(error) });
      return;
    }
    // 执行期间宿主可能已卸载（按取消结算），这时不再结算第二次。
    if (this.current?.id === id) this.settle(true);
  };

  /** 宿主卸载时把仍在显示的确认按取消结算，调用方不会一直等下去。 */
  dispose = (): void => {
    if (this.current) this.settle(false);
  };

  private update(patch: Pick<PendingConfirm<T>, 'busy' | 'error'>): void {
    if (!this.current) return;
    this.current = { ...this.current, ...patch };
    this.publish();
  }

  private settle(confirmed: boolean): void {
    const { resolve } = this.current!;
    this.current = null;
    this.publish();
    resolve(confirmed);
  }

  private publish(): void {
    const current = this.current;
    this.view = current ? { id: current.id, options: current.options, busy: current.busy, error: current.error } : null;
    for (const listener of this.listeners) listener();
  }
}
