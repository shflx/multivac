import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { ProcessStopSchema, type ProcessStop, type ManagedProcess } from '@multivac/contracts';
import { Check } from 'typebox/value';
import { NativeTaskTools } from '../runtime/executors/native-task-tools.js';
import { MANAGED_SUPERVISOR } from '../runtime/executors/managed-process-supervisor.js';
import type { ManagedProcessRecord, SqliteManagedProcessRepository } from '../storage/sqlite-managed-process-repository.js';
import { fingerprint, TaskServiceError } from './task-service.js';
import { readProcessLog } from './process-log.js';

export interface ManagedStart {
  commandId: string; name: string; script: string; port: number | null; requiredWhileRunning: boolean;
}
export interface ManagedBoundary {
  taskId: string; runId: string; sessionId: string; directory: string; maxMillis: number; maxBytes: number;
}
interface Live { child: ChildProcessWithoutNullStreams; closed: Promise<void> }
const exec = promisify(execFile);

/** 仅托管自身通过隔离启动的单进程，不从系统进程列表接管目标。 */
export class ManagedProcessService {
  private readonly ownerId = randomUUID();
  private readonly live = new Map<string, Live>();
  private readonly starting = new Map<string, Promise<ManagedProcess>>();
  private closing = false;
  private observing = false;
  private observationDone: Promise<void> = Promise.resolve();
  private readonly logReads = new Map<string, { at: number; result: ReturnType<typeof readProcessLog> }>();
  constructor(private readonly repository: SqliteManagedProcessRepository, private readonly root: string,
    private readonly protectedPaths: string[], private readonly changed: () => void = () => {},
    private readonly validateBoundary: (boundary: ManagedBoundary) => void = () => {}) {}

