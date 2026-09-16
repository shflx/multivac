import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ModelAccessError } from '../../modules/model-settings/model-access.js';

/** 只准备权限和空文件，凭据内容的读写/锁仍全部由 Pi CredentialStore 完成。 */
export async function securePiAuthFile(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const parent = await lstat(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink() ||
    (process.getuid && parent.uid !== process.getuid()) || (parent.mode & 0o022) !== 0) {
    throw new ModelAccessError('ACCESS_UNAVAILABLE');
  }
  try {
    const created = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try { await created.writeFile('{}'); await created.sync(); } finally { await created.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const descriptor = await handle.stat();
    if (!descriptor.isFile() || descriptor.nlink !== 1 ||
      (process.getuid && descriptor.uid !== process.getuid())) throw new ModelAccessError('ACCESS_UNAVAILABLE');
    await handle.chmod(0o600);
    await handle.sync();
    const current = await lstat(path);
    if (current.isSymbolicLink() || current.ino !== descriptor.ino || current.dev !== descriptor.dev ||
      (current.mode & 0o777) !== 0o600) throw new ModelAccessError('ACCESS_UNAVAILABLE');
  } finally { await handle.close(); }
}
