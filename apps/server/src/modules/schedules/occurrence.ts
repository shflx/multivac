import { createHash } from 'node:crypto';
import { reminderLocalTime, type Schedule, type ScheduleOccurrence } from '@multivac/contracts';

/** 计划身份跨安排版本保持稳定，避免相同绝对时刻重复触发。 */
export const scheduledOccurrenceId = (id: string, at: string) => `planned:${createHash('sha256').update(JSON.stringify([id, at])).digest('hex')}`;

export function makeOccurrence(schedule: Schedule, id: string, at: string, source: 'planned' | 'manual'): ScheduleOccurrence {
  return { occurrenceId: id, scheduleId: schedule.scheduleId, scheduleRevision: schedule.revision, snapshot: schedule, source,
    plannedAt: at, localTime: reminderLocalTime(new Date(at), schedule.timeZone), startedAt: null, endedAt: null,
    status: 'pending', reason: null, summary: null, sessionId: null, notificationId: null, leaseOwner: null, leaseUntil: null, executionSnapshot: null };
}
