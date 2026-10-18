import { mkdirSync, realpathSync } from 'node:fs';
import { canonicalRuntimePath, resolveRuntimeConfig, WorkRootConfigurationError } from '../../runtime-config.js';
import { isAbsolute, join, resolve } from 'node:path';
import { isPathWithin } from './working-directory.js';

export { WorkRootConfigurationError } from '../../runtime-config.js';

/**
 * 工作文件根目录：会话在其中读写用户文件，与内部数据目录（SQLite、Pi session 等）分根。
 *
 * - `multivac/`：全局 Multivac 的工作目录，长期保留；
 * - `sessions/`：不属于项目的工作会话各自的临时目录；
 * - `projects/`：托管项目目录（预留，由项目功能创建）。
 */
export interface MultivacWorkPaths {
  workRoot: string;
  multivacDir: string;
  sessionsDir: string;
  projectsDir: string;
  /** 开发实例的托管目录不得通过历史记录或链接逃出工作根。 */
  strictInstanceBoundary?: boolean;
}

/**
 * 解析并创建工作文件根目录。默认 `~/Multivac/`，可由 `MULTIVAC_WORK_ROOT` 指定（须为绝对路径）。
 *
 * 启动时校验工作文件根目录与内部数据目录互不包含：工作目录一律不得位于内部数据目录之下，
 * 内部数据也不放进工作文件根目录。比较使用解析符号链接后的真实路径。
 */
export function resolveMultivacWorkPaths(workRoot: string | undefined, dataDir: string, strictInstanceBoundary = false): MultivacWorkPaths {
  if (workRoot !== undefined && !isAbsolute(workRoot)) {
    throw new WorkRootConfigurationError(`MULTIVAC_WORK_ROOT 必须是绝对路径：${workRoot}`);
  }
  const resolvedRoot = resolve(workRoot ?? resolveRuntimeConfig().workRoot);
  const paths: MultivacWorkPaths = {
    workRoot: resolvedRoot,
    multivacDir: join(resolvedRoot, 'multivac'),
    sessionsDir: join(resolvedRoot, 'sessions'),
    projectsDir: join(resolvedRoot, 'projects'),
    ...(strictInstanceBoundary ? { strictInstanceBoundary: true } : {}),
  };

  // 先按字面路径校验，冲突时不在内部数据目录中创建任何目录；创建后再按真实路径复核符号链接。
  const conflict = () => new WorkRootConfigurationError(
    `工作文件根目录 ${resolvedRoot} 与内部数据目录 ${dataDir} 相互包含：工作目录不得位于内部数据目录之下。`
    + '请通过 MULTIVAC_WORK_ROOT 或 MULTIVAC_DATA_DIR 把两者设为互不包含的目录。',
  );
  if (overlaps(resolve(dataDir), resolvedRoot)) throw conflict();
  const realDataDir = realpathSync.native(dataDir);
  if (overlaps(realDataDir, realpathSync.native(ensureDirectory(resolvedRoot)))) throw conflict();
  // 子目录若是指向内部数据目录的符号链接，同样拒绝。
  for (const directory of [paths.multivacDir, paths.sessionsDir, paths.projectsDir, join(resolvedRoot, 'tasks')]) {
    assertManagedWorkPath(paths, directory);
    if (isPathWithin(realDataDir, canonicalRuntimePath(directory))) {
      throw new WorkRootConfigurationError(`工作目录 ${directory} 实际位于内部数据目录 ${dataDir} 之下。`);
    }
  }
  for (const directory of [paths.multivacDir, paths.sessionsDir]) ensureDirectory(directory);
  return paths;
}

/** 外部挂载目录不调用此校验；这里只保护本实例自动创建、恢复和清理的托管目录。 */
export function assertManagedWorkPath(paths: MultivacWorkPaths, path: string): void {
  if (!paths.strictInstanceBoundary) return;
  const root = canonicalRuntimePath(paths.workRoot);
  const target = canonicalRuntimePath(path);
  if (root === target || !isPathWithin(root, target)) {
    throw new WorkRootConfigurationError(`开发托管目录 ${path} 必须位于本实例工作根 ${paths.workRoot} 内。`);
  }
}

function overlaps(left: string, right: string): boolean {
  return isPathWithin(left, right) || isPathWithin(right, left);
}

function ensureDirectory(directory: string): string {
  mkdirSync(directory, { recursive: true });
  return directory;
}
