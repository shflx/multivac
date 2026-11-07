import { lstat, readlink, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPathWithin } from './working-directory.js';

const UNICODE_SPACES = /[  -   　]/gu;
const MAX_SYMBOLIC_LINKS = 40;

/**
 * 与 Pi 文件工具（resolveToCwd）一致地把参数中的路径解析为绝对路径：统一 Unicode 空格、
 * 去掉开头的 `@`、展开 `~` 与 `file://`，相对路径相对会话工作目录，并按字面消去 `..`。
 * 判定的路径必须与工具实际访问的路径同源，否则边界可以被写法差异绕开。
 */
export function resolveToolInputPath(input: string, cwd: string): string {
  let path = input.replace(UNICODE_SPACES, ' ');
  if (path.startsWith('@')) path = path.slice(1);

  if (path === '~') path = homedir();
  else if (path.startsWith('~/')) path = join(homedir(), path.slice(2));
  else if (/^file:\/\//u.test(path)) path = fileURLToPath(path);

  return resolve(cwd, path);
}

function isMissingPath(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * 解析路径的真实位置：沿途跟随符号链接，包括指向尚不存在位置的悬空链接。
 * 目标尚不存在时，以最近的已存在祖先的真实路径为准，再接上尚不存在的部分。
 * 已存在部分取系统 realpath，大小写不敏感的文件系统上也得到与工作目录一致的写法。
 */
export async function resolveRealTargetPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!isMissingPath(error)) throw error;
  }

  const { root } = parse(path);
  const pending = path.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  let links = 0;
  while (pending.length > 0) {
    const name = pending.shift()!;
    if (name === '.') continue;
    if (name === '..') {
      current = dirname(current);
      continue;
    }

    const next = join(current, name);
    let stats;
    try {
      stats = await lstat(next);
    } catch (error) {
      if (!isMissingPath(error)) throw error;
      return join(await realpath(current), name, ...pending);
    }

    if (stats.isSymbolicLink()) {
      links += 1;
      if (links > MAX_SYMBOLIC_LINKS) throw new Error('符号链接层级过多。');
      const target = await readlink(next);
      pending.unshift(...target.split(sep).filter(Boolean));
      if (isAbsolute(target)) current = parse(target).root;
      continue;
    }
    current = next;
  }
  return realpath(current);
}

/** 按真实路径检查当前项目挂载，异步核对后再次确认挂载仍有效。 */
export async function isTargetInProjectDirectories(targetPath: string, directories: () => readonly string[]): Promise<boolean> {
  for (const directory of directories()) {
    try {
      const root = await realpath(directory);
      if ((await stat(root)).isDirectory() && isPathWithin(root, targetPath) && directories().includes(directory)) return true;
    } catch {
      // 失效目录不提供项目权限。
    }
  }
  return false;
}
