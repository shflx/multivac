import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { realpathSync, unlinkSync, symlinkSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskRun } from '@multivac/contracts';
import type { IsolatedBashExecution } from '../src/application/bash-process-service.js';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';
import { ProjectService } from '../src/application/project-service.js';
import { ManagedProcessService } from '../src/application/managed-process-service.js';
import { sessionBashExecution } from '../src/application/session-bash-execution.js';
import { managedBashTool } from '../src/runtime/executors/managed-bash-tool.js';
import { resolveMultivacWorkPaths } from '../src/modules/sessions/work-paths.js';

/** 仅模拟私有监护协议；不启动 shell，不把协议输出当成真实命令执行证据。 */
function supervisorFixture() {
  const launches: { directory: string; command: string }[] = [];
  const stops: number[] = [];
  let pid = 100000;
  const bash = () => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    let config: { directory: string; command: string; log: string; receipt: string; token: string };
    const currentPid = ++pid;
    let ended = false;
    const end = async (stopping: boolean) => {
      if (ended) return;
      ended = true;
      await writeFile(config.receipt, JSON.stringify({ token: config.token, pid: currentPid, groupStopped: true, treeStopped: true, spawnError: false, stopping, code: 0, endedAt: new Date().toISOString() }));
      child.stdout.write(JSON.stringify({ rootExited: true, code: 0 }) + '\n');
      child.emit('close', 0);
    };
    child.stdin.on('data', (data: Buffer) => {
      if (data.toString() === 'stop\n') { stops.push(currentPid); void end(true); return; }
      config = JSON.parse(data.toString());
      launches.push({ directory: config.directory, command: config.command });
      child.stdout.write(JSON.stringify({ pid: currentPid }) + '\n');
      if (config.command !== 'hold') void (async () => {
        const output = `simulated cwd: ${config.directory}\n`;
        await writeFile(config.log, output);
        child.stdout.write(JSON.stringify({ output: Buffer.from(output).toString('base64') }) + '\n');
        await end(false);
      })();
    });
    return child as unknown as ChildProcessWithoutNullStreams;
  };
  return { launches, stops, supervisors: { bash, managed: () => { throw new Error('不应调用任务监护器。'); } } };
}

async function fixture() {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'multivac-session-bash-')));
  const primary = join(root, 'primary'), extra = join(root, 'extra'), other = join(root, 'other'), data = join(root, 'data'), home = join(root, 'home');
  for (const path of [primary, extra, other, data, home]) await mkdir(path);
  await mkdir(join(extra, 'child'));
  const store = new SqliteAssistantStore(join(data, 'store.sqlite'));
  const workPaths = resolveMultivacWorkPaths(join(root, 'work'), data);
  const projects = new ProjectService({ projects: store.projects, workspaces: store.workspaces, workPaths, dataDir: data, homeDir: home });
  const project = projects.createProject({ name: 'project', directory: primary }).project;
  store.sessions.insertIfAbsent({ sessionId: 'session', title: 'session', kind: 'work', workspaceId: project.projectId,
    createdAt: new Date().toISOString(), workingDirectory: { kind: 'project-mounted', path: primary } });
  const supervisors = supervisorFixture();
  const logs = join(root, 'logs');
  const processes = new ManagedProcessService(store.managedProcesses, logs, [], {
    isolation: { verify: async () => { throw new Error('不应准备原生隔离。'); }, managedProfile: async () => { throw new Error('不应准备原生隔离。'); } }, supervisors: supervisors.supervisors,
  });
  let execution: string | null = 'turn';
  let run: TaskRun | null = null;
  let directoryReads = 0;
  const leases = new Set<string>();
  const leaseEvents: string[] = [];
  const port = sessionBashExecution({ sessions: store.sessions, workspaces: store.workspaces, projects: store.projects,
    runs: { bySession: () => run }, currentExecution: () => execution,
    taskControl: original => {
      const check = () => {
        if (run?.runId !== original.runId || run.stopIntent || run.stopConfirmed) throw new Error('原任务 Run 已失效。');
      };
      return { check,
        start: (marker, _bytes) => { check(); leases.add(marker); leaseEvents.push('start'); return { maxBytes: 10000, maxMillis: 10000 }; },
        progress: (_marker, _bytes) => { check(); leaseEvents.push('progress'); return 10000; },
        settle: marker => { leases.delete(marker); leaseEvents.push('settle'); },
      };
    },
    currentDirectory: id => { directoryReads++; return store.sessions.get(id)!.workingDirectory!; }, bash: processes.bash });
  const tool = managedBashTool('session', primary, port);
  const mount = () => projects.updateProject(project.projectId, { directories: [primary, extra] });
  const unmount = () => projects.updateProject(project.projectId, { directories: [primary] });
  return { root, primary, extra, other, store, logs, project, projects, processes, supervisors, port, tool, mount, unmount, leases, leaseEvents,
    setExecution: (value: string | null) => { execution = value; }, setRun: (value: TaskRun | null) => { run = value; },
    directoryReads: () => directoryReads,
    invoke: (call: string, cwd?: string, mode: 'foreground' | 'background' = 'foreground', command = 'probe') => tool.execute(call, { command, mode, ...(cwd ? { cwd } : {}) }, undefined, undefined, undefined as never),
    close: async () => { await processes.close(); store.close(); await rm(root, { recursive: true, force: true }); } };
}

