import { createHash } from 'node:crypto';
import type { Task } from '@multivac/contracts';
import { safeDirectoryName } from '../modules/sessions/working-directory.js';

/** 保留中文等可读标题，去掉 Git 引用中不合法的点与路径／shell 字符。 */
function taskDirectoryTitle(title: string): string {
  return safeDirectoryName(title.replace(/[._]/gu, '-').toLowerCase(), 'task');
}

/** 标题只在新建时取一次；任务与执行摘要使同名任务和重新执行各自独立。 */
export function taskDirectoryName(task: Pick<Task, 'taskId' | 'title'>, runId: string): string {
  const suffix = createHash('sha256').update(`${task.taskId}:${runId}`).digest('hex').slice(0, 20);
  return `${taskDirectoryTitle(task.title)}-${suffix}`;
}

/** 按已分配目录确定固定分支，恢复时不依赖当前标题；兼容旧的纯摘要目录。 */
export function taskBranchName(directoryName: string): string | null {
  if (/^[a-f0-9]{64}$/u.test(directoryName)) return `multivac-task-${directoryName.slice(0, 20)}`;
  const match = /^(.+)-[a-f0-9]{20}$/u.exec(directoryName);
  if (!match || taskDirectoryTitle(match[1]!) !== match[1]) return null;
  return `multivac-task-${directoryName}`;
}
