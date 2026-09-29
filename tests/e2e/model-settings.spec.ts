import { expect, test } from '@playwright/test';
import { escapeFromManagement, fakeApiRoot, openModelSettings, openPanel, resetE2eState } from './test-state.js';

test.beforeEach(async ({ request }) => {
  await resetE2eState(request);
});

async function openModels(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await openModelSettings(page);
}

test('模型页支持列表、编辑放弃、保存、添加、设默认和未保存离开确认', async ({ page }) => {
  await openModels(page);

  await expect(page.getByRole('heading', { name: '模型', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'GPT Fixture' })).toBeVisible();
  await expect(page.locator('.model-list-items').getByText('Claude Fixture', { exact: true })).toBeVisible();
  await expect(page.locator('.model-list-items').getByText('未认证 Fixture', { exact: true })).toBeVisible();
  await expect(page.locator('.model-availability')).toHaveText('可用');
  await expect(page.getByText('Pi 报告的能力')).toHaveCount(0);
  await expect(page.locator('.model-capabilities')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '当前默认' })).toBeDisabled();

  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('显示名称').fill('不应保存的名称');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'GPT Fixture' })).toBeVisible();
  await expect(page.getByText('不应保存的名称')).toHaveCount(0);

  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('显示名称').fill('GPT Fixture 已编辑');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByRole('heading', { name: 'GPT Fixture 已编辑' })).toBeVisible();

  await page.getByRole('button', { name: '添加模型', exact: true }).click();
  await page.getByLabel('配置 ID').fill('fixture-added');
  await page.getByLabel('显示名称').fill('新增兼容模型');
  await page.getByLabel('提供方').fill('fixture-added');
  await page.getByLabel('模型 ID').fill('fixture-model');
  await page.getByLabel('协议').selectOption('openai-completions');
  await page.getByLabel('API 端点').fill('https://added.fixture.example/v1');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByRole('heading', { name: '新增兼容模型' })).toBeVisible();
  await expect(page.locator('.model-list-heading')).toHaveText('模型配置 · 3/4 可用');

  await page.getByRole('button', { name: /Claude Fixture/ }).click();
  await page.getByRole('button', { name: '设为默认' }).click();
  await expect(page.getByRole('button', { name: '当前默认' })).toBeDisabled();

  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('显示名称').fill('尚未保存的 Claude');
  // 按 Esc 离开前经确认卡确认：继续编辑时留在管理，草稿不变。
  const leaveCard = page.getByRole('dialog', { name: '放弃未保存的更改？' });
  await escapeFromManagement(page);
  await expect(leaveCard).toContainText('未保存');
  await leaveCard.getByRole('button', { name: '继续编辑' }).click();
  await expect(leaveCard).toHaveCount(0);
  await expect(page.locator('.app-shell')).toHaveClass(/management-mode/);
  await expect(page.getByLabel('显示名称')).toHaveValue('尚未保存的 Claude');

  // 放弃后离开，草稿被丢弃。
  await escapeFromManagement(page);
  await leaveCard.getByRole('button', { name: '放弃并离开' }).click();
  await expect(leaveCard).toHaveCount(0);
  await expect(page.locator('.app-shell')).toHaveClass(/work-mode/);
  await openPanel(page, 'management');
  await expect(page.getByRole('heading', { name: 'Claude Fixture' })).toBeVisible();
  await expect(page.getByLabel('显示名称')).toHaveCount(0);
});