test('真实工具定义/准入/SQLite + 监护替身：前后台贯通真实 cwd，默认保持原目录，重放与改 cwd 冲突', async () => {
  const f = await fixture();
  try {
    f.mount();
    const alias = join(f.primary, 'alias'); await symlink(join(f.extra, 'child'), alias);
    const result = await f.invoke('foreground', alias);
    assert.match(JSON.stringify(result), /simulated cwd/);
    const record = f.store.managedProcesses.byCommand(f.store.managedProcesses.all()[0]!.commandId)!;
    assert.equal(record.directory, join(f.extra, 'child'));
    assert.equal(record.public.sessionId, 'session'); assert.equal(record.public.executionId, 'turn'); assert.equal(record.public.toolCallId, 'foreground');
    await f.invoke('foreground', alias);
    assert.equal(f.supervisors.launches.length, 1);
    unlinkSync(alias); symlinkSync(f.extra, alias);
    // 原始参数不变而真实目录改变，也必须按目录指纹报冲突。
    await assert.rejects(f.invoke('foreground', alias), /参数/);
    await assert.rejects(f.port.execute('session', f.primary, 'foreground', { command: 'probe', mode: 'foreground', cwd: f.primary }, undefined, () => {}), /参数/);
    const before = f.supervisors.launches.length;
    await Promise.all([f.invoke('background', f.extra, 'background', 'hold'), f.invoke('background', f.extra, 'background', 'hold')]);
    assert.equal(f.supervisors.launches.length, before + 1);
    await f.invoke('default');
    assert.equal(f.supervisors.launches.at(-1)!.directory, f.primary);
    assert.equal(f.store.sessions.get('session')!.workingDirectory!.path, f.primary);
    assert.equal(f.processes.list().length, 1);
    await f.processes.stop(f.processes.list()[0]!.processId);
    assert.equal(f.processes.list()[0]!.state, 'exited');
    assert.match((await f.processes.logs(record.public.processId)).text, /simulated cwd/);
  } finally { await f.close(); }
});

test('启动准备中的卸载、归属/轮次/cwd/归档变化和原 cwd 之外的授权拒绝，不调用监护器', async () => {
  for (const mutation of ['unmount', 'project', 'turn', 'cwd', 'archive'] as const) {
    const f = await fixture();
    try {
      f.mount();
      const pending = f.port.execute('session', f.primary, mutation, { command: 'probe', cwd: f.extra }, undefined, () => {});
      if (mutation === 'unmount') f.unmount();
      if (mutation === 'project') f.store.sessions.moveToWorkspace('session', { fromWorkspaceId: f.project.projectId, toWorkspaceId: 'default', workingDirectory: { kind: 'project-mounted', path: f.primary } });
      if (mutation === 'turn') f.setExecution('new-turn');
      if (mutation === 'cwd') f.store.sessions.setWorkingDirectory('session', { kind: 'project-mounted', path: f.other });
      if (mutation === 'archive') f.store.sessions.archive('session', new Date().toISOString());
      const result = await pending;
      assert.equal(result.process.state, 'failed');
      assert.match(result.process.reason, /当前已确认|轮次已变化|目录已变化|已归档/);
      assert.equal(f.supervisors.launches.length, 0);
      assert.equal(f.processes.activeCount, 0);
    } finally { await f.close(); }
  }
  const f = await fixture();
  try {
    // 准入不调用授权服务；独立文件授权不在其依赖中，也不会产生待授权请求。
    assert.throws(() => f.port.execute('session', f.primary, 'outside', { command: 'probe', cwd: f.other }, undefined, () => {}), /当前已确认/);
    assert.equal(f.store.managedProcesses.all().length, 0);
  } finally { await f.close(); }
});

