import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const files = process.argv.slice(2);
const targets = files.length ? files : [
  'packages/contracts/src/agent.ts',
  'packages/contracts/src/assistant-turn.ts',
  'packages/contracts/src/assistant-session.ts',
  'apps/server/src/modules/sessions/assistant-turn.ts',
  'apps/server/src/storage/sqlite-assistant-store.ts',
  'apps/server/src/application/assistant-turn-command-service.ts',
  'apps/web/src/features/assistant/submission-recovery.ts',
];
const results = [];
for (const path of targets) {
  try {
    // Node 原生 TypeScript 解析，不执行模块、不读取依赖或启动子进程。
    stripTypeScriptTypes(readFileSync(path, 'utf8'), { mode: 'transform', disableExperimentalWarning: true });
    results.push({ path, status: 'syntax-pass' });
  } catch (error) { results.push({ path, status: 'failed', message: error.message }); }
}
const result = { node: process.version, dependenciesInstalled: existsSync('node_modules/typescript'), results };
mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/session-agent-syntax.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
if (results.some(result => result.status === 'failed')) process.exitCode = 1;
