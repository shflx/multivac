import { createHash } from 'node:crypto';
import {
  constants,
  closeSync,
  mkdirSync,
  openSync,
  readSync,
  copyFileSync,
  cpSync,
  linkSync,
  lstatSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';

/**
 * 会话归入项目时，把临时目录里的文件移入项目目录。
 *
 * 规则只有一条：不覆盖。按第一层条目（文件、子目录、符号链接）逐个移动，
 * 项目目录中已有同名条目（在大小写不敏感的文件系统上也按实际占用判断）的条目不移动，留在原目录，
 * 由调用方列给用户；单个条目移动失败同样留在原处，不影响其他条目。
 */

function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 目录第一层的条目名，按名称排序；目录不存在时为空。 */
export function listDirectoryEntries(directory: string): string[] {
  try {
    return readdirSync(directory).sort(compareNames);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** 路径是否已被占用（包括悬空的符号链接）；无法确认时按已占用处理，宁可不移动也不覆盖。 */
export function isPathOccupied(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== 'ENOENT' && code !== 'ENOTDIR';
  }
}

/** 源目录中与目标目录已有条目同名、不会移入的条目。 */
export function conflictingEntries(source: string, target: string): string[] {
  return listDirectoryEntries(source).filter((name) => isPathOccupied(join(target, name)));
}

/** Windows 不依赖 POSIX 空目录替换：独占目标、核对副本及源快照后才删除源。失败保留源和部分副本。 */
function directorySnapshot(root: string, identity: boolean): string {
  const entries: unknown[] = [];
  const visit = (path: string, relative: string) => {
    const stat = lstatSync(path);
    let content: string;
    if (stat.isSymbolicLink()) content = `link:${readlinkSync(path)}`;
    else if (stat.isDirectory()) content = 'directory';
    else if (stat.isFile()) {
      const hash = createHash('sha256'), fd = openSync(path, 'r');
      try {
        const buffer = Buffer.alloc(64 * 1024);
        let size: number;
        while ((size = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, size));
      } finally { closeSync(fd); }
      content = hash.digest('hex');
    } else throw new Error('目录包含非普通文件，保留原目录。');
    entries.push([relative, content, ...(identity ? [stat.dev, stat.ino, stat.size, stat.mtimeMs] : [])]);
    if (stat.isDirectory()) for (const name of readdirSync(path).sort(compareNames)) visit(join(path, name), `${relative}/${name}`);
  };
  visit(root, '');
  return JSON.stringify(entries);
}
const directoryMoveIo = { mkdirSync, cpSync, rmSync };
function moveWindowsDirectory(source: string, target: string, io: typeof directoryMoveIo): void {
  const before = directorySnapshot(source, true), content = directorySnapshot(source, false);
  io.mkdirSync(target); // 已存在（包括空目录）必须失败，不覆盖目标。
  io.cpSync(source, target, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
  if (directorySnapshot(target, false) !== content || directorySnapshot(source, true) !== before)
    throw new Error('目录复制后源或目标已变化，保留源与副本等待核对。');
  io.rmSync(source, { recursive: true });
}

/**
 * 把一个条目移到尚不存在的目标路径，任何情况下都不覆盖目标：
 * - 普通文件先建硬链接（目标已存在时失败）再删除源；跨设备时以 COPYFILE_EXCL 复制后删除源；
 * - 符号链接按原指向重建（目标已存在时失败）再删除源；
 * - POSIX 目录直接改名；跨设备时复制后删除源。Windows 独占目标并核对复制结果后删除源。
 */
export function moveEntryWithoutReplace(source: string, target: string, platform: NodeJS.Platform = process.platform, io = directoryMoveIo): void {
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) {
    symlinkSync(readlinkSync(source), target);
    unlinkSync(source);
    return;
  }
  if (stat.isDirectory()) {
    if (platform === 'win32') { moveWindowsDirectory(source, target, io); return; }
    try {
      renameSync(source, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
      cpSync(source, target, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
      rmSync(source, { recursive: true });
    }
    return;
  }
  try {
    linkSync(source, target);
  } catch (error) {
    // 跨设备或文件系统不支持硬链接时改为复制；目标已存在（EEXIST）等其他错误照常抛出。
    if (!['EXDEV', 'EPERM', 'ENOTSUP', 'EMLINK'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    copyFileSync(source, target, constants.COPYFILE_EXCL);
  }
  unlinkSync(source);
}

/** 移入的结果：已移入与留在原处的条目名（按名称排序）。 */
export interface DirectoryEntriesMove {
  moved: string[];
  skipped: string[];
}

/**
 * 把 source 第一层的条目逐个移入 target（target 须已存在）：同名的跳过，失败的跳过，都留在 source。
 */
export function moveDirectoryEntries(source: string, target: string): DirectoryEntriesMove {
  const result: DirectoryEntriesMove = { moved: [], skipped: [] };
  for (const name of listDirectoryEntries(source)) {
    const destination = join(target, name);
    if (isPathOccupied(destination)) {
      result.skipped.push(name);
      continue;
    }
    try {
      moveEntryWithoutReplace(join(source, name), destination);
      result.moved.push(name);
    } catch {
      result.skipped.push(name);
    }
  }
  return result;
}
