import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Check as CheckSchema } from 'typebox/value';
import { agentSessionTrackable, TerminalServerMessageSchema, terminalIsActive, TERMINAL_LIMITS, TERMINAL_THEME, type ProjectTerminal, type TerminalClientMessage, type TerminalSize } from '@multivac/contracts';
import { Columns2, Expand, LoaderCircle, Maximize2, MoreHorizontal, Power, RotateCcw, Shrink, X } from 'lucide-react';
import { terminalAction } from '../../data/terminal-api.js';
import { useConfirm } from '../../components/confirm-card.js';
import { useTerminals } from './terminals-provider.js';
import { TerminalDirectory } from './terminal-directory.js';
import { AgentMark, exitText, presetCommand, statusText, TerminalBadge } from './terminal-presentation.js';
import '@xterm/xterm/css/xterm.css';

/** 关闭连接：握手中的连接等打开后再正常关闭，避免中途放弃导致代理侧连接重置。 */
function closeSocket(socket: WebSocket | null): void {
  if (!socket) return;
  if (socket.readyState === WebSocket.CONNECTING) socket.addEventListener('open', () => socket.close(), { once: true });
  else socket.close();
}

const clampSize = (size: { cols: number; rows: number }): TerminalSize => ({
  cols: Math.max(TERMINAL_LIMITS.minCols, Math.min(TERMINAL_LIMITS.maxCols, size.cols)),
  rows: Math.max(TERMINAL_LIMITS.minRows, Math.min(TERMINAL_LIMITS.maxRows, size.rows)),
});
function bytes(base64: string): Uint8Array { return Uint8Array.from(atob(base64), char => char.charCodeAt(0)); }

/** 终端画面使用浅色，与服务端权威画面应答颜色查询所用的配色一致。字体在等宽字体之后列出常见 Nerd Font，提示符中的图标字形可以逐字回退显示。 */
const THEME: ITheme = {
  ...TERMINAL_THEME,
  scrollbarSliderBackground: 'rgb(27 32 35 / 14%)', scrollbarSliderHoverBackground: 'rgb(27 32 35 / 24%)', scrollbarSliderActiveBackground: 'rgb(27 32 35 / 30%)',
};
const FONT = '"SF Mono", SFMono-Regular, Menlo, Monaco, "MesloLGS NF", "MesloLGS Nerd Font", "JetBrainsMono Nerd Font", "Hack Nerd Font", "Symbols Nerd Font Mono", monospace';

/** 连接说明：已连接时不显示，避免与运行状态重复。 */
type Connection = 'connecting' | 'connected' | 'disconnected' | 'unavailable';

