import type { HarnessFactory } from './harness.js';
import { PiCoordinatorAdapter } from './pi-coordinator-adapter.js';
import { resolvePiInstancePaths } from './pi-instance-paths.js';
import { PiModelAccessBackend } from './pi-model-access-backend.js';
import { PiModelSettingsCatalogFactory } from './pi-model-settings-catalog.js';
import { PI_HARNESS } from './pi-session-factory.js';

/**
 * Pi 执行器：会话保存在 Multivac 内部数据目录，凭据与模型目录使用本实例的 Pi 配置目录。
 * 适配器在会话间共享，只固定会话文件目录；工作目录按会话传入。
 */
export const createPiHarness: HarnessFactory = (context) => {
  const piPaths = resolvePiInstancePaths(context.instance);
  const { paths } = context;
  return {
    id: PI_HARNESS,
    adapter: new PiCoordinatorAdapter({
      usageRecorder: context.usageRecorder,
      executionDiagnostics: context.executionDiagnostics,
      taskProtectedPaths: [paths.dataDir],
      sessionDir: paths.assistantSessionDir,
      agentDir: piPaths.agentDir,
      temporaryRoot: paths.modelCandidateDir,
      authorizeToolCall: context.authorizeToolCall,
      bashProcesses: context.bashProcesses,
    }),
    modelSettingsCatalog: new PiModelSettingsCatalogFactory({ candidateRoot: paths.modelCandidateDir, authPath: piPaths.authPath }),
    modelAccess: new PiModelAccessBackend({ authPath: piPaths.authPath, temporaryRoot: paths.modelCandidateDir }),
    recordsUsage: true,
  };
};
