import type { InboxItem } from '@multivac/contracts';

const labels: Record<string, string> = { read: '读取', 'local-write': '本地写入', 'external-write': '外部副作用', 'data-transfer': '数据传输' };
export function McpRequestEvidence({ request }: { request: NonNullable<InboxItem['mcp']> }) {
  const operation = request.operation;
  const transport = operation.transport.kind === 'stdio'
    ? [operation.transport.command, ...operation.transport.args].map(value => JSON.stringify(value)).join(' ')
    : operation.transport.url;
  return <section className="inbox-evidence"><h3>本次 MCP 调用</h3>
    <dl className="inbox-facts">
      <div><dt>服务与工具</dt><dd>{operation.serviceName} · {operation.toolName}</dd></div>
      <div><dt>来源</dt><dd>{operation.source}</dd></div>
      <div><dt>账号</dt><dd>{operation.accountLabel}</dd></div>
      <div><dt>会话与项目</dt><dd>{request.identity.sessionId} · {request.identity.projectId ?? '无项目'}</dd></div>
      <div><dt>执行目录</dt><dd><code>{request.identity.workingDirectory}</code></dd></div>
      <div><dt>命令或地址</dt><dd><code>{transport}</code></dd></div>
      <div><dt>效果</dt><dd>{request.effects.map(effect => labels[effect] ?? effect).join('、')}</dd></div>
      <div><dt>有效期</dt><dd>{new Date(request.expiresAt).toLocaleString()}</dd></div>
    </dl>
    <h4>固定参数</h4><pre className="inbox-output-preview">{JSON.stringify(request.arguments, null, 2)}</pre>
    <p className="inbox-muted">允许仅适用于这次身份、参数和版本；服务端在执行前再次核对。允许不表示调用已成功。远程工具会接收这些参数。</p>
    <details><summary>固定版本</summary><p>配置：<code>{request.identity.configVersion}</code></p><p>账号版本：{request.identity.accountRevision}</p><p>工具：<code>{request.identity.definitionVersion}</code></p><p>目录：<code>{request.identity.catalogVersion}</code></p></details>
  </section>;
}
