import { randomBytes, randomUUID } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function remoteTokenPath(dataDir: string): string {
  return join(dataDir, 'remote-access-token');
}

/** 只读完整的常规文件，不跟随 token 文件的符号链接，也不在损坏时悄悄换密钥。 */
function readStoredToken(path: string): string {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size < 64 || stat.size > 65) {
      throw new Error('保存的远程 token 文件无效，请在本机检查 remote-access-token 文件。');
    }
    const content = readFileSync(descriptor, 'utf8');
    if (!/^[a-f0-9]{64}\n?$/u.test(content)) {
      throw new Error('保存的远程 token 文件无效，请在本机检查 remote-access-token 文件。');
    }
    // 已有文件同样收紧权限，凭据只允许所属用户读写。
    fchmodSync(descriptor, 0o600);
    return content.trimEnd();
  } finally {
    closeSync(descriptor);
  }
}

/** 首次显式开启远程访问时生成 256 位随机 token，此后按数据目录复用。 */
export function loadOrCreateRemoteToken(dataDir: string): string {
  const path = remoteTokenPath(dataDir);
  try {
    return readStoredToken(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const token = randomBytes(32).toString('hex');
  const descriptor = openSync(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, `${token}\n`, { flush: true });
    // 完整写入后以不覆盖已有文件的方式发布；并发启动时复用先发布的 token。
    try {
      linkSync(temporaryPath, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  } finally {
    closeSync(descriptor);
    unlinkSync(temporaryPath);
  }
  return readStoredToken(path);
}
