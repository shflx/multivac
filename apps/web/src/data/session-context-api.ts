import { Check } from 'typebox/value';
import { SessionContextResponseSchema, ContextCompactionOperationSchema, type CompactSessionContext, type ContextCompactionOperation, type SessionContextResponse } from '@multivac/contracts';
import { assistantApiBase } from './assistant-api.js';

export async function readSessionContext(sessionId: string): Promise<SessionContextResponse> {
  const response = await fetch(`${assistantApiBase(sessionId)}/context`);
  const body: unknown = await response.json();
  if (!response.ok || !Check(SessionContextResponseSchema, body) || body.state.sessionId !== sessionId) throw new Error('上下文状态暂不可读取。');
  return body as SessionContextResponse;
}
export async function readContextOperation(sessionId: string, operationId: string): Promise<ContextCompactionOperation | null> {
  const response = await fetch(`${assistantApiBase(sessionId)}/context/operations/${encodeURIComponent(operationId)}`);
  if (response.status === 404) return null;
  const body: unknown = await response.json();
  if (!response.ok || !Check(ContextCompactionOperationSchema, body) || body.sessionId !== sessionId || body.operationId !== operationId) throw new Error('原压缩操作暂不可核对。');
  return body as ContextCompactionOperation;
}
export async function compactSessionContext(command: CompactSessionContext): Promise<ContextCompactionOperation> {
  const response = await fetch(`${assistantApiBase(command.sessionId)}/context/compact`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(command),
  });
  const body: unknown = await response.json();
  if (!response.ok || !Check(ContextCompactionOperationSchema, body) || body.sessionId !== command.sessionId || body.operationId !== command.operationId) throw new Error('压缩结果未知，请核对原操作。');
  return body as ContextCompactionOperation;
}
