import type { DatabaseSync } from 'node:sqlite';
import type { TaskFacts, TaskFactsStore } from '../modules/tasks/task-facts.js';

/**
 * 任务事实的 SQLite 实现。所有仓储必须建在同一个连接上，事务原子性由本对象统一承诺，
 * 调用方不再依赖“多个仓储恰好共用连接”的约定。
 */
export class SqliteTaskFacts implements TaskFactsStore {
  readonly tasks: TaskFacts['tasks'];
  readonly runs: TaskFacts['runs'];
  readonly requests: TaskFacts['requests'];
  readonly artifacts: TaskFacts['artifacts'];
  readonly runtime: TaskFacts['runtime'];

  constructor(private readonly database: DatabaseSync, facts: TaskFacts) {
    ({ tasks: this.tasks, runs: this.runs, requests: this.requests, artifacts: this.artifacts, runtime: this.runtime } = facts);
  }

  transaction<T>(operation: (facts: TaskFacts) => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation(this);
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}
