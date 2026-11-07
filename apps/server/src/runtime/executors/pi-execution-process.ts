import type { SubagentProcessEntry } from '@multivac/contracts';
import { isObject } from '../../modules/usage/model-usage.js';

/** 保留消息顺序及工具正文，跳过执行器配置和凭据；只用于独立子级的本机过程读取。 */
export function piExecutionProcess(branch: readonly unknown[]): SubagentProcessEntry[] {
  const result: SubagentProcessEntry[] = [];
  for (const entry of branch) {
    if (!isObject(entry) || entry.type !== 'message' || !isObject(entry.message)) continue;
    const message = entry.message;
    const parts = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : Array.isArray(message.content) ? message.content : [];
    for (const [index, part] of parts.entries()) {
      if (!isObject(part)) continue;
      const id = `${String(entry.id)}:${index}`;
      if (part.type === 'toolCall') {
        result.push({ id, role: 'tool', toolName: String(part.name), toolCallId: String(part.id), phase: 'input', text: JSON.stringify(part.arguments, null, 2) ?? '' });
      } else if (part.type === 'thinking' && typeof part.thinking === 'string') {
        result.push({ id, role: 'thinking', text: part.thinking });
      } else if (part.type === 'text' && typeof part.text === 'string') {
        if (message.role === 'toolResult') result.push({ id, role: 'tool', text: part.text, toolName: String(message.toolName), toolCallId: String(message.toolCallId), phase: 'output' });
        else if (message.role === 'user' || message.role === 'assistant') result.push({ id, role: message.role, text: part.text });
      }
    }
  }
  return result;
}
