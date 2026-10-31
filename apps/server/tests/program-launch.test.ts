import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { programLaunch, runProgramSync, spawnProgram } from '../src/runtime/program-launch.js';

test('保留 POSIX 与 Windows 原生 argv，不交给 shell 解析', () => {
  const args = ['中文 空格', 'a&b', '$x', '"quote"'];
  assert.deepEqual(programLaunch('/bin/tool', args, 'darwin'), { file: '/bin/tool', args });
  assert.deepEqual(programLaunch('C:\\Program Files\\node.exe', args, 'win32'), { file: 'C:\\Program Files\\node.exe', args });
});
test('Windows npm/npx 显式经过 cmd.exe，每个批处理参数均加引号', () => {
  const launch = programLaunch('C:\\Program Files\\npm.cmd', ['run', '中文 & 空格'], 'win32', { ComSpec: 'C:\\Windows\\System32\\cmd.exe' });
  assert.deepEqual(launch, { file: 'C:\\Windows\\System32\\cmd.exe', args: ['/d', '/s', '/v:off', '/c', '""C:\\Program Files\\npm.cmd" "run" "中文 & 空格""'], windowsVerbatimArguments: true });
  assert.match(programLaunch('npx', ['--version'], 'win32').args.at(-1)!, /npx.cmd/);
  for (const arg of ['%PATH%', '!x!', 'x" & whoami', 'x\ny', '\0']) assert.throws(() => programLaunch('npm.cmd', [arg], 'win32'), /不能安全传递/);
});
test('共用启动保留退出码与异步启动错误', async () => {
  const result = runProgramSync(process.execPath, ['-e', 'process.stdout.write("中文"); process.exitCode=7'], { encoding: 'utf8' });
  assert.equal(result.status, 7); assert.equal(result.stdout, '中文');
  const child = spawnProgram('/multivac/missing-executable', [], { stdio: 'ignore' });
  const [error] = await once(child, 'error');
  assert.equal(error.code, 'ENOENT');
});
