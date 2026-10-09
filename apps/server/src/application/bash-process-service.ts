import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, stat, appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ManagedProcess } from '@multivac/contracts';
import type { ManagedProcessRecord, SqliteManagedProcessRepository } from '../storage/sqlite-managed-process-repository.js';
import { BASH_PROCESS_SUPERVISOR } from '../runtime/executors/bash-process-supervisor.js';
import { fingerprint, TaskServiceError } from './task-service.js';
import { readProcessLog } from './process-log.js';

export interface BashInput { command: string; mode?: 'foreground' | 'background'; timeout?: number; name?: string }
export interface BashSource { sessionId: string; executionId: string; directory: string; taskId?: string; runId?: string }
/** 任务使用原有受限执行器；普通工作会话使用独立进程组。 */
export type IsolatedBashExecution = (command: string, options: { signal: AbortSignal; timeoutMs?: number; onData: (data: Buffer) => void; onSpawn: (pid: number) => void }) => Promise<{ code: number | null; output: Buffer }>;
interface Live {
  ready: Promise<void>; rootExited: Promise<number | null>; closed: Promise<void>;
  stop: () => void; outputs: Set<(data: Buffer) => void>; timedOut: boolean; supervisorExited?: boolean;
}
const exec = promisify(execFile);
const terminal = (item: ManagedProcess) => ['exited', 'failed'].includes(item.state);

/** 统一登记 bash，前台调用结束与整个进程组退出分别记录。 */
export class BashProcessService {
  private readonly live = new Map<string, Live>();
  private closing = false;
  private readonly stoppedExecutions = new Set<string>();
  private readonly stoppedSessions = new Set<string>();
  constructor(private readonly repository: SqliteManagedProcessRepository, private readonly root: string,
    private readonly changed: () => void, private readonly graceMillis = 1000) {}

