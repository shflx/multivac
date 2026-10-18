import { randomUUID } from 'node:crypto';
import { McpManagementProposalSchema, type McpManagementProposal, type McpManagementProposalPreview } from '@multivac/contracts';
import { McpError, mcpFingerprint } from '../../modules/mcp/mcp.js';
import { defineProposalKind, ProposalExecutionError } from '../../modules/proposals/proposal.js';
import type { McpManagementService } from '../mcp-management-service.js';

/** 模型只有提出入口；执行器在真实用户确认后才取得管理写端口。 */
export function createMcpManagementKind(service: () => McpManagementService, now = () => new Date().toISOString()) {
  function facts(input: McpManagementProposal): Record<string, unknown> {
    if (input.action === 'import') return { service: input.serviceId ? service().detail(input.serviceId).service : null };
    const detail = service().detail(input.serviceId);
    if (detail.service.removed) throw new McpError('conflict', '服务已移除。');
    if (input.action === 'state') {
      if (detail.service.revision !== input.revision) throw new McpError('conflict', '服务版本已变化。');
      return { service: detail.service, state: input.state, scope: '全局服务登记；不改变宿主权限', account: null };
    }
    if (input.action === 'connect') return { connection: service().connectionPreview(input.serviceId, input.accountId, input.sessionId) };
    const target = input.target, id = target.kind === 'project' ? target.projectId : target.kind === 'agent' ? target.agentId : target.sessionId;
    const scope = service().scope(target.kind, id).find(item => item.service.serviceId === input.serviceId);
    if (!scope?.editable || (scope.rule?.revision ?? 0) !== input.revision) throw new McpError('conflict', '范围版本或可编辑状态已变化。');
    const account = target.kind === 'project' && target.accountId ? detail.accounts.find(item => item.accountId === target.accountId) : null;
    if (target.kind === 'project' && target.accountId && (!account || account.state === 'revoked')) throw new McpError('identity-changed', '所选账号不可用。');
    return { service: detail.service, previousRule: scope.rule, target, account: account ?? null };
  }
  return defineProposalKind<typeof McpManagementProposalSchema, McpManagementProposalPreview>({
    kind: 'mcp.manage', payload: McpManagementProposalSchema,
    prepare(input) {
      const commandId = randomUUID(), current = facts(input);
      if (input.action === 'import') current.imports = service().preview({ ...input, commandId });
      const impact = input.action === 'import' ? '登记为停用；修改会使旧目录和许可失效，并关闭旧连接。账号需在管理页单独配置，不导入凭据。'
        : input.action === 'connect' ? '在固定会话及真实目录建立连接，可能启动所示程序或访问所示地址；不授予工具调用许可。'
        : input.action === 'rule' ? '更改所示范围的能力交集；既有许可失效。宿主目录、网络和进程权限不变，每次调用仍需单独确认。'
        : '更改全局登记状态；停用或移除会阻止新调用并请求关闭旧连接，停止结果以持久事实为准。';
      return { title: `MCP：${({ import: '登记或修改服务', state: '更改服务状态', rule: '更改能力范围', connect: '建立固定范围连接' })[input.action]}`,
        preview: { commandId, facts: current, fingerprint: mcpFingerprint(current), impact, expiresAt: new Date(Date.parse(now()) + 15 * 60_000).toISOString() } };
    },
    revalidate(input, preview) {
      try {
        if (preview.expiresAt <= now()) return '提议已过期，请重新核对。';
        const current = facts(input);
        if (input.action === 'import') current.imports = preview.facts.imports;
        if (mcpFingerprint(current) !== preview.fingerprint) return '服务、账号或范围事实已变化，请重新提出。';
        if (input.action === 'connect' && !(current.connection as { available: boolean }).available) return '当前有效规则不允许连接。';
        return null;
      } catch (error) { return error instanceof McpError ? error.message : '当前管理事实无法核对。'; }
    },
    async execute(input, preview) {
      const completed: string[] = [];
      try {
        // 执行前再次同步核对；管理服务还会在写事务或实际发送前复核对应版本。
        if (preview.expiresAt <= now()) throw new McpError('conflict', '提议已过期。');
        const current = facts(input); if (input.action === 'import') current.imports = preview.facts.imports;
        if (mcpFingerprint(current) !== preview.fingerprint) throw new McpError('conflict', '管理事实已变化。');
        if (input.action === 'import') {
          for (const entry of preview.facts.imports as { previewId: string }[]) {
            const saved = await service().confirm(`${preview.commandId}:${entry.previewId}`, entry.previewId);
            completed.push(`「${saved.name}」版本 ${saved.revision}`);
          }
          return { summary: `已停用登记 ${completed.join('、')}；尚未连接、登录或取得调用许可。`, refs: [] };
        }
        if (input.action === 'state') { const saved = await service().state(preview.commandId, input.serviceId, input.revision, input.state); return { summary: `服务「${saved.name}」登记状态已更新至版本 ${saved.revision}；连接停止另查真实记录。`, refs: [] }; }
        if (input.action === 'rule') { const saved = service().rules.set(preview.commandId, input.serviceId, input.revision, input.target); service().notify(input.serviceId); return { summary: `能力范围已更新至版本 ${saved.revision}；未授予调用许可。`, refs: [] }; }
        const evidence = preview.facts.connection as { fingerprint: string };
        const result = await service().connect({ ...input, commandId: preview.commandId, fingerprint: evidence.fingerprint });
        return { summary: `连接记录 ${result.connection?.connectionId ?? '尚无'}，状态 ${result.connection?.state ?? '未知'}；未授予调用许可。`, refs: [] };
      } catch (error) {
        throw new ProposalExecutionError(`${completed.length ? `已登记 ${completed.join('、')}。` : ''}${error instanceof McpError ? error.message : '管理结果未能核实。'}请只读查询服务、连接和原提议回执；不要重发未知操作。`);
      }
    },
  });
}
