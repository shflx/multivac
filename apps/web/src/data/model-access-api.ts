import { Check } from 'typebox/value';
import {
  ModelAccessErrorSchema, ModelAccessReceiptSchema, ModelAccessSnapshotSchema,
  type ConfigureModelApiKey, type ModelAccessCommand, type ModelAccessErrorCode,
  type ModelAccessReceipt, type ModelAccessSnapshot,
} from '@multivac/contracts';

export const MODEL_ACCESS_MESSAGES: Record<ModelAccessErrorCode, string> = {
  INVALID_REQUEST: '请求无效。', ACCESS_CONFLICT: '状态已更新，请刷新后重新输入并提交。',
  COMMAND_ID_CONFLICT: '该命令 ID 已被使用，请刷新状态。', ACCESS_UNAVAILABLE: '凭据或检查服务暂不可用，请稍后重试。',
  CREDENTIAL_UNSUPPORTED: '此 Provider 的 Pi 认证需要额外字段或使用非 API Key 方式；此页面仅支持单个 API Key 输入。',
  CREDENTIAL_RESULT_UNKNOWN: '凭据写入结果未知；输入已清空，请查询结果，不会自动重发密钥。',
  CHECK_AUTH_MISSING: 'Pi 当前未检测到可用于检查的 API Key 认证。',
  CHECK_MODEL_UNAVAILABLE: 'Pi 当前模型配置不可用于连接检查。', CHECK_FAILED: '连接检查失败。',
  CHECK_TIMEOUT: '连接检查超时。', CHECK_CANCELLED: '连接检查已取消。', CHECK_INVALIDATED: '配置或凭据已变化，旧检查已失效。',
  CHECK_BUSY: '已有连接检查正在执行。', NOT_FOUND: '尚未找到该命令结果，请刷新状态。',
};
export class ModelAccessApiError extends Error {
  constructor(readonly code: ModelAccessErrorCode) { super(MODEL_ACCESS_MESSAGES[code]); }
}
async function accessRequest(path: string, body?: unknown): Promise<unknown> {
  try {
    const response = await fetch(path, {
      ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(25_000),
    });
    const value = await response.json();
    if (!response.ok) throw new ModelAccessApiError(Check(ModelAccessErrorSchema, value) ? value.error.code : 'ACCESS_UNAVAILABLE');
    return value;
  } catch (error) {
    if (error instanceof ModelAccessApiError) throw error;
    throw new ModelAccessApiError(body === undefined ? 'ACCESS_UNAVAILABLE' : 'CREDENTIAL_RESULT_UNKNOWN');
  }
}
async function readModelAccess(): Promise<ModelAccessSnapshot> {
  const value = await accessRequest('/api/model-access');
  if (!Check(ModelAccessSnapshotSchema, value)) throw new ModelAccessApiError('ACCESS_UNAVAILABLE');
  return value;
}
// 全量快照单飞不依赖选中 profile 的组件生命周期，不缓存已完成响应。
let snapshotRequest: Promise<ModelAccessSnapshot> | null = null;
export function getModelAccess(): Promise<ModelAccessSnapshot> {
  if (!snapshotRequest) {
    const request = readModelAccess().finally(() => { if (snapshotRequest === request) snapshotRequest = null; });
    snapshotRequest = request;
  }
  return snapshotRequest;
}
async function receipt(path: string, body?: unknown): Promise<ModelAccessReceipt> {
  const value = await accessRequest(path, body);
  if (!Check(ModelAccessReceiptSchema, value)) throw new ModelAccessApiError('CREDENTIAL_RESULT_UNKNOWN');
  return value;
}
export function configureModelApiKey(command: ConfigureModelApiKey) { return receipt('/api/model-access/api-key', command); }
export function revokeModelApiKey(command: ModelAccessCommand) { return receipt('/api/model-access/revoke-api-key', command); }
export function startModelCheck(command: ModelAccessCommand) { return receipt('/api/model-access/check', command); }
export function getModelAccessReceipt(commandId: string) { return receipt(`/api/model-access/commands/${encodeURIComponent(commandId)}`); }
export async function cancelModelCheck(checkId: string): Promise<ModelAccessSnapshot> {
  const value = await accessRequest('/api/model-access/cancel-check', { checkId });
  if (!Check(ModelAccessSnapshotSchema, value)) throw new ModelAccessApiError('ACCESS_UNAVAILABLE');
  return value;
}
