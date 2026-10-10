import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExternalOperation } from '@multivac/contracts';
import { InboxService } from '../src/application/inbox-service.js';
import type { HumanRequestService } from '../src/application/human-request-service.js';
import type { ToolAuthorizationService } from '../src/application/tool-authorization-service.js';
import type { GitPublishService } from '../src/application/git-publish-service.js';
import type { SqliteInboxRepository } from '../src/storage/sqlite-inbox-repository.js';
import { WorkbenchEvents } from '../src/application/workbench-events.js';

/** 不创建Git仓库或发起外发，只验证原服务投影的范围和计数。 */
test('当前对话外发确认先过滤会话再分页，不泄漏Inbox总数且拒绝替换请求ID', () => {
  const operation = (id: string, sessionId: string): ExternalOperation => ({ id, sessionId, taskId: null,
    revision: 1, status: 'pending', repository: '/fixture/repo', remote: 'origin', target: 'https://example.com/repo.git',
    ref: 'refs/heads/new-branch', commit: 'a'.repeat(40), summary: '固定变更', account: '本机凭据',
    createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z', result: '等待确认' });
  const operations = [operation('external:outside-a', 'outside'), operation('external:inside-a', 'global-coordinator'),
    operation('external:outside-b', 'outside'), operation('external:inside-b', 'global-coordinator')];
  const inbox = new InboxService({ list: () => [] } as unknown as HumanRequestService,
    { all: () => [] } as unknown as ToolAuthorizationService,
    { get: () => ({ revision: 0, seen: false, draft: '' }) } as unknown as SqliteInboxRepository,
    new WorkbenchEvents(), { list: () => operations } as unknown as GitPublishService);
  const first = inbox.conversationConfirmations('global-coordinator', 0, 1);
  assert.deepEqual(first.items.map(item => item.id), ['external:inside-a']);
  assert.equal(first.total, 2); assert.equal(first.pendingCount, 2); assert.equal(first.unseenCount, 2); assert.equal(first.nextOffset, 1);
  const second = inbox.conversationConfirmations('global-coordinator', 1, 1);
  assert.deepEqual(second.items.map(item => item.id), ['external:inside-b']); assert.equal(second.nextOffset, null);
  assert.throws(() => inbox.getConversationConfirmation('global-coordinator', 'external:outside-a'), /当前对话确认请求不存在/u);
  assert.equal(inbox.getConversationConfirmation('global-coordinator', 'external:inside-a').sessionId, 'global-coordinator');
});
