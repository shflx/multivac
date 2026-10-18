import type { IncomingMessage, ServerResponse } from 'node:http';
import { Type } from 'typebox';
import { Check } from 'typebox/value';
import type { McpResourceService } from '../../application/mcp-resource-service.js';
import { McpResourceReadSchema, McpResourceSelectionSchema, McpEffectsSchema, McpRuleTargetSchema, type McpAccount } from '@multivac/contracts';
import type { McpManagementService } from '../../application/mcp-management-service.js';
import { McpError } from '../../modules/mcp/mcp.js';
import { readJsonBody, RequestBodyTooLargeError } from './json-body.js';

const id = Type.String({ minLength: 1, maxLength: 256, pattern: '^[A-Za-z0-9._:-]+$' });
const revision = Type.Integer({ minimum: 1 });
const command = { commandId: id };
const account = { ...command, accountId: id, revision };
const object = <T extends Record<string, ReturnType<typeof Type.String>>>(fields: T) => Type.Object(fields, { additionalProperties: false });
const previewSchema = Type.Object({ ...command, config: Type.String({ minLength: 1, maxLength: 256000 }), source: Type.String({ minLength: 1, maxLength: 4096 }), serviceId: Type.Optional(id), revision: Type.Optional(revision) }, { additionalProperties: false });
const oauthSchema = Type.Object({ issuer: Type.String({ maxLength: 4096 }), authorizationEndpoint: Type.String({ maxLength: 4096 }), tokenEndpoint: Type.String({ maxLength: 4096 }), clientId: Type.String({ minLength: 1, maxLength: 256 }), scope: Type.String({ maxLength: 4096 }) }, { additionalProperties: false });

