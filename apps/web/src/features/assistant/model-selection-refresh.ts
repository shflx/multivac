import type { WorkbenchEvent } from '@multivac/contracts';

export const MODEL_SELECTION_FALLBACK_MS = 30_000;
export const MODEL_SELECTION_RECONCILE_MS = 1_500;

interface RefreshClock {
  setTimeout(callback: () => void, delay: number): number;
  clearTimeout(timer: number): void;
}

/** 一次读取期间的请求合并为一次补读；补读期间的新变化由短延时承接，避免同步刷新循环。 */
export class ModelSelectionRefresh {
  private reading: Promise<void> | null = null;
  private dirty = false;
  private stopped = true;
  private timer: number | undefined;

  constructor(private readonly options: {
    read: () => Promise<void>;
    pending: () => boolean;
    visible: () => boolean;
    clock: RefreshClock;
  }) {}

  start(): void { this.stopped = false; void this.request(); }
  stop(): void {
    this.stopped = true;
    this.dirty = false;
    if (this.timer !== undefined) this.options.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }
  schedule(): void {
    if (this.timer !== undefined) this.options.clock.clearTimeout(this.timer);
    this.timer = undefined;
    if (this.stopped) return;
    const delay = this.options.pending() || this.dirty ? MODEL_SELECTION_RECONCILE_MS
      : this.options.visible() ? MODEL_SELECTION_FALLBACK_MS : null;
    if (delay !== null) this.timer = this.options.clock.setTimeout(() => { void this.request(); }, delay);
  }
  event(event: WorkbenchEvent, sessionId: string): void {
    if (event.type === 'workbench.connected' || event.type === 'model-selection.changed' &&
      (event.sessionId === null || event.sessionId === sessionId)) void this.request();
  }
  request(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.reading) { this.dirty = true; return this.reading; }
    this.reading = (async () => {
      for (let pass = 0; pass < 2; pass++) {
        this.dirty = false;
        await this.options.read();
        if (this.stopped || !this.dirty) break;
      }
    })().finally(() => {
      this.reading = null;
      this.schedule();
    });
    return this.reading;
  }
}
