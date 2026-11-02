import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './fixtures/skill-fixture.js';
import { createPiSkills, executeSkillEffect } from '../src/runtime/executors/pi-skills.js';
import { NativeTaskTools } from '../src/runtime/executors/native-task-tools.js';
test('真实 Skill 执行附属脚本、复制模板、越界差异与重放', { skip: process.platform !== 'darwin' && process.platform !== 'win32', timeout: 90_000 }, async () => {
  const f = fixture();
  let native: NativeTaskTools | undefined;
  try {
    mkdirSync(join(f.source, 'scripts'));
    mkdirSync(join(f.source, 'assets'));
    mkdirSync(join(f.source, 'references'));
    const cwd = join(f.root, 'work');
    mkdirSync(cwd);
    writeFileSync(
      join(f.source, 'scripts', 'report.cjs'),
      "require('node:fs').writeFileSync('report.txt','真实脚本产物');process.stdout.write('完成')",
    );
    writeFileSync(
      join(f.source, 'scripts', 'escape.cjs'),
      "require('node:fs').readFileSync('../sample/SKILL.md')",
    );
    writeFileSync(join(f.source, 'assets', 'template.txt'), '真实模板');
    writeFileSync(join(f.source, 'references', 'guide.md'), '真实参考');
    const p = f.service.preview({ source: f.source, displayName: '', projectId: null }),
      r = f.service.confirm('import', p.previewId);
    f.host.context = (() => ({
      sessionId: 's',
      projectId: null,
      host: 'work',
      tools: ['read', 'write', 'bash'],
    }));
    const skills = createPiSkills(f.service, 's');
    native = await NativeTaskTools.create(cwd, [join(f.root, 'packages')]);
    skills.bindExecutor(native.execute.bind(native));
    const tool = skills.definitions.find((t) => t.name === 'skill_resource')!;
    const invoke = (id: string, path: string, action: string, target?: string) =>
      tool.execute(
        id,
        { skillId: r.skillId, version: r.version, path, action, ...(target ? { target } : {}) },
        undefined,
        undefined,
        {} as never,
      );
    assert.match(JSON.stringify(await invoke('read', 'references/guide.md', 'read')), /真实参考/);
    await invoke('copy', 'assets/template.txt', 'copy', 'template.txt');
    assert.equal(readFileSync(join(cwd, 'template.txt'), 'utf8'), '真实模板');
    await invoke('run', 'scripts/report.cjs', 'run');
    assert.equal(readFileSync(join(cwd, 'report.txt'), 'utf8'), '真实脚本产物');
    writeFileSync(join(cwd, 'report.txt'), '不重复执行');
    await invoke('run', 'scripts/report.cjs', 'run');
    assert.equal(readFileSync(join(cwd, 'report.txt'), 'utf8'), '不重复执行');
    if (process.platform === 'win32') await invoke('escape', 'scripts/escape.cjs', 'run');
    else await assert.rejects(invoke('escape', 'scripts/escape.cjs', 'run'), /隔离执行已退出/);
    await assert.rejects(invoke('traversal', '../SKILL.md', 'read'));
    await assert.rejects(invoke('overwrite', 'assets/template.txt', 'copy', 'template.txt'));
  } finally {
    native?.dispose();
    f.close();
  }
});

test('Windows Skill 副作用：固定版本复制、脚本运行、重放与覆盖拒绝', { skip: process.platform !== 'win32', timeout: 90_000 }, async () => {
  const f = fixture();
  let native: NativeTaskTools | undefined;
  try {
    mkdirSync(join(f.source, 'scripts'));
    mkdirSync(join(f.source, 'assets'));
    const cwd = join(f.root, 'work');
    mkdirSync(cwd);
    writeFileSync(join(f.source, 'scripts', 'report.cjs'), "require('node:fs').writeFileSync('report.txt','脚本产物');process.stdout.write('完成')");
    writeFileSync(join(f.source, 'assets', 'template.txt'), '固定模板');
    const preview = f.service.preview({ source: f.source, displayName: '', projectId: null });
    const record = f.service.confirm('windows-import', preview.previewId);
    f.host.context = () => ({ sessionId: 's', projectId: null, host: 'work', tools: ['read', 'write', 'bash'] });
    native = await NativeTaskTools.create(cwd, [join(f.root, 'packages')]);
    const executor = native.execute.bind(native);
    const invoke = async (toolCallId: string, action: 'copy' | 'run', path: string, target?: string) => {
      const input = { skillId: record.skillId, version: record.version, action, path, ...(target ? { target } : {}) };
      const bytes = f.service.resource('s', input, path, toolCallId);
      return executeSkillEffect(f.service, 's', toolCallId, input, bytes, executor);
    };
    assert.equal(await invoke('copy', 'copy', 'assets/template.txt', 'template.txt'), '模板已复制');
    assert.equal(readFileSync(join(cwd, 'template.txt'), 'utf8'), '固定模板');
    assert.equal(await invoke('run', 'run', 'scripts/report.cjs'), '完成');
    assert.equal(readFileSync(join(cwd, 'report.txt'), 'utf8'), '脚本产物');
    writeFileSync(join(cwd, 'report.txt'), '不重复执行');
    assert.equal(await invoke('run', 'run', 'scripts/report.cjs'), '完成');
    assert.equal(readFileSync(join(cwd, 'report.txt'), 'utf8'), '不重复执行');
    await assert.rejects(invoke('overwrite', 'copy', 'assets/template.txt', 'template.txt'));
  } finally { native?.dispose(); f.close(); }
});
