import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { agentSessionTrackable, terminalIsActive, type CreateTerminal, type Project, type ProjectTerminal, type TerminalPreset, type TerminalExit, type TerminalSize } from '@multivac/contracts';
import { assertTerminalOperation, selectTerminalDirectory, type TerminalRepository } from '../modules/terminals/terminal-record.js';
import { TerminalScreen } from '../modules/terminals/terminal-screen.js';
import type { CodexThreads } from '../modules/terminals/codex-threads.js';
import type { TerminalProcess, TerminalProcessFactory } from '../modules/terminals/terminal-process.js';
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
  /** 最近一次有窗口查看（发来 read）的时间；查看中的终端不标记未读。 */
  lastReadAt?: number;
}

/** 有窗口在查看的判定窗口，与活动时间的最小更新间隔。 */
const VIEWING_MILLIS = 2000;
const ACTIVITY_MILLIS = 5000;
export class TerminalService {
  private runtimes = new Map<string, TerminalRuntime>();
  private closing = false;
  get hasActivity(): boolean { return this.runtimes.size > 0; }
  private unsubscribe: () => void;
  /** 当前 Codex app-server 的终端连接地址；不可用时为 null，Codex 以普通方式启动。 */
  private codexEndpoint: string | null = null;
  /** codexThreads 缺省时不跟踪 Codex 会话（Claude Code 的会话 ID 由 Multivac 生成，不依赖它）。 */
  constructor(readonly repository: TerminalRepository, private readonly project: (id: string) => Project, private readonly events: WorkbenchEvents, private readonly createProcess: TerminalProcessFactory, private readonly codexThreads?: CodexThreads) {
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
  /** 新建终端（入口）：Codex 先在 app-server 中创建并命名会话，取得 ID 后再启动；app-server 不可用时以普通方式启动。 */
  async open(input: CreateTerminal): Promise<ProjectTerminal> {
    if (input.preset.kind === 'codex' && agentSessionTrackable(input.preset) && this.codexThreads) {
      const directory = this.directory(input.projectId, input.directory);
      const sessionId = await this.codexSession(directory, terminalTitle(input));
      return this.create(input, sessionId ?? undefined);
    }
    return this.create(input);
  }
  /** 新建终端；codexSessionId 为已在 app-server 中创建的 Codex 会话。 */
  create(input: CreateTerminal, codexSessionId?: string): ProjectTerminal {
    if (this.closing) throw new TerminalError(409, '终端服务正在退出。');
    const directory = this.directory(input.projectId, input.directory);
    const now = new Date().toISOString();
    const agentSessionId = !agentSessionTrackable(input.preset) ? null : input.preset.kind === 'claude' ? randomUUID() : codexSessionId ?? null;
    const record: ProjectTerminal = { terminalId: randomUUID(), instanceId: randomUUID(), projectId: input.projectId, directory, preset: input.preset,
      title: terminalTitle(input), status: 'starting', lastExit: null, createdAt: now, instanceStartedAt: now, lastActivityAt: now, closedAt: null,
      unread: false, notificationCount: 0, agentSessionId };
    this.repository.insert(record); return this.start(record, input.size, 'new');
  }
  /** 确保 app-server 可用并按需创建会话；失败时返回 null（退回普通启动，不跟踪会话）。 */
  private async codexSession(directory: string, title: string, existing?: string | null): Promise<string | null> {
    if (!this.codexThreads) return null;
    try {
      this.codexEndpoint = await this.codexThreads.endpoint();
      return existing ?? await this.codexThreads.createThread(directory, title);
    } catch {
      this.codexEndpoint = null;
      return null;
    }
  }
  /**
   * 实际启动用的命令与追加环境：保存的预设不变。
   * - Claude Code：按会话 ID 追加 --session-id（新会话）或 --resume（接回）；没有 ID 的旧终端接回时用 --continue。
   * - Codex：会话已在 Multivac 管理的 app-server 中创建，用 `resume <id> --remote <地址>` 接入；
   *   app-server 不可用时，有 ID 则用 `resume <id>` 由 Codex 自行接回，没有 ID 则开始新会话。
   *   不加 -c、--profile、--no-daemon 等参数：它们会让 Codex 在终端进程内运行服务，部分用户配置下收到输入即空转。
   * 会话内容由 CLI 自己保存，Multivac 只记 ID。
   */
  private launch(record: ProjectTerminal, session: 'new' | 'resume'): TerminalPreset {
    const { preset } = record;
    if (!agentSessionTrackable(preset)) return preset;
    if (preset.kind === 'claude') {
      const sessionArgs = record.agentSessionId ? [session === 'resume' ? '--resume' : '--session-id', record.agentSessionId] : session === 'resume' ? ['--continue'] : [];
      return { ...preset, argv: [...sessionArgs, ...preset.argv] };
    }
    if (preset.kind !== 'codex' || !record.agentSessionId) return preset;
    const remote = this.codexEndpoint ? ['--remote', this.codexEndpoint] : [];
    return { ...preset, argv: ['resume', record.agentSessionId, ...remote, ...preset.argv] };
  }
  private start(record: ProjectTerminal, size: TerminalSize, session: 'new' | 'resume'): ProjectTerminal {
    try {
      let process: TerminalProcess | undefined;
      const screen = new TerminalScreen(size, { pause: () => process?.pty.pause(), resume: () => process?.pty.resume() });
      try { process = this.createProcess(record.directory, this.launch(record, session), size); }
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
          if (current.instanceId !== record.instanceId) return;
          // 持续刷新的 CLI 会不断产生输出：查看中的终端不标未读，活动时间限频，状态不变时不发布事件，避免侧栏反复刷新。
          const now = Date.now();
          const unread = current.unread || now - (runtime.lastReadAt ?? 0) > VIEWING_MILLIS;
          if (unread !== current.unread || now - Date.parse(current.lastActivityAt) > ACTIVITY_MILLIS) {
            this.save({ ...current, unread, lastActivityAt: new Date(now).toISOString() });
          }
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
  read(id: string, instance: string) {
    const record = this.get(id); this.assert(record, instance, 'read');
    const runtime = this.runtimes.get(instance); if (runtime) runtime.lastReadAt = Date.now();
    if (!record.unread && !record.notificationCount) return record;
    return this.save({ ...record, unread: false, notificationCount: 0 });
  }
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
  /** 重开（入口）：Codex 先确保 app-server 可用，新会话时在其中创建会话，再按 ID 接入。 */
  async reopenTerminal(id: string, instance: string, size: TerminalSize, mode: 'resume' | 'new' = 'resume'): Promise<ProjectTerminal> {
    const record = this.get(id);
    if (record.preset.kind === 'codex' && agentSessionTrackable(record.preset) && this.codexThreads) {
      this.assert(record, instance, 'reopen');
      const sessionId = await this.codexSession(this.directory(record.projectId, record.directory), record.title, mode === 'resume' ? record.agentSessionId ?? null : null);
      return this.reopen(id, instance, size, mode, sessionId ?? undefined);
    }
    return this.reopen(id, instance, size, mode);
  }
  /** 重开：用原目录与原命令创建新实例；coding agent 默认接回记录的会话，new 时开始新会话。 */
  reopen(id: string, instance: string, size: TerminalSize, mode: 'resume' | 'new' = 'resume', codexSessionId?: string) {
    if (this.closing) throw new TerminalError(409, '终端服务正在退出。');
    const record = this.get(id); this.assert(record, instance, 'reopen'); this.directory(record.projectId, record.directory);
    this.release(instance);
    const now = new Date().toISOString();
    const trackable = agentSessionTrackable(record.preset);
    const resume = mode === 'resume' && trackable;
    // 新会话：Claude Code 换新 ID；Codex 使用刚在 app-server 中创建的会话（不可用时为空，开始未跟踪的新会话）。
    const agentSessionId = !trackable ? null
      : record.preset.kind === 'claude' ? (resume ? record.agentSessionId ?? null : randomUUID())
        : codexSessionId ?? (resume ? record.agentSessionId ?? null : null);
    const next = { ...record, instanceId: randomUUID(), status: 'starting' as const, closedAt: null, instanceStartedAt: now, lastActivityAt: now, unread: false, notificationCount: 0, agentSessionId };
    if (!this.repository.replace(next, instance)) throw new TerminalError(409, '终端实例已变更。');
    return this.start(next, size, resume ? 'resume' : 'new');
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
    this.closing = true; this.unsubscribe(); await this.stopRuntimes('service-shutdown'); await this.codexThreads?.close();
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

/** 终端名称：未指定时取预设名，最长 80 字。 */
function terminalTitle(input: CreateTerminal): string {
  return (input.title ?? (input.preset.kind === 'blank' ? '终端' : input.preset.kind === 'custom' ? input.preset.executable : input.preset.kind)).trim().slice(0, 80);
}
