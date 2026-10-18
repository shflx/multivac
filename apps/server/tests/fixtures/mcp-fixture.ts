import { DatabaseSync } from 'node:sqlite';
import type { McpAccount, McpCatalog, McpOperationIdentity, McpService } from '@multivac/contracts';
import { mcpFingerprint, mcpToolId } from '../../src/modules/mcp/mcp.js';
import { MCP_MIGRATION, SqliteMcpRepository } from '../../src/storage/sqlite-mcp-repository.js';

export const mcpAt = '2026-01-01T00:00:00.000Z';
export function mcpFixture() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON;');
  db.exec(MCP_MIGRATION);
  const repository = new SqliteMcpRepository(db);
  const transport = { kind: 'stdio' as const, command: 'fixture-server', args: [], cwd: null, environmentKeys: [] };
  const service: McpService = { serviceId: 'service', revision: 1, name: '测试服务', source: 'fixture', transport,
    configVersion: mcpFingerprint(transport), enabled: true, removed: false, createdAt: mcpAt, updatedAt: mcpAt };
  const account: McpAccount = { accountId: 'account', serviceId: service.serviceId, revision: 1, label: '测试账号', credentialRef: null,
    auth: 'none', state: 'ready', createdAt: mcpAt, updatedAt: mcpAt };
  const definition = { name: 'lookup', description: '服务声明为只读的测试工具', inputSchema: { type: 'object' }, outputSchema: null, annotations: { readOnlyHint: true } };
  const tool = { ...definition, toolId: mcpToolId(service.serviceId, definition.name), definitionVersion: mcpFingerprint(definition) };
  const directory = { tools: [tool], resources: [], resourceTemplates: [] };
  const catalog: McpCatalog = { ...directory, catalogId: 'catalog', serviceId: service.serviceId, accountId: account.accountId,
    accountRevision: 1, configVersion: service.configVersion, version: mcpFingerprint(directory), revision: 1, discoveredAt: mcpAt };
  repository.commit('fixture', mcpFingerprint('fixture'), mcpAt, tx => {
    tx.put('service', service, 0); tx.put('account', account, 0); tx.put('catalog', catalog, 0);
  });
  const identity: McpOperationIdentity = {
    serviceId: service.serviceId, serviceRevision: 1, configVersion: service.configVersion, accountId: account.accountId, accountRevision: 1,
    catalogVersion: catalog.version, toolId: tool.toolId, definitionVersion: tool.definitionVersion, sessionId: 'session', commandId: 'command', toolCallId: 'tool-call',
    taskId: null, runId: null, agentId: null, host: 'work', ruleVersions: [],
  };
  return { db, repository, service, account, catalog, tool, identity, close: () => db.close() };
}
