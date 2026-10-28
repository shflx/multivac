import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);
const LOCKFILE = 'package-lock.json';
const MARKER = join('node_modules', '.multivac-dependencies.json');

const exists = (path: string) => access(path).then(() => true, () => false);
const lockHash = (content: Buffer) => createHash('sha256').update(content).digest('hex');

/** 锁文件中登记的全部 node_modules 根目录（含 workspace 内未提升的依赖），不进入依赖内部的嵌套目录。 */
function dependencyRoots(lock: Buffer): string[] {
  let packages: Record<string, unknown> = {};
  try { packages = (JSON.parse(lock.toString('utf8')) as { packages?: Record<string, unknown> }).packages ?? {}; }
  catch { return []; }
  const roots = new Set<string>();
  for (const key of Object.keys(packages)) {
    const index = key.indexOf('node_modules/');
    if (index < 0) continue;
    const prefix = key.slice(0, index);
    // 只接受仓库内的相对目录，拒绝依赖内部嵌套、绝对路径与目录穿越。
    if (prefix.includes('node_modules') || prefix.startsWith('/') || prefix.split('/').includes('..')) continue;
    roots.add(`${prefix}node_modules`);
  }
  return [...roots].sort();
}

/**
 * 为任务 worktree 准备 Node 依赖：仅当 package-lock.json 与项目主目录完全一致时，
 * 以 APFS 写时复制克隆主目录已安装的 node_modules。不联网、不执行任何依赖脚本；
 * 符号链接按原样保留（npm workspaces 使用相对链接，克隆后指向任务目录内的代码）。
 * 条件不满足时不准备，由提示词如实说明。
 */
export async function prepareNodeDependencies(sourceRoot: string, target: string, signal: AbortSignal): Promise<void> {
  if (process.platform !== 'darwin') return;
  const targetLock = join(target, LOCKFILE);
  if (!await exists(targetLock)) return;
  let sourceLock: Buffer;
  try { sourceLock = await readFile(join(sourceRoot, LOCKFILE)); }
  catch { return; }
  const lock = await readFile(targetLock);
  if (!lock.equals(sourceLock)) return;

  const roots = dependencyRoots(lock);
  if (!roots.includes('node_modules') || !await exists(join(sourceRoot, 'node_modules'))) return;
  for (const root of roots) {
    signal.throwIfAborted();
    const from = join(sourceRoot, root);
    if (!await exists(from) || await exists(join(target, root))) continue;
    // -c 使用 clonefile 写时复制，-R 不跟随符号链接；不支持写时复制的卷直接失败，不退化为完整复制。
    await executeFile('/bin/cp', ['-c', '-R', from, join(target, dirname(root), '')], { timeout: 120000, signal });
  }
  await writeFile(join(target, MARKER), JSON.stringify({ lockSha256: lockHash(lock), preparedAt: new Date().toISOString() }));
}

/** 提示词中的依赖说明：没有 package-lock.json 时不提及；标记与当前锁文件一致才视为已准备。 */
export async function describeNodeDependencies(directory: string): Promise<string | null> {
  let lock: Buffer;
  try { lock = await readFile(join(directory, LOCKFILE)); }
  catch { return null; }
  try {
    const marker = JSON.parse(await readFile(join(directory, MARKER), 'utf8')) as { lockSha256?: unknown };
    if (marker.lockSha256 === lockHash(lock)) return '依赖：已按项目主目录的 package-lock.json 准备 node_modules（未联网、未执行依赖脚本），可按项目要求使用共用 bash 安装或更新依赖，仍受任务预算约束。';
  } catch { /* 没有准备标记。 */ }
  return '依赖：任务目录未准备 node_modules（锁文件与项目主目录不一致，或主目录尚未安装依赖），可使用共用 bash 安装项目依赖后运行检查；失败时记录真实原因并修复。';
}
