import { join, relative, isAbsolute, sep } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { canonicalRuntimePath, type MultivacRuntimeConfig } from '../../runtime-config.js';

/** 生产继续使用既有 Pi 配置；开发的每个 Pi 入口都绑定数据目录内同一个私有根。 */
export function resolvePiInstancePaths(config: MultivacRuntimeConfig, legacyAgentDir: () => string = getAgentDir) {
  const agentDir = config.mode === 'development' ? join(config.dataDir, 'pi') : legacyAgentDir();
  if (config.mode === 'development') {
    const suffix = relative(canonicalRuntimePath(config.dataDir), canonicalRuntimePath(agentDir));
    if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
      throw new Error('开发 Pi 配置目录必须位于本实例数据目录内，不能链接到外部配置。');
    }
  }
  return { agentDir, authPath: join(agentDir, 'auth.json'), modelsStorePath: join(agentDir, 'models-store.json') };
}
