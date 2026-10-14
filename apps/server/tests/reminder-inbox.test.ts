import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Check } from 'typebox/value';
import { InboxItemSchema, type HumanRequest } from '@multivac/contracts';
import { InboxService } from '../src/application/inbox-service.js';
import { ReminderService } from '../src/application/reminder-service.js';
import { ReminderScheduler } from '../src/application/reminder-scheduler.js';
import type { HumanRequestService } from '../src/application/human-request-service.js';
import type { ToolAuthorizationService } from '../src/application/tool-authorization-service.js';
import { WorkbenchEvents } from '../src/application/workbench-events.js';
import { INBOX_MIGRATION, SqliteInboxRepository } from '../src/storage/sqlite-inbox-repository.js';
import { REMINDER_MIGRATION, SqliteReminderRepository } from '../src/storage/sqlite-reminder-repository.js';
import { createReminderTool } from '../src/application/internal-tools/reminder-tools.js';
import type { InternalToolProposeContext } from '../src/application/internal-tools/internal-tool-service.js';

const human: HumanRequest = { requestId: 'blocking', taskId: 'task', runId: null, sessionId: 'work', kind: 'clarification', revision: 1,
  status: 'pending', question: '澄清', createdAt: '2026-10-15T00:00:00Z', updatedAt: '2026-10-15T00:00:00Z',
  artifactVersionId: null, authorizationRequestId: null, decision: null, answer: '', reason: '' };
function inbox(db: DatabaseSync, reminders: SqliteReminderRepository, events: WorkbenchEvents, humans: HumanRequest[] = []) {
  return new InboxService({ list: () => humans } as unknown as HumanRequestService,
    { all: () => [] } as unknown as ToolAuthorizationService, new SqliteInboxRepository(db), events, undefined, reminders);
}

test('工具安排 → 真实 SQLite 持久化 → 重启补发 → 查看 → 知道了，共享窗口和重新连接一致', async () => {
  mkdirSync('.tmp', { recursive: true });
  const directory = mkdtempSync('.tmp/reminder-inbox-');
  const path = `${directory}/data.sqlite`;
  let db = new DatabaseSync(path);
  try {
    db.exec(INBOX_MIGRATION); db.exec(REMINDER_MIGRATION);
    let repo = new SqliteReminderRepository(db);
    const reminders = new ReminderService(repo, () => {}, () => new Date('2026-10-14T00:00:00Z'));
    const context = { sessionId: 'global-coordinator', services: { reminders } } as unknown as InternalToolProposeContext;
    await createReminderTool.execute({ commandId: 'create-meeting', text: '开会\n<script>不可执行</script>', scheduledAt: '2026-10-14T15:00:00+08:00', timeZone: 'Asia/Shanghai', localTime: '2026-10-14T15:00:00' }, context);
    assert.equal(repo.page().total, 1);
    assert.equal(inbox(db, repo, new WorkbenchEvents()).page().pendingCount, 0);
    db.close(); db = new DatabaseSync(path); repo = new SqliteReminderRepository(db);
    const events = new WorkbenchEvents();
    let firstWindow = 0; let secondWindow = 0;
    events.subscribe(event => { if (event.type === 'inbox.changed') firstWindow++; }, 'first');
    events.subscribe(event => { if (event.type === 'inbox.changed') secondWindow++; }, 'second');
    const clock = () => new Date('2026-10-14T08:00:00Z');
    const scheduler = new ReminderScheduler(repo, events, clock);
    scheduler.tick(); scheduler.tick();
    const first = inbox(db, repo, events, [human]);
    const second = inbox(db, repo, events, [human]);
    const page = first.page();
    assert.equal(page.pendingCount, 2); assert.equal(page.unseenCount, 2);
    assert.equal(page.items[0]!.id, human.requestId);
    const notice = page.items.find(item => item.notification)!;
    assert.equal(Check(InboxItemSchema, notice), true);
    assert.equal(notice.blocksWork, false); assert.equal(notice.taskId, null);
    assert.equal(notice.notification!.scheduledAt, '2026-10-14T07:00:00.000Z');
    assert.equal(notice.notification!.createdAt, '2026-10-14T08:00:00.000Z');
    assert.equal(first.get(notice.id).state.seen, false);
    first.updateState(notice.id, { revision: 0, seen: true });
    assert.equal(second.page().pendingCount, 2); assert.equal(second.page().unseenCount, 1);
    await assert.rejects(first.decide(notice.id, { commandId: 'bad', revision: 1, decision: 'accept' }), /普通通知/);
    const command = { commandId: 'know', revision: 1, decision: 'acknowledge' as const };
    await first.decide(notice.id, command);
    await first.decide(notice.id, command);
    assert.equal(second.get(notice.id).status, 'answered');
    assert.equal(second.page().pendingCount, 1); assert.equal(second.page().unseenCount, 1);
    assert.equal(repo.notifications().length, 1);
    await assert.rejects(second.decide(human.requestId, { ...command, commandId: 'invalid-human' }), /仅用于普通通知/);
    assert.equal(human.status, 'pending');
    assert.equal(firstWindow, secondWindow); assert.ok(firstWindow >= 3);
    db.close(); db = new DatabaseSync(path); repo = new SqliteReminderRepository(db);
    const reconnected = inbox(db, repo, new WorkbenchEvents(), [human]);
    assert.equal(reconnected.page().pendingCount, 1); assert.equal(reconnected.page().unseenCount, 1);
    assert.equal(reconnected.get(notice.id).status, 'answered');
    assert.equal(reconnected.get(notice.id).state.seen, true);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('通知全量计数超过一页，重复确认与版本冲突不改变其他通知', async () => {
  const db = new DatabaseSync(':memory:'); db.exec(INBOX_MIGRATION); db.exec(REMINDER_MIGRATION);
  const repo = new SqliteReminderRepository(db);
  try {
    const service = new ReminderService(repo, () => {}, () => new Date('2026-10-14T00:00:00Z'));
    for (let i = 0; i < 105; i++) service.create('global-coordinator', { commandId: `create-${i}`, text: `通知${i}`, scheduledAt: '2026-10-14T07:00:00Z', timeZone: 'Asia/Shanghai', localTime: '2026-10-14T15:00:00' });
    const scheduler = new ReminderScheduler(repo, new WorkbenchEvents(), () => new Date('2026-10-14T07:00:05Z'));
    assert.equal(scheduler.tick(), true); scheduler.tick();
    const first = inbox(db, repo, new WorkbenchEvents());
    assert.equal(first.page({ limit: 1 }).pendingCount, 105); assert.equal(first.page({ offset: 100 }).items.length, 5);
    const item = first.page().items[0]!;
    await assert.rejects(first.decide(item.id, { commandId: 'stale', revision: 2, decision: 'acknowledge' }), /版本/);
    assert.equal(first.page().pendingCount, 105);
    await first.decide(item.id, { commandId: 'valid', revision: 1, decision: 'acknowledge' });
    assert.equal(first.page().pendingCount, 104);
    assert.equal(first.page().unseenCount, 104);
  } finally { db.close(); }
});
