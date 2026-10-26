import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { Check } from 'typebox/value';
import { CreateTerminalSchema, ListTerminalsSchema, GetTerminalSchema, RenameTerminalSchema, EndTerminalSchema, CloseTerminalSchema,
  ReopenTerminalSchema, ReadTerminalSchema, TerminalClientMessageSchema, TERMINAL_BODY_LIMIT_BYTES, TERMINAL_LIMITS,
  type TerminalServerMessage, type TerminalSize } from '@multivac/contracts';
import { TerminalError, type TerminalService, type TerminalRuntime, type TerminalRuntimeEvent } from '../../application/terminal-service.js';
import { assertTerminalOwner, type TerminalConnectionState } from '../../modules/terminals/terminal-record.js';
import { guardTerminalUpgrade } from './terminal-entry.js';
import type { RemoteAccess } from './remote-access.js';
import { readJsonBody, RequestBodyTooLargeError } from './json-body.js';
function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(value));
}
export function createTerminalRoutes(service: TerminalService) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/api/terminals')) return false;
    try {
      if (url.searchParams.size || !['POST', 'PATCH'].includes(request.method ?? '')) throw new TerminalError(400, '终端请求方法或查询参数无效。');
      if (!request.headers['content-type']?.startsWith('application/json')) throw new TerminalError(415, '必须使用 application/json。');
      const body = await readJsonBody(request, TERMINAL_BODY_LIMIT_BYTES);
      if (url.pathname === '/api/terminals/capabilities' && Check(GetTerminalSchema, body)) { json(response, 200, { supported: true }); return true; }
      const match = /^\/api\/terminals(?:\/([A-Za-z0-9._:-]+)(?:\/(get|end|close|reopen|read))?)?$/.exec(url.pathname);
      if (!match) throw new TerminalError(404, '终端接口不存在。');
      const [, id, action] = match;
      let value: unknown;
      if (request.method === 'POST' && id === 'list' && !action && Check(ListTerminalsSchema, body)) value = { terminals: service.list(body.projectId, body.includeClosed) };
      else if (request.method === 'POST' && !id && Check(CreateTerminalSchema, body)) value = { terminal: service.create(body) };
      else if (request.method === 'PATCH' && id && !action && Check(RenameTerminalSchema, body)) value = { terminal: service.rename(id, body.title) };
      else if (request.method === 'POST' && id && action === 'get' && Check(GetTerminalSchema, body)) value = { terminal: service.get(id) };
      else if (request.method === 'POST' && id && action === 'end' && Check(EndTerminalSchema, body)) value = { terminal: await service.end(id, body.instanceId) };
      else if (request.method === 'POST' && id && action === 'close' && Check(CloseTerminalSchema, body)) value = { terminal: await service.closeTerminal(id, body.instanceId, body.confirmRunning) };
      else if (request.method === 'POST' && id && action === 'reopen' && Check(ReopenTerminalSchema, body)) value = { terminal: service.reopen(id, body.instanceId, body.size) };
      else if (request.method === 'POST' && id && action === 'read' && Check(ReadTerminalSchema, body)) value = { terminal: service.read(id, body.instanceId) };
      else throw new TerminalError(400, '终端参数无效。');
      json(response, 200, value);
    } catch (error) {
      const status = error instanceof TerminalError ? error.status : error instanceof RequestBodyTooLargeError ? 413 : error instanceof SyntaxError ? 400 : 500;
      json(response, status, { error: { code: status === 404 ? 'NOT_FOUND' : status === 409 ? 'COMMAND_STATE_MISMATCH' : 'INVALID_REQUEST',
        message: error instanceof TerminalError ? error.message : status === 500 ? '终端操作失败，请检查项目目录及进程状态。' : '终端请求体无效或超过上限。' } });
    }
    return true;
  };
}
interface WindowConnection {
  socket: WebSocket; state: TerminalConnectionState; runtime: TerminalRuntime;
  send(message: Omit<TerminalServerMessage, 'instanceId' | 'connectionId'>): void;
}
export function attachTerminalWebSockets(server: Server, service: TerminalService, access: RemoteAccess): () => void {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: TERMINAL_LIMITS.frameBytes });
  const connections = new Set<WindowConnection>();
  const controls = new WeakMap<TerminalRuntime, Promise<void>>();
  const control = (runtime: TerminalRuntime, action: () => Promise<void>) => {
    const next = (controls.get(runtime) ?? Promise.resolve()).then(action);
    controls.set(runtime, next.catch(() => {})); return next;
  };
  const connect = (socket: WebSocket, id: string) => {
    const record = service.get(id);
    const runtime = service.runtime(id);
    if (!runtime || record.closedAt) { socket.close(1008, '终端画面不存在，请重新打开终端。'); return; }
    const state: TerminalConnectionState = { instanceId: record.instanceId, connectionId: randomUUID(), acknowledged: 0, sent: 0, attached: true };
    let joining = true;
    type RuntimeEvent = TerminalRuntimeEvent;
    let buffered: Exclude<RuntimeEvent, { type: 'exit' }>[] = [];
    let bufferedBytes = 0;
    let pendingControlBytes = 0;
    const send = (message: Omit<TerminalServerMessage, 'instanceId' | 'connectionId'>, callback?: (error?: Error) => void) => {
      if (socket.readyState !== WebSocket.OPEN) { callback?.(new Error('连接已断开。')); return; }
      const frame = JSON.stringify({ ...message, instanceId: state.instanceId, connectionId: state.connectionId });
      if (Buffer.byteLength(frame) > TERMINAL_LIMITS.frameBytes) throw new Error('终端帧超过上限。');
      if (socket.bufferedAmount > TERMINAL_LIMITS.unacknowledgedBytes) { socket.terminate(); return; }
      socket.send(frame, callback);
    };
    const connection: WindowConnection = { socket, state, runtime, send };
    connections.add(connection);
    if (runtime.owner === null) runtime.owner = state.connectionId;
    send({ type: 'attached', ownerConnectionId: runtime.owner } as TerminalServerMessage);
    const fail = (code: 'SLOW_WINDOW' | 'SNAPSHOT_TIMEOUT' | 'INVALID_MESSAGE' | 'STALE_INSTANCE', message: string) => {
      send({ type: 'error', code, message } as TerminalServerMessage); socket.close(1008, code);
      setTimeout(() => { if (socket.readyState !== WebSocket.CLOSED) socket.terminate(); }, 1000).unref();
    };
    const output = ({ data, from, watermark }: { data: Buffer; from: number; watermark: number }) => {
      if (watermark <= state.sent) return;
      if (from !== state.sent || watermark - state.acknowledged > TERMINAL_LIMITS.unacknowledgedBytes) { fail('SLOW_WINDOW', '窗口输出积压，请重新接回。'); return; }
      for (let offset = 0; offset < data.length; offset += 8192) {
        const chunk = data.subarray(offset, offset + 8192);
        send({ type: 'output', from: from + offset, watermark: from + offset + chunk.length, data: chunk.toString('base64') } as TerminalServerMessage);
      }
      state.sent = watermark;
    };
    const deliver = (event: Exclude<RuntimeEvent, { type: 'exit' }>) => {
      if (event.type === 'output') output(event);
      else send({ type: 'owner', ownerConnectionId: event.ownerConnectionId, size: event.size } as TerminalServerMessage);
    };
    const listener: TerminalRuntime['listeners'] extends Set<infer T> ? T : never = event => {
      if (event.type === 'exit') { if (!joining) send({ type: 'exit', exit: event.exit } as TerminalServerMessage); return; }
      if (joining) {
        bufferedBytes += event.type === 'output' ? event.data.length : 128;
        if (bufferedBytes > TERMINAL_LIMITS.unacknowledgedBytes) { buffered = []; fail('SLOW_WINDOW', '接回期间输出超过上限，请重试。'); }
        else buffered.push(event);
      } else deliver(event);
    };
    runtime.listeners.add(listener);
    void runtime.screen.snapshot().then(async snapshot => {
      if (!state.attached) return;
      state.sent = state.acknowledged = snapshot.watermark;
      const snapshotId = randomUUID();
      send({ type: 'snapshot-begin', snapshotId, watermark: snapshot.watermark, size: snapshot.size, historyTrimmed: snapshot.historyTrimmed } as TerminalServerMessage);
      for (let offset = 0; offset < snapshot.data.length; offset += 8192) {
        if (!state.attached || socket.readyState !== WebSocket.OPEN) return;
        // 写回调限制快照发送队列，不把大快照一次塞满 ws 缓冲。
        await new Promise<void>((resolve, reject) => send({ type: 'snapshot-data', snapshotId, offset, data: snapshot.data.subarray(offset, offset + 8192).toString('base64') } as TerminalServerMessage, error => error ? reject(error) : resolve()));
      }
      if (!state.attached) return;
      send({ type: 'snapshot-end', snapshotId, watermark: snapshot.watermark } as TerminalServerMessage);
      joining = false;
      for (const chunk of buffered) if (chunk.sequence > snapshot.sequence) deliver(chunk);
      buffered = []; bufferedBytes = 0;
      const current = service.get(id);
      if (current.instanceId !== state.instanceId) { fail('STALE_INSTANCE', '终端已重新打开。'); return; }
      if (current.lastExit?.instanceId === state.instanceId) send({ type: 'exit', exit: current.lastExit } as TerminalServerMessage);
    }).catch(() => { if (state.attached) fail('SNAPSHOT_TIMEOUT', '画面尚未形成完整边界，请重试接回。'); });
    socket.on('message', (data, binary) => {
      const receivedBytes = Buffer.byteLength(data.toString());
      if (!state.attached || socket.readyState !== WebSocket.OPEN) return;
      pendingControlBytes += receivedBytes;
      if (pendingControlBytes > TERMINAL_LIMITS.unacknowledgedBytes) { fail('SLOW_WINDOW', '窗口控制消息积压。'); return; }
      void control(runtime, async () => {
        try {
          if (!state.attached) return;
          if (binary || Buffer.byteLength(data.toString()) > TERMINAL_LIMITS.frameBytes) throw new Error('消息格式无效。');
          const message: unknown = JSON.parse(data.toString());
          if (!Check(TerminalClientMessageSchema, message)) throw new Error('消息格式无效。');
          if (service.get(id).instanceId !== state.instanceId || service.runtime(id) !== runtime) { fail('STALE_INSTANCE', '终端实例已变更。'); return; }
          assertTerminalOwner(state, message, runtime.owner);
          if (message.type === 'ack') state.acknowledged = message.watermark;
          else if (message.type === 'read') service.read(id, state.instanceId);
          else if (message.type === 'input') {
            if (service.get(id).status !== 'running') throw new Error('终端进程已结束或正在停止。');
            runtime.process.pty.write(message.data);
          }
          else if (message.type === 'resize' || message.type === 'takeover') {
            if (message.type === 'takeover') runtime.owner = state.connectionId;
            await runtime.screen.resize(message.size);
            if (service.get(id).status === 'running') runtime.process.pty.resize(message.size.cols, message.size.rows);

          }
        } catch (error) {
          if (runtime.owner !== state.connectionId) send({ type: 'error', code: 'NOT_OWNER', message: '此窗口只读，请先接管。' } as TerminalServerMessage);
          else fail('INVALID_MESSAGE', error instanceof Error ? error.message : '终端消息无效。');
        } finally { pendingControlBytes -= receivedBytes; }
      });
    });
    socket.on('error', () => socket.terminate());
    socket.once('close', () => {
      state.attached = false; connections.delete(connection); runtime.listeners.delete(listener); buffered = [];
      void control(runtime, async () => {
        if (runtime.owner === state.connectionId) { runtime.owner = null; await runtime.screen.resize({ cols: runtime.screen.terminal.cols, rows: runtime.screen.terminal.rows }); }
      });
    });
  };
  server.on('upgrade', (request, socket, head) => {
    // 无论路径如何，先核对完整本机来源，之后才读取终端。
    if (!guardTerminalUpgrade(request, socket, access)) return;
    let id: string | undefined;
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      id = /^\/api\/terminals\/([A-Za-z0-9._:-]+)\/stream$/.exec(url.pathname)?.[1];
      if (!id || url.searchParams.size || !service.runtime(id) || service.get(id).closedAt) throw new Error('missing');
    } catch { socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
    wss.handleUpgrade(request, socket, head, ws => connect(ws, id!));
  });
  return () => { for (const { socket } of connections) socket.terminate(); wss.close(); };
}
