import { randomUUID } from 'node:crypto';
import {
  ConfirmHumanTaskSchema, type ConfirmHumanTask, CreateTaskSchema, UpdateTaskSchema, DeleteTaskSchema, CreateTaskGroupSchema, TaskQuerySchema, TaskSchema,
  UNKNOWN_CHANGE_ORIGIN, satisfiesTaskDependency,
  DEFAULT_TASK_BUDGET,
  type AssistantApiErrorCode, type CreateTask, type UpdateTask, type CreateTaskGroup,
  type TaskRelations, type DeleteTask, type Task, type TaskDetail, type TaskGroup, type TaskList, type TaskQuery, type TaskReceipt,
  type TaskBudget,
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
  describeProject?: (projectId: string) => { name: string; directories: { path: string }[]; defaultConstraints: string };
  events?: WorkbenchEventPublisher;
  now?: () => string;
  newId?: () => string;
  runs?: TaskRunRepository;
  requests?: HumanRequestRepository;
  artifacts?: ArtifactRepository;
  /** 新建任务时未指定预算采用的默认值（执行时长跟随偏好）；缺省用固定默认值。 */
  defaultBudget?: () => TaskBudget;
}

export class TaskService {
  private externalPending: (id: string) => boolean = () => false;
  setExternalPending(check: (id: string) => boolean) { this.externalPending = check; }
  private readonly now: () => string;
  private readonly newId: () => string;
  constructor(private readonly options: TaskServiceOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.newId = options.newId ?? randomUUID;
  }

  get(taskId: string): Task {
    const task = this.options.repository.get(taskId);
    if (!task || task.deletedAt) throw new TaskServiceError('NOT_FOUND', '任务不存在或已删除。');
    return task;
  }

  bySession(sessionId: string): Task {
    const run = this.options.runs?.bySession(sessionId);
    if (!run) throw new TaskServiceError('NOT_FOUND', '此会话没有关联任务。');
    return this.get(run.taskId);
  }

