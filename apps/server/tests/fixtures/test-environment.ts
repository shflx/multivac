import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** 测试临时目录下的内部数据目录（按需创建，便于在启动应用前写入配置文件）。 */
export function testDataDir(root: string): string {
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  return dataDir;
}

/** 测试临时目录下的工作文件根目录，与内部数据目录分根。 */
export function testWorkRoot(root: string): string {
  return join(root, 'work');
}

/** 测试临时目录下的废纸篓：到期的临时目录移到这里，不触碰真实的废纸篓。 */
export function testTrashDir(root: string): string {
  return join(root, 'trash');
}

/**
 * 启动测试应用的环境：内部数据目录、工作文件根目录与废纸篓都在测试临时目录中，
 * 测试不会读写真实的 `~/.multivac/`、`~/Multivac/` 或系统废纸篓。
 */
export function testApplicationEnvironment(root: string): NodeJS.ProcessEnv {
  return {
    MULTIVAC_DATA_DIR: testDataDir(root),
    MULTIVAC_WORK_ROOT: testWorkRoot(root),
    MULTIVAC_TRASH_DIR: testTrashDir(root),
    MULTIVAC_FAKE_ASSISTANT: '1',
  };
}
