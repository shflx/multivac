import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentService } from '../application/agent-service.js';
import type { ManagedProcessService } from '../application/managed-process-service.js';
import type { ModelAccessService } from '../application/model-access-service.js';
import type { ModelSettingsService } from '../application/model-settings-service.js';
import type { PreferencesService } from '../application/preferences-service.js';
import type { ProjectService } from '../application/project-service.js';
import type { ProposalService } from '../application/proposals/proposal-service.js';
import type { SessionWorkingDirectories } from '../application/session-working-directories.js';
import type { TaskExecutionService } from '../application/task-execution-service.js';
import type { TaskService } from '../application/task-service.js';
import type { TempDirectoryCleaner } from '../application/temp-directory-cleaner.js';
import type { ToolAuthorizationService } from '../application/tool-authorization-service.js';
import type { WorkspaceSessionService } from '../application/workspace-session-service.js';
import type { StoredModelSettingsState } from '../modules/model-settings/model-settings.js';
import type { FakeModelAccessBackend } from '../runtime/executors/fake-model-access-backend.js';
import type { SqliteAssistantStore } from '../storage/sqlite-assistant-store.js';

/** Fake E2E 控制需要的已装配对象；只在显式开启 E2E 控制时使用。 */
export interface E2eControlParts {
  store: SqliteAssistantStore;
  tasks: TaskService;
  taskExecution: TaskExecutionService;
  managedProcesses: ManagedProcessService;
  agents: AgentService;
  toolAuthorization: ToolAuthorizationService;
  proposals: ProposalService;
  workspaceSessions: WorkspaceSessionService;
  projects: ProjectService;
  workingDirectories: SessionWorkingDirectories;
  tempDirectoryCleaner: TempDirectoryCleaner;
  preferences: PreferencesService;
  modelAccess: ModelAccessService;
  modelSettings: ModelSettingsService;
  fakeAccessBackend: FakeModelAccessBackend;
  /** Fake 执行器已经失败过的提示文本，重置时清空。 */
  failedFakePrompts: Set<string>;
  fakeModelSettingsState: () => StoredModelSettingsState;
}

/** Fake E2E 的夹具与重置操作：启动可观察的托管进程、切换选模配置、把业务事实恢复到初始状态。 */
export function createE2eControls(parts: E2eControlParts) {
  return {
    startTestProcess: async (taskId: string, required: boolean) => {
      const task = parts.tasks.get(taskId);
      const run = task.currentRunId ? parts.store.taskRuns.get(task.currentRunId) : null;
      if (!run?.directory || task.status !== 'running') throw new Error('测试任务尚未执行。');
      await writeFile(join(run.directory.path, '__managed-fixture.cjs'), 'console.log("<script>not-executed</script>");console.log("api_key=must-hide");setInterval(()=>console.log("真实日志追加"),500);');
      return parts.managedProcesses.start({ commandId: `fixture:${run.runId}`, name: '真实测试后台进程', script: '__managed-fixture.cjs', port: null, requiredWhileRunning: required },
        { taskId, runId: run.runId, sessionId: run.sessionId, directory: run.directory.path, maxMillis: 20000, maxBytes: 100000 });
    },
    configureModelSelectionForTest: async (empty: boolean) => {
      const next = parts.fakeModelSettingsState();
      if (empty) { next.profiles = []; next.defaultProfileId = null; }
      await parts.modelSettings.replaceStateForTest(next);
    },
    /** 先取消未结束的任务并停止托管进程，再清理业务事实；调用方须确认没有其他测试在运行。 */
    reset: async () => {
      let offset: number | null = 0;
      while (offset !== null) {
        const page = parts.tasks.list({ offset, limit: 100 });
        for (const task of page.tasks) if (!['done', 'cancelled'].includes(task.status)) await parts.taskExecution.control(task.taskId, { commandId: `test-reset:${task.taskId}:${task.revision}`, revision: task.revision, action: 'cancel' });
        offset = page.nextOffset;
      }
      await parts.taskExecution.idle();
      await Promise.all(parts.managedProcesses.list().map((item) => parts.managedProcesses.stop(item.processId)));
      parts.store.resetTasksForTest();
      parts.agents.resetForTest();
      parts.failedFakePrompts.clear();
      parts.toolAuthorization.setTimeoutForTest(null);
      parts.toolAuthorization.resetGrantsForTest();
      parts.proposals.resetForTest();
      parts.workspaceSessions.resetForTest();
      parts.projects.resetForTest();
      parts.workingDirectories.clearSessionsForTest();
      parts.tempDirectoryCleaner.resetForTest();
      parts.preferences.resetForTest();
      await parts.modelAccess.resetForTest();
      parts.fakeAccessBackend.reset();
      await parts.modelSettings.replaceStateForTest(parts.fakeModelSettingsState());
    },
  };
}
