import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { GLOBAL_ASSISTANT_SESSION_ID, type WorkingDirectory } from '@multivac/contracts';
import { isPathWithin } from '../modules/sessions/working-directory.js';
import { projectFileScope } from './project-file-scope.js';

export interface BashDirectoryPlan {
  /** 本次启动使用的真实目录，也用于进程登记与命令指纹。 */
  directory: string;
  /** 异步准备后同步复核，不在复核与交给启动器之间让出执行权。 */
  revalidate: () => void;
}

/** bash 目录来源只有会话 cwd 和当前项目目录，不接收文件独立授权。 */
export function projectBashScope(dependencies: Parameters<typeof projectFileScope>[0]) {
  const projectDirectories = projectFileScope(dependencies);
  return (sessionId: string, runtimeDirectory: WorkingDirectory, requestedCwd?: string): BashDirectoryPlan => {
    if (requestedCwd !== undefined && (typeof requestedCwd !== 'string' || !requestedCwd.trim() || requestedCwd.includes('\0'))) {
      throw new Error('bash cwd 必须是有效的目录路径。');
    }
    const requested = resolve(runtimeDirectory.path, requestedCwd ?? '.');
    const check = () => {
      const session = dependencies.sessions.get(sessionId);
      if (session?.archivedAt) throw new Error('会话已归档，未启动命令。');
      if (sessionId !== GLOBAL_ASSISTANT_SESSION_ID && (!session?.workingDirectory ||
        session.workingDirectory.path !== runtimeDirectory.path || session.workingDirectory.kind !== runtimeDirectory.kind)) {
        throw new Error('会话执行目录已变化。');
      }
      if (session?.host) throw new Error('此宿主没有 bash 执行权限。');
      const ordinary = sessionId !== GLOBAL_ASSISTANT_SESSION_ID && session?.kind === 'work' &&
        !['task-isolated', 'worktree'].includes(runtimeDirectory.kind) && !dependencies.isTaskSession(sessionId);
      // 其他宿主只保留原 cwd，不因新增参数获得项目目录或子目录选择能力。
      if (!ordinary && requested !== resolve(runtimeDirectory.path)) throw new Error('此会话只能在原工作目录执行 bash。');
      const target = existingDirectory(requested);
      const roots = [runtimeDirectory.path, ...(ordinary ? projectDirectories(sessionId, runtimeDirectory) : [])];
      const allowed = roots.some(root => {
        try { return isPathWithin(existingDirectory(root), target); }
        catch { return false; } // 失效挂载不授予范围，其他有效来源仍可独立生效。
      });
      if (!allowed) throw new Error('bash cwd 不在会话工作目录或当前已确认的项目目录内。');
      return target;
    };
    const directory = check();
    return { directory, revalidate: () => {
      if (check() !== directory) throw new Error('bash cwd 的实际目标已发生变化，未启动命令。');
    } };
  };
}

function existingDirectory(path: string): string {
  try {
    const real = realpathSync.native(path);
    if (!statSync(real).isDirectory()) throw new Error('不是目录');
    return real;
  } catch {
    throw new Error(`bash 执行目录不存在、不是目录或无法确认真实路径：${path}`);
  }
}
