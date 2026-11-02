import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnWindowsObservedCommand, stopWindowsObservedCommand } from '../src/runtime/executors/windows-stdio-supervisor.js';
import { NativeTaskTools } from '../src/runtime/executors/native-task-tools.js';
import { gitEnvironment, gitNullDevice } from '../src/application/git-platform.js';

test('Windows 直接命令保留输入、退出码且不继承模型密钥', { skip: process.platform !== 'win32', timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-direct-command-'));
  const script = `let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{if(process.env.OPENAI_API_KEY)process.exit(44);process.stdout.write(input);process.exit(7)});`;
  const child = spawnWindowsObservedCommand(process.execPath, ['-e', script], root, { ...process.env, OPENAI_API_KEY: 'private-test-value' });
  let output = '';
  try {
    child.stdout!.on('data', chunk => { output += chunk.toString(); });
    const closed = once(child, 'close');
    child.stdin!.end('中文输入');
    const [code] = await closed;
    assert.equal(code, 7);
    assert.equal(output, '中文输入');
  } finally { stopWindowsObservedCommand(child); await rm(root, { recursive: true, force: true }); }
});

test('Windows 直接命令取消后确认已观察的子进程退出', { skip: process.platform !== 'win32', timeout: 40_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-direct-tree-'));
  const script = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});console.log('CHILD:'+child.pid);setInterval(()=>{},1000);`;
  const child = spawnWindowsObservedCommand(process.execPath, ['-e', script], root);
  let output = '';
  try {
    child.stdout!.on('data', chunk => { output += chunk.toString(); });
    const closed = once(child, 'close');
    child.stdin!.end();
    for (let attempt = 0; attempt < 100 && !output.includes('CHILD:'); attempt++) await new Promise(resolve => setTimeout(resolve, 100));
    const pid = Number(/CHILD:(\d+)/u.exec(output)?.[1]);
    assert.ok(pid > 0, output);
    await new Promise(resolve => setTimeout(resolve, 750));
    stopWindowsObservedCommand(child);
    const [code] = await closed;
    assert.equal(code, 124);
    const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const result = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', `if(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'){'alive'}else{'absent'}`], { encoding: 'utf8' });
    assert.equal(result.trim(), 'absent');
  } finally { stopWindowsObservedCommand(child); await rm(root, { recursive: true, force: true }); }
});

test('Windows 任务工具直接执行仍结算租约、输出额度和超时', { skip: process.platform !== 'win32', timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-direct-task-tool-'));
  const phases: string[] = [];
  const lease = (phase: string, marker: string, bytes: number) => { phases.push(`${phase}:${marker}:${bytes}`); return 1000; };
  const tools = await NativeTaskTools.create(root, [], lease);
  try {
    const result = await tools.execute(process.execPath, ['-e', "process.stdout.write('租约通过')"], { fenced: true });
    assert.equal(result.code, 0);
    assert.equal(result.output.toString(), '租约通过');
    assert.equal(phases.filter(item => item.startsWith('starting:')).length, 1);
    assert.equal(phases.filter(item => item.startsWith('settled:')).length, 1);
    await assert.rejects(tools.execute(process.execPath, ['-e', "process.stdout.write('x'.repeat(200))"], { fenced: true, limit: 20 }), /输出超过上限/u);
    const timedOut = await tools.execute(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { fenced: true, timeoutMs: 600 });
    assert.equal(timedOut.code, 124);
    assert.equal(tools.processesStopped, true);
  } finally { tools.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('Windows 受控 Git 的直接执行保留固定仓库参数且不继承 Git 跟踪环境', { skip: process.platform !== 'win32', timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-direct-git-'));
  try {
    execFileSync('git.exe', ['init', '-q', root]);
    await writeFile(join(root, 'result.txt'), '待提交');
    const environment = gitEnvironment('win32', { ...process.env, GIT_TRACE: join(root, 'trace-canary') }, 'worktree', root);
    const child = spawnWindowsObservedCommand('git.exe', [`--git-dir=${join(root, '.git')}`, `--work-tree=${root}`,
      '-c', `core.hooksPath=${gitNullDevice('win32')}`, 'status', '--porcelain'], root, process.env, environment);
    let output = '';
    child.stdout!.on('data', chunk => { output += chunk.toString(); });
    child.stdin!.end();
    const [code] = await once(child, 'close');
    assert.equal(code, 0);
    assert.match(output, /result\.txt/u);
    await assert.rejects(stat(join(root, 'trace-canary')), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
