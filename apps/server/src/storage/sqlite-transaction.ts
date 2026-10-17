import type { DatabaseSync } from 'node:sqlite';

/**
 * 在一个短事务中执行同步操作：成功提交，抛错回滚并原样抛出。
 * 不支持嵌套；操作内不得调用模型、文件或网络。
 */
export function runInTransaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
