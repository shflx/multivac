import { ModelRuntime, type CreateModelRuntimeOptions } from '@earendil-works/pi-coding-agent';
import { azureProvider } from '@earendil-works/pi-ai/providers/azure';

const LEGACY_AZURE_PROVIDER = 'azure-openai-responses';

export async function createPiModelRuntime(options: CreateModelRuntimeOptions): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create(options);
  const azure = azureProvider();
  // 旧会话和凭据按 provider ID 绑定。沿用旧 ID、认证和动态端点解析。
  const getModels = () => azure.getModels().filter(model => model.api === LEGACY_AZURE_PROVIDER)
    .map(model => ({ ...model, provider: LEGACY_AZURE_PROVIDER }));
  runtime.registerNativeProvider({ ...azure, id: LEGACY_AZURE_PROVIDER, getModels, getAllModels: getModels });
  await runtime.refresh({ providers: [LEGACY_AZURE_PROVIDER], allowNetwork: false,
    ...(options.signal ? { signal: options.signal } : {}) });
  return runtime;
}
