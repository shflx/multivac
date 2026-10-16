import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';

export type MultivacMode = 'development' | 'production';
export interface MultivacRuntimeConfig {
  mode: MultivacMode;
  dataDir: string;
  workRoot: string;
  port: number;
  /** 稳定身份仅由模式与数据目录派生，不包含凭据。 */
  instanceId: string;
  cookieName: string;
}

export function resolveMode(value: string | undefined, required?: MultivacMode): MultivacMode {
  const mode = value?.trim() || required || 'production';
  if (mode !== 'development' && mode !== 'production') throw new Error('MULTIVAC_MODE 必须是 development 或 production。');
  if (required && mode !== required) throw new Error(`启动入口要求 ${required} 模式，与 MULTIVAC_MODE=${mode} 冲突。`);
  return mode;
}

export function resolvePort(value: string | undefined, mode: MultivacMode = 'production'): number {
  const normalized = value?.trim() || (mode === 'development' ? '4318' : '4317');
  const port = /^\d+$/u.test(normalized) ? Number(normalized) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('MULTIVAC_PORT 必须是 1 至 65535 的整数。');
  return port;
}

/** 对尚未创建的目录也核对其已有祖先的真实路径；不在配置解析中创建文件。 */
export function canonicalRuntimePath(path: string): string {
  let ancestor = resolve(path);
  const suffix: string[] = [];
  for (;;) {
    try { return resolve(realpathSync.native(ancestor), ...suffix); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      suffix.unshift(ancestor.slice(parent.length).replace(/^[/\\]/u, ''));
      ancestor = parent;
    }
  }
}

export function runtimePathsOverlap(left: string, right: string): boolean {
  const forms = [left, right].map(path => canonicalRuntimePath(path).toLowerCase());
  const contains = (root: string, path: string) => {
    const suffix = relative(root, path);
    return suffix === '' || (suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
  };
  return contains(forms[0]!, forms[1]!) || contains(forms[1]!, forms[0]!);
}

export function resolveRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env,
  requiredMode?: MultivacMode,
  home = homedir(),
): MultivacRuntimeConfig {
  const mode = resolveMode(environment.MULTIVAC_MODE, requiredMode);
  const dataDir = resolve(environment.MULTIVAC_DATA_DIR?.trim() || join(home, mode === 'development' ? '.multivac-dev' : '.multivac'));
  const workValue = environment.MULTIVAC_WORK_ROOT?.trim();
  if (workValue && !isAbsolute(workValue)) throw new Error('MULTIVAC_WORK_ROOT 必须是绝对路径。');
  const workRoot = resolve(workValue || join(home, mode === 'development' ? 'Multivac-dev' : 'Multivac'));
  const port = resolvePort(environment.MULTIVAC_PORT, mode);
  if ([dataDir, workRoot].some(path => path.includes('\0') || dirname(path) === path)) throw new Error('数据目录与工作根必须是有效的非根目录。');
  if (runtimePathsOverlap(dataDir, workRoot)) throw new Error('MULTIVAC_DATA_DIR 与 MULTIVAC_WORK_ROOT 必须互不包含。');
  if (mode === 'development') {
    for (const path of [dataDir, workRoot]) {
      if ([join(home, '.multivac'), join(home, 'Multivac'), join(home, '.pi')].some(protectedPath => runtimePathsOverlap(path, protectedPath))) {
        throw new Error('开发目录不得与默认生产目录或 Pi 全局目录重叠。请使用独立目录。');
      }
    }
    if (port === 5173) throw new Error('开发 API 端口不得占用 Vite 的 5173 端口。');
  }
  const instanceId = createHash('sha256').update(`${mode}\0${canonicalRuntimePath(dataDir)}`).digest('hex').slice(0, 24);
  const legacyProduction = mode === 'production' && canonicalRuntimePath(dataDir) === canonicalRuntimePath(join(home, '.multivac'));
  return Object.freeze({ mode, dataDir, workRoot, port, instanceId,
    cookieName: legacyProduction ? 'multivac_remote' : `multivac_remote_${instanceId}` });
}

/** 启动器向 API 与 Vite 传递同一份有效配置，避免子进程重新推断。 */
export function runtimeEnvironment(config: MultivacRuntimeConfig, environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...environment, MULTIVAC_MODE: config.mode, MULTIVAC_DATA_DIR: config.dataDir,
    MULTIVAC_WORK_ROOT: config.workRoot, MULTIVAC_PORT: String(config.port) };
}
