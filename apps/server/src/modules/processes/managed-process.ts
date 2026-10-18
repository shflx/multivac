import type { ManagedProcess } from '@multivac/contracts';

/** 托管进程的持久记录：公开状态之外，保存命令身份、目录、监督令牌与归属，供恢复对账。 */
export interface ManagedProcessRecord {
  public: ManagedProcess;
  commandId: string;
  fingerprint: string;
  directory: string;
  backend?: 'bash';
  token: string;
  pid: number | null;
  ownerId: string;
}

/** 托管进程与命令回执的仓储端口；transaction 内的写入整体提交或回滚。 */
export interface ManagedProcessRepository {
  transaction<T>(operation: () => T): T;
  command(id: string): { fingerprint: string; result: ManagedProcess } | null;
  batchCommand(id: string): { fingerprint: string; processIds: string[] } | null;
  saveBatchCommand(id: string, key: string, processIds: string[]): void;
  saveCommand(id: string, key: string, result: ManagedProcess): void;
  all(): ManagedProcessRecord[];
  visible(): ManagedProcessRecord[];
  /** 活跃进程都可见；终态前台进程的隐藏规则不影响这两个计数。 */
  counts(activeOnly?: boolean): { processesRunning: number; processesRecovery: number };
  active(): ManagedProcessRecord[];
  get(id: string): ManagedProcessRecord | undefined;
  byCommand(id: string): ManagedProcessRecord | undefined;
  save(record: ManagedProcessRecord): void;
}
