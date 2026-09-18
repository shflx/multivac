import { expect, test } from '@playwright/test';
import { fakeApiRoot, resetE2eState } from './test-state.js';

test.beforeEach(async ({ request }) => {
  await resetE2eState(request);
});

async function openModels(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: '打开管理模式' }).click();
}

test('模型页支持列表、编辑放弃、保存、添加、设默认和未保存离开确认', async ({ page }) => {
  await openModels(page);

  await expect(page.getByRole('heading', { name: '模型', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'GPT Fixture' })).toBeVisible();
  await expect(page.locator('.model-list-items').getByText('Claude Fixture', { exact: true })).toBeVisible();
  await expect(page.locator('.model-list-items').getByText('未认证 Fixture', { exact: true })).toBeVisible();
  await expect(page.getByText('已认证且可用')).toBeVisible();
  await expect(page.getByText('Pi 报告的能力')).toHaveCount(0);
  await expect(page.locator('.model-capabilities')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '当前默认' })).toBeDisabled();

  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('显示名称').fill('不应保存的名称');
  await page.getByRole('button', { name: '放弃' }).click();
  await expect(page.getByRole('heading', { name: 'GPT Fixture' })).toBeVisible();
  await expect(page.getByText('不应保存的名称')).toHaveCount(0);

  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('显示名称').fill('GPT Fixture 已编辑');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByRole('heading', { name: 'GPT Fixture 已编辑' })).toBeVisible();

  await page.getByRole('button', { name: '添加模型配置' }).click();
  await page.getByLabel('配置 ID').fill('fixture-added');
  await page.getByLabel('显示名称').fill('新增兼容模型');
  await page.getByLabel('Provider').fill('fixture-added');
  await page.getByLabel('模型 ID').fill('fixture-model');
  await page.getByLabel('协议').selectOption('openai-completions');
  await page.getByLabel('端点').fill('https://added.fixture.example/v1');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByRole('heading', { name: '新增兼容模型' })).toBeVisible();
  await expect(page.getByText('4', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: /Claude Fixture/ }).click();
  await page.getByRole('button', { name: '设为默认' }).click();
  await expect(page.getByRole('button', { name: '当前默认' })).toBeDisabled();

  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('显示名称').fill('尚未保存的 Claude');
  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('未保存');
    await dialog.dismiss();
  });
  await page.getByRole('button', { name: '返回工作模式' }).first().click();
  await expect(page.locator('.app-shell')).toHaveClass(/management-mode/);
  await expect(page.getByLabel('显示名称')).toHaveValue('尚未保存的 Claude');

  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('未保存');
    await dialog.accept();
  });
  await page.getByRole('button', { name: '返回工作模式' }).first().click();
  await expect(page.locator('.app-shell')).toHaveClass(/work-mode/);
  await page.getByRole('button', { name: '打开管理模式' }).click();
  await expect(page.getByRole('heading', { name: 'Claude Fixture' })).toBeVisible();
  await expect(page.getByLabel('显示名称')).toHaveCount(0);
});

test('保存和设默认期间冻结编辑导航，旧响应不能清除新的编辑现场', async ({ page }) => {
  await openModels(page);
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('显示名称').fill('延迟保存后的名称');

  let releaseSave!: () => void;
  let markSaveStarted!: () => void;
  const saveStarted = new Promise<void>((resolve) => { markSaveStarted = resolve; });
  const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
  await page.route('**/api/model-settings/profiles', async (route) => {
    markSaveStarted();
    await saveGate;
    await route.continue();
  });
  await page.getByRole('button', { name: '保存' }).click();
  await saveStarted;
  await expect(page.getByLabel('显示名称')).toBeDisabled();
  await expect(page.getByRole('button', { name: '添加模型配置' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '返回工作模式' }).first()).toBeDisabled();
  releaseSave();
  await expect(page.getByRole('heading', { name: '延迟保存后的名称' })).toBeVisible();

  await page.getByRole('button', { name: /Claude Fixture/ }).click();
  let releaseDefault!: () => void;
  let markDefaultStarted!: () => void;
  const defaultStarted = new Promise<void>((resolve) => { markDefaultStarted = resolve; });
  const defaultGate = new Promise<void>((resolve) => { releaseDefault = resolve; });
  await page.route('**/api/model-settings/default', async (route) => {
    markDefaultStarted();
    await defaultGate;
    await route.continue();
  });
  await page.getByRole('button', { name: '设为默认' }).click();
  await defaultStarted;
  await expect(page.getByRole('button', { name: '编辑', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '添加模型配置' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '返回工作模式' }).first()).toBeDisabled();
  releaseDefault();
  await expect(page.getByRole('button', { name: '当前默认' })).toBeDisabled();
});

test('网络未知结果重试复用原 commandId 和提交基线', async ({ page }) => {
  const bodies: Array<{ commandId: string; revision: number; profile: { displayName: string } }> = [];
  let attempt = 0;
  await page.route('**/api/model-settings/profiles', async (route) => {
    attempt += 1;
    bodies.push(route.request().postDataJSON() as typeof bodies[number]);
    if (attempt === 1) return route.abort('connectionfailed');
    await route.continue();
  });
  await openModels(page);
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('显示名称').fill('网络未知后重试');
  await page.getByRole('button', { name: '保存' }).click();

  await expect(page.getByRole('button', { name: '重试原命令' })).toBeVisible();
  await expect(page.getByLabel('显示名称')).toBeDisabled();
  await expect(page.getByRole('button', { name: '返回工作模式' }).first()).toBeEnabled();
  await page.getByRole('button', { name: '返回工作模式' }).first().click();
  await expect(page.locator('.app-shell')).toHaveClass(/work-mode/);
  await page.getByRole('button', { name: '打开管理模式' }).click();
  await expect(page.getByLabel('显示名称')).toHaveValue('网络未知后重试');
  await expect(page.getByLabel('显示名称')).toBeDisabled();
  await expect(page.getByRole('button', { name: '重新加载确认结果' })).toBeVisible();
  await page.getByRole('button', { name: '重试原命令' }).click();
  await expect(page.getByRole('heading', { name: '网络未知后重试' })).toBeVisible();
  expect(bodies).toHaveLength(2);
  expect(bodies[1]?.commandId).toBe(bodies[0]?.commandId);
  expect(bodies[1]?.revision).toBe(bodies[0]?.revision);
  expect(bodies[1]?.profile.displayName).toBe(bodies[0]?.profile.displayName);
});

