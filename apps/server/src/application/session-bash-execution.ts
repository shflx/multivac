import type { TaskRun, WorkingDirectory } from '@multivac/contracts';
import type { BashExecutionPort } from '../modules/processes/bash-execution.js';
import type { TaskRunRepository } from '../modules/tasks/task.js';
import type { BashProcessService, BashRunControl } from './bash-process-service.js';
import { projectBashScope } from './project-bash-scope.js';

/** 将可信会话/轮次与动态目录计划绑定，前后台共用同一启动准入。 */
export function sessionBashExecution(dependencies: Parameters<typeof projectBashScope>[0] & {
  currentExecution: (sessionId: string) => string | null | undefined;
  currentDirectory: (sessionId: string) => WorkingDirectory;
  runs: Pick<TaskRunRepository, 'bySession'>;
  bash: Pick<BashProcessService, 'execute'>;
  taskControl?: (run: TaskRun, toolCallId: string) => BashRunControl;
}): BashExecutionPort {
  const scope = projectBashScope({ ...dependencies, taskExecutionMode: id => {
    const run = dependencies.runs.bySession(id);
    return run ? run.executionMode ?? 'native-isolated' : null;
  } });
  return { execute: (sessionId, runtimePath, toolCallId, input, signal, onData, isolated) => {
    const executionId = dependencies.currentExecution(sessionId);
    if (!executionId) throw new Error('当前没有可登记的会话执行。');
    if (dependencies.sessions.get(sessionId)?.archivedAt) throw new Error('会话已归档，未启动命令。');
    const runtimeDirectory = dependencies.currentDirectory(sessionId);
    if (runtimeDirectory.path !== runtimePath) throw new Error('会话执行目录已变化。');
    const run = dependencies.runs.bySession(sessionId);
    const validateExecution = () => {
      if (dependencies.currentExecution(sessionId) !== executionId) throw new Error('会话执行轮次已变化。');
      if (dependencies.sessions.get(sessionId)?.archivedAt) throw new Error('会话已归档，未启动命令。');
      const current = dependencies.currentDirectory(sessionId);
      if (current.path !== runtimeDirectory.path || current.kind !== runtimeDirectory.kind) throw new Error('会话执行目录已变化。');
      const currentRun = dependencies.runs.bySession(sessionId);
      if (currentRun?.runId !== run?.runId || (currentRun && (currentRun.stopIntent || currentRun.stopConfirmed ||
        (currentRun.executionMode === 'workspace' ? !!isolated || executionId !== currentRun.commandId : !isolated)))) {
        throw new Error('任务执行边界已失效。');
      }
    };
    validateExecution();
    const control = run?.executionMode === 'workspace' ? dependencies.taskControl?.(run, toolCallId) : undefined;
    if (run?.executionMode === 'workspace' && !control) throw new Error('任务执行租约尚未接入。');
    const plan = scope(sessionId, runtimeDirectory, input.cwd);
    return dependencies.bash.execute({ sessionId, executionId, directory: plan.directory,
      ...(run ? { taskId: run.taskId, runId: run.runId } : {}) }, toolCallId, input, signal, onData, isolated, () => {
      validateExecution();
      plan.revalidate();
      control?.check();
    }, control);
  } };
}
