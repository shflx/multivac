import type { WorkingDirectory } from '@multivac/contracts';
import type { BashExecutionPort } from '../runtime/executors/managed-bash-tool.js';
import type { TaskRunRepository } from '../modules/tasks/task.js';
import type { BashProcessService } from './bash-process-service.js';
import { projectBashScope } from './project-bash-scope.js';

/** 将可信会话/轮次与动态目录计划绑定，前后台共用同一启动准入。 */
export function sessionBashExecution(dependencies: Parameters<typeof projectBashScope>[0] & {
  currentExecution: (sessionId: string) => string | null | undefined;
  currentDirectory: (sessionId: string) => WorkingDirectory;
  runs: Pick<TaskRunRepository, 'bySession'>;
  bash: Pick<BashProcessService, 'execute'>;
}): BashExecutionPort {
  const scope = projectBashScope(dependencies);
  return { execute: (sessionId, runtimePath, toolCallId, input, signal, onData, isolated) => {
    const executionId = dependencies.currentExecution(sessionId);
    if (!executionId) throw new Error('当前没有可登记的会话执行。');
    const runtimeDirectory = dependencies.currentDirectory(sessionId);
    if (runtimeDirectory.path !== runtimePath) throw new Error('会话执行目录已变化。');
    const run = dependencies.runs.bySession(sessionId);
    const validateExecution = () => {
      if (dependencies.currentExecution(sessionId) !== executionId) throw new Error('会话执行轮次已变化。');
      const current = dependencies.currentDirectory(sessionId);
      if (current.path !== runtimeDirectory.path || current.kind !== runtimeDirectory.kind) throw new Error('会话执行目录已变化。');
      const currentRun = dependencies.runs.bySession(sessionId);
      if (currentRun?.runId !== run?.runId || (currentRun && (!isolated || currentRun.stopIntent || currentRun.stopConfirmed))) {
        throw new Error('任务执行边界已失效。');
      }
    };
    validateExecution();
    const plan = scope(sessionId, runtimeDirectory, input.cwd);
    return dependencies.bash.execute({ sessionId, executionId, directory: plan.directory,
      ...(run ? { taskId: run.taskId, runId: run.runId } : {}) }, toolCallId, input, signal, onData, isolated, () => {
      validateExecution();
      plan.revalidate();
    });
  } };
}