export function TerminalView({ record, visible, current, slotLabel = '', focused, onActivate, onFocus, onReturnToParallel, onClosed }: {
  record: ProjectTerminal;
  visible: boolean;
  /** 是否为工作区的当前对象：标题栏与会话一样提亮并带强调色底线。 */
  current: boolean;
  onActivate: () => void;
  /** 并排时的栏位标记，如“第 2 栏”。 */
  slotLabel?: string;
  /** 是否单独查看（聚焦）；并排栏位中为 false。 */
  focused: boolean;
  onFocus: () => void;
  onReturnToParallel: () => void;
  onClosed: () => void;
}) {
  const { refresh } = useTerminals();
  const confirm = useConfirm();
  const root = useRef<HTMLElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  const [connection, setConnection] = useState<Connection>('connecting');
  const [owner, setOwner] = useState(false);
  const [trimmed, setTrimmed] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const menuList = useRef<HTMLDivElement>(null);
  const focusTerminal = useRef<() => void>(() => {});
  const active = useRef(visible); active.current = visible;
  const runningRef = useRef(terminalIsActive(record.status)); runningRef.current = terminalIsActive(record.status);
  const running = terminalIsActive(record.status);
  // 没有运行期画面、不再连接的终端：已关闭、启动失败，或当前实例随服务退出 / Multivac 重启而结束。
  // 只看属于当前实例的结束信息；重开后旧实例的结束信息仍在记录中，不能据此判断。
  const currentExit = record.lastExit?.instanceId === record.instanceId ? record.lastExit : null;
  const lostWithService = !running && (currentExit?.reason === 'multivac-restarted' || currentExit?.reason === 'service-shutdown');
  const detached = Boolean(record.closedAt) || record.status === 'failed' || lostWithService;
  // coding agent 终端随服务结束时，显示出来即自动接回原会话（每个实例只尝试一次，失败时保留按钮）。
  // Claude Code 没有 ID 时仍可继续该目录最近的会话；Codex 需要已记录 app-server 创建的会话 ID。
  const agentResumable = agentSessionTrackable(record.preset) && (record.preset.kind === 'claude' || Boolean(record.agentSessionId));
  const autoResumed = useRef<string | null>(null);

  useEffect(() => {
    if (!host.current) return;
    const hostElement = host.current;
    if (detached) { setOwner(false); setConnection('unavailable'); return; }
    let disposed = false; let socket: WebSocket | null = null; let timer: number | undefined;
    let connectionId = ''; let owns = false; let ready = false; let watermark = 0;
    let snapshotId: string | null = null; let snapshotOffset = 0;
    let queue = Promise.resolve(); let pendingBytes = 0;
    const term = new Terminal({ cursorBlink: true, scrollback: TERMINAL_LIMITS.scrollback, fontSize: 13, lineHeight: 1.2, fontFamily: FONT, theme: THEME, allowProposedApi: true });
    const fit = new FitAddon(); term.loadAddon(fit); term.loadAddon(new WebLinksAddon((_event, url) => window.open(url, '_blank', 'noopener,noreferrer')));
    term.open(host.current);
    focusTerminal.current = () => term.focus();
    // 设备查询由服务端 headless 唯一应答，跟随窗口不能重复应答。
    // 所有会自动应答的终端查询都在浏览器端吞掉，只由服务端权威画面应答一次：
    // 浏览器若也应答，应答会混进输入；多个窗口同时显示时还会互相触发重绘与再次查询，形成死循环。
    // DA1/DA2/DA3、DSR、DECRQM（含 DEC 私有）、XTVERSION、kitty 键盘查询、窗口报告、DECRQSS、调色板与前景/背景/光标色查询。
    const queries: Array<{ prefix?: string; intermediates?: string; final: string }> = [
      { final: 'c' }, { prefix: '>', final: 'c' }, { prefix: '=', final: 'c' },
      { final: 'n' }, { prefix: '?', final: 'n' },
      { intermediates: '$', final: 'p' }, { prefix: '?', intermediates: '$', final: 'p' },
      { prefix: '>', final: 'q' }, { prefix: '?', final: 'u' }, { final: 't' },
    ];
    for (const query of queries) term.parser.registerCsiHandler(query, () => true);
    term.parser.registerDcsHandler({ intermediates: '$', final: 'q' }, () => true);
    for (const osc of [4, 10, 11, 12]) term.parser.registerOscHandler(osc, data => data.includes('?'));
    const send = (message: Omit<TerminalClientMessage, 'connectionId' | 'instanceId'>) => {
      if (socket?.readyState === WebSocket.OPEN && connectionId) socket.send(JSON.stringify({ ...message, connectionId, instanceId: record.instanceId }));
    };
    const read = () => { if (active.current && ready) send({ type: 'read' }); };
    const proposed = (): TerminalSize | null => { const measured = fit.proposeDimensions(); return measured && measured.cols > 0 && measured.rows > 0 ? clampSize(measured) : null; };
    const resize = () => {
      if (!host.current?.clientWidth || !active.current) return;
      const next = proposed();
      if (next && owns && ready && (term.cols !== next.cols || term.rows !== next.rows)) send({ type: 'resize', size: next } as TerminalClientMessage);
    };
    // 输入权在窗口之间自动转移：哪个窗口聚焦终端或开始输入，就由它接管输入与尺寸。
    // 接管确认之前的输入暂存（有上限），取得输入权后按顺序发出。
    let requested = false; let pendingInput = '';
    const takeover = () => {
      if (!ready || owns || requested || !terminalIsActive(record.status)) return;
      requested = true; send({ type: 'takeover', size: proposed() ?? clampSize(term) } as TerminalClientMessage);
    };
    const sendInput = (data: string) => {
      // 按字符拆分，中文/emoji 不截断且每帧低于协议上限。
      let chunk = '';
      for (const char of data) { if (chunk.length + char.length > 2048) { send({ type: 'input', data: chunk } as TerminalClientMessage); chunk = ''; } chunk += char; }
      if (chunk) send({ type: 'input', data: chunk } as TerminalClientMessage);
    };
    const flushInput = () => { if (owns && pendingInput) { const data = pendingInput; pendingInput = ''; sendInput(data); } };
    const observer = new ResizeObserver(resize); observer.observe(host.current);
    // 只有用户的真实操作（聚焦、按键、粘贴、点击、滚轮、输入法）才接管输入权；程序产生的数据不触发接管。
    let intentAt = 0;
    const intent = () => { intentAt = Date.now(); };
    const focused = () => { intent(); takeover(); };
    const intentEvents = ['keydown', 'paste', 'mousedown', 'wheel', 'compositionend'] as const;
    term.textarea?.addEventListener('focus', focused);
    for (const name of intentEvents) host.current.addEventListener(name, intent, { capture: true });
    // 未就绪（正在接回或重连）与尚未取得输入权时都暂存输入，接回并取得输入权后按顺序补发。
    const input = term.onData(data => {
      // 进程已结束时不再发送输入（终端只保留最后的画面）。
      if (!runningRef.current) return;
      if (ready && owns) { sendInput(data); return; }
      if (Date.now() - intentAt > 1500) return;
      if (pendingInput.length + data.length <= 4096) pendingInput += data;
      takeover();
    });
    const write = (data: Uint8Array) => new Promise<void>(resolve => term.write(data, resolve));
    const connect = () => {
      if (disposed) return;
      connectionId = ''; ready = false; owns = false; requested = false; setOwner(false); setConnection('connecting');
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/terminals/${encodeURIComponent(record.terminalId)}/stream`); socket = ws;
      ws.onmessage = event => {
        if (disposed || ws !== socket || ws.readyState !== WebSocket.OPEN) return;
        const raw = String(event.data); const length = new TextEncoder().encode(raw).length;
        if (length > TERMINAL_LIMITS.frameBytes) { setError('终端帧超过上限。'); ws.close(); return; }
        pendingBytes += length;
        // 帧为 JSON 与 base64，体积约为输出的 1.4 倍；超过服务端允许的未确认量后本地也不再积累。
        if (pendingBytes > 2 * TERMINAL_LIMITS.unacknowledgedBytes) { setError('画面写入积压，正在重新接回。'); ws.close(); return; }
        queue = queue.then(async () => {
          if (disposed || ws !== socket || ws.readyState !== WebSocket.OPEN) return;
          const message: unknown = JSON.parse(raw);
          if (!CheckSchema(TerminalServerMessageSchema, message) || message.instanceId !== record.instanceId) throw new Error('终端消息或实例无效。');
          if (message.type === 'attached') { connectionId = message.connectionId; owns = message.ownerConnectionId === connectionId; }
          else {
            if (message.connectionId !== connectionId) throw new Error('终端连接已失效。');
            if (message.type === 'snapshot-begin') {
              term.reset(); term.resize(message.size.cols, message.size.rows); snapshotId = message.snapshotId; snapshotOffset = 0; watermark = message.watermark; setTrimmed(message.historyTrimmed);
            } else if (message.type === 'snapshot-data') {
              if (message.snapshotId !== snapshotId || message.offset !== snapshotOffset) throw new Error('快照片段不连续。');
              const data = bytes(message.data); snapshotOffset += data.length; await write(data);
            } else if (message.type === 'snapshot-end') {
              if (message.snapshotId !== snapshotId || message.watermark !== watermark) throw new Error('快照水位无效。');
              snapshotId = null; ready = true; send({ type: 'ack', watermark } as TerminalClientMessage); setConnection('connected'); setError(''); resize(); read();
              if (owns) flushInput(); else if (pendingInput) takeover();
            } else if (message.type === 'output') {
              const data = bytes(message.data);
              if (!ready || message.from !== watermark || message.watermark - message.from !== data.length) throw new Error('终端输出水位不连续。');
              await write(data); if (disposed || ws !== socket || ws.readyState !== WebSocket.OPEN) return; watermark = message.watermark; send({ type: 'ack', watermark } as TerminalClientMessage); read();
            } else if (message.type === 'owner') {
              owns = message.ownerConnectionId === connectionId; requested = false; term.resize(message.size.cols, message.size.rows);
              if (owns) { resize(); flushInput(); } else pendingInput = '';
            }
            else if (message.type === 'error') { if (message.code === 'NOT_OWNER') requested = false; else setError(message.message); }
            else if (message.type === 'exit') void refresh();
          }
          setOwner(owns);
        }).catch(error => { setError(error instanceof Error ? error.message : '画面同步失败。'); ws.close(); }).finally(() => { pendingBytes -= length; });
      };
      ws.onclose = () => {
        if (disposed || ws !== socket) return;
        ready = false; owns = false; requested = false; setOwner(false); setConnection('disconnected');
        // 断线后先刷新终端状态再重连：服务重启等情况下进程已不在，不再反复连接已没有画面的终端。
        void refresh();
        timer = window.setTimeout(() => { if (runningRef.current) void queue.then(connect); }, 1500);
      };
      ws.onerror = () => setError('终端连接不可用，请检查本机入口与进程状态。');
    };
    // 下一轮再连接：开发模式 StrictMode 会立即卸载并重新挂载，先挂载的那次在建连前就被取消。
    const start = window.setTimeout(connect, 0);
    const visibility = () => { if (document.visibilityState === 'visible') { read(); resize(); } };
    window.addEventListener('focus', visibility); document.addEventListener('visibilitychange', visibility);
    return () => { disposed = true; focusTerminal.current = () => {}; window.clearTimeout(start); window.clearTimeout(timer); closeSocket(socket); term.textarea?.removeEventListener('focus', focused); for (const name of intentEvents) hostElement.removeEventListener(name, intent, { capture: true }); input.dispose(); observer.disconnect(); term.dispose(); window.removeEventListener('focus', visibility); document.removeEventListener('visibilitychange', visibility); };
  }, [record.terminalId, record.instanceId, detached]);

  useEffect(() => {
    if (visible && record.closedAt === null && (record.unread || record.notificationCount)) void terminalAction(record.terminalId, 'read', { instanceId: record.instanceId }).then(refresh).catch(() => {});
  }, [visible, record.unread, record.notificationCount, record.terminalId, record.instanceId, record.closedAt, refresh]);
  useEffect(() => { const handler = () => setFullscreen(document.fullscreenElement === root.current); document.addEventListener('fullscreenchange', handler); return () => document.removeEventListener('fullscreenchange', handler); }, []);
  useEffect(() => { if (!visible) setMenuOpen(false); }, [visible]);

  const isCodex = record.preset.kind === 'codex' && agentSessionTrackable(record.preset);

  /** 菜单键盘操作与会话标题栏菜单一致：上下切换，Esc 收起并回到触发按钮，Tab 收起。 */
  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') { event.stopPropagation(); setMenuOpen(false); menuTrigger.current?.focus(); return; }
    if (event.key === 'Tab') { setMenuOpen(false); return; }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const items = [...(menuList.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLElement);
    items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  }

  async function action(kind: 'end' | 'close' | 'reopen', mode: 'resume' | 'new' = 'resume') {
    setBusy(true); setError('');
    try {
      await terminalAction(record.terminalId, kind, { instanceId: record.instanceId, ...(kind === 'close' ? { confirmRunning: true } : kind === 'reopen' ? { size: { cols: 80, rows: 24 }, mode } : {}) });
      await refresh();
      if (kind === 'close') onClosed();
    } catch (error) { setError(error instanceof Error ? error.message : '终端操作失败。'); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    if (!visible || !lostWithService || !agentResumable || record.closedAt || autoResumed.current === record.instanceId) return;
    autoResumed.current = record.instanceId;
    void action('reopen', 'resume');
  }, [visible, lostWithService, agentResumable, record.closedAt, record.instanceId]);

  function close() {
    if (!running) { void action('close'); return; }
    void confirm({ title: `关闭「${record.title}」`, description: '这会结束该终端进程及已归属的后代进程，然后关闭终端。', tone: 'danger', confirmLabel: '结束并关闭', action: () => action('close') });
  }
  const run = (task: () => void) => () => { setMenuOpen(false); task(); };

  // coding agent 可接回时，默认继续原会话，另可开始新会话；其他终端只能用原命令重新打开。
  const reopenButtons = agentResumable ? <>
    <button type="button" className="secondary-button" disabled={busy} title="开始一个新会话" onClick={() => void action('reopen', 'new')}>新会话</button>
    <button type="button" className="primary-button" disabled={busy} title="接回同一个会话" onClick={() => void action('reopen', 'resume')}><RotateCcw aria-hidden="true" />继续原会话</button>
  </> : <button type="button" className="primary-button" disabled={busy} title="在原目录用原命令启动新进程" onClick={() => void action('reopen')}><RotateCcw aria-hidden="true" />重新打开终端</button>;
  const connectionNote = running && !detached ? (connection === 'connecting' ? '正在接回画面' : connection === 'disconnected' ? '连接已断开，正在重连' : '') : '';
  const ended = !running || Boolean(record.closedAt);
  // 标题栏沿用会话面板的结构与样式：栏位标记、名称、信息行，右侧为更多操作与放大/返回并排。
  return <section className={`terminal-view${current ? ' active' : ''}${focused ? ' focused' : ''}`} ref={root} aria-label={`终端：${record.title}`} data-terminal-id={record.terminalId} data-connection={connection} data-owner={owner}
    onPointerDownCapture={onActivate} onFocusCapture={onActivate}
    onPointerDown={event => { if (!(event.target as Element).closest('header')) focusTerminal.current(); }}>
    <header className="conversation-header terminal-header">
      <div className="conversation-title">
        <div>
          <div className="conversation-name">
            {slotLabel && <span className="slot-tag">{slotLabel}</span>}
            <h2 title={record.title}>{record.title}</h2>
            <AgentMark preset={record.preset} />
          </div>
          {/* 信息行与会话一致：可展开的目录说明在前；正常运行时不显示状态，只有结束、正在结束等情况才显示。 */}
          <div className="session-meta terminal-meta">
            <TerminalDirectory path={record.directory} />
            {(!running || record.status !== 'running') && <span className="terminal-status">{statusText(record)}</span>}
            {connectionNote && <span>{connectionNote}</span>}
          </div>
        </div>
      </div>
      <div className="conversation-tools">
        {fullscreen && <button type="button" className="icon-button" title="退出全屏" aria-label="退出终端全屏" onClick={() => void document.exitFullscreen()}><Shrink aria-hidden="true" /></button>}
        <div className="session-menu" ref={menuRef} onKeyDown={menuOpen ? onMenuKeyDown : undefined}>
          <button type="button" ref={menuTrigger} className="icon-button" aria-label={`「${record.title}」的更多操作`} title="更多操作" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(value => !value)}><MoreHorizontal aria-hidden="true" /></button>
          {menuOpen && <div className="session-menu-list" role="menu" aria-label={`「${record.title}」的更多操作`} ref={menuList}>
            {!fullscreen && <button type="button" role="menuitem" onClick={run(() => void root.current?.requestFullscreen())}><Expand aria-hidden="true" />终端全屏</button>}
            {running && <button type="button" role="menuitem" disabled={busy} onClick={run(() => void action('end'))}><Power aria-hidden="true" />结束进程</button>}
            {!record.closedAt && <button type="button" role="menuitem" disabled={busy} onClick={run(close)}><X aria-hidden="true" />关闭终端</button>}
          </div>}
        </div>
        {focused
          ? <button type="button" className="return-parallel" onClick={onReturnToParallel}><Columns2 aria-hidden="true" />返回并排</button>
          : <button type="button" className="icon-button" aria-label={`放大「${record.title}」`} title="放大终端" onClick={onFocus}><Maximize2 aria-hidden="true" /></button>}
      </div>
    </header>
    {error && <p role="alert" className="terminal-error">{error}<button type="button" className="icon-button" aria-label="关闭提示" onClick={() => setError('')}><X /></button></p>}
    <div className="terminal-canvas">
      {trimmed && <p className="terminal-trimmed">较早的画面已裁剪，保留最近 {TERMINAL_LIMITS.scrollback} 行</p>}
      <div className="terminal-host" ref={host} />
      {connection === 'connecting' && !detached && <p className="terminal-connecting" role="status"><LoaderCircle className="spin" aria-hidden="true" />正在接回画面…</p>}
      {ended && !detached && <div className="terminal-ended-bar" role="status">
        <span><b>进程已结束</b>{statusText(record)}</span>
        <button type="button" className="secondary-button" disabled={busy} onClick={() => void action('close')}>关闭终端</button>
        {reopenButtons}
      </div>}
      {ended && detached && agentResumable && lostWithService && busy && <p className="terminal-connecting" role="status"><LoaderCircle className="spin" aria-hidden="true" />正在接回原会话…</p>}
      {ended && detached && !(agentResumable && lostWithService && busy) && <div className="terminal-ended">
        <div className="terminal-ended-card">
          <h3><TerminalBadge preset={record.preset} />终端进程已结束</h3>
          {record.lastExit && <p>{exitText(record.lastExit)}{record.lastExit.reason === 'multivac-restarted' ? '，重启后不恢复终端进程' : ''}</p>}
          <dl>
            <dt>目录</dt><dd title={record.directory}>{record.directory}</dd>
            <dt>命令</dt><dd>{presetCommand(record.preset)}</dd>
          </dl>
          <div className="terminal-ended-actions">
            <button type="button" className="secondary-button" disabled={busy} onClick={() => void action('close')}>关闭终端</button>
            {reopenButtons}
          </div>
          <small>{agentResumable ? '继续原会话会在原目录接回同一个会话；会话内容由 CLI 自己保存。'
            : isCodex ? '没有记录 Codex 会话 ID（启动时 Codex app-server 不可用），重新打开会开始新会话。'
            : '重新打开会在原目录用原命令启动新进程。'}</small>
        </div>
      </div>}
    </div>
  </section>;
}
