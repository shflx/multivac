import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface MultivacDataPaths {
  dataDir: string;
  databasePath: string;
  assistantSessionDir: string;
}

/** 产品数据始终位于源码目录之外；测试通过 dataDir 注入临时目录。 */
export function resolveMultivacDataPaths(dataDir?: string): MultivacDataPaths {
  const resolvedDataDir = resolve(dataDir ?? join(homedir(), '.multivac'));
  const assistantSessionDir = join(resolvedDataDir, 'assistant-sessions');
  mkdirSync(assistantSessionDir, { recursive: true });

  return {
    dataDir: resolvedDataDir,
    databasePath: join(resolvedDataDir, 'multivac.sqlite'),
    assistantSessionDir,
  };
}
