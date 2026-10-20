import { useState } from 'react';
import type { McpTransport } from '@multivac/contracts';

/** 把传输配置读成“标签 · 值”的事实卡片；原始 JSON 收在折叠项里供核对。 */
export function McpTransportFacts({ transport, source }: { transport: McpTransport; source?: string }) {
  const [raw, setRaw] = useState(false);
  const facts: [string, string][] = transport.kind === 'stdio'
    ? [
        ['命令', transport.command],
        ['参数', transport.args.length ? transport.args.join(' ') : '无'],
        ['工作目录', transport.cwd ?? '使用会话目录'],
        ['私有环境变量', transport.environmentKeys.length ? transport.environmentKeys.join('、') : '无'],
      ]
    : [['地址', transport.url]];

  return <div className="mcp-transport">
    <dl className="mcp-facts">
      {source !== undefined && <div><dt>来源</dt><dd>{source}</dd></div>}
      {facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd><code>{value}</code></dd></div>)}
    </dl>
    <button type="button" className="inline-link mcp-raw-toggle" aria-expanded={raw} onClick={() => setRaw(value => !value)}>{raw ? '收起原始配置' : '查看原始配置'}</button>
    {raw && <pre className="mcp-json">{JSON.stringify(transport, null, 2)}</pre>}
  </div>;
}
