import {
  SessionModelOptionsSchema, SessionModelCommandResultSchema,
  type SessionModelOptions, type SessionModelCommandResult, type SetSessionModel, type SetSessionThinkingLevel,
} from '@multivac/contracts';
import { Check } from 'typebox/value';
import { assistantApiBase } from './assistant-api.js';

async function read<T>(sessionId: string, path: string, schema: object, init?: RequestInit): Promise<T> {
  const response = await fetch(`${assistantApiBase(sessionId)}/model-selection${path}`, init);
  const body: unknown = await response.json();
  // 失败命令仍携带实际 Pi 选择，不能因 HTTP 409/503 丢弃对账结果。
  if (!Check(schema, body)) throw new Error('会话模型状态暂时无法读取，请稍后重试。');
  return body as T;
}
export function getSessionModelOptions(sessionId: string): Promise<SessionModelOptions> {
  return read(sessionId, '', SessionModelOptionsSchema);
}
export function getSessionModelCommand(sessionId: string, id: string): Promise<SessionModelCommandResult> {
  return read(sessionId, `/commands/${encodeURIComponent(id)}`, SessionModelCommandResultSchema);
}
export function setSessionModel(command: SetSessionModel | SetSessionThinkingLevel): Promise<SessionModelCommandResult> {
  return read(command.sessionId, 'profileId' in command ? '/model' : '/thinking', SessionModelCommandResultSchema, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(command),
  });
}
