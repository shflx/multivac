import type { GitPublishService } from './git-publish-service.js';
import { Check } from 'typebox/value';
import { compareInboxItems, InboxQuerySchema, UpdateInboxStateSchema, UNKNOWN_CHANGE_ORIGIN, type InboxItem, type InboxQuery, type InboxList, type UpdateInboxState, type WorkbenchChangeOrigin, type DecideHumanRequest } from '@multivac/contracts';
import type { SqliteInboxRepository } from '../storage/sqlite-inbox-repository.js';
import type { HumanRequestService } from './human-request-service.js';
import type { ToolAuthorizationService } from './tool-authorization-service.js';
import type { WorkbenchEvents } from './workbench-events.js';
import { TaskServiceError, fingerprint } from './task-service.js';

/** 统一投影原服务事实，授权镜像不生成第二个决定对象。 */
export class InboxService {
  constructor(private readonly humans: HumanRequestService, private readonly authorization: ToolAuthorizationService,
    private readonly states: SqliteInboxRepository, private readonly events: WorkbenchEvents, private readonly external?: GitPublishService) {}

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
    for (const external of this.external?.list() ?? []) items.push({
      id: external.id, kind: 'external', revision: external.revision,
      status: external.status === 'pending' ? 'pending' : external.status === 'invalidated' ? 'invalidated' : ['unknown', 'executing'].includes(external.status) ? 'unknown' : 'answered',
      title: `发布到 ${external.ref}`, createdAt: external.createdAt, updatedAt: external.updatedAt, blocksWork: false,
      taskId: external.taskId, sessionId: external.sessionId, artifactVersionId: null, human: null, authorization: null, external, state: this.states.get(external.id),
    });
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
  /** 精简对话只读取该会话的外发确认；不暴露 Inbox 总数、任务请求或其他会话。 */
  conversationConfirmations(sessionId: string, offset = 0, limit = 100): InboxList {
    const all = this.all().filter(item => item.sessionId === sessionId && item.kind === 'external');
    const pending = all.filter(item => item.status === 'pending');
    const items = all.slice(offset, offset + limit);
    return { items, total: all.length, pendingCount: pending.length,
      unseenCount: pending.filter(item => !item.state.seen).length,
      nextOffset: offset + items.length < all.length ? offset + items.length : null };
  }
  getConversationConfirmation(sessionId: string, id: string): InboxItem {
    const item = this.get(id);
    if (item.sessionId !== sessionId || item.kind !== 'external') throw new TaskServiceError('NOT_FOUND', '当前对话确认请求不存在。');
    return item;
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
  async respond(id: string, input: DecideHumanRequest, origin: WorkbenchChangeOrigin = UNKNOWN_CHANGE_ORIGIN): Promise<InboxItem> {
    const item = this.get(id);
    if (!item.human || item.authorization || item.external) throw new TaskServiceError('INVALID_REQUEST', '权限与外发请求只能由用户在界面中处理。');
    await this.humans.respond(item.human.requestId, input, origin); return this.get(id);
  }
  async reconcile(id: string): Promise<InboxItem> {
    if (!this.get(id).external || !this.external) throw new TaskServiceError('INVALID_REQUEST', '此请求没有外部核对操作。');
    await this.external.reconcile(id); return this.get(id);
  }
  async decide(id: string, input: DecideHumanRequest, origin: WorkbenchChangeOrigin = UNKNOWN_CHANGE_ORIGIN): Promise<InboxItem> {
    const item = this.get(id);
    this.states.claimCommand(input.commandId, fingerprint({ id, ...input }));
    if (item.external) await this.external!.decide(id, input);
    else if (item.authorization) {
      if (!['once', 'session', 'project', 'deny'].includes(input.decision)) throw new TaskServiceError('INVALID_REQUEST', '目录授权决定无效。');
      if (item.status === 'pending' && item.revision !== input.revision) throw new TaskServiceError('TASK_CONFLICT', '请求版本已变化。');
      this.authorization.decide(item.authorization.sessionId, item.authorization.requestId, input.decision as 'once' | 'session' | 'project' | 'deny', origin);
    } else if (item.human) await this.humans.decide(item.human.requestId, input, origin);
    this.events.publish({ type: 'inbox.changed', id, origin });
    return this.get(id);
  }
}
