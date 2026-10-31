import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { privateDirectoryAclScript, secureWindowsPrivateDirectory } from '../src/storage/private-directory.js';
import type { runProgramSync } from '../src/runtime/program-launch.js';

test('ACL 使用稳定 SID 和继承，替身核对命令失败/错误输出都不放行', () => {
  const directory = mkdtempSync(join(tmpdir(), 'multivac-acl-'));
  try {
    let calls = 0;
    const run: typeof runProgramSync = (file, args, options) => {
      calls++;
      assert.match(file, /WindowsPowerShell/);
      assert.ok(args.includes('-NoProfile')); assert.ok(!args.includes('-ExecutionPolicy'));
      const script = Buffer.from(args.at(-1)!, 'base64').toString('utf16le');
      assert.match(script, /S-1-5-18/); assert.match(script, /S-1-5-32-544/);
      assert.match(script, /ContainerInherit,ObjectInherit/); assert.match(script, /SetAccessRuleProtection\(\$true,\$false\)/);
      assert.equal(options.timeout, 15000);
      return { pid: 1, output: [], stdout: 'multivac-acl-v1', stderr: '', status: 0, signal: null };
    };
    secureWindowsPrivateDirectory(directory, 'auth.json', { platform: 'win32', run });
    assert.equal(calls, 1);
    for (const failure of [{ status: 1, stdout: '' }, { status: 0, stdout: 'unexpected' }])
      assert.throws(() => secureWindowsPrivateDirectory(directory, 'auth.json', { platform: 'win32', run: (() => ({ ...failure })) as typeof run }), /ACL 无法确认/);
    assert.equal(lstatSync(directory).isDirectory(), true);
    assert.throws(() => secureWindowsPrivateDirectory(directory, '../auth', { platform: 'win32', run }));
    writeFileSync(join(directory, 'target'), '{}'); symlinkSync('target', join(directory, 'auth.json'));
    assert.throws(() => secureWindowsPrivateDirectory(directory, 'auth.json', { platform: 'win32', run }), /类型无效/);
    assert.equal(calls, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('POSIX 分支不调用 ACL 命令；路径引号是字面数据', () => {
  secureWindowsPrivateDirectory('/missing', undefined, { platform: 'darwin', run: (() => { throw new Error(); }) as typeof runProgramSync });
  const script = privateDirectoryAclScript("C:\\数据'目录", 'auth.json');
  assert.match(script, /数据''目录/); assert.match(script, /ReparsePoint/); assert.match(script, /IsInherited/);
});
