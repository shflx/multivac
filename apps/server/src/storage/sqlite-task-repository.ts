import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { TaskSchema, type Task, type TaskEvent, type TaskGroup, type TaskList, type TaskQuery, type TaskRelationSummary } from '@multivac/contracts';
import { Check } from 'typebox/value';
import type { TaskCommandRecord, TaskRepository } from '../modules/tasks/task.js';

export const TASK_MIGRATION = `
  CREATE TABLE IF NOT EXISTS task_group (
    group_id TEXT PRIMARY KEY, project_id TEXT REFERENCES project(project_id),
    record_json TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS task (
    task_id TEXT PRIMARY KEY, project_id TEXT REFERENCES project(project_id),
    group_id TEXT REFERENCES task_group(group_id), parent_id TEXT REFERENCES task(task_id),
    status TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0),
    created_at TEXT NOT NULL, record_json TEXT NOT NULL,
    CHECK(parent_id IS NULL OR parent_id != task_id)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS task_dependency (
    task_id TEXT NOT NULL REFERENCES task(task_id),
    dependency_id TEXT NOT NULL REFERENCES task(task_id),
    PRIMARY KEY(task_id, dependency_id), CHECK(task_id != dependency_id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS task_project_status ON task(project_id, status, created_at);
  CREATE INDEX IF NOT EXISTS task_parent ON task(parent_id);
  CREATE INDEX IF NOT EXISTS task_dependency_target ON task_dependency(dependency_id);
  CREATE TABLE IF NOT EXISTS task_command (
    command_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result_json TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS task_event (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES task(task_id), command_id TEXT NOT NULL,
    revision INTEGER NOT NULL, kind TEXT NOT NULL, summary TEXT NOT NULL, occurred_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS task_event_task ON task_event(task_id, event_id);
`;

function taskFromRow(row: unknown): Task {
  const task: unknown = JSON.parse((row as { record_json: string }).record_json);
  if (!Check(TaskSchema, task)) throw new Error('任务存储记录不符合契约，需要核对迁移或数据。');
  return task;
}

export class SqliteTaskRepository implements TaskRepository {
  constructor(private readonly database: DatabaseSync) {}

  transaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  get(taskId: string): Task | null {
    const row = this.database.prepare('SELECT record_json FROM task WHERE task_id = ?').get(taskId);
    return row ? taskFromRow(row) : null;
  }

