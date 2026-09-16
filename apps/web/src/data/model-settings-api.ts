import {
  ModelSettingsApiErrorResponseSchema,
  ModelSettingsSnapshotSchema,
  type ModelSettingsApiErrorCode,
  type ModelSettingsSnapshot,
  type SaveModelSettings,
  type SetDefaultModel,
} from '@multivac/contracts';
import { Check } from 'typebox/value';

export class ModelSettingsApiError extends Error {
  constructor(
    readonly code: ModelSettingsApiErrorCode,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ModelSettingsApiError';
  }
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ModelSettingsApiError(
      response.ok ? 'RESULT_UNKNOWN' : 'INTERNAL_ERROR',
      response.ok
        ? '服务可能已提交命令，但成功响应无法验证；请重试原命令进行对账。'
        : '服务返回了无法解析的错误响应。',
      response.status,
    );
  }
}

async function fetchSnapshot(url: string, init?: RequestInit): Promise<ModelSettingsSnapshot> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new ModelSettingsApiError(
      'MODEL_SETTINGS_UNAVAILABLE',
      '网络请求结果未知；重试将复用原命令 ID。',
      0,
    );
  }
  const body = await responseJson(response);
  if (!response.ok) {
    if (Check(ModelSettingsApiErrorResponseSchema, body)) {
      throw new ModelSettingsApiError(body.error.code, body.error.message, response.status);
    }
    throw new ModelSettingsApiError('INTERNAL_ERROR', '模型设置请求失败。', response.status);
  }
  if (!Check(ModelSettingsSnapshotSchema, body)) {
    throw new ModelSettingsApiError(
      'RESULT_UNKNOWN',
      '服务可能已提交命令，但成功响应不符合契约；请重试原命令进行对账。',
      response.status,
    );
  }
  return body;
}

export function getModelSettings(): Promise<ModelSettingsSnapshot> {
  return fetchSnapshot('/api/model-settings');
}

export function saveModelSettings(command: SaveModelSettings): Promise<ModelSettingsSnapshot> {
  return fetchSnapshot('/api/model-settings/profiles', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(command),
  });
}

export function setDefaultModel(command: SetDefaultModel): Promise<ModelSettingsSnapshot> {
  return fetchSnapshot('/api/model-settings/default', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(command),
  });
}