  list(): ManagedProcess[] { return this.repository.all().map((record) => record.public).sort((a, b) => Number(['exited', 'failed'].includes(a.state)) - Number(['exited', 'failed'].includes(b.state))); }
  async logs(id: string, after = 0) {
    if (!Number.isSafeInteger(after) || after < 0) throw new TaskServiceError('INVALID_REQUEST', '日志游标无效。');
    if (!this.repository.get(id)) throw new TaskServiceError('NOT_FOUND', '托管进程不存在。');
    let cached = this.logReads.get(id);
    if (!cached || Date.now() - cached.at >= 250) {
      cached = { at: Date.now(), result: readProcessLog(this.paths(id).log, -1) };
      if (this.logReads.size >= 100) this.logReads.delete(this.logReads.keys().next().value!);
      this.logReads.set(id, cached);
    }
    const result = await cached.result;
    return { ...result, unchanged: result.available && result.cursor === after, text: result.cursor === after ? '' : result.text };
  }
  async observe(): Promise<void> {
    if (this.observing || this.closing) return;
    this.observing = true;
    let finished!: () => void;
    this.observationDone = new Promise((resolve) => { finished = resolve; });
    try {
      for (const record of this.repository.all().filter((item) => !['exited', 'failed'].includes(item.public.state))) {
        const id = record.public.processId;
        if (!this.live.has(id)) { await this.reconcile(id); continue; }
        if (!record.pid || record.public.state !== 'running') continue;
        try {
          const { stdout } = await exec('/usr/sbin/lsof', ['-nP', '-a', '-p', String(record.pid), '-iTCP', '-sTCP:LISTEN', '-Fn'], { timeout: 1000 });
          const line = stdout.split('\n').find((line) => /^n127\.0\.0\.1:\d+$/.test(line));
          const port = line ? Number(line.split(':').at(-1)) : null;
          const latest = this.repository.get(id)!;
          if (this.live.has(id) && latest.public.state === 'running' && latest.public.port !== port) this.save(latest, { port });
        } catch {
          const latest = this.repository.get(id);
          if (latest?.public.port && this.live.has(id) && latest.public.state === 'running') this.save(latest, { port: null });
        }
      }
    } finally { this.observing = false; finished(); }
  }
  hasDirectoryLease(directory: string): boolean {
    return this.repository.all().some((record) => record.directory === directory && !['exited', 'failed'].includes(record.public.state));
  }
  get activeCount(): number { return this.live.size + this.starting.size + Number(this.observing); }
  stopObservation(): void { this.closing = true; }
  async recover(): Promise<void> {
    for (const record of this.repository.all()) await this.reconcile(record.public.processId);
  }
  async stopRequired(runId: string): Promise<boolean> {
    const required = this.list().filter((item) => item.runId === runId && item.requiredWhileRunning);
    await Promise.all(required.map((item) => this.stop(item.processId)));
    return this.list().filter((item) => item.runId === runId && item.requiredWhileRunning).every((item) => ['exited', 'failed'].includes(item.state));
  }
  preview(id: string, task: { revision: number; status: string } | null) {
    const record = this.repository.get(id);
    if (!record) throw new TaskServiceError('NOT_FOUND', '托管进程不存在。');
    return { process: record.public, taskRevision: task?.revision ?? null,
      needsConfirmation: record.public.requiredWhileRunning && !!task && ['running', 'queued', 'waiting'].includes(task.status),
      impact: record.public.requiredWhileRunning ? '此进程是任务的执行依赖。停止可能使任务工具失败，任务不会自动重新启动该进程。' : '独立长期进程将退出，现有会话与成果保留。' };
  }
  async stopChecked(id: string, input: ProcessStop, task: { revision: number; status: string } | null): Promise<ManagedProcess> {
    if (!Check(ProcessStopSchema, input)) throw new TaskServiceError('INVALID_REQUEST', '停止参数无效。');
    const key = fingerprint({ id, input });
    const previous = this.repository.command(input.commandId);
    if (previous) {
      if (previous.fingerprint !== key) throw new TaskServiceError('COMMAND_ID_CONFLICT', '停止命令参数已改变。');
      return previous.result;
    }
    const preview = this.preview(id, task);
    if (preview.process.revision !== input.revision || preview.taskRevision !== input.taskRevision) throw new TaskServiceError('TASK_CONFLICT', '进程或任务状态已变化，请重新核对停止影响。');
    if (preview.needsConfirmation && !input.confirmed) throw new TaskServiceError('INVALID_REQUEST', '停止依赖进程需要用户确认影响。');
    const record = this.repository.get(id)!;
    const terminal = ['exited', 'failed'].includes(record.public.state);
    this.repository.transaction(() => {
      if (!terminal) { record.public = { ...record.public, revision: record.public.revision + 1, state: 'stopping', reason: '停止意图已保存，等待真实退出。' }; this.repository.save(record); }
      this.repository.saveCommand(input.commandId, key, record.public);
    });
    this.changed();
    if (!terminal) await this.stop(id);
    // 回执表明受理；最终退出由同一持久化进程记录给出，重放不再发送停止。
    return record.public;
  }
  private paths(id: string) { return { log: join(this.root, `${id}.log`), receipt: join(this.root, `${id}.exit.json`) }; }
  private save(record: ManagedProcessRecord, patch: Partial<ManagedProcess>) {
    record.public = { ...record.public, ...patch, revision: record.public.revision + 1 };
    this.repository.save(record); this.changed();
  }
  start(input: ManagedStart, boundary: ManagedBoundary): Promise<ManagedProcess> {
    const key = fingerprint({ input, taskId: boundary.taskId, runId: boundary.runId, sessionId: boundary.sessionId, directory: boundary.directory });
    const existing = this.repository.all().find((record) => record.commandId === input.commandId);
    if (existing) {
      if (existing.fingerprint !== key) return Promise.reject(new TaskServiceError('COMMAND_ID_CONFLICT', '启动命令参数已改变。'));
      return this.starting.get(input.commandId) ?? Promise.resolve(existing.public);
    }
    const pending = this.launch(input, boundary, key);
    this.starting.set(input.commandId, pending);
    void pending.finally(() => this.starting.delete(input.commandId)).catch(() => undefined);
    return pending;
  }
  private async launch(input: ManagedStart, boundary: ManagedBoundary, key: string): Promise<ManagedProcess> {
    if (this.closing) throw new TaskServiceError('TASK_CONFLICT', '本地服务正在退出。');
    if (process.platform !== 'darwin') throw new TaskServiceError('INVALID_REQUEST', '当前平台未验证托管隔离。');
    const active = this.list().filter((item) => !['exited', 'failed'].includes(item.state));
    if (active.length >= 16 || active.filter((item) => item.taskId === boundary.taskId).length >= 4) throw new TaskServiceError('TASK_CONFLICT', '托管进程并发预算已用尽。');
    if (!input.commandId || !input.name || input.name.length > 200 || !input.script || input.script.length > 1024 || isAbsolute(input.script)
      || !(boundary.maxMillis > 0 && boundary.maxMillis <= 86400000) || !(boundary.maxBytes > 0 && boundary.maxBytes <= 64 * 1024 * 1024)
      || (input.port !== null && (!Number.isInteger(input.port) || input.port < 1024 || input.port > 65535))) throw new TaskServiceError('INVALID_REQUEST', '托管启动参数无效。');
    // 在异步路径核对前登记意图，崩溃后不得重放启动。
    const id = randomUUID();
    const record: ManagedProcessRecord = {
      commandId: input.commandId, fingerprint: key, directory: boundary.directory, ownerId: this.ownerId, token: randomUUID(), pid: null,
      public: { processId: id, taskId: boundary.taskId, runId: boundary.runId, sessionId: boundary.sessionId, revision: 1,
        name: input.name, command: 'node（任务目录内脚本）', state: 'starting', requiredWhileRunning: input.requiredWhileRunning,
        startedAt: null, endedAt: null, port: null, exitCode: null, reason: '正在核对受控执行环境。' },
    };
    this.repository.save(record); this.changed();
    try {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const directory = await realpath(boundary.directory);
      const script = await realpath(join(directory, input.script));
      const rel = relative(directory, script);
      if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('脚本不在任务目录内。');
      record.public.command = `node ${rel.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 900)}`;
      const tools = await NativeTaskTools.create(directory, [...this.protectedPaths, this.root]);
      const profile = tools.managedProfile(input.port); tools.dispose();
      if (this.closing) throw new Error('本地服务正在退出。');
      this.validateBoundary(boundary);
      const paths = this.paths(id);
      const child = spawn(process.execPath, ['-e', MANAGED_SUPERVISOR], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', OPENSSL_CONF: '/dev/null' } });
      let ready!: () => void;
      const spawned = new Promise<void>((resolve) => { ready = resolve; });
      let protocol = '';
      child.stdout.on('data', (chunk: Buffer) => {
        protocol += chunk.toString();
        const lines = protocol.split('\n'); protocol = lines.pop()!;
        for (const line of lines) {
          try {
            const message = JSON.parse(line) as { pid?: number };
            if (Number.isInteger(message.pid) && message.pid! > 0) {
              record.pid = message.pid!;
              this.save(record, { state: 'running', startedAt: new Date().toISOString(), reason: '受控进程已创建；端口尚待观测。' });
              ready();
            }
          } catch { /* 私有监护协议损坏不构造成功事实。 */ }
        }
      });
      child.stderr.resume();
      child.stdin.on('error', () => {});
      child.on('error', () => ready());
      const closed = new Promise<void>((resolve) => child.once('close', () => {
        this.live.delete(id); ready();
        void this.reconcile(id).finally(resolve);
      }));
      this.live.set(id, { child, closed });
      child.stdin.write(JSON.stringify({ profile, directory, executable: process.execPath, args: [script], token: record.token,
        ...paths, maxMillis: boundary.maxMillis, maxBytes: boundary.maxBytes }) + '\n');
      await Promise.race([spawned, closed]);
      if (input.port !== null && record.pid && this.live.has(id)) {
        // lsof 只核对自己登记的精确 PID；声明的端口从不直接进入公开事实。
        try {
          const { stdout } = await exec('/usr/sbin/lsof', ['-nP', '-a', '-p', String(record.pid), '-iTCP', '-sTCP:LISTEN', '-Fn'], { timeout: 1000 });
          const latest = this.repository.get(id)!;
          if (latest.public.state === 'running' && this.live.has(id) && stdout.split('\n').includes(`n127.0.0.1:${input.port}`)) this.save(latest, { port: input.port, reason: '已观测到指定回环端口监听。' });
        } catch { /* 尚未监听或已经退出时端口保持未知。 */ }
      }
      return this.repository.get(id)!.public;
    } catch {
      this.save(record, { state: 'failed', endedAt: new Date().toISOString(), reason: '受控启动失败，未开放生产执行入口。' });
      return record.public;
    }
  }
  async reconcile(id: string): Promise<void> {
    const record = this.repository.get(id);
    if (!record || ['exited', 'failed'].includes(record.public.state)) return;
    try {
      const receipt = JSON.parse(await readFile(this.paths(id).receipt, 'utf8')) as { token: string; pid: number; code: number | null; endedAt: string; spawnError: boolean };
      if (receipt.token !== record.token || (record.pid !== null && receipt.pid !== record.pid)) throw new Error('停止凭据身份不匹配。');
      this.save(record, { state: receipt.spawnError || receipt.code !== 0 && record.public.state !== 'stopping' ? 'failed' : 'exited',
        endedAt: receipt.endedAt, exitCode: receipt.code, port: null, reason: '私有监护器已确认受限进程退出，派生后代被隔离策略禁止。' });
    } catch {
      if (!this.live.has(id) && record.public.state !== 'recovery') this.save(record, { state: 'recovery', reason: '缺少可信退出凭据，保留占用；不会按旧 PID 杀进程或重新启动。' });
    }
  }
  async stop(id: string): Promise<ManagedProcess> {
    const record = this.repository.get(id);
    if (!record) throw new TaskServiceError('NOT_FOUND', '托管进程不存在。');
    if (['exited', 'failed'].includes(record.public.state)) return record.public;
    const live = this.live.get(id);
    if (!live) { await this.reconcile(id); return this.repository.get(id)!.public; }
    if (record.public.state !== 'stopping') this.save(record, { state: 'stopping', reason: '停止意图已保存，等待真实退出。' });
    live.child.stdin.write('stop\n');
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([live.closed, new Promise<void>((resolve) => { timer = setTimeout(resolve, 3000); })]);
    if (timer) clearTimeout(timer);
    if (this.live.has(id)) this.save(this.repository.get(id)!, { state: 'recovery', reason: '停止超时，保留资源占用，等待可信退出凭据。' });
    return this.repository.get(id)!.public;
  }
  async close(): Promise<void> {
    this.closing = true;
    await this.observationDone;
    await Promise.allSettled([...this.starting.values()]);
    await Promise.all([...this.live.keys()].map((id) => this.stop(id)));
  }
}