test('模型页的放弃确认：默认聚焦“继续编辑”，Esc 只关闭确认卡，不收起侧栏也不离开管理', async ({ page }) => {
  const nativeDialogs: string[] = [];
  page.on('dialog', (dialog) => {
    nativeDialogs.push(dialog.message());
    void dialog.dismiss();
  });
  await openModels(page);
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('显示名称').fill('尚未保存的名称');
  await page.keyboard.press('ControlOrMeta+J');
  const sidebar = page.locator('.multivac-sidebar');
  await expect(sidebar).toBeVisible();

  const leave = page.locator('.logo-area');
  await leave.click();
  const card = page.getByRole('dialog', { name: '放弃未保存的更改？' });
  await expect(card).toHaveAccessibleDescription('当前模型配置有未保存的更改，离开后这些更改会丢失。');
  const keepEditing = card.getByRole('button', { name: '继续编辑' });
  const discard = card.getByRole('button', { name: '放弃并离开' });

  // 会丢失更改：焦点默认在“继续编辑”上，Tab 在卡内循环。
  await expect(keepEditing).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(discard).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(keepEditing).toBeFocused();

  // Esc 只关闭确认卡：侧栏仍展开，仍在管理中，草稿不变，焦点回到 Logo。
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
  await expect(sidebar).toBeVisible();
  await expect(page.locator('.app-shell')).toHaveClass(/management-mode/);
  await expect(page.getByLabel('显示名称')).toHaveValue('尚未保存的名称');
  await expect(leave).toBeFocused();

  // 焦点在“继续编辑”上时，Enter 按下的是继续编辑，不会误放弃。
  await page.keyboard.press('Enter');
  await expect(keepEditing).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(card).toHaveCount(0);
  await expect(page.locator('.app-shell')).toHaveClass(/management-mode/);
  await expect(page.getByLabel('显示名称')).toHaveValue('尚未保存的名称');

  // 没有确认卡时，Esc 照常先收起侧栏。
  await page.keyboard.press('Escape');
  await expect(sidebar).toBeHidden();

  // 切换到别的配置同样先确认：继续编辑时留在原配置，放弃后才切换。
  await page.getByRole('button', { name: /Claude Fixture/ }).click();
  await card.getByRole('button', { name: '继续编辑' }).click();
  await expect(page.getByLabel('显示名称')).toHaveValue('尚未保存的名称');
  await page.getByRole('button', { name: /Claude Fixture/ }).click();
  await card.getByRole('button', { name: '放弃更改' }).click();
  await expect(card).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Claude Fixture' })).toBeVisible();
  await expect(page.getByLabel('显示名称')).toHaveCount(0);
  expect(nativeDialogs).toEqual([]);
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
  await expect(page.getByRole('button', { name: '添加模型', exact: true })).toBeDisabled();
  // 保存进行中不能离开管理：Logo 不可用，Esc 也不离开。
  await expect(page.getByRole('button', { name: '回到 Multivac', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.locator('.app-shell')).toHaveClass(/management-mode/);
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
  await expect(page.getByRole('button', { name: '添加模型', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '回到 Multivac', exact: true })).toBeDisabled();
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
  await expect(page.getByRole('button', { name: '回到 Multivac', exact: true })).toBeEnabled();
  await escapeFromManagement(page);
  await expect(page.locator('.app-shell')).toHaveClass(/work-mode/);
  await openPanel(page, 'management');
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
  await openModelSettings(page);
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
  await expect(page.locator('.model-list-heading')).toHaveText('模型配置 · 0/0 可用');
  // 页头的“添加模型”之外，列表为空时列表里也有一个。
  await expect(page.locator('.management-page-actions').getByRole('button', { name: '添加模型', exact: true })).toBeVisible();
  await expect(page.locator('.model-empty-list').getByRole('button', { name: '添加模型', exact: true })).toBeVisible();
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

test('模型页按原型排版：页头添加、列表的“默认”标签与不可用原因、详情头与“配置”小节，默认模型失效的提示在页面顶部', async ({ page, request }) => {
  await openModels(page);
  const main = page.getByRole('main', { name: '模型' });

  // “添加模型”在页头操作位（次要按钮，36px），列表头只有一行小字。
  const add = main.locator('.management-page-actions').getByRole('button', { name: '添加模型', exact: true });
  await expect(add).toHaveClass(/secondary-button/);
  expect(Math.round((await add.boundingBox())!.height)).toBe(36);
  await expect(page.getByRole('button', { name: '添加模型配置' })).toHaveCount(0);
  await expect(page.locator('.model-list-heading')).toHaveText('模型配置 · 2/3 可用');
  await expect(page.locator('.model-list-heading')).toHaveCSS('font-size', '11px');

  // 列表行：默认模型是文字标签（没有星标），每行右侧有箭头，不可用时附一句原因。
  const rows = page.locator('.model-list-items > button');
  const gpt = rows.filter({ hasText: 'GPT Fixture' });
  await expect(gpt.locator('.model-default-tag')).toHaveText('默认');
  await expect(gpt.locator('.model-default-tag')).not.toHaveClass(/unavailable/);
  await expect(gpt.locator('small')).toHaveText('fixture / gpt-fixture');
  await expect(page.locator('.default-star, [aria-label="全局默认"]')).toHaveCount(0);
  await expect(rows.locator('svg.lucide-chevron-right')).toHaveCount(3);
  await expect(rows.filter({ hasText: '未认证 Fixture' }).locator('small')).toHaveText('missing-auth / missing-auth-model · 未认证');
  await expect(rows.filter({ hasText: '未认证 Fixture' }).locator('.model-default-tag')).toHaveCount(0);

  // 详情头：状态小标签 + 名称 + 说明（原来的状态横幅并入这里）；“编辑”“当前默认”都是次要按钮。
  const heading = page.locator('.model-detail-heading');
  await expect(heading.locator('.model-availability')).toHaveText('可用');
  await expect(heading.getByRole('heading', { name: 'GPT Fixture', level: 2 })).toHaveCSS('font-size', '22px');
  await expect(heading.locator('p')).toHaveText('Pi 当前已确认该模型具备有效认证并可用。');
  await expect(heading.getByRole('button', { name: '编辑', exact: true })).toHaveClass(/secondary-button/);
  await expect(heading.getByRole('button', { name: '当前默认' })).toHaveClass(/secondary-button/);
  await expect(heading.locator('.primary-button')).toHaveCount(0);

  // “配置”小节：单列 dl，协议写名称；配置 ID 与认证类型以小字放在下方。
  const config = page.locator('.model-section').filter({ has: page.getByRole('heading', { name: '配置', exact: true }) });
  await expect(config.locator('.model-metadata dt')).toHaveText(['提供方', '协议', '模型 ID', 'API 端点', '推理能力']);
  await expect(config.locator('.model-metadata dd')).toHaveText(['fixture', 'OpenAI Responses', 'gpt-fixture', 'https://fixture.example/v1', '支持（Pi 目录）']);
  await expect(config.locator('.model-technical dt')).toHaveText(['配置 ID', '认证类型']);
  await expect(config.locator('.model-technical dd')).toHaveText(['fixture-openai', 'API Key']);
  await expect(config.locator('.model-technical')).toHaveCSS('font-size', '11px');
  await expect(page.getByRole('heading', { level: 3 })).toHaveText(['配置', 'API Key', '连接检查']);

  // 不可用的模型：标签与说明写原因，只有可用的模型才能设为默认。
  await rows.filter({ hasText: '未认证 Fixture' }).click();
  await expect(heading.locator('.model-availability')).toHaveText('未认证');
  await expect(heading.locator('p')).toHaveText('Pi 当前未检测到有效认证。');
  await expect(heading.getByRole('button', { name: '设为默认' })).toBeDisabled();
  await expect(heading.getByRole('button', { name: '设为默认' })).toHaveAttribute('title', '只有可用的模型才能设为默认');
  await expect(page.locator('.model-default-warning')).toHaveCount(0);

  // 默认模型失效（改成未认证的提供方）：提示在页头下方、列表之上，选中其他模型时也看得到；“默认”标签变色。
  const settings = await (await request.get(`${fakeApiRoot}/api/model-settings`)).json();
  const current = settings.profiles.find((profile: { profileId: string }) => profile.profileId === 'fixture-openai');
  const missing = settings.profiles.find((profile: { profileId: string }) => profile.profileId === 'fixture-missing-auth');
  delete current.capabilities;
  expect((await request.post(`${fakeApiRoot}/api/model-settings/profiles`, { data: { commandId: 'default-broken', revision: settings.revision,
    profile: { ...current, provider: missing.provider, protocol: missing.protocol, endpoint: missing.endpoint } } })).ok()).toBe(true);
  await page.getByRole('button', { name: '刷新认证与连接状态' }).click();
  const warning = page.locator('.model-default-warning');
  await expect(warning).toHaveText('默认模型「GPT Fixture」当前不可用：Pi 当前未检测到有效认证。默认引用已保留，Multivac 不会自动换成其他模型；处理好后自动恢复，也可以把其他可用模型设为默认。');
  await expect(warning).toHaveAttribute('role', 'status');
  expect((await warning.boundingBox())!.y + (await warning.boundingBox())!.height)
    .toBeLessThanOrEqual((await page.locator('.model-settings').boundingBox())!.y);
  await expect(gpt.locator('.model-default-tag')).toHaveClass(/unavailable/);
  await expect(gpt.locator('small')).toHaveText('missing-auth / gpt-fixture · 未认证');
  await expect(heading).toContainText('未认证 Fixture');
  // 把其他可用模型设为默认后提示消失。
  await rows.filter({ hasText: 'Claude Fixture' }).click();
  await expect(warning).toBeVisible();
  await heading.getByRole('button', { name: '设为默认' }).click();
  await expect(heading.getByRole('button', { name: '当前默认' })).toBeDisabled();
  await expect(warning).toHaveCount(0);
});

test('原地编辑：在“配置”小节里编辑，下方 API Key 与连接检查仍然显示但暂停；推理能力是分段单选', async ({ page }) => {
  await openModels(page);
  const edit = page.getByRole('button', { name: '编辑', exact: true });
  await edit.click();

  // 详情头保留（名称仍是已保存的），“编辑”隐藏；表单就在“配置”小节里，焦点在显示名称上。
  await expect(page.getByRole('heading', { name: 'GPT Fixture', level: 2 })).toBeVisible();
  await expect(edit).toHaveCount(0);
  const config = page.locator('.model-section').filter({ has: page.getByRole('heading', { name: '配置', exact: true }) });
  await expect(config.locator('form.model-profile-form')).toBeVisible();
  await expect(page.getByLabel('显示名称')).toBeFocused();
  await expect(page.getByLabel('配置 ID')).toHaveCount(0);
  await expect(page.getByLabel('提供方')).toHaveValue('fixture');
  await expect(page.getByLabel('API 端点')).toHaveValue('https://fixture.example/v1');

  // API Key 与连接检查两节仍然显示：输入与按钮暂停，并写明原因。
  const keySection = page.locator('.model-key-section');
  const checkSection = page.locator('.model-check-section');
  await expect(keySection).toBeVisible();
  await expect(checkSection).toBeVisible();
  await expect(page.getByLabel('API Key', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '检查连接', exact: true })).toBeDisabled();
  await expect(keySection).toContainText('正在编辑配置：保存或取消后才能配置或撤销 API Key。');
  await expect(checkSection).toContainText('正在编辑配置：保存或取消后才能检查连接。');

  // 表单底部：说明 + “取消 / 保存”；没有改动时不能保存。
  const actions = config.locator('.model-form-actions');
  await expect(actions.locator('.model-edit-note')).toHaveText('改了提供方、协议、模型 ID 或端点，保存后需要重新检查连接。');
  await expect(actions.getByRole('button')).toHaveText(['取消', '保存']);
  const save = actions.getByRole('button', { name: '保存' });
  await expect(save).toBeDisabled();
  expect((await actions.boundingBox())!.y).toBeLessThan((await keySection.boundingBox())!.y);

  // 推理能力：分段单选，按目录判断时如实写来源；方向键切换并选中，只有选中项在 Tab 序列里。
  const reasoning = page.getByRole('radiogroup', { name: '推理能力' });
  const radios = reasoning.getByRole('radio');
  await expect(radios).toHaveText(['自动（按 Pi 目录）', '支持', '不支持']);
  const auto = reasoning.getByRole('radio', { name: '自动（按 Pi 目录）' });
  const supported = reasoning.getByRole('radio', { name: '支持', exact: true });
  const unsupported = reasoning.getByRole('radio', { name: '不支持' });
  await expect(auto).toHaveAttribute('aria-checked', 'true');
  await expect(auto).toHaveAttribute('tabindex', '0');
  await expect(supported).toHaveAttribute('tabindex', '-1');
  await expect(page.locator('.reasoning-source')).toHaveText('来源：Pi 目录');
  // 可选推理等级：Pi 给出的等级，只读小标签，放在单选组之外、单选组下方。
  const levels = page.locator('.reasoning-levels');
  await expect(levels.locator('span').first()).toHaveText('可选推理等级');
  await expect(levels.locator('em')).toHaveText(['关闭', '极简', '低', '中', '高']);
  await expect(reasoning.locator('.reasoning-levels')).toHaveCount(0);
  await expect(levels.getByRole('button')).toHaveCount(0);
  expect((await levels.boundingBox())!.y).toBeGreaterThan((await reasoning.boundingBox())!.y);
  await auto.focus();
  await page.keyboard.press('ArrowRight');
  await expect(supported).toHaveAttribute('aria-checked', 'true');
  await expect(supported).toBeFocused();
  await expect(page.locator('.reasoning-source')).toHaveText('来源：手动设置');
  // 目录已支持推理时手动设为“支持”，等级不变。
  await expect(levels.locator('em')).toHaveText(['关闭', '极简', '低', '中', '高']);
  await page.keyboard.press('ArrowRight');
  await expect(unsupported).toHaveAttribute('aria-checked', 'true');
  await expect(auto).toHaveAttribute('aria-checked', 'false');
  await expect(save).toBeEnabled();
  // 不支持时不显示等级。
  await expect(levels).toHaveCount(0);

  // 改了连到的模型时，自动模式的来源与可选等级都要等保存后由 Pi 判断。
  await auto.click();
  await page.getByLabel('模型 ID').fill('gpt-fixture-next');
  await expect(page.locator('.reasoning-source')).toHaveText('来源：保存后由 Pi 判断');
  await expect(levels).toHaveText('可选推理等级保存后由 Pi 给出');
  await expect(levels.locator('em')).toHaveCount(0);
  await page.getByLabel('模型 ID').fill('gpt-fixture');
  await expect(levels.locator('em')).toHaveCount(5);

  // 保存：“配置”标题旁出现“已保存”，回到只读，焦点回到“编辑”。
  await unsupported.click();
  await save.click();
  await expect(config.locator('.section-title').getByRole('status')).toHaveText('已保存');
  await expect(config.locator('.model-metadata')).toContainText('推理能力不支持（手动设置）');
  await expect(page.getByRole('button', { name: '编辑', exact: true })).toBeFocused();
  // 结束编辑后两节不再写“正在编辑”（配置版本变了，凭据操作仍按原有规则先确认当前配置）。
  await expect(page.locator('.model-key-section')).not.toContainText('正在编辑配置');
  await expect(page.locator('.model-check-section')).not.toContainText('正在编辑配置');

  // 只读的“配置”里不列等级（与原型一致）。
  await expect(page.locator('.reasoning-levels')).toHaveCount(0);

  // 取消同样回到只读，焦点回到“编辑”，草稿丢弃。
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  // 已保存为“不支持”：不显示等级；改为“支持”后 Pi 会给出哪些等级要保存后才知道。
  await expect(levels).toHaveCount(0);
  await supported.click();
  await expect(levels).toHaveText('可选推理等级保存后由 Pi 给出');
  await page.getByLabel('显示名称').fill('不会保存');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('button', { name: '编辑', exact: true })).toBeFocused();
  await expect(page.getByText('不会保存')).toHaveCount(0);

  // 保存为手动“支持”后，再编辑时列出 Pi 给出的等级。
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await supported.click();
  await save.click();
  await expect(config.locator('.model-metadata')).toContainText('推理能力支持（手动设置）');
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await expect(supported).toHaveAttribute('aria-checked', 'true');
  await expect(levels.locator('em')).toHaveText(['关闭', '极简', '低', '中', '高']);
  await page.getByRole('button', { name: '取消', exact: true }).click();
});
