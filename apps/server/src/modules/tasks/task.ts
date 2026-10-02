import type { Task, TaskEvent, TaskGroup, TaskList, TaskQuery } from '@multivac/contracts';
import type { TaskRun } from '@multivac/contracts';

export interface TaskRunRepository {
  get(runId: string): TaskRun | null;
  list(taskId: string): TaskRun[];
  active(): TaskRun[];
  bySession(sessionId: string): TaskRun | null;
  tree(taskId: string): TaskRun[];
  save(run: TaskRun): void;
}
export interface TaskRuntimeRepository {
  owner(): { ownerId: string; pid: number } | null;
  claim(ownerId: string, pid: number): void;
  release(ownerId: string): void;
}

export interface TaskCommandRecord {
  commandId: string;
  fingerprint: string;
  result: Task | TaskGroup;
}

/** 命令回执、业务事实与事件必须在同一个短事务中提交。 */
export interface TaskRepository {
  transaction<T>(operation: () => T): T;
  get(taskId: string): Task | null;
  list(query: TaskQuery): TaskList;
  save(task: Task, previousRevision: number | null): void;
  events(taskId: string, before?: number): TaskEvent[];
  appendEvent(event: Omit<TaskEvent, 'eventId' | 'task'>): void;
  command(commandId: string): TaskCommandRecord | null;
  saveCommand(command: TaskCommandRecord): void;
  group(groupId: string): TaskGroup | null;
  groups(projectId?: string | null): TaskGroup[];
  saveGroup(group: TaskGroup): void;
}
