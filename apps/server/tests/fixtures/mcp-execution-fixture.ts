import type { McpExecutionHost } from '../../src/application/mcp-execution-service.js';
import { McpExecutionService } from '../../src/application/mcp-execution-service.js';
import { McpConnections } from '../../src/modules/mcp/connections.js';
import type { McpMessage, McpWire } from '../../src/modules/mcp/client.js';
import { mcpFixture } from './mcp-fixture.js';

export async function mcpExecutionFixture() {
  const f = mcpFixture(), sent: McpMessage[] = [], state = { hang: false, changed: false, opened: 0, directory: '/workspace' };
  const context: ReturnType<McpExecutionHost['context']> = { sessionId: 'session', projectId: null, agentId: null, taskId: null, runId: null,
    host: 'work', hostEffects: ['read', 'local-write', 'external-write', 'data-transfer'], transportAllowed: true, accountId: null, workingDirectory: '/workspace' };
  const leases: string[] = [];
  const host: McpExecutionHost = { context: id => ({ ...context, sessionId: id, workingDirectory: state.directory }), transport: () => true,
    lease(_id, phase) { leases.push(phase); return 2_000_000; }, async redactor() { return text => text.replaceAll('fixture-secret', '[已隐藏]'); } };
  const connections = new McpConnections(f.repository, { async open() {
    state.opened++; let receive: (message: McpMessage) => void, disconnected: () => void;
    const wire: McpWire = {
      async start(data, exit) { receive = data; disconnected = exit; },
      async send(message) {
        sent.push(message);
        if (message.id === undefined || state.hang && message.method === 'tools/call') return;
        const { toolId: _id, definitionVersion: _version, ...tool } = f.tool;
        const result = message.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} } }
          : message.method === 'tools/list' ? { tools: [{ ...tool, description: state.changed ? '新定义' : tool.description }] }
          : { content: [{ type: 'text', text: '实际结果 fixture-secret' }] };
        queueMicrotask(() => receive({ jsonrpc: '2.0', id: message.id, result }));
      }, async close() { disconnected(); },
    };
    return wire;
  } });
  const mcp = new McpExecutionService(f.repository, connections, host);
  const live = await connections.connect('service', 'account', { sessionId: 'session', host: 'work' });
  const classify = () => mcp.authorizations.confirmClassification('user-classification', mcp.userIdentity('session', live.connection.connectionId, f.tool.toolId), ['read']);
  return { ...f, mcp, host, connections, live, classify, sent, state, context, leases, async dispose() { await mcp.close(); f.close(); } };
}
export async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise<void>(resolve => setImmediate(resolve)); }
  throw new Error('等待条件未满足');
}
