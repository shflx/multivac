import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface DirectoryUsage {
  /** 根目录第一层的子目录数（符号链接不算）。 */
  directories: number;
  /** 其中文件的字节数之和。 */
  bytes: number;
  /** 条目数超过上限、停止统计时为 true。 */
  truncated: boolean;
}

/** 默认最多统计的条目数：足够覆盖正常使用，异常庞大的目录不会让一次请求长时间占用服务。 */
export const DIRECTORY_USAGE_MAX_ENTRIES = 200_000;
/** 同一目录中并发读取元数据的条目数。 */
const LSTAT_BATCH = 64;

/**
 * 统计目录的占用：异步逐层遍历，不阻塞事件循环。
 * - 不跟随符号链接（lstat）：链接只计链接本身，指向的内容（可能是项目目录或别处）不计入；
 * - 硬链接按设备与 inode 只计一次；
 * - 读不到的条目（权限、遍历中被删除）跳过，不让整次统计失败；根目录不存在时为 0。
 */
export async function measureDirectoryUsage(
  root: string,
  options: { maxEntries?: number } = {},
): Promise<DirectoryUsage> {
  const maxEntries = options.maxEntries ?? DIRECTORY_USAGE_MAX_ENTRIES;
  const seenInodes = new Set<string>();
  const pending = [root];
  let directories = 0;
  let bytes = 0;
  let entries = 0;

  while (pending.length > 0) {
    const directory = pending.pop()!;
    let names: string[];
    try {
      names = await readdir(directory);
    } catch {
      continue;
    }
    for (let start = 0; start < names.length; start += LSTAT_BATCH) {
      const batch = names.slice(start, start + LSTAT_BATCH);
      if (entries + batch.length > maxEntries) return { directories, bytes, truncated: true };
      entries += batch.length;
      const stats = await Promise.all(batch.map((name) => lstat(join(directory, name)).catch(() => null)));
      stats.forEach((stat, index) => {
        if (!stat) return;
        if (stat.isDirectory()) {
          if (directory === root) directories += 1;
          pending.push(join(directory, batch[index]!));
          return;
        }
        if (stat.nlink > 1) {
          const inode = `${stat.dev}:${stat.ino}`;
          if (seenInodes.has(inode)) return;
          seenInodes.add(inode);
        }
        bytes += stat.size;
      });
    }
  }
  return { directories, bytes, truncated: false };
}
