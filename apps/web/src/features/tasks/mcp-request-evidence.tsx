import type { InboxItem, McpEffect } from '@multivac/contracts';

const labels: Record<string, string> = { read: '读取', 'local-write': '本地写入', 'external-write': '外部副作用', 'data-transfer': '数据传输' };
const EFFECT_OPTIONS: { value: McpEffect; label: string; hint: string }[] = [
  { value: 'read', label: '读取', hint: '只读取信息，如搜索、查看页面' },
  { value: 'local-write', label: '本地写入', hint: '修改本机文件' },
  { value: 'external-write', label: '外部副作用', hint: '改动外部系统，如提交表单、创建条目' },
  { value: 'data-transfer', label: '数据传输', hint: '把本地内容发送到外部' },
];

/**
 * MCP 调用许可的证据。effects 只在首次调用时传入：用户按工具实际行为确认效果，
 * 预选来自服务注解，仅作提示；确认后作为该工具版本的分类保存，之后不再询问。
 */
export function McpRequestEvidence({ request, effects, onEffects, disabled }: { request: NonNullable<InboxItem['mcp']>; effects?: McpEffect[]; onEffects?: (value: McpEffect[]) => void; disabled?: boolean }) {
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
      <div><dt>效果</dt><dd>{request.effects.length ? request.effects.map(effect => labels[effect] ?? effect).join('、') : '首次调用，请在下方确认'}</dd></div>
      <div><dt>有效期</dt><dd>{new Date(request.expiresAt).toLocaleString()}</dd></div>
    </dl>
    {effects && onEffects && <fieldset className="inbox-mcp-effects" disabled={disabled}>
      <legend>这个工具会做什么？</legend>
      <p className="inbox-muted">首次调用需要确认。选择会作为这个工具的分类保存，之后调用不再询问；工具定义变化时会重新确认。{request.suggestedEffects?.length ? '已按服务声明预选，请核对。' : ''}</p>
      <div className="inbox-mcp-effect-options">{EFFECT_OPTIONS.map(option => <label key={option.value} className={effects.includes(option.value) ? 'checked' : ''} title={option.hint}>
        <input type="checkbox" checked={effects.includes(option.value)} onChange={event => onEffects(event.target.checked ? [...effects, option.value] : effects.filter(value => value !== option.value))} />{option.label}
      </label>)}</div>
    </fieldset>}
    <h4>固定参数</h4><pre className="inbox-output-preview">{JSON.stringify(request.arguments, null, 2)}</pre>
    <p className="inbox-muted">允许仅适用于这次身份、参数和版本；服务端在执行前再次核对。允许不表示调用已成功。远程工具会接收这些参数。</p>
    <details><summary>固定版本</summary><p>配置：<code>{request.identity.configVersion}</code></p><p>账号版本：{request.identity.accountRevision}</p><p>工具：<code>{request.identity.definitionVersion}</code></p><p>目录：<code>{request.identity.catalogVersion}</code></p></details>
  </section>;
}
