import { childEnvironment } from '../runtime/program-launch.js';

export function gitNullDevice(platform: NodeJS.Platform = process.platform): string { return platform === 'win32' ? 'NUL' : '/dev/null'; }
/** 工作目录准备不读取用户全局配置；发布保留本机 HTTPS 凭据配置，但不传服务端秘密。 */
export function gitEnvironment(platform: NodeJS.Platform, source: NodeJS.ProcessEnv, mode: 'worktree' | 'publish', home?: string): NodeJS.ProcessEnv {
  if (platform !== 'win32') return mode === 'worktree'
    ? { PATH: source.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
    : { PATH: source.PATH, HOME: source.HOME, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' };
  const environment = { ...childEnvironment(source, platform), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' };
  if (mode === 'worktree') return { ...environment, HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: 'NUL' };
  return environment;
}
