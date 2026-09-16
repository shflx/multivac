import type { APIRequestContext } from '@playwright/test';

export const fakeApiRoot = `http://127.0.0.1:${process.env.MULTIVAC_E2E_API_PORT ?? '4317'}`;

export async function resetE2eState(request: APIRequestContext): Promise<void> {
  const response = await request.post(`${fakeApiRoot}/api/__e2e/reset`);
  if (!response.ok()) {
    throw new Error(`E2E 状态重置失败：${response.status()}`);
  }
}
