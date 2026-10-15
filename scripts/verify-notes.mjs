import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// 用户本地验证入口，需要正常Node/npm、已安装的仓库依赖及可用Chromium。
// 不适用于禁止派生进程的任务执行环境；本轮不会借此绕过隔离。
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--browser')) throw new Error('仅支持 --browser；默认执行类型、SQL及针对性服务/Web测试。');
const major = Number(process.versions.node.split('.')[0]);
const minor = Number(process.versions.node.split('.')[1]);
if (major < 22 || major === 22 && minor < 19) throw new Error('需要Node >=22.19.0。');
const root = process.cwd();
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const checks = [
  { name: '仓库类型检查（先构建contracts）', command: npm, args: ['run', 'check'] },
  { name: '新增模块引用与新增迁移SQL', command: process.execPath, args: ['scripts/notes-static-check.mjs'] },
  { name: '笔记服务及受影响会话/阅读回归', command: process.execPath, args: ['--import', 'tsx', '--test',
    'apps/server/tests/notes.test.ts', 'apps/server/tests/note-versions.test.ts', 'apps/server/tests/note-delete.test.ts', 'apps/server/tests/note-assistant.test.ts', 'apps/server/tests/note-suggestions.test.ts',
    'apps/server/tests/note-pi-history.test.ts', 'apps/server/tests/note-tools.test.ts', 'apps/server/tests/note-tools-real-pi.test.ts',
    'apps/server/tests/reading-pi-history.test.ts',
    'apps/server/tests/session-context.test.ts', 'apps/server/tests/session-files.test.ts',
    'apps/server/tests/workspace-sessions.test.ts', 'apps/server/tests/fake-reading-context.test.ts',
  ] },
  { name: 'Web草稿及导航回归', command: process.execPath, args: ['--import', 'tsx', '--test', 'apps/web/tests/note-draft.test.ts', 'apps/web/tests/note-markdown.test.ts', 'apps/web/tests/management-nav.test.ts'] },
];
if (args.includes('--browser')) checks.push({ name: '笔记浏览器用例（受控模型夹具）', command: npm, args: ['run', 'test:e2e', '--', 'tests/e2e/notes.spec.ts', 'tests/e2e/multivac-notes.spec.ts'] });
const report = { timestamp: new Date().toISOString(), node: process.versions.node,
  checks: checks.map(check => ({ name: check.name, command: [check.command, ...check.args], status: 'not-run', exitCode: null, error: null })),
  notCovered: ['真实配置模型访问/建议质量', '人工原型视觉核验', '停止运行后跨重启历史的真实模型闭环'],
};
if (!args.includes('--browser')) report.notCovered.push('浏览器验证：使用 --browser 启用');
const out = resolve(root, 'artifacts/notes-local-validation.json');
mkdirSync(resolve(root, 'artifacts'), { recursive: true });
const save = () => writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
save();
for (const [index, check] of checks.entries()) {
  console.log(`正在验证：${check.name}`);
  const result = spawnSync(check.command, check.args, { cwd: root, stdio: 'inherit', shell: false });
  report.checks[index].exitCode = result.status;
  report.checks[index].error = result.error?.message ?? (result.signal ? `进程信号：${result.signal}` : null);
  report.checks[index].status = !result.error && result.status === 0 ? 'pass' : 'failed';
  save();
  if (report.checks[index].status === 'failed') { process.exitCode = 1; break; }
}
console.log(`实际验证结果：${out}`);
