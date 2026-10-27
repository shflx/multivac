import assert from 'node:assert/strict';
import test from 'node:test';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';
import { ProjectService } from '../src/application/project-service.js';
import { ManagedProcessService } from '../src/application/managed-process-service.js';
import { projectFileScope } from '../src/application/project-file-scope.js';
import { sessionBashExecution } from '../src/application/session-bash-execution.js';
import { resolveMultivacWorkPaths } from '../src/modules/sessions/work-paths.js';
import { managedBashTool } from '../src/runtime/executors/managed-bash-tool.js';
import { createBoundaryFileTools } from '../src/runtime/executors/pi-tool-boundary.js';
import { nativeTaskIsolation, nodeProcessSupervisors } from '../src/runtime/executors/process-runtime.js';

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

// 真实 shell/Git 会派生进程。隔离任务内禁止启用；仅供允许本机执行的普通工作宿主显式运行。
test('真实工具接续：同一会话挂载附加 worktree、编辑、指定 cwd 测试/构建/本地提交和后台清理', {
  skip: process.env.MULTIVAC_PROJECT_BASH_REAL !== '1' ? '需在允许派生进程的普通工作宿主设置 MULTIVAC_PROJECT_BASH_REAL=1；隔离任务不执行。' : false,
}, async () => {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'multivac-project-bash-real-')));
  const primary = join(root, 'main'), extra = join(root, 'extra'), data = join(root, 'data'), home = join(root, 'home');
  for (const path of [primary, data, home]) await mkdir(path);
  const store = new SqliteAssistantStore(join(data, 'store.sqlite'));
  const workPaths = resolveMultivacWorkPaths(join(root, 'work'), data);
  const projects = new ProjectService({ projects: store.projects, workspaces: store.workspaces, workPaths, dataDir: data, homeDir: home });
  const project = projects.createProject({ name: 'real', directory: primary }).project;
  const directory = { kind: 'project-mounted' as const, path: primary };
  store.sessions.insertIfAbsent({ sessionId: 'real', title: 'real', kind: 'work', workspaceId: project.projectId, createdAt: new Date().toISOString(), workingDirectory: directory });
  const processes = new ManagedProcessService(store.managedProcesses, join(root, 'logs'), [], { isolation: nativeTaskIsolation, supervisors: nodeProcessSupervisors });
  const dependencies = { sessions: store.sessions, workspaces: store.workspaces, projects: store.projects, isTaskSession: () => false };
  const scope = projectFileScope(dependencies);
  const port = sessionBashExecution({ ...dependencies, currentExecution: () => 'real-turn',
    currentDirectory: () => store.sessions.get('real')!.workingDirectory!, runs: { bySession: () => null }, bash: processes.bash });
  const bash = managedBashTool('real', primary, port);
  const files = createBoundaryFileTools({ cwd: primary, projectDirectories: () => scope('real', directory) });
  let sequence = 0;
  const command = async (command: string, cwd?: string, call = `bash-${++sequence}`) => {
    const result = await bash.execute(call, { command, ...(cwd ? { cwd } : {}) }, undefined, undefined, undefined as never);
    return result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
  };
  const file = (name: string, params: object) => files.find(tool => tool.name === name)!.execute(`file-${++sequence}`, params, new AbortController().signal, undefined, {} as never);
  // 所有 Git 命令仅作用于此临时仓库，禁用用户/系统配置、hooks 和签名。
  const git = 'GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git -c core.hooksPath=/dev/null -c commit.gpgsign=false -c user.name=Multivac -c user.email=multivac@localhost';
  try {
    await command(`${git} init -b main`);
    await file('write', { path: 'value.mjs', content: 'export const value = 1;\n' });
    await file('write', { path: 'value.test.mjs', content: 'import assert from "node:assert/strict"; import { value } from "./value.mjs"; assert.equal(value, 1);\n' });
    await file('write', { path: 'build.mjs', content: 'import { mkdir, writeFile } from "node:fs/promises"; import { value } from "./value.mjs"; await mkdir("dist", { recursive: true }); await writeFile("dist/value.txt", String(value));\n' });
    await command(`${git} add value.mjs value.test.mjs build.mjs`);
    await command(`${git} commit -m '初始代码'`);
    await command(`${git} worktree add -b feature ${quote(extra)} main`);
    await assert.rejects(file('read', { path: join(extra, 'value.mjs') }), /授权|拒绝/);
    // 测试直接调用服务端挂载业务，不伪装成用户界面确认或真实模型决策。
    projects.updateProject(project.projectId, { directories: [primary, extra] });
    await file('edit', { path: join(extra, 'value.mjs'), edits: [{ oldText: 'value = 1', newText: 'value = 2' }] });
    await file('edit', { path: join(extra, 'value.test.mjs'), edits: [{ oldText: 'equal(value, 1)', newText: 'equal(value, 2)' }] });
    assert.match(await command('pwd', extra), new RegExp(extra));
    assert.match(await command('pwd', primary), new RegExp(primary));
    await command(`${quote(process.execPath)} -e 'require("node:fs").writeFileSync("relative.txt",process.cwd())'`, extra);
    assert.equal(await readFile(join(extra, 'relative.txt'), 'utf8'), extra);
    await command(`${quote(process.execPath)} --test --test-isolation=none value.test.mjs`, extra);
    await command(`${quote(process.execPath)} build.mjs`, extra);
    assert.equal(await readFile(join(extra, 'dist/value.txt'), 'utf8'), '2');
    await command(`${git} add value.mjs value.test.mjs`, extra);
    await command(`${git} commit -m '更新附加工作树代码'`, extra);
    const featureHead = (await command(`${git} rev-parse HEAD`, extra)).trim();
    const mainHead = (await command(`${git} rev-parse HEAD`)).trim();
    assert.match(featureHead, /^[a-f0-9]{40}$/); assert.notEqual(featureHead, mainHead);
    assert.ok(['', '(no output)'].includes((await command(`${git} status --porcelain`)).trim()));
    assert.equal(await readFile(join(primary, 'value.mjs'), 'utf8'), 'export const value = 1;\n');
    const count = store.managedProcesses.all().length;
    await command('pwd', extra, 'replay'); await command('pwd', extra, 'replay');
    assert.equal(store.managedProcesses.all().length, count + 1);
    await assert.rejects(command('pwd', primary, 'replay'), /参数/);
    assert.match(await command('pwd'), new RegExp(primary));
    assert.equal(store.sessions.get('real')!.workingDirectory!.path, primary);
    const background = await bash.execute('background', { command: `${quote(process.execPath)} -e 'console.log(process.cwd());setInterval(()=>{},1000)'`, cwd: extra, mode: 'background' }, undefined, undefined, undefined as never);
    const processId = JSON.parse(background.content[0]!.type === 'text' ? background.content[0]!.text : '{}').processId as string;
    assert.equal(store.managedProcesses.get(processId)!.directory, extra);
    let logged = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      if ((await processes.logs(processId)).text.includes(extra)) { logged = true; break; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(logged, true); assert.equal(processes.hasDirectoryLease(extra), true);
    projects.updateProject(project.projectId, { directories: [primary] });
    await assert.rejects(command('pwd', extra), /当前已确认/);
    await processes.stopSession('real');
    assert.equal(processes.get(processId)!.state, 'exited');
    assert.equal(processes.hasDirectoryLease(extra), false);
  } finally { await processes.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});
