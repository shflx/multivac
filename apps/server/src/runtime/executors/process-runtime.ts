import { spawn } from 'node:child_process';
import type { TerminalProcessFactory } from '../../modules/terminals/terminal-process.js';
import { TerminalProcess } from './terminal-process.js';
import type { CodexThreads } from '../../modules/terminals/codex-threads.js';
import { CodexAppServer } from './codex-app-server.js';
import type { ProcessSupervisors, TaskIsolation } from '../../modules/processes/process-runtime.js';
import { BASH_PROCESS_SUPERVISOR } from './bash-process-supervisor.js';
import { MANAGED_SUPERVISOR } from './managed-process-supervisor.js';
import { NativeTaskTools } from './native-task-tools.js';

/** 基于原生任务工具的隔离核对：创建隔离环境成功即视为可用，核对后立即释放。 */
export const nativeTaskIsolation: TaskIsolation = {
  async verify(directory, protectedPaths = []) {
    (await NativeTaskTools.create(directory, protectedPaths)).dispose();
  },
  async managedProfile(directory, protectedPaths, port) {
    const tools = await NativeTaskTools.create(directory, protectedPaths);
    try { return tools.managedProfile(port); }
    finally { tools.dispose(); }
  },
};

/** 以当前 node 运行监护脚本；只给最小 PATH，不继承服务环境与密钥。 */
export const nodeProcessSupervisors: ProcessSupervisors = {
  managed: () => spawn(process.execPath, ['-e', MANAGED_SUPERVISOR], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', OPENSSL_CONF: '/dev/null' } }),
  bash: () => spawn(process.execPath, ['-e', BASH_PROCESS_SUPERVISOR], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin' } }),
};

/** 项目终端与任务监护共用装配入口，运行语义仍由各自实现负责。 */
export const nativeTerminalProcess: TerminalProcessFactory = (directory, preset, size) => new TerminalProcess(directory, preset, size);

/** Codex 会话控制与终端进程经同一运行时入口装配。 */
export const nativeCodexThreads = (): CodexThreads => new CodexAppServer();
