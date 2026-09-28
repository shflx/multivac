import { closeSync, cpSync, mkdirSync, openSync, renameSync, rmdirSync, rmSync, unlinkSync, writeSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';

/**
 * 废纸篓：到期的会话临时目录移到这里，而不是直接删除，误清理时还能找回。
 *
 * 实现都不覆盖废纸篓中已有的条目：先以独占方式占住一个名字（重名时依次追加 `-2`、`-3`……），
 * 再把目录移进去；移动失败时释放占位，原目录保持不动。
 * 测试与 E2E 一律注入临时目录（`DirectoryTrash` / `MULTIVAC_TRASH_DIR`），不触碰真实的废纸篓。
 */
export interface Trash {
  /** 把目录移到废纸篓，返回它在废纸篓中的位置；失败时抛错，原目录不变。 */
  moveToTrash(path: string): string;
}

/** 占位名最多尝试的次数；正常情况下远用不到。 */
const MAX_NAME_ATTEMPTS = 10_000;

function candidateName(name: string, attempt: number): string {
  return attempt === 1 ? name : `${name}-${attempt}`;
}

function isExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'EEXIST';
}

/**
 * 把目录移到已占好的空占位目录上：同一文件系统内直接改名（POSIX 的 rename 只会替换空目录，
 * 占位期间有人写入时失败而不是覆盖）；跨设备时复制后删除原目录，复制失败则清掉不完整的副本。
 */
function moveOntoPlaceholder(source: string, placeholder: string): void {
  try {
    renameSync(source, placeholder);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
  }
  try {
    cpSync(source, placeholder, {
      recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true, preserveTimestamps: true,
    });
  } catch (error) {
    rmSync(placeholder, { recursive: true, force: true });
    throw error;
  }
  rmSync(source, { recursive: true, force: true });
}

/**
 * 以一个普通目录作为废纸篓：macOS 的 `~/.Trash`，以及测试注入的临时目录。
 * 目录移入后保持原名，重名时追加后缀。
 */
export class DirectoryTrash implements Trash {
  constructor(private readonly directory: string) {
    if (!isAbsolute(directory)) throw new Error(`废纸篓必须是绝对路径：${directory}`);
  }

  moveToTrash(path: string): string {
    mkdirSync(this.directory, { recursive: true });
    const name = basename(path);
    for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt += 1) {
      const target = join(this.directory, candidateName(name, attempt));
      try {
        mkdirSync(target);
      } catch (error) {
        if (isExists(error)) continue;
        throw error;
      }
      try {
        moveOntoPlaceholder(path, target);
      } catch (error) {
        try { rmdirSync(target); } catch { /* 占位已被占用或已删除：保持原样，不覆盖。 */ }
        throw error;
      }
      return target;
    }
    throw new Error(`废纸篓中没有可用的名字：${name}`);
  }
}

/** trashinfo 中的路径按 URL 规则编码，保留分隔符。 */
function encodeTrashPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

/** trashinfo 中的删除时间：本地时间 `YYYY-MM-DDThh:mm:ss`。 */
function localDeletionDate(at: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

/**
 * freedesktop.org（XDG）规范的废纸篓：`$XDG_DATA_HOME/Trash`（缺省 `~/.local/share/Trash`），
 * 目录移到 `files/<名字>`，并在 `info/<名字>.trashinfo` 中记下原路径与删除时间，文件管理器可以据此还原。
 * 按规范先以独占方式创建 trashinfo 占住名字，再移动目录；失败时删除 trashinfo。
 */
export class XdgTrash implements Trash {
  constructor(private readonly root: string, private readonly now: () => Date = () => new Date()) {
    if (!isAbsolute(root)) throw new Error(`废纸篓必须是绝对路径：${root}`);
  }

  moveToTrash(path: string): string {
    const filesDir = join(this.root, 'files');
    const infoDir = join(this.root, 'info');
    mkdirSync(filesDir, { recursive: true, mode: 0o700 });
    mkdirSync(infoDir, { recursive: true, mode: 0o700 });
    const name = basename(path);
    for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt += 1) {
      const candidate = candidateName(name, attempt);
      const infoPath = join(infoDir, `${candidate}.trashinfo`);
      let descriptor: number;
      try {
        descriptor = openSync(infoPath, 'wx', 0o600);
      } catch (error) {
        if (isExists(error)) continue;
        throw error;
      }
      const target = join(filesDir, candidate);
      try {
        writeSync(descriptor, `[Trash Info]\nPath=${encodeTrashPath(path)}\nDeletionDate=${localDeletionDate(this.now())}\n`);
      } catch (error) {
        closeSync(descriptor);
        unlinkSync(infoPath);
        throw error;
      }
      closeSync(descriptor);
      try {
        mkdirSync(target);
      } catch (error) {
        unlinkSync(infoPath);
        // files/ 中已有同名条目（没有对应的 trashinfo）：换下一个名字。
        if (isExists(error)) continue;
        throw error;
      }
      try {
        moveOntoPlaceholder(path, target);
      } catch (error) {
        try { rmdirSync(target); } catch { /* 保持原样，不覆盖。 */ }
        unlinkSync(infoPath);
        throw error;
      }
      return target;
    }
    throw new Error(`废纸篓中没有可用的名字：${name}`);
  }
}

/** 当前平台没有可用的废纸篓：到期的临时目录保持不动，下次检查时重试。 */
export class UnavailableTrash implements Trash {
  constructor(private readonly reason: string) {}

  moveToTrash(): string {
    throw new Error(this.reason);
  }
}

/**
 * 系统废纸篓：macOS 为 `~/.Trash`；Windows 的回收站需要系统接口，暂不支持（到期的临时目录保留不动）；
 * 其他平台（Linux 等）按 XDG 规范使用 `$XDG_DATA_HOME/Trash` 或 `~/.local/share/Trash`。
 * 只在真正移动时才访问文件系统。
 */
export function systemTrash(input: { platform: NodeJS.Platform; homeDir: string; xdgDataHome?: string | undefined }): Trash {
  if (input.platform === 'darwin') return new DirectoryTrash(join(input.homeDir, '.Trash'));
  if (input.platform === 'win32') return new UnavailableTrash('Windows 的回收站暂不支持，到期的临时目录保留不动。');
  const dataHome = input.xdgDataHome && isAbsolute(input.xdgDataHome)
    ? input.xdgDataHome
    : join(input.homeDir, '.local', 'share');
  return new XdgTrash(join(dataHome, 'Trash'));
}