test('准备后的合法链接替换仍拒绝；卸载原 cwd 来源后默认执行仍可启动', async () => {
  const f = await fixture();
  try {
    f.mount();
    const link = join(f.primary, 'link'); await symlink(join(f.extra, 'child'), link);
    const pending = f.port.execute('session', f.primary, 'link', { command: 'probe', cwd: link }, undefined, () => {});
    // 同步替换保证发生在启动器异步准备完成前。
    unlinkSync(link); symlinkSync(f.extra, link);
    const result = await pending;
    assert.equal(result.process.state, 'failed'); assert.match(result.process.reason, /实际目标已发生变化/);
    assert.equal(f.supervisors.launches.length, 0);
    f.projects.updateProject(f.project.projectId, { directories: [f.extra] });
    await f.invoke('original');
    assert.equal(f.supervisors.launches[0]!.directory, f.primary);
  } finally { await f.close(); }
});

test('附目录进程的轮次/会话停止、取消、恢复及父子目录占用沿用既有身份', async () => {
  const f = await fixture();
  try {
    f.mount();
    await f.invoke('old', join(f.extra, 'child'), 'background', 'hold');
    f.setExecution('next');
    await f.invoke('new', f.extra, 'background', 'hold');
    assert.equal(f.processes.hasDirectoryLease(f.extra), true);
    assert.equal(f.processes.hasDirectoryLease(join(f.extra, 'child', 'nested')), true);
    assert.equal(f.processes.hasDirectoryLease(f.primary), false);
    await f.processes.bash.stopExecution('session', 'next');
    assert.equal(f.processes.list().filter(item => item.state === 'running').length, 1);
    // 缺少退出凭据的重启记录不得按旧 PID 操作，也不得释放目录占用。
    const active = f.store.managedProcesses.all().find(item => item.public.state === 'running')!;
    const recovered = new ManagedProcessService(f.store.managedProcesses, f.logs, [], {
      isolation: { verify: async () => {}, managedProfile: async () => '' }, supervisors: f.supervisors.supervisors,
    });
    await recovered.recover();
    assert.equal(recovered.get(active.public.processId)!.state, 'recovery');
    assert.equal(recovered.hasDirectoryLease(f.extra), true);
    await f.processes.stopSession('session');
    assert.ok(f.processes.list().every(item => item.state === 'exited'));
    assert.equal(f.processes.hasDirectoryLease(f.extra), false);
    assert.equal(f.supervisors.stops.length, 2);
    const receipt = JSON.parse(await readFile(join(f.logs, `${active.public.processId}.exit.json`), 'utf8'));
    assert.equal(receipt.groupStopped, true);
    f.processes.bash.resumeSession('session'); f.setExecution('cancel');
    const controller = new AbortController();
    const pending = f.port.execute('session', f.primary, 'cancelled', { command: 'hold', cwd: f.extra, mode: 'background' }, controller.signal, () => {});
    controller.abort();
    await assert.rejects(pending, /aborted/);
    assert.ok(f.processes.list().every(item => ['exited', 'failed'].includes(item.state)));
  } finally { await f.close(); }
});

test('归档准入不准备目录，准备期间原 cwd 消失则失败，不补建或启动', async () => {
  const archived = await fixture();
  try {
    archived.store.sessions.archive('session', new Date().toISOString());
    assert.throws(() => archived.port.execute('session', archived.primary, 'archived', { command: 'probe' }, undefined, () => {}), /已归档/);
    assert.equal(archived.directoryReads(), 0);
    assert.equal(archived.store.managedProcesses.all().length, 0);
  } finally { await archived.close(); }
  const missing = await fixture();
  try {
    const pending = missing.port.execute('session', missing.primary, 'missing', { command: 'probe' }, undefined, () => {});
    rmSync(missing.primary, { recursive: true });
    const result = await pending;
    assert.equal(result.process.state, 'failed');
    assert.equal(missing.supervisors.launches.length, 0);
    await assert.rejects(stat(missing.primary), /ENOENT/);
  } finally { await missing.close(); }
});