  list(query: TaskQuery): TaskList {
    const clauses: string[] = ["json_extract(record_json, '$.deletedAt') IS NULL"];
    const args: SQLInputValue[] = [];
    const equal = (column: string, value: string | undefined) => {
      if (value !== undefined) { clauses.push(`${column} = ?`); args.push(value); }
    };
    if (query.projectId === 'daily') clauses.push('project_id IS NULL');
    else equal('project_id', query.projectId);
    if (query.ids?.length) { clauses.push(`task_id IN (${query.ids.map(() => '?').join(',')})`); args.push(...query.ids); }
    equal('status', query.status);
    if (query.viewStatus) {
      const viewStatus = `CASE
        WHEN status IN ('done','cancelled') THEN status
        WHEN EXISTS(SELECT 1 FROM task_human_request r WHERE r.task_id=task.task_id AND r.status='pending' AND json_extract(r.record_json,'$.kind')='review') THEN 'review'
        WHEN EXISTS(SELECT 1 FROM task_human_request r WHERE r.task_id=task.task_id AND r.status='pending') OR status IN ('failed','recovery') THEN 'waiting'
        WHEN status='queued' THEN 'idle'
        ELSE status END`;
      clauses.push(query.viewStatus === 'unfinished' ? `${viewStatus} NOT IN ('done','cancelled')` : `${viewStatus} = ?`);
      if (query.viewStatus !== 'unfinished') args.push(query.viewStatus);
    }
    if (query.statuses?.length) { clauses.push(`status IN (${query.statuses.map(() => '?').join(',')})`); args.push(...query.statuses); }
    equal('parent_id', query.parentTaskId);
    if (query.topLevel) clauses.push('parent_id IS NULL');
    if (query.excludeIds?.length) { clauses.push(`task_id NOT IN (${query.excludeIds.map(() => '?').join(',')})`); args.push(...query.excludeIds); }
    // 候选过滤使用完整关系集合，分页前排除自身与会形成循环的对象。
    const candidate = query.parentCandidateFor ?? query.dependencyCandidateFor;
    if (candidate) {
      const edges = query.parentCandidateFor
        ? 'SELECT t.task_id FROM task t JOIN excluded e ON t.parent_id=e.id'
        : 'SELECT d.task_id FROM task_dependency d JOIN excluded e ON d.dependency_id=e.id';
      clauses.push(`task_id NOT IN (WITH RECURSIVE excluded(id) AS (VALUES(?) UNION ${edges}) SELECT id FROM excluded)`);
      args.push(candidate);
    }
    equal('group_id', query.groupId);
    if (query.dependencyId !== undefined) {
      clauses.push('task_id IN (SELECT task_id FROM task_dependency WHERE dependency_id = ?)');
      args.push(query.dependencyId);
    }
    if (query.query?.trim()) {
      clauses.push("instr(lower(json_extract(record_json, '$.title') || char(10) || json_extract(record_json, '$.goal') || char(10) || json_extract(record_json, '$.scope') || char(10) || json_extract(record_json, '$.reason') || char(10) || json_extract(record_json, '$.nextStep')), lower(?)) > 0");
      args.push(query.query.trim());
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const total = (this.database.prepare(`SELECT count(*) AS count FROM task ${where}`).get(...args) as { count: number }).count;
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 50;
    const order = query.sort === 'recent' ? "json_extract(record_json, '$.updatedAt') DESC, task_id" : 'created_at, task_id';
    const tasks = this.database.prepare(`SELECT record_json FROM task ${where} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...args, limit, offset).map(taskFromRow);
    return { tasks, total, nextOffset: offset + tasks.length < total ? offset + tasks.length : null,
      ...(query.includeRelations ? { relations: this.summaries(tasks.map((task) => task.taskId)) } : {}) };
  }

  /** 同一页一次聚合直属子任务与前置条件，不逐卡读取详情。 */
  summaries(taskIds: string[]): Record<string, TaskRelationSummary> {
    if (!taskIds.length) return {};
    const rows = this.database.prepare(`SELECT t.task_id,
      (SELECT record_json FROM task p WHERE p.task_id=t.parent_id AND json_extract(p.record_json,'$.deletedAt') IS NULL) parent_json,
      (SELECT count(*) FROM task c WHERE c.parent_id=t.task_id AND json_extract(c.record_json,'$.deletedAt') IS NULL) child_total,
      (SELECT count(*) FROM task c WHERE c.parent_id=t.task_id AND c.status='done' AND json_extract(c.record_json,'$.deletedAt') IS NULL) child_done,
      (SELECT count(*) FROM task c WHERE c.parent_id=t.task_id AND c.status='cancelled' AND json_extract(c.record_json,'$.deletedAt') IS NULL) child_cancelled,
      (SELECT count(*) FROM task_dependency d WHERE d.task_id=t.task_id) dependency_total,
      (SELECT count(*) FROM task_dependency d JOIN task p ON p.task_id=d.dependency_id WHERE d.task_id=t.task_id AND p.status='done' AND json_extract(p.record_json,'$.deletedAt') IS NULL) dependency_done,
      (SELECT p.record_json FROM task_dependency d JOIN task p ON p.task_id=d.dependency_id WHERE d.task_id=t.task_id AND p.status!='done' AND json_extract(p.record_json,'$.deletedAt') IS NULL ORDER BY p.task_id LIMIT 1) unmet_json
      FROM task t WHERE t.task_id IN (${taskIds.map(() => '?').join(',')})`).all(...taskIds);
    const link = (value: unknown) => {
      if (!value) return null;
      const task = taskFromRow({ record_json: value });
      return { taskId: task.taskId, title: task.title, status: task.status, revision: task.revision };
    };
    return Object.fromEntries(rows.map((row) => [String(row.task_id), {
      parent: link(row.parent_json),
      children: { total: Number(row.child_total), done: Number(row.child_done), cancelled: Number(row.child_cancelled) },
      dependencies: { total: Number(row.dependency_total), done: Number(row.dependency_done), firstUnmet: link(row.unmet_json) },
    }]));
  }

  relationContext(taskId: string, ancestorOffset: number) {
    // 路径防护容忍旧数据损坏；深层祖先按游标完整读取，不设展示深度上限。
    const ancestors = `WITH RECURSIVE ancestors(id,depth,path) AS (
      SELECT p.task_id,0,'|' || t.task_id || '|' || p.task_id || '|' FROM task t JOIN task p ON p.task_id=t.parent_id WHERE t.task_id=? AND json_extract(p.record_json,'$.deletedAt') IS NULL
      UNION ALL SELECT p.task_id,a.depth+1,a.path || p.task_id || '|' FROM ancestors a JOIN task c ON c.task_id=a.id JOIN task p ON p.task_id=c.parent_id WHERE instr(a.path,'|' || p.task_id || '|')=0 AND json_extract(p.record_json,'$.deletedAt') IS NULL)`;
    const total = Number(this.database.prepare(`${ancestors} SELECT count(*) total FROM ancestors`).get(taskId)!.total);
    const page = this.database.prepare(`${ancestors} SELECT t.record_json FROM ancestors a JOIN task t ON t.task_id=a.id ORDER BY a.depth LIMIT 100 OFFSET ?`).all(taskId, ancestorOffset).map(taskFromRow);
    const dependencies = this.database.prepare(`SELECT p.record_json FROM task_dependency d JOIN task p ON p.task_id=d.dependency_id WHERE d.task_id=? AND json_extract(p.record_json,'$.deletedAt') IS NULL ORDER BY p.task_id`).all(taskId).map(taskFromRow);
    return { ancestors: page, nextAncestorOffset: ancestorOffset + page.length < total ? ancestorOffset + page.length : null, dependencies };
  }

  save(task: Task, previousRevision: number | null): void {
    const values = [task.projectId, task.groupId, task.parentTaskId, task.status, task.revision, task.createdAt, JSON.stringify(task)];
    if (previousRevision === null) {
      this.database.prepare('INSERT INTO task(project_id, group_id, parent_id, status, revision, created_at, record_json, task_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(...values, task.taskId);
    } else {
      const result = this.database.prepare('UPDATE task SET project_id=?, group_id=?, parent_id=?, status=?, revision=?, created_at=?, record_json=? WHERE task_id=? AND revision=?')
        .run(...values, task.taskId, previousRevision);
      if (result.changes !== 1) throw new Error('任务写入版本已变化。');
    }
    this.database.prepare('DELETE FROM task_dependency WHERE task_id = ?').run(task.taskId);
    const insert = this.database.prepare('INSERT INTO task_dependency VALUES (?, ?)');
    for (const id of task.dependencyIds) insert.run(task.taskId, id);
  }

  events(taskId: string, before?: number): TaskEvent[] {
    return this.database.prepare('SELECT e.*, c.result_json AS record_json FROM task_event e JOIN task_command c ON c.command_id = e.command_id WHERE e.task_id = ? AND e.event_id < ? ORDER BY e.event_id DESC LIMIT 101')
      .all(taskId, before ?? Number.MAX_SAFE_INTEGER).map((value) => {
        const row = value as { event_id: number; task_id: string; command_id: string; revision: number; kind: string; summary: string; occurred_at: string };
        return { eventId: row.event_id, taskId: row.task_id, commandId: row.command_id, revision: row.revision, kind: row.kind, summary: row.summary, occurredAt: row.occurred_at, task: taskFromRow(value) };
      });
  }

  appendEvent(event: Omit<TaskEvent, 'eventId' | 'task'>): void {
    this.database.prepare('INSERT INTO task_event(task_id, command_id, revision, kind, summary, occurred_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(event.taskId, event.commandId, event.revision, event.kind, event.summary, event.occurredAt);
  }

  command(commandId: string): TaskCommandRecord | null {
    const row = this.database.prepare('SELECT * FROM task_command WHERE command_id = ?').get(commandId) as { fingerprint: string; result_json: string } | undefined;
    return row ? { commandId, fingerprint: row.fingerprint, result: JSON.parse(row.result_json) as Task | TaskGroup } : null;
  }

  saveCommand(command: TaskCommandRecord): void {
    this.database.prepare('INSERT INTO task_command VALUES (?, ?, ?)').run(command.commandId, command.fingerprint, JSON.stringify(command.result));
  }

  group(groupId: string): TaskGroup | null {
    const row = this.database.prepare('SELECT record_json FROM task_group WHERE group_id = ?').get(groupId) as { record_json: string } | undefined;
    return row ? JSON.parse(row.record_json) as TaskGroup : null;
  }

  groups(projectId?: string | null): TaskGroup[] {
    const rows = projectId === undefined
      ? this.database.prepare('SELECT record_json FROM task_group ORDER BY group_id LIMIT 100').all()
      : this.database.prepare('SELECT record_json FROM task_group WHERE project_id IS ? ORDER BY group_id LIMIT 100').all(projectId);
    return rows.map((row) => JSON.parse(row.record_json as string) as TaskGroup);
  }

  saveGroup(group: TaskGroup): void {
    this.database.prepare('INSERT INTO task_group VALUES (?, ?, ?)').run(group.groupId, group.projectId, JSON.stringify(group));
  }
}
