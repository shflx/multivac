import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Check } from 'typebox/value';
import { TerminalServerMessageSchema, terminalIsActive, TERMINAL_LIMITS, type ProjectTerminal, type TerminalClientMessage, type TerminalSize } from '@multivac/contracts';
import { Maximize2, Minimize2, TerminalSquare } from 'lucide-react';
import { terminalAction } from '../../data/terminal-api.js';
import { useConfirm } from '../../components/confirm-card.js';
import { useTerminals } from './terminals-provider.js';
import '@xterm/xterm/css/xterm.css';
import './terminals.css';
const size = (term: Terminal): TerminalSize => ({ cols: Math.max(10, Math.min(240, term.cols)), rows: Math.max(4, Math.min(100, term.rows)) });
function bytes(base64: string): Uint8Array { return Uint8Array.from(atob(base64), char => char.charCodeAt(0)); }
const exitReasons = { 'process-exit': '程序退出', 'user-ended': '用户结束', 'project-removed': '项目移除', 'directory-removed': '目录移除', 'service-shutdown': '服务退出', 'multivac-restarted': 'Multivac 重启', 'spawn-failed': '启动失败' };
export function TerminalView({ record, visible }: { record: ProjectTerminal; visible: boolean }) {
  const { refresh, select } = useTerminals(); const confirm = useConfirm();
  const root = useRef<HTMLDivElement>(null); const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState(''); const [status, setStatus] = useState('正在接回画面');
  const [owner, setOwner] = useState(false); const [trimmed, setTrimmed] = useState(false);
  const [fullscreen, setFullscreen] = useState(false); const [reconnect, setReconnect] = useState(0);
  const [renaming, setRenaming] = useState(false); const [title, setTitle] = useState(record.title);
  const [busy, setBusy] = useState(false);
  const takeover = useRef<() => void>(() => {});
  const active = useRef(visible); active.current = visible;
  useEffect(() => {
    if (!host.current) return;
    if (record.closedAt || record.lastExit?.reason === 'multivac-restarted' || record.status === 'failed') { setOwner(false); setStatus(record.closedAt ? '已关闭' : '本轮画面不可用'); return; }
    let disposed = false; let socket: WebSocket | null = null; let timer: number | undefined;
    let connectionId = ''; let owns = false; let ready = false; let watermark = 0;
    let snapshotId: string | null = null; let snapshotOffset = 0;
    let queue = Promise.resolve(); let pendingBytes = 0;
    const term = new Terminal({ cursorBlink: true, scrollback: 1000, fontSize: 13, fontFamily: 'SFMono-Regular, Menlo, monospace', allowProposedApi: true, disableStdin: true });
    const fit = new FitAddon(); term.loadAddon(fit); term.loadAddon(new WebLinksAddon((_event, url) => window.open(url, '_blank', 'noopener,noreferrer')));
    term.open(host.current);
    // 设备查询由服务端 headless 唯一应答，跟随窗口不能重复应答。
    for (const final of ['c', 'n']) for (const prefix of ['', '?', '>']) term.parser.registerCsiHandler({ final, ...(prefix ? { prefix } : {}) }, () => true);
    for (const osc of [10, 11, 12]) term.parser.registerOscHandler(osc, data => data === '?');
    const theme = () => {
      const styles = getComputedStyle(document.documentElement);
      term.options.theme = { background: styles.getPropertyValue('--surface').trim(), foreground: styles.getPropertyValue('--ink').trim(), cursor: styles.getPropertyValue('--ink').trim(), selectionBackground: styles.getPropertyValue('--accent-muted').trim() };
    };
    theme(); const themeObserver = new MutationObserver(theme); themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
    const send = (message: Omit<TerminalClientMessage, 'connectionId' | 'instanceId'>) => {
      if (socket?.readyState === WebSocket.OPEN && connectionId) socket.send(JSON.stringify({ ...message, connectionId, instanceId: record.instanceId }));
    };
    const read = () => { if (active.current && ready) send({ type: 'read' }); };
    const resize = () => {
      if (!host.current?.clientWidth || !active.current) return;
      const measured = fit.proposeDimensions();
      if (!measured) return;
      const next = { cols: Math.max(10, Math.min(240, measured.cols)), rows: Math.max(4, Math.min(100, measured.rows)) };
      if (owns && ready && (term.cols !== next.cols || term.rows !== next.rows)) send({ type: 'resize', size: next } as TerminalClientMessage);
    };
    takeover.current = () => {
      const measured = fit.proposeDimensions(); const next = measured ? { cols: Math.max(10, Math.min(240, measured.cols)), rows: Math.max(4, Math.min(100, measured.rows)) } : size(term);
      send({ type: 'takeover', size: next } as TerminalClientMessage);
    };
    const observer = new ResizeObserver(resize); observer.observe(host.current);
    const input = term.onData(data => {
      if (!ready || !owns) return;
      // 按字符拆分，中文/emoji 不截断且每帧低于协议上限。
      let chunk = '';
      for (const char of data) { if (chunk.length + char.length > 2048) { send({ type: 'input', data: chunk } as TerminalClientMessage); chunk = ''; } chunk += char; }
      if (chunk) send({ type: 'input', data: chunk } as TerminalClientMessage);
    });
    const write = (data: Uint8Array) => new Promise<void>(resolve => term.write(data, resolve));
    const connect = () => {
      if (disposed) return;
      connectionId = ''; ready = false; owns = false; term.options.disableStdin = true; setOwner(false); setStatus('正在接回画面');
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/terminals/${encodeURIComponent(record.terminalId)}/stream`); socket = ws;
      ws.onmessage = event => {
        if (disposed || ws !== socket || ws.readyState !== WebSocket.OPEN) return;
        const raw = String(event.data); const length = new TextEncoder().encode(raw).length;
        if (length > TERMINAL_LIMITS.frameBytes) { setError('终端帧超过上限。'); ws.close(); return; }
        pendingBytes += length;
        if (pendingBytes > 1024 * 1024) { setError('画面写入积压，正在重新接回。'); ws.close(); return; }
        queue = queue.then(async () => {
          if (disposed || ws !== socket || ws.readyState !== WebSocket.OPEN) return;
          const message: unknown = JSON.parse(raw);
          if (!Check(TerminalServerMessageSchema, message) || message.instanceId !== record.instanceId) throw new Error('终端消息或实例无效。');
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
              snapshotId = null; ready = true; send({ type: 'ack', watermark } as TerminalClientMessage); setStatus('已连接'); setError(''); resize(); read();
            } else if (message.type === 'output') {
              const data = bytes(message.data);
              if (!ready || message.from !== watermark || message.watermark - message.from !== data.length) throw new Error('终端输出水位不连续。');
              await write(data); if (disposed || ws !== socket || ws.readyState !== WebSocket.OPEN) return; watermark = message.watermark; send({ type: 'ack', watermark } as TerminalClientMessage); read();
            } else if (message.type === 'owner') { owns = message.ownerConnectionId === connectionId; term.resize(message.size.cols, message.size.rows); }
            else if (message.type === 'error') setError(message.message);
            else if (message.type === 'exit') { setStatus('进程已结束'); void refresh(); }
          }
          setOwner(owns); term.options.disableStdin = !owns || !ready || !terminalIsActive(record.status);
        }).catch(error => { setError(error instanceof Error ? error.message : '画面同步失败。'); ws.close(); }).finally(() => { pendingBytes -= length; });
      };
      ws.onclose = () => {
        if (disposed || ws !== socket) return;
        ready = false; owns = false; setOwner(false); term.options.disableStdin = true; setStatus('连接已断开');
        // 已结束且没有运行期画面的终端仍保留元数据说明，由用户手动重试或重开。
        if (terminalIsActive(record.status)) timer = window.setTimeout(() => { void queue.then(connect); }, 1500);
      };
      ws.onerror = () => setError('终端连接不可用，请检查本机入口与进程状态。');
    };
    connect();
    const visibility = () => { if (document.visibilityState === 'visible') { read(); resize(); } };
    window.addEventListener('focus', visibility); document.addEventListener('visibilitychange', visibility);
    return () => { disposed = true; window.clearTimeout(timer); socket?.close(); input.dispose(); observer.disconnect(); themeObserver.disconnect(); term.dispose(); window.removeEventListener('focus', visibility); document.removeEventListener('visibilitychange', visibility); };
  }, [record.terminalId, record.instanceId, record.closedAt, reconnect]);
  useEffect(() => {
    if (visible && record.closedAt === null && (record.unread || record.notificationCount)) void terminalAction(record.terminalId, 'read', { instanceId: record.instanceId }).then(refresh).catch(() => {});
  }, [visible, record.unread, record.notificationCount, record.terminalId, record.instanceId, refresh]);
  useEffect(() => { const handler = () => setFullscreen(document.fullscreenElement === root.current); document.addEventListener('fullscreenchange', handler); return () => document.removeEventListener('fullscreenchange', handler); }, []);
  async function action(action: 'end' | 'close' | 'reopen') {
    setBusy(true); setError('');
    try {
      await terminalAction(record.terminalId, action, { instanceId: record.instanceId, ...(action === 'close' ? { confirmRunning: true } : action === 'reopen' ? { size: { cols: 80, rows: 24 } } : {}) });
      await refresh(); if (action === 'close') select(null);
    } catch (error) { setError(error instanceof Error ? error.message : '终端操作失败。'); }
    finally { setBusy(false); }
  }
  const ended = !terminalIsActive(record.status);
  return <section className="terminal-view" ref={root} aria-label={`终端：${record.title}`}>
    <header className="terminal-header"><TerminalSquare /><form onSubmit={event => { event.preventDefault(); setBusy(true); void terminalAction(record.terminalId, 'rename', { title }).then(refresh).then(() => setRenaming(false)).catch(error => setError(String(error))).finally(() => setBusy(false)); }}>
      {renaming ? <><input aria-label="终端名称" value={title} onChange={event => setTitle(event.target.value)} maxLength={80} autoFocus /><button disabled={busy}>保存名称</button><button type="button" onClick={() => setRenaming(false)}>取消</button></> : <button type="button" title="改名" onClick={() => { setTitle(record.title); setRenaming(true); }}>{record.title}</button>}
    </form><span className="terminal-state">{ended ? '已结束' : record.status === 'stop-unconfirmed' ? '结束未确认' : record.status === 'stopping' ? '正在结束' : '运行中'} · {status}{record.unread ? ' · 未读输出' : ''}{record.notificationCount ? ` · 终端通知 ${record.notificationCount}` : ''}</span>
      {!ended && <button disabled={busy} onClick={() => void action('end')}>结束进程</button>}
      <button title={fullscreen ? '退出全屏' : '终端全屏'} aria-label={fullscreen ? '退出终端全屏' : '终端全屏'} onClick={() => void (fullscreen ? document.exitFullscreen() : root.current?.requestFullscreen())}>{fullscreen ? <Minimize2 /> : <Maximize2 />}</button>
      {!record.closedAt && <button disabled={busy} onClick={() => { if (ended) void action('close'); else void confirm({ title: `关闭「${record.title}」`, description: '这会结束该终端进程及已归属后代，然后关闭终端。', tone: 'danger', confirmLabel: '结束并关闭', action: () => action('close') }); }}>关闭终端</button>}{record.closedAt && <button onClick={() => select(null)}>返回工作区</button>}
    </header>
    <div className="terminal-boundary"><strong>外部程序，Multivac 不管控</strong><span>目录仅决定启动位置，不提供文件访问隔离；同目录并发修改可能冲突。未观察到的脱组进程不保证回收。</span></div>
    <div className="terminal-toolbar"><code title={record.directory}>{record.directory}</code>{!ended && <span>{owner ? '此窗口可输入' : '只读跟随'} {!owner && <button onClick={() => takeover.current()}>接管终端</button>}</span>}<button onClick={() => setReconnect(value => value + 1)}>重新接回画面</button></div>
    {trimmed && <p className="terminal-notice">较早画面已裁剪，保留最近 1000 行滚动历史。</p>}
    {error && <p role="alert" className="terminal-error">{error}</p>}
    <div className="terminal-canvas" ref={host} />
    {ended && <footer className="terminal-exit"><p>{record.lastExit ? `${exitReasons[record.lastExit.reason]} · 退出码 ${record.lastExit.code ?? '无'} · 信号 ${record.lastExit.signal ?? '无'}` : '终端已结束'} · {record.preset.kind === 'blank' ? '交互 shell' : record.preset.kind === 'custom' ? `${record.preset.executable} ${JSON.stringify(record.preset.argv)}` : `${record.preset.kind} ${JSON.stringify(record.preset.argv)}`}</p><p>重新打开会在原目录使用原命令创建新实例，不能恢复 CLI 原会话。</p><button disabled={busy} onClick={() => void action('reopen')}>重新打开终端</button></footer>}
  </section>;
}