test('隔离任务保持原执行器、归属和 cwd；准备期间停止或 Run 变化拒绝', async () => {
  const f = await fixture();
  try {
    f.mount();
    const run = { taskId: 'task', runId: 'run', stopIntent: null, stopConfirmed: false } as TaskRun;
    f.setRun(run);
    let executions = 0;
    const isolated: IsolatedBashExecution = async (_command, options) => { executions++; options.onSpawn(100001); options.onData(Buffer.from('isolated')); return { code: 0, output: Buffer.from('isolated') }; };
    assert.throws(() => f.port.execute('session', f.primary, 'no-isolation', { command: 'probe' }, undefined, () => {}), /任务执行边界/);
    assert.throws(() => f.port.execute('session', f.primary, 'outside-task', { command: 'probe', cwd: f.extra }, undefined, () => {}, isolated), /原工作目录/);
    const ok = await f.port.execute('session', f.primary, 'task', { command: 'probe' }, undefined, () => {}, isolated);
    assert.equal(ok.process.taskId, 'task'); assert.equal(ok.process.runId, 'run'); assert.equal(ok.process.processGroupId, null);
    const pending = f.port.execute('session', f.primary, 'stopping', { command: 'probe' }, undefined, () => {}, isolated);
    f.setRun({ ...run, stopIntent: 'cancel' } as TaskRun);
    const rejected = await pending;
    assert.equal(rejected.process.state, 'failed'); assert.match(rejected.process.reason, /任务执行边界/);
    assert.equal(executions, 1); assert.equal(f.supervisors.launches.length, 0);
    const nativeTool = managedBashTool('session', f.primary, f.port, { execute: () => { throw new Error('不应执行'); } } as never);
    await assert.rejects(nativeTool.execute('cwd-task', { command: 'probe', cwd: f.primary }, undefined, undefined, undefined as never), /不支持指定 cwd/);
  } finally { await f.close(); }
});


test('共用后端任务：独立 worktree 可选项目 cwd，保留原目录及 Run 归属，退出才结算租约', async () => {
  const f = await fixture();
  try {
    f.mount();
    f.store.sessions.setWorkingDirectory('session', { kind: 'worktree', path: f.primary });
    f.setRun({ taskId: 'task', runId: 'workspace-run', commandId: 'turn', executionMode: 'workspace', stopIntent: null, stopConfirmed: false } as TaskRun);
    const result = await f.port.execute('session', f.primary, 'workspace', { command: 'probe', cwd: f.extra }, undefined, () => {});
    assert.equal(result.process.taskId, 'task'); assert.equal(result.process.runId, 'workspace-run');
    assert.equal(f.supervisors.launches[0]!.directory, f.extra);
    assert.equal(f.store.sessions.get('session')!.workingDirectory!.path, f.primary);
    assert.deepEqual(f.leaseEvents, ['start', 'progress', 'settle']); assert.equal(f.leases.size, 0);
    f.setExecution('wrong-turn');
    assert.throws(() => f.port.execute('session', f.primary, 'stale', { command: 'probe' }, undefined, () => {}), /任务执行边界/);
  } finally { await f.close(); }
});

for (const change of ['unmount', 'cancel', 'replace'] as const) test(`共用后端任务：准备期间 ${change} 拒绝启动且不遗留进程租约`, async () => {
  const f = await fixture();
  try {
    f.mount();
    const run = { taskId: 'task', runId: 'workspace-run', commandId: 'turn', executionMode: 'workspace', stopIntent: null, stopConfirmed: false } as TaskRun;
    f.setRun(run);
    const pending = f.port.execute('session', f.primary, change, { command: 'probe', cwd: f.extra }, undefined, () => {});
    if (change === 'unmount') f.unmount();
    if (change === 'cancel') f.setRun({ ...run, stopIntent: 'cancel' } as TaskRun);
    if (change === 'replace') f.setRun({ ...run, runId: 'replacement' });
    const result = await pending;
    assert.equal(result.process.state, 'failed'); assert.equal(f.supervisors.launches.length, 0);
    assert.equal(f.leases.size, 0); assert.deepEqual(f.leaseEvents, []);
  } finally { await f.close(); }
});
