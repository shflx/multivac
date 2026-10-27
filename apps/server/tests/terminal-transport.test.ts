import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nativeTerminalProcess } from '../src/runtime/executors/process-runtime.js';
import { WebSocket } from 'ws';
import headless from '@xterm/headless';
import { Check } from 'typebox/value';
import { TerminalServerMessageSchema, type TerminalServerMessage, type ProjectTerminal } from '@multivac/contracts';
import { TerminalService } from '../src/application/terminal-service.js';
import { WorkbenchEvents } from '../src/application/workbench-events.js';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';
import { createTerminalRoutes, attachTerminalWebSockets } from '../src/adapters/http/terminal-routes.js';
import { guardTerminalHttp } from '../src/adapters/http/terminal-entry.js';
import { RemoteAccess } from '../src/adapters/http/remote-access.js';
const size = { cols: 80, rows: 24 };
async function until(check: () => boolean, timeout = 8000) {
  const start = Date.now(); while (!check()) { if (Date.now() - start > timeout) throw new Error('等待终端事实超时'); await new Promise(resolve => setTimeout(resolve, 20)); }
}
async function windowFor(url: string, origin: string, autoAck = true) {
  const socket = new WebSocket(url, { origin });
  const messages: TerminalServerMessage[] = []; let connectionId = ''; let instanceId = ''; let data = ''; let snapshot = '';
  const send = (message: Record<string, unknown>) => socket.send(JSON.stringify({ ...message, connectionId, instanceId }));
  socket.on('message', raw => {
    assert.ok(raw.length <= 16384); const message: unknown = JSON.parse(raw.toString()); assert.ok(Check(TerminalServerMessageSchema, message));
    messages.push(message); connectionId = message.connectionId; instanceId = message.instanceId;
    if (message.type === 'snapshot-data') snapshot += Buffer.from(message.data, 'base64').toString();
    if (message.type === 'output') { data += Buffer.from(message.data, 'base64').toString(); if (autoAck) send({ type: 'ack', watermark: message.watermark }); }
    if (message.type === 'snapshot-end' && autoAck) send({ type: 'ack', watermark: message.watermark });
  });
  await once(socket, 'open'); await until(() => messages.some(message => message.type === 'snapshot-end'));
  return { socket, messages, send, get data() { return data; }, get snapshot() { return snapshot; }, get connectionId() { return connectionId; } };
}
test('真实HTTP/WS：来源拒绝、刷新快照、多窗口接管、慢窗口隔离、结束及重开', { skip: process.platform !== 'darwin' || process.arch !== 'arm64', timeout: 30000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'multivac-terminal-integration-'));
  const store = new SqliteAssistantStore(join(root, 'metadata.sqlite'));
  const created = store.projects.create({ projectId: 'terminal-test', name: '终端集成', directories: [{ kind: 'mounted', path: root }], defaultConstraints: '', createdAt: new Date().toISOString() });
  const events = new WorkbenchEvents(); const eventBodies: string[] = []; events.subscribe(event => eventBodies.push(JSON.stringify(event)));
  const service = new TerminalService(store.terminals, () => created.project, events, nativeTerminalProcess);
  const access = new RemoteAccess({ enabled: false, token: '', origin: '', host: '127.0.0.1' });
  const route = createTerminalRoutes(service);
  const server = createServer((request, response) => { if (guardTerminalHttp(request, response, access)) void route(request, response); });
  const closeSockets = attachTerminalWebSockets(server, service, access);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (path: string, body: unknown, source: string | null = origin) => fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(source ? { origin: source } : {}) }, body: JSON.stringify(body) });
  let record: ProjectTerminal | undefined;
  const sockets: WebSocket[] = [];
  try {
    for (const source of [null, 'http://evil.example', 'http://localhost:9999']) assert.equal((await post('/api/terminals/list', { projectId: 'terminal-test' }, source)).status, 403);
    const bad = new WebSocket(`${origin.replace('http', 'ws')}/api/terminals/missing/stream`, { origin: 'http://evil.example' });
    await new Promise<void>((resolve, reject) => { bad.on('unexpected-response', (_req, response) => { assert.equal(response.statusCode, 403); response.resume(); bad.terminate(); resolve(); }); bad.on('open', () => reject(new Error('非法upgrade通过'))); bad.on('error', () => {}); });
    const response = await post('/api/terminals', { projectId: 'terminal-test', preset: { kind: 'blank' }, size }); assert.equal(response.status, 200);
    record = (await response.json() as { terminal: ProjectTerminal }).terminal;
    const url = `${origin.replace('http', 'ws')}/api/terminals/${record.terminalId}/stream`;
    const first = await windowFor(url, origin); sockets.push(first.socket);
    first.send({ type: 'input', data: "printf '\\nECHO-%s\\n' VERIFIED\r" }); await until(() => first.data.includes('ECHO-VERIFIED'));
    const second = await windowFor(url, origin); sockets.push(second.socket); assert.match(second.snapshot, /ECHO-VERIFIED/);
    second.send({ type: 'input', data: 'SHOULD_NOT_RUN\r' }); await until(() => second.messages.some(message => message.type === 'error' && message.code === 'NOT_OWNER'));
    second.send({ type: 'takeover', size: { cols: 100, rows: 30 } });
    await until(() => first.messages.some(message => message.type === 'owner' && message.ownerConnectionId === second.connectionId && message.size.cols === 100));
    second.send({ type: 'input', data: "printf '\\nTAKEOVER-%s\\n' OK\r" }); await until(() => first.data.includes('TAKEOVER-OK'));
    first.socket.close(); await once(first.socket, 'close');
    second.send({ type: 'input', data: "for i in 1 2 3 4 5; do printf 'DETACHED-LINE-%s\\n' $i; done\r" }); await until(() => second.data.includes('DETACHED-LINE-5'));
    const rejoined = await windowFor(url, origin); sockets.push(rejoined.socket);
    const restored = new headless.Terminal({ cols: 100, rows: 30, allowProposedApi: true, scrollback: 1000 });
    await new Promise<void>(resolve => restored.write(rejoined.snapshot, resolve));
    const lines = Array.from({ length: restored.buffer.active.length }, (_, index) => restored.buffer.active.getLine(index)?.translateToString(true));
    for (let i = 1; i <= 5; i++) assert.equal(lines.filter(line => line === `DETACHED-LINE-${i}`).length, 1); restored.dispose();
    second.send({ type: 'takeover', size: { cols: 120, rows: 31 } });
    rejoined.send({ type: 'takeover', size: { cols: 90, rows: 32 } });
    const lastOwner = (window: typeof second) => window.messages.filter(message => message.type === 'owner').at(-1);
    await until(() => {
      const a = lastOwner(second); const b = lastOwner(rejoined);
      return !!a && !!b && a.type === 'owner' && b.type === 'owner' && a.ownerConnectionId === b.ownerConnectionId && a.size.cols === b.size.cols;
    });
    second.send({ type: 'takeover', size: { cols: 100, rows: 30 } });
    await until(() => { const owner = lastOwner(second); return owner?.type === 'owner' && owner.ownerConnectionId === second.connectionId && owner.size.cols === 100; });
    const slow = await windowFor(url, origin, false); sockets.push(slow.socket);
    second.send({ type: 'input', data: "yes BACKPRESSURE | head -n 40000; printf '\\nFAST-WINDOW-DONE\\n'\r" });
    await until(() => second.data.includes('\r\nFAST-WINDOW-DONE\r\n'), 10000);
    // 不确认的慢窗口不被断开：未确认超过上限后暂停发送；确认完已发内容后补发当前画面快照。
    assert.equal(slow.socket.readyState, WebSocket.OPEN);
    const slowStart = slow.messages.find(message => message.type === 'snapshot-begin')!;
    const slowLast = slow.messages.filter(message => message.type === 'output').at(-1)!;
    assert.ok(slowStart.type === 'snapshot-begin' && slowLast.type === 'output' && slowLast.watermark - slowStart.watermark <= 256 * 1024 + 16 * 1024);
    slow.send({ type: 'ack', watermark: slowLast.watermark });
    await until(() => slow.messages.filter(message => message.type === 'snapshot-end').length === 2, 10000);
    assert.ok(slow.snapshot.includes('FAST-WINDOW-DONE'));
    assert.equal(second.socket.readyState, WebSocket.OPEN);
    assert.ok(!eventBodies.join('').includes('ECHO-VERIFIED')); assert.ok(!eventBodies.join('').includes('BACKPRESSURE'));
    const deniedClose = await post(`/api/terminals/${record.terminalId}/close`, { instanceId: record.instanceId, confirmRunning: false }); assert.equal(deniedClose.status, 409);
    const ended = await post(`/api/terminals/${record.terminalId}/end`, { instanceId: record.instanceId }); assert.equal(ended.status, 200);
    assert.equal(service.get(record.terminalId).status, 'exited');
    const reopened = await post(`/api/terminals/${record.terminalId}/reopen`, { instanceId: record.instanceId, size }); assert.equal(reopened.status, 200);
    const next = (await reopened.json() as { terminal: ProjectTerminal }).terminal; assert.notEqual(record.instanceId, next.instanceId);
    second.send({ type: 'input', data: 'OLD INSTANCE\r' }); await until(() => second.messages.some(message => message.type === 'error' && message.code === 'STALE_INSTANCE'));
    record = next;
    const latest = await windowFor(url, origin); sockets.push(latest.socket); assert.ok(!latest.snapshot.includes('ECHO-VERIFIED'));
    latest.send({ type: 'ack', watermark: Number.MAX_SAFE_INTEGER }); await until(() => latest.socket.readyState === WebSocket.CLOSED);
  } finally {
    for (const socket of sockets) socket.terminate(); closeSockets(); await service.close(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); rmSync(root, { recursive: true, force: true });
  }
});