  get activeCount() { return this.live.size; }
  private paths(id: string) { return { log: join(this.root, `${id}.log`), receipt: join(this.root, `${id}.exit.json`) }; }
  private save(id: string, patch: Partial<ManagedProcess>) {
    const record = this.repository.get(id)!;
    record.public = { ...record.public, ...patch, revision: record.public.revision + 1 };
    this.repository.save(record); this.changed();
  }
  private allowed(source: BashSource) {
    if (this.closing || this.stoppedSessions.has(source.sessionId) || this.stoppedExecutions.has(`${source.sessionId}:${source.executionId}`)) {
      throw new Error('对应执行或会话已停止，未启动命令。');
    }
  }
  async execute(source: BashSource, toolCallId: string, input: BashInput, signal: AbortSignal | undefined,
    onData: (data: Buffer) => void, isolated?: IsolatedBashExecution): Promise<{ process: ManagedProcess; exitCode: number | null }> {
    if (!input.command.trim() || input.command.length > 100000 || (input.timeout !== undefined && (!Number.isFinite(input.timeout) || input.timeout <= 0 || input.timeout > 2147483))) throw new Error('bash 命令或超时参数无效。');
    this.allowed(source);
    if (signal?.aborted) throw new Error('aborted');
    const mode = input.mode ?? 'foreground';
    const commandId = `bash:${fingerprint({ sessionId: source.sessionId, toolCallId })}`;
    const key = fingerprint({ source, input });
    let record = this.repository.byCommand(commandId);
    if (record && record.fingerprint !== key) throw new TaskServiceError('COMMAND_ID_CONFLICT', '工具调用参数已改变。');
    if (!record) {
      const id = randomUUID();
      record = { backend: 'bash', commandId, fingerprint: key, directory: source.directory, ownerId: randomUUID(), token: randomUUID(), pid: null,
        public: { processId: id, sessionId: source.sessionId, taskId: source.taskId ?? null, runId: source.runId ?? null,
          executionId: source.executionId, toolCallId, mode, pid: null, processGroupId: null, revision: 1,
          name: (input.name || input.command.split('\n')[0] || 'bash').slice(0, 200), command: input.command.slice(0, 1000),
          state: 'starting', requiredWhileRunning: !!source.taskId, startedAt: null, endedAt: null, port: null, exitCode: null, reason: '正在启动 bash 执行。' } };
      this.repository.save(record); this.changed();
      // 登记与 live 安装之间不让出执行权，取消和重复调用始终能看到启动意图。
      this.launch(record, input, source, isolated);
    }
    const id = record.public.processId;
    const live = this.live.get(id);
    if (!live) {
      await this.reconcile(id);
      const current = this.repository.get(id)!.public;
      if (mode === 'foreground') onData(Buffer.from((await this.logs(id)).text));
      return { process: current, exitCode: current.exitCode };
    }
    if (mode === 'foreground') live.outputs.add(onData);
    const abort = () => { void this.stop(id); };
    signal?.addEventListener('abort', abort, { once: true });
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (mode === 'background' && input.timeout !== undefined) {
        try {
          await Promise.race([live.ready, new Promise<never>((_resolve, reject) => {
            startupTimer = setTimeout(() => reject(new Error(`后台进程未在 ${input.timeout} 秒内启动，已请求清理本次托管范围。`)), input.timeout! * 1000);
          })]);
        } catch (error) { await this.stop(id); throw error; }
        finally { clearTimeout(startupTimer); }
      } else await live.ready;
      if (signal?.aborted) { await this.stop(id); throw new Error('aborted'); }
      if (mode === 'background') return { process: this.repository.get(id)!.public, exitCode: null };
      const exitCode = await live.rootExited;
      // 给 stdout/stderr 排空一次事件循环；保留仍在组内运行的后代。
      await new Promise(resolve => setTimeout(resolve, 60));
      if (signal?.aborted) { await this.stop(id); throw new Error('aborted'); }
      if (live.timedOut) { await this.stop(id); throw new Error(`timeout:${input.timeout}`); }
      return { process: this.repository.get(id)!.public, exitCode };
    } finally { signal?.removeEventListener('abort', abort); live.outputs.delete(onData); }
  }
  private launch(record: ManagedProcessRecord, input: BashInput, source: BashSource, isolated?: IsolatedBashExecution) {
    const id = record.public.processId;
    let ready!: () => void, exited!: (code: number | null) => void, closed!: () => void;
    const controller = new AbortController();
    let child: ChildProcessWithoutNullStreams | undefined;
    const live: Live = { ready: new Promise(resolve => { ready = resolve; }), rootExited: new Promise(resolve => { exited = resolve; }),
      closed: new Promise(resolve => { closed = resolve; }), timedOut: false, outputs: new Set(),
      stop: () => { controller.abort(); if (child?.stdin.writable) child.stdin.write('stop\n'); } };
    this.live.set(id, live);
    const pidReady = (pid: number) => {
      const current = this.repository.get(id)!; current.pid = pid; this.repository.save(current);
      this.save(id, { pid, processGroupId: isolated ? null : pid, startedAt: new Date().toISOString(), state: current.public.state === 'stopping' ? 'stopping' : 'running', reason: 'bash 已启动，监听端口尚待观测。' }); ready();
    };
    void (async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const directory = await realpath(source.directory);
      this.allowed(source);
      if (controller.signal.aborted) throw new Error('启动已取消。');
      if (isolated) {
        await writeFile(this.paths(id).log, '', { mode: 0o600, flag: 'wx' });
        let writes = Promise.resolve();
        let result: { code: number | null } = { code: null };
        let failed = false; let failureReason = '任务 bash 执行失败。';
        try {
          result = await isolated(input.command, { signal: controller.signal,
            ...(input.mode === 'background' || input.timeout === undefined ? {} : { timeoutMs: input.timeout * 1000 }), onSpawn: pidReady,
            onData: data => { for (const output of live.outputs) output(data); writes = writes.then(() => appendFile(this.paths(id).log, data)); } });
        } catch (error) { failed = true; failureReason = error instanceof Error ? error.message : failureReason; }
        await writes;
        this.save(id, { state: controller.signal.aborted ? 'exited' : failed || result.code !== 0 ? 'failed' : 'exited', endedAt: new Date().toISOString(), exitCode: result.code, port: null, reason: failed && !controller.signal.aborted ? failureReason : '受限任务 bash 已退出，派生进程由隔离策略禁止。' });
        exited(result.code); ready(); this.live.delete(id); closed(); return;
      }
      const env: NodeJS.ProcessEnv = {};
      for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SHELL', 'USER', 'LOGNAME', 'TERM']) if (process.env[key]) env[key] = process.env[key];
      child = spawn(process.execPath, ['-e', BASH_PROCESS_SUPERVISOR], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin' } });
      let protocol = '';
      child.stdout.on('data', (chunk: Buffer) => {
        protocol += chunk.toString();
        const lines = protocol.split('\n'); protocol = lines.pop()!;
        for (const line of lines) {
          try {
            const message = JSON.parse(line) as { pid?: number; rootExited?: boolean; code?: number | null; output?: string; timedOut?: boolean };
            if (message.pid) pidReady(message.pid);
            if (message.output) for (const output of live.outputs) output(Buffer.from(message.output, 'base64'));
            if (message.rootExited) { this.save(id, { exitCode: message.code ?? null }); exited(message.code ?? null); }
            if (message.timedOut) live.timedOut = true;
          } catch { /* 损坏协议不产生成功事实。 */ }
        }
      });
      child.stderr.resume(); child.stdin.on('error', () => {});
      child.once('error', () => { ready(); exited(null); });
      child.once('close', () => {
        live.supervisorExited = true;
        // 退出凭据落库后才释放 live，应用关闭会等待这一段收尾。
        void this.reconcile(id).finally(() => { this.live.delete(id); ready(); exited(null); closed(); });
      });
      child.stdin.write(JSON.stringify({ ...this.paths(id), token: record.token, directory, command: input.command, env, graceMillis: this.graceMillis,
        timeoutMillis: input.mode === 'background' || input.timeout === undefined ? null : input.timeout * 1000 }) + '\n');
      if (controller.signal.aborted) live.stop();
    })().catch(error => {
      this.save(id, { state: 'failed', endedAt: new Date().toISOString(), reason: error instanceof Error ? error.message.slice(0, 2000) : 'bash 启动失败。' });
      this.live.delete(id); ready(); exited(null); closed();
    });
  }
  async logs(id: string) {
    const path = this.paths(id).log;
    const result = await readProcessLog(path, -1);
    const info = await stat(path).catch(() => null);
    return { ...result, cursor: info ? Math.floor(info.mtimeMs * 1000) : 0, truncated: result.truncated || (info?.size ?? 0) >= 1024 * 1024 };
  }
  async reconcile(id: string) {
    const record = this.repository.get(id)!;
    if (terminal(record.public)) return;
    try {
      const receipt = JSON.parse(await readFile(this.paths(id).receipt, 'utf8')) as { token: string; pid: number; groupStopped: boolean; spawnError: boolean; stopping: boolean; timedOut?: boolean; timeoutMillis?: number; code: number | null; endedAt: string };
      if (receipt.token !== record.token || !receipt.groupStopped || (record.pid !== null && receipt.pid !== record.pid)) throw new Error('退出凭据不匹配。');
      this.save(id, { state: receipt.spawnError || receipt.timedOut || (!receipt.stopping && receipt.code !== 0) ? 'failed' : 'exited', endedAt: receipt.endedAt, exitCode: receipt.code, port: null,
        reason: receipt.timedOut ? `bash 执行超过 ${receipt.timeoutMillis! / 1000} 秒，托管进程组已核对退出。` : '监护器已核对本次创建的托管进程组退出。' });
    } catch { if (!this.live.has(id) || this.live.get(id)?.supervisorExited) this.save(id, { state: 'recovery', reason: '托管进程组退出结果未确认。' }); }
  }
  async observe(id: string) {
    const record = this.repository.get(id)!;
    if (!this.live.has(id)) { await this.reconcile(id); return; }
    if (!record.public.processGroupId || record.public.state !== 'running') return;
    try {
      const { stdout } = await exec('/usr/sbin/lsof', ['-nP', '-a', '-g', String(record.public.processGroupId), '-iTCP', '-sTCP:LISTEN', '-Fn'], { timeout: 1000 });
      const line = stdout.split('\n').find(line => /^n(?:127\.0\.0\.1|\[::1\]):\d+$/.test(line));
      const port = line ? Number(line.split(':').at(-1)) : null;
      const current = this.repository.get(id)!.public;
      if (current.state === 'running' && current.port !== port) this.save(id, { port });
    } catch { if (this.repository.get(id)!.public.port) this.save(id, { port: null }); }
  }
  async stop(id: string) {
    const record = this.repository.get(id)!;
    if (terminal(record.public)) return record.public;
    const live = this.live.get(id);
    if (!live) { await this.reconcile(id); return this.repository.get(id)!.public; }
    this.save(id, { state: 'stopping', reason: '正在结束本次托管进程组。' }); live.stop();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([live.closed, new Promise(resolve => { timer = setTimeout(resolve, this.graceMillis + 3000); })]);
    clearTimeout(timer);
    if (this.live.has(id)) this.save(id, { state: 'recovery', reason: '托管范围的清理结果尚未确认。' });
    return this.repository.get(id)!.public;
  }
  async stopExecution(sessionId: string, executionId: string) {
    this.stoppedExecutions.add(`${sessionId}:${executionId}`);
    await this.stopMatching(item => item.sessionId === sessionId && item.executionId === executionId);
  }
  async stopSession(sessionId: string) {
    this.stoppedSessions.add(sessionId);
    await this.stopMatching(item => item.sessionId === sessionId);
  }
  async stopMatching(matches: (item: ManagedProcess) => boolean) {
    await Promise.all(this.repository.active().filter(item => item.backend === 'bash' && matches(item.public) && !terminal(item.public)).map(item => this.stop(item.public.processId)));
  }
  resumeSession(sessionId: string) { this.stoppedSessions.delete(sessionId); }
  beginClose() { this.closing = true; }
  async close() { this.closing = true; await this.stopMatching(() => true); }
}
