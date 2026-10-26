import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { terminalIsActive, type CreateTerminal, type Project, type ProjectTerminal, type TerminalExit, type TerminalSize } from '@multivac/contracts';
import { assertTerminalOperation, selectTerminalDirectory, type TerminalRepository } from '../modules/terminals/terminal-record.js';
import { TerminalScreen } from '../modules/terminals/terminal-screen.js';
import { TerminalProcess } from '../runtime/executors/terminal-process.js';
import type { WorkbenchEvents } from './workbench-events.js';
export class TerminalError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export type TerminalRuntimeEvent = { type: 'output'; data: Buffer; from: number; watermark: number; sequence: number }
  | { type: 'owner'; ownerConnectionId: string | null; size: TerminalSize; sequence: number }
  | { type: 'exit'; exit: TerminalExit };
export interface TerminalRuntime {
  terminalId: string;
  process: TerminalProcess; screen: TerminalScreen; owner: string | null;
  listeners: Set<(event: TerminalRuntimeEvent) => void>;
  endReason?: TerminalExit['reason'];
  stopping?: Promise<ProjectTerminal> | undefined;
  metadataTimer?: ReturnType<typeof setTimeout> | undefined;
}
export class TerminalService {
  private runtimes = new Map<string, TerminalRuntime>();
  private closing = false;
  get hasActivity(): boolean { return this.runtimes.size > 0; }
  private unsubscribe: () => void;
  constructor(readonly repository: TerminalRepository, private readonly project: (id: string) => Project, private readonly events: WorkbenchEvents) {
    repository.endInterrupted(new Date().toISOString());
    this.unsubscribe = events.subscribe(event => {
      if (event.type !== 'workspace.changed' || !event.workspace.project) return;
      const project = event.workspace.project;
      for (const record of repository.list(project.projectId)) if (terminalIsActive(record.status) && !project.directories.some(dir => dir.path === record.directory)) {
        void this.end(record.terminalId, record.instanceId, 'directory-removed').catch(() => {});
      }
    });
  }
  get(id: string): ProjectTerminal { const record = this.repository.get(id); if (!record) throw new TerminalError(404, '终端不存在。'); return record; }
  list(projectId: string, includeClosed = false) { this.requireProject(projectId); return this.repository.list(projectId, includeClosed); }
  runtime(id: string): TerminalRuntime | undefined { return this.runtimes.get(this.get(id).instanceId); }
  private save(record: ProjectTerminal): ProjectTerminal {
    if (!this.repository.replace(record, record.instanceId)) throw new TerminalError(409, '终端实例已变更。');
    this.events.publish({ type: 'terminal.changed', projectId: record.projectId }); return record;
  }
  private requireProject(id: string): Project {
    try { const project = this.project(id); if (project) return project; } catch { /* 统一映射不存在的项目。 */ }
    throw new TerminalError(404, '项目不存在或已移除。');
  }
  private directory(projectId: string, directory?: string): string {
    const project = this.requireProject(projectId);
    try {
      const selected = selectTerminalDirectory(project, directory);
      if (statSync(selected).isDirectory()) return selected;
    } catch (error) {
      throw new TerminalError(400, error instanceof Error ? error.message : '终端目录不可用。');
    }
    throw new TerminalError(400, '终端目录不存在或不是目录。');
  }
  create(input: CreateTerminal): ProjectTerminal {
    if (this.closing) throw new TerminalError(409, '终端服务正在退出。');
    const directory = this.directory(input.projectId, input.directory);
    const now = new Date().toISOString();
    const record: ProjectTerminal = { terminalId: randomUUID(), instanceId: randomUUID(), projectId: input.projectId, directory, preset: input.preset,
      title: input.title ?? (input.preset.kind === 'blank' ? '终端' : input.preset.kind === 'custom' ? input.preset.executable : input.preset.kind),
      status: 'starting', lastExit: null, createdAt: now, instanceStartedAt: now, lastActivityAt: now, closedAt: null, unread: false, notificationCount: 0 };
    record.title = record.title.trim().slice(0, 80);
    this.repository.insert(record); return this.start(record, input.size);
  }
  private start(record: ProjectTerminal, size: TerminalSize): ProjectTerminal {
    try {
      let process: TerminalProcess | undefined;
      const screen = new TerminalScreen(size, { pause: () => process?.pty.pause(), resume: () => process?.pty.resume() });
      try { process = new TerminalProcess(record.directory, record.preset, size); }
      catch (error) { screen.dispose(); throw error; }
      const runtime: TerminalRuntime = { terminalId: record.terminalId, process, screen, owner: null, listeners: new Set() };
      this.runtimes.set(record.instanceId, runtime);
      process.onOutput = data => {
        try { screen.output(data); } catch { void this.end(record.terminalId, record.instanceId, 'user-ended'); }
        const current = this.get(record.terminalId);
        if (current.instanceId !== record.instanceId) return;
        // 元数据和工作台事件合并发布；绝不把输出放入事件。
        if (!runtime.metadataTimer) runtime.metadataTimer = setTimeout(() => {
          runtime.metadataTimer = undefined;
          const current = this.get(record.terminalId);
          if (current.instanceId === record.instanceId) this.save({ ...current, unread: true, lastActivityAt: new Date().toISOString() });
        }, 250);
      };
      screen.onNotification = () => {
        const current = this.get(record.terminalId);
        if (current.instanceId === record.instanceId) this.save({ ...current, unread: true, notificationCount: current.notificationCount + 1 });
      };
      screen.onOutput = (data, from, watermark, sequence) => { for (const listener of runtime.listeners) listener({ type: 'output', data, from, watermark, sequence }); };
      screen.onResize = (size, sequence) => { for (const listener of runtime.listeners) listener({ type: 'owner', ownerConnectionId: runtime.owner, size, sequence }); };
      // DA/DSR 等终端设备查询只由服务端权威终端应答，浏览器跟随者不回写。
      screen.terminal.onData(data => { if (terminalIsActive(this.get(record.terminalId).status)) process?.pty.write(data); });
      process.onExit = () => {
        if (!runtime.stopping) void this.end(record.terminalId, record.instanceId, runtime.endReason ?? 'process-exit');
      };
      return this.save({ ...record, status: 'running' });
    } catch (error) {
      const failed = this.save({ ...record, status: 'failed', lastExit: { instanceId: record.instanceId, code: null, signal: null, reason: 'spawn-failed', occurredAt: new Date().toISOString() } });
      throw new TerminalError(400, `终端启动失败：${error instanceof Error ? error.message : String(error)}（${failed.title}）`);
    }
  }
  rename(id: string, title: string) { return this.save({ ...this.get(id), title }); }
  read(id: string, instance: string) { const record = this.get(id); this.assert(record, instance, 'read'); if (!record.unread && !record.notificationCount) return record; return this.save({ ...record, unread: false, notificationCount: 0 }); }
  private assert(record: ProjectTerminal, instance: string, action: 'end' | 'read' | 'reopen' | 'close', confirm = false) {
    try { assertTerminalOperation(record, instance, action, confirm); } catch (error) { throw new TerminalError(409, (error as Error).message); }
  }
  end(id: string, instance: string, reason: TerminalExit['reason'] = 'user-ended'): Promise<ProjectTerminal> {
    const record = this.get(id); this.assert(record, instance, 'end');
    const runtime = this.runtimes.get(instance);
    if (!runtime) return Promise.resolve(this.save({ ...record, status: 'stop-unconfirmed' }));
    if (runtime.stopping) return runtime.stopping;
    runtime.endReason = reason;
    runtime.screen.resumeForStop();
    this.save({ ...record, status: 'stopping' });
    runtime.stopping = (async () => {
      const stopped = await runtime.process.stop();
      await runtime.screen.drain();
      if (!stopped) return this.save({ ...this.get(id), status: 'stop-unconfirmed' });
      const result = runtime.process.result;
      const exit: TerminalExit = { instanceId: instance, code: result?.signal ? null : result?.exitCode ?? null,
        signal: result?.signal || null, reason, occurredAt: new Date().toISOString() };
      clearTimeout(runtime.metadataTimer); runtime.metadataTimer = undefined;
      runtime.process.dispose();
      const final = this.save({ ...this.get(id), status: 'exited', lastExit: exit, lastActivityAt: exit.occurredAt });
      for (const listener of runtime.listeners) listener({ type: 'exit', exit });
      // 终态保留一个有界权威画面供刷新查看；重开、关闭或服务退出时释放。
      return final;
    })().finally(() => { runtime.stopping = undefined; });
    return runtime.stopping;
  }
  async closeTerminal(id: string, instance: string, confirm: boolean) {
    let record = this.get(id); this.assert(record, instance, 'close', confirm);
    if (terminalIsActive(record.status)) record = await this.end(id, instance);
    if (terminalIsActive(record.status)) throw new TerminalError(409, '尚未证实进程结束，终端保持打开。');
    this.release(instance); return this.save({ ...record, closedAt: new Date().toISOString() });
  }
  reopen(id: string, instance: string, size: TerminalSize) {
    if (this.closing) throw new TerminalError(409, '终端服务正在退出。');
    const record = this.get(id); this.assert(record, instance, 'reopen'); this.directory(record.projectId, record.directory);
    this.release(instance);
    const now = new Date().toISOString();
    const next = { ...record, instanceId: randomUUID(), status: 'starting' as const, closedAt: null, instanceStartedAt: now, lastActivityAt: now, unread: false, notificationCount: 0 };
    if (!this.repository.replace(next, instance)) throw new TerminalError(409, '终端实例已变更。');
    return this.start(next, size);
  }
  private release(instance: string) {
    const runtime = this.runtimes.get(instance); if (!runtime) return;
    runtime.process.dispose(); clearTimeout(runtime.metadataTimer); runtime.screen.dispose(); runtime.listeners.clear(); this.runtimes.delete(instance);
  }
  async endProject(projectId: string, reason: 'project-removed' | 'directory-removed' = 'project-removed'): Promise<void> {
    const results = await Promise.allSettled(this.list(projectId).filter(record => terminalIsActive(record.status)).map(async record => {
      const ended = await this.end(record.terminalId, record.instanceId, reason);
      if (terminalIsActive(ended.status)) throw new TerminalError(409, '项目终端停止尚未确认。');
    }));
    this.assertStopped(results);
  }
  async resetForTest(): Promise<void> { await this.stopRuntimes('project-removed'); }
  async close(): Promise<void> {
    this.closing = true; this.unsubscribe(); await this.stopRuntimes('service-shutdown');
  }
  private async stopRuntimes(reason: TerminalExit['reason']): Promise<void> {
    const results = await Promise.allSettled([...this.runtimes].map(async ([instance, runtime]) => {
      const record = this.get(runtime.terminalId);
      if (terminalIsActive(record.status)) await this.end(record.terminalId, instance, reason);
      if (terminalIsActive(this.get(record.terminalId).status)) throw new Error('终端进程停止尚未确认。');
      this.release(instance);
    }));
    this.assertStopped(results);
  }
  private assertStopped(results: PromiseSettledResult<unknown>[]): void {
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }
}
