import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import { TERMINAL_LIMITS, TERMINAL_THEME, type TerminalSize } from '@multivac/contracts';

/** 所有依赖私有字段的访问集中在这里，升级须复验解析边界、UTF-8 和光标。 */
function internals(term: headless.Terminal) {
  const core = (term as unknown as { _core: {
    _inputHandler: { _parser: { currentState: number }; _utf8Decoder: { interim: Uint8Array } };
    coreService: { isCursorHidden: boolean };
  } })._core;
  if (typeof core?._inputHandler?._parser?.currentState !== 'number' ||
      !(core._inputHandler._utf8Decoder.interim instanceof Uint8Array) || typeof core.coreService?.isCursorHidden !== 'boolean') {
    throw new Error('headless 私有解析状态不兼容，请复验固定版本。');
  }
  return core;
}

export interface ScreenSnapshot { data: Buffer; watermark: number; sequence: number; size: TerminalSize; historyTrimmed: boolean }
export interface ScreenTextSnapshot extends Omit<ScreenSnapshot, 'data'> { text: string; buffer: 'normal' | 'alternate' }
export class TerminalScreen {
  readonly terminal: headless.Terminal;
  private readonly serializer = new serialize.SerializeAddon();
  private queue = Promise.resolve();
  private pendingBytes = 0;
  private watermark = 0;
  private sequence = 0;
  private disposed = false;
  private stopping = false;
  private trimmed = false;
  private waiters = new Set<{ ready: boolean; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  onOutput: (data: Buffer, from: number, watermark: number, sequence: number) => void = () => {};
  onResize: (size: TerminalSize, sequence: number) => void = () => {};
  onNotification: () => void = () => {};
  constructor(size: TerminalSize, private readonly flow: { pause(): void; resume(): void }) {
    this.terminal = new headless.Terminal({ ...size, allowProposedApi: true, scrollback: TERMINAL_LIMITS.scrollback, theme: { ...TERMINAL_THEME } });
    this.terminal.loadAddon(this.serializer);
    internals(this.terminal);
    // 首行标记真正被滚动历史移除后才提示裁剪，达到容量本身不等于已丢历史。
    this.terminal.registerMarker(0)?.onDispose(() => { if (!this.disposed) this.trimmed = true; });
    // xterm 的流式解析器区分独立 BEL 与 OSC 终止符，跨块通知不另造解析器。
    this.terminal.onBell(() => this.onNotification());
    for (const id of [9, 777]) this.terminal.parser.registerOscHandler(id, () => { this.onNotification(); return true; });
    // headless 不应答颜色查询；按共用配色应答前景、背景与光标色，CLI 据此识别浅色背景。应答经 onData 写回 PTY。
    for (const [id, color] of [[10, TERMINAL_THEME.foreground], [11, TERMINAL_THEME.background], [12, TERMINAL_THEME.cursor]] as const) {
      this.terminal.parser.registerOscHandler(id, data => {
        if (data !== '?') return false;
        this.terminal.input(`\x1b]${id};${xtermColor(color)}\x1b\\`, false);
        return true;
      });
    }
  }
  output(data: Buffer): void {
    if (this.disposed) return;
    // PTY 在暂停生效前仍可送来一个块；超出硬界限则拒绝继续积累并由运行时收尾。
    if (this.pendingBytes + data.length > 4 * TERMINAL_LIMITS.pauseBytes) throw new Error('终端解析缓冲超过上限。');
    this.pendingBytes += data.length;
    if (!this.stopping && this.pendingBytes > TERMINAL_LIMITS.pauseBytes) this.flow.pause();
    this.enqueue(async () => {
      await new Promise<void>(resolve => this.terminal.write(data, resolve));
      const from = this.watermark;
      this.watermark += data.length;
      this.pendingBytes -= data.length;
      if (this.pendingBytes < TERMINAL_LIMITS.resumeBytes) this.flow.resume();
      this.onOutput(data, from, this.watermark, ++this.sequence);
      this.resolveSnapshots();
    });
  }
  resize(size: TerminalSize): Promise<void> {
    return this.enqueue(async () => { this.terminal.resize(size.cols, size.rows); this.onResize(size, ++this.sequence); this.resolveSnapshots(); });
  }
  private enqueue(action: () => Promise<void>): Promise<void> {
    const next = this.queue.then(() => { if (!this.disposed) return action(); });
    this.queue = next.catch(error => {
      for (const waiter of this.waiters) { clearTimeout(waiter.timer); waiter.reject(error); }
      this.waiters.clear();
    });
    return next;
  }
  snapshot(): Promise<ScreenSnapshot> {
    return this.atBoundary(() => ({ ...this.metadata(), data: Buffer.from(this.serializer.serialize({ scrollback: TERMINAL_LIMITS.scrollback }) +
      (internals(this.terminal).coreService.isCursorHidden ? '\x1b[?25l' : '\x1b[?25h')) }));
  }
  /** 只读 active buffer；宽字占位由 xterm 处理，软换行不变成正文换行。 */
  textSnapshot(): Promise<ScreenTextSnapshot> {
    return this.atBoundary(() => {
      const buffer = this.terminal.buffer.active;
      const parts: string[] = [];
      for (let index = 0; index < buffer.length; index++) {
        const line = buffer.getLine(index)!;
        const next = buffer.getLine(index + 1);
        const wrapped = next?.isWrapped ?? false;
        // 宽字放不进行尾时，xterm 留一个空占位再折行；该占位不属于正文。
        const widePadding = wrapped && next?.getCell(0)?.getWidth() === 2 &&
          line.getCell(this.terminal.cols - 1)?.getWidth() === 1 && line.getCell(this.terminal.cols - 1)?.getChars() === '';
        parts.push(line.translateToString(!wrapped, 0, this.terminal.cols - (widePadding ? 1 : 0)));
        if (next && !wrapped) parts.push('\n');
      }
      return { ...this.metadata(), text: parts.join(''), buffer: buffer.type, historyTrimmed: buffer.type === 'normal' && this.trimmed };
    });
  }
  private metadata() {
    return { watermark: this.watermark, sequence: this.sequence, size: { cols: this.terminal.cols, rows: this.terminal.rows }, historyTrimmed: this.trimmed };
  }
  private atBoundary<T>(capture: () => T): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('终端画面已释放。'));
    return new Promise((resolve, reject) => {
      const waiter = { ready: false, resolve: () => {
        try { resolve(capture()); } catch (error) { reject(error); }
      }, reject, timer: setTimeout(() => {
        this.waiters.delete(waiter); reject(new Error('SNAPSHOT_TIMEOUT'));
      }, TERMINAL_LIMITS.snapshotTimeoutMillis) };
      this.waiters.add(waiter);
      // 等待完整控制序列时不占据解析队列，后续输出仍能使快照完成。
      void this.enqueue(async () => { waiter.ready = true; this.resolveSnapshots(); });
    });
  }
  private resolveSnapshots(): void {
    const eligible = [...this.waiters].filter(waiter => waiter.ready);
    if (!eligible.length) return;
    const core = internals(this.terminal);
    if (core._inputHandler._parser.currentState !== 0 || core._inputHandler._utf8Decoder.interim[0] !== 0) return;
    for (const waiter of eligible) { clearTimeout(waiter.timer); this.waiters.delete(waiter); waiter.resolve(); }
  }
  drain(): Promise<void> { return this.queue; }
  resumeForStop(): void { this.stopping = true; this.flow.resume(); }
  dispose(): void {
    this.disposed = true;
    for (const waiter of this.waiters) { clearTimeout(waiter.timer); waiter.reject(new Error('终端画面已释放。')); }
    this.waiters.clear(); this.terminal.dispose();
  }
}

/** #rrggbb 转为 xterm 颜色应答格式 rgb:rrrr/gggg/bbbb。 */
function xtermColor(hex: string): string {
  return `rgb:${[1, 3, 5].map(index => hex.slice(index, index + 2).repeat(2)).join('/')}`;
}
