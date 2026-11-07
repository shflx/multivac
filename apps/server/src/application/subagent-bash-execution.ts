import type { BashExecutionPort } from '../modules/processes/bash-execution.js';
import type { SubagentRepository } from '../modules/agents/subagent-run.js';
import type { CoordinatorToolGuard } from '../modules/sessions/coordinator-adapter.js';
import type { BashProcessService } from './bash-process-service.js';
import type { SubagentExecution } from './subagent-execution.js';
import type { projectBashScope } from './project-bash-scope.js';

/** 子级使用父级目录计划及同一个 bash 后端，进程记录保留子级身份和父任务 Run。 */
export function subagentBashExecution(options: {
  parent: BashExecutionPort; repository: SubagentRepository; guard: CoordinatorToolGuard;
  scope: ReturnType<typeof projectBashScope>; execution: () => SubagentExecution;
  bash: Pick<BashProcessService, 'execute'>;
}): BashExecutionPort {
  return { execute: async (id, directory, call, input, signal, onData, isolated) => {
    const record = options.repository.bySession(id);
    if (!record) return options.parent.execute(id, directory, call, input, signal, onData, isolated);
    if (record.run.mode !== 'execute' || directory !== record.workingDirectory.path || isolated) throw new Error('子智能体执行方式或目录不一致。');
    const release = options.guard.acquire(id, 'bash');
    try {
      const execution = options.execution();
      const check = () => { execution.lease(id, 'check', call, 0); };
      check();
      const plan = options.scope(record.run.parentSessionId, record.workingDirectory, input.cwd);
      return await options.bash.execute({ sessionId: id, executionId: `subagent-send:${record.run.id}`, directory: plan.directory,
        ...(record.run.taskId ? { taskId: record.run.taskId, runId: record.run.taskRunId! } : {}) }, call,
      { ...input, requiredWhileRunning: true }, signal, onData, undefined, () => { check(); plan.revalidate(); }, {
        check, start: (marker, bytes) => ({ maxBytes: execution.lease(id, 'starting', marker, bytes), maxMillis: Math.max(1, execution.remainingMillis(id)) }),
        progress: (marker, bytes) => execution.lease(id, 'progress', marker, bytes), settle: marker => { execution.lease(id, 'settled', marker, 0); },
      });
    } finally { release(); }
  } };
}
