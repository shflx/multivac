import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import type { McpManagementDetail } from '@multivac/contracts';
import { McpToolRow } from '../../web/src/features/mcp/mcp-detail.js';
import { mcpExecutionFixture } from './fixtures/mcp-execution-fixture.js';
import { mcpFingerprint } from '../src/modules/mcp/mcp.js';

test('MCP 工具分类视图不会将旧账号分类显示为当前确认；生成实际组件的静态渲染证据', async () => {
  const f = await mcpExecutionFixture();
  try {
    const { toolId, definitionVersion: _oldVersion, ...definition } = f.live.catalog.tools[0]!;
    const raw = { ...definition, description: '<script>不能执行的服务内容</script>' };
    const tool = { ...raw, toolId, definitionVersion: mcpFingerprint(raw) };
    const directory = { tools: [tool], resources: [], resourceTemplates: [] };
    const catalog = { ...f.live.catalog, ...directory, version: mcpFingerprint(directory) };
    const classification = { ...f.classify(), catalogVersion: catalog.version, definitionVersion: tool.definitionVersion };
    const detail: McpManagementDetail = { service: f.service, accounts: [f.account], catalogs: [{ catalog, current: true }], connections: [{ connection: f.live.connection, usable: true }], rules: [], classifications: [classification], calls: [] };
    const render = (value: McpManagementDetail) => renderToStaticMarkup(<McpToolRow detail={value} catalogId={catalog.catalogId} toolId={f.tool.toolId} connectionId={f.live.connection.connectionId} sessionId="session" disabled={false} run={async () => {}} />);
    const current = render(detail), stale = render({ ...detail, accounts: [{ ...f.account, revision: 2 }] });
    assert.match(current, /已确认分类/u);
    assert.match(stale, /待确认分类/u); assert.match(stale, /版本已变化，不适用/u);
    assert.equal(current.includes('<script>'), false); assert.match(current, /&lt;script&gt;/u);
    const css = readFileSync('apps/web/src/styles/base.css', 'utf8') + readFileSync('apps/web/src/features/mcp/mcp.css', 'utf8');
    writeFileSync('artifacts/mcp/ui-static.html', `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MCP 工具分类静态渲染证据</title><style>${css}</style><body><main class="mcp-page" style="max-width:900px;margin:24px"><h1>MCP 工具分类静态渲染证据</h1><p>由实际 React 组件生成。可展开工具查看资料。此证据未覆盖浏览器布局、键盘、登录或网络交互。</p><section class="mcp-detail"><h2>当前账号与分类</h2>${current}<h2>账号版本改变后的同一分类</h2>${stale}</section></main></body></html>`);
  } finally { await f.dispose(); }
});