/** 仅本地用户管理入口；远程访问保持 remote-policy 的默认拒绝。模型没有本接口的决定端口。 */
export function createMcpRequestHandler(service: McpManagementService, resources?: McpResourceService) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== '/api/mcp' && !url.pathname.startsWith('/api/mcp/')) return false;
    const send = (status: number, value: unknown) => { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); response.end(JSON.stringify(value)); };
    const query = (keys: string[]) => { const actual = [...url.searchParams.keys()]; if (new Set(actual).size !== actual.length || actual.some(key => !keys.includes(key))) throw new McpError('invalid-config', 'MCP 查询参数无效。', 400); };
    const changedAccount = async (value: McpAccount) => { service.notify(value.serviceId); await service.execution.connections.closeAccount(value.accountId, value.revision); return value; };
    try {
      if (request.method === 'GET' && url.pathname === '/api/mcp/oauth/callback') {
        await changedAccount(await service.accounts.finishCallback(new URL(request.url!, `http://${request.headers.host}`).href));
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'" });
        response.end('MCP 登录已处理。请关闭此页，回到能力管理核对账号状态。'); return true;
      }
      if (request.method === 'GET') {
        if (url.pathname === '/api/mcp') { query(['offset', 'limit']); send(200, service.list(Number(url.searchParams.get('offset') ?? 0), Number(url.searchParams.get('limit') ?? 100))); }
        else if (url.pathname === '/api/mcp/resources' && resources) { query(['sessionId', 'offset', 'limit']); send(200, resources.list(url.searchParams.get('sessionId') ?? '', Number(url.searchParams.get('offset') ?? 0), Number(url.searchParams.get('limit') ?? 25))); }
        else if (url.pathname === '/api/mcp/detail') { query(['serviceId']); send(200, service.detail(url.searchParams.get('serviceId') ?? '')); }
        else if (url.pathname === '/api/mcp/account-status') { query(['accountId']); send(200, await service.accounts.status(url.searchParams.get('accountId') ?? '')); }
        else if (url.pathname === '/api/mcp/connect-result') { query(['commandId']); send(200, service.connectResult(url.searchParams.get('commandId') ?? '')); }
        else if (url.pathname === '/api/mcp/availability') { query(['serviceId', 'sessionId']); send(200, service.availability(url.searchParams.get('serviceId') ?? '', url.searchParams.get('sessionId') ?? '')); }
        else if (url.pathname === '/api/mcp/scope') {
          query(['kind', 'id']); const kind = url.searchParams.get('kind');
          if (kind !== 'project' && kind !== 'agent' && kind !== 'session') throw new McpError('invalid-config', 'MCP 作用域无效。', 400);
          send(200, service.scope(kind, url.searchParams.get('id') ?? ''));
        } else if (url.pathname === '/api/mcp/call') { query(['callId']); send(200, service.call(url.searchParams.get('callId') ?? '')); }
        else throw new McpError('not-found', 'MCP 接口不存在。', 404);
        return true;
      }
      if (request.method !== 'POST' || url.searchParams.size || !request.headers['content-type']?.startsWith('application/json')) throw new McpError('invalid-config', 'MCP 管理需要无查询参数的 JSON POST。', 400);
      const input = await readJsonBody(request, url.pathname === '/api/mcp/preview' ? 300_000 : 128_000);
      if (url.pathname === '/api/mcp/preview' && Check(previewSchema, input)) send(200, service.preview(input));
      else if (url.pathname === '/api/mcp/resource-preview' && resources && Check(McpResourceSelectionSchema, input)) send(200, resources.preview(input));
      else if (url.pathname === '/api/mcp/resource-read' && resources && Check(McpResourceReadSchema, input)) send(200, await resources.read(input));
      else if (url.pathname === '/api/mcp/resource-result' && resources && Check(McpResourceReadSchema, input)) send(200, resources.result(input));
      else if (url.pathname === '/api/mcp/confirm' && Check(object({ ...command, previewId: id }), input)) send(200, await service.confirm(input.commandId, input.previewId));
      else if (url.pathname === '/api/mcp/state' && Check(Type.Object({ ...command, serviceId: id, revision, action: Type.Union([Type.Literal('enable'), Type.Literal('disable'), Type.Literal('remove')]) }, { additionalProperties: false }), input)) send(200, await service.state(input.commandId, input.serviceId, input.revision, input.action));
      else if (url.pathname === '/api/mcp/account-create' && Check(Type.Object({ ...command, serviceId: id, revision, label: Type.String({ minLength: 1, maxLength: 128 }), auth: Type.Union([Type.Literal('none'), Type.Literal('bearer'), Type.Literal('oauth')]) }, { additionalProperties: false }), input)) send(200, await changedAccount(service.accounts.create(input.commandId, input.serviceId, input.revision, input.label, input.auth)));
      else if (url.pathname === '/api/mcp/account-configure' && Check(Type.Object({ ...account, bearer: Type.Union([Type.String({ maxLength: 16000 }), Type.Null()]), environment: Type.Record(Type.String(), Type.String({ maxLength: 16000 })) }, { additionalProperties: false }), input)) send(200, await changedAccount(await service.accounts.configure(input.commandId, input.accountId, input.revision, { bearer: input.bearer, environment: input.environment })));
      else if (url.pathname === '/api/mcp/account-revoke' && Check(Type.Object(account, { additionalProperties: false }), input)) send(200, await changedAccount(await service.accounts.revoke(input.commandId, input.accountId, input.revision)));
      else if (url.pathname === '/api/mcp/account-reconcile' && Check(object({ accountId: id }), input)) send(200, await changedAccount(await service.accounts.reconcile(input.accountId)));
      else if (url.pathname === '/api/mcp/oauth-start' && Check(Type.Object({ ...account, config: oauthSchema }, { additionalProperties: false }), input)) { const result = await service.accounts.beginOAuth(input.commandId, input.accountId, input.revision, input.config); await changedAccount(result.account); send(200, result); }
      else if (url.pathname === '/api/mcp/oauth-refresh' && Check(Type.Object(account, { additionalProperties: false }), input)) send(200, await changedAccount(await service.accounts.refresh(input.accountId, input.revision)));
      else if (url.pathname === '/api/mcp/oauth-cancel' && Check(Type.Object(account, { additionalProperties: false }), input)) send(200, await changedAccount(await service.accounts.cancelOAuth(input.commandId, input.accountId, input.revision)));
      else if (url.pathname === '/api/mcp/connect-preview' && Check(object({ serviceId: id, accountId: id, sessionId: id }), input)) send(200, service.connectionPreview(input.serviceId, input.accountId, input.sessionId));
      else if (url.pathname === '/api/mcp/connect' && Check(object({ ...command, serviceId: id, accountId: id, sessionId: id, fingerprint: id }), input)) send(200, await service.connect(input));
      else if (url.pathname === '/api/mcp/disconnect' && Check(object({ ...command, connectionId: id }), input)) send(200, await service.disconnect(input.commandId, input.connectionId));
      else if (url.pathname === '/api/mcp/refresh' && Check(object({ ...command, connectionId: id }), input)) send(200, await service.refresh(input.commandId, input.connectionId));
      else if (url.pathname === '/api/mcp/rule' && Check(Type.Object({ ...command, serviceId: id, revision: Type.Integer({ minimum: 0 }), target: McpRuleTargetSchema }, { additionalProperties: false }), input)) { const result = service.rules.set(input.commandId, input.serviceId, input.revision, input.target); service.notify(input.serviceId); send(200, result); }
      else if (url.pathname === '/api/mcp/classify' && Check(Type.Object({ ...command, sessionId: id, connectionId: id, toolId: id, catalogVersion: id, definitionVersion: id, effects: McpEffectsSchema }, { additionalProperties: false }), input)) {
        const identity = service.execution.userIdentity(input.sessionId, input.connectionId, input.toolId);
        if (identity.catalogVersion !== input.catalogVersion || identity.definitionVersion !== input.definitionVersion) throw new McpError('catalog-changed', '目录或工具定义已变化，请重新核对。');
        const result = service.execution.authorizations.confirmClassification(input.commandId, identity, input.effects); service.notify(identity.serviceId); send(200, result);
      } else if (url.pathname === '/api/mcp/classification-revoke' && Check(Type.Object({ ...command, classificationId: id, serviceId: id, revision }, { additionalProperties: false }), input)) {
        if (!service.detail(input.serviceId).classifications.some(value => value.classificationId === input.classificationId)) throw new McpError('identity-changed', '分类不属于此服务。');
        service.execution.authorizations.revokeClassification(input.commandId, input.classificationId, input.revision); service.notify(input.serviceId); send(200, { revoked: true });
      } else throw new McpError('invalid-config', 'MCP 管理参数无效。', 400);
    } catch (error) {
      const status = error instanceof McpError ? error.status : error instanceof RequestBodyTooLargeError ? 413 : error instanceof SyntaxError || error instanceof URIError ? 400 : 500;
      send(status, { error: { code: error instanceof McpError ? error.code : status === 413 ? 'limit-exceeded' : 'invalid-config', message: error instanceof McpError ? error.message : 'MCP 请求未完成，请先核对当前事实。' } });
    }
    return true;
  };
}
