import {
  SessionModelOptionsSchema, SessionModelCommandResultSchema,
  type SessionModelOptions, type SessionModelCommandResult, type SetSessionModel, type SetSessionThinkingLevel,
} from '@multivac/contracts';
import { Check } from 'typebox/value';

async function read<T>(path: string, schema: object, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/assistant/model-selection${path}`, init);
  const body: unknown = await response.json();
  // 失败命令仍携带实际 Pi 选择，不能因 HTTP 409/503 丢弃对账结果。
  if (!Check(schema, body)) throw new Error('会话模型状态暂时无法读取，请稍后重试。');
  return body as T;
}
export function getSessionModelOptions(): Promise<SessionModelOptions> { return read('', SessionModelOptionsSchema); }
export function getSessionModelCommand(id: string): Promise<SessionModelCommandResult> {
  return read(`/commands/${encodeURIComponent(id)}`, SessionModelCommandResultSchema);
}
export function setSessionModel(command: SetSessionModel | SetSessionThinkingLevel): Promise<SessionModelCommandResult> {
  return read('profileId' in command ? '/model' : '/thinking', SessionModelCommandResultSchema, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(command),
  });
}
