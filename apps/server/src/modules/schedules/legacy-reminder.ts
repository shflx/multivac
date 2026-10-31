import type { Reminder, Schedule } from '@multivac/contracts';

export function reminderSchedule(item: Reminder): Schedule {
  return { scheduleId: item.reminderId, legacyReminderId: item.reminderId, revision: item.revision,
    name: item.text.slice(0, 200), action: { kind: 'reminder', text: item.text },
    rule: { kind: 'once', scheduledAt: item.scheduledAt, localTime: item.localTime }, timeZone: item.timeZone, missedPolicy: 'latest',
    state: item.status === 'scheduled' ? 'active' : item.status === 'cancelled' ? 'deleted' : 'completed',
    nextAt: item.status === 'scheduled' ? item.scheduledAt : null, sourceSessionId: item.sourceSessionId, createdAt: item.createdAt, updatedAt: item.updatedAt };
}