test('服务端已提交但成功响应 body stream 读取失败时标记结果未知并复用原命令对账', async ({ page }) => {
  const bodies: Array<{ commandId: string; revision: number; profile: { displayName: string } }> = [];
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    let rejected = false;
    window.fetch = async (input, init) => {
      const response = await originalFetch(input, init);
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!rejected && init?.method === 'POST' && url.endsWith('/api/model-settings/profiles')) {
        rejected = true;
        return new Proxy(response, {
          get(target, property) {
            if (property === 'json') {
              return async () => {
                const reader = target.body?.getReader();
                await reader?.read();
                await reader?.cancel();
                throw new TypeError('simulated response body stream failure');
              };
            }
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      }
      return response;
    };
  });
  await page.route('**/api/model-settings/profiles', async (route) => {
    bodies.push(route.request().postDataJSON() as typeof bodies[number]);
    await route.continue();
  });
  await openModels(page);
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('显示名称').fill('响应丢失但已提交');
  await page.getByRole('button', { name: '保存' }).click();

  await expect(page.getByText(/成功响应无法验证/)).toBeVisible();
  await expect(page.getByRole('button', { name: '重试原命令' })).toBeVisible();
  await page.getByRole('button', { name: '重试原命令' }).click();
  await expect(page.getByRole('heading', { name: '响应丢失但已提交' })).toBeVisible();
  expect(bodies).toHaveLength(2);
  expect(bodies[1]?.commandId).toBe(bodies[0]?.commandId);
  expect(bodies[1]?.revision).toBe(bodies[0]?.revision);
  expect(bodies[1]?.profile.displayName).toBe(bodies[0]?.profile.displayName);
});

test('revision 冲突可重新加载最新快照并保留当前草稿', async ({ page, request }) => {
  const browserCommandIds: string[] = [];
  await page.route('**/api/model-settings/profiles', async (route) => {
    browserCommandIds.push((route.request().postDataJSON() as { commandId: string }).commandId);
    await route.continue();
  });
  await openModels(page);
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('显示名称').fill('冲突后保留的草稿');

  const current = await request.get(`${fakeApiRoot}/api/model-settings`);
  const snapshot = await current.json() as {
    revision: number;
    profiles: Array<{
      profileId: string;
      displayName: string;
      provider: string;
      modelId: string;
      protocol: string;
      endpoint: string | null;
    }>;
  };
  const claude = snapshot.profiles.find((profile) => profile.profileId === 'fixture-anthropic')!;
  const external = await request.post(`${fakeApiRoot}/api/model-settings/profiles`, {
    data: {
      commandId: 'external:revision-bump',
      revision: snapshot.revision,
      profile: {
        profileId: claude.profileId,
        displayName: '外部页面更新',
        provider: claude.provider,
        modelId: claude.modelId,
        protocol: claude.protocol,
        endpoint: claude.endpoint,
      },
    },
  });
  expect(external.ok()).toBe(true);

  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByRole('button', { name: '重新加载并保留草稿' })).toBeVisible();
  await expect(page.getByLabel('显示名称')).toHaveValue('冲突后保留的草稿');
  await page.getByRole('button', { name: '重新加载并保留草稿' }).click();
  await expect(page.getByLabel('显示名称')).toHaveValue('冲突后保留的草稿');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByRole('heading', { name: '冲突后保留的草稿' })).toBeVisible();
  expect(browserCommandIds).toHaveLength(2);
  expect(browserCommandIds[1]).not.toBe(browserCommandIds[0]);
});

test('模型页展示加载状态', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/model-settings', async (route) => {
    await gate;
    await route.continue();
  });
  await page.goto('/');
  await page.getByRole('button', { name: '打开管理模式' }).click();
  await expect(page.getByText('正在加载模型设置')).toBeVisible();
  release();
  await expect(page.getByRole('heading', { name: 'GPT Fixture' })).toBeVisible();
});

test('模型页展示空配置状态', async ({ page }) => {
  await page.route('**/api/model-settings', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ revision: 0, profiles: [], defaultProfileId: null, availability: [] }),
  }));
  await openModels(page);
  await expect(page.getByText('暂无模型配置')).toBeVisible();
  await expect(page.getByRole('button', { name: '添加模型', exact: true })).toBeVisible();
});

test('模型页加载错误可原位重试', async ({ page }) => {
  let attempts = 0;
  let allowSuccess = false;
  await page.route('**/api/model-settings', async (route) => {
    attempts += 1;
    if (!allowSuccess) {
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'MODEL_SETTINGS_UNAVAILABLE', message: '测试模型设置暂不可用。' },
        }),
      });
    }
    await route.continue();
  });
  await openModels(page);
  await expect(page.getByText('模型设置加载失败')).toBeVisible();
  await expect(page.getByText('测试模型设置暂不可用。')).toBeVisible();
  allowSuccess = true;
  await page.getByRole('button', { name: '重新加载' }).click();
  await expect(page.getByRole('heading', { name: 'GPT Fixture' })).toBeVisible();
  expect(attempts).toBeGreaterThanOrEqual(2);
});
