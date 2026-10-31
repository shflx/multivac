import { secureWindowsPrivateDirectory } from './private-directory.js';
import { mkdirSync } from 'node:fs';
import { resolveRuntimeConfig } from '../runtime-config.js';
import { join, resolve } from 'node:path';

export interface MultivacDataPaths {
  dataDir: string;
  databasePath: string;
  assistantSessionDir: string;
  /** 工作会话的 Pi session 目录，与全局会话目录分开。 */
  workSessionDir: string;
  modelSettingsPath: string;
  modelCandidateDir: string;
  modelSelectionRecoveryDir: string;
  modelAccessPath: string;
  mcpCredentialPath: string;
}

/** 产品数据始终位于源码目录之外；测试通过 dataDir 注入临时目录。 */
export function resolveMultivacDataPaths(dataDir?: string): MultivacDataPaths {
  const resolvedDataDir = resolve(dataDir ?? resolveRuntimeConfig().dataDir);
  secureWindowsPrivateDirectory(resolvedDataDir);
  const assistantSessionDir = join(resolvedDataDir, 'assistant-sessions');
  const workSessionDir = join(assistantSessionDir, 'work');
  mkdirSync(workSessionDir, { recursive: true });

  return {
    dataDir: resolvedDataDir,
    databasePath: join(resolvedDataDir, 'multivac.sqlite'),
    assistantSessionDir,
    workSessionDir,
    modelSettingsPath: join(resolvedDataDir, 'model-settings.json'),
    modelCandidateDir: join(resolvedDataDir, 'model-runtime-candidates'),
    modelSelectionRecoveryDir: join(resolvedDataDir, 'model-selection-recovery'),
    modelAccessPath: join(resolvedDataDir, 'model-access.json'),
    mcpCredentialPath: join(resolvedDataDir, 'mcp-credentials.json'),
  };
}