  list(query: TaskQuery = {}): TaskList {
    if (!Check(TaskQuerySchema, query)) invalid('任务查询条件无效。');
    if (query.parentCandidateFor && query.dependencyCandidateFor) invalid('只能查询一种关系候选。');
    if (query.topLevel && query.parentTaskId) invalid('根任务与直属子任务条件不能同时使用。');
    const candidate = query.parentCandidateFor ?? query.dependencyCandidateFor;
    if (candidate) {
      const scope = this.get(candidate).projectId ?? 'daily';
      if (query.projectId && query.projectId !== scope) invalid('关系候选必须属于同一个项目。');
      query = { ...query, projectId: scope };
    }
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
      requests: this.options.requests?.list(taskId).slice(0, 100) ?? [],
      artifacts: this.options.artifacts?.list(taskId) ?? [],
    };
  }

  relations(taskId: string, ancestorOffset = 0): TaskRelations {
    if (!Number.isSafeInteger(ancestorOffset) || ancestorOffset < 0 || ancestorOffset > 1000000) invalid('祖先分页参数无效。');
    const task = this.get(taskId);
    const context = this.options.repository.relationContext(taskId, ancestorOffset);
    const runs = this.options.runs?.tree(taskId) ?? [];
    const editReason = this.boundaryEditReason(task, runs);
    return { task, ...context, summary: this.options.repository.summaries([taskId])[taskId]!,
      missingDependencyIds: task.dependencyIds.filter((id) => !context.dependencies.some((item) => item.taskId === id)),
      editReason, parentChangeReason: editReason ?? (runs.length ? '已执行的任务树不能更换父任务以重置共享预算。' : null) };
  }

  /** 在父任务 transition 的事务内绑定子项，事务提交后再发布变更。 */
  bindExecutionChildren(run: import('@multivac/contracts').TaskRun): Task[] {
    const changed: Task[] = [];
    for (const snapshot of run.treeTasks ?? []) {
      const current = this.get(snapshot.taskId);
      if (current.humanOnly || satisfiesTaskDependency(current.status)) continue;
      const next: Task = { ...current, executionTaskId: run.taskId, currentRunId: run.runId, sessionId: run.sessionId, status: 'waiting', revision: current.revision + 1, updatedAt: this.now(), reason: '由父任务会话统一执行，尚未独立交付。', nextStep: '查看父任务执行进展。' };
      this.options.repository.save(next, current.revision);
      this.record(`tree-bind:${run.runId}:${current.taskId}`, run.runId, next, 'tree-execution', next.reason);
      changed.push(next);
    }
    return changed;
  }
  publishExecutionChildren(children: Task[], origin: WorkbenchChangeOrigin): void {
    for (const task of children) this.options.events?.publish({ type: 'task.changed', origin, task });
  }

  /** 由祖先运行持有的固定范围；暂停后仍归原会话，取消或交付后释放。 */
  executionOwner(taskId: string): Task | null {
    let current: Task | null = this.get(taskId);
    const seen = new Set<string>();
    while (current) {
      if (seen.has(current.taskId)) break;
      seen.add(current.taskId);
      const run = current.currentRunId ? this.options.runs?.get(current.currentRunId) : null;
      if (run?.taskId === current.taskId && run.treeTasks?.some(item => item.taskId === taskId) &&
          (!run.stopConfirmed || !['done', 'review', 'cancelled'].includes(current.status))) return current;
      current = current.parentTaskId ? this.get(current.parentTaskId) : null;
    }
    return null;
  }

  descendants(taskId: string): Task[] {
    const result: Task[] = [];
    const pending = [taskId];
    const seen = new Set(pending);
    for (let i = 0; i < pending.length; i++) {
      let offset = 0;
      do {
        const page = this.list({ parentTaskId: pending[i]!, offset, limit: 100 });
        for (const child of page.tasks) {
          if (seen.has(child.taskId)) invalid('任务树存在循环。');
          seen.add(child.taskId); pending.push(child.taskId); result.push(child);
        }
        if (page.nextOffset === null) break;
        offset = page.nextOffset;
      } while (true);
    }
    return result;
  }

  private boundaryEditReason(task: Task, runs = this.options.runs?.tree(task.taskId) ?? []): string | null {
    if (this.executionOwner(task.taskId)) return '由父任务会话统一执行，请先结束父任务执行再修改边界。';
    if (['done', 'cancelled'].includes(task.status)) return '完成或取消的任务保留为历史，不能修改。';
    if (!['idle', 'paused', 'failed'].includes(task.status)) return '任务已进入执行流程，请先安全停止，再修改关系。';
    if (runs.some((run) => run.taskId === task.taskId && (!run.stopConfirmed || run.pendingToolIds.length || run.nativePendingIds?.length))) return '执行停止或工具结束尚未确认，不能修改关系。';
    return null;
  }

  create(input: CreateTask, origin: WorkbenchChangeOrigin = UNKNOWN_CHANGE_ORIGIN): TaskReceipt {
    if (!Check(CreateTaskSchema, input)) invalid('任务创建参数无效。');
    const fields = {
      humanOnly: input.humanOnly ?? false, title: input.title.trim(), goal: input.goal.trim(), projectId: input.projectId ?? null,
      scope: input.scope?.trim() ?? '', priority: input.priority ?? 'medium', acceptance: input.acceptance ?? true,
      acceptanceCriteria: input.acceptanceCriteria?.trim() ?? '', groupId: input.groupId ?? null,
      parentTaskId: input.parentTaskId ?? null, dependencyIds: [...(input.dependencyIds ?? [])].sort(),
      budget: input.budget ?? this.options.defaultBudget?.() ?? DEFAULT_TASK_BUDGET,
    };
    // 未标记与旧版缺省语义一致，保持升级前创建命令的重放指纹。
    const { humanOnly, ...agentFields } = fields;
    const key = fingerprint({ kind: 'create', ...agentFields, ...(humanOnly ? { humanOnly: true } : {}) });
    let changed = false;
    const task = this.options.repository.transaction(() => {
      const replay = this.replay<Task>(input.commandId, key);
      if (replay) return replay;
      const at = this.now();
      const task: Task = {
        taskId: this.newId(), ...fields, status: 'idle', revision: 1,
        sessionId: null, currentRunId: null, reason: fields.humanOnly ? '由你处理，等待完成确认。' : '尚未启动执行。', nextStep: fields.humanOnly ? '处理后标记完成。' : '启动任务。',
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
  preview(input: Omit<CreateTask, 'commandId'>) {
    const at = this.now();
    const task: Task = { humanOnly: input.humanOnly ?? false, taskId: randomUUID(), title: input.title.trim(), goal: input.goal.trim(), scope: input.scope?.trim() ?? '', projectId: input.projectId ?? null, groupId: input.groupId ?? null, parentTaskId: input.parentTaskId ?? null, dependencyIds: input.dependencyIds ?? [], priority: input.priority ?? 'medium', acceptance: input.acceptance ?? true, acceptanceCriteria: input.acceptanceCriteria ?? '', status: 'idle', revision: 1, sessionId: null, currentRunId: null, reason: '', nextStep: '', createdAt: at, updatedAt: at, completedAt: null };
    this.validate(task);
    const project = task.projectId ? this.options.describeProject?.(task.projectId) : undefined;
    const parent = task.parentTaskId ? this.get(task.parentTaskId) : null;
    const dependencies = task.dependencyIds.length ? this.options.repository.list({ ids: task.dependencyIds, limit: 100 }).tasks : [];
    const byId = new Map(dependencies.map((item) => [item.taskId, item]));
    return {
      projectId: task.projectId, projectName: project?.name ?? (task.projectId ?? '日常'),
      sourceDirectory: project?.directories[0]?.path ?? null, constraints: project?.defaultConstraints ?? '',
      scope: task.scope, acceptance: task.acceptance, title: task.title, goal: task.goal,
      parentTaskId: task.parentTaskId, dependencyIds: task.dependencyIds, parentTitle: parent?.title ?? null,
      dependencyTitles: task.dependencyIds.map((id) => byId.get(id)!.title),
      relationRevisions: [...(parent ? [parent] : []), ...dependencies].map((item) => ({ taskId: item.taskId, revision: item.revision })),
    };
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
      if (patch.humanOnly !== undefined && !!current.humanOnly !== patch.humanOnly) {
        const reason = this.boundaryEditReason(current);
        if (reason) invalid(reason);
        if (current.currentRunId || this.options.runs?.list(taskId).length || this.options.requests?.list(taskId).some((item) => item.status === 'pending')) invalid('已有执行记录或待处理请求，不能切换“我来处理”标记。');
        next.reason = patch.humanOnly ? '由你处理，等待完成确认。' : '尚未启动执行。';
        next.nextStep = patch.humanOnly ? '处理后标记完成。' : '启动任务。';
      }
      if (patch.parentTaskId !== undefined && patch.parentTaskId !== current.parentTaskId && this.options.runs?.tree(taskId).length) invalid('已执行的任务树不能更换父任务以重置共享预算。');
      if (!['idle', 'paused', 'failed'].includes(current.status)) {
        const boundaries = ['projectId', 'goal', 'scope', 'acceptance', 'acceptanceCriteria', 'parentTaskId', 'dependencyIds', 'budget'] as const;
        if (boundaries.some((field) => fingerprint(next[field]) !== fingerprint(current[field]))) invalid('任务已进入执行流程，请先安全停止，再修改执行范围、关系或验收要求。');
      }
      const boundaryFields = ['projectId', 'goal', 'scope', 'acceptance', 'acceptanceCriteria', 'parentTaskId', 'dependencyIds', 'budget'] as const;
      if (boundaryFields.some((field) => fingerprint(next[field]) !== fingerprint(current[field]))) {
        const reason = this.boundaryEditReason(current);
        if (reason) invalid(reason);
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

  /** 用户完成现实中的事项；独立于 Agent 的成果提交与验收。 */
  confirmHumanCompletion(taskId: string, input: ConfirmHumanTask, origin: WorkbenchChangeOrigin = UNKNOWN_CHANGE_ORIGIN): TaskReceipt {
    if (!Check(ConfirmHumanTaskSchema, input)) invalid('完成确认参数无效。');
    return this.transition(taskId, { commandId: input.commandId, revision: input.revision,
      key: fingerprint({ kind: 'human-completion', taskId, ...input }), kind: 'human-completion', summary: '用户已确认完成“我来处理”的任务。',
    }, (task) => {
      if (!task.humanOnly || !['idle', 'paused', 'failed'].includes(task.status)) invalid('只能确认尚未完成的“我来处理”任务。');
      if (this.options.runs?.list(taskId).length) invalid('任务已有后台执行记录，不能用个人完成确认绕过执行核对。');
      if (this.externalPending(taskId) || this.options.requests?.list(taskId).some((item) => item.status === 'pending')) invalid('请先处理待处理请求。');
      if (task.dependencyIds.some((id) => !satisfiesTaskDependency(this.get(id).status))) invalid('前置任务尚未满足条件。');
      return { ...task, status: 'done', completedAt: this.now(), reason: '你已确认完成。', nextStep: '查看任务记录。' };
    }, origin);
  }

  /** 从待办移除已停止的任务，保留运行、会话、成果与命令历史的稳定引用。 */
  remove(taskId: string, input: DeleteTask, origin: WorkbenchChangeOrigin = UNKNOWN_CHANGE_ORIGIN): TaskReceipt {
    if (!Check(DeleteTaskSchema, input)) invalid('删除任务参数无效。');
    return this.transition(taskId, {
      commandId: input.commandId, revision: input.revision,
      key: fingerprint({ kind: 'delete', taskId, ...input }), kind: 'deleted',
      summary: '已从待办删除任务，会话与成果保留。',
    }, (task) => {
      if (this.executionOwner(taskId)) invalid('由父任务会话统一执行，不能删除。');
      if (!['idle', 'paused', 'failed', 'done', 'cancelled'].includes(task.status)) invalid('请先取消任务并等待执行停止，再删除。');
      const runs = this.options.runs?.list(taskId) ?? [];
      if (this.options.runs?.active().some((run) => run.taskId === taskId) || runs.some((run) => !run.stopConfirmed || run.pendingToolIds.length || run.nativePendingIds?.length)) {
        throw new TaskServiceError('TASK_CONFLICT', '执行停止尚未确认，请等待停止确认后再删除。');
      }
      if (this.externalPending(taskId) || this.options.requests?.list(taskId).some((request) => request.status === 'pending')) invalid('请先取消任务，使待处理请求失效后再删除。');
      if (this.options.repository.list({ parentTaskId: taskId, limit: 1 }).total || this.options.repository.list({ dependencyId: taskId, limit: 1 }).total) {
        invalid('此任务仍有子任务或被其他任务依赖，请先解除关联。');
      }
      return { ...task, deletedAt: this.now() };
    }, origin);
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
  checkCommand(commandId: string, key: string): void { this.replay(commandId, key); }
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
