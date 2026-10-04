import { Check } from 'typebox/value';
import { compareInboxItems, InboxQuerySchema, UpdateInboxStateSchema, UNKNOWN_CHANGE_ORIGIN, type InboxItem, type InboxQuery, type InboxList, type UpdateInboxState, type WorkbenchChangeOrigin, type DecideHumanRequest } from '@multivac/contracts';
import type { SqliteInboxRepository } from '../storage/sqlite-inbox-repository.js';
import type { HumanRequestService } from './human-request-service.js';
import type { ToolAuthorizationService } from './tool-authorization-service.js';
import type { WorkbenchEvents } from './workbench-events.js';
import { TaskServiceError } from './task-service.js';

/** 统一投影原服务事实，授权镜像不生成第二个决定对象。 */
export class InboxService {
  constructor(private readonly humans: HumanRequestService, private readonly authorization: ToolAuthorizationService,
    private readonly states: SqliteInboxRepository, private readonly events: WorkbenchEvents) {}

  private all(): InboxItem[] {
    const humans = this.humans.list();
    const items: InboxItem[] = humans.filter((request) => request.kind !== 'authorization').map((human) => ({
      id: human.requestId, kind: human.kind, revision: human.revision, status: human.status,
      title: human.question, createdAt: human.createdAt, updatedAt: human.updatedAt, blocksWork: human.status === 'pending',
      taskId: human.taskId, sessionId: human.sessionId, artifactVersionId: human.artifactVersionId,
      human, authorization: null, state: this.states.get(human.requestId),
    }));
    for (const authorization of this.authorization.all()) {
      // 记住的授权直接执行，没有用户待决定过程，不混进 Inbox。
      if (authorization.approval?.source === 'grant') continue;
      const human = humans.find((request) => request.authorizationRequestId === authorization.requestId) ?? null;
      const id = `authorization:${authorization.requestId}`;
      const status = authorization.status === 'pending' ? 'pending' : authorization.status === 'expired' ? 'expired'
        : ['approved', 'denied'].includes(authorization.status) ? 'answered' : 'invalidated';
      items.push({ id, kind: 'authorization', revision: status === 'pending' ? 1 : 2, status,
        title: `是否允许 ${authorization.toolName} 访问 ${authorization.targetPath}？`,
        createdAt: authorization.createdAt, updatedAt: authorization.decidedAt ?? authorization.createdAt,
        blocksWork: status === 'pending', taskId: human?.taskId ?? null, sessionId: authorization.sessionId,
        artifactVersionId: null, human, authorization, state: this.states.get(id) });
    }
    return items.sort(compareInboxItems);
  }
  page(query: InboxQuery = {}): InboxList {
    if (!Check(InboxQuerySchema, query)) throw new TaskServiceError('INVALID_REQUEST', 'Inbox 查询无效。');
    const all = this.all();
    const pending = all.filter((item) => item.status === 'pending');
    const filtered = all.filter((item) => (!query.taskId || item.taskId === query.taskId) && (query.status === 'all' || item.status === 'pending'));
    const offset = query.offset ?? 0;
    const items = filtered.slice(offset, offset + (query.limit ?? 100));
    return { items, total: filtered.length, pendingCount: pending.length, unseenCount: pending.filter((item) => !item.state.seen).length,
      nextOffset: offset + items.length < filtered.length ? offset + items.length : null };
  }
  get(id: string): InboxItem {
    const item = this.all().find((item) => item.id === id);
    if (!item) throw new TaskServiceError('NOT_FOUND', 'Inbox 请求不存在或来源已移除。');
    return item;
  }
  updateState(id: string, input: UpdateInboxState, origin: WorkbenchChangeOrigin = UNKNOWN_CHANGE_ORIGIN) {
    this.get(id);
    if (!Check(UpdateInboxStateSchema, input)) throw new TaskServiceError('INVALID_REQUEST', '查看或草稿参数无效。');
    const state = this.states.update(id, input);
    this.events.publish({ type: 'inbox.changed', id, origin });
    return state;
  }
  async decide(id: string, input: DecideHumanRequest, origin: WorkbenchChangeOrigin = UNKNOWN_CHANGE_ORIGIN): Promise<InboxItem> {
    const item = this.get(id);
    if (item.authorization) {
      if (!['once', 'session', 'project', 'deny'].includes(input.decision)) throw new TaskServiceError('INVALID_REQUEST', '目录授权决定无效。');
      if (item.status === 'pending' && item.revision !== input.revision) throw new TaskServiceError('TASK_CONFLICT', '请求版本已变化。');
      this.authorization.decide(item.authorization.sessionId, item.authorization.requestId, input.decision as 'once' | 'session' | 'project' | 'deny', origin);
    } else if (item.human) await this.humans.decide(item.human.requestId, input, origin);
    this.events.publish({ type: 'inbox.changed', id, origin });
    return this.get(id);
  }
}
