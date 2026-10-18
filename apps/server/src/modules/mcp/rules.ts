import type { McpAvailability, McpEffect, McpHost, McpOperationIdentity, McpRule, McpRuleTarget } from '@multivac/contracts';
import { McpError, mcpCanonical, mcpFingerprint, ruleIdentity, type McpRepository } from './mcp.js';

export interface McpRuleContext {
  sessionId: string;
  projectId: string | null;
  agentId: string | null;
  taskId: string | null;
  runId: string | null;
  host: McpHost;
  /** 原宿主实际许可；必须由服务端解析，不能采用模型或页面提交的能力候选。 */
  hostEffects: readonly McpEffect[];
  transportAllowed: boolean;
  /** 本会话显式连接的账号；项目选择存在时不得静默改用它。 */
  accountId: string | null;
}
const ALL_EFFECTS: McpEffect[] = ['read', 'local-write', 'external-write', 'data-transfer'];

/** 展示、模型候选和执行入口共用的规则交集。偏好只排序，不能启用服务或越过排除。 */
export class McpRules {
  constructor(private readonly repository: McpRepository) {}
  resolve(serviceId: string, context: McpRuleContext, effects: readonly McpEffect[] = []): McpAvailability {
    const service = this.repository.get('service', serviceId), rules = this.applicable(serviceId, context);
    const project = rules.find(rule => rule.target.kind === 'project')?.target;
    const agent = rules.find(rule => rule.target.kind === 'agent')?.target;
    const session = rules.find(rule => rule.target.kind === 'session')?.target;
    const accountId = project?.kind === 'project' ? project.accountId : context.accountId;
    const account = accountId ? this.repository.get('account', accountId) : null;
    const agentCap = agent?.kind === 'agent' ? agent.effectCeiling : ALL_EFFECTS;
    const ceiling = context.hostEffects.filter(effect => agentCap.includes(effect)
      && (context.host !== 'coordinator' || effect === 'read' || effect === 'data-transfer'));
    const reasons: McpAvailability['reasons'] = [], details: string[] = [];
    const deny = (code: McpAvailability['reasons'][number], reason: string) => { if (!reasons.includes(code)) reasons.push(code); details.push(reason); };
    if (!service || service.removed || !service.enabled) deny('rule-denied', '服务未启用或已移除');
    if (service?.transport.kind === 'legacy-sse') deny('unsupported-transport', '不支持旧 HTTP+SSE');
    if (project?.kind === 'project' && project.excluded) deny('rule-denied', '本项目已排除');
    if (session?.kind === 'session' && session.disabled) deny('rule-denied', '本会话已临时停用');
    if (!account || account.serviceId !== serviceId || account.state !== 'ready') deny('credential-unavailable', '未选择可用的服务账号');
    if (accountId && context.accountId && accountId !== context.accountId) deny('identity-changed', '项目选择与本连接账号不一致');
    if (!context.transportAllowed) deny('rule-denied', '宿主未允许此服务的进程或网络访问');
    if (effects.some(effect => !ceiling.includes(effect))) deny('rule-denied', '超出智能体或宿主的效果上限');
    return { serviceId, accountId, available: !reasons.length, reasons, details, effectCeiling: [...ceiling],
      preferred: agent?.kind === 'agent' ? agent.preferred : false,
      ruleVersions: rules.map(rule => ({ ruleId: rule.ruleId, revision: rule.revision })).sort((a, b) => a.ruleId.localeCompare(b.ruleId)) };
  }
  assert(identity: McpOperationIdentity, context: McpRuleContext, effects: readonly McpEffect[]): void {
    if (identity.sessionId !== context.sessionId || identity.projectId !== context.projectId || identity.agentId !== context.agentId
      || identity.taskId !== context.taskId || identity.runId !== context.runId || identity.host !== context.host)
      throw new McpError('identity-changed', 'MCP 宿主、项目或本轮执行者身份已变化。');
    const effective = this.resolve(identity.serviceId, context, effects);
    if (!effective.available || effective.accountId !== identity.accountId) throw new McpError('rule-denied', effective.details.join('；') || 'MCP 账号不适用。');
    if (mcpCanonical(effective.ruleVersions) !== mcpCanonical([...identity.ruleVersions].sort((a, b) => a.ruleId.localeCompare(b.ruleId))))
      throw new McpError('identity-changed', 'MCP 有效规则版本已变化。');
  }
  private applicable(serviceId: string, context: McpRuleContext): McpRule[] {
    const applicable: McpRule[] = [];
    for (let offset = 0; ; offset += 100) {
      const rules = this.repository.list('rule', { serviceId, offset });
      applicable.push(...rules.filter(rule => {
        const target = rule.target;
        return target.kind === 'project' ? target.projectId === context.projectId : target.kind === 'agent' ? target.agentId === context.agentId : target.sessionId === context.sessionId;
      }));
      if (rules.length < 100) return applicable;
    }
  }
}

export interface McpRuleOwnerPolicy { validate(target: McpRuleTarget, readOnly?: boolean): void }
/** 仅由用户管理入口装配；写入仍不提供执行许可或传输权限。 */
export class McpRuleService {
  constructor(private readonly repository: McpRepository, private readonly owners: McpRuleOwnerPolicy, private readonly now = () => new Date().toISOString()) {}
  set(commandId: string, serviceId: string, expectedRevision: number, target: McpRuleTarget): McpRule {
    const ruleId = mcpFingerprint([serviceId, ruleIdentity(target)]), fingerprint = mcpFingerprint({ serviceId, expectedRevision, target });
    this.repository.commit(`mcp-rule:${commandId}`, fingerprint, this.now(), tx => {
      this.owners.validate(target);
      const service = tx.get('service', serviceId);
      if (!service || service.removed) throw new McpError('not-found', 'MCP 服务不存在。', 404);
      if (target.kind === 'project' && target.accountId) {
        const account = tx.get('account', target.accountId);
        if (!account || account.serviceId !== serviceId || account.state === 'revoked') throw new McpError('identity-changed', '项目账号不存在或已撤销。');
      }
      tx.put('rule', { ruleId, serviceId, revision: expectedRevision + 1, target, updatedAt: this.now() }, expectedRevision);
    });
    return this.repository.get('rule', ruleId)!;
  }
  get(serviceId: string, target: McpRuleTarget): McpRule | null { return this.repository.get('rule', mcpFingerprint([serviceId, ruleIdentity(target)])); }
}
