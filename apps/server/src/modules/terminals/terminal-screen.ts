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
  private waiters = new Set<{ ready: boolean; resolve: (snapshot: ScreenSnapshot) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  onOutput: (data: Buffer, from: number, watermark: number, sequence: number) => void = () => {};
  onResize: (size: TerminalSize, sequence: number) => void = () => {};
  onNotification: () => void = () => {};
  constructor(size: TerminalSize, private readonly flow: { pause(): void; resume(): void }) {
    this.terminal = new headless.Terminal({ ...size, allowProposedApi: true, scrollback: TERMINAL_LIMITS.scrollback, theme: { ...TERMINAL_THEME } });
    this.terminal.loadAddon(this.serializer);
    internals(this.terminal);
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
      if (this.terminal.buffer.normal.length >= this.terminal.rows + TERMINAL_LIMITS.scrollback) this.trimmed = true;
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
    return new Promise((resolve, reject) => {
      const waiter = { ready: false, resolve, reject, timer: setTimeout(() => {
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
    const data = Buffer.from(this.serializer.serialize({ scrollback: TERMINAL_LIMITS.scrollback }) +
      (core.coreService.isCursorHidden ? '\x1b[?25l' : '\x1b[?25h'));
    const snapshot = { data, watermark: this.watermark, sequence: this.sequence, size: { cols: this.terminal.cols, rows: this.terminal.rows }, historyTrimmed: this.trimmed };
    for (const waiter of eligible) { clearTimeout(waiter.timer); this.waiters.delete(waiter); waiter.resolve(snapshot); }
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
