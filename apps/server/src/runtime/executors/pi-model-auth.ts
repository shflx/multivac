import {
  equalModelEndpoints,
  safeModelEndpoint,
  isPiNativeDynamicEndpoint,
} from '../../modules/sessions/model-selection-recovery.js';
import type { CoordinatorModelSource } from '@multivac/contracts';

export interface PiRequestModel {
  provider: string;
  id: string;
  api: string;
  baseUrl: string;
}

export interface PiModelAuthRuntime<TModel extends PiRequestModel> {
  getAuth(model: TModel, options?: { signal?: AbortSignal }): Promise<{
    auth: { baseUrl?: string };
  } | undefined>;
}

export type PiResolvedRequestEndpoint =
  | { mode: 'fixed'; endpoint: string }
  | { mode: 'pi-native-dynamic'; endpoint: null; fallback: string | null };

/** 与 Pi prepareRequest/AgentSession 相同，OAuth auth.baseUrl 优先于模型目录端点。 */
export async function resolvePiRequestEndpoint<TModel extends PiRequestModel>(
  runtime: PiModelAuthRuntime<TModel>,
  model: TModel,
  customEndpoint: string | null = null,
  source: CoordinatorModelSource = 'controlled',
  signal?: AbortSignal,
): Promise<PiResolvedRequestEndpoint | undefined> {
  const deadline = AbortSignal.timeout(5_000);
  const resolution = await runtime.getAuth(model, { signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
  if (!resolution) return undefined;
  const endpoint = resolution.auth.baseUrl || model.baseUrl;
  if (source === 'base' && isPiNativeDynamicEndpoint(model.api)) {
    const fallback = endpoint || null;
    if (customEndpoint !== null || (fallback !== null && !safeModelEndpoint(fallback))) {
      throw new Error('Azure 基础配置只能保存安全 fallback，不能保证受控显式端点。');
    }
    // Azure SDK 始终优先读取环境；目录或 auth.baseUrl 只是请求阶段的 fallback。
    return { mode: 'pi-native-dynamic', endpoint: null, fallback };
  }
  if (!safeModelEndpoint(endpoint) || (customEndpoint !== null && (
    !safeModelEndpoint(customEndpoint) || !equalModelEndpoints(customEndpoint, endpoint)
  ))) {
    throw new Error('Pi 认证解析后的端点不安全或无法保证自定义端点生效。');
  }
  return { mode: 'fixed', endpoint };
}
