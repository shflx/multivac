import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommandShell, BASH_ANCHOR_COMMAND } from '../src/runtime/executors/command-shell.js';
import { childEnvironment, programLaunch } from '../src/runtime/program-launch.js';

test('bash 原包装不变；Windows 使用 PowerShell 5.1 编码命令且不加载 profile', () => {
  assert.deepEqual(createCommandShell('darwin').launch('echo 中文'), { file: '/bin/bash', args: ['--noprofile', '--norc', '-c', BASH_ANCHOR_COMMAND, 'multivac-bash', 'echo 中文'] });
  const command = "Write-Output '中文'; cmd.exe /c exit 7; Write-Output 'later'";
  const launch = createCommandShell('win32').launch(command);
  assert.match(launch.file, /WindowsPowerShell\\v1.0\\powershell.exe$/);
  assert.ok(launch.args.includes('-NoProfile'));
  assert.ok(!launch.args.includes('-ExecutionPolicy'));
  const script = Buffer.from(launch.args.at(-1)!, 'base64').toString('utf16le');
  assert.ok(script.includes(Buffer.from(command).toString('base64')));
  assert.match(script, /UTF8Encoding/);
  assert.match(script, /multivacExitCode -eq 0/);
  assert.match(script, /\$Error.Count -gt 0/);
  assert.match(script, /foreach\(\$multivacStatement/);
  assert.match(script, /Native calls in loops/);
  assert.match(script, /exit \$multivacExitCode/);
});
test('原生 argv、批处理、命令文本分开，环境白名单不会继承模型秘密', () => {
  const source = { Path: 'C:\\bin', SystemRoot: 'C:\\Windows', OPENAI_API_KEY: 'secret', MULTIVAC_TOKEN: 'secret', TEMP: 'C:\\tmp' };
  assert.deepEqual(childEnvironment(source, 'win32'), { Path: 'C:\\bin', SystemRoot: 'C:\\Windows', TEMP: 'C:\\tmp' });
  assert.equal(programLaunch('npm', ['run', 'check'], 'win32').file.endsWith('cmd.exe'), true);
  assert.equal(programLaunch('node.exe', ['-e', 'process.exit(7)'], 'win32').file, 'node.exe');
});

test('Windows 前台工具直接使用共用端口，保留中文输出与非零结果', async () => {
  const { managedBashTool } = await import('../src/runtime/executors/managed-bash-tool.js');
  const context = {} as never;
  let code: number | null = 7;
  const port = { async execute(_session: string, _directory: string, _id: string, _input: unknown, _signal: unknown, onData: (data: Buffer) => void) {
    onData(Buffer.from('中文输出'));
    return { process: { reason: '停止未确认', state: 'running' }, exitCode: code } as never;
  } };
  const tool = managedBashTool('session', 'C:\\project', port, undefined, 'win32');
  assert.match(tool.description, /Windows PowerShell 5.1/);
  await assert.rejects(tool.execute('call', { command: 'native.exe; Write-Output later' }, undefined, undefined, context), /退出码 7。\n中文输出/);
  code = null;
  await assert.rejects(tool.execute('call', { command: 'test' }, undefined, undefined, context), /停止未确认/);
  code = 0;
  const result = await tool.execute('call', { command: 'test' }, undefined, undefined, context);
  assert.deepEqual(result.content, [{ type: 'text', text: '中文输出' }]);
});
