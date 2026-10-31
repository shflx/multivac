import type { Schedule, ScheduleOccurrence, SchedulePage, ScheduleQuery } from '@multivac/contracts';

/** 安排、触发与命令共用短事务；动作只能在提交触发身份后执行。 */
export interface ScheduleRepository {
  transaction<T>(operation: () => T): T;
  command<T>(id: string, fingerprint: string, operation: () => T): T;
  receipt<T>(id: string): { fingerprint: string; result: T } | null;
  get(id: string): Schedule | null;
  save(schedule: Schedule): void;
  page(query?: ScheduleQuery): SchedulePage;
  occurrence(id: string): ScheduleOccurrence | null;
  saveOccurrence(occurrence: ScheduleOccurrence): void;
  history(id: string, offset?: number, limit?: number): { items: ScheduleOccurrence[]; total: number; nextOffset: number | null };
  active(id: string): ScheduleOccurrence | null;
  due(now: string): Schedule[];
  bySession(id: string): ScheduleOccurrence | null;
  unsettled(): ScheduleOccurrence[];
}
