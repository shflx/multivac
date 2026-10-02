import { randomUUID } from 'node:crypto';
import {
  CreateTaskSchema, UpdateTaskSchema, CreateTaskGroupSchema, TaskQuerySchema, TaskSchema,
  UNKNOWN_CHANGE_ORIGIN,
  DEFAULT_TASK_BUDGET,
  type AssistantApiErrorCode, type CreateTask, type UpdateTask, type CreateTaskGroup,
  type Task, type TaskDetail, type TaskGroup, type TaskList, type TaskQuery, type TaskReceipt,
  type WorkbenchChangeOrigin,
} from '@multivac/contracts';
import { Check } from 'typebox/value';
import type { TaskRepository, TaskRunRepository } from '../modules/tasks/task.js';
import type { WorkbenchEventPublisher } from './workbench-events.js';
import type { HumanRequestRepository } from '../modules/tasks/human-request.js';
import type { ArtifactRepository } from '../modules/tasks/artifact.js';

export class TaskServiceError extends Error {
  constructor(readonly code: AssistantApiErrorCode, message: string) { super(message); }
}
function invalid(message: string): never { throw new TaskServiceError('INVALID_REQUEST', message); }

/** 排序键固定，字段顺序不同的网络重试仍是同一个命令。 */
export function fingerprint(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(fingerprint).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${fingerprint(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export interface TaskServiceOptions {
  repository: TaskRepository;
  requireProject: (projectId: string) => unknown;
  events?: WorkbenchEventPublisher;
  now?: () => string;
  newId?: () => string;
  runs?: TaskRunRepository;
  requests?: HumanRequestRepository;
  artifacts?: ArtifactRepository;
}

export class TaskService {
  private readonly now: () => string;
  private readonly newId: () => string;
  constructor(private readonly options: TaskServiceOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.newId = options.newId ?? randomUUID;
  }

  get(taskId: string): Task {
    const task = this.options.repository.get(taskId);
    if (!task) throw new TaskServiceError('NOT_FOUND', '任务不存在。');
    return task;
  }

  list(query: TaskQuery = {}): TaskList {
    if (!Check(TaskQuerySchema, query)) invalid('任务查询条件无效。');
    if (query.projectId && query.projectId !== 'daily') this.options.requireProject(query.projectId);
    if (query.parentTaskId) this.get(query.parentTaskId);
    if (query.dependencyId) this.get(query.dependencyId);
    if (query.groupId) this.requireGroup(query.groupId);
    return this.options.repository.list(query);
  }

  detail(taskId: string, before?: number): TaskDetail {
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) invalid('进展游标无效。');
    const task = this.get(taskId);
    const events = this.options.repository.events(taskId, before);
    const children = this.list({ parentTaskId: taskId, limit: 100 });
    return {
      task, events: events.slice(0, 100), children: children.tasks.map((child) => child.taskId),
      totalChildren: children.total,
      nextEventBefore: events.length > 100 ? events[99]!.eventId : null,
      runs: this.options.runs?.list(taskId) ?? [],
      requests: this.options.requests?.list(taskId) ?? [],
      artifacts: this.options.artifacts?.list(taskId) ?? [],
    };
  }

  create(input: CreateTask, origin: WorkbenchChangeOrigin = UNKNOWN_CHANGE_ORIGIN): TaskReceipt {
    if (!Check(CreateTaskSchema, input)) invalid('任务创建参数无效。');
    const fields = {
      title: input.title.trim(), goal: input.goal.trim(), projectId: input.projectId ?? null,
      scope: input.scope?.trim() ?? '', priority: input.priority ?? 'medium', acceptance: input.acceptance ?? true,
      acceptanceCriteria: input.acceptanceCriteria?.trim() ?? '', groupId: input.groupId ?? null,
      parentTaskId: input.parentTaskId ?? null, dependencyIds: [...(input.dependencyIds ?? [])].sort(),
      budget: input.budget ?? DEFAULT_TASK_BUDGET,
    };
    const key = fingerprint({ kind: 'create', ...fields });
    let changed = false;
    const task = this.options.repository.transaction(() => {
      const replay = this.replay<Task>(input.commandId, key);
      if (replay) return replay;
      const at = this.now();
      const task: Task = {
        taskId: this.newId(), ...fields, status: 'idle', revision: 1,
        sessionId: null, currentRunId: null, reason: '尚未启动执行。', nextStep: '启动任务。',
        createdAt: at, updatedAt: at, completedAt: null,
      };
      this.validate(task);
      this.options.repository.save(task, null);
      this.record(input.commandId, key, task, 'created', '任务已创建，尚未执行。');
      changed = true;
      return task;
    });
    if (changed) this.options.events?.publish({ type: 'task.changed', origin, task });
    return { commandId: input.commandId, task };
  }

  update(taskId: string, input: UpdateTask, origin: WorkbenchChangeOrigin = UNKNOWN_CHANGE_ORIGIN): TaskReceipt {
    if (!Check(UpdateTaskSchema, input) || Object.keys(input.patch).length === 0) invalid('任务修改参数无效。');
    const patch = { ...input.patch };
    for (const key of ['title', 'goal', 'scope', 'acceptanceCriteria'] as const) {
      if (patch[key] !== undefined) patch[key] = patch[key].trim();
    }
    if (patch.dependencyIds) patch.dependencyIds = [...patch.dependencyIds].sort();
    const key = fingerprint({ kind: 'update', taskId, revision: input.revision, patch });
    let changed = false;
    const task = this.options.repository.transaction(() => {
      const replay = this.replay<Task>(input.commandId, key);
      if (replay) return replay;
      const current = this.get(taskId);
      if (current.revision !== input.revision) throw new TaskServiceError('TASK_CONFLICT', '任务已变化，请读取最新版本后重试。');
      if (['done', 'cancelled'].includes(current.status)) invalid('完成或取消的任务保留为历史，不能修改。');
      const next = { ...current, ...patch };
      if (patch.parentTaskId !== undefined && patch.parentTaskId !== current.parentTaskId && this.options.runs?.tree(taskId).length) invalid('已执行的任务树不能更换父任务以重置共享预算。');
      if (!['idle', 'paused', 'failed'].includes(current.status)) {
        const boundaries = ['projectId', 'goal', 'scope', 'acceptance', 'acceptanceCriteria', 'parentTaskId', 'dependencyIds', 'budget'] as const;
        if (boundaries.some((field) => fingerprint(next[field]) !== fingerprint(current[field]))) invalid('任务已进入执行流程，请先安全停止，再修改执行范围、关系或验收要求。');
      }
      this.validate(next);
      if (fingerprint(next) === fingerprint(current)) {
        this.options.repository.saveCommand({ commandId: input.commandId, fingerprint: key, result: current });
        return current;
      }
      next.revision += 1;
      next.updatedAt = this.now();
      this.options.repository.save(next, current.revision);
      this.record(input.commandId, key, next, 'updated', `任务属性已更新：${Object.keys(patch).join('、')}。`);
      changed = true;
      return next;
    });
    if (changed) this.options.events?.publish({ type: 'task.changed', origin, task });
    return { commandId: input.commandId, task };
  }

  groups(projectId?: string | null): TaskGroup[] {
    if (projectId) this.options.requireProject(projectId);
    return this.options.repository.groups(projectId);
  }

  createGroup(input: CreateTaskGroup, origin: WorkbenchChangeOrigin = UNKNOWN_CHANGE_ORIGIN): TaskGroup {
    if (!Check(CreateTaskGroupSchema, input) || !input.title.trim()) invalid('分组参数无效。');
    const fields = { title: input.title.trim(), projectId: input.projectId ?? null };
    const key = fingerprint({ kind: 'create-group', ...fields });
    let changed = false;
    const group = this.options.repository.transaction(() => {
      const replay = this.replay<TaskGroup>(input.commandId, key);
      if (replay) return replay;
      if (fields.projectId) this.options.requireProject(fields.projectId);
      const group = { groupId: this.newId(), ...fields, createdAt: this.now() };
      this.options.repository.saveGroup(group);
      this.options.repository.saveCommand({ commandId: input.commandId, fingerprint: key, result: group });
      changed = true;
      return group;
    });
    if (changed) this.options.events?.publish({ type: 'task-group.changed', origin, group });
    return group;
  }

  private replay<T extends Task | TaskGroup>(commandId: string, key: string): T | null {
    const record = this.options.repository.command(commandId);
    if (!record) return null;
    if (record.fingerprint !== key) throw new TaskServiceError('COMMAND_ID_CONFLICT', '同一个命令 ID 不能用于不同操作。');
    return record.result as T;
  }
  facts<T>(operation: () => T): T { return this.options.repository.transaction(operation); }

  /** 仅供服务端用例提交状态事实；HTTP 和模型均不能自行传入状态补丁。 */
  transition(taskId: string, command: { commandId: string; revision?: number; key: string; kind: string; summary: string }, change: (task: Task) => Task, origin: WorkbenchChangeOrigin = UNKNOWN_CHANGE_ORIGIN): TaskReceipt {
    let changed = false;
    const task = this.options.repository.transaction(() => {
      const replay = this.replay<Task>(command.commandId, command.key);
      if (replay) return replay;
      const current = this.get(taskId);
      if (command.revision !== undefined && current.revision !== command.revision) throw new TaskServiceError('TASK_CONFLICT', '任务已变化，请读取最新版本后重试。');
      const next = change({ ...current });
      if (!Check(TaskSchema, next)) invalid('任务状态事实不符合契约。');
      changed = fingerprint(next) !== fingerprint(current);
      if (changed) {
        next.revision = current.revision + 1;
        next.updatedAt = this.now();
        this.options.repository.save(next, current.revision);
        this.record(command.commandId, command.key, next, command.kind, command.summary);
      } else this.options.repository.saveCommand({ commandId: command.commandId, fingerprint: command.key, result: current });
      return changed ? next : current;
    });
    if (changed) this.options.events?.publish({ type: 'task.changed', origin, task });
    return { commandId: command.commandId, task };
  }

  private record(commandId: string, key: string, task: Task, kind: string, summary: string): void {
    this.options.repository.appendEvent({ taskId: task.taskId, commandId, revision: task.revision, kind, summary, occurredAt: task.updatedAt });
    this.options.repository.saveCommand({ commandId, fingerprint: key, result: task });
  }

  private requireGroup(groupId: string): TaskGroup {
    const group = this.options.repository.group(groupId);
    if (!group) throw new TaskServiceError('NOT_FOUND', '任务分组不存在。');
    return group;
  }

  private validate(task: Task): void {
    if (!task.title || !task.goal) invalid('任务标题和目标不能为空。');
    if (task.projectId) this.options.requireProject(task.projectId);
    if (task.groupId && this.requireGroup(task.groupId).projectId !== task.projectId) invalid('分组和任务必须属于同一个项目范围。');
    const sameScope = (id: string) => {
      const related = this.get(id);
      if (related.projectId !== task.projectId) invalid('父子和依赖关系不能跨项目范围。');
      return related;
    };
    const ancestors = new Set([task.taskId]);
    let parent = task.parentTaskId;
    while (parent) {
      if (ancestors.has(parent)) invalid('父子关系不能形成循环。');
      ancestors.add(parent);
      parent = sameScope(parent).parentTaskId;
    }
    const visited = new Set<string>();
    const stack = [...task.dependencyIds];
    while (stack.length) {
      const id = stack.pop()!;
      if (id === task.taskId) invalid('任务不能依赖自身或形成循环依赖。');
      if (visited.has(id)) continue;
      visited.add(id);
      stack.push(...sameScope(id).dependencyIds);
    }
    // 换项目时也核对指向本任务的关系，避免留下跨范围的反向引用。
    for (const query of [{ parentTaskId: task.taskId }, { dependencyId: task.taskId }]) {
      let offset = 0;
      do {
        const page = this.options.repository.list({ ...query, offset, limit: 100 });
        if (page.tasks.some((related) => related.projectId !== task.projectId)) invalid('仍有关联任务处于原范围，不能单独更换项目。');
        if (page.nextOffset === null) break;
        offset = page.nextOffset;
      } while (true);
    }
  }
}
